<script lang="ts">
  import { graphql } from "$houdini";
  import Button from "$lib/components/ui/button.svelte";
  import { X } from "@lucide/svelte";

  let {
    open = $bindable(false),
    purchaseId,
    selectedItemIds = [],
    items = [],
    onSaved
  }: {
    open: boolean;
    purchaseId: string;
    selectedItemIds: string[];
    items: any[];
    onSaved: () => void;
  } = $props();

  const UpdateCosts = graphql(`
    mutation ConsoleUpdatePurchaseItemsCosts(
      $purchaseId: ID!
      $updates: [PurchaseItemCostUpdate!]!
    ) {
      updatePurchaseItemsCosts(purchaseId: $purchaseId, updates: $updates) {
        id
        baseCostMinor
        discount
        taxPct
        unitCostMinor
      }
    }
  `);

  let busy = $state(false);
  let discountType = $state<"percentage" | "fixed">("percentage");
  let discountString = $state(""); // e.g., "10+2.5"
  let discountFixed = $state<number | null>(null);
  let taxPct = $state<number | null>(null);

  const getItemBaseCost = (item: any) => {
    if (typeof item?.baseCostMinor === 'number' && item.baseCostMinor > 0) return item.baseCostMinor;
    if (typeof item?.unitCostMinor === 'number' && item.unitCostMinor > 0) return item.unitCostMinor;
    return 0;
  };

  const selectedItems = $derived(items.filter(i => selectedItemIds.includes(i.id)));
  const totalBaseAmount = $derived(selectedItems.reduce((acc, i) => acc + (getItemBaseCost(i) * (i.qtyOrdered || 0)), 0));

  let prevOpen = false;
  $effect(() => {
    if (open && !prevOpen) {
      const first = selectedItems[0];
      const sameDiscount = selectedItems.length > 0 && selectedItems.every(i => (i.discount || null) === (first?.discount || null));
      const sameTax = selectedItems.length > 0 && selectedItems.every(i => (i.taxPct ?? null) === (first?.taxPct ?? null));

      if (sameDiscount && first?.discount) {
        if (first.discount.startsWith("flat-")) {
          discountType = "fixed";
          const val = parseFloat(first.discount.replace("flat-", ""));
          discountFixed = isNaN(val) ? null : val;
          discountString = "";
        } else {
          discountType = "percentage";
          discountString = first.discount;
          discountFixed = null;
        }
      } else {
        discountType = "percentage";
        discountString = "";
        discountFixed = null;
      }

      if (sameTax && first?.taxPct != null) {
        taxPct = first.taxPct;
      } else {
        taxPct = null;
      }
    }
    prevOpen = open;
  });

  // Compute chained percentage discount from a string like "10+2.5"
  function getDiscountMultiplier(str: string) {
    if (!str.trim()) return 1;
    const parts = str.split("+").map(p => parseFloat(p.trim())).filter(p => !isNaN(p));
    let multiplier = 1;
    for (const p of parts) {
      multiplier *= (1 - (p / 100));
    }
    return multiplier;
  }

  const computedUpdates = $derived.by(() => {
    const pMultiplier = discountType === "percentage" ? getDiscountMultiplier(discountString) : 1;
    const fixedDiscount = discountType === "fixed" ? (discountFixed || 0) : 0;
    const taxMultiplier = 1 + ((taxPct || 0) / 100);

    return selectedItems.map(item => {
      const baseCost = getItemBaseCost(item);
      const qty = item.qtyOrdered || 0;
      const lineSubtotal = baseCost * qty;
      
      let netLineSubtotal = lineSubtotal;
      let finalDiscountString = "";

      if (discountType === "percentage") {
        netLineSubtotal = lineSubtotal * pMultiplier;
        finalDiscountString = discountString.trim();
      } else if (discountType === "fixed" && totalBaseAmount > 0) {
        // Proportional distribution
        const weight = lineSubtotal / totalBaseAmount;
        const portion = fixedDiscount * weight;
        netLineSubtotal = Math.max(0, lineSubtotal - portion);
        // We can't really store a clean string for proportional fixed discounts easily, 
        // but we can just say "flat" or leave it null, or store the distributed amount.
        // Let's store the proportion amount as a string if we want, or just leave it blank.
        finalDiscountString = `flat-${fixedDiscount}`;
      }

      netLineSubtotal = netLineSubtotal * taxMultiplier;

      const newUnitCost = qty > 0 ? netLineSubtotal / qty : 0;

      return {
        id: item.id,
        qtyOrdered: qty,
        description: item.description || item.variant?.sku || 'Item',
        baseCostMinor: baseCost,
        discount: finalDiscountString || null,
        taxPct: taxPct || null,
        unitCostMinor: Math.max(0, Math.round(newUnitCost * 100) / 100),
        newSubtotal: Math.max(0, Math.round(netLineSubtotal * 100) / 100),
      };
    });
  });

  const newTotalAmount = $derived(computedUpdates.reduce((acc, u) => acc + u.newSubtotal, 0));

  async function save() {
    if (selectedItemIds.length === 0) return;
    busy = true;
    try {
      await UpdateCosts.mutate({
        purchaseId,
        updates: computedUpdates.map(u => ({
          id: u.id,
          baseCostMinor: u.baseCostMinor,
          discount: u.discount,
          taxPct: u.taxPct,
          unitCostMinor: u.unitCostMinor
        }))
      });
      open = false;
      onSaved();
    } finally {
      busy = false;
    }
  }
</script>

{#if open}
  <div class="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4 sm:p-6">
    <div class="flex max-h-[90vh] w-full max-w-4xl flex-col rounded-lg bg-card shadow-lg ring-1 ring-border">
      <div class="flex shrink-0 items-center justify-between border-b p-4">
        <h2 class="text-lg font-semibold">Calculate Discount</h2>
        <Button variant="ghost" size="icon" class="h-8 w-8 text-muted-foreground hover:text-foreground" onclick={() => open = false}>
          <X class="h-5 w-5" />
        </Button>
      </div>

      <div class="flex-1 overflow-y-auto p-4 sm:p-6 flex flex-col md:flex-row gap-6">
        <!-- Sidebar Controls -->
        <div class="w-full md:w-64 space-y-6 flex-shrink-0">
          <div class="space-y-3">
            <h3 class="text-sm font-semibold">Discount Type</h3>
            <div class="flex bg-muted p-1 rounded-md">
              <button 
                class="flex-1 text-sm py-1.5 rounded-sm {discountType === 'percentage' ? 'bg-background shadow-sm' : 'text-muted-foreground hover:bg-background/50'}"
                onclick={() => discountType = 'percentage'}
              >
                Percentage
              </button>
              <button 
                class="flex-1 text-sm py-1.5 rounded-sm {discountType === 'fixed' ? 'bg-background shadow-sm' : 'text-muted-foreground hover:bg-background/50'}"
                onclick={() => discountType = 'fixed'}
              >
                Fixed Amount
              </button>
            </div>
          </div>

          {#if discountType === 'percentage'}
            <div class="space-y-1">
              <label class="text-sm font-medium">Multi-layer Discount</label>
              <input 
                type="text" 
                class="w-full border rounded-md px-3 py-2 text-sm bg-background" 
                bind:value={discountString} 
                placeholder="e.g. 10+2.5" 
              />
              <p class="text-xs text-muted-foreground">Chain discounts with a plus sign.</p>
            </div>
          {:else}
            <div class="space-y-1">
              <label class="text-sm font-medium">Global Flat Discount</label>
              <div class="relative">
                <span class="absolute left-3 top-2 text-sm text-muted-foreground">Rp</span>
                <input 
                  type="number" 
                  class="w-full border rounded-md px-3 py-2 pl-8 text-sm bg-background" 
                  bind:value={discountFixed} 
                  placeholder="0" 
                  min="0"
                />
              </div>
              <p class="text-xs text-muted-foreground">Distributed proportionally by subtotal.</p>
            </div>
          {/if}

          <div class="space-y-1">
            <label class="text-sm font-medium">Tax %</label>
            <div class="relative">
              <input 
                type="number" 
                class="w-full border rounded-md px-3 py-2 pr-8 text-sm bg-background" 
                bind:value={taxPct} 
                placeholder="11" 
                min="0"
              />
              <span class="absolute right-3 top-2 text-sm text-muted-foreground">%</span>
            </div>
          </div>
        </div>

        <!-- Preview Table -->
        <div class="flex-1 border rounded-lg overflow-hidden flex flex-col bg-muted/10">
          <div class="bg-muted/30 px-4 py-2 border-b font-medium text-sm flex justify-between">
            <span>Preview Items ({selectedItems.length})</span>
            <span class="text-muted-foreground">Base Total: {totalBaseAmount.toLocaleString()}</span>
          </div>
          <div class="flex-1 overflow-y-auto">
            <table class="w-full text-sm">
              <thead class="border-b bg-muted/10 text-left text-muted-foreground sticky top-0 backdrop-blur-md">
                <tr>
                  <th class="px-4 py-2 font-medium">Item</th>
                  <th class="px-4 py-2 font-medium text-right">Qty</th>
                  <th class="px-4 py-2 font-medium text-right">Base Cost</th>
                  <th class="px-4 py-2 font-medium text-right">New Unit Cost</th>
                  <th class="px-4 py-2 font-medium text-right">New Subtotal</th>
                </tr>
              </thead>
              <tbody>
                {#each computedUpdates as u}
                  <tr class="border-b last:border-0 hover:bg-muted/30">
                    <td class="px-4 py-2 truncate max-w-[150px]">{u.description}</td>
                    <td class="px-4 py-2 text-right">{u.qtyOrdered}</td>
                    <td class="px-4 py-2 text-right text-muted-foreground">{u.baseCostMinor.toLocaleString()}</td>
                    <td class="px-4 py-2 text-right font-medium text-sky-600">{u.unitCostMinor.toLocaleString()}</td>
                    <td class="px-4 py-2 text-right font-semibold">{u.newSubtotal.toLocaleString()}</td>
                  </tr>
                {/each}
                {#if computedUpdates.length === 0}
                  <tr>
                    <td colspan="5" class="px-4 py-8 text-center text-muted-foreground">
                      No items selected.
                    </td>
                  </tr>
                {/if}
              </tbody>
            </table>
          </div>
          <div class="bg-muted/30 px-4 py-3 border-t font-semibold text-right flex justify-end items-center gap-4">
            <span class="text-sm text-muted-foreground">New Total:</span>
            <span class="text-lg text-primary">{newTotalAmount.toLocaleString()}</span>
          </div>
        </div>
      </div>

      <div class="flex shrink-0 items-center justify-end gap-3 border-t bg-muted/20 p-4">
        <Button variant="outline" disabled={busy} onclick={() => open = false}>Cancel</Button>
        <Button disabled={busy || selectedItems.length === 0} onclick={save}>
          {busy ? "Applying..." : "Apply Discount"}
        </Button>
      </div>
    </div>
  </div>
{/if}
