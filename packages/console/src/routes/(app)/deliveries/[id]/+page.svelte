<script lang="ts">
  import { graphql, CachePolicy } from "$houdini";
  import { page } from "$app/state";
  import type { Viewer } from "../../+layout.server";
  import { formatMoney, roundMoney, treePathMap } from "$lib/utils";
  import { t } from "$lib/i18n";
  import { refetchOnVisible } from "$lib/refetch-on-visible.svelte";
  import Badge from "$lib/components/ui/badge.svelte";
  import Button from "$lib/components/ui/button.svelte";
  import Combobox from "$lib/components/ui/combobox.svelte";
  import Input from "$lib/components/ui/input.svelte";
  import MoneyInput from "$lib/components/ui/money-input.svelte";
  import Select from "$lib/components/ui/select.svelte";
  import type { PageData } from "./$types";

  graphql(`
    query DeliveryDetail($id: ID!) {
      delivery(id: $id) {
        id
        kind
        date
        biller
        targetLocationId
        targetLocation { id name }
        purchaseId
        status
        deliveredAt
        totalCostMinor
        createdAt
        updatedAt
        items {
          id
          parentItemId
          purchaseItemId
          vendorId
          vendor { id name }
          description
          qty
          costMinor
          allocatedFreightMinor
          sortOrder
          purchaseItem { id purchaseId variantId qtyOrdered qtyDelivered }
        }
        leafLandings {
          itemId
          landedUnitCostMinor
          freightMinor
          transitFreightMinor
          isStock
        }
      }
      locations(includeArchived: false) {
        id
        name
        parentId
      }
      couriers: vendors(kind: expedition) {
        id
        name
      }
      openPurchases: purchases(status: open) {
        id
        snapshotVendorName
        items {
          id
          variantId
          description
          qtyOrdered
          qtyDelivered
          unitCostMinor
        }
      }
      products(includeArchived: true) {
        id
        name
        variants { id sku label }
      }
    }
  `);

  const UpdateDelivery = graphql(`
    mutation ConsoleUpdateDelivery(
      $id: ID!
      $date: String
      $biller: String
      $targetLocationId: ID
    ) {
      updateDelivery(
        id: $id
        date: $date
        biller: $biller
        targetLocationId: $targetLocationId
      ) {
        id
        date
        biller
        targetLocationId
        updatedAt
      }
    }
  `);

  const DeleteDelivery = graphql(`
    mutation ConsoleDeleteDelivery($id: ID!) {
      deleteDelivery(id: $id)
    }
  `);

  const CreateDeliveryItem = graphql(`
    mutation ConsoleCreateDeliveryItem(
      $deliveryId: ID!
      $parentItemId: ID
      $purchaseItemId: ID
      $description: String!
      $qty: Float
      $costMinor: Float!
      $vendorId: ID
    ) {
      createDeliveryItem(
        deliveryId: $deliveryId
        parentItemId: $parentItemId
        purchaseItemId: $purchaseItemId
        description: $description
        qty: $qty
        costMinor: $costMinor
        vendorId: $vendorId
      ) {
        id
      }
    }
  `);

  const UpdateDeliveryItem = graphql(`
    mutation ConsoleUpdateDeliveryItem(
      $id: ID!
      $description: String
      $qty: Float
      $costMinor: Float
      $vendorId: ID
      $parentItemId: ID
    ) {
      updateDeliveryItem(
        id: $id
        description: $description
        qty: $qty
        costMinor: $costMinor
        vendorId: $vendorId
        parentItemId: $parentItemId
      ) {
        id
      }
    }
  `);

  const DeleteDeliveryItem = graphql(`
    mutation ConsoleDeleteDeliveryItem($id: ID!) {
      deleteDeliveryItem(id: $id)
    }
  `);

  const CommitDelivery = graphql(`
    mutation ConsoleCommitDelivery($id: ID!) {
      commitDelivery(id: $id) {
        id
        status
        deliveredAt
      }
    }
  `);

  const CancelDelivery = graphql(`
    mutation ConsoleCancelDelivery($id: ID!) {
      cancelDelivery(id: $id) {
        id
        status
      }
    }
  `);

  let { data }: { data: PageData } = $props();
  const Detail = $derived(data.DeliveryDetail);
  const delivery = $derived($Detail.data?.delivery ?? null);
  const locations = $derived($Detail.data?.locations ?? []);
  const couriers = $derived($Detail.data?.couriers ?? []);
  // { value, label } shapes for the searchable Comboboxes (location + courier
  // pickers). Each empty-row prompt is prepended at the call site.
  // Breadcrumb path per location ("Shelf 2 › Level 1") so same-named children
  // under different parents are distinguishable.
  const locationPaths = $derived(treePathMap(locations));
  const locationOptions = $derived(
    locations.map((l) => ({ value: l.id, label: locationPaths.get(l.id) ?? l.name })),
  );
  const courierOptions = $derived(
    couriers.map((c) => ({ value: c.id, label: c.name })),
  );
  const openPurchases = $derived($Detail.data?.openPurchases ?? []);
  const productList = $derived($Detail.data?.products ?? []);
  const items = $derived(delivery?.items ?? []);

  // Mutations return only { id }, so Houdini can't merge added/removed/moved
  // rows into the cached query — refetch from the network or the tree renders
  // stale until a hard refresh.
  const refetch = () => Detail.fetch({ policy: CachePolicy.NetworkOnly });

  // Flat variant lookup so PO lines label by product name / SKU, not raw id.
  const variantLabel = $derived.by(() => {
    const m = new Map<string, string>();
    for (const p of productList) {
      for (const v of p.variants) {
        const suffix = v.label ? `${v.sku} · ${v.label}` : v.sku;
        m.set(v.id, `${p.name} · ${suffix}`);
      }
    }
    return (id: string | null | undefined, fallback: string | null | undefined) =>
      id ? (m.get(id) ?? fallback ?? t("products.unknown")) : (fallback ?? "—");
  });

  // Split display parts per variant so goods rows can put the product name on
  // the main line and the SKU underneath — inlining both bloats the row.
  type VariantParts = { name: string; sku: string };
  const variantParts = $derived.by(() => {
    const m = new Map<string, VariantParts>();
    for (const p of productList) {
      for (const v of p.variants) {
        m.set(v.id, { name: p.name, sku: v.label ? `${v.sku} · ${v.label}` : v.sku });
      }
    }
    return m;
  });
  // Variant behind a goods leaf; null for cost lines or when the variant (or
  // its PO line) is gone — callers fall back to the stored description.
  const goodsParts = (it: { purchaseItem: { variantId: string | null } | null }) =>
    it.purchaseItem?.variantId
      ? (variantParts.get(it.purchaseItem.variantId) ?? null)
      : null;

  // PO lines still owing goods, across every open purchase — the goods picker.
  // A delivery can draw lines from several purchases; `remaining` is what's left
  // to receive on the PO (this draft's own staged qty is enforced at commit).
  type PoLine = {
    itemId: string;
    purchaseId: string;
    vendorName: string;
    /** Main display line: product name, else the PO line's free text. */
    productName: string;
    /** SKU (· variant label) shown under the name; null for non-stock lines. */
    sku: string | null;
    /** Full label (vendor · line) used when written onto a delivery item. */
    label: string;
    remaining: number;
    unitCostMinor: number;
  };
  const poLines = $derived.by(() => {
    const out: PoLine[] = [];
    for (const p of openPurchases) {
      for (const it of p.items) {
        const remaining = it.qtyOrdered - it.qtyDelivered;
        if (remaining <= 0) continue;
        const lineLabel = variantLabel(it.variantId, it.description);
        const parts = it.variantId ? variantParts.get(it.variantId) : undefined;
        out.push({
          itemId: it.id,
          purchaseId: p.id,
          vendorName: p.snapshotVendorName,
          productName: parts?.name ?? it.description ?? lineLabel,
          sku: parts?.sku ?? null,
          label: `${p.snapshotVendorName} · ${lineLabel}`,
          remaining,
          unitCostMinor: it.unitCostMinor,
        });
      }
    }
    return out;
  });
  const poLineById = $derived.by(() => {
    const m = new Map<string, PoLine>();
    for (const l of poLines) m.set(l.itemId, l);
    return m;
  });
  // Open purchases that still have lines to receive — step 1 of the picker.
  // `totalMinor` is the remaining value per purchase, so the picker shows what
  // each PO is still worth alongside its open line count.
  const poGroups = $derived.by(() => {
    const m = new Map<
      string,
      { id: string; vendorName: string; count: number; totalMinor: number }
    >();
    for (const l of poLines) {
      const value = l.remaining * l.unitCostMinor;
      const g = m.get(l.purchaseId);
      if (g) {
        g.count++;
        g.totalMinor += value;
      } else {
        m.set(l.purchaseId, {
          id: l.purchaseId,
          vendorName: l.vendorName,
          count: 1,
          totalMinor: value,
        });
      }
    }
    return [...m.values()];
  });

  // Server-computed landed cost per leaf, keyed by item id — the same
  // apportionment commit will apply, so the preview can't drift from it.
  const landingByItem = $derived.by(() => {
    type Landing = NonNullable<typeof delivery>["leafLandings"][number];
    const m = new Map<string, Landing>();
    for (const l of delivery?.leafLandings ?? []) m.set(l.itemId, l);
    return m;
  });

  // Itemized totals for the reconciliation summary. Every node is counted once:
  // goods leaves carry line value, cost nodes carry their freight/customs amount,
  // so goods + charges is the true grand total landing into stock — unlike the
  // server's denormalized `totalCostMinor`, which intentionally sums only the
  // cost nodes (the delivery's own charges, for list views).
  const costSummary = $derived.by(() => {
    let goods = 0;
    let charges = 0;
    for (const it of items) {
      if (it.purchaseItemId != null) goods += it.costMinor;
      else charges += it.costMinor;
    }
    // Arrival only: cost picked up from committed transit hops (qty × pooled
    // rate per line) — part of what lands into stock but billed on the hops.
    let transit = 0;
    for (const l of delivery?.leafLandings ?? []) transit += l.transitFreightMinor;
    return { goods, charges, transit, total: goods + charges + transit };
  });

  const viewer = $derived(page.data.user as Viewer | undefined);
  const has = (key: string) => !!viewer && viewer.permissions.includes(key);
  const canDraft = $derived(has("delivery.draft"));
  const canCommit = $derived(has("delivery.commit"));
  const canCancel = $derived(has("delivery.cancel"));

  const isDraft = $derived(delivery?.status === "draft");
  const editable = $derived(isDraft && canDraft);
  const isTransit = $derived(delivery?.kind === "transit");

  // ---- Tree build ----------------------------------------------------------
  // Items are flat; build a parent → children map and surface roots in
  // sortOrder so the editor renders the cost tree top-down.
  type Item = (typeof items)[number];
  type Node = { item: Item; children: Node[] };

  const tree = $derived.by(() => {
    const byParent = new Map<string | null, Item[]>();
    for (const it of items) {
      const key = it.parentItemId ?? null;
      const list = byParent.get(key) ?? [];
      list.push(it);
      byParent.set(key, list);
    }
    for (const list of byParent.values()) {
      list.sort((a, b) => a.sortOrder - b.sortOrder);
    }
    const build = (parentId: string | null): Node[] =>
      (byParent.get(parentId) ?? []).map((item) => ({
        item,
        children: build(item.id),
      }));
    return build(null);
  });

  // ---- Charge scope (mirrors the server's shape-based allocation) ----------
  // A cost node with children spreads over its own subtree's goods; a childless
  // cost line spreads over its parent's subtree (the whole delivery at root).
  // Charges that will capitalize into nothing at commit — a charge grouped
  // where no goods sit — still post courier AP; surfaced as a warning before
  // commit, never a blocker.
  const inertCharges = $derived.by(() => {
    const out: Item[] = [];
    const hasGoods = (n: Node): boolean =>
      n.children.some((c) => c.item.purchaseItemId != null || hasGoods(c));
    const anyGoods = items.some((it) => it.purchaseItemId != null);
    const walk = (nodes: Node[], siblingsHaveGoods: boolean) => {
      for (const n of nodes) {
        if (n.item.purchaseItemId == null && n.item.costMinor > 0) {
          const inert =
            n.children.length > 0 ? !hasGoods(n) : !siblingsHaveGoods;
          if (inert) out.push(n.item);
        }
        walk(n.children, hasGoods(n));
      }
    };
    walk(tree, anyGoods);
    return out;
  });

  // ---- Header editing ------------------------------------------------------
  let editingHeader = $state(false);
  let hDate = $state("");
  let hBiller = $state("");
  let hTargetLocationId = $state("");

  function startHeaderEdit() {
    if (!delivery) return;
    hDate = delivery.date.slice(0, 10);
    hBiller = delivery.biller ?? "";
    hTargetLocationId = delivery.targetLocationId ?? "";
    editingHeader = true;
  }

  let busy = $state(false);
  let error = $state<string | null>(null);

  // Cross-tab freshness: a courier/vendor (or PO line) created in another
  // browser tab only exists on the server — this tab's Houdini cache never
  // hears about it. Re-pull when the tab becomes visible again so the
  // cost-line courier pickers list it. Skipped mid-mutation: the mutation's
  // own refetch() is about to run anyway.
  refetchOnVisible(() => {
    if (!busy) refetch();
  });

  async function saveHeader() {
    if (!delivery) return;
    busy = true;
    error = null;
    try {
      const res = await UpdateDelivery.mutate({
        id: delivery.id,
        date: hDate,
        biller: hBiller.trim() || null,
        // A transit note has no target location — never send one for it.
        ...(isTransit ? {} : { targetLocationId: hTargetLocationId }),
      });
      if (res.errors?.length) {
        error = res.errors[0].message;
        return;
      }
      editingHeader = false;
      await refetch();
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    } finally {
      busy = false;
    }
  }

  // ---- Item add / edit / delete -------------------------------------------
  // addingUnder: id of the parent (or "" for a root). null means no form open.
  // A new line is either a goods leaf (a PO line + qty) or a cost node
  // (freight/customs, optionally owed to a courier).
  let addingUnder = $state<string | null | "">(null);
  let nMode = $state<"goods" | "cost">("goods");
  let nDesc = $state("");
  let nCost = $state<number | null>(null);
  let nVendorId = $state("");

  function startAdd(parentId: string | "") {
    addingUnder = parentId;
    nMode = "goods";
    nDesc = "";
    nCost = null;
    nVendorId = "";
  }

  // ---- PO-line picker modal (multi-select goods) --------------------------
  // Pick several PO lines at once, filter by purchase, and drop them all under
  // the same parent (a cost line, or the root) in one go.
  let pickerOpen = $state(false);
  let pickerParent = $state<string | "">("");
  let pickerPoId = $state(""); // "" = step 1 (pick a purchase); else show its lines
  let pickerSearch = $state(""); // step 1: filter purchases by vendor
  let pickerLineSearch = $state(""); // step 2: filter the purchase's lines
  // poLine itemId → qty string. A key's presence means the line is selected.
  let pickerQty = $state<Record<string, string>>({});

  function openPicker() {
    if (addingUnder === null) return;
    pickerParent = addingUnder;
    pickerPoId = "";
    pickerSearch = "";
    pickerLineSearch = "";
    pickerQty = {};
    pickerOpen = true;
  }
  function togglePick(line: PoLine) {
    if (line.itemId in pickerQty) {
      const rest = { ...pickerQty };
      delete rest[line.itemId];
      pickerQty = rest;
    } else {
      pickerQty = { ...pickerQty, [line.itemId]: String(line.remaining) };
    }
  }
  // Select-all toggles only the visible lines of the purchase on screen,
  // leaving any selection in other purchases intact (selections accumulate
  // across POs).
  function toggleAllPicker() {
    const next = { ...pickerQty };
    if (allPicked) {
      for (const l of filteredPickerLines) delete next[l.itemId];
    } else {
      for (const l of filteredPickerLines)
        if (!(l.itemId in next)) next[l.itemId] = String(l.remaining);
    }
    pickerQty = next;
  }
  function setPickQty(itemId: string, v: string) {
    pickerQty = { ...pickerQty, [itemId]: v };
  }

  const pickerParentLabel = $derived(
    pickerParent === ""
      ? t("deliveryDetail.topLevel")
      : (items.find((it) => it.id === pickerParent)?.description ?? t("deliveryDetail.costLineGeneric")),
  );
  const pickerLines = $derived(
    poLines.filter((l) => l.purchaseId === pickerPoId),
  );
  // Step-1 purchase search (vendor name) and step-2 line search (product name,
  // SKU, or full label) keep the picker usable with many open POs.
  const filteredPoGroups = $derived.by(() => {
    const q = pickerSearch.trim().toLowerCase();
    if (!q) return poGroups;
    return poGroups.filter((g) => g.vendorName.toLowerCase().includes(q));
  });
  const filteredPickerLines = $derived.by(() => {
    const q = pickerLineSearch.trim().toLowerCase();
    if (!q) return pickerLines;
    return pickerLines.filter(
      (l) =>
        l.productName.toLowerCase().includes(q) ||
        (l.sku?.toLowerCase().includes(q) ?? false) ||
        l.label.toLowerCase().includes(q),
    );
  });
  const allPicked = $derived(
    filteredPickerLines.length > 0 &&
      filteredPickerLines.every((l) => l.itemId in pickerQty),
  );
  const somePicked = $derived(
    !allPicked && filteredPickerLines.some((l) => l.itemId in pickerQty),
  );
  const pickerPoName = $derived(
    poGroups.find((g) => g.id === pickerPoId)?.vendorName ?? "",
  );
  // How many lines are currently ticked per purchase — shown on step 1 so a
  // cross-purchase selection stays visible after switching purchases.
  const selectedByPo = $derived.by(() => {
    const m = new Map<string, number>();
    for (const itemId of Object.keys(pickerQty)) {
      const line = poLineById.get(itemId);
      if (line) m.set(line.purchaseId, (m.get(line.purchaseId) ?? 0) + 1);
    }
    return m;
  });
  const pickerSelected = $derived.by(() => {
    const out: { line: PoLine; qty: number }[] = [];
    for (const [itemId, raw] of Object.entries(pickerQty)) {
      const line = poLineById.get(itemId);
      if (line) out.push({ line, qty: raw.trim() ? Number(raw) : NaN });
    }
    return out;
  });
  const pickerValid = $derived(
    pickerSelected.length > 0 &&
      pickerSelected.every((s) => Number.isInteger(s.qty) && s.qty > 0),
  );
  const pickerTotal = $derived(
    pickerSelected.reduce(
      (sum, s) =>
        sum + (Number.isFinite(s.qty) ? s.line.unitCostMinor * s.qty : 0),
      0,
    ),
  );

  async function confirmPicker() {
    if (!delivery || !pickerValid) return;
    const parentItemId = pickerParent === "" ? null : pickerParent;
    busy = true;
    error = null;
    try {
      for (const { line, qty } of pickerSelected) {
        const res = await CreateDeliveryItem.mutate({
          deliveryId: delivery.id,
          parentItemId,
          purchaseItemId: line.itemId,
          description: line.label,
          qty,
          costMinor: roundMoney(line.unitCostMinor * qty),
        });
        if (res.errors?.length) {
          error = res.errors[0].message;
          break;
        }
      }
      pickerOpen = false;
      addingUnder = null;
      await refetch();
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    } finally {
      busy = false;
    }
  }

  // Cost lines (freight / customs) are still added one at a time inline. The
  // description is optional — blank falls back to the courier's name (else
  // "Freight") on the server.
  async function addItem() {
    if (!delivery || addingUnder === null) return;
    if (nCost == null) return;
    const parentItemId = addingUnder === "" ? null : addingUnder;
    busy = true;
    error = null;
    try {
      const res = await CreateDeliveryItem.mutate({
        deliveryId: delivery.id,
        parentItemId,
        description: nDesc.trim(),
        costMinor: nCost,
        vendorId: nVendorId || null,
      });
      if (res.errors?.length) {
        error = res.errors[0].message;
        return;
      }
      addingUnder = null;
      await refetch();
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    } finally {
      busy = false;
    }
  }

  let editingId = $state<string | null>(null);
  let eIsLeaf = $state(false);
  let eUnitCost = $state(0); // derived from the leaf's stored cost ÷ qty
  let eDesc = $state("");
  let eCost = $state<number | null>(null);
  let eQty = $state<string>("");
  let eVendorId = $state("");
  let eParentId = $state(""); // "" = root; else a cost node to nest under

  function startEdit(it: Item) {
    editingId = it.id;
    eIsLeaf = it.purchaseItemId != null;
    eUnitCost = eIsLeaf && it.qty ? Math.round((it.costMinor / it.qty) * 100) / 100 : 0;
    eDesc = it.description;
    eCost = it.costMinor;
    eQty = it.qty == null ? "" : String(it.qty);
    eVendorId = it.vendorId ?? "";
    eParentId = it.parentItemId ?? "";
  }

  // Valid "Move to" destinations for the edited node: every cost line except
  // the node itself and its own descendants (which would form a cycle).
  const moveTargets = $derived.by(() => {
    if (!editingId) return [] as { value: string; label: string }[];
    const blocked = new Set<string>([editingId]);
    const walk = (pid: string) => {
      for (const it of items) {
        if (it.parentItemId === pid && !blocked.has(it.id)) {
          blocked.add(it.id);
          walk(it.id);
        }
      }
    };
    walk(editingId);
    return items
      .filter((it) => it.purchaseItemId == null && !blocked.has(it.id))
      .map((it) => ({ value: it.id, label: it.description }));
  });

  // A goods leaf's stored value follows its qty at the PO line's unit cost.
  const eGoodsQty = $derived(eQty.trim() ? Number(eQty) : NaN);
  const eGoodsValid = $derived(Number.isInteger(eGoodsQty) && eGoodsQty > 0);

  async function saveEdit() {
    if (!editingId) return;
    busy = true;
    error = null;
    try {
      let res;
      if (eIsLeaf) {
        if (!eGoodsValid) return;
        res = await UpdateDeliveryItem.mutate({
          id: editingId,
          qty: eGoodsQty,
          costMinor: roundMoney(eUnitCost * eGoodsQty),
          parentItemId: eParentId || null,
        });
      } else {
        if (eCost == null) return;
        res = await UpdateDeliveryItem.mutate({
          id: editingId,
          description: eDesc.trim(),
          costMinor: eCost,
          vendorId: eVendorId || null,
          parentItemId: eParentId || null,
        });
      }
      if (res.errors?.length) {
        error = res.errors[0].message;
        return;
      }
      editingId = null;
      await refetch();
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    } finally {
      busy = false;
    }
  }

  async function removeItem(id: string) {
    if (!confirm(t("deliveryDetail.confirmDeleteLine"))) return;
    busy = true;
    error = null;
    try {
      const res = await DeleteDeliveryItem.mutate({ id });
      if (res.errors?.length) {
        error = res.errors[0].message;
        return;
      }
      await refetch();
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    } finally {
      busy = false;
    }
  }

  // ---- Group selected goods under a new cost line ---------------------------
  // Tick goods leaves in the tree, then create one charge that groups them —
  // the one-step alternative to add-line + per-item "Move to".
  let costSelected = $state<Set<string>>(new Set());
  function toggleCostSelect(id: string) {
    const next = new Set(costSelected);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    costSelected = next;
  }
  // Drop selected ids that have vanished (deleted here or refetched away) so
  // the toolbar count never references ghosts.
  $effect(() => {
    const ids = new Set(items.map((it) => it.id));
    if ([...costSelected].some((id) => !ids.has(id))) {
      costSelected = new Set([...costSelected].filter((id) => ids.has(id)));
    }
  });

  let groupFormOpen = $state(false);
  let gDesc = $state("");
  let gCost = $state<number | null>(null);
  let gVendorId = $state("");

  function startGroupForm() {
    groupFormOpen = true;
    gDesc = "";
    gCost = null;
    gVendorId = "";
  }
  function clearGroupSelect() {
    costSelected = new Set();
    groupFormOpen = false;
  }

  async function createGroupCostLine() {
    if (!delivery || costSelected.size === 0) return;
    if (gCost == null) return;
    // Nest the new charge under the goods' common parent so any outer charge
    // keeps spreading over them; mixed parents fall back to the root.
    const selected = items.filter((it) => costSelected.has(it.id));
    const parents = new Set(selected.map((it) => it.parentItemId ?? null));
    const parentItemId = parents.size === 1 ? [...parents][0] : null;
    busy = true;
    error = null;
    try {
      const res = await CreateDeliveryItem.mutate({
        deliveryId: delivery.id,
        parentItemId,
        description: gDesc.trim(),
        costMinor: gCost,
        vendorId: gVendorId || null,
      });
      if (res.errors?.length) {
        error = res.errors[0].message;
        return;
      }
      const newId = res.data?.createDeliveryItem.id;
      if (!newId) {
        error = t("deliveryDetail.errorCostLineNotCreated");
        return;
      }
      for (const it of selected) {
        const r = await UpdateDeliveryItem.mutate({
          id: it.id,
          parentItemId: newId,
        });
        if (r.errors?.length) {
          error = r.errors[0].message;
          break;
        }
      }
      groupFormOpen = false;
      costSelected = new Set();
      await refetch();
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    } finally {
      busy = false;
    }
  }

  // ---- Lifecycle: commit / cancel / delete --------------------------------
  async function commit() {
    if (!delivery) return;
    const msg = isTransit
      ? t("deliveryDetail.confirmCommitTransit")
      : t("deliveryDetail.confirmCommitArrival");
    if (!confirm(msg)) {
      return;
    }
    busy = true;
    error = null;
    try {
      const res = await CommitDelivery.mutate({ id: delivery.id });
      if (res.errors?.length) {
        error = res.errors[0].message;
        return;
      }
      await refetch();
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    } finally {
      busy = false;
    }
  }

  async function cancelDelivered() {
    if (!delivery) return;
    const msg = isTransit
      ? t("deliveryDetail.confirmReverseTransit")
      : t("deliveryDetail.confirmReverseArrival");
    if (!confirm(msg)) return;
    busy = true;
    error = null;
    try {
      const res = await CancelDelivery.mutate({ id: delivery.id });
      if (res.errors?.length) {
        error = res.errors[0].message;
        return;
      }
      await refetch();
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    } finally {
      busy = false;
    }
  }

  async function deleteDraft() {
    if (!delivery) return;
    if (!confirm(t("deliveryDetail.confirmDiscard"))) return;
    busy = true;
    error = null;
    try {
      const res = await DeleteDelivery.mutate({ id: delivery.id });
      if (res.errors?.length) {
        error = res.errors[0].message;
        return;
      }
      window.location.href = "/deliveries";
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    } finally {
      busy = false;
    }
  }

  const fmtDate = (iso: string | null | undefined) =>
    iso ? new Date(iso).toLocaleDateString("en-CA") : "—";

  function statusBadge(s: string) {
    if (s === "delivered") return "bg-emerald-100 text-emerald-700";
    if (s === "cancelled") return "bg-destructive/10 text-destructive";
    return "bg-amber-100 text-amber-800";
  }
</script>

<svelte:head><title>{t("deliveryDetail.pageTitle")}</title></svelte:head>

<!-- Line-form keyboard shortcuts: Ctrl/Cmd+Enter submits the open form (header
     edit, add/edit line, group charge, or the goods picker), Esc cancels or
     steps back. Esc inside an open combobox menu closes the menu first — it
     only reaches here once the menu is already shut. -->
<svelte:window
  onkeydown={(e) => {
    const submit = (e.ctrlKey || e.metaKey) && e.key === "Enter";
    if (pickerOpen) {
      if (e.key === "Escape") {
        e.preventDefault();
        // Step 2 steps back to the purchase list; step 1 closes the picker.
        if (pickerPoId) pickerPoId = "";
        else pickerOpen = false;
      } else if (submit && pickerValid && !busy) {
        e.preventDefault();
        confirmPicker();
      }
      return;
    }
    if (!editable || busy) return;
    if (editingHeader) {
      if (submit) {
        e.preventDefault();
        saveHeader();
      } else if (e.key === "Escape") {
        e.preventDefault();
        editingHeader = false;
      }
    } else if (editingId) {
      if (submit) {
        e.preventDefault();
        saveEdit();
      } else if (e.key === "Escape") {
        e.preventDefault();
        editingId = null;
      }
    } else if (groupFormOpen && costSelected.size > 0) {
      if (submit) {
        e.preventDefault();
        createGroupCostLine();
      } else if (e.key === "Escape") {
        e.preventDefault();
        groupFormOpen = false;
      }
    } else if (addingUnder !== null) {
      if (e.key === "Escape") {
        e.preventDefault();
        addingUnder = null;
      } else if (submit) {
        e.preventDefault();
        if (nMode === "cost") addItem();
        else if (poLines.length > 0) openPicker();
      }
    }
  }}
/>

<div class="space-y-4">
  <a href="/deliveries" class="text-sm text-primary hover:underline">{t("deliveryDetail.backToDeliveries")}</a>

  {#if error}
    <p class="text-sm text-destructive">{error}</p>
  {/if}

  {#if $Detail.fetching && !delivery}
    <p class="text-sm text-muted-foreground">{t("common.loading")}</p>
  {:else if $Detail.errors?.length}
    <p class="text-sm text-destructive">{$Detail.errors[0].message}</p>
  {:else if !delivery}
    <p class="text-sm text-muted-foreground">{t("deliveryDetail.notFound")}</p>
  {:else}
    <!-- Header -->
    <div class="rounded-lg border bg-card p-4">
      <div class="flex items-start justify-between gap-4">
        <div class="flex-1">
          {#if editingHeader}
            <div class="grid grid-cols-3 gap-3">
              <label class="space-y-1">
                <span class="text-sm font-medium">{t("common.date")}</span>
                <Input type="date" bind:value={hDate} />
              </label>
              <label class="space-y-1">
                <span class="text-sm font-medium">{t("deliveries.biller")}</span>
                <Input bind:value={hBiller} />
              </label>
              {#if !isTransit}
                <label class="space-y-1">
                  <span class="text-sm font-medium">{t("deliveries.targetLocation")}</span>
                  <Combobox
                    options={locationOptions}
                    bind:value={hTargetLocationId}
                    placeholder={t("deliveries.searchLocation")}
                  />
                </label>
              {/if}
            </div>
            <div class="mt-3 flex gap-2">
              <Button size="sm" disabled={busy} onclick={saveHeader}>{t("common.save")}</Button>
              <Button
                variant="ghost"
                size="sm"
                disabled={busy}
                onclick={() => (editingHeader = false)}>{t("common.cancel")}</Button
              >
            </div>
          {:else}
            <h1 class="text-xl font-semibold">
              {isTransit ? t("deliveryDetail.transitNote") : t("deliveryDetail.delivery")}
              {fmtDate(delivery.date)}
            </h1>
            <p class="text-sm text-muted-foreground">
              {delivery.biller ?? t("deliveryDetail.noBiller")}{#if !isTransit}
                &nbsp;→ {(delivery.targetLocationId
                  ? locationPaths.get(delivery.targetLocationId)
                  : null) ??
                  delivery.targetLocation?.name ??
                  "—"}{/if}
              {#if delivery.deliveredAt}
                · {isTransit ? t("deliveryDetail.committed") : t("deliveryDetail.delivered")} {fmtDate(delivery.deliveredAt)}
              {/if}
            </p>
            {#if delivery.purchaseId}
              <p class="text-xs text-muted-foreground">
                {t("deliveryDetail.receivingCheckForPo")}
                <a
                  href={`/purchases/${delivery.purchaseId}`}
                  class="font-mono text-primary hover:underline"
                >
                  {delivery.purchaseId.slice(-8)}
                </a>
              </p>
            {/if}
          {/if}
        </div>

        <div class="flex flex-col items-end gap-2">
          <div class="flex gap-1">
            {#if isTransit}
              <Badge class="bg-violet-100 text-violet-700">{t("deliveries.transit")}</Badge>
            {/if}
            <Badge class={statusBadge(delivery.status)}>{t(`deliveries.status.${delivery.status}`)}</Badge>
          </div>
          <p class="text-xs text-muted-foreground">
            {#if isTransit}
              {t("deliveryDetail.freight", { amount: formatMoney(costSummary.charges) })}
            {:else}
              {t("deliveryDetail.total", { amount: formatMoney(costSummary.total) })}
            {/if}
          </p>
        </div>
      </div>

      {#if isDraft && inertCharges.length > 0}
        <div class="mt-3 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-800">
          {t("deliveryDetail.inertCharges", { list: inertCharges.map((c) => c.description).join(", ") })}
        </div>
      {/if}

      <!-- Lifecycle actions -->
      <div class="mt-3 flex flex-wrap gap-2 border-t pt-3">
        {#if isDraft}
          {#if !editingHeader && editable}
            <Button size="sm" variant="outline" onclick={startHeaderEdit}>
              {t("deliveryDetail.editHeader")}
            </Button>
          {/if}
          <Button
            size="sm"
            disabled={busy || !canCommit || items.length === 0}
            onclick={commit}>{isTransit ? t("deliveryDetail.commitTransit") : t("deliveryDetail.commitDelivery")}</Button
          >
          <Button
            size="sm"
            variant="destructive"
            disabled={busy || !canDraft}
            onclick={deleteDraft}>{t("deliveryDetail.discardDraft")}</Button
          >
        {:else if delivery.status === "delivered"}
          <Button
            size="sm"
            variant="destructive"
            disabled={busy || !canCancel}
            onclick={cancelDelivered}>{t("deliveryDetail.reverseDelivery")}</Button
          >
        {/if}
      </div>
    </div>

    <!-- Cost tree -->
    <div class="rounded-lg border bg-card p-4">
      <div class="mb-1 flex items-center justify-between">
        <h2 class="text-sm font-semibold">{t("deliveryDetail.costTree")}</h2>
        {#if editable}
          <div class="flex items-center gap-2">
            {#if costSelected.size > 0}
              <span class="text-xs text-muted-foreground">
                {t("common.selected", { count: costSelected.size })}
              </span>
              <Button size="sm" onclick={startGroupForm}>
                {t("deliveryDetail.newCostLineForSelected")}
              </Button>
              <Button size="sm" variant="ghost" disabled={busy} onclick={clearGroupSelect}>
                {t("common.clear")}
              </Button>
            {/if}
            <Button size="sm" variant="outline" onclick={() => startAdd("")}>
              {t("deliveryDetail.addLine")}
            </Button>
          </div>
        {/if}
      </div>
      <p class="mb-3 text-xs text-muted-foreground">
        {@html t("deliveryDetail.costTreeHelp")}
      </p>

      {#if groupFormOpen && costSelected.size > 0}
        <div class="mb-3 flex items-center gap-2 rounded-md border bg-muted/30 p-3">
          <span class="whitespace-nowrap text-xs text-muted-foreground">
            {t("deliveryDetail.newChargeOver", { count: costSelected.size })}
          </span>
          <Input
            bind:value={gDesc}
            class="flex-1"
            placeholder={t("deliveryDetail.costDescriptionOptional")}
          />
          <MoneyInput
            bind:value={gCost}
            autofocus
            class="w-32"
            placeholder={t("common.amount")}
          />
          <div class="w-40">
            <Combobox
              options={[{ value: "", label: t("deliveryDetail.noCourier") }, ...courierOptions]}
              bind:value={gVendorId}
              placeholder={t("deliveryDetail.searchCourier")}
            />
          </div>
          <Button
            size="sm"
            disabled={busy || gCost == null}
            onclick={createGroupCostLine}>{t("common.create")}</Button
          >
          <Button
            size="sm"
            variant="ghost"
            disabled={busy}
            onclick={() => (groupFormOpen = false)}>{t("common.cancel")}</Button
          >
        </div>
      {/if}

      {#if addingUnder === ""}
        {@render addForm()}
      {/if}

      {#if items.length === 0}
        <p class="text-sm text-muted-foreground">
          {editable ? t("deliveryDetail.noLinesYetHint") : t("deliveryDetail.noLinesYet")}
        </p>
      {:else}
        <ul class="space-y-1">
          {#each tree as node (node.item.id)}
            {@render renderNode(node, 0)}
          {/each}
        </ul>

        <!-- Reconciliation summary. Arrival: goods + charges + transit pickup
             = what lands into stock. Transit: only the freight is billed here;
             goods value is carried for allocation reference only. -->
        <dl class="mt-4 ml-auto w-full max-w-xs space-y-1 border-t pt-3 text-sm">
          {#if isTransit}
            <div class="flex justify-between text-muted-foreground">
              <dt>{t("deliveryDetail.goodsValueBasis")}</dt>
              <dd class="tabular-nums">{formatMoney(costSummary.goods)}</dd>
            </div>
            <div class="flex justify-between border-t pt-1 font-semibold">
              <dt>{t("deliveryDetail.freightBanked")}</dt>
              <dd class="tabular-nums">{formatMoney(costSummary.charges)}</dd>
            </div>
          {:else}
            <div class="flex justify-between text-muted-foreground">
              <dt>{t("deliveryDetail.goodsValue")}</dt>
              <dd class="tabular-nums">{formatMoney(costSummary.goods)}</dd>
            </div>
            <div class="flex justify-between text-muted-foreground">
              <dt>{t("deliveryDetail.freightCustoms")}</dt>
              <dd class="tabular-nums">{formatMoney(costSummary.charges)}</dd>
            </div>
            {#if costSummary.transit > 0}
              <div class="flex justify-between text-muted-foreground">
                <dt>{t("deliveryDetail.transitCostPickup")}</dt>
                <dd class="tabular-nums">{formatMoney(costSummary.transit)}</dd>
              </div>
            {/if}
            <div class="flex justify-between border-t pt-1 font-semibold">
              <dt>{t("deliveryDetail.totalLandedCost")}</dt>
              <dd class="tabular-nums">{formatMoney(costSummary.total)}</dd>
            </div>
          {/if}
        </dl>
      {/if}
    </div>
  {/if}
</div>

{#if pickerOpen}
  <!-- PO-line picker. Step 1: pick a purchase. Step 2: tick its lines and set
       qty. Selections accumulate across purchases; all are added at once. -->
  <button
    type="button"
    aria-label={t("common.close")}
    class="fixed inset-0 z-40 cursor-default bg-black/40"
    onclick={() => (pickerOpen = false)}
  ></button>
  <div
    class="fixed left-1/2 top-1/2 z-50 flex max-h-[80vh] w-[44rem] max-w-[92vw] -translate-x-1/2 -translate-y-1/2 flex-col rounded-lg border bg-card shadow-xl"
    role="dialog"
    aria-modal="true"
  >
    <div class="flex items-center gap-3 border-b p-4">
      {#if pickerPoId}
        <Button
          variant="ghost"
          size="sm"
          class="shrink-0"
          onclick={() => (pickerPoId = "")}>{t("deliveryDetail.backToPurchases")}</Button
        >
      {/if}
      <div>
        <h2 class="text-sm font-semibold">
          {pickerPoId ? pickerPoName : t("deliveryDetail.addGoodsLines")}
        </h2>
        <p class="text-xs text-muted-foreground">
          {pickerPoId ? t("deliveryDetail.tickLinesToReceive") : t("deliveryDetail.intoParent", { name: pickerParentLabel })}
        </p>
      </div>
    </div>

    <div class="flex-1 overflow-y-auto">
      {#if !pickerPoId}
        <!-- Step 1: pick a purchase. Search filters by vendor; each row shows
             the remaining value so the clerk sees what a PO is still worth. -->
        {#if poGroups.length === 0}
          <p class="p-6 text-center text-sm text-muted-foreground">
            {t("deliveryDetail.noOpenPurchases")}
          </p>
        {:else}
          {#if poGroups.length > 1}
            <div class="border-b p-2">
              <Input
                bind:value={pickerSearch}
                placeholder={t("deliveryDetail.searchPurchases")}
              />
            </div>
          {/if}
          {#if filteredPoGroups.length === 0}
            <p class="p-6 text-center text-sm text-muted-foreground">
              {t("deliveryDetail.noMatches")}
            </p>
          {:else}
            <ul class="divide-y">
              {#each filteredPoGroups as g (g.id)}
                {@const picked = selectedByPo.get(g.id) ?? 0}
                <li>
                  <button
                    type="button"
                    class="flex w-full items-center justify-between gap-3 px-4 py-2 text-left hover:bg-muted/40"
                    onclick={() => {
                      pickerPoId = g.id;
                      pickerLineSearch = "";
                    }}
                  >
                    <span class="min-w-0">
                      <span class="block truncate text-sm font-medium">{g.vendorName}</span>
                      <span class="block text-xs text-muted-foreground">
                        {t("deliveryDetail.poLinesLeft", { id: g.id.slice(-6), count: g.count })}
                      </span>
                    </span>
                    <span class="flex shrink-0 items-center gap-2 text-xs text-muted-foreground">
                      <span class="tabular-nums">{formatMoney(g.totalMinor)}</span>
                      {#if picked > 0}
                        <Badge class="bg-primary/10 text-primary">{t("deliveryDetail.picked", { count: picked })}</Badge>
                      {/if}
                      <span aria-hidden="true">›</span>
                    </span>
                  </button>
                </li>
              {/each}
            </ul>
          {/if}
        {/if}
      {:else}
        <!-- Step 2: tick the chosen purchase's lines -->
        <div class="border-b p-2">
          <Input
            bind:value={pickerLineSearch}
            placeholder={t("deliveryDetail.searchLines")}
          />
        </div>
        <table class="w-full text-sm">
          <thead
            class="sticky top-0 border-b bg-muted text-left text-xs text-muted-foreground"
          >
            <tr>
              <th class="w-8 px-3 py-1.5">
                <input
                  type="checkbox"
                  checked={allPicked}
                  indeterminate={somePicked}
                  onchange={toggleAllPicker}
                  class="h-4 w-4"
                  title={t("deliveryDetail.selectAllLines")}
                />
              </th>
              <th class="px-3 py-1.5 font-medium">{t("deliveryDetail.poLine")}</th>
              <th class="px-3 py-1.5 text-right font-medium">{t("deliveryDetail.left")}</th>
              <th class="px-3 py-1.5 text-right font-medium">{t("deliveryDetail.unitCost")}</th>
              <th class="w-24 px-3 py-1.5 text-right font-medium">{t("common.qty")}</th>
              <th class="w-28 px-3 py-1.5 text-right font-medium">{t("deliveryDetail.lineTotal")}</th>
            </tr>
          </thead>
          <tbody>
            {#each filteredPickerLines as l (l.itemId)}
              {@const sel = l.itemId in pickerQty}
              {@const q = pickerQty[l.itemId] ?? ""}
              {@const qNum = Number(q)}
              {@const over =
                sel && Number.isFinite(qNum) && qNum > l.remaining}
              {@const lineQty = sel && Number.isFinite(qNum) ? qNum : l.remaining}
              <tr
                class="border-b last:border-0 hover:bg-muted/40 {sel ? 'bg-primary/5' : ''}"
              >
                <td class="px-3 py-1.5">
                  <input
                    type="checkbox"
                    checked={sel}
                    onchange={() => togglePick(l)}
                    class="h-4 w-4"
                  />
                </td>
                <td class="px-3 py-1.5">
                  <button
                    type="button"
                    class="text-left hover:underline"
                    onclick={() => togglePick(l)}
                  >
                    <span class="block text-[13px] font-medium">{l.productName}</span>
                    {#if l.sku}
                      <span class="block text-xs font-normal text-muted-foreground">
                        {l.sku}
                      </span>
                    {/if}
                  </button>
                </td>
                <td class="px-3 py-1.5 text-right tabular-nums">{l.remaining}</td>
                <td class="px-3 py-1.5 text-right tabular-nums">
                  {formatMoney(l.unitCostMinor)}
                </td>
                <td class="px-3 py-1.5 text-right">
                  {#if sel}
                    <input
                      inputmode="numeric"
                      value={q}
                      autocomplete="off"
                      oninput={(e) => setPickQty(l.itemId, e.currentTarget.value)}
                      class="h-7 w-20 rounded-md border bg-background px-2 text-right text-sm {over
                        ? 'border-amber-500'
                        : 'border-input'}"
                    />
                  {:else}
                    <span class="text-xs text-muted-foreground">—</span>
                  {/if}
                </td>
                <td class="px-3 py-1.5 text-right tabular-nums">
                  {formatMoney(l.unitCostMinor * lineQty)}
                </td>
              </tr>
            {/each}
            {#if filteredPickerLines.length === 0}
              <tr>
                <td colspan="6" class="px-4 py-6 text-center text-sm text-muted-foreground">
                  {t("deliveryDetail.noMatches")}
                </td>
              </tr>
            {/if}
          </tbody>
        </table>
      {/if}
    </div>

    <div class="flex items-center justify-between gap-3 border-t p-4">
      <div>
        <p class="text-sm text-muted-foreground">
          {t("deliveryDetail.selectedAmount", { count: pickerSelected.length, amount: formatMoney(pickerTotal) })}
        </p>
        <p class="text-xs text-muted-foreground">{t("deliveryDetail.ctrlEnterHint")}</p>
      </div>
      <div class="flex gap-2">
        <Button
          variant="ghost"
          size="sm"
          disabled={busy}
          onclick={() => (pickerOpen = false)}>{t("common.cancel")}</Button
        >
        <Button size="sm" disabled={busy || !pickerValid} onclick={confirmPicker}>
          {t("deliveryDetail.addLines", { count: pickerSelected.length || 0 })}
        </Button>
      </div>
    </div>
  </div>
{/if}

{#snippet renderNode(node: Node, depth: number)}
  {@const parts = goodsParts(node.item)}
  <li>
    <div
      class="flex items-center gap-2 rounded-md px-2 py-1.5 hover:bg-muted/40"
      style:padding-left="{depth * 1.25 + 0.5}rem"
    >
      {#if editingId === node.item.id}
        {#if eIsLeaf}
          <span class="min-w-0 flex-1 text-sm">
            <span class="block truncate">{parts?.name ?? node.item.description}</span>
            {#if parts}
              <span class="block truncate text-xs text-muted-foreground">
                {parts.sku}
              </span>
            {/if}
          </span>
          <Input bind:value={eQty} class="w-24" inputmode="numeric" placeholder={t("common.qty")} />
          <span class="w-32 text-right text-sm">
            {formatMoney(eUnitCost * (eGoodsValid ? eGoodsQty : 0))}
          </span>
        {:else}
          <Input
            bind:value={eDesc}
            class="flex-1"
            placeholder={t("deliveryDetail.costDescriptionOptional")}
          />
          <MoneyInput bind:value={eCost} autofocus class="w-32" />
          <div class="w-36">
            <Combobox
              options={[{ value: "", label: t("deliveryDetail.noCourier") }, ...courierOptions]}
              bind:value={eVendorId}
              placeholder={t("deliveryDetail.searchCourier")}
            />
          </div>
        {/if}
        <Select bind:value={eParentId} class="w-36" title={t("deliveryDetail.nestUnderCost")}>
          <option value="">{t("deliveryDetail.topLevelOption")}</option>
          {#each moveTargets as t (t.value)}
            <option value={t.value}>↳ {t.label}</option>
          {/each}
        </Select>
        <Button size="sm" disabled={busy} onclick={saveEdit}>{t("common.save")}</Button>
        <Button
          size="sm"
          variant="ghost"
          disabled={busy}
          onclick={() => (editingId = null)}>{t("common.cancel")}</Button
        >
      {:else}
        {#if editable && node.item.purchaseItemId}
          <input
            type="checkbox"
            class="size-4 cursor-pointer rounded border-input accent-primary"
            checked={costSelected.has(node.item.id)}
            onchange={() => toggleCostSelect(node.item.id)}
            aria-label={t("deliveryDetail.selectGoodsLine")}
          />
        {/if}
        <span class="min-w-0 flex-1 text-sm">
          <span class="block truncate">
            {parts?.name ?? node.item.description}
            {#if node.item.purchaseItem}
              {@const pi = node.item.purchaseItem}
              {@const over =
                isDraft && pi.qtyDelivered + (node.item.qty ?? 0) > pi.qtyOrdered}
              <span
                class="ml-1 text-xs {over ? 'text-amber-600' : 'text-muted-foreground'}"
                title={t("deliveryDetail.receivedOfOrdered")}
              >
                · PO {pi.qtyDelivered}{#if isDraft && node.item.qty}&nbsp;+{node.item
                    .qty}{/if} / {pi.qtyOrdered}
              </span>
            {:else if node.item.purchaseItemId}
              <span class="ml-1 text-xs text-muted-foreground">
                · {t("deliveryDetail.poLine")} {node.item.purchaseItemId.slice(-6)}
              </span>
            {:else if node.item.vendor}
              <Badge class="ml-1 bg-sky-100 text-xs text-sky-700">
                → {node.item.vendor.name}
              </Badge>
            {/if}
          </span>
          {#if parts}
            <span class="block truncate text-xs text-muted-foreground">
              {parts.sku}
            </span>
          {/if}
        </span>
        {#if node.item.qty != null}
          <span class="text-xs text-muted-foreground">×{node.item.qty}</span>
        {/if}
        <span class="w-32 text-right text-sm">
          {formatMoney(node.item.costMinor)}
        </span>
        {#if node.item.purchaseItemId}
          {@const ld = landingByItem.get(node.item.id)}
          {#if ld?.isStock && isTransit}
            <!-- A transit leaf receives nothing — its freight share banks to
                 the PO line's transit pool, picked up at arrival. -->
            <span
              class="w-40 text-right text-xs {ld.freightMinor > 0
                ? 'text-violet-700'
                : 'text-muted-foreground'}"
              title={t("deliveryDetail.freightShareTitle")}
            >
              {t("deliveryDetail.banks", { amount: formatMoney(ld.freightMinor) })}
            </span>
          {:else if ld?.isStock}
            <span
              class="w-40 text-right text-xs {ld.freightMinor > 0 ||
              ld.transitFreightMinor > 0
                ? 'text-emerald-700'
                : 'text-muted-foreground'}"
              title={t("deliveryDetail.landedUnitTitle")}
            >
              {t("deliveryDetail.landedUnit", { amount: formatMoney(ld.landedUnitCostMinor) })}
            </span>
          {:else}
            <span class="w-40"></span>
          {/if}
        {:else}
          <span class="w-40"></span>
        {/if}
        {#if editable}
          {#if !node.item.purchaseItemId}
            <Button
              size="sm"
              variant="ghost"
              title={t("deliveryDetail.addLineUnder")}
              onclick={() => startAdd(node.item.id)}>+</Button
            >
          {/if}
          <Button size="sm" variant="ghost" onclick={() => startEdit(node.item)}>
            ✎
          </Button>
          <Button
            size="sm"
            variant="ghost"
            class="text-destructive"
            onclick={() => removeItem(node.item.id)}>×</Button
          >
        {/if}
      {/if}
    </div>

    {#if addingUnder === node.item.id}
      <div style:margin-left="{(depth + 1) * 1.25}rem">
        {@render addForm()}
      </div>
    {/if}

    {#if node.children.length > 0}
      <ul class="space-y-1">
        {#each node.children as child (child.item.id)}
          {@render renderNode(child, depth + 1)}
        {/each}
      </ul>
    {/if}
  </li>
{/snippet}

{#snippet addForm()}
  <div class="my-1 space-y-2 rounded-md border bg-muted/40 p-3">
    <div class="flex gap-1">
      <Button
        size="sm"
        variant={nMode === "goods" ? "default" : "outline"}
        onclick={() => (nMode = "goods")}>{t("deliveryDetail.goodsLine")}</Button
      >
      <Button
        size="sm"
        variant={nMode === "cost" ? "default" : "outline"}
        onclick={() => (nMode = "cost")}>{t("deliveryDetail.costLineButton")}</Button
      >
    </div>

    {#if nMode === "goods"}
      <div class="flex items-center gap-2">
        <Button size="sm" disabled={busy || poLines.length === 0} onclick={openPicker}>
          {t("deliveryDetail.choosePoLines")}
        </Button>
        <Button
          size="sm"
          variant="ghost"
          disabled={busy}
          onclick={() => (addingUnder = null)}>{t("common.cancel")}</Button
        >
        {#if poLines.length === 0}
          <span class="text-xs text-muted-foreground">
            {t("deliveryDetail.noOpenPoLines")}
          </span>
        {/if}
      </div>
    {:else}
      <div class="flex items-end gap-2">
        <label class="flex-1 space-y-1">
          <span class="text-xs font-medium">{t("deliveryDetail.costDescriptionOptional")}</span>
          <Input bind:value={nDesc} placeholder={t("deliveryDetail.freightCustomsPlaceholder")} />
        </label>
        <label class="w-40 space-y-1">
          <span class="text-xs font-medium">{t("deliveryDetail.costRp")}</span>
          <MoneyInput bind:value={nCost} autofocus />
        </label>
        <label class="w-40 space-y-1">
          <span class="text-xs font-medium">{t("deliveryDetail.courierAp")}</span>
          <Combobox
            options={[{ value: "", label: t("deliveryDetail.none") }, ...courierOptions]}
            bind:value={nVendorId}
            placeholder={t("deliveryDetail.searchCourier")}
          />
        </label>
        <Button
          size="sm"
          disabled={busy || nCost == null}
          onclick={addItem}>{t("common.add")}</Button
        >
        <Button
          size="sm"
          variant="ghost"
          disabled={busy}
          onclick={() => (addingUnder = null)}>{t("common.cancel")}</Button
        >
      </div>
      <p class="text-xs text-muted-foreground">{t("deliveryDetail.ctrlEnterHint")}</p>
    {/if}
  </div>
{/snippet}
