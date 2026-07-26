<script lang="ts">
  import { graphql } from "$houdini";
  import { goto } from "$app/navigation";
  import { page } from "$app/state";
  import Badge from "$lib/components/ui/badge.svelte";
  import Button from "$lib/components/ui/button.svelte";
  import Input from "$lib/components/ui/input.svelte";
  import Combobox from "$lib/components/ui/combobox.svelte";
  import { AlertTriangle, Plus, Trash2, Printer } from "@lucide/svelte";
  import type { PageData } from "./$types";
  import { matchesTokens, searchTokens } from "$lib/utils";

  let { data } = $props<{ data: PageData }>();
  const RequisitionDetail = $derived(data.RequisitionDetail);
  const RequisitionEditorRefData = $derived(data.RequisitionEditorRefData);

  graphql(`
    query RequisitionDetail($id: ID!) {
      requisition(id: $id) {
        id
        name
        status
        sections {
          id
          name
          sortOrder
        }
        items {
          id
          sectionId
          variantId
          description
          qtyRequested
          qtyOrdered
          sortOrder
        }
      }
    }
  `);

  graphql(`
    query RequisitionEditorRefData {
      products(includeArchived: true) {
        id
        name
        kind
        variants {
          id
          sku
          label
        }
      }
    }
  `);

  const CreateRequisitionItem = graphql(`
    mutation ConsoleCreateRequisitionItem($requisitionId: ID!, $sectionId: ID, $variantId: ID, $description: String, $qtyRequested: Float!) {
      createRequisitionItem(requisitionId: $requisitionId, sectionId: $sectionId, variantId: $variantId, description: $description, qtyRequested: $qtyRequested) {
        id
      }
    }
  `);

  const DeleteRequisitionItem = graphql(`
    mutation ConsoleDeleteRequisitionItem($id: ID!) {
      deleteRequisitionItem(id: $id)
    }
  `);

  const CreateSection = graphql(`
    mutation ConsoleCreateRequisitionSection($requisitionId: ID!, $name: String!) {
      createRequisitionSection(requisitionId: $requisitionId, name: $name) {
        id
      }
    }
  `);

  const UpdateSection = graphql(`
    mutation ConsoleUpdateRequisitionSection($id: ID!, $name: String!) {
      updateRequisitionSection(id: $id, name: $name) {
        id
      }
    }
  `);

  const DeleteSection = graphql(`
    mutation ConsoleDeleteRequisitionSection($id: ID!) {
      deleteRequisitionSection(id: $id)
    }
  `);

  // State
  let search = $state("");
  let showAddItem = $state(false);
  
  let newItemVariantId = $state("");
  let newItemDescription = $state("");
  let newItemQty = $state(1);
  let newItemSection = $state("");

  let newSectionName = $state<string | null>(null);
  let adding = $state(false);

  async function addSection() {
    const name = (newSectionName ?? "").trim();
    if (!requisition || !name) return;
    await CreateSection.mutate({ requisitionId: requisition.id, name });
    newSectionName = null;
    await RequisitionDetail.fetch({ policy: 'NetworkOnly', variables: { id: requisition.id } });
  }

  function openAddItem(sectionId: string = "") {
    newItemSection = sectionId === "unsectioned" ? "" : sectionId;
    newItemVariantId = "";
    newItemDescription = "";
    newItemQty = 1;
    showAddItem = true;
  }

  const requisition = $derived($RequisitionDetail.data?.requisition);
  const products = $derived($RequisitionEditorRefData.data?.products ?? []);

  const variantOptions = $derived(
    products.flatMap((p: any) => p.variants.map((v: any) => ({
      value: v.id,
      label: p.kind === "simple" ? p.name : `${p.name} - ${v.label}`,
      sku: v.sku
    })))
  );

  const duplicateWarning = $derived(
    requisition?.items.some((i: any) => i.variantId === newItemVariantId) && newItemVariantId !== ""
  );

  const groupedItems = $derived.by(() => {
    if (!requisition) return { unsectioned: [] };
    const groups: Record<string, typeof requisition.items & { variantName?: string; sku?: string }[]> = { unsectioned: [] };
    for (const sec of requisition.sections) groups[sec.id] = [];
    
    const term = searchTokens(search);
    
    for (const item of requisition.items) {
      let variantName = item.description || "";
      let sku = "";
      if (item.variantId) {
        const vOpt = variantOptions.find((o: any) => o.value === item.variantId);
        if (vOpt) {
          variantName = vOpt.label;
          sku = vOpt.sku || "";
        }
      }

      if (term.length > 0 && !matchesTokens(term, variantName) && !matchesTokens(term, sku)) continue;
      
      const itemWithMeta = { ...item, variantName, sku };

      if (item.sectionId && groups[item.sectionId]) {
        groups[item.sectionId].push(itemWithMeta);
      } else {
        groups.unsectioned.push(itemWithMeta);
      }
    }
    return groups;
  });

  async function saveItem() {
    if (!requisition) return;
    if (newItemQty <= 0) return;
    if (!newItemVariantId && !newItemDescription.trim()) return;

    adding = true;
    try {
      await CreateRequisitionItem.mutate({
        requisitionId: requisition.id,
        sectionId: newItemSection || null,
        variantId: newItemVariantId || null,
        description: newItemDescription || null,
        qtyRequested: newItemQty
      });
      showAddItem = false;
      newItemVariantId = "";
      newItemDescription = "";
      newItemQty = 1;
      await RequisitionDetail.fetch({ policy: 'NetworkOnly', variables: { id: requisition.id } });
    } finally {
      adding = false;
    }
  }

  async function deleteItem(id: string) {
    if (!confirm("Remove this item?")) return;
    await DeleteRequisitionItem.mutate({ id });
    if (requisition) {
      await RequisitionDetail.fetch({ policy: 'NetworkOnly', variables: { id: requisition.id } });
    }
  }

  async function deleteSection(id: string) {
    if (!confirm("Remove this section? Items will be moved to unsectioned.")) return;
    await DeleteSection.mutate({ id });
    if (requisition) {
      await RequisitionDetail.fetch({ policy: 'NetworkOnly', variables: { id: requisition.id } });
    }
  }
</script>

<svelte:head>
  <title>{requisition?.name || "Loading..."} · Purchase Requisition</title>
</svelte:head>

{#if !requisition}
  <div class="p-8 text-center text-muted-foreground">Loading requisition...</div>
{:else}
  <div class="space-y-6">
    <div class="flex items-center justify-between">
      <div class="flex items-center gap-2">
        <a href="/requisitions" class="text-sm text-muted-foreground hover:underline">Requisitions</a>
        <span class="text-muted-foreground">/</span>
        <h1 class="text-xl font-semibold">{requisition.name}</h1>
        <Badge class="ml-2 bg-sky-100 text-sky-700">{requisition.status.replace('_', ' ')}</Badge>
      </div>
      <div class="flex items-center gap-2">
        <Button variant="outline" onclick={() => window.print()}>
          <Printer class="mr-2 h-4 w-4" /> Print
        </Button>
      </div>
    </div>

    <div class="space-y-4 max-w-5xl">
      <div class="flex items-center justify-between">
        <h2 class="text-lg font-semibold">Requested Items</h2>
        <div class="flex items-center gap-2">
          <Input type="search" placeholder="Search items..." bind:value={search} class="w-64" />
          {#if newSectionName !== null}
            <div class="flex items-center gap-2">
              <Input placeholder="Section name..." bind:value={newSectionName} class="w-40 h-9 text-sm" onkeydown={(e) => e.key === 'Enter' && addSection()} autofocus />
              <Button size="sm" onclick={addSection}>Save</Button>
              <Button size="sm" variant="ghost" onclick={() => newSectionName = null}>Cancel</Button>
            </div>
          {:else}
            <Button variant="outline" size="sm" onclick={() => newSectionName = ""}>
              Add section
            </Button>
            <Button variant="outline" size="sm" onclick={() => openAddItem("")}>
              <Plus class="mr-1 h-4 w-4" /> Add line
            </Button>
          {/if}
        </div>
      </div>

      {#snippet lineForm()}
        <div class="bg-card border rounded-lg p-4 space-y-4">
          <h3 class="text-sm font-medium">Add New Item</h3>
          <div class="flex gap-4">
            <div class="flex-1 space-y-1">
              <label class="text-xs text-muted-foreground" for="variant-select">Variant</label>
              <Combobox id="variant-select" options={variantOptions} bind:value={newItemVariantId} placeholder="Search variant..." />
            </div>
            {#if !newItemVariantId}
              <div class="flex-1 space-y-1">
                <label class="text-xs text-muted-foreground" for="desc-input">Description (Non-stock)</label>
                <Input id="desc-input" placeholder="Describe item..." bind:value={newItemDescription} />
              </div>
            {/if}
            <div class="w-24 space-y-1">
              <label class="text-xs text-muted-foreground" for="qty-input">Qty</label>
              <Input id="qty-input" type="number" bind:value={newItemQty} min="1" />
            </div>
            <div class="w-48 space-y-1">
              <label class="text-xs text-muted-foreground" for="sec-select">Section</label>
              <select id="sec-select" class="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm transition-colors file:border-0 file:bg-transparent file:text-sm file:font-medium placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50" bind:value={newItemSection}>
                <option value="">No Section</option>
                {#each requisition.sections as sec}
                  <option value={sec.id}>{sec.name}</option>
                {/each}
              </select>
            </div>
          </div>
          
          {#if duplicateWarning}
            <div class="flex items-center gap-2 text-sm text-amber-600 bg-amber-50 p-2 rounded-md">
              <AlertTriangle class="h-4 w-4" />
              <span>This variant is already on the requisition!</span>
            </div>
          {/if}

          <div class="flex justify-end gap-2">
            <Button variant="ghost" size="sm" onclick={() => showAddItem = false}>Cancel</Button>
            <Button size="sm" onclick={saveItem} disabled={adding}>Save Item</Button>
          </div>
        </div>
      {/snippet}

      <div class="border rounded-lg bg-card overflow-hidden">
        {#each [{ id: "unsectioned", name: "Items" }, ...requisition.sections] as section}
          {#if groupedItems[section.id] && (groupedItems[section.id].length > 0 || search === "")}
            {#if section.id !== "unsectioned" || requisition.sections.length > 0}
              <div class="bg-muted/30 px-4 py-2 border-b font-medium text-sm flex justify-between items-center group">
                {section.name}
                {#if section.id !== "unsectioned"}
                  <Button variant="ghost" size="icon" class="h-6 w-6 opacity-0 group-hover:opacity-100 transition-opacity text-muted-foreground hover:text-destructive" onclick={() => deleteSection(section.id)}>
                    <Trash2 class="h-3 w-3" />
                  </Button>
                {/if}
              </div>
            {/if}
            <table class="w-full text-sm">
              <thead class="border-b text-left text-muted-foreground bg-muted/10">
                <tr>
                  <th class="px-4 py-2 font-medium w-32">SKU</th>
                  <th class="px-4 py-2 font-medium">Product Name</th>
                  <th class="px-4 py-2 text-right font-medium">Requested</th>
                  <th class="px-4 py-2 text-right font-medium">Ordered</th>
                  <th class="px-4 py-2 text-right font-medium">Remaining</th>
                  <th class="w-10"></th>
                </tr>
              </thead>
              <tbody>
                {#each groupedItems[section.id] as item}
                  {@const remaining = item.qtyRequested - item.qtyOrdered}
                  <tr class="border-b last:border-0 hover:bg-muted/40">
                    <td class="px-4 py-2 text-muted-foreground">{item.sku || "-"}</td>
                    <td class="px-4 py-2 font-medium">{item.variantName}</td>
                    <td class="px-4 py-2 text-right">{item.qtyRequested}</td>
                    <td class="px-4 py-2 text-right">{item.qtyOrdered}</td>
                    <td class="px-4 py-2 text-right font-semibold {remaining > 0 ? 'text-amber-600' : 'text-emerald-600'}">
                      {remaining}
                    </td>
                    <td class="px-4 py-2 text-right">
                       <Button variant="ghost" size="icon" class="h-6 w-6 text-muted-foreground hover:text-destructive" onclick={() => deleteItem(item.id)}>
                         <Trash2 class="h-4 w-4" />
                       </Button>
                    </td>
                  </tr>
                {/each}
                {#if groupedItems[section.id].length === 0}
                  <tr><td colspan="6" class="px-4 py-4 text-center text-muted-foreground text-xs">No items.</td></tr>
                {/if}
                {#if section.id !== "unsectioned" && !showAddItem}
                  <tr class="hover:bg-muted/40 group">
                    <td colspan="6" class="p-0">
                      <button class="w-full text-left px-4 py-2 text-xs font-medium text-muted-foreground group-hover:text-primary transition-colors" onclick={() => openAddItem(section.id)}>
                        + Add line to {section.name}
                      </button>
                    </td>
                  </tr>
                {:else if showAddItem && (newItemSection || "unsectioned") === section.id}
                  <tr>
                    <td colspan="6" class="p-2 bg-muted/20">
                      {@render lineForm()}
                    </td>
                  </tr>
                {/if}
              </tbody>
            </table>
          {/if}
        {/each}
      </div>
    </div>
  </div>
{/if}
