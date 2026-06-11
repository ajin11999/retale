// Shared helpers for the hand-rolled SVG charts (area-chart, line-chart).

/** Smallest 1/2/2.5/5×10ⁿ ≥ max, so gridline values stay round. */
export function niceMax(max: number): number {
  if (max <= 0) return 1;
  const pow = 10 ** Math.floor(Math.log10(max));
  for (const m of [1, 2, 2.5, 5]) if (m * pow >= max) return m * pow;
  return 10 * pow;
}

/**
 * Catmull-Rom → cubic bezier path through every point. Control-point y is
 * clamped to [yTop, yBottom] so spikes next to zero days can't dip the curve
 * outside the plot box. Returns "" for fewer than 2 points.
 */
export function smoothPath(
  pts: readonly (readonly [number, number])[],
  yTop: number,
  yBottom: number,
): string {
  if (pts.length < 2) return "";
  const clampY = (y: number) => Math.min(Math.max(y, yTop), yBottom);
  let d = `M ${pts[0][0]} ${pts[0][1]}`;
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[i - 1] ?? pts[i];
    const p1 = pts[i];
    const p2 = pts[i + 1];
    const p3 = pts[i + 2] ?? p2;
    const c1y = clampY(p1[1] + (p2[1] - p0[1]) / 6);
    const c2y = clampY(p2[1] - (p3[1] - p1[1]) / 6);
    d += ` C ${p1[0] + (p2[0] - p1[0]) / 3} ${c1y}, ${p2[0] - (p2[0] - p1[0]) / 3} ${c2y}, ${p2[0]} ${p2[1]}`;
  }
  return d;
}
