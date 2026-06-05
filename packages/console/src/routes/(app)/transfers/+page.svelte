<script lang="ts">
  import { graphql } from "$houdini";
  import { goto } from "$app/navigation";
  import { page } from "$app/state";
  import { Trash2 } from "@lucide/svelte";
  import type { Viewer } from "../+layout.server";
  import Badge from "$lib/components/ui/badge.svelte";
  import Button from "$lib/components/ui/button.svelte";
  import Combobox from "$lib/components/ui/combobox.svelte";
  import IconButton from "$lib/components/ui/icon-button.svelte";
  import Input from "$lib/components/ui/input.svelte";
  import { treePathMap } from "$lib/utils";
  import type { PageData } from "./$types";

  // Query document — Houdini scans this for codegen. The live store is
  // supplied by +page.ts through `data` (route-store wiring is unavailable).
  graphql(`
    query TransferList {
      stockTransfers(limit: 100) {
        id
        sourceLocationId
        targetLocationId
        status
        createdAt
        items {
          id
        }
      }
      locations {
        id
        name
        parentId
      }
      products(includeArchived: true) {
        id
        name
        variants {
          id
          sku
          label
        }
      }
    }
  `);

  const CreateTransfer = graphql(`
    mutation ConsoleCreateStockTransfer(
      $sourceLocationId: ID!
      $targetLocationId: ID!
      $items: [StockTransferItemInput!]!
      $notes: String
    ) {
      createStockTransfer(
        sourceLocationId: $sourceLocationId
        targetLocationId: $targetLocationId
        items: $items
        notes: $notes
      ) {
        id
      }
    }
  `);

  let { data }: { data: PageData } = $props();
  const TransferList = $derived(data.TransferList);
  const transfers = $derived($TransferList.data?.stockTransfers ?? []);
  const locations = $derived($TransferList.data?.locations ?? []);
  const products = $derived($TransferList.data?.products ?? []);

  // Breadcrumb path per location ("Shelf 2 › Level 1") so same-named children
  // under different parents are distinguishable.
  const locationPaths = $derived(treePathMap(locations));
  const locationName = (id: string) => locationPaths.get(id) ?? "Unknown";

  // Searchable Combobox options ({ value, label }) for locations + variants.
  const locationOptions = $derived(
    locations.map((l) => ({ value: l.id, label: locationName(l.id) })),
  );

  // Flat variant options for the item picker.
  interface VariantOption {
    value: string;
    label: string;
  }
  const variantOptions = $derived.by<VariantOption[]>(() => {
    const out: VariantOption[] = [];
    for (const p of products) {
      for (const v of p.variants) {
        const suffix = v.label ? `${v.sku} · ${v.label}` : v.sku;
        out.push({ value: v.id, label: `${p.name} · ${suffix}` });
      }
    }
    return out.sort((a, b) => a.label.localeCompare(b.label));
  });

  // ---- Viewer permissions --------------------------------------------------
  const viewer = $derived(page.data.user as Viewer | undefined);
  const has = (key: string) => !!viewer && viewer.permissions.includes(key);
  const canCreate = $derived(has("stock.transfer.create"));

  const statusClass = (s: string) =>
    s === "draft"
      ? "bg-muted text-muted-foreground"
      : s === "in_transit"
        ? "bg-sky-100 text-sky-700"
        : s === "received"
          ? "bg-emerald-100 text-emerald-700"
          : "bg-amber-100 text-amber-800";
  const fmtDate = (iso: string) => new Date(iso).toLocaleDateString("id-ID");

  // ---- New-transfer composer ----------------------------------------------
  interface ItemRow {
    variantId: string;
    qty: number;
  }
  interface Draft {
    sourceLocationId: string;
    targetLocationId: string;
    notes: string;
    items: ItemRow[];
  }
  let draft = $state<Draft | null>(null);
  let busy = $state(false);
  let error = $state<string | null>(null);

  function startNew() {
    draft = {
      sourceLocationId: "",
      targetLocationId: "",
      notes: "",
      items: [{ variantId: "", qty: 1 }],
    };
  }

  function addRow() {
    draft?.items.push({ variantId: "", qty: 1 });
  }
  function removeRow(i: number) {
    draft?.items.splice(i, 1);
  }

  async function createTransfer() {
    const d = draft;
    if (!d) return;
    const items = d.items
      .filter((r) => r.variantId && r.qty > 0)
      .map((r) => ({ variantId: r.variantId, qty: Math.round(r.qty) }));
    if (!d.sourceLocationId || !d.targetLocationId) {
      error = "Pick a source and target location.";
      return;
    }
    if (d.sourceLocationId === d.targetLocationId) {
      error = "Source and target must differ.";
      return;
    }
    if (items.length === 0) {
      error = "Add at least one line with a variant and quantity.";
      return;
    }
    busy = true;
    error = null;
    try {
      const res = await CreateTransfer.mutate({
        sourceLocationId: d.sourceLocationId,
        targetLocationId: d.targetLocationId,
        items,
        notes: d.notes.trim() || null,
      });
      if (res.errors?.length) {
        error = res.errors[0].message;
        return;
      }
      const id = res.data?.createStockTransfer.id;
      if (id) await goto(`/transfers/${id}`);
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    } finally {
      busy = false;
    }
  }
</script>

<svelte:head><title>Stock transfers · Retale Console</title></svelte:head>

<div class="space-y-4">
  <div class="flex items-center justify-between">
    <h1 class="text-xl font-semibold">Stock transfers</h1>
    <Button size="sm" disabled={busy || !canCreate} onclick={startNew}>
      New transfer
    </Button>
  </div>

  {#if error}
    <p class="text-sm text-destructive">{error}</p>
  {/if}

  {#if draft}
    <div class="space-y-3 rounded-lg border bg-card p-5">
      <h2 class="text-sm font-semibold">New transfer</h2>
      <p class="text-xs text-muted-foreground">
        A transfer's lines are fixed at creation — it starts as a draft and
        moves no stock until dispatched.
      </p>
      <div class="grid grid-cols-2 gap-4">
        <label class="space-y-1">
          <span class="text-sm font-medium">Source location</span>
          <Combobox
            options={locationOptions}
            bind:value={draft.sourceLocationId}
            placeholder="Search location…"
          />
        </label>
        <label class="space-y-1">
          <span class="text-sm font-medium">Target location</span>
          <Combobox
            options={locationOptions}
            bind:value={draft.targetLocationId}
            placeholder="Search location…"
          />
        </label>
      </div>

      <div class="space-y-2">
        <span class="text-sm font-medium">Lines</span>
        {#each draft.items as row, i (i)}
          <div class="flex items-center gap-2">
            <div class="flex-1">
              <Combobox
                options={variantOptions}
                bind:value={row.variantId}
                placeholder="Search variant…"
              />
            </div>
            <Input type="number" bind:value={row.qty} class="w-24" />
            <IconButton
              icon={Trash2}
              label="Remove row"
              variant="destructive"
              disabled={draft.items.length === 1}
              onclick={() => removeRow(i)}
            />
          </div>
        {/each}
        <Button variant="outline" size="sm" onclick={addRow}>Add line</Button>
      </div>

      <label class="space-y-1">
        <span class="text-sm font-medium">Notes (optional)</span>
        <Input bind:value={draft.notes} />
      </label>

      <div class="flex justify-end gap-2">
        <Button
          variant="ghost"
          size="sm"
          disabled={busy}
          onclick={() => (draft = null)}>Cancel</Button
        >
        <Button size="sm" disabled={busy} onclick={createTransfer}>
          Create draft
        </Button>
      </div>
    </div>
  {/if}

  {#if $TransferList.fetching && transfers.length === 0}
    <p class="text-sm text-muted-foreground">Loading…</p>
  {:else if $TransferList.errors?.length}
    <p class="text-sm text-destructive">{$TransferList.errors[0].message}</p>
  {:else}
    <div class="overflow-hidden rounded-lg border bg-card">
      <table class="w-full text-sm">
        <thead class="border-b bg-muted/50 text-left text-muted-foreground">
          <tr>
            <th class="px-4 py-2 font-medium">From → To</th>
            <th class="px-4 py-2 text-right font-medium">Lines</th>
            <th class="px-4 py-2 font-medium">Created</th>
            <th class="px-4 py-2 font-medium">Status</th>
          </tr>
        </thead>
        <tbody>
          {#each transfers as t (t.id)}
            <tr class="border-b last:border-0 hover:bg-muted/40">
              <td class="px-4 py-2">
                <a
                  href={`/transfers/${t.id}`}
                  class="font-medium text-primary hover:underline"
                >
                  {locationName(t.sourceLocationId)} →
                  {locationName(t.targetLocationId)}
                </a>
              </td>
              <td class="px-4 py-2 text-right">{t.items.length}</td>
              <td class="px-4 py-2">{fmtDate(t.createdAt)}</td>
              <td class="px-4 py-2">
                <Badge class={statusClass(t.status)}>{t.status}</Badge>
              </td>
            </tr>
          {/each}
          {#if transfers.length === 0}
            <tr>
              <td colspan="4" class="px-4 py-10 text-center text-muted-foreground">
                No transfers yet.
              </td>
            </tr>
          {/if}
        </tbody>
      </table>
    </div>
  {/if}
</div>
