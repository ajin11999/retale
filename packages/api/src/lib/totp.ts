// RFC 6238 TOTP — 30-second step, 6 digits, SHA-1 (universal authenticator
// compatibility). Pure functions, no environment or DB access; the 2FA
// service handles secret storage and replay state.

import { createHmac, randomBytes } from "node:crypto";

const B32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

/** Base32-encode a buffer (RFC 4648, no padding) — the authenticator format. */
export function base32Encode(buf: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += B32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32_ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

/** Decode a base32 string back to bytes; throws on an invalid character. */
export function base32Decode(s: string): Buffer {
  const clean = s.toUpperCase().replace(/=+$/, "").replace(/\s/g, "");
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const i = B32_ALPHABET.indexOf(ch);
    if (i === -1) throw new Error("invalid base32");
    value = (value << 5) | i;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

export const TOTP_STEP_SECONDS = 30;

/** A fresh 160-bit TOTP secret, base32-encoded for authenticator apps. */
export function generateTotpSecret(): string {
  return base32Encode(randomBytes(20));
}

/** The current 30-second time-step counter. */
export function currentTimeStep(now = Date.now()): number {
  return Math.floor(now / 1000 / TOTP_STEP_SECONDS);
}

/** The 6-digit RFC 6238 code for a base32 secret at a given time-step. */
export function totpCode(base32Secret: string, step: number): string {
  const key = base32Decode(base32Secret);
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const hmac = createHmac("sha1", key).update(counter).digest();
  const offset = hmac[hmac.length - 1]! & 0x0f;
  const bin =
    ((hmac[offset]! & 0x7f) << 24) |
    (hmac[offset + 1]! << 16) |
    (hmac[offset + 2]! << 8) |
    hmac[offset + 3]!;
  return String(bin % 1_000_000).padStart(6, "0");
}

/**
 * Verify a code against the secret, allowing ±1 step for clock drift, and
 * rejecting any step at or below `lastUsedStep` (replay protection). Returns
 * the matched step on success so the caller can advance `lastUsedStep`.
 */
export function verifyTotp(opts: {
  secret: string;
  code: string;
  lastUsedStep?: number | null;
  now?: number;
}): { ok: boolean; step?: number } {
  const code = opts.code.replace(/[\s-]/g, "").trim();
  if (!/^\d{6}$/.test(code)) return { ok: false };
  const current = currentTimeStep(opts.now);
  for (const step of [current - 1, current, current + 1]) {
    if (opts.lastUsedStep != null && step <= opts.lastUsedStep) continue;
    if (totpCode(opts.secret, step) === code) return { ok: true, step };
  }
  return { ok: false };
}

/** The `otpauth://` URI an authenticator app renders as a QR code. */
export function otpauthUrl(opts: {
  secret: string;
  account: string;
  issuer: string;
}): string {
  const label = opts.issuer
    ? `${encodeURIComponent(opts.issuer)}:${encodeURIComponent(opts.account)}`
    : encodeURIComponent(opts.account);
  const params = new URLSearchParams({
    secret: opts.secret,
    issuer: opts.issuer,
    algorithm: "SHA1",
    digits: "6",
    period: String(TOTP_STEP_SECONDS),
  });
  return `otpauth://totp/${label}?${params.toString()}`;
}
