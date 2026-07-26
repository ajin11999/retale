<script lang="ts">
  import { graphql } from "$houdini";
  import Button from "$lib/components/ui/button.svelte";
  import Combobox from "$lib/components/ui/combobox.svelte";
  import { X, Check } from "@lucide/svelte";

  let { 
    open = $bindable(false), 
    purchaseId, 
    products = [],
    onAdd 
  }: { 
    open: boolean; 
    purchaseId: string;
    products: any[];
    onAdd: () => void;
  } = $props();

  const OpenRequisitionsQuery = graphql(`
    query ConsoleOpenRequisitions {
      requisitions(includeCancelled: false) {
        id
        name
        status
        items {
          id
          variantId
          description
          qtyRequested
          qtyOrdered
        }
      }
    }
  `);

  const CreatePurchaseItems = graphql(`
    mutation ConsoleCreatePurchaseItemsFromReq(
      $purchaseId: ID!
      $lines: [PurchaseLineInput!]!
    ) {
      createPurchaseItems(purchaseId: $purchaseId, lines: $lines) {
        id
      }
    }
  `);

  let reqs = $state<any[]>([]);
  let selectedReqId = $state("");
  let selectedItemIds = $state<string[]>([]); // chronological order of clicks
  let busy = $state(false);

  // Fetch when opened
  $effect(() => {
    if (open) {
      OpenRequisitionsQuery.fetch({ policy: "NetworkOnly" }).then(res => {
        if (res.data?.requisitions) {
          reqs = res.data.requisitions.filter(r => ["open", "partially_ordered"].includes(r.status));
        }
      });
    } else {
      selectedReqId = "";
      selectedItemIds = [];
    }
  });

  const reqOptions = $derived(reqs.map(r => ({ value: r.id, label: r.name })));
  const requisition = $derived(reqs.find(r => r.id === selectedReqId));
  const availableItems = $derived(requisition?.items.filter((i: any) => i.qtyRequested > i.qtyOrdered) || []);

  function getVariantName(variantId: string | null, fallback: string | null) {
    if (!variantId) return fallback || "Unknown";
    for (const p of products) {
      for (const v of p.variants) {
        if (v.id === variantId) {
          return p.kind === "simple" ? p.name : `${p.name} - ${v.label}`;
        }
      }
    }
    return fallback || "Unknown";
  }

  function getSku(variantId: string | null) {
    if (!variantId) return "";
    for (const p of products) {
      for (const v of p.variants) {
        if (v.id === variantId) return v.sku;
      }
    }
    return "";
  }

  function toggleItem(id: string) {
    if (selectedItemIds.includes(id)) {
      selectedItemIds = selectedItemIds.filter(x => x !== id);
    } else {
      selectedItemIds = [...selectedItemIds, id];
    }
  }

  async function addSelected() {
    if (selectedItemIds.length === 0) return;
    busy = true;
    try {
      // Build lines in chronological selection order
      const lines = selectedItemIds.map(id => {
        const item = availableItems.find((i: any) => i.id === id);
        return {
          requisitionItemId: item.id,
          variantId: item.variantId,
          description: item.description,
          qtyOrdered: item.qtyRequested - item.qtyOrdered,
          unitCostMinor: 0 // User will fill this in after pulling
        };
      });

      await CreatePurchaseItems.mutate({
        purchaseId,
        lines
      });
      open = false;
      onAdd();
    } finally {
      busy = false;
    }
  }
</script>

{#if open}
  <div class="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4 sm:p-6">
    <div class="flex max-h-[90vh] w-full max-w-3xl flex-col rounded-lg bg-card shadow-lg ring-1 ring-border">
      <div class="flex shrink-0 items-center justify-between border-b p-4">
        <h2 class="text-lg font-semibold">Pull from Requisition</h2>
        <Button variant="ghost" size="icon" class="h-8 w-8 text-muted-foreground hover:text-foreground" onclick={() => open = false}>
          <X class="h-5 w-5" />
        </Button>
      </div>

      <div class="overflow-y-auto p-4 sm:p-6 space-y-4">
        <div class="space-y-1">
          <label class="text-sm font-medium">Select Requisition</label>
          <Combobox options={reqOptions} bind:value={selectedReqId} placeholder="Search open requisitions..." />
        </div>

        {#if requisition}
          <div class="mt-6 border rounded-lg overflow-hidden">
            <div class="bg-muted/30 px-4 py-2 border-b font-medium text-sm">
              Outstanding Items ({availableItems.length})
            </div>
            <table class="w-full text-sm">
              <thead class="border-b bg-muted/10 text-left text-muted-foreground">
                <tr>
                  <th class="w-10 px-4 py-2"></th>
                  <th class="px-4 py-2 font-medium">SKU</th>
                  <th class="px-4 py-2 font-medium">Item</th>
                  <th class="px-4 py-2 text-right font-medium">Remaining Qty</th>
                </tr>
              </thead>
              <tbody>
                {#each availableItems as item}
                  {@const selected = selectedItemIds.includes(item.id)}
                  {@const selectedIndex = selectedItemIds.indexOf(item.id)}
                  <tr class="border-b last:border-0 hover:bg-muted/40 cursor-pointer transition-colors {selected ? 'bg-sky-50 hover:bg-sky-50' : ''}" onclick={() => toggleItem(item.id)}>
                    <td class="px-4 py-2 text-center">
                      <div class="flex h-5 w-5 items-center justify-center rounded border {selected ? 'border-primary bg-primary text-primary-foreground' : 'border-input'}">
                        {#if selected}
                          <span class="text-xs font-bold">{selectedIndex + 1}</span>
                        {/if}
                      </div>
                    </td>
                    <td class="px-4 py-2 text-muted-foreground">{getSku(item.variantId)}</td>
                    <td class="px-4 py-2 font-medium">{getVariantName(item.variantId, item.description)}</td>
                    <td class="px-4 py-2 text-right text-amber-600 font-semibold">{item.qtyRequested - item.qtyOrdered}</td>
                  </tr>
                {:else}
                  <tr><td colspan="4" class="px-4 py-8 text-center text-muted-foreground">No outstanding items on this requisition.</td></tr>
                {/each}
              </tbody>
            </table>
          </div>
          {#if availableItems.length > 0}
            <p class="text-xs text-muted-foreground mt-2 text-center">
              Click items in the exact order they appear on your physical vendor invoice.
            </p>
          {/if}
        {/if}
      </div>

      <div class="flex shrink-0 items-center justify-end gap-2 border-t p-4 bg-muted/20">
        <Button variant="ghost" onclick={() => open = false}>Cancel</Button>
        <Button disabled={selectedItemIds.length === 0 || busy} onclick={addSelected}>
          Pull {selectedItemIds.length} {selectedItemIds.length === 1 ? 'line' : 'lines'}
        </Button>
      </div>
    </div>
  </div>
{/if}
