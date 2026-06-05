<script lang="ts">
  import { graphql } from "$houdini";
  import { page } from "$app/state";
  import type { Viewer } from "../+layout.server";
  import { formatMoney } from "$lib/utils";
  import Badge from "$lib/components/ui/badge.svelte";
  import Button from "$lib/components/ui/button.svelte";
  import Input from "$lib/components/ui/input.svelte";

  // Each report is its own query store, fetched on demand — a viewer may hold
  // only some report.* keys, so querying them together would error on the
  // fields they cannot see. +page.ts is omitted; these fetch client-side.
  // Reports are point-in-time snapshots — always re-query so a sale/payment made
  // elsewhere (e.g. an order just closed in the POS) shows up, instead of serving
  // Houdini's cached copy from the previous fetch.
  const SalesReport = graphql(`
    query SalesReport($periodStart: String!, $periodEnd: String!) @cache(policy: NetworkOnly) {
      salesReport(periodStart: $periodStart, periodEnd: $periodEnd) {
        periodStart
        periodEnd
        orderCount
        itemsSoldQty
        revenueMinor
        byDay {
          date
          orderCount
          revenueMinor
        }
      }
    }
  `);

  const ProfitReport = graphql(`
    query ProfitReport($periodStart: String!, $periodEnd: String!) @cache(policy: NetworkOnly) {
      profitReport(periodStart: $periodStart, periodEnd: $periodEnd) {
        revenueMinor
        cogsMinor
        grossMarginMinor
        marginBps
      }
    }
  `);

  const ArAgingReport = graphql(`
    query ArAgingReport @cache(policy: NetworkOnly) {
      arAgingReport {
        asOf
        totalBalanceMinor
        rows {
          partyId
          partyName
          balanceMinor
          bucket0_30
          bucket31_60
          bucket61_90
          bucket90plus
        }
      }
    }
  `);

  const ApAgingReport = graphql(`
    query ApAgingReport @cache(policy: NetworkOnly) {
      apAgingReport {
        asOf
        totalBalanceMinor
        rows {
          partyId
          partyName
          balanceMinor
          bucket0_30
          bucket31_60
          bucket61_90
          bucket90plus
        }
      }
    }
  `);

  const SessionVarianceReport = graphql(`
    query SessionVarianceReport($periodStart: String!, $periodEnd: String!) @cache(policy: NetworkOnly) {
      sessionVarianceReport(periodStart: $periodStart, periodEnd: $periodEnd) {
        totalVarianceMinor
        unreconciledCount
        sessions {
          sessionId
          posCode
          openedAt
          closedAt
          openingCashMinor
          closingCashMinor
          varianceMinor
          forceClosed
        }
      }
    }
  `);

  // Current tracking-account balances — read-only mirror of /tracking, shown as
  // a Reports tab. Not period-driven; reuses the existing trackingAccounts field.
  const TrackingBalances = graphql(`
    query TrackingBalances @cache(policy: NetworkOnly) {
      trackingAccounts {
        id
        parentId
        name
        code
        accountCategory
        balanceMinor
        archivedAt
      }
    }
  `);

  // Buying activity — purchases and delivery costs for the period, for manual
  // GnuCash inventory-valuation entry. Both reuse the existing list queries and
  // are summed client-side (retail volumes are small).
  const ReportPurchases = graphql(`
    query ReportPurchases @cache(policy: NetworkOnly) {
      purchases(includeCancelled: true) {
        id
        snapshotVendorName
        date
        status
        totalInvoiceCost
      }
    }
  `);
  const ReportDeliveries = graphql(`
    query ReportDeliveries @cache(policy: NetworkOnly) {
      deliveries {
        id
        date
        status
        leafLandings {
          freightMinor
        }
      }
    }
  `);

  // ---- Viewer permissions --------------------------------------------------
  const viewer = $derived(page.data.user as Viewer | undefined);
  const has = (key: string) => !!viewer && viewer.permissions.includes(key);

  // Tabs the viewer is allowed to see — each report is gated on its own key.
  interface Tab {
    id: string;
    label: string;
    perm: string;
    ranged: boolean; // true → driven by the period inputs
  }
  const ALL_TABS: Tab[] = [
    { id: "sales", label: "Sales", perm: "report.sales.view", ranged: true },
    { id: "profit", label: "Profit", perm: "report.margin.view", ranged: true },
    { id: "ar", label: "AR aging", perm: "report.ar_aging.view", ranged: false },
    { id: "ap", label: "AP aging", perm: "report.ap_aging.view", ranged: false },
    {
      id: "variance",
      label: "Cash variance",
      perm: "report.session_variance.view",
      ranged: true,
    },
    {
      id: "buying",
      label: "Purchases & Deliveries",
      perm: "purchase.edit",
      ranged: true,
    },
    { id: "tracking", label: "Tracking", perm: "tracking_account.edit", ranged: false },
  ];
  const tabs = $derived(ALL_TABS.filter((t) => has(t.perm)));

  // ---- Period --------------------------------------------------------------
  // Default to the last 30 days.
  const today = new Date();
  const ago = new Date(today.getTime() - 29 * 86_400_000);
  let periodStart = $state(ago.toISOString().slice(0, 10));
  let periodEnd = $state(today.toISOString().slice(0, 10));

  let active = $state<string | null>(null);
  // Pick the first permitted tab once the viewer resolves.
  $effect(() => {
    if (active === null && tabs.length) active = tabs[0].id;
  });

  let busy = $state(false);
  let error = $state<string | null>(null);

  /** Fetch the store backing the active tab with the current period. */
  async function load(tabId: string) {
    busy = true;
    error = null;
    const range = { periodStart, periodEnd };
    try {
      if (tabId === "sales") await SalesReport.fetch({ variables: range });
      else if (tabId === "profit") await ProfitReport.fetch({ variables: range });
      else if (tabId === "ar") await ArAgingReport.fetch();
      else if (tabId === "ap") await ApAgingReport.fetch();
      else if (tabId === "variance")
        await SessionVarianceReport.fetch({ variables: range });
      else if (tabId === "tracking") await TrackingBalances.fetch();
      else if (tabId === "buying") {
        await ReportPurchases.fetch();
        if (has("delivery.draft")) await ReportDeliveries.fetch();
      }
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    } finally {
      busy = false;
    }
  }

  function selectTab(id: string) {
    active = id;
    load(id);
  }

  // First load when a tab becomes active.
  let loadedFor = $state("");
  $effect(() => {
    if (active && active !== loadedFor) {
      loadedFor = active;
      load(active);
    }
  });

  const sales = $derived($SalesReport.data?.salesReport);
  const profit = $derived($ProfitReport.data?.profitReport);
  const ar = $derived($ArAgingReport.data?.arAgingReport);
  const ap = $derived($ApAgingReport.data?.apAgingReport);
  const variance = $derived($SessionVarianceReport.data?.sessionVarianceReport);

  // ---- Tracking balances tree ----------------------------------------------
  type TrackingAcc = NonNullable<
    typeof $TrackingBalances.data
  >["trackingAccounts"][number];
  type TrackingNode = { acc: TrackingAcc; children: TrackingNode[] };

  const trackingAccounts = $derived(
    $TrackingBalances.data?.trackingAccounts ?? [],
  );
  const trackingTree = $derived.by<TrackingNode[]>(() => {
    const visible = trackingAccounts.filter((a) => !a.archivedAt);
    const byParent = new Map<string | null, TrackingAcc[]>();
    for (const a of visible) {
      const key = a.parentId ?? null;
      const list = byParent.get(key) ?? [];
      list.push(a);
      byParent.set(key, list);
    }
    for (const list of byParent.values()) {
      list.sort((x, y) => x.name.localeCompare(y.name));
    }
    const build = (parentId: string | null): TrackingNode[] =>
      (byParent.get(parentId) ?? []).map((acc) => ({
        acc,
        children: build(acc.id),
      }));
    return build(null);
  });
  const trackingTotalMinor = $derived(
    trackingAccounts.reduce(
      (s, a) => (a.archivedAt ? s : s + a.balanceMinor),
      0,
    ),
  );

  // ---- Purchases & deliveries totals ---------------------------------------
  // Both `date` fields are `YYYY-MM-DD`, so a lexical range test is exact.
  const inRange = (d: string) =>
    d.slice(0, 10) >= periodStart && d.slice(0, 10) <= periodEnd;

  const purchaseRows = $derived(
    ($ReportPurchases.data?.purchases ?? []).filter(
      (p) => p.status !== "cancelled" && inRange(p.date),
    ),
  );
  const purchasesTotalMinor = $derived(
    purchaseRows.reduce((s, p) => s + p.totalInvoiceCost, 0),
  );

  interface DeliveryRecap {
    id: string;
    date: string;
    freightMinor: number;
  }
  const deliveryRows = $derived<DeliveryRecap[]>(
    ($ReportDeliveries.data?.deliveries ?? [])
      .filter((d) => d.status === "delivered" && inRange(d.date))
      .map((d) => ({
        id: d.id,
        date: d.date,
        freightMinor: d.leafLandings.reduce((s, l) => s + l.freightMinor, 0),
      })),
  );
  const deliveryCostTotalMinor = $derived(
    deliveryRows.reduce((s, d) => s + d.freightMinor, 0),
  );

  const fmtDate = (iso: string | null | undefined) =>
    iso ? new Date(iso).toLocaleDateString("id-ID") : "—";
  const fmtDateTime = (iso: string | null | undefined) =>
    iso ? new Date(iso).toLocaleString("id-ID") : "—";
  // marginBps → percent, e.g. 2750 → "27.5%".
  const pct = (bps: number) => `${(bps / 100).toFixed(1)}%`;
</script>

<svelte:head><title>Reports · Retale Console</title></svelte:head>

<div class="space-y-4">
  <h1 class="text-xl font-semibold">Reports</h1>

  {#if tabs.length === 0}
    <p
      class="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800"
    >
      You don't have access to any reports.
    </p>
  {:else}
    <!-- Tab bar -->
    <div class="flex gap-1 border-b">
      {#each tabs as t (t.id)}
        <button
          class="border-b-2 px-3 py-2 text-sm transition-colors
            {active === t.id
            ? 'border-primary font-medium text-foreground'
            : 'border-transparent text-muted-foreground hover:text-foreground'}"
          onclick={() => selectTab(t.id)}
        >
          {t.label}
        </button>
      {/each}
    </div>

    <!-- Period control — only the ranged reports use it -->
    {#if tabs.find((t) => t.id === active)?.ranged}
      <div class="flex items-end gap-3">
        <label class="space-y-1">
          <span class="text-sm font-medium">From</span>
          <Input type="date" bind:value={periodStart} class="w-44" />
        </label>
        <label class="space-y-1">
          <span class="text-sm font-medium">To</span>
          <Input type="date" bind:value={periodEnd} class="w-44" />
        </label>
        <Button
          size="sm"
          disabled={busy}
          onclick={() => active && load(active)}
        >
          Apply
        </Button>
      </div>
    {/if}

    {#if error}
      <p class="text-sm text-destructive">{error}</p>
    {/if}

    {#if busy}
      <p class="text-sm text-muted-foreground">Loading…</p>
    {/if}

    <!-- ---- Sales ---------------------------------------------------------- -->
    {#if active === "sales" && !busy}
      {#if sales}
        <div class="grid grid-cols-3 gap-4">
          <div class="rounded-lg border bg-card p-4">
            <p class="text-sm text-muted-foreground">Orders</p>
            <p class="text-2xl font-semibold">{sales.orderCount}</p>
          </div>
          <div class="rounded-lg border bg-card p-4">
            <p class="text-sm text-muted-foreground">Units sold</p>
            <p class="text-2xl font-semibold">{sales.itemsSoldQty}</p>
          </div>
          <div class="rounded-lg border bg-card p-4">
            <p class="text-sm text-muted-foreground">Revenue</p>
            <p class="text-2xl font-semibold">
              {formatMoney(sales.revenueMinor)}
            </p>
          </div>
        </div>
        <div class="overflow-hidden rounded-lg border bg-card">
          <table class="w-full text-sm">
            <thead class="border-b bg-muted/50 text-left text-muted-foreground">
              <tr>
                <th class="px-4 py-2 font-medium">Date</th>
                <th class="px-4 py-2 text-right font-medium">Orders</th>
                <th class="px-4 py-2 text-right font-medium">Revenue</th>
              </tr>
            </thead>
            <tbody>
              {#each sales.byDay as d (d.date)}
                <tr class="border-b last:border-0">
                  <td class="px-4 py-2">{fmtDate(d.date)}</td>
                  <td class="px-4 py-2 text-right">{d.orderCount}</td>
                  <td class="px-4 py-2 text-right">
                    {formatMoney(d.revenueMinor)}
                  </td>
                </tr>
              {/each}
              {#if sales.byDay.length === 0}
                <tr>
                  <td
                    colspan="3"
                    class="px-4 py-8 text-center text-muted-foreground"
                  >
                    No sales in this period.
                  </td>
                </tr>
              {/if}
            </tbody>
          </table>
        </div>
      {/if}
    {/if}

    <!-- ---- Profit --------------------------------------------------------- -->
    {#if active === "profit" && !busy && profit}
      <div class="grid grid-cols-4 gap-4">
        <div class="rounded-lg border bg-card p-4">
          <p class="text-sm text-muted-foreground">Revenue</p>
          <p class="text-2xl font-semibold">{formatMoney(profit.revenueMinor)}</p>
        </div>
        <div class="rounded-lg border bg-card p-4">
          <p class="text-sm text-muted-foreground">COGS</p>
          <p class="text-2xl font-semibold">{formatMoney(profit.cogsMinor)}</p>
        </div>
        <div class="rounded-lg border bg-card p-4">
          <p class="text-sm text-muted-foreground">Gross margin</p>
          <p class="text-2xl font-semibold">
            {formatMoney(profit.grossMarginMinor)}
          </p>
        </div>
        <div class="rounded-lg border bg-card p-4">
          <p class="text-sm text-muted-foreground">Margin</p>
          <p class="text-2xl font-semibold">{pct(profit.marginBps)}</p>
        </div>
      </div>
    {/if}

    <!-- ---- AR / AP aging -------------------------------------------------- -->
    {#each [{ id: "ar", report: ar, who: "Customer" }, { id: "ap", report: ap, who: "Vendor" }] as v (v.id)}
      {#if active === v.id && !busy && v.report}
        <p class="text-sm text-muted-foreground">
          As of {fmtDate(v.report.asOf)} · total outstanding
          <span class="font-medium text-foreground"
            >{formatMoney(v.report.totalBalanceMinor)}</span
          >
        </p>
        <div class="overflow-hidden rounded-lg border bg-card">
          <table class="w-full text-sm">
            <thead class="border-b bg-muted/50 text-left text-muted-foreground">
              <tr>
                <th class="px-4 py-2 font-medium">{v.who}</th>
                <th class="px-4 py-2 text-right font-medium">Balance</th>
                <th class="px-4 py-2 text-right font-medium">0–30</th>
                <th class="px-4 py-2 text-right font-medium">31–60</th>
                <th class="px-4 py-2 text-right font-medium">61–90</th>
                <th class="px-4 py-2 text-right font-medium">90+</th>
              </tr>
            </thead>
            <tbody>
              {#each v.report.rows as r (r.partyId)}
                <tr class="border-b last:border-0">
                  <td class="px-4 py-2 font-medium">{r.partyName}</td>
                  <td class="px-4 py-2 text-right">
                    {formatMoney(r.balanceMinor)}
                  </td>
                  <td class="px-4 py-2 text-right">{formatMoney(r.bucket0_30)}</td>
                  <td class="px-4 py-2 text-right">{formatMoney(r.bucket31_60)}</td>
                  <td class="px-4 py-2 text-right">{formatMoney(r.bucket61_90)}</td>
                  <td class="px-4 py-2 text-right">
                    {formatMoney(r.bucket90plus)}
                  </td>
                </tr>
              {/each}
              {#if v.report.rows.length === 0}
                <tr>
                  <td
                    colspan="6"
                    class="px-4 py-8 text-center text-muted-foreground"
                  >
                    Nothing outstanding.
                  </td>
                </tr>
              {/if}
            </tbody>
          </table>
        </div>
      {/if}
    {/each}

    <!-- ---- Cash variance ------------------------------------------------- -->
    {#if active === "variance" && !busy && variance}
      <div class="grid grid-cols-2 gap-4">
        <div class="rounded-lg border bg-card p-4">
          <p class="text-sm text-muted-foreground">Total variance</p>
          <p class="text-2xl font-semibold">
            {formatMoney(variance.totalVarianceMinor)}
          </p>
        </div>
        <div class="rounded-lg border bg-card p-4">
          <p class="text-sm text-muted-foreground">Unreconciled sessions</p>
          <p class="text-2xl font-semibold">{variance.unreconciledCount}</p>
        </div>
      </div>
      <div class="overflow-hidden rounded-lg border bg-card">
        <table class="w-full text-sm">
          <thead class="border-b bg-muted/50 text-left text-muted-foreground">
            <tr>
              <th class="px-4 py-2 font-medium">POS</th>
              <th class="px-4 py-2 font-medium">Opened</th>
              <th class="px-4 py-2 font-medium">Closed</th>
              <th class="px-4 py-2 text-right font-medium">Opening</th>
              <th class="px-4 py-2 text-right font-medium">Closing</th>
              <th class="px-4 py-2 text-right font-medium">Variance</th>
            </tr>
          </thead>
          <tbody>
            {#each variance.sessions as s (s.sessionId)}
              <tr class="border-b last:border-0">
                <td class="px-4 py-2 font-medium">{s.posCode}</td>
                <td class="px-4 py-2">{fmtDateTime(s.openedAt)}</td>
                <td class="px-4 py-2">{fmtDateTime(s.closedAt)}</td>
                <td class="px-4 py-2 text-right">
                  {formatMoney(s.openingCashMinor)}
                </td>
                <td class="px-4 py-2 text-right">
                  {s.closingCashMinor == null
                    ? "—"
                    : formatMoney(s.closingCashMinor)}
                </td>
                <td class="px-4 py-2 text-right">
                  {#if s.forceClosed}
                    <Badge class="bg-amber-100 text-amber-800">
                      force-closed
                    </Badge>
                  {:else if s.varianceMinor == null}
                    —
                  {:else}
                    <span
                      class={s.varianceMinor === 0
                        ? ""
                        : "font-medium text-destructive"}
                    >
                      {formatMoney(s.varianceMinor)}
                    </span>
                  {/if}
                </td>
              </tr>
            {/each}
            {#if variance.sessions.length === 0}
              <tr>
                <td
                  colspan="6"
                  class="px-4 py-8 text-center text-muted-foreground"
                >
                  No sessions closed in this period.
                </td>
              </tr>
            {/if}
          </tbody>
        </table>
      </div>
    {/if}

    <!-- ---- Purchases & deliveries --------------------------------------- -->
    {#if active === "buying" && !busy}
      <div class="grid grid-cols-2 gap-4">
        <div class="rounded-lg border bg-card p-4">
          <p class="text-sm text-muted-foreground">
            Total purchases ({purchaseRows.length})
          </p>
          <p class="text-2xl font-semibold">
            {formatMoney(purchasesTotalMinor)}
          </p>
          <p class="mt-1 text-xs text-muted-foreground">
            Goods ordered (non-cancelled), by purchase date.
          </p>
        </div>
        <div class="rounded-lg border bg-card p-4">
          <p class="text-sm text-muted-foreground">
            Total delivery cost ({deliveryRows.length})
          </p>
          {#if has("delivery.draft")}
            <p class="text-2xl font-semibold">
              {formatMoney(deliveryCostTotalMinor)}
            </p>
            <p class="mt-1 text-xs text-muted-foreground">
              Freight / customs added on receipt, excluding goods lines.
            </p>
          {:else}
            <p class="text-2xl font-semibold text-muted-foreground">—</p>
            <p class="mt-1 text-xs text-muted-foreground">
              Requires delivery access.
            </p>
          {/if}
        </div>
      </div>
      <div class="overflow-hidden rounded-lg border bg-card">
        <table class="w-full text-sm">
          <thead class="border-b bg-muted/50 text-left text-muted-foreground">
            <tr>
              <th class="px-4 py-2 font-medium">Date</th>
              <th class="px-4 py-2 font-medium">Vendor</th>
              <th class="px-4 py-2 text-right font-medium">Invoice total</th>
            </tr>
          </thead>
          <tbody>
            {#each purchaseRows as p (p.id)}
              <tr class="border-b last:border-0">
                <td class="px-4 py-2">{fmtDate(p.date)}</td>
                <td class="px-4 py-2">{p.snapshotVendorName ?? "—"}</td>
                <td class="px-4 py-2 text-right">
                  {formatMoney(p.totalInvoiceCost)}
                </td>
              </tr>
            {/each}
            {#if purchaseRows.length === 0}
              <tr>
                <td
                  colspan="3"
                  class="px-4 py-8 text-center text-muted-foreground"
                >
                  No purchases in this period.
                </td>
              </tr>
            {/if}
          </tbody>
        </table>
      </div>
    {/if}

    <!-- ---- Tracking balances -------------------------------------------- -->
    {#if active === "tracking" && !busy}
      <div class="overflow-hidden rounded-lg border bg-card">
        <table class="w-full text-sm">
          <thead class="border-b bg-muted/50 text-left text-muted-foreground">
            <tr>
              <th class="px-4 py-2 font-medium">Account</th>
              <th class="px-4 py-2 font-medium">Category</th>
              <th class="px-4 py-2 text-right font-medium">Balance</th>
            </tr>
          </thead>
          <tbody>
            {#each trackingTree as node (node.acc.id)}
              {@render trackingRow(node, 0)}
            {/each}
            {#if trackingTree.length === 0}
              <tr>
                <td
                  colspan="3"
                  class="px-4 py-8 text-center text-muted-foreground"
                >
                  No tracking accounts.
                </td>
              </tr>
            {:else}
              <tr class="border-t bg-muted/30 font-medium">
                <td class="px-4 py-2" colspan="2">Total owed</td>
                <td class="px-4 py-2 text-right">
                  {formatMoney(trackingTotalMinor)}
                </td>
              </tr>
            {/if}
          </tbody>
        </table>
      </div>
    {/if}
  {/if}
</div>

{#snippet trackingRow(node: TrackingNode, depth: number)}
  <tr class="border-b last:border-0">
    <td class="px-4 py-2" style:padding-left="{depth * 1.25 + 1}rem">
      <span class="font-medium">{node.acc.name}</span>
      {#if node.acc.code}
        <span class="ml-1 text-xs text-muted-foreground">{node.acc.code}</span>
      {/if}
    </td>
    <td class="px-4 py-2 font-mono text-xs text-muted-foreground">
      {node.acc.accountCategory}
    </td>
    <td class="px-4 py-2 text-right">
      <span class={node.acc.balanceMinor > 0 ? "font-medium" : ""}>
        {formatMoney(node.acc.balanceMinor)}
      </span>
    </td>
  </tr>
  {#each node.children as child (child.acc.id)}
    {@render trackingRow(child, depth + 1)}
  {/each}
{/snippet}
