// Opaque refresh tokens. The wire format is `{sessionId}.{secret}` — the
// session id lets us look the row up, the secret is verified (argon2) against
// the stored hash. 32 random bytes of entropy in the secret.

import { randomBytes } from "node:crypto";
import { hash as argonHash, verify as argonVerify } from "@node-rs/argon2";

const SECRET_BYTES = 32;
const SEPARATOR = ".";

export interface RefreshToken {
  /** The full token string handed to the client. */
  token: string;
  /** Argon2 hash of the secret, stored in `sessions.refresh_token_hash`. */
  secretHash: string;
}

/** Mint a fresh refresh token bound to a session id. */
export async function createRefreshToken(sessionId: string): Promise<RefreshToken> {
  const secret = randomBytes(SECRET_BYTES).toString("base64url");
  const secretHash = await argonHash(secret);
  return { token: `${sessionId}${SEPARATOR}${secret}`, secretHash };
}

/** Split a wire token into its session id and secret. Null if malformed. */
export function parseRefreshToken(token: string): { sessionId: string; secret: string } | null {
  const idx = token.indexOf(SEPARATOR);
  if (idx <= 0 || idx === token.length - 1) return null;
  return { sessionId: token.slice(0, idx), secret: token.slice(idx + 1) };
}

/** Verify a presented secret against a stored hash. False (never throws) on mismatch. */
export async function verifyRefreshSecret(secretHash: string, secret: string): Promise<boolean> {
  try {
    return await argonVerify(secretHash, secret);
  } catch {
    return false;
  }
}
