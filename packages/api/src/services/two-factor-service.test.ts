// Integration tests for TOTP 2FA — setup/confirm, the password → challenge →
// code login flow, recovery codes, replay protection, and the attempt cap.
// Runs against the local Docker MariaDB (DATABASE_URL); WIPES the auth + 2FA
// tables between tests.
//
//   bun test src/services/two-factor-service.test.ts

import "../lib/load-env.ts";
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { db } from "../lib/db.ts";
import { currentTimeStep, totpCode } from "../lib/totp.ts";
import { login, loginTwoFactor, registerUser } from "./auth-service.ts";
import {
  confirmTwoFactor,
  disableTwoFactor,
  isTwoFactorEnabled,
  setupTwoFactor,
  TwoFactorError,
  type TwoFactorErrorCode,
} from "./two-factor-service.ts";

async function wipe(): Promise<void> {
  await db.execute(sql`SET FOREIGN_KEY_CHECKS = 0`);
  for (const t of [
    "two_factor_challenges", "user_recovery_codes", "user_two_factor",
    "sessions", "user_roles", "users",
  ]) {
    await db.execute(sql.raw(`DELETE FROM \`${t}\``));
  }
  await db.execute(sql`SET FOREIGN_KEY_CHECKS = 1`);
}

beforeEach(wipe);
afterAll(async () => {
  await wipe();
  // The shared pool is closed once globally — see src/test-setup.ts.
});

const PASSWORD = "correct horse";

/** Register a user; returns the id. */
async function seedUser(username: string): Promise<string> {
  const user = await registerUser({ username, password: PASSWORD, name: "2FA Test" });
  return user.id;
}

/** Setup + confirm 2FA for a user; returns the secret and recovery codes. */
async function enable2fa(
  userId: string,
  username: string,
): Promise<{ secret: string; recoveryCodes: string[] }> {
  const setup = await setupTwoFactor({ userId, accountLabel: username });
  await confirmTwoFactor({ userId, code: totpCode(setup.secret, currentTimeStep()) });
  return { secret: setup.secret, recoveryCodes: setup.recoveryCodes };
}

async function expectError(
  code: TwoFactorErrorCode,
  fn: () => Promise<unknown>,
): Promise<void> {
  try {
    await fn();
  } catch (e) {
    expect(e).toBeInstanceOf(TwoFactorError);
    expect((e as TwoFactorError).code).toBe(code);
    return;
  }
  throw new Error(`expected TwoFactorError ${code}, nothing thrown`);
}

describe("setup and confirmation", () => {
  test("setup yields a secret and ten recovery codes; not yet enabled", async () => {
    const userId = await seedUser("alice");
    const setup = await setupTwoFactor({ userId, accountLabel: "alice" });
    expect(setup.secret.length).toBeGreaterThan(0);
    expect(setup.recoveryCodes).toHaveLength(10);
    expect(await isTwoFactorEnabled(userId)).toBe(false);
  });

  test("a wrong confirmation code is rejected", async () => {
    const userId = await seedUser("alice");
    await setupTwoFactor({ userId, accountLabel: "alice" });
    await expectError("INVALID_CODE", () =>
      confirmTwoFactor({ userId, code: "000000" }),
    );
    expect(await isTwoFactorEnabled(userId)).toBe(false);
  });

  test("the correct code activates 2FA", async () => {
    const userId = await seedUser("alice");
    await enable2fa(userId, "alice");
    expect(await isTwoFactorEnabled(userId)).toBe(true);
  });

  test("setup is refused while 2FA is already enabled", async () => {
    const userId = await seedUser("alice");
    await enable2fa(userId, "alice");
    await expectError("TWO_FACTOR_ALREADY_ENABLED", () =>
      setupTwoFactor({ userId, accountLabel: "alice" }),
    );
  });
});

describe("the 2FA login flow", () => {
  test("password login returns a challenge, completed by a TOTP code", async () => {
    const userId = await seedUser("alice");
    const { secret } = await enable2fa(userId, "alice");

    const outcome = await login({ username: "alice", password: PASSWORD });
    expect(outcome.kind).toBe("challenge");
    if (outcome.kind !== "challenge") throw new Error("expected challenge");

    // The confirm step consumed the current step — use the next one.
    const completed = await loginTwoFactor({
      challengeToken: outcome.challengeToken,
      code: totpCode(secret, currentTimeStep() + 1),
    });
    expect(completed.tokens.accessToken.length).toBeGreaterThan(0);
  });

  test("a user without 2FA logs in directly", async () => {
    await seedUser("bob");
    const outcome = await login({ username: "bob", password: PASSWORD });
    expect(outcome.kind).toBe("tokens");
  });

  test("a recovery code completes the challenge and is then single-use", async () => {
    const userId = await seedUser("alice");
    const { recoveryCodes } = await enable2fa(userId, "alice");
    const code = recoveryCodes[0]!;

    const first = await login({ username: "alice", password: PASSWORD });
    if (first.kind !== "challenge") throw new Error("expected challenge");
    const ok = await loginTwoFactor({ challengeToken: first.challengeToken, code });
    expect(ok.tokens.accessToken.length).toBeGreaterThan(0);

    // Same recovery code, fresh challenge — already consumed.
    const second = await login({ username: "alice", password: PASSWORD });
    if (second.kind !== "challenge") throw new Error("expected challenge");
    await expectError("INVALID_CODE", () =>
      loginTwoFactor({ challengeToken: second.challengeToken, code }),
    );
  });

  test("a replayed TOTP code (already-used step) is rejected", async () => {
    const userId = await seedUser("alice");
    const { secret } = await enable2fa(userId, "alice");
    // enable2fa confirmed with the current step — replaying it must fail.
    const outcome = await login({ username: "alice", password: PASSWORD });
    if (outcome.kind !== "challenge") throw new Error("expected challenge");
    await expectError("INVALID_CODE", () =>
      loginTwoFactor({
        challengeToken: outcome.challengeToken,
        code: totpCode(secret, currentTimeStep()),
      }),
    );
  });

  test("five wrong codes kill the challenge", async () => {
    const userId = await seedUser("alice");
    await enable2fa(userId, "alice");
    const outcome = await login({ username: "alice", password: PASSWORD });
    if (outcome.kind !== "challenge") throw new Error("expected challenge");

    for (let i = 0; i < 4; i++) {
      await expectError("INVALID_CODE", () =>
        loginTwoFactor({ challengeToken: outcome.challengeToken, code: "000000" }),
      );
    }
    // The fifth wrong code consumes the challenge outright.
    await expectError("CHALLENGE_INVALID", () =>
      loginTwoFactor({ challengeToken: outcome.challengeToken, code: "000000" }),
    );
  });
});

describe("disabling", () => {
  test("disable turns 2FA off; the next login is direct", async () => {
    const userId = await seedUser("alice");
    await enable2fa(userId, "alice");
    await disableTwoFactor(userId);
    expect(await isTwoFactorEnabled(userId)).toBe(false);

    const outcome = await login({ username: "alice", password: PASSWORD });
    expect(outcome.kind).toBe("tokens");
  });
});
