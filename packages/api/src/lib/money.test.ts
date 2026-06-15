import { describe, expect, test } from "bun:test";
import { allocateProportional, formatRp, isMoney, roundMoney } from "./money.ts";

describe("roundMoney", () => {
  test("rounds to 2 decimals and kills float drift", () => {
    expect(roundMoney(123.455)).toBe(123.46);
    expect(roundMoney(0.1 + 0.2)).toBe(0.3);
    expect(roundMoney(66400 / 24)).toBe(2766.67);
    expect(roundMoney(10)).toBe(10);
    expect(roundMoney(-3.255)).toBe(-3.25);
  });
});

describe("isMoney", () => {
  test("accepts finite numbers with ≤2 decimals", () => {
    for (const n of [0, 10, 10.5, 10.55, -3.25, 1500000.5]) {
      expect(isMoney(n)).toBe(true);
    }
  });
  test("rejects >2 decimals, non-finite, and non-numbers", () => {
    expect(isMoney(10.555)).toBe(false);
    expect(isMoney(Number.NaN)).toBe(false);
    expect(isMoney(Number.POSITIVE_INFINITY)).toBe(false);
    expect(isMoney("10")).toBe(false);
    expect(isMoney(null)).toBe(false);
    expect(isMoney(undefined)).toBe(false);
  });
});

describe("formatRp", () => {
  test("international grouping (comma thousands, dot decimal), trimmed", () => {
    expect(formatRp(1500000.5)).toBe("Rp 1,500,000.5");
    expect(formatRp(10)).toBe("Rp 10");
    expect(formatRp(10.5)).toBe("Rp 10.5");
    expect(formatRp(10.55)).toBe("Rp 10.55");
    expect(formatRp(0)).toBe("Rp 0");
  });
});

describe("allocateProportional", () => {
  test("splits a whole amount, summing back exactly (largest-remainder)", () => {
    const shares = allocateProportional(10, [1, 1, 1]);
    expect(roundMoney(shares.reduce((a, b) => a + b, 0))).toBe(10);
    expect([...shares].sort((a, b) => a - b)).toEqual([3.33, 3.33, 3.34]);
  });
  test("splits a 2-decimal total by weight, summing back exactly", () => {
    const shares = allocateProportional(100.5, [2, 3, 5]);
    expect(roundMoney(shares.reduce((a, b) => a + b, 0))).toBe(100.5);
  });
  test("all-zero weights put the whole amount on the last part", () => {
    expect(allocateProportional(7.5, [0, 0, 0])).toEqual([0, 0, 7.5]);
  });
  test("empty weights yield no shares", () => {
    expect(allocateProportional(5, [])).toEqual([]);
  });
});
