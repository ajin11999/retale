<script lang="ts">
  import { graphql } from "$houdini";
  import { page } from "$app/state";
  import { formatMoney } from "$lib/utils";
  import Input from "$lib/components/ui/input.svelte";
  import { t } from "$lib/i18n";
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

  let search = $state("");

  const filtered = $derived.by(() => {
    const q = search.trim().toLowerCase();
    if (!q) return rows;
    return rows.filter(
      (r) =>
        r.productName.toLowerCase().includes(q) ||
        (r.variantLabel?.toLowerCase().includes(q) ?? false) ||
        r.sku.toLowerCase().includes(q),
    );
  });

  const fmt = (iso: string | null | undefined) =>
    iso ? new Date(iso).toLocaleString("id-ID") : "—";

  // Margin as a percent of revenue; "—" when there's no revenue to divide by.
  const marginPct = (revenue: number, cost: number) =>
    revenue === 0 ? "—" : `${(((revenue - cost) / revenue) * 100).toFixed(1)}%`;

  // Totals follow the search filter on purpose: searching "bolt" should show
  // bolt-only revenue/margin, not the whole session's.
  const totals = $derived.by(() =>
    filtered.reduce(
      (t, r) => ({
        qty: t.qty + r.qtySold,
        revenue: t.revenue + r.revenueMinor,
        cost: t.cost + r.costMinor,
      }),
      { qty: 0, revenue: 0, cost: 0 },
    ),
  );
</script>

<svelte:head><title>{t("sessions.variantSalesPageTitle")}</title></svelte:head>

<div class="space-y-4">
  <a
    href={`/sessions/${page.params.id}`}
    class="text-sm text-primary hover:underline"
  >
    {t("sessions.backToSession")}
  </a>

  {#if $SessionVariants.fetching && rows.length === 0}
    <p class="text-sm text-muted-foreground">{t("common.loading")}</p>
  {:else if $SessionVariants.errors?.length}
    <p class="text-sm text-destructive">{$SessionVariants.errors[0].message}</p>
  {:else}
    <div>
      <h1 class="text-xl font-semibold">
        {session
          ? t("sessions.variantSalesSession", { id: session.id.slice(-8) })
          : t("sessions.variantSales")}
      </h1>
      {#if session}
        <p class="text-sm text-muted-foreground">
          {t("sessions.openedAt", { date: fmt(session.openedAt) })}{session.closedAt
            ? ` · ${t("sessions.closedAt", { date: fmt(session.closedAt) })}`
            : ""}
        </p>
      {/if}
    </div>

    <div class="flex items-center gap-2">
      <div class="w-full max-w-sm">
        <Input
          type="search"
          placeholder={t("sessions.searchVariants")}
          bind:value={search}
        />
      </div>
      {#if search.trim()}
        <span class="whitespace-nowrap text-xs text-muted-foreground">
          {t("sessions.resultsCount", { count: filtered.length, total: rows.length })}
        </span>
      {/if}
    </div>

    <div class="overflow-hidden rounded-lg border bg-card">
      <table class="w-full text-sm">
        <thead class="border-b bg-muted/50 text-left text-muted-foreground">
          <tr>
            <th class="px-4 py-2 font-medium">{t("common.product")}</th>
            <th class="px-4 py-2 font-medium">{t("common.sku")}</th>
            <th class="px-4 py-2 text-right font-medium">{t("sessions.qtySold")}</th>
            <th class="px-4 py-2 text-right font-medium">{t("sessions.revenue")}</th>
            <th class="px-4 py-2 text-right font-medium">{t("common.cost")}</th>
            <th class="px-4 py-2 text-right font-medium">{t("sessions.margin")}</th>
            <th class="px-4 py-2 text-right font-medium">{t("sessions.marginPct")}</th>
          </tr>
        </thead>
        <tbody>
          {#each filtered as r (r.variantId ?? r.sku)}
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
                {t("sessions.noVariantsSold")}
              </td>
            </tr>
          {:else if filtered.length === 0}
            <tr>
              <td colspan="7" class="px-4 py-10 text-center text-muted-foreground">
                {t("sessions.noVariantsMatch", { query: search.trim() })}
              </td>
            </tr>
          {:else}
            {@const margin = totals.revenue - totals.cost}
            <tr class="border-t bg-muted/30 font-medium">
              <td class="px-4 py-2" colspan="2">{t("common.total")}</td>
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
