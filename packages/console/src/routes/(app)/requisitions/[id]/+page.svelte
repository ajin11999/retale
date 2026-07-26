<script lang="ts">
  import { dndzone, type DndEvent } from "svelte-dnd-action";
  import { flip } from "svelte/animate";
  import { fly } from "svelte/transition";
  import { graphql } from "$houdini";
  import { goto } from "$app/navigation";
  import { page } from "$app/state";
  import Badge from "$lib/components/ui/badge.svelte";
  import Button from "$lib/components/ui/button.svelte";
  import Input from "$lib/components/ui/input.svelte";
  import NumericInput from "$lib/components/ui/numeric-input.svelte";
  import Combobox from "$lib/components/ui/combobox.svelte";
  import { AlertTriangle, Plus, Trash2, Printer, Check, X, GripVertical, Pencil } from "@lucide/svelte";
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

  const UpdateRequisition = graphql(`
    mutation ConsoleUpdateRequisition($id: ID!, $name: String, $status: RequisitionStatus) {
      updateRequisition(id: $id, name: $name, status: $status) {
        id
        name
        status
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

  const UpdateRequisitionItem = graphql(`
    mutation ConsoleUpdateRequisitionItem($id: ID!, $sectionId: ID, $variantId: ID, $description: String, $qtyRequested: Float) {
      updateRequisitionItem(id: $id, sectionId: $sectionId, variantId: $variantId, description: $description, qtyRequested: $qtyRequested) {
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

  const ReorderSections = graphql(`
    mutation ConsoleReorderRequisitionSections($requisitionId: ID!, $orderedIds: [ID!]!) {
      reorderRequisitionSections(requisitionId: $requisitionId, orderedIds: $orderedIds) {
        id
      }
    }
  `);

  const ReorderItems = graphql(`
    mutation ConsoleReorderRequisitionItems($requisitionId: ID!, $orderedIds: [ID!]!) {
      reorderRequisitionItems(requisitionId: $requisitionId, orderedIds: $orderedIds) {
        id
      }
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

  // Edit Metadata
  let editingRequisitionName = $state(false);
  let editedRequisitionName = $state("");
  
  // Edit Section
  let editingSectionId = $state<string | null>(null);
  let editedSectionName = $state("");

  type CellField = "qty" | "desc";
  let cellEdit = $state<{ id: string; field: CellField } | null>(null);
  let cellStr = $state("");
  let cellQty = $state<number>(0);

  function selectOnMount(node: HTMLInputElement) {
    node.focus();
    node.select();
  }

  function startCellEdit(item: any, field: CellField) {
    if (field === "qty") cellQty = item.qtyRequested;
    else cellStr = item.description || "";
    cellEdit = { id: item.id, field };
  }

  async function commitCell() {
    const c = cellEdit;
    if (!c || !requisition) return;
    const i = requisition.items.find((x: any) => x.id === c.id);
    if (!i) {
      cellEdit = null;
      return;
    }
    
    if (c.field === "qty") {
      if (cellQty <= 0) {
        cellEdit = null;
        return;
      }
      if (cellQty !== i.qtyRequested) {
        await UpdateRequisitionItem.mutate({ id: i.id, qtyRequested: cellQty });
        await refetch();
      }
    } else {
      const d = cellStr.trim();
      if ((d || null) !== (i.description || null)) {
        await UpdateRequisitionItem.mutate({ id: i.id, description: d || null });
        await refetch();
      }
    }
    cellEdit = null;
  }

  function cellKeydown(e: KeyboardEvent) {
    if (e.key === "Enter") {
      e.preventDefault();
      commitCell();
    } else if (e.key === "Escape") {
      e.preventDefault();
      cellEdit = null;
    }
  }

  // Multi-select state
  let selectedItemIds = $state<Set<string>>(new Set());

  const flipDurationMs = 200;

  async function refetch() {
    if (requisition) {
      await RequisitionDetail.fetch({ policy: 'NetworkOnly', variables: { id: requisition.id } });
      sectionOrder = null;
      itemOrders = {};
    }
  }

  // --- Header Actions ---
  async function saveRequisitionName() {
    const name = editedRequisitionName.trim();
    if (!requisition || !name) return;
    await UpdateRequisition.mutate({ id: requisition.id, name });
    editingRequisitionName = false;
    await refetch();
  }

  // PRs no longer use status workflows

  // --- Section Actions ---
  async function addSection() {
    const name = (newSectionName ?? "").trim();
    if (!requisition || !name) return;
    await CreateSection.mutate({ requisitionId: requisition.id, name });
    newSectionName = null;
    await refetch();
  }

  function startRenameSection(id: string, name: string) {
    editingSectionId = id;
    editedSectionName = name;
  }

  async function saveRenameSection() {
    const name = editedSectionName.trim();
    if (!editingSectionId || !name) return;
    await UpdateSection.mutate({ id: editingSectionId, name });
    editingSectionId = null;
    await refetch();
  }

  async function deleteSection(id: string) {
    if (!confirm("Remove this section? Items will be moved to unsectioned.")) return;
    await DeleteSection.mutate({ id });
    await refetch();
  }

  // --- Item Actions ---
  function openAddItem(sectionId: string = "") {
    newItemSection = sectionId === "unsectioned" ? "" : sectionId;
    newItemVariantId = "";
    newItemDescription = "";
    newItemQty = 1;
    showAddItem = true;
  }

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
      await refetch();
    } finally {
      adding = false;
    }
  }

  async function deleteItem(id: string) {
    await DeleteRequisitionItem.mutate({ id });
    selectedItemIds.delete(id);
    await refetch();
  }

  function toggleItemSelection(id: string) {
    if (selectedItemIds.has(id)) {
      selectedItemIds.delete(id);
    } else {
      selectedItemIds.add(id);
    }
    // trigger reactivity
    selectedItemIds = new Set(selectedItemIds);
  }

  async function moveSelectedToSection(sectionId: string | null) {
    if (selectedItemIds.size === 0) return;
    for (const id of selectedItemIds) {
      await UpdateRequisitionItem.mutate({ id, sectionId });
    }
    selectedItemIds.clear();
    await refetch();
  }

  async function deleteSelectedItems() {
    if (selectedItemIds.size === 0) return;
    if (!confirm(`Delete ${selectedItemIds.size} selected items?`)) return;
    for (const id of selectedItemIds) {
      await DeleteRequisitionItem.mutate({ id });
    }
    selectedItemIds.clear();
    await refetch();
  }

  // --- Computed Data ---
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

  let sectionOrder = $state<any[] | null>(null);
  let itemOrders = $state<Record<string, any[]>>({});

  const sections = $derived.by(() => {
    if (sectionOrder) return sectionOrder;
    return requisition?.sections ?? [];
  });

  const groupedItems = $derived.by(() => {
    if (!requisition) return { unsectioned: [] };
    const groups: Record<string, any[]> = { unsectioned: [] };
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
    
    const orderedGroups: Record<string, any[]> = {};
    for (const [key, items] of Object.entries(groups)) {
       orderedGroups[key] = itemOrders[key] || items;
    }
    return orderedGroups;
  });

  // --- Drag and Drop ---
  const dndSections = $derived([{ id: "unsectioned", name: "Items" }, ...sections]);

  function handleSectionConsider(e: CustomEvent<DndEvent>) {
    sectionOrder = e.detail.items.filter(x => x.id !== "unsectioned");
  }

  async function handleSectionFinalize(e: CustomEvent<DndEvent>) {
    sectionOrder = e.detail.items.filter(x => x.id !== "unsectioned");
    if (requisition) {
      await ReorderSections.mutate({ requisitionId: requisition.id, orderedIds: sectionOrder!.map(x => x.id) });
      await refetch();
    }
  }

  // Multi-select drag logic
  let draggedSelectedIds = new Set<string>();

  function handleItemConsider(sectionId: string, e: CustomEvent<DndEvent>) {
    itemOrders[sectionId] = e.detail.items;
  }

  let dndTimeout: any;
  async function handleItemFinalize(sectionId: string, e: CustomEvent<DndEvent>) {
    const draggedId = e.detail.info.id;

    if (selectedItemIds.has(draggedId) && selectedItemIds.size > 1) {
      // 1. Gather all selected items from all sections
      const allSelectedItems: any[] = [];
      for (const sec of [{id: "unsectioned"}, ...sections]) {
         const itemsForSec = itemOrders[sec.id] || groupedItems[sec.id] || [];
         for (const item of itemsForSec) {
            if (selectedItemIds.has(item.id) && !allSelectedItems.some(i => i.id === item.id)) {
               allSelectedItems.push(item);
            }
         }
      }
      
      // 2. Remove all selected items from all sections locally
      for (const sec of [{id: "unsectioned"}, ...sections]) {
         const currentList = itemOrders[sec.id] || groupedItems[sec.id] || [];
         itemOrders[sec.id] = currentList.filter((i: any) => !selectedItemIds.has(i.id));
      }
      
      // 3. Find the anchor to insert before
      const dropIdxInEvent = e.detail.items.findIndex(i => i.id === draggedId);
      const anchorItem = e.detail.items.slice(dropIdxInEvent + 1).find(i => !selectedItemIds.has(i.id));
      
      let insertIdx = itemOrders[sectionId].length;
      if (anchorItem) {
         insertIdx = itemOrders[sectionId].findIndex((i: any) => i.id === anchorItem.id);
         if (insertIdx === -1) insertIdx = itemOrders[sectionId].length;
      }
      
      // 4. Insert selected items
      itemOrders[sectionId].splice(insertIdx, 0, ...allSelectedItems);
      
      // 5. Update DB section for moved items
      const newSecId = sectionId === "unsectioned" ? null : sectionId;
      for (const item of allSelectedItems) {
         if ((item.sectionId || "unsectioned") !== sectionId) {
            UpdateRequisitionItem.mutate({ id: item.id, sectionId: newSecId });
            item.sectionId = newSecId;
         }
      }
    } else {
      itemOrders[sectionId] = e.detail.items;
      
      const movedItem = e.detail.items.find((i: any) => (i.sectionId || "unsectioned") !== sectionId);
      if (movedItem) {
         const newSecId = sectionId === "unsectioned" ? null : sectionId;
         UpdateRequisitionItem.mutate({
            id: movedItem.id,
            sectionId: newSecId
         });
         movedItem.sectionId = newSecId;
      }
    }

    clearTimeout(dndTimeout);
    dndTimeout = setTimeout(async () => {
      if (!requisition) return;
      const allItemIds = [];
      for (const sec of [{id: "unsectioned"}, ...sections]) {
         const itemsForSec = itemOrders[sec.id] || groupedItems[sec.id] || [];
         allItemIds.push(...itemsForSec.map((x: any) => x.id));
      }
      await ReorderItems.mutate({ requisitionId: requisition.id, orderedIds: allItemIds });
      await refetch();
    }, 50);
  }

</script>

<svelte:window
  onkeydown={(e) => {
    if (showAddItem && !adding) {
      if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
        e.preventDefault();
        saveItem();
      } else if (e.key === "Escape") {
        e.preventDefault();
        showAddItem = false;
      }
    }
  }}
/>

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
        
        {#if editingRequisitionName}
          <div class="flex items-center gap-1">
            <Input bind:value={editedRequisitionName} class="w-64 h-8" onkeydown={(e: any) => e.key === 'Enter' && saveRequisitionName()} autofocus />
            <Button size="icon" variant="ghost" class="h-8 w-8" onclick={saveRequisitionName}><Check class="h-4 w-4" /></Button>
            <Button size="icon" variant="ghost" class="h-8 w-8" onclick={() => editingRequisitionName = false}><X class="h-4 w-4" /></Button>
          </div>
        {:else}
          <!-- svelte-ignore a11y_click_events_have_key_events -->
          <!-- svelte-ignore a11y_no_static_element_interactions -->
          <div class="flex items-center gap-1 group cursor-pointer" onclick={() => { editingRequisitionName = true; editedRequisitionName = requisition.name; }}>
            <h1 class="text-xl font-semibold group-hover:text-primary">{requisition.name}</h1>
            <Pencil class="h-4 w-4 text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity" />
          </div>
        {/if}
      </div>
      <div class="flex items-center gap-2 print:hidden">
        <Button variant="outline" onclick={() => window.print()}>
          <Printer class="mr-2 h-4 w-4" /> Print
        </Button>
      </div>
    </div>

    <div class="space-y-4 max-w-5xl">
      <div class="flex items-center justify-between">
        <h2 class="text-lg font-semibold">Requested Items</h2>
        <div class="flex items-center gap-2 print:hidden">
          <Input type="search" placeholder="Search items..." bind:value={search} class="w-64" />
          {#if newSectionName !== null}
            <div class="flex items-center gap-2">
              <Input placeholder="Section name..." bind:value={newSectionName} class="w-40 h-9 text-sm" onkeydown={(e: any) => e.key === 'Enter' && addSection()} autofocus />
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

      {#if selectedItemIds.size > 0}
        <div class="fixed bottom-6 left-1/2 z-50 flex -translate-x-1/2 flex-wrap items-center gap-2 rounded-lg border border-primary/40 bg-card px-3 py-2 shadow-lg print:hidden" transition:fly={{ y: 12, duration: 150 }}>
          <span class="text-sm font-medium">{selectedItemIds.size} item{selectedItemIds.size === 1 ? '' : 's'} selected</span>
          
          <select class="flex h-9 w-48 rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm" onchange={(e) => {
             const val = e.currentTarget.value;
             e.currentTarget.value = "";
             if (val) moveSelectedToSection(val === "unsectioned" ? null : val);
          }}>
             <option value="" disabled selected>Move to section...</option>
             {#each sections as sec}
                <option value={sec.id}>{sec.name}</option>
             {/each}
             <option value="unsectioned">— No section —</option>
          </select>

          <Button variant="destructive" size="sm" onclick={deleteSelectedItems}>Delete selected</Button>
          <Button variant="ghost" size="sm" onclick={() => selectedItemIds.clear()}>Clear</Button>
        </div>
      {/if}

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
            <span class="mr-auto text-xs text-muted-foreground mt-2">
              <kbd class="rounded border px-1 font-mono">Ctrl</kbd>+<kbd class="rounded border px-1 font-mono">Enter</kbd> to save
            </span>
            <Button variant="ghost" size="sm" onclick={() => showAddItem = false}>Cancel</Button>
            <Button size="sm" onclick={saveItem} disabled={adding}>Save Item</Button>
          </div>
        </div>
      {/snippet}
      
      <div class="border rounded-lg bg-card">
        <div use:dndzone={{items: dndSections, dragDisabled: search !== "" || editingSectionId !== null || cellEdit !== null, flipDurationMs, dropTargetStyle: {}}} onconsider={handleSectionConsider} onfinalize={handleSectionFinalize}>
          {#each dndSections as section, idx (section.id)}
            <div animate:flip={{duration: flipDurationMs}}>
              {#if groupedItems[section.id] && (groupedItems[section.id].length > 0 || search === "")}
                {#if section.id !== "unsectioned" || requisition.sections.length > 0}
                  <div class="bg-muted/30 px-4 py-2 border-b {idx > 0 ? 'border-t' : ''} font-medium text-sm flex justify-between items-center group">
                    <div class="flex items-center gap-2">
                       <GripVertical class="h-4 w-4 text-muted-foreground opacity-50 cursor-grab active:cursor-grabbing hover:opacity-100 transition-opacity print:hidden" />
                       {#if editingSectionId === section.id}
                         <Input bind:value={editedSectionName} class="h-7 w-48 text-sm" onkeydown={(e: any) => e.key === 'Enter' && saveRenameSection()} autofocus />
                         <Button size="icon" variant="ghost" class="h-7 w-7" onclick={saveRenameSection}><Check class="h-3 w-3" /></Button>
                         <Button size="icon" variant="ghost" class="h-7 w-7" onclick={() => editingSectionId = null}><X class="h-3 w-3" /></Button>
                       {:else}
                         <!-- svelte-ignore a11y_click_events_have_key_events -->
                         <!-- svelte-ignore a11y_no_static_element_interactions -->
                         <span class="cursor-pointer hover:text-primary transition-colors" onclick={() => startRenameSection(section.id, section.name)}>{section.name}</span>
                       {/if}
                    </div>
                    {#if section.id !== "unsectioned"}
                      <Button variant="ghost" size="icon" class="h-6 w-6 opacity-0 group-hover:opacity-100 transition-opacity text-muted-foreground hover:text-destructive print:hidden" onclick={() => deleteSection(section.id)}>
                        <Trash2 class="h-3 w-3" />
                      </Button>
                    {/if}
                  </div>
                {/if}
                <table class="w-full text-sm">
                  <thead class="border-b text-left text-muted-foreground bg-muted/10">
                    <tr>
                      <th class="w-8 print:hidden"></th>
                      <th class="w-8 print:hidden"></th>
                      <th class="px-4 py-2 font-medium w-32">SKU</th>
                      <th class="px-4 py-2 font-medium">Product Name</th>
                      <th class="px-4 py-2 text-right font-medium">Requested</th>
                      <th class="px-4 py-2 text-right font-medium">Ordered</th>
                      <th class="px-4 py-2 text-right font-medium">Remaining</th>
                      <th class="w-12 print:hidden"></th>
                    </tr>
                  </thead>
                  <tbody use:dndzone={{items: groupedItems[section.id], dragDisabled: search !== "" || cellEdit !== null || editingSectionId !== null, flipDurationMs, dropTargetStyle: {}}} onconsider={(e) => handleItemConsider(section.id, e)} onfinalize={(e) => handleItemFinalize(section.id, e)}>
                    {#each groupedItems[section.id] as item (item.id)}
                      {@const remaining = item.qtyRequested - item.qtyOrdered}
                      <tr animate:flip={{duration: flipDurationMs}} class="border-b last:border-0 hover:bg-muted/40 group/row {selectedItemIds.has(item.id) ? 'bg-sky-50 hover:bg-sky-50' : ''}">
                        <td class="px-2 py-2 text-center print:hidden w-8">
                          <GripVertical class="h-4 w-4 text-muted-foreground opacity-30 cursor-grab active:cursor-grabbing hover:opacity-100 transition-opacity inline-block" />
                        </td>
                        <td class="px-2 py-2 text-center print:hidden w-8">
                          <input type="checkbox" checked={selectedItemIds.has(item.id)} onchange={() => toggleItemSelection(item.id)} class="h-4 w-4 rounded border-gray-300 text-primary focus:ring-primary" />
                        </td>
                        <td class="px-4 py-2 text-muted-foreground">{item.sku || "-"}</td>
                        <td class="px-4 py-2 font-medium">
                          {#if cellEdit?.id === item.id && cellEdit?.field === "desc"}
                            <input
                              bind:value={cellStr}
                              use:selectOnMount
                              onkeydown={cellKeydown}
                              onblur={commitCell}
                              class="h-7 w-full rounded-md border border-input bg-background px-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                            />
                          {:else if !item.variantId}
                            <button type="button" class="-mx-1 rounded px-1 text-left hover:bg-accent" title="Edit description" onclick={() => startCellEdit(item, "desc")}>{item.variantName}</button>
                          {:else}
                            {item.variantName}
                          {/if}
                        </td>
                        <td class="px-4 py-2 text-right tabular-nums">
                          {#if cellEdit?.id === item.id && cellEdit?.field === "qty"}
                            <NumericInput
                              bind:value={cellQty}
                              autofocus={true}
                              onkeydown={cellKeydown}
                              onblur={commitCell}
                              class="h-7 w-20 rounded-md border border-input bg-background px-2 text-right text-sm tabular-nums focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ml-auto"
                            />
                          {:else}
                            <button type="button" class="-mx-1 rounded px-1 hover:bg-accent" title="Edit quantity" onclick={() => startCellEdit(item, "qty")}>{item.qtyRequested}</button>
                          {/if}
                        </td>
                        <td class="px-4 py-2 text-right">{item.qtyOrdered}</td>
                        <td class="px-4 py-2 text-right font-semibold {remaining > 0 ? 'text-amber-600' : 'text-emerald-600'}">
                          {remaining}
                        </td>
                        <td class="px-4 py-2 text-right print:hidden">
                           <div class="flex items-center justify-end gap-1 opacity-0 group-hover/row:opacity-100 transition-opacity">
                             <Button variant="ghost" size="icon" class="h-6 w-6 text-muted-foreground hover:text-destructive" onclick={() => deleteItem(item.id)}>
                               <Trash2 class="h-4 w-4" />
                             </Button>
                           </div>
                        </td>
                      </tr>
                    {/each}
                    {#if groupedItems[section.id].length === 0}
                      <tr><td colspan="8" class="px-4 py-4 text-center text-muted-foreground text-xs">No items.</td></tr>
                    {/if}
                    {#if section.id !== "unsectioned" && !showAddItem}
                      <tr class="hover:bg-muted/40 group">
                        <td colspan="8" class="p-0">
                          <button class="w-full text-left px-4 py-2 text-xs font-medium text-muted-foreground group-hover:text-primary transition-colors" onclick={() => openAddItem(section.id)}>
                            + Add line to {section.name}
                          </button>
                        </td>
                      </tr>
                    {:else if showAddItem && (newItemSection || "unsectioned") === section.id}
                      <tr>
                        <td colspan="8" class="p-2 bg-muted/20">
                          {@render lineForm()}
                        </td>
                      </tr>
                    {/if}
                  </tbody>
                </table>
              {/if}
            </div>
          {/each}
        </div>
      </div>
    </div>
  </div>
{/if}
