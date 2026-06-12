<script lang="ts">
  import { graphql } from "$houdini";
  import { goto } from "$app/navigation";
  import { page } from "$app/state";
  import type { Viewer } from "../+layout.server";
  import { formatMoney, matchesTokens, searchTokens, statusLabel } from "$lib/utils";
  import Badge from "$lib/components/ui/badge.svelte";
  import Button from "$lib/components/ui/button.svelte";
  import Input from "$lib/components/ui/input.svelte";
  import type { PageData } from "./$types";

  graphql(`
    query OrderList {
      orders(limit: 200) {
        id
        displayNumber
        status
        customerId
        snapshotCustomerName
        posSessionId
        totalMinor
        closedAt
        cancelledAt
        createdAt
      }
      customers(includeArchived: false) {
        id
        name
        phone
      }
    }
  `);

  const CreateCustomerSale = graphql(`
    mutation ConsoleOrdersCreateCustomerSale($customerId: ID!) {
      createCustomerSale(customerId: $customerId) {
        id
      }
    }
  `);

  let { data }: { data: PageData } = $props();
  const OrderList = $derived(data.OrderList);
  const orders = $derived($OrderList.data?.orders ?? []);

  const viewer = $derived(page.data.user as Viewer | undefined);
  const has = (key: string) => !!viewer && viewer.permissions.includes(key);
  const canView = $derived(has("report.sales.view"));
  const canCreateSale = $derived(has("order.create_customer_sale"));
  const customers = $derived($OrderList.data?.customers ?? []);

  // ---- New sale picker -----------------------------------------------------
  // A tiny searchable combobox over the customer list. Pick → create the sale
  // → land on the editable order page.
  let pickerOpen = $state(false);
  let custSearch = $state("");
  let custHighlight = $state(0);
  let busy = $state(false);
  let saleError = $state<string | null>(null);

  const custMatches = $derived.by(() => {
    const tokens = searchTokens(custSearch.trim());
    const filtered = tokens.length
      ? customers.filter((c) => matchesTokens(tokens, c.name, c.phone))
      : customers;
    return [...filtered]
      .sort((a, b) => a.name.localeCompare(b.name))
      .slice(0, 30);
  });

  $effect(() => {
    void custSearch;
    custHighlight = 0;
  });

  async function startSale(customerId: string) {
    busy = true;
    saleError = null;
    try {
      const res = await CreateCustomerSale.mutate({ customerId });
      if (res.errors?.length) {
        saleError = res.errors[0].message;
        return;
      }
      const id = res.data?.createCustomerSale.id;
      if (id) await goto(`/orders/${id}`);
    } catch (e) {
      saleError = e instanceof Error ? e.message : String(e);
    } finally {
      busy = false;
    }
  }

  function onPickerKey(e: KeyboardEvent) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      pickerOpen = true;
      if (custMatches.length) custHighlight = (custHighlight + 1) % custMatches.length;
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      if (custMatches.length)
        custHighlight = (custHighlight - 1 + custMatches.length) % custMatches.length;
    } else if (e.key === "Enter") {
      if (custMatches.length === 0) return;
      e.preventDefault();
      const target =
        custMatches.length === 1
          ? custMatches[0]
          : custMatches[custHighlight] ?? custMatches[0];
      startSale(target.id);
    } else if (e.key === "Escape") {
      pickerOpen = false;
    }
  }

  let search = $state("");
  let statusFilter = $state<"all" | "open" | "closed" | "cancelled">("all");

  const rows = $derived.by(() => {
    const tokens = searchTokens(search.trim());
    let list = orders;
    if (statusFilter !== "all") list = list.filter((o) => o.status === statusFilter);
    if (tokens.length) {
      list = list.filter((o) =>
        matchesTokens(tokens, o.displayNumber, o.snapshotCustomerName),
      );
    }
    // Most recent first by closed > cancelled > created.
    return [...list].sort((a, b) => {
      const at = new Date(a.closedAt ?? a.cancelledAt ?? a.createdAt).getTime();
      const bt = new Date(b.closedAt ?? b.cancelledAt ?? b.createdAt).getTime();
      return bt - at;
    });
  });

  const fmt = (iso: string | null | undefined) =>
    iso ? new Date(iso).toLocaleString("id-ID") : "—";

  function statusBadge(s: string) {
    if (s === "closed") return "bg-emerald-100 text-emerald-700";
    if (s === "cancelled") return "bg-destructive/10 text-destructive";
    return "bg-amber-100 text-amber-800";
  }
</script>

<svelte:head><title>Orders · Retale Console</title></svelte:head>

<div class="space-y-4">
  <div class="flex items-center justify-between gap-3">
    <h1 class="text-xl font-semibold">Orders</h1>
    <div class="flex items-center gap-3">
      <select
        bind:value={statusFilter}
        class="h-9 rounded-md border border-input bg-transparent px-3 text-sm"
      >
        <option value="all">All statuses</option>
        <option value="closed">Closed</option>
        <option value="open">Open</option>
        <option value="cancelled">Cancelled</option>
      </select>
      <div class="w-64">
        <Input type="search" placeholder="Number or customer…" bind:value={search} />
      </div>
      <Button
        size="sm"
        disabled={busy || !canCreateSale}
        onclick={() => {
          pickerOpen = true;
          custSearch = "";
        }}
      >
        New sale
      </Button>
    </div>
  </div>

  {#if saleError}
    <p class="text-sm text-destructive">{saleError}</p>
  {/if}

  {#if pickerOpen}
    <div class="space-y-2 rounded-lg border bg-card p-4">
      <div class="flex items-end gap-2">
        <label class="flex-1 space-y-1">
          <span class="text-xs font-medium">Customer for the new sale</span>
          <div class="relative">
            <Input
              type="search"
              placeholder="Search by name or phone…"
              bind:value={custSearch}
              onkeydown={onPickerKey}
              autocomplete="off"
              disabled={busy}
            />
            {#if custMatches.length > 0}
              <ul
                class="absolute z-10 mt-1 max-h-72 w-full overflow-auto rounded-md border bg-popover shadow-md"
              >
                {#each custMatches as c, i (c.id)}
                  <li>
                    <button
                      type="button"
                      class="w-full px-3 py-2 text-left text-sm hover:bg-muted/60 {i ===
                      custHighlight
                        ? 'bg-muted/60'
                        : ''}"
                      onmousedown={(e) => e.preventDefault()}
                      onmouseenter={() => (custHighlight = i)}
                      onclick={() => startSale(c.id)}
                    >
                      <span class="font-medium">{c.name}</span>
                      {#if c.phone}
                        <span class="ml-2 text-xs text-muted-foreground">
                          {c.phone}
                        </span>
                      {/if}
                    </button>
                  </li>
                {/each}
              </ul>
            {:else if custSearch.trim()}
              <div
                class="absolute z-10 mt-1 w-full rounded-md border bg-popover px-3 py-2 text-sm text-muted-foreground shadow-md"
              >
                No customers match.
              </div>
            {/if}
          </div>
        </label>
        <Button
          variant="ghost"
          size="sm"
          disabled={busy}
          onclick={() => (pickerOpen = false)}
        >
          Cancel
        </Button>
      </div>
      <p class="text-xs text-muted-foreground">
        Press Enter to pick the highlighted customer; the sale opens on its order page.
      </p>
    </div>
  {/if}

  {#if !canView}
    <p class="text-sm text-muted-foreground">
      You don't have permission to view orders.
    </p>
  {:else if $OrderList.fetching && orders.length === 0}
    <p class="text-sm text-muted-foreground">Loading…</p>
  {:else if $OrderList.errors?.length}
    <p class="text-sm text-destructive">{$OrderList.errors[0].message}</p>
  {:else}
    <div class="overflow-hidden rounded-lg border bg-card">
      <table class="w-full text-sm">
        <thead class="border-b bg-muted/50 text-left text-muted-foreground">
          <tr>
            <th class="px-4 py-2 font-medium">Number</th>
            <th class="px-4 py-2 font-medium">Customer</th>
            <th class="px-4 py-2 font-medium">When</th>
            <th class="px-4 py-2 text-right font-medium">Total</th>
            <th class="px-4 py-2 font-medium">Status</th>
          </tr>
        </thead>
        <tbody>
          {#each rows as o (o.id)}
            <tr class="border-b last:border-0 hover:bg-muted/40">
              <td class="px-4 py-2">
                <a
                  href={`/orders/${o.id}`}
                  class="font-mono text-xs text-primary hover:underline"
                >
                  {o.displayNumber ?? o.id.slice(-8)}
                </a>
              </td>
              <td class="px-4 py-2">{o.snapshotCustomerName ?? "—"}</td>
              <td class="px-4 py-2">
                {fmt(o.closedAt ?? o.cancelledAt ?? o.createdAt)}
              </td>
              <td class="px-4 py-2 text-right">{formatMoney(o.totalMinor)}</td>
              <td class="px-4 py-2">
                <Badge class={statusBadge(o.status)}>{statusLabel(o.status)}</Badge>
              </td>
            </tr>
          {/each}
          {#if rows.length === 0}
            <tr>
              <td colspan="5" class="px-4 py-10 text-center text-muted-foreground">
                No orders match.
              </td>
            </tr>
          {/if}
        </tbody>
      </table>
    </div>
    <p class="text-sm text-muted-foreground">
      {rows.length} order{rows.length === 1 ? "" : "s"}
    </p>
  {/if}
</div>
