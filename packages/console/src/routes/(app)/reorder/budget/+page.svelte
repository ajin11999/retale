<script lang="ts">
  import { graphql } from "$houdini";
  import Button from "$lib/components/ui/button.svelte";
  import Badge from "$lib/components/ui/badge.svelte";

  const BudgetSandbox = graphql(`
    query ConsoleBudgetSandbox($budgetAmount: Float!) {
      reorderBudgetSandbox(budgetAmount: $budgetAmount) {
        totalEstimatedCost
        remainingBudget
        lines {
          variantId
          productName
          sku
          suggestedQty
          estimatedUnitCost
          estimatedTotalCost
          vendorName
          priorityScore
          status
        }
      }
    }
  `);

  let budget = $state<number>(1000);
  let busy = $state(false);
  
  async function generate() {
    if (budget <= 0) return;
    busy = true;
    await BudgetSandbox.fetch({ variables: { budgetAmount: budget }, policy: "NetworkOnly" });
    busy = false;
  }
  
  const plan = $derived($BudgetSandbox.data?.reorderBudgetSandbox);
  
  const formatMoney = (val: number) =>
    new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(val);
</script>

<svelte:head><title>Budget Sandbox · Retale</title></svelte:head>

<div class="mx-auto max-w-4xl space-y-6">
  <div class="flex items-center justify-between">
    <h1 class="text-xl font-semibold">Budgeted Priority Reorder Sandbox</h1>
    <a href="/reorder" class="text-sm text-muted-foreground hover:underline">Back to Review</a>
  </div>

  <div class="flex items-center gap-3 bg-card p-4 rounded-lg border shadow-sm">
    <label for="budget" class="font-medium text-sm">Available Budget:</label>
    <div class="relative">
      <span class="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground">$</span>
      <input
        id="budget"
        type="number"
        min="1"
        class="flex h-9 w-40 rounded-md border border-input bg-transparent pl-8 pr-3 py-1 text-sm shadow-sm transition-colors"
        bind:value={budget}
      />
    </div>
    <Button disabled={busy || budget <= 0} onclick={generate}>Generate Plan</Button>
  </div>

  {#if busy}
    <p class="text-sm text-muted-foreground">Calculating optimal order plan...</p>
  {:else if plan}
    <div class="grid grid-cols-2 gap-4">
      <div class="rounded-lg border bg-card p-4">
        <p class="text-sm text-muted-foreground mb-1">Total Estimated Cost</p>
        <p class="text-2xl font-bold">{formatMoney(plan.totalEstimatedCost)}</p>
      </div>
      <div class="rounded-lg border bg-card p-4">
        <p class="text-sm text-muted-foreground mb-1">Remaining Budget</p>
        <p class="text-2xl font-bold">{formatMoney(plan.remainingBudget)}</p>
      </div>
    </div>
    
    <div class="space-y-4">
      <h2 class="text-lg font-semibold">Suggested Orders ({plan.lines.length} items)</h2>
      
      {#if plan.lines.length === 0}
        <p class="text-sm text-muted-foreground">No items require reordering, or budget is too low.</p>
      {:else}
        <div class="rounded-lg border bg-card overflow-hidden shadow-sm">
          <table class="w-full text-sm">
            <thead class="border-b bg-muted/50 text-left">
              <tr>
                <th class="p-3 font-medium">Product</th>
                <th class="p-3 font-medium">Vendor</th>
                <th class="p-3 font-medium">Urgency</th>
                <th class="p-3 text-right font-medium">Qty</th>
                <th class="p-3 text-right font-medium">Unit Cost</th>
                <th class="p-3 text-right font-medium">Total Cost</th>
              </tr>
            </thead>
            <tbody>
              {#each plan.lines as line (line.variantId)}
                <tr class="border-b last:border-0 hover:bg-muted/50 transition-colors">
                  <td class="p-3">
                    <p class="font-medium">{line.productName}</p>
                    <p class="text-xs text-muted-foreground">{line.sku}</p>
                  </td>
                  <td class="p-3">{line.vendorName ?? "—"}</td>
                  <td class="p-3">
                    <Badge class={line.status === 'order_now' ? 'border border-red-200 text-red-700 bg-red-50' : line.status === 'order_soon' ? 'border border-amber-200 text-amber-700 bg-amber-50' : 'border border-emerald-200 text-emerald-700 bg-emerald-50'}>
                      {line.status.replace('_', ' ')}
                    </Badge>
                  </td>
                  <td class="p-3 text-right font-medium">{line.suggestedQty}</td>
                  <td class="p-3 text-right text-muted-foreground">{formatMoney(line.estimatedUnitCost)}</td>
                  <td class="p-3 text-right font-semibold">{formatMoney(line.estimatedTotalCost)}</td>
                </tr>
              {/each}
            </tbody>
          </table>
        </div>
      {/if}
    </div>
  {/if}
</div>
