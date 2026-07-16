<script lang="ts">
  import { CachePolicy, graphql } from "$houdini";
  import Button from "$lib/components/ui/button.svelte";
  import Badge from "$lib/components/ui/badge.svelte";
  import MoneyInput from "$lib/components/ui/money-input.svelte";
  import Combobox from "$lib/components/ui/combobox.svelte";
  import Input from "$lib/components/ui/input.svelte";
  import { searchTokens, matchesTokens } from "$lib/utils";

  const BudgetSandbox = graphql(`
    query ConsoleBudgetSandbox($budgetAmount: Float!) {
      reorderBudgetSandbox(budgetAmount: $budgetAmount) {
        totalEstimatedCost
        remainingBudget
        lines {
          suggestionId
          variantId
          productName
          sku
          suggestedQty
          estimatedUnitCost
          estimatedTotalCost
          vendorId
          vendorName
          priorityScore
          status
        }
      }
    }
  `);

  const OpenPurchasesQuery = graphql(`
    query BudgetSandboxOpenPurchases {
      purchases(status: open) {
        id
        vendor {
          name
        }
        snapshotVendorName
        date
      }
    }
  `);

  const ConvertSuggestions = graphql(`
    mutation ConsoleBudgetConvertReorderSuggestions($lines: [ConvertReorderLineInput!]!) {
      convertReorderSuggestions(lines: $lines) {
        id
      }
    }
  `);

  const AddReorderToPurchase = graphql(`
    mutation ConsoleBudgetAddReorderSuggestionsToPurchase(
      $purchaseId: ID!
      $lines: [AddReorderLineInput!]!
    ) {
      addReorderSuggestionsToPurchase(purchaseId: $purchaseId, lines: $lines) {
        id
      }
    }
  `);

  let budget = $state<number | null>(1000);
  let busy = $state(false);
  let feedback = $state<{ ok: boolean; text: string } | null>(null);
  
  async function generate() {
    if (!budget || budget <= 0) return;
    busy = true;
    feedback = null;
    try {
      await BudgetSandbox.fetch({ variables: { budgetAmount: budget }, policy: "NetworkOnly" });
      await OpenPurchasesQuery.fetch({ policy: CachePolicy.NetworkOnly });
    } finally {
      busy = false;
    }
  }
  
  const plan = $derived($BudgetSandbox.data?.reorderBudgetSandbox);
  const openPurchases = $derived($OpenPurchasesQuery.data?.purchases ?? []);
  
  const formatNumber = (val: number) =>
    new Intl.NumberFormat("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(val);

  let selected = $state<Record<string, boolean>>({});
  
  let syncedKey = $state("");
  $effect(() => {
    if (!plan) return;
    const key = plan.lines.map(l => l.suggestionId).join(",");
    if (key === syncedKey) return;
    syncedKey = key;
    const next: Record<string, boolean> = {};
    for (const l of plan.lines) {
      next[l.suggestionId] = true;
    }
    selected = next;
  });

  let searchInputText = $state("");
  let search = $state("");
  let debounceTimer: ReturnType<typeof setTimeout> | undefined;

  function onSearchInput(value: string) {
    searchInputText = value;
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      search = value.trim();
    }, 500);
  }

  const allRows = $derived.by(() => {
    if (!plan) return [];
    return plan.lines.map(l => ({
      ...l,
      haystack: `${l.productName} ${l.sku} ${l.vendorName || ""} ${l.status.replace('_', ' ')}`.toLowerCase()
    }));
  });

  const displayRows = $derived.by(() => {
    let base = allRows;
    const tokens = searchTokens(search);
    if (!tokens.length) return base;
    return base.filter((r) => matchesTokens(tokens, r.haystack));
  });

  const selectedLines = $derived(plan?.lines.filter(l => selected[l.suggestionId]) ?? []);
  const displaySelectedLines = $derived(displayRows.filter(l => selected[l.suggestionId]));
  const allSelected = $derived(displayRows.length > 0 && displaySelectedLines.length === displayRows.length);
  
  function toggleAll() {
    if (!plan) return;
    const next = !allSelected;
    for (const l of displayRows) {
      selected[l.suggestionId] = next;
    }
  }

  let selectedPurchaseId = $state<string>("");
  const purchaseOptions = $derived([
    { value: "", label: "— Create New Purchases —" },
    ...openPurchases.map((p) => ({ value: p.id, label: `${p.snapshotVendorName ?? p.vendor?.name} (${new Date(p.date).toLocaleDateString()})` })),
  ]);

  const unassignedSelected = $derived(!selectedPurchaseId && selectedLines.some(l => !l.vendorId));

  async function convertSelected() {
    if (selectedLines.length === 0) return;
    busy = true;
    feedback = null;
    try {
      if (selectedPurchaseId) {
        const payload = selectedLines.map(l => ({ suggestionId: l.suggestionId, qty: l.suggestedQty }));
        const res = await AddReorderToPurchase.mutate({ purchaseId: selectedPurchaseId, lines: payload });
        if (res.errors?.length) {
          feedback = { ok: false, text: res.errors[0].message };
          return;
        }
        feedback = { ok: true, text: `Appended ${selectedLines.length} items to purchase.` };
      } else {
        const payload = selectedLines.map(l => ({ suggestionId: l.suggestionId, qty: l.suggestedQty, vendorId: l.vendorId }));
        const res = await ConvertSuggestions.mutate({ lines: payload });
        if (res.errors?.length) {
          feedback = { ok: false, text: res.errors[0].message };
          return;
        }
        feedback = { ok: true, text: `Created ${res.data?.convertReorderSuggestions.length ?? 0} draft purchase(s).` };
      }
      await generate();
    } catch (e) {
      feedback = { ok: false, text: e instanceof Error ? e.message : String(e) };
    } finally {
      busy = false;
    }
  }
</script>

<svelte:head><title>Budget Sandbox · Retale</title></svelte:head>

<div class="mx-auto max-w-4xl space-y-6">
  <div class="flex items-center justify-between">
    <h1 class="text-xl font-semibold">Budgeted Priority Reorder Sandbox</h1>
    <a href="/reorder" class="text-sm text-muted-foreground hover:underline">Back to Review</a>
  </div>

  <div class="flex items-center gap-3 bg-card p-4 rounded-lg border shadow-sm">
    <label for="budget" class="font-medium text-sm">Available Budget:</label>
    <div class="relative w-40">
      <MoneyInput
        id="budget"
        class="w-full"
        bind:value={budget}
      />
    </div>
    <Button disabled={busy || !budget || budget <= 0} onclick={generate}>Generate Plan</Button>
  </div>

  {#if feedback}
    <div class="rounded-md border p-4 {feedback.ok ? 'bg-emerald-50 border-emerald-200 text-emerald-800' : 'bg-red-50 border-red-200 text-red-800'}">
      {feedback.text}
    </div>
  {/if}

  {#if busy}
    <p class="text-sm text-muted-foreground">Calculating optimal order plan...</p>
  {:else if plan}
    <div class="grid grid-cols-2 gap-4">
      <div class="rounded-lg border bg-card p-4">
        <p class="text-sm text-muted-foreground mb-1">Total Estimated Cost</p>
        <p class="text-2xl font-bold">{formatNumber(plan.totalEstimatedCost)}</p>
      </div>
      <div class="rounded-lg border bg-card p-4">
        <p class="text-sm text-muted-foreground mb-1">Remaining Budget</p>
        <p class="text-2xl font-bold">{formatNumber(plan.remainingBudget)}</p>
      </div>
    </div>
    
    <div class="space-y-4">
      <div class="flex items-center justify-between">
        <h2 class="text-lg font-semibold">Suggested Orders ({plan.lines.length} items)</h2>
        <div class="w-72">
          <Input 
            placeholder="Search orders..." 
            value={searchInputText}
            oninput={(e) => onSearchInput(e.currentTarget.value)}
          />
        </div>
      </div>
      
      {#if plan.lines.length === 0}
        <p class="text-sm text-muted-foreground">No items require reordering, or budget is too low.</p>
      {:else}
        <div class="rounded-lg border bg-card overflow-hidden shadow-sm">
          <table class="w-full text-sm">
            <thead class="border-b bg-muted/50 text-left">
              <tr>
                <th class="p-3 w-10">
                  <input type="checkbox" class="h-4 w-4 rounded border-gray-300" checked={allSelected} onchange={toggleAll} />
                </th>
                <th class="p-3 font-medium">Product</th>
                <th class="p-3 font-medium">Vendor</th>
                <th class="p-3 font-medium">Urgency</th>
                <th class="p-3 text-right font-medium">Qty</th>
                <th class="p-3 text-right font-medium">Unit Cost</th>
                <th class="p-3 text-right font-medium">Total Cost</th>
              </tr>
            </thead>
            <tbody>
              {#each displayRows as line (line.suggestionId)}
                <tr class="border-b last:border-0 hover:bg-muted/50 transition-colors {selected[line.suggestionId] ? 'bg-muted/20' : ''}">
                  <td class="p-3">
                    <input type="checkbox" class="h-4 w-4 rounded border-gray-300" bind:checked={selected[line.suggestionId]} />
                  </td>
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
                  <td class="p-3 text-right text-muted-foreground">{formatNumber(line.estimatedUnitCost)}</td>
                  <td class="p-3 text-right font-semibold">{formatNumber(line.estimatedTotalCost)}</td>
                </tr>
              {/each}
            </tbody>
          </table>
        </div>

        {#if selectedLines.length > 0}
          <div class="flex items-center justify-between mt-4">
            <p class="text-sm text-muted-foreground">
              {selectedLines.length} selected
              {#if unassignedSelected}
                · <span class="text-destructive">Cannot create new purchase for unassigned lines</span>
              {/if}
            </p>
            <div class="flex items-center gap-3">
              <Combobox
                options={purchaseOptions}
                bind:value={selectedPurchaseId}
                placeholder="Target Purchase..."
                class="w-64"
                disabled={busy}
              />
              <Button
                size="sm"
                disabled={busy || selectedLines.length === 0 || unassignedSelected}
                onclick={convertSelected}
              >
                {selectedPurchaseId ? 'Add to Purchase' : 'Convert to draft purchases'}
              </Button>
            </div>
          </div>
        {/if}
      {/if}
    </div>
  {/if}
</div>
