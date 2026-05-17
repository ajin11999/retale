// Auth service: registration (bootstrap-aware), login, refresh-token
// rotation, and logout. Pure business logic — GraphQL resolvers call in here.

import { and, eq, isNull } from "drizzle-orm";
import { ulid } from "ulid";
import { db } from "../lib/db.ts";
import { sessions, userRoles, users } from "../db/schema/auth.ts";
import { signAccessToken } from "../lib/jwt.ts";
import { hashPassword, verifyPassword } from "../lib/password.ts";
import {
  createRefreshToken,
  parseRefreshToken,
  verifyRefreshSecret,
} from "../lib/refresh-token.ts";
import {
  createChallenge,
  isTwoFactorEnabled,
  verifyChallengeCode,
} from "./two-factor-service.ts";

const REFRESH_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

/** Error codes are stable strings resolvers map to GraphQL errors. */
export type AuthErrorCode =
  | "INVALID_CREDENTIALS"
  | "USERNAME_TAKEN"
  | "SESSION_INVALID"
  | "USER_ARCHIVED";

export class AuthError extends Error {
  constructor(public code: AuthErrorCode, message?: string) {
    super(message ?? code);
    this.name = "AuthError";
  }
}

type User = typeof users.$inferSelect;

export interface AuthTokens {
  accessToken: string;
  refreshToken: string;
  /** Refresh-token expiry; the access token's own expiry is in its JWT. */
  refreshExpiresAt: Date;
}

export interface SessionContext {
  userAgent?: string | null;
  ip?: string | null;
}

/** True when no users exist yet — the next registration is the bootstrap root. */
export async function isBootstrapNeeded(): Promise<boolean> {
  const row = await db.select({ id: users.id }).from(users).limit(1);
  return row.length === 0;
}

/**
 * Create a user. When the users table is empty the new user is auto-promoted
 * to root regardless of the requested flag (bootstrap rule); otherwise
 * `isRoot` is honoured (resolvers gate that behind a permission check).
 */
export async function registerUser(input: {
  username: string;
  password: string;
  name: string;
  isRoot?: boolean;
  createdByUserId?: string;
}): Promise<User> {
  const bootstrap = await isBootstrapNeeded();

  const existing = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.username, input.username))
    .limit(1);
  if (existing.length > 0) throw new AuthError("USERNAME_TAKEN");

  const passwordHash = await hashPassword(input.password);
  const isRoot = bootstrap ? true : (input.isRoot ?? false);

  await db.insert(users).values({
    username: input.username,
    passwordHash,
    name: input.name,
    isRoot,
    createdByUserId: input.createdByUserId,
  });

  const created = await db.query.users.findFirst({
    where: eq(users.username, input.username),
  });
  if (!created) throw new AuthError("INVALID_CREDENTIALS", "user creation failed");
  return created;
}

/** Look up the role ids assigned to a user (for the access-token claims). */
async function roleIdsFor(userId: string): Promise<string[]> {
  const rows = await db
    .select({ roleId: userRoles.roleId })
    .from(userRoles)
    .where(eq(userRoles.userId, userId));
  return rows.map((r) => r.roleId);
}

/** Mint an access token + a new session-backed refresh token for a user. */
async function issueTokens(user: User, ctx: SessionContext): Promise<AuthTokens> {
  const roleIds = await roleIdsFor(user.id);
  const accessToken = await signAccessToken({
    userId: user.id,
    isRoot: user.isRoot,
    roleIds,
  });

  const sessionId = ulid();
  const refreshExpiresAt = new Date(Date.now() + REFRESH_TTL_MS);
  const { token, secretHash } = await createRefreshToken(sessionId);

  await db.insert(sessions).values({
    id: sessionId,
    userId: user.id,
    refreshTokenHash: secretHash,
    userAgent: ctx.userAgent ?? null,
    ip: ctx.ip ?? null,
    expiresAt: refreshExpiresAt,
  });

  return { accessToken, refreshToken: token, refreshExpiresAt };
}

/**
 * Outcome of a password login. A user with 2FA enabled gets a `challenge`
 * (no tokens yet); everyone else gets `tokens` directly.
 */
export type LoginOutcome =
  | { kind: "tokens"; user: User; tokens: AuthTokens }
  | { kind: "challenge"; user: User; challengeToken: string };

/**
 * Authenticate by username + password. Generic error on any failure. When
 * the user has 2FA enabled, the password step succeeds into a challenge that
 * `loginTwoFactor` completes — the password alone never yields tokens.
 */
export async function login(input: {
  username: string;
  password: string;
  ctx?: SessionContext;
}): Promise<LoginOutcome> {
  const user = await db.query.users.findFirst({
    where: eq(users.username, input.username),
  });
  // Verify even when the user is missing, to keep timing uniform.
  const hash = user?.passwordHash ?? "$argon2id$v=19$m=19456,t=2,p=1$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
  const ok = await verifyPassword(hash, input.password);
  if (!user || !ok) throw new AuthError("INVALID_CREDENTIALS");
  if (user.archivedAt) throw new AuthError("USER_ARCHIVED");

  if (await isTwoFactorEnabled(user.id)) {
    return { kind: "challenge", user, challengeToken: await createChallenge(user.id) };
  }
  const tokens = await issueTokens(user, input.ctx ?? {});
  return { kind: "tokens", user, tokens };
}

/**
 * Complete a 2FA login: exchange a challenge token plus a TOTP or recovery
 * code for the actual token pair.
 */
export async function loginTwoFactor(input: {
  challengeToken: string;
  code: string;
  ctx?: SessionContext;
}): Promise<{ user: User; tokens: AuthTokens }> {
  const userId = await verifyChallengeCode({
    challengeToken: input.challengeToken,
    code: input.code,
  });
  const user = await db.query.users.findFirst({ where: eq(users.id, userId) });
  if (!user || user.archivedAt) throw new AuthError("SESSION_INVALID");

  const tokens = await issueTokens(user, input.ctx ?? {});
  return { user, tokens };
}

/**
 * Rotate a refresh token. Presenting a stale secret against a live session
 * (rotation already happened) is treated as theft: the session is revoked.
 */
export async function refresh(input: {
  refreshToken: string;
  ctx?: SessionContext;
}): Promise<{ user: User; tokens: AuthTokens }> {
  const parsed = parseRefreshToken(input.refreshToken);
  if (!parsed) throw new AuthError("SESSION_INVALID");

  const session = await db.query.sessions.findFirst({
    where: eq(sessions.id, parsed.sessionId),
  });
  if (!session) throw new AuthError("SESSION_INVALID");

  const revoked = session.revokedAt != null;
  const expired = new Date(session.expiresAt) <= new Date();
  const secretOk = await verifyRefreshSecret(session.refreshTokenHash, parsed.secret);

  if (revoked || expired || !secretOk) {
    // Stale secret on a live session → reuse; kill it.
    if (!revoked && !expired && !secretOk) {
      await db
        .update(sessions)
        .set({ revokedAt: new Date() })
        .where(eq(sessions.id, session.id));
    }
    throw new AuthError("SESSION_INVALID");
  }

  const user = await db.query.users.findFirst({ where: eq(users.id, session.userId) });
  if (!user || user.archivedAt) throw new AuthError("SESSION_INVALID");

  // Rotate the refresh secret in place.
  const { token, secretHash } = await createRefreshToken(session.id);
  await db
    .update(sessions)
    .set({
      refreshTokenHash: secretHash,
      lastUsedAt: new Date(),
      userAgent: input.ctx?.userAgent ?? session.userAgent,
      ip: input.ctx?.ip ?? session.ip,
    })
    .where(eq(sessions.id, session.id));

  const roleIds = await roleIdsFor(user.id);
  const accessToken = await signAccessToken({
    userId: user.id,
    isRoot: user.isRoot,
    roleIds,
  });

  return {
    user,
    tokens: { accessToken, refreshToken: token, refreshExpiresAt: new Date(session.expiresAt) },
  };
}

/** Revoke a session by its refresh token. Idempotent — unknown tokens no-op. */
export async function logout(refreshToken: string): Promise<void> {
  const parsed = parseRefreshToken(refreshToken);
  if (!parsed) return;
  await db
    .update(sessions)
    .set({ revokedAt: new Date() })
    .where(and(eq(sessions.id, parsed.sessionId), isNull(sessions.revokedAt)));
}
