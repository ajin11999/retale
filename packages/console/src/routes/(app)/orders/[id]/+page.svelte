<script lang="ts">
  import { CachePolicy, graphql } from "$houdini";
  import { page } from "$app/state";
  import type { Viewer } from "../../+layout.server";
  import { formatMoney } from "$lib/utils";
  import Badge from "$lib/components/ui/badge.svelte";
  import Button from "$lib/components/ui/button.svelte";
  import Input from "$lib/components/ui/input.svelte";
  import type { PageData } from "./$types";

  graphql(`
    query OrderDetail($id: ID!) {
      order(id: $id) {
        id
        displayNumber
        status
        customerId
        snapshotCustomerName
        posSessionId
        totalMinor
        closedAt
        cancelledAt
        cancellationReason
        returnOfOrderId
        createdAt
        items {
          id
          productId
          qty
          discountMinor
          displayName
          snapshotProductName
          snapshotPublicName
          snapshotBundleName
          snapshotProductSku
          snapshotVariantLabel
          snapshotUnit
          snapshotCategoryName
          snapshotPriceMinor
          snapshotCostMinor
          lineTotalMinor
          voidedAt
          voidReason
        }
        payments {
          id
          method
          amountMinor
          createdAt
        }
      }
      products(includeArchived: false) {
        id
        name
        kind
        variants {
          id
          sku
          label
          unit
          priceMinor
        }
      }
    }
  `);

  const AddItem = graphql(`
    mutation ConsoleAddCustomerSaleItem(
      $orderId: ID!
      $item: PosOrderItemInput!
    ) {
      addCustomerSaleItem(orderId: $orderId, item: $item) {
        id
      }
    }
  `);

  const UpdateItem = graphql(`
    mutation ConsoleUpdateCustomerSaleItem(
      $orderItemId: ID!
      $qty: Int
      $discountMinor: Float
      $priceOverrideMinor: Float
      $displayNameOverride: String
    ) {
      updateCustomerSaleItem(
        orderItemId: $orderItemId
        qty: $qty
        discountMinor: $discountMinor
        priceOverrideMinor: $priceOverrideMinor
        displayNameOverride: $displayNameOverride
      ) {
        id
      }
    }
  `);

  const VoidItem = graphql(`
    mutation ConsoleVoidCustomerSaleItem($orderItemId: ID!, $reason: String!) {
      voidCustomerSaleItem(orderItemId: $orderItemId, reason: $reason) {
        id
      }
    }
  `);

  const AddPayment = graphql(`
    mutation ConsoleAddCustomerSalePayment(
      $orderId: ID!
      $amountMinor: Float!
    ) {
      addCustomerSalePayment(orderId: $orderId, amountMinor: $amountMinor) {
        id
      }
    }
  `);

  const CloseSale = graphql(`
    mutation ConsoleCloseCustomerSale($orderId: ID!) {
      closeCustomerSale(orderId: $orderId) {
        id
        status
        displayNumber
      }
    }
  `);

  const CancelSale = graphql(`
    mutation ConsoleCancelCustomerSale($orderId: ID!, $reason: String!) {
      cancelCustomerSale(orderId: $orderId, reason: $reason) {
        id
        status
      }
    }
  `);

  let { data }: { data: PageData } = $props();
  const OrderDetail = $derived(data.OrderDetail);
  const order = $derived($OrderDetail.data?.order ?? null);
  const products = $derived($OrderDetail.data?.products ?? []);
  const isOpen = $derived(order?.status === "open");

  // ---- Viewer permissions --------------------------------------------------
  const viewer = $derived(page.data.user as Viewer | undefined);
  const has = (key: string) => !!viewer && viewer.permissions.includes(key);
  const canEdit = $derived(has("order.edit_customer_sale"));
  const canVoid = $derived(has("order.void_item"));
  const canClose = $derived(has("order.close_customer_sale"));
  const canCancel = $derived(has("order.cancel_customer_sale"));

  let busy = $state(false);
  let error = $state<string | null>(null);

  async function run(fn: () => Promise<{ errors?: readonly { message: string }[] | null }>): Promise<boolean> {
    busy = true;
    error = null;
    try {
      const res = await fn();
      if (res.errors?.length) {
        error = res.errors[0].message;
        return false;
      }
      return true;
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
      return false;
    } finally {
      busy = false;
    }
  }

  async function refresh() {
    if (!order) return;
    await OrderDetail.fetch({
      variables: { id: order.id },
      policy: CachePolicy.NetworkOnly,
    });
  }

  // ---- Variant picker ------------------------------------------------------
  interface PickRow {
    variantId: string;
    productId: string;
    productName: string;
    productKind: string;
    sku: string;
    label: string | null;
    priceMinor: number;
    unit: string;
  }

  const pickRows = $derived.by<PickRow[]>(() => {
    const out: PickRow[] = [];
    for (const p of products) {
      for (const v of p.variants) {
        out.push({
          variantId: v.id,
          productId: p.id,
          productName: p.name,
          productKind: p.kind,
          sku: v.sku,
          label: v.label ?? null,
          priceMinor: v.priceMinor,
          unit: v.unit,
        });
      }
    }
    return out.sort((a, b) => {
      const p = a.productName.localeCompare(b.productName);
      return p !== 0 ? p : a.sku.localeCompare(b.sku);
    });
  });

  let variantSearch = $state("");
  let pickerOpen = $state(false);
  let highlight = $state(0);
  let addQty = $state(1);
  let addDiscount = $state(0);
  let addPriceOverride = $state<string>(""); // blank → use variant price
  // Selected draft (after picking from the list, before pressing Add).
  let draft = $state<{ row: PickRow; productKind: string } | null>(null);

  const pickMatches = $derived.by(() => {
    const q = variantSearch.trim().toLowerCase();
    const filtered = q
      ? pickRows.filter(
          (r) =>
            r.productName.toLowerCase().includes(q) ||
            r.sku.toLowerCase().includes(q) ||
            (r.label?.toLowerCase().includes(q) ?? false),
        )
      : pickRows;
    return filtered.slice(0, 30);
  });

  $effect(() => {
    void variantSearch;
    highlight = 0;
  });

  function selectVariant(row: PickRow) {
    draft = { row, productKind: row.productKind };
    addQty = 1;
    addDiscount = 0;
    addPriceOverride = "";
    pickerOpen = false;
    variantSearch = `${row.productName} · ${row.sku}`;
  }

  function clearDraft() {
    draft = null;
    addQty = 1;
    addDiscount = 0;
    addPriceOverride = "";
    variantSearch = "";
  }

  async function commitDraft() {
    if (!order || !draft || addQty < 1) return;
    const isService = draft.productKind === "service";
    const overrideRaw = addPriceOverride.trim();
    let priceOverrideMinor: number | undefined;
    if (overrideRaw) {
      if (!isService) {
        error = "Price overrides are allowed only on service products.";
        return;
      }
      const n = Math.round(Number(overrideRaw));
      if (!Number.isFinite(n) || n < 0) {
        error = "Price override must be a non-negative integer (minor units).";
        return;
      }
      priceOverrideMinor = n;
    }
    const discount =
      addDiscount && Number.isFinite(addDiscount)
        ? Math.round(addDiscount)
        : 0;
    const ok = await run(() =>
      AddItem.mutate({
        orderId: order.id,
        item: {
          variantId: draft.row.variantId,
          qty: addQty,
          discountMinor: discount || undefined,
          priceOverrideMinor,
        },
      }),
    );
    if (ok) {
      clearDraft();
      await refresh();
    }
  }

  function onPickerKey(e: KeyboardEvent) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      pickerOpen = true;
      if (pickMatches.length) highlight = (highlight + 1) % pickMatches.length;
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      if (pickMatches.length)
        highlight = (highlight - 1 + pickMatches.length) % pickMatches.length;
    } else if (e.key === "Enter") {
      if (pickMatches.length === 0) return;
      e.preventDefault();
      const target =
        pickMatches.length === 1
          ? pickMatches[0]
          : pickMatches[highlight] ?? pickMatches[0];
      selectVariant(target);
    } else if (e.key === "Escape") {
      pickerOpen = false;
    }
  }

  async function voidLine(itemId: string) {
    const reason = prompt("Void reason?")?.trim();
    if (!reason) return;
    const ok = await run(() =>
      VoidItem.mutate({ orderItemId: itemId, reason }),
    );
    if (ok) await refresh();
  }

  // ---- Per-line edit -------------------------------------------------------
  // The line keeps its own product kind on `productId`; we cross-reference the
  // products query (already loaded for the variant picker) to know whether a
  // price override is allowed (services only).
  interface LineDraft {
    itemId: string;
    qty: number;
    discountMinor: number;
    priceMinor: number;
    costMinor: number;
    displayName: string;
    productKind: string;
    isBundleLine: boolean;
  }
  let lineDraft = $state<LineDraft | null>(null);

  // Margin % off the net line price (price − per-unit discount) vs. snapshot cost.
  function marginPct(priceMinor: number, costMinor: number, discountMinor: number, qty: number): number | null {
    if (priceMinor <= 0 || qty <= 0) return null;
    const perUnitDiscount = qty > 0 ? discountMinor / qty : 0;
    const net = priceMinor - perUnitDiscount;
    if (net <= 0) return null;
    return ((net - costMinor) / net) * 100;
  }

  function productKindOf(productId: string | null | undefined): string {
    if (!productId) return "physical";
    return products.find((p) => p.id === productId)?.kind ?? "physical";
  }

  function startLineEdit(item: NonNullable<typeof order>["items"][number]) {
    lineDraft = {
      itemId: item.id,
      qty: item.qty,
      discountMinor: item.discountMinor,
      priceMinor: item.snapshotPriceMinor,
      costMinor: item.snapshotCostMinor,
      displayName: item.snapshotPublicName ?? item.snapshotProductName,
      productKind: productKindOf(item.productId),
      isBundleLine: item.snapshotBundleName != null,
    };
  }

  async function saveLineEdit() {
    const d = lineDraft;
    if (!d) return;
    if (d.qty < 1) {
      error = "Qty must be at least 1.";
      return;
    }
    const isService = d.productKind === "service";
    const ok = await run(() =>
      UpdateItem.mutate({
        orderItemId: d.itemId,
        qty: d.qty,
        discountMinor: d.discountMinor,
        // Only send price override for service products; ignored otherwise.
        priceOverrideMinor: isService ? d.priceMinor : undefined,
        // Empty string clears back to default; otherwise overrides.
        displayNameOverride: d.displayName.trim(),
      }),
    );
    if (ok) {
      lineDraft = null;
      await refresh();
    }
  }

  // ---- Payment entry -------------------------------------------------------
  let payAmount = $state<string>("");

  async function recordPayment() {
    if (!order) return;
    const amt = Math.round(Number(payAmount));
    if (!Number.isFinite(amt) || amt <= 0) {
      error = "Payment amount must be a positive integer (minor units).";
      return;
    }
    const ok = await run(() =>
      AddPayment.mutate({ orderId: order.id, amountMinor: amt }),
    );
    if (ok) {
      payAmount = "";
      await refresh();
    }
  }

  async function closeSale() {
    if (!order) return;
    const ok = await run(() => CloseSale.mutate({ orderId: order.id }));
    if (ok) await refresh();
  }

  async function cancelSale() {
    if (!order) return;
    const reason = prompt("Reason for cancelling this sale?")?.trim();
    if (!reason) return;
    const ok = await run(() =>
      CancelSale.mutate({ orderId: order.id, reason }),
    );
    if (ok) await refresh();
  }

  const fmt = (iso: string | null | undefined) =>
    iso ? new Date(iso).toLocaleString("id-ID") : "—";

  function statusBadge(s: string) {
    if (s === "closed") return "bg-emerald-100 text-emerald-700";
    if (s === "cancelled") return "bg-destructive/10 text-destructive";
    return "bg-amber-100 text-amber-800";
  }

  // Sum of live (non-voided) lines — sanity check against the cached total.
  const computed = $derived(
    (order?.items ?? [])
      .filter((i) => !i.voidedAt)
      .reduce((acc, i) => acc + i.lineTotalMinor, 0),
  );
  const paid = $derived(
    (order?.payments ?? []).reduce((acc, p) => acc + p.amountMinor, 0),
  );
</script>

<svelte:head>
  <title>Order · Retale Console</title>
</svelte:head>

<div class="space-y-4">
  <a href="/orders" class="text-sm text-primary hover:underline">← All orders</a>

  {#if $OrderDetail.fetching && !order}
    <p class="text-sm text-muted-foreground">Loading…</p>
  {:else if $OrderDetail.errors?.length}
    <p class="text-sm text-destructive">{$OrderDetail.errors[0].message}</p>
  {:else if !order}
    <p class="text-sm text-muted-foreground">Order not found.</p>
  {:else}
    <div class="flex items-start justify-between">
      <div>
        <h1 class="text-xl font-semibold">
          {order.displayNumber ?? `Order ${order.id.slice(-8)}`}
        </h1>
        <p class="text-sm text-muted-foreground">
          {order.snapshotCustomerName ?? "Walk-in"} · created {fmt(order.createdAt)}
          {#if order.closedAt}· closed {fmt(order.closedAt)}{/if}
          {#if order.cancelledAt}· cancelled {fmt(order.cancelledAt)}{/if}
        </p>
        {#if order.posSessionId}
          <p class="text-xs text-muted-foreground">
            Session
            <a
              href={`/sessions/${order.posSessionId}`}
              class="font-mono text-primary hover:underline"
            >
              {order.posSessionId.slice(-8)}
            </a>
          </p>
        {/if}
        {#if order.returnOfOrderId}
          <p class="text-xs text-muted-foreground">
            Return of
            <a
              href={`/orders/${order.returnOfOrderId}`}
              class="font-mono text-primary hover:underline"
            >
              {order.returnOfOrderId.slice(-8)}
            </a>
          </p>
        {/if}
      </div>
      <Badge class={statusBadge(order.status)}>{order.status}</Badge>
    </div>

    {#if order.cancellationReason}
      <div class="rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm">
        <span class="font-medium">Cancelled:</span>
        {order.cancellationReason}
      </div>
    {/if}

    {#if error}
      <p class="text-sm text-destructive">{error}</p>
    {/if}

    {#if isOpen}
      <!-- Add line -->
      <div class="space-y-3 rounded-lg border bg-card p-4">
        <h2 class="text-sm font-semibold">Add line</h2>
        <div class="space-y-1">
          <span class="text-xs font-medium">Search product or SKU</span>
          <div class="relative">
            <Input
              type="search"
              placeholder="Type to search…"
              bind:value={variantSearch}
              onfocus={() => (pickerOpen = true)}
              onblur={() => setTimeout(() => (pickerOpen = false), 150)}
              onkeydown={onPickerKey}
              autocomplete="off"
              disabled={busy || !canEdit}
            />
            {#if pickerOpen && pickMatches.length > 0}
              <ul
                class="absolute z-10 mt-1 max-h-72 w-full overflow-auto rounded-md border bg-popover shadow-md"
              >
                {#each pickMatches as v, i (v.variantId)}
                  <li>
                    <button
                      type="button"
                      class="flex w-full items-center justify-between px-3 py-2 text-left text-sm hover:bg-muted/60 {i ===
                      highlight
                        ? 'bg-muted/60'
                        : ''}"
                      onmousedown={(e) => e.preventDefault()}
                      onmouseenter={() => (highlight = i)}
                      onclick={() => selectVariant(v)}
                    >
                      <span>
                        <span class="font-medium">{v.productName}</span>
                        <span class="ml-2 font-mono text-xs text-muted-foreground">
                          {v.sku}{v.label ? ` · ${v.label}` : ""}
                        </span>
                        {#if v.productKind !== "physical"}
                          <span class="ml-2 text-xs text-muted-foreground">
                            ({v.productKind})
                          </span>
                        {/if}
                      </span>
                      <span class="text-xs text-muted-foreground">
                        {formatMoney(v.priceMinor)}
                      </span>
                    </button>
                  </li>
                {/each}
              </ul>
            {:else if pickerOpen && variantSearch.trim()}
              <div
                class="absolute z-10 mt-1 w-full rounded-md border bg-popover px-3 py-2 text-sm text-muted-foreground shadow-md"
              >
                No matches.
              </div>
            {/if}
          </div>
        </div>

        {#if draft}
          <div class="space-y-3 rounded-md border bg-background p-3">
            <div class="flex items-start justify-between gap-2">
              <div>
                <div class="text-sm font-medium">{draft.row.productName}</div>
                <div class="text-xs text-muted-foreground">
                  {draft.row.sku}{draft.row.label ? ` · ${draft.row.label}` : ""}
                  · {draft.row.unit} · base {formatMoney(draft.row.priceMinor)}
                  {#if draft.productKind !== "physical"}
                    · {draft.productKind}
                  {/if}
                </div>
              </div>
              <button
                type="button"
                class="text-xs text-muted-foreground hover:text-foreground"
                disabled={busy}
                onclick={clearDraft}
              >
                Clear
              </button>
            </div>
            <div class="grid grid-cols-3 gap-3">
              <label class="space-y-1">
                <span class="text-xs font-medium">Qty</span>
                <Input
                  type="number"
                  min={1}
                  bind:value={addQty}
                  disabled={busy || !canEdit}
                />
              </label>
              <label class="space-y-1">
                <span class="text-xs font-medium">Discount (minor units)</span>
                <Input
                  type="number"
                  min={0}
                  bind:value={addDiscount}
                  disabled={busy || !canEdit}
                />
              </label>
              <label class="space-y-1">
                <span class="text-xs font-medium">
                  Price override (minor units)
                </span>
                <Input
                  type="number"
                  min={0}
                  placeholder={draft.productKind === "service"
                    ? "Leave blank to use base price"
                    : "Service products only"}
                  bind:value={addPriceOverride}
                  disabled={busy || !canEdit || draft.productKind !== "service"}
                />
                {#if draft.productKind !== "service"}
                  <span class="text-xs text-muted-foreground">
                    API only allows price overrides on service products.
                  </span>
                {/if}
              </label>
            </div>
            <div class="flex justify-end gap-2">
              <Button
                variant="ghost"
                size="sm"
                disabled={busy}
                onclick={clearDraft}
              >
                Cancel
              </Button>
              <Button
                size="sm"
                disabled={busy || !canEdit || addQty < 1}
                onclick={commitDraft}
              >
                Add line
              </Button>
            </div>
          </div>
        {:else}
          <p class="text-xs text-muted-foreground">
            Pick a variant (Enter picks the highlighted row). Stock is
            decremented on add; voiding returns it.
          </p>
        {/if}
      </div>
    {/if}

    <!-- Items -->
    <div class="overflow-hidden rounded-lg border bg-card">
      <table class="w-full text-sm">
        <thead class="border-b bg-muted/50 text-left text-muted-foreground">
          <tr>
            <th class="px-4 py-2 font-medium">Item</th>
            <th class="px-4 py-2 text-right font-medium">Qty</th>
            <th class="px-4 py-2 text-right font-medium">Price</th>
            <th class="px-4 py-2 text-right font-medium">Discount</th>
            <th class="px-4 py-2 text-right font-medium">Line total</th>
            {#if isOpen}<th></th>{/if}
          </tr>
        </thead>
        <tbody>
          {#each order.items as i (i.id)}
            <tr
              class="border-b last:border-0 align-top
                {i.voidedAt ? 'text-muted-foreground line-through' : ''}"
            >
              <td class="px-4 py-2">
                <div class="font-medium">{i.displayName}</div>
                <div class="text-xs text-muted-foreground">
                  {i.snapshotProductSku}{i.snapshotVariantLabel
                    ? ` · ${i.snapshotVariantLabel}`
                    : ""} · {i.snapshotUnit}
                  {#if i.snapshotCategoryName}
                    · {i.snapshotCategoryName}
                  {/if}
                </div>
                {#if i.voidReason}
                  <div class="text-xs text-destructive">Void: {i.voidReason}</div>
                {/if}
              </td>
              <td class="px-4 py-2 text-right">{i.qty}</td>
              <td class="px-4 py-2 text-right">
                {formatMoney(i.snapshotPriceMinor)}
              </td>
              <td class="px-4 py-2 text-right">
                {i.discountMinor ? formatMoney(i.discountMinor) : "—"}
              </td>
              <td class="px-4 py-2 text-right font-medium">
                {formatMoney(i.lineTotalMinor)}
              </td>
              {#if isOpen}
                <td class="px-4 py-2 text-right whitespace-nowrap">
                  {#if !i.voidedAt}
                    {#if !i.snapshotBundleName}
                      <button
                        type="button"
                        class="text-xs text-primary hover:underline disabled:cursor-not-allowed disabled:opacity-40"
                        disabled={busy || !canEdit}
                        onclick={() => startLineEdit(i)}
                      >
                        Edit
                      </button>
                    {/if}
                    <button
                      type="button"
                      class="ml-2 text-xs text-destructive hover:underline disabled:cursor-not-allowed disabled:opacity-40"
                      disabled={busy || !canVoid}
                      onclick={() => voidLine(i.id)}
                    >
                      Void
                    </button>
                  {/if}
                </td>
              {/if}
            </tr>
          {/each}
          {#if order.items.length === 0}
            <tr>
              <td
                colspan={isOpen ? 6 : 5}
                class="px-4 py-8 text-center text-muted-foreground"
              >
                No line items.
              </td>
            </tr>
          {/if}
        </tbody>
        <tfoot class="bg-muted/30">
          <tr>
            <td
              colspan={isOpen ? 5 : 4}
              class="px-4 py-2 text-right font-medium"
            >
              Live lines total
            </td>
            <td class="px-4 py-2 text-right font-medium">
              {formatMoney(computed)}
            </td>
          </tr>
          <tr>
            <td
              colspan={isOpen ? 5 : 4}
              class="px-4 py-2 text-right font-medium"
            >
              Cached order total
            </td>
            <td
              class="px-4 py-2 text-right font-medium
                {computed !== order.totalMinor ? 'text-destructive' : ''}"
            >
              {formatMoney(order.totalMinor)}
            </td>
          </tr>
        </tfoot>
      </table>
    </div>

    {#if lineDraft}
      <div class="space-y-3 rounded-lg border bg-card p-4">
        <div class="flex items-center justify-between">
          <h2 class="text-sm font-semibold">Edit line</h2>
          <button
            type="button"
            class="text-xs text-muted-foreground hover:text-foreground"
            disabled={busy}
            onclick={() => (lineDraft = null)}
          >
            Close
          </button>
        </div>
        <div class="grid grid-cols-2 gap-3">
          <label class="space-y-1">
            <span class="text-xs font-medium">Display name (receipt)</span>
            <Input
              bind:value={lineDraft.displayName}
              disabled={busy || !canEdit}
            />
            <span class="text-xs text-muted-foreground">
              Clear to fall back to the product's default.
            </span>
          </label>
          <label class="space-y-1">
            <span class="text-xs font-medium">Qty</span>
            <Input
              type="number"
              min={1}
              bind:value={lineDraft.qty}
              disabled={busy || !canEdit}
            />
          </label>
          <label class="space-y-1">
            <span class="text-xs font-medium">Discount (minor units)</span>
            <Input
              type="number"
              min={0}
              bind:value={lineDraft.discountMinor}
              disabled={busy || !canEdit}
            />
          </label>
          <label class="space-y-1">
            <span class="text-xs font-medium">Price (minor units)</span>
            <Input
              type="number"
              min={0}
              bind:value={lineDraft.priceMinor}
              disabled={busy || !canEdit || lineDraft.productKind !== "service"}
            />
            {#if lineDraft.productKind !== "service"}
              <span class="text-xs text-muted-foreground">
                Price is editable on service products only.
              </span>
            {/if}
          </label>
        </div>
        {#if lineDraft}
          {@const m = marginPct(
            lineDraft.priceMinor,
            lineDraft.costMinor,
            lineDraft.discountMinor,
            lineDraft.qty,
          )}
          <div class="flex items-center justify-between text-xs text-muted-foreground">
            <span>Cost {formatMoney(lineDraft.costMinor)} (snapshot)</span>
            <span>
              Margin
              {#if m == null}
                <span class="font-medium">—</span>
              {:else}
                <span
                  class="font-medium {m < 0
                    ? 'text-destructive'
                    : m < 10
                      ? 'text-amber-700'
                      : 'text-emerald-700'}"
                >
                  {m.toFixed(1)}%
                </span>
              {/if}
            </span>
          </div>
        {/if}
        <div class="flex justify-end gap-2">
          <Button
            variant="ghost"
            size="sm"
            disabled={busy}
            onclick={() => (lineDraft = null)}
          >
            Cancel
          </Button>
          <Button
            size="sm"
            disabled={busy || !canEdit}
            onclick={saveLineEdit}
          >
            Save line
          </Button>
        </div>
      </div>
    {/if}

    <!-- Payments -->
    <div>
      <h2 class="mb-2 text-sm font-semibold">Payments</h2>
      <div class="overflow-hidden rounded-lg border bg-card">
        <table class="w-full text-sm">
          <thead class="border-b bg-muted/50 text-left text-muted-foreground">
            <tr>
              <th class="px-4 py-2 font-medium">Method</th>
              <th class="px-4 py-2 font-medium">When</th>
              <th class="px-4 py-2 text-right font-medium">Amount</th>
            </tr>
          </thead>
          <tbody>
            {#each order.payments as p (p.id)}
              <tr class="border-b last:border-0">
                <td class="px-4 py-2 capitalize">{p.method}</td>
                <td class="px-4 py-2">{fmt(p.createdAt)}</td>
                <td class="px-4 py-2 text-right">{formatMoney(p.amountMinor)}</td>
              </tr>
            {/each}
            {#if order.payments.length === 0}
              <tr>
                <td colspan="3" class="px-4 py-6 text-center text-muted-foreground">
                  No payments recorded.
                </td>
              </tr>
            {/if}
          </tbody>
          <tfoot class="bg-muted/30">
            <tr>
              <td colspan="2" class="px-4 py-2 text-right font-medium">
                Paid total
              </td>
              <td class="px-4 py-2 text-right font-medium">
                {formatMoney(paid)}
              </td>
            </tr>
            <tr>
              <td colspan="2" class="px-4 py-2 text-right font-medium">
                Outstanding
              </td>
              <td
                class="px-4 py-2 text-right font-medium {computed - paid > 0
                  ? 'text-amber-700'
                  : 'text-emerald-700'}"
              >
                {formatMoney(computed - paid)}
              </td>
            </tr>
          </tfoot>
        </table>
      </div>
    </div>

    {#if isOpen}
      <!-- Payment / close / cancel -->
      <div class="space-y-3 rounded-lg border bg-card p-4">
        <h2 class="text-sm font-semibold">Record payment</h2>
        <div class="flex items-end gap-2">
          <label class="flex-1 space-y-1">
            <span class="text-xs font-medium">Amount (minor units)</span>
            <Input
              type="number"
              min={1}
              bind:value={payAmount}
              placeholder={String(Math.max(computed - paid, 0))}
              disabled={busy || !canEdit}
            />
          </label>
          <Button
            size="sm"
            disabled={busy || !canEdit || !payAmount}
            onclick={recordPayment}
          >
            Add payment
          </Button>
        </div>
        <p class="text-xs text-muted-foreground">
          Console payments are recorded as cash. Outstanding above suggests the
          remaining amount.
        </p>

        <div class="flex flex-wrap gap-2 border-t pt-3">
          <Button
            size="sm"
            disabled={busy || !canClose}
            onclick={closeSale}
          >
            Close sale
          </Button>
          <Button
            size="sm"
            variant="destructive"
            disabled={busy || !canCancel}
            onclick={cancelSale}
          >
            Cancel sale
          </Button>
        </div>
        <p class="text-xs text-muted-foreground">
          Closing assigns a display number; the sale becomes immutable.
          Cancelling voids every line and is permanent.
        </p>
      </div>
    {/if}
  {/if}
</div>
