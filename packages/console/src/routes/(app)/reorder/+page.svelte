<script lang="ts">
  import { graphql } from "$houdini";
  import { page } from "$app/state";
  import { X } from "@lucide/svelte";
  import type { Viewer } from "../+layout.server";
  import Badge from "$lib/components/ui/badge.svelte";
  import Button from "$lib/components/ui/button.svelte";
  import IconButton from "$lib/components/ui/icon-button.svelte";
  import Input from "$lib/components/ui/input.svelte";
  import Select from "$lib/components/ui/select.svelte";
  import type { PageData } from "./$types";

  // Query document — Houdini scans this for codegen. The live store is
  // supplied by +page.ts through `data` (route-store wiring is unavailable).
  graphql(`
    query ReorderSuggestions {
      reorderSuggestions {
        id
        variantId
        productName
        sku
        vendorId
        vendorName
        currentStock
        reorderPoint
        suggestedQty
        status
        generatedAt
      }
      vendors {
        id
        name
      }
    }
  `);

  const RunScan = graphql(`
    mutation ConsoleRunReorderScan {
      runReorderScan {
        id
      }
    }
  `);

  const ConvertSuggestions = graphql(`
    mutation ConsoleConvertReorderSuggestions($lines: [ConvertReorderLineInput!]!) {
      convertReorderSuggestions(lines: $lines) {
        id
      }
    }
  `);

  const DismissSuggestion = graphql(`
    mutation ConsoleDismissReorderSuggestion($id: ID!) {
      dismissReorderSuggestion(id: $id) {
        id
        status
      }
    }
  `);

  let { data }: { data: PageData } = $props();
  const ReorderSuggestions = $derived(data.ReorderSuggestions);

  const suggestions = $derived($ReorderSuggestions.data?.reorderSuggestions ?? []);
  const vendors = $derived($ReorderSuggestions.data?.vendors ?? []);

  // ---- Viewer permissions --------------------------------------------------
  // Mirrors the API: reading the list needs report.sales.view; scan / convert /
  // dismiss are buyer actions gated on purchase.create.
  const viewer = $derived(page.data.user as Viewer | undefined);
  const has = (key: string) => !!viewer && viewer.permissions.includes(key);
  const canAct = $derived(has("purchase.create"));

  // ---- Status filter -------------------------------------------------------
  const STATUSES = ["open", "converted", "dismissed"];
  let statusFilter = $state("open");
  const rows = $derived(
    suggestions.filter((s) => s.status === statusFilter),
  );

  // ---- Per-row review state ------------------------------------------------
  // Open suggestions get a checkbox plus qty / vendor overrides. The draft map
  // is keyed by suggestion id and re-synced whenever the scan id set changes.
  interface Review {
    selected: boolean;
    qty: number;
    vendorId: string;
  }
  let review = $state<Record<string, Review>>({});

  let syncedKey = $state("");
  $effect(() => {
    const key = suggestions
      .map((s) => s.id)
      .sort()
      .join(",");
    if (key === syncedKey) return;
    syncedKey = key;
    const next: Record<string, Review> = {};
    for (const s of suggestions) {
      next[s.id] = {
        selected: false,
        qty: s.suggestedQty,
        vendorId: s.vendorId ?? "",
      };
    }
    review = next;
  });

  const selectedCount = $derived(
    rows.filter((s) => review[s.id]?.selected).length,
  );
  // Suggestions can only be converted once they have a vendor assigned.
  const unassignedSelected = $derived(
    rows.some((s) => review[s.id]?.selected && !review[s.id]?.vendorId),
  );

  let busy = $state(false);
  let feedback = $state<{ ok: boolean; text: string } | null>(null);

  async function runScan() {
    busy = true;
    feedback = null;
    try {
      const res = await RunScan.mutate(null);
      if (res.errors?.length) {
        feedback = { ok: false, text: res.errors[0].message };
        return;
      }
      await ReorderSuggestions.fetch();
      statusFilter = "open";
      feedback = {
        ok: true,
        text: `Scan complete — ${res.data?.runReorderScan.length ?? 0} suggestion(s).`,
      };
    } catch (e) {
      feedback = { ok: false, text: e instanceof Error ? e.message : String(e) };
    } finally {
      busy = false;
    }
  }

  async function convertSelected() {
    const lines = rows
      .filter((s) => review[s.id]?.selected)
      .map((s) => ({
        suggestionId: s.id,
        qty: Math.round(review[s.id].qty),
        vendorId: review[s.id].vendorId || null,
      }));
    if (lines.length === 0) return;
    busy = true;
    feedback = null;
    try {
      const res = await ConvertSuggestions.mutate({ lines });
      if (res.errors?.length) {
        feedback = { ok: false, text: res.errors[0].message };
        return;
      }
      await ReorderSuggestions.fetch();
      const n = res.data?.convertReorderSuggestions.length ?? 0;
      feedback = {
        ok: true,
        text: `Created ${n} draft purchase(s) — see the Purchases screen.`,
      };
    } catch (e) {
      feedback = { ok: false, text: e instanceof Error ? e.message : String(e) };
    } finally {
      busy = false;
    }
  }

  async function dismiss(id: string) {
    busy = true;
    feedback = null;
    try {
      const res = await DismissSuggestion.mutate({ id });
      if (res.errors?.length) {
        feedback = { ok: false, text: res.errors[0].message };
        return;
      }
      await ReorderSuggestions.fetch();
    } catch (e) {
      feedback = { ok: false, text: e instanceof Error ? e.message : String(e) };
    } finally {
      busy = false;
    }
  }

  const fmtDate = (iso: string) => new Date(iso).toLocaleString("id-ID");
  const statusClass = (s: string) =>
    s === "open"
      ? "bg-sky-100 text-sky-700"
      : s === "converted"
        ? "bg-emerald-100 text-emerald-700"
        : "bg-muted text-muted-foreground";
</script>

<svelte:head><title>Reorder suggestions · Retale Console</title></svelte:head>

<div class="space-y-4">
  <div class="flex items-center justify-between">
    <h1 class="text-xl font-semibold">Reorder suggestions</h1>
    <div class="flex items-center gap-3">
      <div class="w-40">
        <Select bind:value={statusFilter}>
          {#each STATUSES as s (s)}<option value={s}>{s}</option>{/each}
        </Select>
      </div>
      <Button size="sm" disabled={busy || !canAct} onclick={runScan}>
        Run scan
      </Button>
    </div>
  </div>

  <p class="text-sm text-muted-foreground">
    A scan rebuilds the open suggestion set from current stock. Review the
    quantities and vendors, then convert the lines you want into draft
    purchases — one per vendor.
  </p>

  {#if feedback}
    <p class="text-sm {feedback.ok ? 'text-emerald-700' : 'text-destructive'}">
      {feedback.text}
    </p>
  {/if}

  {#if $ReorderSuggestions.fetching && suggestions.length === 0}
    <p class="text-sm text-muted-foreground">Loading…</p>
  {:else if $ReorderSuggestions.errors?.length}
    <p class="text-sm text-destructive">
      {$ReorderSuggestions.errors[0].message}
    </p>
  {:else}
    <div class="overflow-hidden rounded-lg border bg-card">
      <table class="w-full text-sm">
        <thead class="border-b bg-muted/50 text-left text-muted-foreground">
          <tr>
            {#if statusFilter === "open"}<th class="w-8 px-4 py-2"></th>{/if}
            <th class="px-4 py-2 font-medium">Product</th>
            <th class="px-4 py-2 text-right font-medium">Stock</th>
            <th class="px-4 py-2 text-right font-medium">Reorder point</th>
            <th class="px-4 py-2 font-medium">Order qty</th>
            <th class="px-4 py-2 font-medium">Vendor</th>
            {#if statusFilter !== "open"}
              <th class="px-4 py-2 font-medium">Status</th>
            {/if}
            <th class="px-4 py-2"></th>
          </tr>
        </thead>
        <tbody>
          {#each rows as s (s.id)}
            <tr class="border-b last:border-0 hover:bg-muted/40">
              {#if statusFilter === "open"}
                <td class="px-4 py-2">
                  {#if review[s.id]}
                    <input
                      type="checkbox"
                      bind:checked={review[s.id].selected}
                      disabled={!canAct}
                    />
                  {/if}
                </td>
              {/if}
              <td class="px-4 py-2">
                <span class="font-medium">{s.productName}</span>
                <span class="ml-1 font-mono text-xs text-muted-foreground"
                  >{s.sku}</span
                >
              </td>
              <td class="px-4 py-2 text-right">{s.currentStock}</td>
              <td class="px-4 py-2 text-right">{s.reorderPoint}</td>
              <td class="px-4 py-2">
                {#if statusFilter === "open" && review[s.id]}
                  <Input
                    type="number"
                    class="w-24"
                    bind:value={review[s.id].qty}
                    disabled={!canAct}
                  />
                {:else}
                  {s.suggestedQty}
                {/if}
              </td>
              <td class="px-4 py-2">
                {#if statusFilter === "open" && review[s.id]}
                  <Select
                    bind:value={review[s.id].vendorId}
                    disabled={!canAct}
                  >
                    <option value="">— Unassigned —</option>
                    {#each vendors as v (v.id)}
                      <option value={v.id}>{v.name}</option>
                    {/each}
                  </Select>
                {:else}
                  {s.vendorName ?? "—"}
                {/if}
              </td>
              {#if statusFilter !== "open"}
                <td class="px-4 py-2">
                  <Badge class={statusClass(s.status)}>{s.status}</Badge>
                </td>
              {/if}
              <td class="px-4 py-2 text-right">
                {#if statusFilter === "open"}
                  <IconButton
                    icon={X}
                    label="Dismiss"
                    variant="destructive"
                    disabled={busy || !canAct}
                    onclick={() => dismiss(s.id)}
                  />
                {:else}
                  <span class="text-xs text-muted-foreground"
                    >{fmtDate(s.generatedAt)}</span
                  >
                {/if}
              </td>
            </tr>
          {/each}
          {#if rows.length === 0}
            <tr>
              <td
                colspan="7"
                class="px-4 py-10 text-center text-muted-foreground"
              >
                No {statusFilter} suggestions.
                {#if statusFilter === "open"}Run a scan to generate them.{/if}
              </td>
            </tr>
          {/if}
        </tbody>
      </table>
    </div>

    {#if statusFilter === "open" && rows.length > 0}
      <div class="flex items-center justify-between">
        <p class="text-sm text-muted-foreground">
          {selectedCount} selected
          {#if unassignedSelected}
            · <span class="text-destructive"
              >assign a vendor to every selected line</span
            >
          {/if}
        </p>
        <Button
          size="sm"
          disabled={busy || !canAct || selectedCount === 0 || unassignedSelected}
          onclick={convertSelected}
        >
          Convert {selectedCount} to draft purchases
        </Button>
      </div>
    {/if}
  {/if}
</div>
