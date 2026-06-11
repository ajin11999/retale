<script lang="ts">
  // Hand-rolled SVG multi-series line chart (sibling of area-chart): N money
  // series on a shared y scale, one smooth stroke each. Sized to its container
  // via bind:clientWidth so SVG units map 1:1 to CSS pixels.
  import { niceMax, smoothPath } from "./chart-utils";

  export interface LinePoint {
    label: string;
    /** One value per entry in `series`, same order. */
    values: number[];
  }
  export interface LineSeries {
    label: string;
    color: string;
  }

  let {
    points,
    series,
    formatValue,
    tooltipFooter,
    height = 240,
    formatTick = new Intl.NumberFormat("id-ID", {
      notation: "compact",
      maximumFractionDigits: 1,
    }).format,
  }: {
    points: LinePoint[];
    series: LineSeries[];
    formatValue: (v: number) => string;
    /** Extra muted tooltip line computed from the hovered point's values. */
    tooltipFooter?: (values: number[]) => string;
    height?: number;
    formatTick?: (v: number) => string;
  } = $props();

  const PAD = { left: 44, right: 8, top: 8, bottom: 20 };
  let width = $state(600);
  const plotW = $derived(Math.max(width - PAD.left - PAD.right, 1));
  const plotH = $derived(height - PAD.top - PAD.bottom);
  const baseline = $derived(PAD.top + plotH);

  const yMax = $derived(
    niceMax(Math.max(0, ...points.flatMap((p) => p.values))),
  );
  const step = $derived(points.length > 1 ? plotW / (points.length - 1) : plotW);

  const xAt = (i: number) =>
    points.length === 1 ? PAD.left + plotW / 2 : PAD.left + i * step;
  // Negative day values (returns exceeding sales) draw flat on the baseline;
  // the tooltip still shows the true number.
  const yAt = (v: number) =>
    Math.min(PAD.top + plotH * (1 - v / yMax), baseline);

  const linePaths = $derived(
    series.map((_, s) =>
      smoothPath(
        points.map((p, i) => [xAt(i), yAt(p.values[s])] as const),
        PAD.top,
        baseline,
      ),
    ),
  );

  const yTicks = $derived([0.25, 0.5, 0.75, 1].map((f) => f * yMax));
  const xLabelIdx = $derived.by(() => {
    const n = points.length;
    const count = Math.min(n, 6);
    return [...new Set(
      Array.from({ length: count }, (_, i) =>
        Math.round((i * (n - 1)) / Math.max(count - 1, 1)),
      ),
    )];
  });

  let hover = $state<number | null>(null);
  function onMove(e: PointerEvent) {
    if (points.length === 0) return;
    const i = Math.round((e.offsetX - PAD.left) / step);
    hover = Math.min(Math.max(i, 0), points.length - 1);
  }
</script>

{#if points.length > 0}
  <div class="relative" bind:clientWidth={width}>
    <svg
      viewBox="0 0 {width} {height}"
      width="100%"
      {height}
      class="block"
      role="img"
      aria-label="{series.map((s) => s.label).join(' vs ')} chart"
      onpointermove={onMove}
      onpointerleave={() => (hover = null)}
    >
      <!-- gridlines + y tick labels -->
      <line x1={PAD.left} x2={width - PAD.right} y1={baseline} y2={baseline} stroke="var(--border)" />
      {#each yTicks as t (t)}
        <line
          x1={PAD.left}
          x2={width - PAD.right}
          y1={yAt(t)}
          y2={yAt(t)}
          stroke="var(--border)"
          stroke-dasharray="3 3"
        />
        <text
          x={PAD.left - 6}
          y={yAt(t) + 3}
          text-anchor="end"
          font-size="10"
          fill="var(--muted-foreground)"
        >
          {formatTick(t)}
        </text>
      {/each}

      <!-- series -->
      {#each series as s, si (s.label)}
        {#if points.length === 1}
          <circle cx={xAt(0)} cy={yAt(points[0].values[si])} r="4" fill={s.color} />
        {:else}
          <path
            d={linePaths[si]}
            fill="none"
            stroke={s.color}
            stroke-width="2"
            stroke-linejoin="round"
            stroke-linecap="round"
          />
        {/if}
      {/each}

      <!-- crosshair -->
      {#if hover !== null && points[hover]}
        <line
          x1={xAt(hover)}
          x2={xAt(hover)}
          y1={PAD.top}
          y2={baseline}
          stroke="var(--muted-foreground)"
          opacity="0.4"
        />
        {#each series as s, si (s.label)}
          <circle
            cx={xAt(hover)}
            cy={yAt(points[hover].values[si])}
            r="3.5"
            fill={s.color}
            stroke="var(--card)"
            stroke-width="1.5"
          />
        {/each}
      {/if}

      <!-- x labels -->
      {#each xLabelIdx as i (i)}
        <text
          x={xAt(i)}
          y={height - 6}
          text-anchor="middle"
          font-size="10"
          fill="var(--muted-foreground)"
        >
          {points[i].label}
        </text>
      {/each}
    </svg>

    <!-- legend -->
    <div class="mt-1 flex gap-4 text-xs text-muted-foreground">
      {#each series as s (s.label)}
        <span class="flex items-center gap-1.5">
          <span class="size-2.5 rounded-full" style:background={s.color}></span>
          {s.label}
        </span>
      {/each}
    </div>

    {#if hover !== null && points[hover]}
      <div
        class="pointer-events-none absolute top-2 z-10 rounded-md border bg-card px-2.5 py-1.5 text-xs shadow-sm"
        style:left="{xAt(hover)}px"
        style:transform={xAt(hover) > width / 2
          ? "translateX(calc(-100% - 8px))"
          : "translateX(8px)"}
      >
        <p class="font-medium">{points[hover].label}</p>
        {#each series as s, si (s.label)}
          <p class="flex items-center gap-1.5">
            <span class="size-2 rounded-full" style:background={s.color}></span>
            {s.label}: <span class="font-medium">{formatValue(points[hover].values[si])}</span>
          </p>
        {/each}
        {#if tooltipFooter}
          <p class="text-muted-foreground">{tooltipFooter(points[hover].values)}</p>
        {/if}
      </div>
    {/if}
  </div>
{/if}
