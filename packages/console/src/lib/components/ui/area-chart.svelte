<script lang="ts">
  // Hand-rolled SVG time-series chart: a smooth gradient area for a money
  // series plus thin baseline bars for a count series (e.g. revenue + orders
  // per day). Sized to its container via bind:clientWidth so SVG units map
  // 1:1 to CSS pixels — pointer offsets need no scaling.
  export interface ChartPoint {
    label: string;
    value: number;
    bar: number;
  }

  let {
    points,
    formatValue,
    valueLabel = "Revenue",
    barLabel = "Orders",
    height = 240,
    formatTick = new Intl.NumberFormat("id-ID", {
      notation: "compact",
      maximumFractionDigits: 1,
    }).format,
  }: {
    points: ChartPoint[];
    formatValue: (v: number) => string;
    valueLabel?: string;
    barLabel?: string;
    height?: number;
    formatTick?: (v: number) => string;
  } = $props();

  const PAD = { left: 44, right: 8, top: 8, bottom: 20 };
  let width = $state(600);
  const plotW = $derived(Math.max(width - PAD.left - PAD.right, 1));
  const plotH = $derived(height - PAD.top - PAD.bottom);
  const baseline = $derived(PAD.top + plotH);

  /** Smallest 1/2/2.5/5×10ⁿ ≥ max, so gridline values stay round. */
  function niceMax(max: number): number {
    if (max <= 0) return 1;
    const pow = 10 ** Math.floor(Math.log10(max));
    for (const m of [1, 2, 2.5, 5]) if (m * pow >= max) return m * pow;
    return 10 * pow;
  }

  const yMax = $derived(niceMax(Math.max(0, ...points.map((p) => p.value))));
  const barMax = $derived(Math.max(1, ...points.map((p) => p.bar)));
  const step = $derived(points.length > 1 ? plotW / (points.length - 1) : plotW);
  const barW = $derived(Math.max(1.5, Math.min(step * 0.5, 12)));

  const xAt = (i: number) =>
    points.length === 1 ? PAD.left + plotW / 2 : PAD.left + i * step;
  const yAt = (v: number) => PAD.top + plotH * (1 - v / yMax);
  // Bars use their own scale and only the bottom quarter of the plot.
  const barH = (b: number) => (b / barMax) * plotH * 0.25;

  // Catmull-Rom → cubic bezier through every point. Control-point y is
  // clamped to the plot box so spikes next to zero days can't dip the curve
  // below the baseline.
  const linePath = $derived.by(() => {
    if (points.length < 2) return "";
    const pts = points.map((p, i) => [xAt(i), yAt(p.value)] as const);
    const clampY = (y: number) => Math.min(Math.max(y, PAD.top), baseline);
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
  });
  const areaPath = $derived(
    linePath &&
      `${linePath} L ${xAt(points.length - 1)} ${baseline} L ${xAt(0)} ${baseline} Z`,
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

  const gradId = `area-grad-${Math.random().toString(36).slice(2)}`;

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
      aria-label="{valueLabel} chart"
      onpointermove={onMove}
      onpointerleave={() => (hover = null)}
    >
      <defs>
        <linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stop-color="var(--primary)" stop-opacity="0.28" />
          <stop offset="1" stop-color="var(--primary)" stop-opacity="0" />
        </linearGradient>
      </defs>

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

      <!-- count bars -->
      {#each points as p, i (i)}
        {#if p.bar > 0}
          <rect
            x={xAt(i) - barW / 2}
            y={baseline - barH(p.bar)}
            width={barW}
            height={barH(p.bar)}
            rx={Math.min(barW / 2, 2)}
            fill="var(--muted-foreground)"
            opacity="0.35"
          />
        {/if}
      {/each}

      <!-- value series -->
      {#if points.length === 1}
        <circle cx={xAt(0)} cy={yAt(points[0].value)} r="4" fill="var(--primary)" />
      {:else}
        <path d={areaPath} fill="url(#{gradId})" />
        <path
          d={linePath}
          fill="none"
          stroke="var(--primary)"
          stroke-width="2"
          stroke-linejoin="round"
          stroke-linecap="round"
        />
      {/if}

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
        <circle
          cx={xAt(hover)}
          cy={yAt(points[hover].value)}
          r="3.5"
          fill="var(--primary)"
          stroke="var(--card)"
          stroke-width="1.5"
        />
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

    {#if hover !== null && points[hover]}
      <div
        class="pointer-events-none absolute top-2 z-10 rounded-md border bg-card px-2.5 py-1.5 text-xs shadow-sm"
        style:left="{xAt(hover)}px"
        style:transform={xAt(hover) > width / 2
          ? "translateX(calc(-100% - 8px))"
          : "translateX(8px)"}
      >
        <p class="font-medium">{points[hover].label}</p>
        <p>{valueLabel}: <span class="font-medium">{formatValue(points[hover].value)}</span></p>
        <p class="text-muted-foreground">{barLabel}: {points[hover].bar}</p>
      </div>
    {/if}
  </div>
{/if}
