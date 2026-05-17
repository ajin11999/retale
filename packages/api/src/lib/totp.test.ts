// Unit tests for the TOTP primitives — pure, no DB or environment.
//
//   bun test src/lib/totp.test.ts

import { describe, expect, test } from "bun:test";
import {
  base32Decode,
  base32Encode,
  currentTimeStep,
  generateTotpSecret,
  otpauthUrl,
  totpCode,
  verifyTotp,
} from "./totp.ts";

describe("base32", () => {
  test("round-trips arbitrary bytes", () => {
    const buf = Buffer.from("12345678901234567890");
    expect(base32Decode(base32Encode(buf)).equals(buf)).toBe(true);
  });
});

describe("totpCode", () => {
  test("matches the RFC 6238 SHA-1 vector, truncated to 6 digits", () => {
    // RFC 6238: secret "12345678901234567890", T=59s → step 1 → 8-digit
    // code 94287082; the 6-digit form is its last six digits.
    const secret = base32Encode(Buffer.from("12345678901234567890"));
    expect(totpCode(secret, 1)).toBe("287082");
  });
});

describe("verifyTotp", () => {
  test("accepts the current code and ±1 step of drift", () => {
    const secret = generateTotpSecret();
    const now = Date.now();
    const step = currentTimeStep(now);
    expect(verifyTotp({ secret, code: totpCode(secret, step), now }).ok).toBe(true);
    expect(verifyTotp({ secret, code: totpCode(secret, step - 1), now }).ok).toBe(true);
    expect(verifyTotp({ secret, code: totpCode(secret, step + 1), now }).ok).toBe(true);
  });

  test("rejects a code from a replayed (already-used) step", () => {
    const secret = generateTotpSecret();
    const now = Date.now();
    const step = currentTimeStep(now);
    const result = verifyTotp({
      secret,
      code: totpCode(secret, step),
      now,
      lastUsedStep: step,
    });
    expect(result.ok).toBe(false);
  });

  test("rejects a wrong or malformed code", () => {
    const secret = generateTotpSecret();
    expect(verifyTotp({ secret, code: "000000" }).ok).toBe(false);
    expect(verifyTotp({ secret, code: "abc" }).ok).toBe(false);
  });
});

describe("otpauthUrl", () => {
  test("carries the secret, issuer, and algorithm", () => {
    const url = otpauthUrl({ secret: "ABC234", account: "bob", issuer: "Retale" });
    expect(url.startsWith("otpauth://totp/")).toBe(true);
    expect(url).toContain("secret=ABC234");
    expect(url).toContain("issuer=Retale");
    expect(url).toContain("algorithm=SHA1");
  });
});
