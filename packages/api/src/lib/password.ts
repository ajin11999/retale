// Password hashing — Argon2id via @node-rs/argon2.
// Produces standard PHC strings (`$argon2id$...`), so hashes carried over
// from ProDuck verify here unchanged (same algorithm).

import { hash as argonHash, verify as argonVerify } from "@node-rs/argon2";

/** Hash a plaintext password for storage. */
export function hashPassword(plain: string): Promise<string> {
  return argonHash(plain);
}

/**
 * Verify a plaintext password against a stored hash. Returns false (never
 * throws) on a malformed hash, so callers can treat it as a failed login.
 */
export async function verifyPassword(hash: string, plain: string): Promise<boolean> {
  try {
    return await argonVerify(hash, plain);
  } catch {
    return false;
  }
}
