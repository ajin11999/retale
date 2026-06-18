<script lang="ts">
  import { CachePolicy, graphql } from "$houdini";
  import { page } from "$app/state";
  import { Trash2 } from "@lucide/svelte";
  import type { Viewer } from "../+layout.server";
  import { refetchOnVisible } from "$lib/refetch-on-visible.svelte";
  import Button from "$lib/components/ui/button.svelte";
  import IconButton from "$lib/components/ui/icon-button.svelte";
  import Input from "$lib/components/ui/input.svelte";
  import Select from "$lib/components/ui/select.svelte";
  import { matchesTokens, searchTokens } from "$lib/utils";
  import type { PageData } from "./$types";

  // Per-location count sheet — refetched whenever the location changes.
  graphql(`
    query LocationStockLevels($locationId: ID) {
      locationStockLevels(locationId: $locationId) {
        variantId
        productName
        sku
        label
        unit
        onHand
      }
    }
  `);

  // Reference data: the location selector and the catalog behind add-search.
  // Loaded once — it does not depend on the chosen location.
  graphql(`
    query StockEditorRefData {
      locations {
        id
        name
      }
      products(includeArchived: false) {
        id
        name
        variants {
          id
          sku
          label
          barcode
        }
      }
    }
  `);

  const BulkAdjustStock = graphql(`
    mutation ConsoleBulkAdjustStock(
      $locationId: ID
      $reason: String!
      $lines: [BulkStockCountInput!]!
    ) {
      bulkAdjustStock(locationId: $locationId, reason: $reason, lines: $lines)
    }
  `);

  let { data }: { data: PageData } = $props();
  const Levels = $derived(data.LocationStockLevels);
  const RefData = $derived(data.StockEditorRefData);

  // A location or product created in another tab won't appear in the
  // selector / add-search — Houdini serves the cached ref data. Re-pull it
  // when the tab becomes visible again; count rows are plain component state.
  refetchOnVisible(() => RefData.fetch({ policy: CachePolicy.NetworkOnly }));

  const levels = $derived($Levels.data?.locationStockLevels ?? []);
  const locations = $derived($RefData.data?.locations ?? []);
  const products = $derived($RefData.data?.products ?? []);

  // ---- Viewer permission ---------------------------------------------------
  const viewer = $derived(page.data.user as Viewer | undefined);
  const has = (key: string) => !!viewer && viewer.permissions.includes(key);
  const canAdjust = $derived(has("stock.adjust"));

  // ---- Location selector ---------------------------------------------------
  // "" is the sentinel for the unlocated root bucket (locationId null), so it
  // is distinct from every real location id.
  const ROOT = "";
  // Seed from `?location=<id>` (set when arriving from the Locations list); the
  // server load already fetched levels for this bucket. Null param → root.
  let locValue = $state(data.initialLocationId ?? ROOT);

  async function changeLocation() {
    // NetworkOnly: switching buckets must reflect live on-hand, not a cached
    // list. The sync effect below reseeds the count inputs from the new rows.
    await Levels.fetch({
      variables: { locationId: locValue || null },
      policy: CachePolicy.NetworkOnly,
    });
  }

  // ---- Rows: server levels + variants pulled in via search -----------------
  interface AddedRow {
    variantId: string;
    productName: string;
    sku: string;
    label: string | null;
    unit: string;
  }
  let added = $state<AddedRow[]>([]);
  // Count inputs, keyed by variantId. Seeded as strings; a bound number input
  // coerces edits to `number`, so reads must tolerate either.
  let counted = $state<Record<string, string | number>>({});

  // Reseed whenever the server rows change — a location switch or a post-save
  // refetch. This also discards any pending added rows / unsaved edits, which
  // is the right behaviour when the underlying bucket changes.
  // "" never matches a real key — keys always contain the "|" separator.
  let syncedKey = $state("");
  $effect(() => {
    const key =
      `${locValue}|` +
      levels
        .map((l) => `${l.variantId}:${l.onHand}`)
        .join(",");
    if (key === syncedKey) return;
    syncedKey = key;
    const next: Record<string, string> = {};
    for (const l of levels) next[l.variantId] = String(l.onHand);
    counted = next;
    added = [];
  });

  const onHandFor = (variantId: string): number =>
    levels.find((l) => l.variantId === variantId)?.onHand ?? 0;

  interface DisplayRow {
    variantId: string;
    productName: string;
    sku: string;
    label: string | null;
    unit: string;
    onHand: number;
  }
  const displayRows = $derived<DisplayRow[]>([
    ...levels.map((l) => ({ ...l, onHand: l.onHand })),
    ...added.map((a) => ({ ...a, onHand: 0 })),
  ]);

  // A row is changed when its counted value parses to a valid, non-negative
  // integer that differs from the on-hand.
  function parseCount(v: string | number | undefined): number | null {
    if (v == null || (typeof v === "string" && v.trim() === "")) return null;
    const n = Math.round(Number(v));
    if (!Number.isFinite(n) || n < 0) return null;
    return n;
  }
  const changedRows = $derived(
    displayRows.filter((r) => {
      const c = parseCount(counted[r.variantId]);
      return c != null && c !== r.onHand;
    }),
  );
  const hasInvalid = $derived(
    displayRows.some((r) => {
      const raw = counted[r.variantId];
      if (raw == null || String(raw).trim() === "") return false;
      // An untouched input still equals the seeded on-hand; never flag it —
      // a negative on-hand would otherwise show an error before any edit.
      if (String(raw).trim() === String(r.onHand)) return false;
      return parseCount(raw) == null;
    }),
  );

  // ---- Add-search ----------------------------------------------------------
  let search = $state("");
  interface VariantHit {
    variantId: string;
    productName: string;
    sku: string;
    label: string | null;
    unit: string;
  }
  const shownIds = $derived(new Set(displayRows.map((r) => r.variantId)));
  const hits = $derived.by<VariantHit[]>(() => {
    // AND-match whitespace tokens across name, SKU, label, and barcode, so word
    // order and gaps don't matter — "sproc m6" matches "M6 … sprocket". Mirrors
    // the Products screen / Combobox search rather than one contiguous match.
    if (search.trim().length < 2) return [];
    const tokens = searchTokens(search);
    if (tokens.length === 0) return [];
    const out: VariantHit[] = [];
    for (const p of products) {
      for (const v of p.variants) {
        if (shownIds.has(v.id)) continue;
        if (!matchesTokens(tokens, p.name, v.sku, v.label, v.barcode)) continue;
        out.push({
          variantId: v.id,
          productName: p.name,
          sku: v.sku,
          label: v.label ?? null,
          // The ref query does not carry unit; counts are in the variant's
          // smallest unit regardless, so a neutral placeholder is fine.
          unit: "",
        });
        if (out.length >= 12) return out;
      }
    }
    return out;
  });

  function addRow(h: VariantHit) {
    added.push({
      variantId: h.variantId,
      productName: h.productName,
      sku: h.sku,
      label: h.label,
      unit: h.unit,
    });
    counted[h.variantId] = "0";
    search = "";
  }
  function removeAdded(variantId: string) {
    added = added.filter((a) => a.variantId !== variantId);
    delete counted[variantId];
  }

  // ---- Row filter ----------------------------------------------------------
  // The same query narrows the rows already at this location, so a long count
  // sheet collapses to the item you're after. Edits live in `counted` (keyed by
  // variantId), so filtering only hides rows — pending counts and the save set
  // (`changedRows`, computed over the full list) are untouched.
  const visibleRows = $derived.by<DisplayRow[]>(() => {
    const tokens = searchTokens(search);
    if (tokens.length === 0) return displayRows;
    return displayRows.filter((r) =>
      matchesTokens(tokens, r.productName, r.sku, r.label),
    );
  });

  // ---- Save ----------------------------------------------------------------
  let reason = $state("");
  let busy = $state(false);
  let feedback = $state<{ ok: boolean; text: string } | null>(null);

  async function save() {
    if (!reason.trim()) {
      feedback = { ok: false, text: "Enter a reason for the adjustment." };
      return;
    }
    const lines = changedRows.map((r) => ({
      variantId: r.variantId,
      countedQty: parseCount(counted[r.variantId]) as number,
    }));
    if (lines.length === 0) return;
    busy = true;
    feedback = null;
    try {
      const res = await BulkAdjustStock.mutate({
        locationId: locValue || null,
        reason: reason.trim(),
        lines,
      });
      if (res.errors?.length) {
        feedback = { ok: false, text: res.errors[0].message };
        return;
      }
      const n = res.data?.bulkAdjustStock ?? 0;
      await Levels.fetch({
        variables: { locationId: locValue || null },
        policy: CachePolicy.NetworkOnly,
      });
      reason = "";
      feedback = { ok: true, text: `Adjusted ${n} item${n === 1 ? "" : "s"}.` };
    } catch (e) {
      feedback = { ok: false, text: e instanceof Error ? e.message : String(e) };
    } finally {
      busy = false;
    }
  }

  const delta = (r: DisplayRow): number | null => {
    const c = parseCount(counted[r.variantId]);
    return c == null || c === r.onHand ? null : c - r.onHand;
  };
</script>

<svelte:head><title>Stock editor · Retale Console</title></svelte:head>

<div class="space-y-4">
  <div class="flex items-center justify-between gap-4">
    <h1 class="text-xl font-semibold">Stock editor</h1>
    <div class="flex items-center gap-3">
      <label class="flex items-center gap-2 text-sm">
        <span class="text-muted-foreground">Location</span>
        <div class="w-52">
          <Select bind:value={locValue} onchange={changeLocation}>
            <option value={ROOT}>— Unlocated (root) —</option>
            {#each locations as l (l.id)}
              <option value={l.id}>{l.name}</option>
            {/each}
          </Select>
        </div>
      </label>
    </div>
  </div>

  <p class="text-sm text-muted-foreground">
    Type the counted on-hand for each item; the system records the difference as
    a stock adjustment against the chosen location. Use the search to filter the
    list below, or to pull in items that hold no stock here yet. One reason
    applies to the whole save.
  </p>

  {#if feedback}
    <p class="text-sm {feedback.ok ? 'text-emerald-700' : 'text-destructive'}">
      {feedback.text}
    </p>
  {/if}

  <!-- Add-search ----------------------------------------------------------- -->
  <div class="relative max-w-md">
    <Input
      bind:value={search}
      placeholder="Search or add items by name, SKU, or barcode…"
      disabled={!canAdjust}
    />
    {#if hits.length > 0}
      <div
        class="absolute z-10 mt-1 w-full overflow-hidden rounded-md border bg-card shadow-md"
      >
        {#each hits as h (h.variantId)}
          <button
            type="button"
            class="flex w-full items-center justify-between px-3 py-2 text-left text-sm hover:bg-accent/60"
            onclick={() => addRow(h)}
          >
            <span class="font-medium">{h.productName}</span>
            <span class="ml-2 font-mono text-xs text-muted-foreground">
              {h.sku}{h.label ? ` · ${h.label}` : ""}
            </span>
          </button>
        {/each}
      </div>
    {/if}
  </div>

  {#if $Levels.fetching && levels.length === 0}
    <p class="text-sm text-muted-foreground">Loading…</p>
  {:else if $Levels.errors?.length}
    <p class="text-sm text-destructive">{$Levels.errors[0].message}</p>
  {:else}
    <div class="overflow-hidden rounded-lg border bg-card">
      <table class="w-full text-sm">
        <thead class="border-b bg-muted/50 text-left text-muted-foreground">
          <tr>
            <th class="px-4 py-2 font-medium">Product</th>
            <th class="px-4 py-2 font-medium">SKU</th>
            <th class="px-4 py-2 text-right font-medium">On hand</th>
            <th class="px-4 py-2 font-medium">Counted</th>
            <th class="px-4 py-2 text-right font-medium">Δ</th>
            <th class="px-4 py-2"></th>
          </tr>
        </thead>
        <tbody>
          {#each visibleRows as r (r.variantId)}
            {@const d = delta(r)}
            <tr
              class="border-b last:border-0 hover:bg-muted/40
                {d != null ? 'bg-amber-50' : ''}"
            >
              <td class="px-4 py-2">
                <span class="font-medium">{r.productName}</span>
                {#if r.label}
                  <span class="ml-1 text-xs text-muted-foreground">{r.label}</span>
                {/if}
              </td>
              <td class="px-4 py-2 font-mono text-xs text-muted-foreground">
                {r.sku}
              </td>
              <td class="px-4 py-2 text-right tabular-nums">{r.onHand}</td>
              <td class="px-4 py-2">
                <Input
                  type="number"
                  class="w-24"
                  bind:value={counted[r.variantId]}
                  disabled={!canAdjust || busy}
                />
              </td>
              <td
                class="px-4 py-2 text-right tabular-nums
                  {d == null ? 'text-muted-foreground' : d > 0 ? 'text-emerald-700' : 'text-destructive'}"
              >
                {d == null ? "—" : d > 0 ? `+${d}` : d}
              </td>
              <td class="px-4 py-2 text-right">
                {#if added.some((a) => a.variantId === r.variantId)}
                  <IconButton
                    icon={Trash2}
                    label="Remove row"
                    variant="muted"
                    disabled={busy}
                    onclick={() => removeAdded(r.variantId)}
                  />
                {/if}
              </td>
            </tr>
          {/each}
          {#if visibleRows.length === 0}
            <tr>
              <td colspan="6" class="px-4 py-10 text-center text-muted-foreground">
                {#if search.trim() && displayRows.length > 0}
                  No items here match your search. Pick a result above to add it.
                {:else}
                  No stock recorded at this location. Use the search above to add
                  items and set their counts.
                {/if}
              </td>
            </tr>
          {/if}
        </tbody>
      </table>
    </div>

    <div class="flex items-end justify-between gap-4">
      <label class="flex-1 space-y-1">
        <span class="text-sm font-medium">Reason</span>
        <Input
          bind:value={reason}
          placeholder="e.g. Stocktake 2026-06-04"
          disabled={!canAdjust || busy}
        />
      </label>
      <div class="flex flex-col items-end gap-1">
        {#if hasInvalid}
          <span class="text-xs text-destructive">
            Some counts are not valid non-negative numbers.
          </span>
        {/if}
        <Button
          size="sm"
          disabled={busy || !canAdjust || changedRows.length === 0 || hasInvalid}
          onclick={save}
        >
          Save {changedRows.length} change{changedRows.length === 1 ? "" : "s"}
        </Button>
      </div>
    </div>
  {/if}
</div>
