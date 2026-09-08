<script lang="ts">
  import { dndzone, type DndEvent } from "svelte-dnd-action";
  import { flip } from "svelte/animate";
  import { fly } from "svelte/transition";
  import { graphql } from "$houdini";
  import Button from "$lib/components/ui/button.svelte";
  import Input from "$lib/components/ui/input.svelte";
  import NumericInput from "$lib/components/ui/numeric-input.svelte";
  import Combobox from "$lib/components/ui/combobox.svelte";
  import Badge from "$lib/components/ui/badge.svelte";
  import {
    AlertTriangle,
    Plus,
    Trash2,
    Printer,
    Check,
    X,
    GripVertical,
    Pencil,
    Layers,
    Search
  } from "@lucide/svelte";
  import type { PageData } from "./$types";
  import { matchesTokens, searchTokens } from "$lib/utils";
  import { t } from "$lib/i18n";

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
          totalQty
          reorderPoint
        }
      }
    }
  `);

  const ReorderSuggestionsQuery = graphql(`
    query RequisitionReorderSuggestions {
      reorderSuggestions(status: open) {
        id
        variantId
        productName
        sku
        vendorId
        vendorName
        currentStock
        reorderPoint
        suggestedQty
      }
    }
  `);

  const AddReorderSuggestionsToRequisition = graphql(`
    mutation ConsoleRequisitionAddReorderSuggestions($requisitionId: ID!, $lines: [AddReorderLineInput!]!) {
      addReorderSuggestionsToRequisition(requisitionId: $requisitionId, lines: $lines) {
        id
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

  // --- State ---
  let search = $state("");
  let showAddItem = $state(false);

  let newItemVariantId = $state("");
  let newItemDescription = $state("");
  let newItemQty = $state(1);
  let newItemSection = $state("");

  let newSectionName = $state<string | null>(null);
  let newSectionAnchorId = $state<string | null>(null);
  let adding = $state(false);

  // Edit Metadata
  let editingRequisitionName = $state(false);
  let editedRequisitionName = $state("");

  // Edit Section
  let editingSectionId = $state<string | null>(null);
  let editedSectionName = $state("");

  // Bulk Add Modal State
  interface BulkPick {
    selected: boolean;
    qty: number;
  }

  let bulkOpen = $state(false);
  let bulkTab = $state<"reorder" | "stock">("reorder");
  let stockSearch = $state("");
  let reorderPicks = $state<Record<string, BulkPick>>({});
  let stockPicks = $state<Record<string, BulkPick>>({});

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

  // --- Section Actions ---
  function startAddSection(anchorId: string | null = null) {
    showAddItem = false;
    newSectionAnchorId = anchorId;
    newSectionName = "";
  }

  function cancelAddSection() {
    newSectionName = null;
    newSectionAnchorId = null;
  }

  async function addSection() {
    const name = (newSectionName ?? "").trim();
    if (!requisition || !name || adding) return;
    const anchorId = newSectionAnchorId;
    adding = true;
    try {
      const res = await CreateSection.mutate({ requisitionId: requisition.id, name });
      const newId = res.data?.createRequisitionSection?.id;
      if (newId && anchorId) {
        const currentIds = sections.map((s: any) => s.id).filter((id: string) => id !== newId);
        const idx = currentIds.indexOf(anchorId);
        const orderedIds = idx === -1
          ? [...currentIds, newId]
          : [...currentIds.slice(0, idx + 1), newId, ...currentIds.slice(idx + 1)];
        await ReorderSections.mutate({ requisitionId: requisition.id, orderedIds });
      }
      newSectionName = null;
      newSectionAnchorId = null;
      await refetch();
    } finally {
      adding = false;
    }
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
    if (!confirm(t("requisitions.confirmDeleteSection"))) return;
    await DeleteSection.mutate({ id });
    await refetch();
  }

  // --- Item Actions ---
  function openAddItem(sectionId: string = "") {
    cancelAddSection();
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
      // Keep form open for continuous additions
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
    if (!confirm(t("requisitions.confirmDeleteItems", { count: selectedItemIds.size }))) return;
    for (const id of selectedItemIds) {
      await DeleteRequisitionItem.mutate({ id });
    }
    selectedItemIds.clear();
    await refetch();
  }

  // --- Computed Data ---
  const requisition = $derived($RequisitionDetail.data?.requisition);
  const products = $derived($RequisitionEditorRefData.data?.products ?? []);
  const suggestions = $derived($ReorderSuggestionsQuery.data?.reorderSuggestions ?? []);

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

  interface StockRow {
    variantId: string;
    label: string;
    sku: string;
    totalQty: number;
    reorderPoint: number | null;
  }

  const stockRows = $derived.by<StockRow[]>(() => {
    const term = searchTokens(stockSearch);
    const rows: StockRow[] = [];
    for (const p of products) {
      for (const v of p.variants) {
        const label = p.kind === "simple" ? p.name : `${p.name} - ${v.label}`;
        const sku = v.sku || "";
        if (term.length > 0 && !matchesTokens(term, label) && !matchesTokens(term, sku)) {
          continue;
        }
        rows.push({
          variantId: v.id,
          label,
          sku,
          totalQty: v.totalQty ?? 0,
          reorderPoint: v.reorderPoint ?? null
        });
      }
    }
    rows.sort((a, b) => a.totalQty - b.totalQty);
    return rows;
  });

  const reorderRows = $derived(suggestions);

  const stockDefaultQty = (r: StockRow) =>
    r.reorderPoint != null ? Math.max(1, r.reorderPoint - r.totalQty) : 1;

  async function openBulk() {
    bulkOpen = true;
    bulkTab = "reorder";
    stockSearch = "";

    const sp: Record<string, BulkPick> = {};
    for (const r of stockRows) {
      sp[r.variantId] = {
        selected: false,
        qty: stockDefaultQty(r)
      };
    }
    stockPicks = sp;

    await ReorderSuggestionsQuery.fetch({ policy: "NetworkOnly" });
    const picks: Record<string, BulkPick> = {};
    for (const s of suggestions) {
      picks[s.id] = { selected: false, qty: s.suggestedQty };
    }
    reorderPicks = picks;
  }

  function closeBulk() {
    bulkOpen = false;
  }

  const reorderSelectedCount = $derived(
    Object.values(reorderPicks).filter((p) => p.selected).length
  );
  const stockSelectedCount = $derived(
    Object.values(stockPicks).filter((p) => p.selected).length
  );

  const STOCK_CAP = 60;
  const stockVisible = $derived(stockRows.slice(0, STOCK_CAP));
  const stockTruncated = $derived(stockRows.length > STOCK_CAP);

  const tabClass = (t: "reorder" | "stock") =>
    bulkTab === t
      ? "border-b-2 border-primary px-4 py-2.5 text-sm font-semibold text-primary"
      : "border-b-2 border-transparent px-4 py-2.5 text-sm text-muted-foreground hover:text-foreground";

  async function addReorderSelected() {
    if (!requisition) return;
    const lines = Object.entries(reorderPicks)
      .filter(([, p]) => p.selected && p.qty > 0)
      .map(([suggestionId, p]) => ({
        suggestionId,
        qty: Math.round(p.qty)
      }));
    if (lines.length === 0) return;
    adding = true;
    try {
      await AddReorderSuggestionsToRequisition.mutate({
        requisitionId: requisition.id,
        lines
      });
      closeBulk();
      await refetch();
    } finally {
      adding = false;
    }
  }

  async function addStockSelected() {
    if (!requisition) return;
    const selectedEntries = Object.entries(stockPicks).filter(([, p]) => p.selected && p.qty > 0);
    if (selectedEntries.length === 0) return;

    adding = true;
    try {
      for (const [variantId, p] of selectedEntries) {
        await CreateRequisitionItem.mutate({
          requisitionId: requisition.id,
          sectionId: newItemSection || null,
          variantId,
          description: null,
          qtyRequested: p.qty
        });
      }
      closeBulk();
      await refetch();
    } finally {
      adding = false;
    }
  }

  let sectionOrder = $state.raw<any[] | null>(null);
  let itemOrders = $state.raw<Record<string, any[]>>({});

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
  const unsectionedGroup = $derived({ id: "unsectioned", name: t("common.items") });
  const dndSections = $derived(sectionOrder || [unsectionedGroup, ...sections]);

  function handleSectionConsider(e: CustomEvent<DndEvent>) {
    sectionOrder = e.detail.items;
  }

  async function handleSectionFinalize(e: CustomEvent<DndEvent>) {
    sectionOrder = e.detail.items;
    if (requisition) {
      const orderedIds = e.detail.items.map(x => x.id).filter(id => id !== "unsectioned");
      await ReorderSections.mutate({ requisitionId: requisition.id, orderedIds });
      await refetch();
    }
  }

  // Multi-select drag logic
  function handleItemConsider(sectionId: string, e: CustomEvent<DndEvent>) {
    itemOrders = { ...itemOrders, [sectionId]: e.detail.items };
  }

  let dndTimeout: any;
  async function handleItemFinalize(sectionId: string, e: CustomEvent<DndEvent>) {
    const draggedId = e.detail.info.id;

    if (selectedItemIds.has(draggedId) && selectedItemIds.size > 1) {
      const allSelectedItems: any[] = [];
      for (const sec of [{id: "unsectioned"}, ...sections]) {
         const itemsForSec = itemOrders[sec.id] || groupedItems[sec.id] || [];
         for (const item of itemsForSec) {
            if (selectedItemIds.has(item.id) && !allSelectedItems.some(i => i.id === item.id)) {
               allSelectedItems.push(item);
            }
         }
      }

      let nextOrders = { ...itemOrders };
      for (const sec of [{id: "unsectioned"}, ...sections]) {
         const currentList = nextOrders[sec.id] || groupedItems[sec.id] || [];
         nextOrders[sec.id] = currentList.filter((i: any) => !selectedItemIds.has(i.id));
      }

      const dropIdxInEvent = e.detail.items.findIndex(i => i.id === draggedId);
      const anchorItem = e.detail.items.slice(dropIdxInEvent + 1).find(i => !selectedItemIds.has(i.id));

      const targetList = [...(nextOrders[sectionId] || groupedItems[sectionId] || [])];
      const cleanedTargetList = targetList.filter(i => !selectedItemIds.has(i.id));
      const insertIdx = anchorItem ? cleanedTargetList.findIndex(i => i.id === anchorItem.id) : cleanedTargetList.length;

      if (insertIdx === -1) {
         cleanedTargetList.push(...allSelectedItems);
      } else {
         cleanedTargetList.splice(insertIdx, 0, ...allSelectedItems);
      }

      nextOrders[sectionId] = cleanedTargetList;
      itemOrders = nextOrders;

      const newSecId = sectionId === "unsectioned" ? null : sectionId;
      for (const item of allSelectedItems) {
         if ((item.sectionId || "unsectioned") !== sectionId) {
            UpdateRequisitionItem.mutate({ id: item.id, sectionId: newSecId });
            item.sectionId = newSecId;
         }
      }
    } else {
      itemOrders = { ...itemOrders, [sectionId]: e.detail.items };

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
    if (bulkOpen) {
      if (e.key === "Escape") {
        e.preventDefault();
        closeBulk();
      }
      return;
    }
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
  <title>{requisition?.name || t("common.loading")} · {t("requisitions.title")}</title>
</svelte:head>

{#if !requisition}
  <div class="p-8 text-center text-muted-foreground">{t("common.loading")}</div>
{:else}
  <div class="space-y-6">
    <div class="flex items-center justify-between">
      <div class="flex items-center gap-2">
        <a href="/requisitions" class="text-sm text-muted-foreground hover:underline">{t("requisitions.title")}</a>
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
          <div class="flex items-center gap-1.5 group cursor-pointer" onclick={() => { editingRequisitionName = true; editedRequisitionName = requisition.name; }}>
            <h1 class="text-xl font-semibold group-hover:text-primary">{requisition.name}</h1>
            <Pencil class="h-4 w-4 text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity" />
          </div>
        {/if}
      </div>
      <div class="flex items-center gap-2 print:hidden">
        <Button variant="outline" size="sm" onclick={() => window.print()}>
          <Printer class="mr-1.5 h-4 w-4" /> {t("common.print")}
        </Button>
      </div>
    </div>

    <div class="space-y-4 max-w-5xl">
      <div class="flex flex-wrap items-center justify-between gap-3">
        <div class="flex items-center gap-2">
          <h2 class="text-lg font-semibold">{t("requisitions.requestedItems")}</h2>
          <Badge class="font-normal text-xs bg-secondary text-secondary-foreground">
            {t("requisitions.lines", { count: requisition.items.length })}
          </Badge>
        </div>

        <div class="flex items-center gap-2 print:hidden">
          <Input type="search" placeholder={t("requisitions.searchItems")} bind:value={search} class="w-56 h-9" />
          {#if newSectionName !== null && newSectionAnchorId === null}
            <div class="flex items-center gap-2">
              <Input placeholder={t("requisitions.sectionName")} bind:value={newSectionName} class="w-40 h-9 text-sm" onkeydown={(e: any) => { if (e.key === 'Enter') addSection(); else if (e.key === 'Escape') cancelAddSection(); }} autofocus />
              <Button size="sm" onclick={addSection} disabled={adding || !newSectionName.trim()}>{t("common.save")}</Button>
              <Button size="sm" variant="ghost" onclick={cancelAddSection}>{t("common.cancel")}</Button>
            </div>
          {:else}
            <Button variant="outline" size="sm" onclick={() => startAddSection(null)}>
              {t("requisitions.addSection")}
            </Button>
            <Button variant="outline" size="sm" onclick={openBulk}>
              <Layers class="mr-1.5 h-4 w-4" /> {t("requisitions.addMultiple")}
            </Button>
            <Button variant="default" size="sm" onclick={() => openAddItem("")}>
              <Plus class="mr-1 h-4 w-4" /> {t("requisitions.addLine")}
            </Button>
          {/if}
        </div>
      </div>

      {#if selectedItemIds.size > 0}
        <div class="fixed bottom-6 left-1/2 z-50 flex -translate-x-1/2 flex-wrap items-center gap-2.5 rounded-xl border border-primary/30 bg-card/95 px-4 py-2.5 shadow-2xl backdrop-blur-sm print:hidden" transition:fly={{ y: 12, duration: 150 }}>
          <span class="text-xs font-semibold text-foreground">{t("requisitions.itemsSelected", { count: selectedItemIds.size })}</span>

          <div class="h-4 w-px bg-border"></div>

          <select class="flex h-8 w-44 rounded-md border border-input bg-background px-2.5 py-1 text-xs shadow-xs focus:outline-none focus:ring-1 focus:ring-primary" onchange={(e) => {
             const val = e.currentTarget.value;
             e.currentTarget.value = "";
             if (val) moveSelectedToSection(val === "unsectioned" ? null : val);
          }}>
             <option value="" disabled selected>{t("requisitions.moveToSection")}</option>
             {#each sections as sec}
                <option value={sec.id}>{sec.name}</option>
             {/each}
             <option value="unsectioned">{t("requisitions.noSection")}</option>
          </select>

          <Button variant="destructive" size="sm" class="h-8 text-xs" onclick={deleteSelectedItems}>{t("requisitions.deleteSelected")}</Button>
          <Button variant="ghost" size="sm" class="h-8 text-xs" onclick={() => selectedItemIds.clear()}>{t("common.clear")}</Button>
        </div>
      {/if}

      {#snippet lineForm()}
        <div class="m-3 p-4 bg-muted/20 border border-dashed rounded-lg space-y-4">
          <div class="flex items-center justify-between">
            <h3 class="text-xs font-semibold uppercase tracking-wider text-muted-foreground">{t("requisitions.addLineItem")}</h3>
            <span class="text-xs text-muted-foreground">
              {t("requisitions.ctrlEnterToSave")}
            </span>
          </div>

          <div class="grid grid-cols-1 md:grid-cols-12 gap-3 items-end">
            <div class="md:col-span-5 space-y-1">
              <label class="text-xs font-medium text-muted-foreground" for="variant-select">{t("requisitions.productVariant")}</label>
              <Combobox id="variant-select" options={variantOptions} bind:value={newItemVariantId} placeholder={t("requisitions.searchVariant")} />
            </div>
            {#if !newItemVariantId}
              <div class="md:col-span-4 space-y-1">
                <label class="text-xs font-medium text-muted-foreground" for="desc-input">{t("requisitions.nonStockDescription")}</label>
                <Input id="desc-input" placeholder={t("requisitions.customItemName")} bind:value={newItemDescription} />
              </div>
            {/if}
            <div class="{newItemVariantId ? 'md:col-span-3' : 'md:col-span-2'} space-y-1">
              <label class="text-xs font-medium text-muted-foreground" for="qty-input">{t("requisitions.requestedQty")}</label>
              <Input id="qty-input" type="number" bind:value={newItemQty} min="1" />
            </div>
            <div class="md:col-span-4 space-y-1">
              <label class="text-xs font-medium text-muted-foreground" for="sec-select">{t("requisitions.targetSection")}</label>
              <select id="sec-select" class="flex h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm shadow-xs transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring" bind:value={newItemSection}>
                <option value="">{t("requisitions.noSection")}</option>
                {#each requisition.sections as sec}
                  <option value={sec.id}>{sec.name}</option>
                {/each}
              </select>
            </div>
          </div>

          {#if duplicateWarning}
            <div class="flex items-center gap-2 text-xs font-medium text-amber-700 bg-amber-500/10 border border-amber-500/20 p-2.5 rounded-md">
              <AlertTriangle class="h-4 w-4 shrink-0 text-amber-600" />
              <span>{t("requisitions.alreadyOnRequisition")}</span>
            </div>
          {/if}

          <div class="flex justify-end gap-2 pt-1 border-t border-border/50">
            <Button variant="ghost" size="sm" onclick={() => showAddItem = false}>{t("common.cancel")}</Button>
            <Button size="sm" onclick={saveItem} disabled={adding}>
              {adding ? t("common.saving") : t("requisitions.saveLineItem")}
            </Button>
          </div>
        </div>
      {/snippet}

      <div class="rounded-xl border bg-card text-card-foreground shadow-xs overflow-hidden">
        <div use:dndzone={{items: dndSections, dragDisabled: search !== "" || editingSectionId !== null || cellEdit !== null, flipDurationMs, dropTargetStyle: {}}} onconsider={handleSectionConsider} onfinalize={handleSectionFinalize}>
          {#each dndSections as section, idx (section.id)}
            <div animate:flip={{duration: flipDurationMs}}>
              {#if groupedItems[section.id] && (groupedItems[section.id].length > 0 || search === "")}
                {#if section.id !== "unsectioned" || requisition.sections.length > 0}
                  <div class="bg-muted/40 px-4 py-2.5 border-b {idx > 0 ? 'border-t' : ''} font-medium text-sm flex items-center justify-between group select-none">
                    <div class="flex items-center gap-2.5">
                       <GripVertical class="h-4 w-4 text-muted-foreground/60 cursor-grab active:cursor-grabbing hover:text-foreground transition-colors print:hidden" />
                       {#if editingSectionId === section.id}
                         <div class="flex items-center gap-1">
                           <Input bind:value={editedSectionName} class="h-7 w-48 text-sm" onkeydown={(e: any) => e.key === 'Enter' && saveRenameSection()} autofocus />
                           <Button size="icon" variant="ghost" class="h-7 w-7" onclick={saveRenameSection}><Check class="h-3.5 w-3.5" /></Button>
                           <Button size="icon" variant="ghost" class="h-7 w-7" onclick={() => editingSectionId = null}><X class="h-3.5 w-3.5" /></Button>
                         </div>
                       {:else}
                         <!-- svelte-ignore a11y_click_events_have_key_events -->
                         <!-- svelte-ignore a11y_no_static_element_interactions -->
                         <span class="font-semibold text-foreground cursor-pointer hover:text-primary transition-colors flex items-center gap-2" onclick={() => startRenameSection(section.id, section.name)}>
                           {section.name}
                           <Badge class="font-normal text-xs py-0 px-1.5 bg-background border">
                             {t("requisitions.lines", { count: groupedItems[section.id]?.length || 0 })}
                           </Badge>
                         </span>
                       {/if}
                    </div>
                    {#if section.id !== "unsectioned"}
                      <Button variant="ghost" size="icon" class="h-7 w-7 opacity-0 group-hover:opacity-100 transition-opacity text-muted-foreground hover:text-destructive print:hidden" onclick={() => deleteSection(section.id)}>
                        <Trash2 class="h-3.5 w-3.5" />
                      </Button>
                    {/if}
                  </div>
                {/if}

                <div class="overflow-x-auto">
                  <table class="w-full text-sm">
                    <thead class="bg-muted/15 border-b text-left text-xs font-semibold text-muted-foreground uppercase tracking-wider">
                      <tr>
                        <th class="w-8 py-2.5 pl-3 print:hidden"></th>
                        <th class="w-8 py-2.5 pr-2 print:hidden"></th>
                        <th class="px-4 py-2.5 w-36">{t("common.sku")}</th>
                        <th class="px-4 py-2.5">{t("requisitions.productName")}</th>
                        <th class="px-4 py-2.5 text-right w-28">{t("requisitions.requested")}</th>
                        <th class="px-4 py-2.5 text-right w-24">{t("requisitions.orderedQty")}</th>
                        <th class="px-4 py-2.5 text-right w-28">{t("requisitions.remainingQty")}</th>
                        <th class="w-12 py-2.5 pr-3 text-right print:hidden"></th>
                      </tr>
                    </thead>
                    <tbody use:dndzone={{items: groupedItems[section.id], dragDisabled: search !== "" || cellEdit !== null || editingSectionId !== null, flipDurationMs, dropTargetStyle: {}}} onconsider={(e) => handleItemConsider(section.id, e)} onfinalize={(e) => handleItemFinalize(section.id, e)}>
                      {#each groupedItems[section.id] as item (item.id)}
                        {@const remaining = item.qtyRequested - item.qtyOrdered}
                        <tr animate:flip={{duration: flipDurationMs}} class="border-b last:border-0 hover:bg-muted/30 transition-colors group/row {selectedItemIds.has(item.id) ? 'bg-primary/5 hover:bg-primary/10' : ''}">
                          <td class="py-2 pl-3 text-center print:hidden w-8">
                            <GripVertical class="h-4 w-4 text-muted-foreground/40 cursor-grab active:cursor-grabbing hover:text-foreground transition-colors inline-block" />
                          </td>
                          <td class="py-2 pr-2 text-center print:hidden w-8">
                            <input type="checkbox" checked={selectedItemIds.has(item.id)} onchange={() => toggleItemSelection(item.id)} class="h-4 w-4 rounded border-input accent-primary cursor-pointer" />
                          </td>
                          <td class="px-4 py-2 font-mono text-xs text-muted-foreground">{item.sku || "—"}</td>
                          <td class="px-4 py-2 font-medium text-foreground">
                            {#if cellEdit?.id === item.id && cellEdit?.field === "desc"}
                              <input
                                bind:value={cellStr}
                                use:selectOnMount
                                onkeydown={cellKeydown}
                                onblur={commitCell}
                                autocomplete="off"
                                class="h-7 w-full rounded-md border border-input bg-background px-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                              />
                            {:else if !item.variantId}
                              <button type="button" class="-mx-1 rounded px-1.5 py-0.5 text-left hover:bg-muted text-foreground transition-colors" title={t("purchaseDetail.editDescription")} onclick={() => startCellEdit(item, "desc")}>
                                {item.variantName}
                              </button>
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
                              <button type="button" class="-mx-1 rounded px-1.5 py-0.5 hover:bg-muted font-medium tabular-nums transition-colors" title={t("purchaseDetail.editQuantity")} onclick={() => startCellEdit(item, "qty")}>
                                {item.qtyRequested}
                              </button>
                            {/if}
                          </td>
                          <td class="px-4 py-2 text-right tabular-nums text-muted-foreground">{item.qtyOrdered}</td>
                          <td class="px-4 py-2 text-right tabular-nums">
                            {#if remaining > 0}
                              <span class="inline-flex items-center rounded-full bg-amber-500/10 px-2 py-0.5 text-xs font-semibold text-amber-600 dark:text-amber-400">
                                {remaining}
                              </span>
                            {:else}
                              <span class="inline-flex items-center rounded-full bg-emerald-500/10 px-2 py-0.5 text-xs font-semibold text-emerald-600 dark:text-emerald-400">
                                0
                              </span>
                            {/if}
                          </td>
                          <td class="py-2 pr-3 text-right print:hidden">
                             <div class="flex items-center justify-end gap-1 opacity-0 group-hover/row:opacity-100 transition-opacity">
                               <Button variant="ghost" size="icon" class="h-7 w-7 text-muted-foreground hover:text-destructive" onclick={() => deleteItem(item.id)}>
                                 <Trash2 class="h-3.5 w-3.5" />
                               </Button>
                             </div>
                          </td>
                        </tr>
                      {/each}
                      {#if groupedItems[section.id].length === 0}
                        <tr><td colspan="8" class="px-4 py-6 text-center text-muted-foreground text-xs">{t("requisitions.noItemsInSection")}</td></tr>
                      {/if}
                      {#if newSectionName !== null && newSectionAnchorId === section.id}
                        <tr class="border-t">
                          <td colspan="8" class="p-0">
                            <div class="flex items-center gap-2 px-4 py-2">
                              <Input placeholder={t("requisitions.sectionName")} bind:value={newSectionName} class="h-8 max-w-xs text-sm" onkeydown={(e: any) => { if (e.key === 'Enter') addSection(); else if (e.key === 'Escape') cancelAddSection(); }} autofocus />
                              <Button size="sm" onclick={addSection} disabled={adding || !newSectionName.trim()}>{t("common.save")}</Button>
                              <Button size="sm" variant="ghost" onclick={cancelAddSection}>{t("common.cancel")}</Button>
                            </div>
                          </td>
                        </tr>
                      {:else if section.id !== "unsectioned" && !showAddItem && newSectionName === null && search === ""}
                        <tr class="hover:bg-muted/20 border-t group">
                          <td colspan="8" class="p-0">
                            <div class="flex items-center justify-between gap-2">
                              <button class="flex-1 text-left px-4 py-2 text-xs font-medium text-muted-foreground group-hover:text-primary transition-colors flex items-center gap-1.5" onclick={() => openAddItem(section.id)}>
                                <Plus class="h-3.5 w-3.5" /> {t("requisitions.addLineToSection", { section: section.name })}
                              </button>
                              <button class="shrink-0 mr-2 px-2 py-2 text-xs font-medium text-muted-foreground/70 hover:text-primary transition-colors flex items-center gap-1 print:hidden" title={t("requisitions.addSectionBelow")} onclick={() => startAddSection(section.id)}>
                                <Plus class="h-3.5 w-3.5" /> {t("requisitions.addSectionBelow")}
                              </button>
                            </div>
                          </td>
                        </tr>
                      {:else if showAddItem && (newItemSection || "unsectioned") === section.id}
                        <tr>
                          <td colspan="8" class="p-0">
                            {@render lineForm()}
                          </td>
                        </tr>
                      {/if}
                    </tbody>
                  </table>
                </div>
              {/if}
            </div>
          {/each}
        </div>
      </div>
    </div>
  </div>
{/if}

{#if bulkOpen}
  <div
    class="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4 backdrop-blur-xs"
    role="presentation"
    onclick={(e) => e.target === e.currentTarget && closeBulk()}
  >
    <div
      class="flex max-h-[85vh] w-full max-w-3xl flex-col rounded-xl border bg-card shadow-2xl overflow-hidden"
      role="dialog"
      aria-modal="true"
      aria-label={t("requisitions.addMultipleLines")}
    >
      <div class="flex items-center justify-between border-b px-5 py-3.5">
        <div class="flex items-center gap-2">
          <Layers class="h-4 w-4 text-primary" />
          <h2 class="text-base font-semibold">{t("requisitions.addMultipleLines")}</h2>
        </div>
        <Button variant="ghost" size="icon" class="h-8 w-8" onclick={closeBulk}>
          <X class="h-4 w-4" />
        </Button>
      </div>

      <div class="flex border-b bg-muted/20 px-5">
        <button class={tabClass("reorder")} onclick={() => (bulkTab = "reorder")}>
          {t("requisitions.reorderSuggestions")}
        </button>
        <button class={tabClass("stock")} onclick={() => (bulkTab = "stock")}>
          {t("requisitions.byStockCatalog")}
        </button>
      </div>

      <div class="flex-1 overflow-auto px-5 py-4 space-y-3">
        {#if bulkTab === "reorder"}
          <p class="text-xs text-muted-foreground">
            {t("requisitions.reorderSubtitle")}
          </p>

          {#if $ReorderSuggestionsQuery.fetching && suggestions.length === 0}
            <p class="py-12 text-center text-sm text-muted-foreground">{t("common.loading")}</p>
          {:else if reorderRows.length === 0}
            <p class="py-12 text-center text-sm text-muted-foreground">
              {t("requisitions.noOpenSuggestions")}
            </p>
          {:else}
            <div class="rounded-lg border overflow-hidden">
              <table class="w-full text-sm">
                <thead class="bg-muted/40 border-b text-left text-xs font-semibold text-muted-foreground">
                  <tr>
                    <th class="w-10 px-3 py-2.5 text-center"></th>
                    <th class="px-4 py-2.5 font-semibold">{t("common.product")}</th>
                    <th class="px-4 py-2.5 text-right font-semibold">{t("stock.onHand")}</th>
                    <th class="px-4 py-2.5 text-right font-semibold">{t("requisitions.reorderPoint")}</th>
                    <th class="px-4 py-2.5 font-semibold">{t("vendors.vendor")}</th>
                    <th class="px-4 py-2.5 w-32 font-semibold">{t("requisitions.orderQty")}</th>
                  </tr>
                </thead>
                <tbody class="divide-y">
                  {#each reorderRows as s (s.id)}
                    {#if reorderPicks[s.id]}
                      <tr class="hover:bg-muted/30 transition-colors {reorderPicks[s.id].selected ? 'bg-primary/5' : ''}">
                        <td class="px-3 py-2 text-center">
                          <input
                            type="checkbox"
                            bind:checked={reorderPicks[s.id].selected}
                            class="h-4 w-4 rounded border-input accent-primary cursor-pointer"
                          />
                        </td>
                        <td class="px-4 py-2">
                          <span class="font-medium text-foreground">{s.productName}</span>
                          {#if s.sku}
                            <span class="ml-1.5 font-mono text-xs text-muted-foreground">({s.sku})</span>
                          {/if}
                        </td>
                        <td class="px-4 py-2 text-right tabular-nums">{s.currentStock}</td>
                        <td class="px-4 py-2 text-right tabular-nums">{s.reorderPoint ?? '—'}</td>
                        <td class="px-4 py-2 text-xs text-muted-foreground">{s.vendorName ?? '—'}</td>
                        <td class="px-4 py-2">
                          <Input
                            type="number"
                            class="h-8 w-24 text-right tabular-nums ml-auto"
                            bind:value={reorderPicks[s.id].qty}
                            min="1"
                          />
                        </td>
                      </tr>
                    {/if}
                  {/each}
                </tbody>
              </table>
            </div>
          {/if}
        {:else}
          <div class="relative">
            <Search class="absolute left-3 top-2.5 h-4 w-4 text-muted-foreground" />
            <Input
              type="search"
              placeholder={t("requisitions.searchProduct")}
              bind:value={stockSearch}
              class="pl-9"
            />
          </div>

          {#if stockVisible.length === 0}
            <p class="py-12 text-center text-sm text-muted-foreground">{t("requisitions.noMatchingVariants")}</p>
          {:else}
            <div class="rounded-lg border overflow-hidden">
              <table class="w-full text-sm">
                <thead class="bg-muted/40 border-b text-left text-xs font-semibold text-muted-foreground">
                  <tr>
                    <th class="w-10 px-3 py-2.5 text-center"></th>
                    <th class="px-4 py-2.5 font-semibold">{t("common.sku")}</th>
                    <th class="px-4 py-2.5 font-semibold">{t("requisitions.variantName")}</th>
                    <th class="px-4 py-2.5 text-right font-semibold">{t("stock.onHand")}</th>
                    <th class="px-4 py-2.5 w-32 font-semibold text-right">{t("requisitions.requestedQty")}</th>
                  </tr>
                </thead>
                <tbody class="divide-y">
                  {#each stockVisible as r (r.variantId)}
                    {#if stockPicks[r.variantId]}
                      <tr class="hover:bg-muted/30 transition-colors {stockPicks[r.variantId].selected ? 'bg-primary/5' : ''}">
                        <td class="px-3 py-2 text-center">
                          <input
                            type="checkbox"
                            bind:checked={stockPicks[r.variantId].selected}
                            class="h-4 w-4 rounded border-input accent-primary cursor-pointer"
                          />
                        </td>
                        <td class="px-4 py-2 font-mono text-xs text-muted-foreground">{r.sku || '—'}</td>
                        <td class="px-4 py-2 font-medium text-foreground">{r.label}</td>
                        <td class="px-4 py-2 text-right tabular-nums">{r.totalQty}</td>
                        <td class="px-4 py-2">
                          <Input
                            type="number"
                            class="h-8 w-24 text-right tabular-nums ml-auto"
                            bind:value={stockPicks[r.variantId].qty}
                            min="1"
                          />
                        </td>
                      </tr>
                    {/if}
                  {/each}
                </tbody>
              </table>
            </div>
            {#if stockTruncated}
              <p class="text-center text-xs text-muted-foreground">
                {t("requisitions.showingTopLowStock", { count: STOCK_CAP })}
              </p>
            {/if}
          {/if}
        {/if}
      </div>

      <div class="flex items-center justify-between border-t bg-muted/10 px-5 py-3">
        <span class="text-xs font-medium text-muted-foreground">
          {t("requisitions.itemsSelected", { count: bulkTab === "reorder" ? reorderSelectedCount : stockSelectedCount })}
        </span>
        <div class="flex items-center gap-2">
          <Button variant="ghost" size="sm" onclick={closeBulk}>{t("common.cancel")}</Button>
          {#if bulkTab === "reorder"}
            <Button
              size="sm"
              disabled={adding || reorderSelectedCount === 0}
              onclick={addReorderSelected}
            >
              {adding ? t("common.saving") : t("requisitions.addToRequisition", { count: reorderSelectedCount })}
            </Button>
          {:else}
            <Button
              size="sm"
              disabled={adding || stockSelectedCount === 0}
              onclick={addStockSelected}
            >
              {adding ? t("common.saving") : t("requisitions.addToRequisition", { count: stockSelectedCount })}
            </Button>
          {/if}
        </div>
      </div>
    </div>
  </div>
{/if}
