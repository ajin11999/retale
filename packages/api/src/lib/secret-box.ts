// AES-256-GCM sealing for secrets at rest — used for stored TOTP secrets.
// The 32-byte key is derived (SHA-256) from the `TWO_FACTOR_ENC_KEY` env var,
// so any-length passphrase works.

import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { env } from "./env.ts";

const key = createHash("sha256").update(env.twoFactorEncKey).digest();

/** Seal plaintext: base64 of `iv(12) || authTag(16) || ciphertext`. */
export function sealSecret(plain: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString("base64");
}

/** Reverse `sealSecret`. Throws if the data was tampered with (GCM auth). */
export function openSecret(sealed: string): string {
  const buf = Buffer.from(sealed, "base64");
  const iv = buf.subarray(0, 12);
  const authTag = buf.subarray(12, 28);
  const ciphertext = buf.subarray(28);
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
}
