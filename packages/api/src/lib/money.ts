// Money helpers. Retale stores money as the literal rupiah value in
// DECIMAL(19,2) (see the `money` schema helper) — never scaled into "minor
// units". Values flow through the API as plain JS numbers carrying up to 2
// decimals. Compute with `roundMoney` and render with `formatRp` so rounding
// and display stay consistent everywhere.

/** Decimal places the currency carries (the rupiah's smallest denomination). */
export const MONEY_DECIMALS = 2;
const SCALE = 10 ** MONEY_DECIMALS; // 100

/**
 * Round a computed money value to the currency's precision (2 decimals). Apply
 * after any multiply/divide so binary-float drift never reaches the DB or the
 * wire — e.g. `roundMoney(123.455) === 123.46`, `roundMoney(0.1 + 0.2) === 0.3`.
 */
export function roundMoney(n: number): number {
  return Math.round(n * SCALE) / SCALE;
}

/**
 * True when `n` is a valid money input: a finite number with no more than 2
 * decimal places. Use in place of `Number.isInteger` when validating an amount
 * (counts/quantities stay integer-checked). Sign is the caller's concern.
 */
export function isMoney(n: unknown): n is number {
  return typeof n === "number" && Number.isFinite(n) && roundMoney(n) === n;
}

/**
 * Render a money value for display: international grouping (comma thousands,
 * dot decimal) with a `Rp ` prefix, trailing zeros trimmed.
 * e.g. `1500000.5` → `"Rp 1,500,000.5"`, `10` → `"Rp 10"`, `10.5` → `"Rp 10.5"`.
 */
export function formatRp(value: number): string {
  return (
    "Rp " +
    value.toLocaleString("en-US", { maximumFractionDigits: MONEY_DECIMALS })
  );
}

/**
 * Distribute `total` (a money value) across `weights` proportionally, rounded
 * to whole 0.01 increments so the parts sum back to `total` exactly
 * (largest-remainder rounding: floor each share, then hand the leftover cents
 * to the largest fractional shares first). Used for bundle price splits and
 * landed-freight allocation. With all weights ≤ 0 the whole amount lands on the
 * last part.
 */
export function allocateProportional(total: number, weights: number[]): number[] {
  const n = weights.length;
  if (n === 0) return [];
  const totalCents = Math.round(total * SCALE);
  const totalWeight = weights.reduce((a, w) => a + w, 0);
  if (totalWeight <= 0) {
    return weights.map((_, i) => (i === n - 1 ? totalCents / SCALE : 0));
  }
  const exact = weights.map((w) => (totalCents * w) / totalWeight);
  const cents = exact.map((e) => Math.floor(e));
  let leftover = totalCents - cents.reduce((a, b) => a + b, 0);
  const byFraction = exact
    .map((e, i) => ({ i, frac: e - Math.floor(e) }))
    .sort((a, b) => b.frac - a.frac);
  for (const { i } of byFraction) {
    if (leftover <= 0) break;
    cents[i]!++;
    leftover--;
  }
  return cents.map((c) => c / SCALE);
}
