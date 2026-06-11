<script lang="ts">
  // Dumb SVG donut: each slice is a circle stroke segment via dasharray, so
  // 0% and 100% slices need no special-casing (an SVG arc path can't draw a
  // full circle). The legend lives with the caller.
  export interface DonutSlice {
    value: number;
    color: string;
    opacity?: number;
  }

  let {
    slices,
    centerLabel,
    centerSub,
    size = 168,
    thickness = 26,
  }: {
    slices: DonutSlice[];
    centerLabel?: string;
    centerSub?: string;
    size?: number;
    thickness?: number;
  } = $props();

  const r = $derived((size - thickness) / 2);
  const circumference = $derived(2 * Math.PI * r);
  const total = $derived(slices.reduce((s, x) => s + Math.max(0, x.value), 0));
  // Cumulative start fraction per slice, for the dashoffset.
  const starts = $derived.by(() => {
    let acc = 0;
    return slices.map((s) => {
      const start = acc;
      acc += Math.max(0, s.value) / total;
      return start;
    });
  });
</script>

{#if total > 0}
  <svg
    viewBox="0 0 {size} {size}"
    width={size}
    height={size}
    role="img"
    aria-label={centerLabel ? `${centerLabel} ${centerSub ?? ""}` : "Breakdown"}
  >
    <!-- rotate so slices start at 12 o'clock -->
    <g transform="rotate(-90 {size / 2} {size / 2})">
      {#each slices as s, i (i)}
        {#if s.value > 0}
          <circle
            cx={size / 2}
            cy={size / 2}
            {r}
            fill="none"
            stroke={s.color}
            stroke-opacity={s.opacity ?? 1}
            stroke-width={thickness}
            stroke-dasharray="{(Math.max(0, s.value) / total) * circumference} {circumference}"
            stroke-dashoffset={-starts[i] * circumference}
          />
        {/if}
      {/each}
    </g>
    {#if centerLabel}
      <text
        x={size / 2}
        y={size / 2 + (centerSub ? 0 : 5)}
        text-anchor="middle"
        font-size="22"
        font-weight="600"
        fill="var(--foreground)"
      >
        {centerLabel}
      </text>
    {/if}
    {#if centerSub}
      <text
        x={size / 2}
        y={size / 2 + 18}
        text-anchor="middle"
        font-size="11"
        fill="var(--muted-foreground)"
      >
        {centerSub}
      </text>
    {/if}
  </svg>
{/if}
