// Two-factor (TOTP) service: authenticator setup/confirmation, recovery
// codes, and the login challenge that bridges the password and TOTP steps.
// See docs/design-decisions.md → "Authentication".

import { and, eq, isNull } from "drizzle-orm";
import { ulid } from "ulid";
import {
  twoFactorChallenges,
  userRecoveryCodes,
  userTwoFactor,
} from "../db/schema/two-factor.ts";
import { db } from "../lib/db.ts";
import { hashPassword, verifyPassword } from "../lib/password.ts";
import { openSecret, sealSecret } from "../lib/secret-box.ts";
import { generateTotpSecret, otpauthUrl, verifyTotp } from "../lib/totp.ts";

export type TwoFactorErrorCode =
  | "TWO_FACTOR_NOT_SETUP"
  | "TWO_FACTOR_ALREADY_ENABLED"
  | "TWO_FACTOR_NOT_ENABLED"
  | "SETUP_EXPIRED"
  | "INVALID_CODE"
  | "CHALLENGE_INVALID";

export class TwoFactorError extends Error {
  constructor(
    public code: TwoFactorErrorCode,
    message?: string,
  ) {
    super(message ?? code);
    this.name = "TwoFactorError";
  }
}

/** A drizzle transaction handle; structurally a subset of `db`. */
type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

const OTP_ISSUER = "Retale";
const RECOVERY_CODE_COUNT = 10;
/** An unconfirmed setup secret expires after this long. */
const PENDING_TTL_MS = 60 * 60 * 1000;
/** A login challenge is valid for this long. */
const CHALLENGE_TTL_MS = 5 * 60 * 1000;
/** Wrong codes allowed against one challenge before it is killed. */
const MAX_CHALLENGE_ATTEMPTS = 5;
/** Recovery-code alphabet — no I/O/0/1, to stay unambiguous on paper. */
const RECOVERY_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

/** True when the user has a confirmed (active) authenticator. */
export async function isTwoFactorEnabled(userId: string): Promise<boolean> {
  const row = await db.query.userTwoFactor.findFirst({
    where: eq(userTwoFactor.userId, userId),
  });
  return row?.confirmedAt != null;
}

/** Generate, format, and hash a fresh batch of recovery codes. */
async function freshRecoveryCodes(
  tx: Tx,
  userId: string,
): Promise<string[]> {
  const plain: string[] = [];
  const rows: (typeof userRecoveryCodes.$inferInsert)[] = [];
  for (let i = 0; i < RECOVERY_CODE_COUNT; i++) {
    let raw = "";
    for (let c = 0; c < 10; c++) {
      raw += RECOVERY_ALPHABET[Math.floor(Math.random() * RECOVERY_ALPHABET.length)];
    }
    const code = `${raw.slice(0, 5)}-${raw.slice(5)}`;
    plain.push(code);
    rows.push({ id: ulid(), userId, codeHash: await hashPassword(raw) });
  }
  await tx.insert(userRecoveryCodes).values(rows);
  return plain;
}

/** Normalize user-entered recovery code input to the stored raw form. */
function normalizeRecoveryCode(input: string): string {
  return input.toUpperCase().replace(/[^A-Z0-9]/g, "");
}

export interface TwoFactorSetup {
  /** `otpauth://` URI for the QR code. */
  otpauthUrl: string;
  /** The base32 secret, for manual entry. */
  secret: string;
  /** Plaintext recovery codes — shown once, never recoverable after. */
  recoveryCodes: string[];
}

/**
 * Begin TOTP setup: generate a secret and recovery codes, store them in a
 * pending (unconfirmed) state. Fails if 2FA is already active — disable it
 * first to re-enrol. Re-running while pending replaces the pending secret.
 */
export async function setupTwoFactor(input: {
  userId: string;
  accountLabel: string;
}): Promise<TwoFactorSetup> {
  return db.transaction(async (tx) => {
    const existing = await tx.query.userTwoFactor.findFirst({
      where: eq(userTwoFactor.userId, input.userId),
    });
    if (existing?.confirmedAt) {
      throw new TwoFactorError("TWO_FACTOR_ALREADY_ENABLED");
    }
    // Clear any prior pending state.
    await tx.delete(userTwoFactor).where(eq(userTwoFactor.userId, input.userId));
    await tx
      .delete(userRecoveryCodes)
      .where(eq(userRecoveryCodes.userId, input.userId));

    const secret = generateTotpSecret();
    await tx.insert(userTwoFactor).values({
      userId: input.userId,
      secretEncrypted: sealSecret(secret),
    });
    const recoveryCodes = await freshRecoveryCodes(tx, input.userId);

    return {
      otpauthUrl: otpauthUrl({
        secret,
        account: input.accountLabel,
        issuer: OTP_ISSUER,
      }),
      secret,
      recoveryCodes,
    };
  });
}

/**
 * Confirm a pending setup by entering a current code. On success 2FA goes
 * active. An unconfirmed secret older than the pending window is expired.
 */
export async function confirmTwoFactor(input: {
  userId: string;
  code: string;
}): Promise<void> {
  const row = await db.query.userTwoFactor.findFirst({
    where: eq(userTwoFactor.userId, input.userId),
  });
  if (!row) throw new TwoFactorError("TWO_FACTOR_NOT_SETUP");
  if (row.confirmedAt) throw new TwoFactorError("TWO_FACTOR_ALREADY_ENABLED");
  if (Date.now() - row.createdAt.getTime() > PENDING_TTL_MS) {
    await db.delete(userTwoFactor).where(eq(userTwoFactor.userId, input.userId));
    await db
      .delete(userRecoveryCodes)
      .where(eq(userRecoveryCodes.userId, input.userId));
    throw new TwoFactorError("SETUP_EXPIRED");
  }

  const result = verifyTotp({ secret: openSecret(row.secretEncrypted), code: input.code });
  if (!result.ok) throw new TwoFactorError("INVALID_CODE");

  await db
    .update(userTwoFactor)
    .set({ confirmedAt: new Date(), lastUsedStep: result.step })
    .where(eq(userTwoFactor.userId, input.userId));
}

/** Turn off 2FA for a user — drops the authenticator and recovery codes. */
export async function disableTwoFactor(userId: string): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.delete(userTwoFactor).where(eq(userTwoFactor.userId, userId));
    await tx.delete(userRecoveryCodes).where(eq(userRecoveryCodes.userId, userId));
    await tx
      .delete(twoFactorChallenges)
      .where(eq(twoFactorChallenges.userId, userId));
  });
}

/** Replace a user's recovery codes; the previous set is invalidated. */
export async function regenerateRecoveryCodes(userId: string): Promise<string[]> {
  return db.transaction(async (tx) => {
    if (!(await isTwoFactorEnabled(userId))) {
      throw new TwoFactorError("TWO_FACTOR_NOT_ENABLED");
    }
    await tx.delete(userRecoveryCodes).where(eq(userRecoveryCodes.userId, userId));
    return freshRecoveryCodes(tx, userId);
  });
}

/** Open a login challenge for a user; the returned id is the challenge token. */
export async function createChallenge(userId: string): Promise<string> {
  const id = ulid();
  await db.insert(twoFactorChallenges).values({
    id,
    userId,
    expiresAt: new Date(Date.now() + CHALLENGE_TTL_MS),
  });
  return id;
}

/** Try a recovery code against the user's unused codes; consume one on a hit. */
async function tryRecoveryCode(userId: string, input: string): Promise<boolean> {
  const candidate = normalizeRecoveryCode(input);
  const codes = await db
    .select()
    .from(userRecoveryCodes)
    .where(
      and(
        eq(userRecoveryCodes.userId, userId),
        isNull(userRecoveryCodes.usedAt),
      ),
    );
  for (const row of codes) {
    if (await verifyPassword(row.codeHash, candidate)) {
      await db
        .update(userRecoveryCodes)
        .set({ usedAt: new Date() })
        .where(eq(userRecoveryCodes.id, row.id));
      return true;
    }
  }
  return false;
}

/**
 * Verify a TOTP or recovery code against an open challenge. Returns the
 * user id on success. A wrong code increments the attempt counter; the
 * challenge is killed after `MAX_CHALLENGE_ATTEMPTS`.
 */
export async function verifyChallengeCode(input: {
  challengeToken: string;
  code: string;
}): Promise<string> {
  const challenge = await db.query.twoFactorChallenges.findFirst({
    where: eq(twoFactorChallenges.id, input.challengeToken),
  });
  if (
    !challenge ||
    challenge.consumedAt ||
    challenge.expiresAt <= new Date() ||
    challenge.failedAttempts >= MAX_CHALLENGE_ATTEMPTS
  ) {
    throw new TwoFactorError("CHALLENGE_INVALID");
  }

  const tf = await db.query.userTwoFactor.findFirst({
    where: eq(userTwoFactor.userId, challenge.userId),
  });
  if (!tf?.confirmedAt) throw new TwoFactorError("CHALLENGE_INVALID");

  // A 6-digit input is a TOTP code; anything else is treated as recovery.
  const digitsOnly = input.code.replace(/[\s-]/g, "");
  let ok = false;
  if (/^\d{6}$/.test(digitsOnly)) {
    const result = verifyTotp({
      secret: openSecret(tf.secretEncrypted),
      code: digitsOnly,
      lastUsedStep: tf.lastUsedStep,
    });
    if (result.ok) {
      ok = true;
      await db
        .update(userTwoFactor)
        .set({ lastUsedStep: result.step })
        .where(eq(userTwoFactor.userId, challenge.userId));
    }
  } else {
    ok = await tryRecoveryCode(challenge.userId, input.code);
  }

  if (!ok) {
    const attempts = challenge.failedAttempts + 1;
    await db
      .update(twoFactorChallenges)
      .set({
        failedAttempts: attempts,
        ...(attempts >= MAX_CHALLENGE_ATTEMPTS && { consumedAt: new Date() }),
      })
      .where(eq(twoFactorChallenges.id, challenge.id));
    throw new TwoFactorError(
      attempts >= MAX_CHALLENGE_ATTEMPTS ? "CHALLENGE_INVALID" : "INVALID_CODE",
    );
  }

  await db
    .update(twoFactorChallenges)
    .set({ consumedAt: new Date() })
    .where(eq(twoFactorChallenges.id, challenge.id));
  return challenge.userId;
}
