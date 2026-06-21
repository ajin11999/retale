<script lang="ts">
  import { CachePolicy, graphql } from "$houdini";
  import { onMount } from "svelte";
  import { page } from "$app/state";
  import {
    ArrowDownToLine,
    ArrowUpFromLine,
    Landmark,
    PackageSearch,
    ClipboardList,
    TriangleAlert,
    Truck,
    Users,
  } from "@lucide/svelte";
  import type { Component } from "svelte";
  import type { Viewer } from "./+layout.server";
  import { formatMoney } from "$lib/utils";
  import { refetchOnVisible } from "$lib/refetch-on-visible.svelte";
  import Button from "$lib/components/ui/button.svelte";
  import Combobox from "$lib/components/ui/combobox.svelte";
  import Input from "$lib/components/ui/input.svelte";
  import MoneyInput from "$lib/components/ui/money-input.svelte";

  // ---- Informatic counts ---------------------------------------------------
  // Product + purchase alerts share the alert.acknowledge gate, so they ride a
  // single document. Reorder needs report.sales.view — its own query. Each is
  // fetched client-side, guarded by permission, so a viewer missing a gate
  // simply doesn't see (or fetch) that card rather than erroring the page.
  const DashboardAlerts = graphql(`
    query DashboardAlerts {
      productAlerts(acknowledged: false) {
        id
      }
      purchaseAlerts(acknowledged: false) {
        id
      }
    }
  `);

  const DashboardReorder = graphql(`
    query DashboardReorder {
      reorderSuggestions(status: open) {
        id
      }
    }
  `);

  // ---- Cash-shortcut pickers -----------------------------------------------
  // Loaded lazily the first time a card's panel opens — these lists can be
  // large and most dashboard visits never touch them.
  const DashTrackingAccounts = graphql(`
    query DashTrackingAccounts {
      trackingAccounts(includeArchived: false) {
        id
        name
        balanceMinor
      }
    }
  `);

  const DashVendors = graphql(`
    query DashVendors {
      vendors {
        id
        name
        balanceMinor
        archivedAt
      }
    }
  `);

  const DashCustomers = graphql(`
    query DashCustomers {
      customers {
        id
        name
        balanceMinor
        archivedAt
      }
    }
  `);

  // ---- Cash-shortcut mutations ---------------------------------------------
  // Distinct operation names from the detail-page documents (Houdini requires
  // unique names); they hit the same API fields.
  const RecordTrackingDeposit = graphql(`
    mutation DashRecordTrackingDeposit(
      $accountId: ID!
      $amountMinor: Float!
      $note: String
    ) {
      recordTrackingDeposit(
        accountId: $accountId
        amountMinor: $amountMinor
        note: $note
      ) {
        id
        balanceMinor
      }
    }
  `);

  const RecordTrackingPayout = graphql(`
    mutation DashRecordTrackingPayout(
      $accountId: ID!
      $amountMinor: Float!
      $note: String
    ) {
      recordTrackingPayout(
        accountId: $accountId
        amountMinor: $amountMinor
        note: $note
      ) {
        id
        balanceMinor
      }
    }
  `);

  const RecordVendorPayment = graphql(`
    mutation DashRecordVendorPayment(
      $vendorId: ID!
      $amountMinor: Float!
      $note: String
    ) {
      recordVendorPayment(
        vendorId: $vendorId
        amountMinor: $amountMinor
        note: $note
      ) {
        id
        balanceMinor
      }
    }
  `);

  const RecordDebtPayment = graphql(`
    mutation DashRecordDebtPayment(
      $customerId: ID!
      $amountMinor: Float!
      $note: String
    ) {
      recordDebtPayment(
        customerId: $customerId
        amountMinor: $amountMinor
        note: $note
      ) {
        id
        balanceMinor
      }
    }
  `);

  const AdjustCustomerBalance = graphql(`
    mutation DashAdjustCustomerBalance(
      $customerId: ID!
      $amountMinor: Float!
      $note: String!
    ) {
      adjustCustomerBalance(
        customerId: $customerId
        amountMinor: $amountMinor
        note: $note
      ) {
        id
        balanceMinor
      }
    }
  `);

  // ---- Viewer permissions --------------------------------------------------
  const viewer = $derived(page.data.user as Viewer | undefined);
  const has = (key: string) => !!viewer && viewer.permissions.includes(key);

  const canSeeAlerts = $derived(has("alert.acknowledge"));
  const canSeeReorder = $derived(has("report.sales.view"));

  // A cash card needs both the list query's gate (for its picker) and at least
  // one action gate. Buttons inside are then gated on their own action.
  const canTrackList = $derived(has("tracking_account.edit"));
  const canTrackIn = $derived(has("tracking_account.deposit"));
  const canTrackOut = $derived(has("tracking_account.payout"));
  const showTracking = $derived(canTrackList && (canTrackIn || canTrackOut));

  const canVendorList = $derived(has("vendor.edit"));
  const canVendorOut = $derived(has("vendor.record_payment"));
  const showVendor = $derived(canVendorList && canVendorOut);

  const canCustomerList = $derived(has("customer.edit"));
  const canCustIn = $derived(has("debt.record_payment"));
  const canCustOut = $derived(has("customer.adjustment"));
  const showCustomer = $derived(canCustomerList && (canCustIn || canCustOut));

  const hasCashCard = $derived(showTracking || showVendor || showCustomer);

  // ---- Count reads ---------------------------------------------------------
  const productAlertCount = $derived(
    $DashboardAlerts.data?.productAlerts.length ?? null,
  );
  const purchaseAlertCount = $derived(
    $DashboardAlerts.data?.purchaseAlerts.length ?? null,
  );
  const reorderCount = $derived(
    $DashboardReorder.data?.reorderSuggestions.length ?? null,
  );

  function loadCounts(networkOnly = false) {
    const opts = networkOnly ? { policy: CachePolicy.NetworkOnly } : undefined;
    if (canSeeAlerts) DashboardAlerts.fetch(opts);
    if (canSeeReorder) DashboardReorder.fetch(opts);
  }

  onMount(() => loadCounts());
  // Counts drift while the tab is hidden (the nightly scan, another buyer's
  // work) — refresh from the network when the operator returns.
  refetchOnVisible(() => loadCounts(true));

  // ---- Cash quick-entry ----------------------------------------------------
  type CashKind = "tracking" | "vendor" | "customer";
  type CashDir = "in" | "out";

  let cashOpen = $state<{ kind: CashKind; dir: CashDir } | null>(null);
  let cashTargetId = $state("");
  let cashAmount = $state<number | null>(null);
  let cashNote = $state("");
  let cashBusy = $state(false);
  let cashFeedback = $state<{ ok: boolean; text: string } | null>(null);

  let trackingLoaded = $state(false);
  let vendorsLoaded = $state(false);
  let customersLoaded = $state(false);

  const trackingOptions = $derived(
    ($DashTrackingAccounts.data?.trackingAccounts ?? []).map((a) => ({
      value: a.id,
      label: `${a.name} · ${formatMoney(a.balanceMinor)}`,
    })),
  );
  const vendorOptions = $derived(
    ($DashVendors.data?.vendors ?? [])
      .filter((v) => !v.archivedAt)
      .map((v) => ({
        value: v.id,
        label: `${v.name} · owe ${formatMoney(v.balanceMinor)}`,
      })),
  );
  const customerOptions = $derived(
    ($DashCustomers.data?.customers ?? [])
      .filter((c) => !c.archivedAt)
      .map((c) => ({
        value: c.id,
        label: `${c.name} · AR ${formatMoney(c.balanceMinor)}`,
      })),
  );

  const activeOptions = $derived(
    cashOpen?.kind === "tracking"
      ? trackingOptions
      : cashOpen?.kind === "vendor"
        ? vendorOptions
        : cashOpen?.kind === "customer"
          ? customerOptions
          : [],
  );
  const activeLoading = $derived(
    cashOpen?.kind === "tracking"
      ? $DashTrackingAccounts.fetching
      : cashOpen?.kind === "vendor"
        ? $DashVendors.fetching
        : cashOpen?.kind === "customer"
          ? $DashCustomers.fetching
          : false,
  );

  function openCash(kind: CashKind, dir: CashDir) {
    // Toggle the same button closed.
    if (cashOpen?.kind === kind && cashOpen?.dir === dir) {
      cashOpen = null;
      return;
    }
    cashOpen = { kind, dir };
    cashTargetId = "";
    cashAmount = null;
    cashNote = "";
    cashFeedback = null;
    if (kind === "tracking" && !trackingLoaded) {
      trackingLoaded = true;
      DashTrackingAccounts.fetch();
    } else if (kind === "vendor" && !vendorsLoaded) {
      vendorsLoaded = true;
      DashVendors.fetch();
    } else if (kind === "customer" && !customersLoaded) {
      customersLoaded = true;
      DashCustomers.fetch();
    }
  }

  async function submitCash() {
    if (!cashOpen || !cashTargetId || !cashAmount || cashAmount <= 0) return;
    const { kind, dir } = cashOpen;
    const amt = Math.abs(cashAmount);
    const note = cashNote.trim();
    cashBusy = true;
    cashFeedback = null;
    try {
      let res: { errors?: readonly { message: string }[] | null } | undefined;
      if (kind === "tracking" && dir === "in") {
        res = await RecordTrackingDeposit.mutate({
          accountId: cashTargetId,
          amountMinor: amt,
          note: note || null,
        });
      } else if (kind === "tracking") {
        res = await RecordTrackingPayout.mutate({
          accountId: cashTargetId,
          amountMinor: amt,
          note: note || null,
        });
      } else if (kind === "vendor") {
        res = await RecordVendorPayment.mutate({
          vendorId: cashTargetId,
          amountMinor: amt,
          note: note || null,
        });
      } else if (kind === "customer" && dir === "in") {
        res = await RecordDebtPayment.mutate({
          customerId: cashTargetId,
          amountMinor: amt,
          note: note || null,
        });
      } else {
        // Customer "out": cash lent to the customer with no goods — raises
        // their AR. adjustCustomerBalance needs a note, so default one in.
        res = await AdjustCustomerBalance.mutate({
          customerId: cashTargetId,
          amountMinor: amt,
          note: note || "Cash loan",
        });
      }
      if (res?.errors?.length) {
        cashFeedback = { ok: false, text: res.errors[0].message };
        return;
      }
      const verb = dir === "in" ? "Cash in" : "Cash out";
      cashFeedback = { ok: true, text: `${verb} recorded — ${formatMoney(amt)}.` };
      cashOpen = null;
      // Refresh the picker so the next entry shows the updated balance.
      if (kind === "tracking")
        await DashTrackingAccounts.fetch({ policy: CachePolicy.NetworkOnly });
      else if (kind === "vendor")
        await DashVendors.fetch({ policy: CachePolicy.NetworkOnly });
      else await DashCustomers.fetch({ policy: CachePolicy.NetworkOnly });
    } catch (e) {
      cashFeedback = { ok: false, text: e instanceof Error ? e.message : String(e) };
    } finally {
      cashBusy = false;
    }
  }

  const panelHint = $derived(
    !cashOpen
      ? ""
      : cashOpen.kind === "tracking"
        ? cashOpen.dir === "in"
          ? "Cash advanced into the account."
          : "Paid out of the drawer."
        : cashOpen.kind === "vendor"
          ? "Pay the vendor from the drawer."
          : cashOpen.dir === "in"
            ? "Customer pays down their AR balance."
            : "Cash lent to the customer — raises their AR balance.",
  );

  const pickerPlaceholder = $derived(
    cashOpen?.kind === "tracking"
      ? "Search account…"
      : cashOpen?.kind === "vendor"
        ? "Search vendor…"
        : "Search customer…",
  );

  const isOpen = (kind: CashKind, dir: CashDir) =>
    cashOpen?.kind === kind && cashOpen?.dir === dir;
</script>

<svelte:head><title>Dashboard · Retale Console</title></svelte:head>

<div class="space-y-5">
  <div>
    <h1 class="text-xl font-semibold">Dashboard</h1>
    <p class="text-sm text-muted-foreground">
      What needs attention, and quick cash entry.
    </p>
  </div>

  <div class="grid gap-5 lg:grid-cols-2">
    <!-- Column: needs attention --------------------------------------------->
    <section class="space-y-3">
      <h2
        class="px-1 text-xs font-medium tracking-wider text-muted-foreground uppercase"
      >
        Needs attention
      </h2>

      {#if !canSeeAlerts && !canSeeReorder}
        <p class="rounded-lg border bg-card p-4 text-sm text-muted-foreground">
          Nothing to show — you don't have access to alerts or reorder
          suggestions.
        </p>
      {/if}

      {#if canSeeAlerts}
        {@render infoCard(
          TriangleAlert,
          "Product margin alerts",
          "Open the alerts inbox →",
          "/alerts",
          productAlertCount,
          $DashboardAlerts.fetching,
        )}
        {@render infoCard(
          ClipboardList,
          "Purchase alerts",
          "Open the alerts inbox →",
          "/alerts",
          purchaseAlertCount,
          $DashboardAlerts.fetching,
        )}
      {/if}

      {#if canSeeReorder}
        {@render infoCard(
          PackageSearch,
          "Reorder suggestions",
          "Review & convert to purchases →",
          "/reorder",
          reorderCount,
          $DashboardReorder.fetching,
        )}
      {/if}
    </section>

    <!-- Column: cash shortcuts ---------------------------------------------->
    <section class="space-y-3">
      <h2
        class="px-1 text-xs font-medium tracking-wider text-muted-foreground uppercase"
      >
        Cash shortcuts
      </h2>

      {#if cashFeedback}
        <p
          class="rounded-md px-1 text-sm {cashFeedback.ok
            ? 'text-emerald-700'
            : 'text-destructive'}"
        >
          {cashFeedback.text}
        </p>
      {/if}

      {#if !hasCashCard}
        <p class="rounded-lg border bg-card p-4 text-sm text-muted-foreground">
          You don't have permission to record cash movements.
        </p>
      {/if}

      {#if showTracking}
        {@render cashCard(Landmark, "Tracking accounts", "tracking", canTrackIn, canTrackOut)}
      {/if}
      {#if showVendor}
        {@render cashCard(Truck, "Vendor payment", "vendor", false, true)}
      {/if}
      {#if showCustomer}
        {@render cashCard(Users, "Customer cash", "customer", canCustIn, canCustOut)}
      {/if}
    </section>
  </div>
</div>

<!-- Informatic count card: icon + label, big count, links to its screen. -->
{#snippet infoCard(
  Icon: Component<{ class?: string }>,
  label: string,
  hint: string,
  href: string,
  count: number | null,
  fetching: boolean,
)}
  <a
    {href}
    class="flex items-center gap-4 rounded-lg border bg-card p-4 transition-colors hover:bg-accent/50"
  >
    <span
      class="flex size-10 shrink-0 items-center justify-center rounded-md
        {count && count > 0
        ? 'bg-amber-100 text-amber-700'
        : 'bg-muted text-muted-foreground'}"
    >
      <Icon class="size-5" />
    </span>
    <div class="flex-1">
      <p class="text-sm font-medium">{label}</p>
      <p class="text-xs text-muted-foreground">{hint}</p>
    </div>
    <span class="text-2xl font-semibold tabular-nums">
      {#if count === null}
        <span class="text-base text-muted-foreground">{fetching ? "…" : "—"}</span>
      {:else}
        {count}
      {/if}
    </span>
  </a>
{/snippet}

<!-- Cash card: header + In/Out buttons; clicking one expands a quick-entry
     panel below for picking the entity, amount, and note. -->
{#snippet cashCard(
  Icon: Component<{ class?: string }>,
  title: string,
  kind: CashKind,
  showIn: boolean,
  showOut: boolean,
)}
  <div class="rounded-lg border bg-card p-4">
    <div class="flex items-center gap-3">
      <span
        class="flex size-9 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground"
      >
        <Icon class="size-5" />
      </span>
      <p class="flex-1 text-sm font-medium">{title}</p>
      <div class="flex gap-2">
        {#if showIn}
          <Button
            size="sm"
            variant={isOpen(kind, "in") ? "default" : "outline"}
            disabled={cashBusy}
            onclick={() => openCash(kind, "in")}
          >
            <ArrowDownToLine class="size-4" /> Cash in
          </Button>
        {/if}
        {#if showOut}
          <Button
            size="sm"
            variant={isOpen(kind, "out") ? "default" : "outline"}
            disabled={cashBusy}
            onclick={() => openCash(kind, "out")}
          >
            <ArrowUpFromLine class="size-4" /> Cash out
          </Button>
        {/if}
      </div>
    </div>

    {#if cashOpen?.kind === kind}
      <div class="mt-3 space-y-2 rounded-md border bg-muted/40 p-3">
        <p class="text-xs text-muted-foreground">{panelHint}</p>
        <div class="space-y-2">
          <Combobox
            options={activeOptions}
            bind:value={cashTargetId}
            placeholder={activeLoading ? "Loading…" : pickerPlaceholder}
            disabled={cashBusy}
          />
          <div class="flex items-end gap-2">
            <label class="space-y-1">
              <span class="text-xs font-medium">Amount (Rp)</span>
              <MoneyInput bind:value={cashAmount} class="w-40" disabled={cashBusy} />
            </label>
            <label class="flex-1 space-y-1">
              <span class="text-xs font-medium">
                Note {cashOpen.kind === "customer" && cashOpen.dir === "out"
                  ? "(defaults to “Cash loan”)"
                  : "(optional)"}
              </span>
              <Input bind:value={cashNote} disabled={cashBusy} />
            </label>
            <Button
              size="sm"
              disabled={cashBusy || !cashTargetId || !cashAmount || cashAmount <= 0}
              onclick={submitCash}
            >
              Record
            </Button>
            <Button
              size="sm"
              variant="ghost"
              disabled={cashBusy}
              onclick={() => (cashOpen = null)}
            >
              Cancel
            </Button>
          </div>
        </div>
      </div>
    {/if}
  </div>
{/snippet}
