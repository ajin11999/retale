<script lang="ts">
  import Combobox from "$lib/components/ui/combobox.svelte";
  import NumericInput from "$lib/components/ui/numeric-input.svelte";
  import { graphql } from "$houdini";
  import { page } from "$app/state";
  import type { Viewer } from "../../+layout.server";
  import Badge from "$lib/components/ui/badge.svelte";
  import Button from "$lib/components/ui/button.svelte";
  import IconButton from "$lib/components/ui/icon-button.svelte";
  import Input from "$lib/components/ui/input.svelte";
  import { Trash2, X } from "@lucide/svelte";
  import { treePathMap } from "$lib/utils";
  import { t } from "$lib/i18n";
  import type { PageData } from "./$types";

  // Query document — Houdini scans this for codegen.
  graphql(`
    query TransferDetail($id: ID!) {
      stockTransfer(id: $id) {
        id
        targetLocationId
        status
        notes
        dispatchedAt
        receivedAt
        cancelledAt
        cancellationReason
        createdAt
        items {
          id
          sourceLocationId
          variantId
          qty
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

  const DispatchTransfer = graphql(`
    mutation ConsoleDispatchStockTransfer($id: ID!) {
      dispatchStockTransfer(id: $id) {
        id
        status
      }
    }
  `);

  const ReceiveTransfer = graphql(`
    mutation ConsoleReceiveStockTransfer($id: ID!) {
      receiveStockTransfer(id: $id) {
        id
        status
      }
    }
  `);

  const CancelTransfer = graphql(`
    mutation ConsoleCancelStockTransfer($id: ID!, $reason: String!) {
      cancelStockTransfer(id: $id, reason: $reason) {
        id
        status
      }
    }
  `);

  const AddItems = graphql(`
    mutation ConsoleAddTransferItems($id: ID!, $items: [StockTransferItemInput!]!) {
      addStockTransferItems(id: $id, items: $items) {
        id
      }
    }
  `);

  const RemoveItem = graphql(`
    mutation ConsoleRemoveTransferItem($id: ID!, $itemId: ID!) {
      removeStockTransferItem(id: $id, itemId: $itemId) {
        id
      }
    }
  `);

  const LocationStockLevels = graphql(`
    query ConsoleLocationStockLevels($locationId: ID) {
      locationStockLevels(locationId: $locationId) {
        variantId
        productName
        sku
        label
        onHand
      }
    }
  `);

  let { data }: { data: PageData } = $props();
  const TransferDetail = $derived(data.TransferDetail);
  const transfer = $derived($TransferDetail.data?.stockTransfer);
  const locations = $derived($TransferDetail.data?.locations ?? []);
  const products = $derived($TransferDetail.data?.products ?? []);

  const locationPaths = $derived(treePathMap(locations));
  const locationName = (id: string) => locationPaths.get(id) ?? t("products.unknown");
  
  const locationOptions = $derived(
    locations
      .filter((l) => l.id !== transfer?.targetLocationId)
      .map((l) => ({ value: l.id, label: locationName(l.id) })),
  );

  const variantLabel = (id: string) => {
    for (const p of products) {
      const v = p.variants.find((x) => x.id === id);
      if (v) {
        const suffix = v.label ? `${v.sku} · ${v.label}` : v.sku;
        return `${p.name} · ${suffix}`;
      }
    }
    return t("transferDetail.unknownVariant");
  };

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

  const viewer = $derived(page.data.user as Viewer | undefined);
  const has = (key: string) => !!viewer && viewer.permissions.includes(key);
  const canDispatch = $derived(has("stock.transfer.dispatch"));
  const canReceive = $derived(has("stock.transfer.receive"));
  const canCancel = $derived(has("stock.transfer.cancel"));
  const canEdit = $derived(has("stock.transfer.create"));

  let busy = $state(false);
  let feedback = $state<{ ok: boolean; text: string } | null>(null);

  async function run(
    fn: () => Promise<{ errors?: readonly { message: string }[] | null }>,
  ): Promise<boolean> {
    busy = true;
    feedback = null;
    try {
      const res = await fn();
      if (res.errors?.length) {
        feedback = { ok: false, text: res.errors[0].message };
        return false;
      }
      return true;
    } catch (e) {
      feedback = { ok: false, text: e instanceof Error ? e.message : String(e) };
      return false;
    } finally {
      busy = false;
    }
  }

  const refetch = () =>
    transfer && TransferDetail.fetch({ variables: { id: transfer.id }, policy: "NetworkOnly" });

  async function dispatch() {
    if (!transfer) return;
    if (!confirm(t("transferDetail.confirmDispatch"))) return;
    if (await run(() => DispatchTransfer.mutate({ id: transfer.id }))) {
      feedback = { ok: true, text: t("transferDetail.dispatchSuccess") };
      await refetch();
    }
  }

  async function receive() {
    if (!transfer) return;
    if (!confirm(t("transferDetail.confirmReceive"))) return;
    if (await run(() => ReceiveTransfer.mutate({ id: transfer.id }))) {
      feedback = { ok: true, text: t("transferDetail.receiveSuccess") };
      await refetch();
    }
  }

  async function cancel() {
    if (!transfer) return;
    const reason = prompt(t("transferDetail.cancelReasonPrompt"));
    if (reason === null) return;
    if (!reason.trim()) {
      feedback = { ok: false, text: t("transferDetail.cancelReasonRequired") };
      return;
    }
    if (await run(() => CancelTransfer.mutate({ id: transfer.id, reason: reason.trim() }))) {
      feedback = { ok: true, text: t("transferDetail.cancelSuccess") };
      await refetch();
    }
  }

  // Active source sections that the user has added to the UI
  let activeSourceSections = $state<string[]>([]);

  // Derive all source locations that either have existing items, or have been manually added to UI
  const sourceSections = $derived.by(() => {
    const ids = [...activeSourceSections];
    if (transfer?.items) {
      for (const item of transfer.items) {
        if (!ids.includes(item.sourceLocationId)) {
          ids.push(item.sourceLocationId);
        }
      }
    }
    return ids.map(id => ({
      sourceLocationId: id,
      items: transfer?.items.filter(i => i.sourceLocationId === id) || []
    }));
  });

  let newSectionSourceId = $state("");
  function addSection() {
    console.log("addSection called with:", newSectionSourceId);
    if (newSectionSourceId && transfer?.targetLocationId !== newSectionSourceId) {
      if (!activeSourceSections.includes(newSectionSourceId)) {
        activeSourceSections = [...activeSourceSections, newSectionSourceId];
        console.log("Added to activeSourceSections:", activeSourceSections);
      }
      newSectionSourceId = "";
    } else if (transfer?.targetLocationId === newSectionSourceId) {
      alert(t("transferDetail.sameSourceError"));
    }
  }

  let addVariantIds = $state<Record<string, string>>({});
  let addQtys = $state<Record<string, number>>({});

  async function addLine(sourceId: string) {
    if (!transfer) return;
    const variantId = addVariantIds[sourceId];
    const qty = addQtys[sourceId] || 1;
    if (!variantId || qty <= 0) return;
    
    if (await run(() => AddItems.mutate({ id: transfer.id, items: [{ variantId, qty, sourceLocationId: sourceId }] }))) {
      addVariantIds[sourceId] = "";
      addQtys[sourceId] = 1;
      await refetch();
    }
  }

  async function removeLine(itemId: string) {
    if (!transfer) return;
    if (await run(() => RemoveItem.mutate({ id: transfer.id, itemId }))) {
      await refetch();
    }
  }

  interface BulkItem {
    variantId: string;
    name: string;
    onHand: number;
    selected: boolean;
    qty: number;
  }
  let bulkSourceId = $state<string | null>(null);
  let bulkItems = $state<BulkItem[]>([]);
  let bulkItemsLoading = $state(false);
  let bulkSearchQuery = $state("");

  const filteredBulkItems = $derived(
    bulkItems.filter(i => i.name.toLowerCase().includes(bulkSearchQuery.toLowerCase()))
  );

  async function doBulkTransfer(sourceId: string) {
    bulkSourceId = sourceId;
    bulkItemsLoading = true;
    bulkSearchQuery = "";
    try {
      const res = await LocationStockLevels.fetch({ variables: { locationId: sourceId } });
      if (res.data?.locationStockLevels) {
        // Find items that are already in this source section to skip or show existing?
        // Let's just list all stock levels.
        bulkItems = res.data.locationStockLevels.map(i => {
          const suffix = i.label ? `${i.sku} · ${i.label}` : i.sku;
          return {
            variantId: i.variantId,
            name: `${i.productName} · ${suffix}`,
            onHand: i.onHand,
            selected: false,
            qty: i.onHand, // Default to full onHand amount for quick transfer
          };
        });
      }
    } catch (e) {
      feedback = { ok: false, text: e instanceof Error ? e.message : String(e) };
    } finally {
      bulkItemsLoading = false;
    }
  }

  async function submitBulkTransfer() {
    if (!transfer || !bulkSourceId) return;
    const selected = bulkItems.filter(i => i.selected && i.qty > 0);
    if (selected.length === 0) {
      bulkSourceId = null;
      return;
    }
    
    const items = selected.map(i => ({
      variantId: i.variantId,
      qty: i.qty,
      sourceLocationId: bulkSourceId!
    }));

    if (await run(() => AddItems.mutate({ id: transfer.id, items }))) {
      bulkSourceId = null;
      await refetch();
    }
  }

  const statusClass = (s: string) =>
    s === "draft"
      ? "bg-muted text-muted-foreground"
      : s === "in_transit"
        ? "bg-sky-100 text-sky-700"
        : s === "received"
          ? "bg-emerald-100 text-emerald-700"
          : "bg-amber-100 text-amber-800";
  const fmtDateTime = (iso: string | null | undefined) =>
    iso ? new Date(iso).toLocaleString("id-ID") : "—";

  function formatSources(items: any[]) {
    if (!items || items.length === 0) return "—";
    const uniqueSources = Array.from(new Set(items.map((i) => i.sourceLocationId)));
    if (uniqueSources.length === 1) return locationName(uniqueSources[0] as string);
    return t("transfers.multiple");
  }
</script>

<svelte:head><title>{t("transferDetail.pageTitle")}</title></svelte:head>

<div class="mx-auto max-w-2xl space-y-6">
  <a
    href="/transfers"
    class="text-sm text-muted-foreground hover:text-foreground"
    >{t("transferDetail.backToTransfers")}</a
  >

  {#if $TransferDetail.fetching && !transfer}
    <p class="text-sm text-muted-foreground">{t("common.loading")}</p>
  {:else if !transfer}
    <p class="text-sm text-destructive">{t("transferDetail.notFound")}</p>
  {:else}
    <div class="flex items-start justify-between gap-4">
      <div>
        <h1 class="text-xl font-semibold">
          {t("transferDetail.transferTo", { location: locationName(transfer.targetLocationId) })}
        </h1>
        <p class="text-sm text-muted-foreground">
          {t("transferDetail.created", { date: fmtDateTime(transfer.createdAt) })}
        </p>
      </div>
      <Badge class={statusClass(transfer.status)}>{t(`transfers.status.${transfer.status}`)}</Badge>
    </div>

    {#if feedback}
      <p class="text-sm {feedback.ok ? 'text-emerald-700' : 'text-destructive'}">
        {feedback.text}
      </p>
    {/if}

    <!-- Lifecycle actions -->
    <div class="flex gap-2">
      {#if transfer.status === "draft"}
        <Button size="sm" disabled={busy || !canDispatch} onclick={dispatch}>
          {t("transferDetail.dispatch")}
        </Button>
        <Button
          variant="outline"
          size="sm"
          disabled={busy || !canCancel}
          onclick={cancel}>{t("common.cancel")}</Button
        >
      {:else if transfer.status === "in_transit"}
        <Button size="sm" disabled={busy || !canReceive} onclick={receive}>
          {t("transferDetail.receive")}
        </Button>
        <Button
          variant="outline"
          size="sm"
          disabled={busy || !canCancel}
          onclick={cancel}>{t("common.cancel")}</Button
        >
      {:else}
        <p class="text-sm text-muted-foreground">
          {t("transferDetail.noFurtherActions", { status: t(`transfers.status.${transfer.status}`) })}
        </p>
      {/if}
    </div>

    <!-- Timeline -->
    <section class="space-y-1 rounded-lg border bg-card p-5 text-sm">
      <h2 class="mb-2 text-sm font-semibold">{t("transferDetail.timelineDetails")}</h2>
      <div class="flex justify-between">
        <span class="text-muted-foreground">{t("transferDetail.destination")}</span>
        <span class="font-medium">{locationName(transfer.targetLocationId)}</span>
      </div>
      <div class="flex justify-between">
        <span class="text-muted-foreground">{t("transferDetail.sources")}</span>
        <span>{formatSources(transfer.items)}</span>
      </div>
      <div class="flex justify-between">
        <span class="text-muted-foreground">{t("transferDetail.dispatched")}</span>
        <span>{fmtDateTime(transfer.dispatchedAt)}</span>
      </div>
      <div class="flex justify-between">
        <span class="text-muted-foreground">{t("transferDetail.received")}</span>
        <span>{fmtDateTime(transfer.receivedAt)}</span>
      </div>
      {#if transfer.cancelledAt}
        <div class="flex justify-between">
          <span class="text-muted-foreground">{t("transferDetail.cancelled")}</span>
          <span>{fmtDateTime(transfer.cancelledAt)}</span>
        </div>
        {#if transfer.cancellationReason}
          <p class="pt-1 text-muted-foreground">
            {t("transferDetail.reason", { reason: transfer.cancellationReason })}
          </p>
        {/if}
      {/if}
      {#if transfer.notes}
        <p class="pt-2 text-muted-foreground">{t("transferDetail.notes", { notes: transfer.notes })}</p>
      {/if}
    </section>

    <!-- Lines Grouped by Source -->
    <section class="space-y-6">
      {#each sourceSections as section (section.sourceLocationId)}
        <div class="rounded-lg border bg-card p-5 shadow-sm space-y-4">
          <div class="flex items-center justify-between border-b pb-3">
            <h3 class="text-base font-semibold">{t("transferDetail.fromLocation", { location: locationName(section.sourceLocationId) })}</h3>
            {#if transfer.status === "draft" && canEdit}
              <Button size="sm" variant="outline" onclick={() => doBulkTransfer(section.sourceLocationId)}>
                {t("transferDetail.bulkTransfer")}
              </Button>
            {/if}
          </div>

          {#if section.items.length > 0}
            <table class="w-full text-sm">
              <thead class="text-left text-muted-foreground">
                <tr>
                  <th class="py-1.5 font-medium">{t("interchangeGroups.variant")}</th>
                  <th class="py-1.5 text-right font-medium">{t("common.quantity")}</th>
                  {#if transfer.status === "draft" && canEdit}
                    <th class="py-1.5 w-10"></th>
                  {/if}
                </tr>
              </thead>
              <tbody>
                {#each section.items as i (i.id)}
                  <tr class="border-b last:border-0 hover:bg-muted/40">
                    <td class="py-1.5">{variantLabel(i.variantId)}</td>
                    <td class="py-1.5 text-right">{i.qty}</td>
                    {#if transfer.status === "draft" && canEdit}
                      <td class="py-1.5 text-right">
                        <IconButton
                          icon={Trash2}
                          label={t("transferDetail.removeLine")}
                          variant="destructive"
                          disabled={busy}
                          onclick={() => removeLine(i.id)}
                        />
                      </td>
                    {/if}
                  </tr>
                {/each}
              </tbody>
            </table>
          {:else}
            <p class="text-sm text-muted-foreground py-2">{t("transferDetail.noItemsFromLocation")}</p>
          {/if}

          {#if transfer.status === "draft" && canEdit}
            <div class="flex gap-2 items-center mt-3 pt-3 border-t">
              <div class="flex-1">
                <Combobox
                  options={variantOptions}
                  bind:value={addVariantIds[section.sourceLocationId]}
                  placeholder={t("transfers.searchVariantToAdd")}
                />
              </div>
              <NumericInput bind:value={addQtys[section.sourceLocationId]} class="w-24" />
              <Button 
                size="sm" 
                disabled={busy || !addVariantIds[section.sourceLocationId] || (addQtys[section.sourceLocationId] || 1) <= 0} 
                onclick={() => addLine(section.sourceLocationId)}
              >
                {t("transferDetail.addLine")}
              </Button>
            </div>
          {/if}
        </div>
      {/each}

      {#if transfer.status === "draft" && canEdit}
        <form 
          class="rounded-lg border border-dashed bg-card/50 p-5 space-y-3"
          onsubmit={(e) => { e.preventDefault(); addSection(); }}
        >
          <h3 class="text-sm font-semibold">{t("transferDetail.addNewSource")}</h3>
          <p class="text-xs text-muted-foreground">{t("transferDetail.transferSubtitle", { location: locationName(transfer.targetLocationId) })}</p>
          <div class="flex gap-2">
            <div class="flex-1 max-w-sm">
              <Combobox
                options={locationOptions.filter(l => l.value !== transfer.targetLocationId)}
                bind:value={newSectionSourceId}
                placeholder={t("transfers.searchSourceLocation")}
              />
            </div>
            <Button type="submit" size="sm" disabled={!newSectionSourceId}>{t("transfers.addSource")}</Button>
          </div>
        </form>
      {/if}
    </section>
  {/if}
</div>

{#if bulkSourceId}
  <div class="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-4">
    <div class="bg-card w-full max-w-3xl rounded-lg shadow-lg flex flex-col max-h-[90vh]">
      <!-- Header -->
      <div class="px-6 py-4 border-b flex justify-between items-center">
        <h2 class="text-lg font-semibold">{t("transferDetail.bulkTransferFrom", { location: locationName(bulkSourceId) })}</h2>
        <IconButton icon={X} onclick={() => (bulkSourceId = null)} label={t("common.close")} />
      </div>
      <!-- Body -->
      <div class="p-6 overflow-y-auto flex-1 space-y-4">
        {#if bulkItemsLoading}
          <p class="text-muted-foreground text-sm">{t("transferDetail.loadingStockLevels")}</p>
        {:else if bulkItems.length === 0}
          <p class="text-muted-foreground text-sm">{t("transferDetail.noStockFound")}</p>
        {:else}
          <div class="flex justify-between items-center">
            <Input bind:value={bulkSearchQuery} placeholder={t("transfers.searchVariants")} class="max-w-xs" />
            <div class="space-x-2">
              <Button size="sm" variant="outline" onclick={() => bulkItems.forEach(i => i.selected = true)}>{t("common.selectAll")}</Button>
              <Button size="sm" variant="outline" onclick={() => bulkItems.forEach(i => i.selected = false)}>{t("common.deselectAll")}</Button>
            </div>
          </div>
          <table class="w-full text-sm mt-4">
            <thead class="text-left border-b text-muted-foreground">
              <tr>
                <th class="py-2 w-10"></th>
                <th class="py-2 font-medium">{t("interchangeGroups.variant")}</th>
                <th class="py-2 font-medium text-right">{t("stock.onHand")}</th>
                <th class="py-2 font-medium text-right w-32">{t("transferDetail.transferQty")}</th>
              </tr>
            </thead>
            <tbody>
              {#each filteredBulkItems as item (item.variantId)}
                <tr class="border-b last:border-0 hover:bg-muted/40">
                  <td class="py-2">
                    <input type="checkbox" bind:checked={item.selected} class="rounded border-input text-primary focus:ring-primary" />
                  </td>
                  <td class="py-2">{item.name}</td>
                  <td class="py-2 text-right text-muted-foreground">{item.onHand}</td>
                  <td class="py-2 text-right">
                    <NumericInput bind:value={item.qty} class="w-24 ml-auto" disabled={!item.selected} />
                  </td>
                </tr>
              {/each}
              {#if filteredBulkItems.length === 0}
                <tr>
                  <td colspan="4" class="py-4 text-center text-muted-foreground">{t("transferDetail.noMatches", { query: bulkSearchQuery })}</td>
                </tr>
              {/if}
            </tbody>
          </table>
        {/if}
      </div>
      <!-- Footer -->
      <div class="px-6 py-4 border-t flex justify-end gap-2 bg-muted/20">
        <Button variant="ghost" disabled={busy} onclick={() => (bulkSourceId = null)}>{t("common.cancel")}</Button>
        <Button disabled={busy || !bulkItems.some(i => i.selected)} onclick={submitBulkTransfer}>
          {t("transferDetail.addSelected")}
        </Button>
      </div>
    </div>
  </div>
{/if}
