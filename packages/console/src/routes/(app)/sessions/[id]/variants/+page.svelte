<script lang="ts">
  import { graphql } from "$houdini";
  import { page } from "$app/state";
  import { formatMoney } from "$lib/utils";
  import type { PageData } from "./$types";

  graphql(`
    query SessionVariants($id: ID!) {
      posSession(id: $id) {
        id
        openedAt
        closedAt
      }
      sessionVariantSales(sessionId: $id) {
        variantId
        productName
        variantLabel
        sku
        qtySold
        revenueMinor
        costMinor
      }
    }
  `);

  let { data }: { data: PageData } = $props();
  const SessionVariants = $derived(data.SessionVariants);
  const session = $derived($SessionVariants.data?.posSession ?? null);
  const rows = $derived($SessionVariants.data?.sessionVariantSales ?? []);

  const fmt = (iso: string | null | undefined) =>
    iso ? new Date(iso).toLocaleString("id-ID") : "—";

  // Margin as a percent of revenue; "—" when there's no revenue to divide by.
  const marginPct = (revenue: number, cost: number) =>
    revenue === 0 ? "—" : `${(((revenue - cost) / revenue) * 100).toFixed(1)}%`;

  const totals = $derived.by(() =>
    rows.reduce(
      (t, r) => ({
        qty: t.qty + r.qtySold,
        revenue: t.revenue + r.revenueMinor,
        cost: t.cost + r.costMinor,
      }),
      { qty: 0, revenue: 0, cost: 0 },
    ),
  );
</script>

<svelte:head><title>Variant sales · Retale Console</title></svelte:head>

<div class="space-y-4">
  <a
    href={`/sessions/${page.params.id}`}
    class="text-sm text-primary hover:underline"
  >
    ← Back to session
  </a>

  {#if $SessionVariants.fetching && rows.length === 0}
    <p class="text-sm text-muted-foreground">Loading…</p>
  {:else if $SessionVariants.errors?.length}
    <p class="text-sm text-destructive">{$SessionVariants.errors[0].message}</p>
  {:else}
    <div>
      <h1 class="text-xl font-semibold">
        Variant sales{session ? ` · session ${session.id.slice(-8)}` : ""}
      </h1>
      {#if session}
        <p class="text-sm text-muted-foreground">
          Opened {fmt(session.openedAt)} · closed {fmt(session.closedAt)}
        </p>
      {/if}
    </div>

    <div class="overflow-hidden rounded-lg border bg-card">
      <table class="w-full text-sm">
        <thead class="border-b bg-muted/50 text-left text-muted-foreground">
          <tr>
            <th class="px-4 py-2 font-medium">Product</th>
            <th class="px-4 py-2 font-medium">SKU</th>
            <th class="px-4 py-2 text-right font-medium">Qty sold</th>
            <th class="px-4 py-2 text-right font-medium">Revenue</th>
            <th class="px-4 py-2 text-right font-medium">Cost</th>
            <th class="px-4 py-2 text-right font-medium">Margin</th>
            <th class="px-4 py-2 text-right font-medium">Margin %</th>
          </tr>
        </thead>
        <tbody>
          {#each rows as r (r.variantId ?? r.sku)}
            {@const margin = r.revenueMinor - r.costMinor}
            <tr class="border-b last:border-0 hover:bg-muted/40">
              <td class="px-4 py-2">
                <span class="font-medium">{r.productName}</span>
                {#if r.variantLabel}
                  <span class="ml-1 text-xs text-muted-foreground">
                    {r.variantLabel}
                  </span>
                {/if}
              </td>
              <td class="px-4 py-2 font-mono text-xs text-muted-foreground">
                {r.sku}
              </td>
              <td class="px-4 py-2 text-right">{r.qtySold}</td>
              <td class="px-4 py-2 text-right">{formatMoney(r.revenueMinor)}</td>
              <td class="px-4 py-2 text-right">{formatMoney(r.costMinor)}</td>
              <td class="px-4 py-2 text-right {margin < 0 ? 'text-destructive' : ''}">
                {formatMoney(margin)}
              </td>
              <td class="px-4 py-2 text-right text-muted-foreground">
                {marginPct(r.revenueMinor, r.costMinor)}
              </td>
            </tr>
          {/each}
          {#if rows.length === 0}
            <tr>
              <td colspan="7" class="px-4 py-10 text-center text-muted-foreground">
                No variants sold in this session.
              </td>
            </tr>
          {:else}
            {@const margin = totals.revenue - totals.cost}
            <tr class="border-t bg-muted/30 font-medium">
              <td class="px-4 py-2" colspan="2">Total</td>
              <td class="px-4 py-2 text-right">{totals.qty}</td>
              <td class="px-4 py-2 text-right">{formatMoney(totals.revenue)}</td>
              <td class="px-4 py-2 text-right">{formatMoney(totals.cost)}</td>
              <td class="px-4 py-2 text-right {margin < 0 ? 'text-destructive' : ''}">
                {formatMoney(margin)}
              </td>
              <td class="px-4 py-2 text-right text-muted-foreground">
                {marginPct(totals.revenue, totals.cost)}
              </td>
            </tr>
          {/if}
        </tbody>
      </table>
    </div>
  {/if}
</div>
