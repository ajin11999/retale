<script lang="ts">
  import { graphql, CachePolicy } from "$houdini";
  import { page } from "$app/state";
  import type { Viewer } from "../../+layout.server";
  import { formatMoney } from "$lib/utils";
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
          sortOrder
          purchaseItem { id qtyOrdered qtyDelivered }
        }
        leafLandings {
          itemId
          landedUnitCostMinor
          freightMinor
          isStock
        }
      }
      locations(includeArchived: false) {
        id
        name
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
      id ? (m.get(id) ?? fallback ?? "Unknown") : (fallback ?? "—");
  });

  // PO lines still owing goods, across every open purchase — the goods picker.
  // A delivery can draw lines from several purchases; `remaining` is what's left
  // to receive on the PO (this draft's own staged qty is enforced at commit).
  type PoLine = {
    itemId: string;
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
        out.push({
          itemId: it.id,
          label: `${p.snapshotVendorName} · ${variantLabel(it.variantId, it.description)}`,
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
  const poLineOptions = $derived(
    poLines.map((l) => ({
      value: l.itemId,
      label: `${l.label} · ${l.remaining} left @ ${formatMoney(l.unitCostMinor)}`,
    })),
  );

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
  // server's denormalized `totalCostMinor` (roots only), which under-reports when
  // goods are nested under a cost node.
  const costSummary = $derived.by(() => {
    let goods = 0;
    let charges = 0;
    for (const it of items) {
      if (it.purchaseItemId != null) goods += it.costMinor;
      else charges += it.costMinor;
    }
    return { goods, charges, total: goods + charges };
  });

  const viewer = $derived(page.data.user as Viewer | undefined);
  const has = (key: string) => !!viewer && viewer.permissions.includes(key);
  const canDraft = $derived(has("delivery.draft"));
  const canCommit = $derived(has("delivery.commit"));
  const canCancel = $derived(has("delivery.cancel"));

  const isDraft = $derived(delivery?.status === "draft");
  const editable = $derived(isDraft && canDraft);

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

  // ---- Header editing ------------------------------------------------------
  let editingHeader = $state(false);
  let hDate = $state("");
  let hBiller = $state("");
  let hTargetLocationId = $state("");

  function startHeaderEdit() {
    if (!delivery) return;
    hDate = delivery.date.slice(0, 10);
    hBiller = delivery.biller ?? "";
    hTargetLocationId = delivery.targetLocationId;
    editingHeader = true;
  }

  let busy = $state(false);
  let error = $state<string | null>(null);

  async function saveHeader() {
    if (!delivery) return;
    busy = true;
    error = null;
    try {
      const res = await UpdateDelivery.mutate({
        id: delivery.id,
        date: hDate,
        biller: hBiller.trim() || null,
        targetLocationId: hTargetLocationId,
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
  let nQty = $state<string>("");
  let nVendorId = $state("");
  let nPoLineId = $state("");

  function startAdd(parentId: string | "") {
    addingUnder = parentId;
    nMode = "goods";
    nDesc = "";
    nCost = null;
    nQty = "";
    nVendorId = "";
    nPoLineId = "";
  }

  // The PO line currently picked in the goods form, and the staged value
  // (unit cost × qty) it would receive at — what gets stored as the leaf cost.
  const nPoLine = $derived(nPoLineId ? poLineById.get(nPoLineId) : undefined);
  const nGoodsQty = $derived(nQty.trim() ? Number(nQty) : NaN);
  const nGoodsValid = $derived(
    !!nPoLine && Number.isInteger(nGoodsQty) && nGoodsQty > 0,
  );
  const nGoodsValue = $derived(
    nPoLine && Number.isFinite(nGoodsQty) ? nPoLine.unitCostMinor * nGoodsQty : 0,
  );

  async function addItem() {
    if (!delivery || addingUnder === null) return;
    const parentItemId = addingUnder === "" ? null : addingUnder;
    busy = true;
    error = null;
    try {
      let res;
      if (nMode === "goods") {
        if (!nGoodsValid || !nPoLine) return;
        res = await CreateDeliveryItem.mutate({
          deliveryId: delivery.id,
          parentItemId,
          purchaseItemId: nPoLineId,
          description: nPoLine.label,
          qty: nGoodsQty,
          costMinor: nGoodsValue,
        });
      } else {
        if (!nDesc.trim() || nCost == null) return;
        res = await CreateDeliveryItem.mutate({
          deliveryId: delivery.id,
          parentItemId,
          description: nDesc.trim(),
          costMinor: nCost,
          vendorId: nVendorId || null,
        });
      }
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
    eUnitCost = eIsLeaf && it.qty ? Math.round(it.costMinor / it.qty) : 0;
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
          costMinor: eUnitCost * eGoodsQty,
          parentItemId: eParentId || null,
        });
      } else {
        if (!eDesc.trim() || eCost == null) return;
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
    if (!confirm("Delete this line? Any lines nested under it move up to its parent.")) return;
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

  // ---- Lifecycle: commit / cancel / delete --------------------------------
  async function commit() {
    if (!delivery) return;
    if (
      !confirm(
        "Commit this delivery? Stock will be received and product costs " +
          "may be recomputed — this cannot be edited afterwards.",
      )
    ) {
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
    if (!confirm("Reverse this delivery? Stock will be returned.")) return;
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
    if (!confirm("Discard this draft delivery?")) return;
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
    iso ? new Date(iso).toLocaleDateString("id-ID") : "—";

  function statusBadge(s: string) {
    if (s === "delivered") return "bg-emerald-100 text-emerald-700";
    if (s === "cancelled") return "bg-destructive/10 text-destructive";
    return "bg-amber-100 text-amber-800";
  }
</script>

<svelte:head><title>Delivery · Retale Console</title></svelte:head>

<div class="space-y-4">
  <a href="/deliveries" class="text-sm text-primary hover:underline">← All deliveries</a>

  {#if error}
    <p class="text-sm text-destructive">{error}</p>
  {/if}

  {#if $Detail.fetching && !delivery}
    <p class="text-sm text-muted-foreground">Loading…</p>
  {:else if $Detail.errors?.length}
    <p class="text-sm text-destructive">{$Detail.errors[0].message}</p>
  {:else if !delivery}
    <p class="text-sm text-muted-foreground">Delivery not found.</p>
  {:else}
    <!-- Header -->
    <div class="rounded-lg border bg-card p-4">
      <div class="flex items-start justify-between gap-4">
        <div class="flex-1">
          {#if editingHeader}
            <div class="grid grid-cols-3 gap-3">
              <label class="space-y-1">
                <span class="text-sm font-medium">Date</span>
                <Input type="date" bind:value={hDate} />
              </label>
              <label class="space-y-1">
                <span class="text-sm font-medium">Biller</span>
                <Input bind:value={hBiller} />
              </label>
              <label class="space-y-1">
                <span class="text-sm font-medium">Target location</span>
                <Select bind:value={hTargetLocationId}>
                  {#each locations as l (l.id)}
                    <option value={l.id}>{l.name}</option>
                  {/each}
                </Select>
              </label>
            </div>
            <div class="mt-3 flex gap-2">
              <Button size="sm" disabled={busy} onclick={saveHeader}>Save</Button>
              <Button
                variant="ghost"
                size="sm"
                disabled={busy}
                onclick={() => (editingHeader = false)}>Cancel</Button
              >
            </div>
          {:else}
            <h1 class="text-xl font-semibold">
              Delivery {fmtDate(delivery.date)}
            </h1>
            <p class="text-sm text-muted-foreground">
              {delivery.biller ?? "No biller"} → {delivery.targetLocation?.name ?? "—"}
              {#if delivery.deliveredAt}
                · delivered {fmtDate(delivery.deliveredAt)}
              {/if}
            </p>
            {#if delivery.purchaseId}
              <p class="text-xs text-muted-foreground">
                Receiving check for PO
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
          <Badge class={statusBadge(delivery.status)}>{delivery.status}</Badge>
          <p class="text-xs text-muted-foreground">
            Total {formatMoney(costSummary.total)}
          </p>
        </div>
      </div>

      <!-- Lifecycle actions -->
      <div class="mt-3 flex flex-wrap gap-2 border-t pt-3">
        {#if isDraft}
          {#if !editingHeader && editable}
            <Button size="sm" variant="outline" onclick={startHeaderEdit}>
              Edit header
            </Button>
          {/if}
          <Button
            size="sm"
            disabled={busy || !canCommit || items.length === 0}
            onclick={commit}>Commit delivery</Button
          >
          <Button
            size="sm"
            variant="destructive"
            disabled={busy || !canDraft}
            onclick={deleteDraft}>Discard draft</Button
          >
        {:else if delivery.status === "delivered"}
          <Button
            size="sm"
            variant="destructive"
            disabled={busy || !canCancel}
            onclick={cancelDelivered}>Reverse delivery</Button
          >
        {/if}
      </div>
    </div>

    <!-- Cost tree -->
    <div class="rounded-lg border bg-card p-4">
      <div class="mb-1 flex items-center justify-between">
        <h2 class="text-sm font-semibold">Cost tree</h2>
        {#if editable}
          <Button size="sm" variant="outline" onclick={() => startAdd("")}>
            Add line
          </Button>
        {/if}
      </div>
      <p class="mb-3 text-xs text-muted-foreground">
        Add goods lines from any open PO, and freight / customs cost lines. A
        cost line spreads by value <em>only over the goods nested under it</em> —
        edit a goods line and pick a cost line under <em>Move to</em> to apply
        that charge to it. Goods left at the top level carry no freight. Each
        product shows its landed unit cost (→ /unit).
      </p>

      {#if addingUnder === ""}
        {@render addForm()}
      {/if}

      {#if items.length === 0}
        <p class="text-sm text-muted-foreground">
          No lines yet{editable ? " — add a goods or cost line to get started." : "."}
        </p>
      {:else}
        <ul class="space-y-1">
          {#each tree as node (node.item.id)}
            {@render renderNode(node, 0)}
          {/each}
        </ul>

        <!-- Reconciliation summary: goods + charges = what lands into stock. -->
        <dl class="mt-4 ml-auto w-full max-w-xs space-y-1 border-t pt-3 text-sm">
          <div class="flex justify-between text-muted-foreground">
            <dt>Goods value</dt>
            <dd class="tabular-nums">{formatMoney(costSummary.goods)}</dd>
          </div>
          <div class="flex justify-between text-muted-foreground">
            <dt>Freight &amp; customs</dt>
            <dd class="tabular-nums">{formatMoney(costSummary.charges)}</dd>
          </div>
          <div class="flex justify-between border-t pt-1 font-semibold">
            <dt>Total landed cost</dt>
            <dd class="tabular-nums">{formatMoney(costSummary.total)}</dd>
          </div>
        </dl>
      {/if}
    </div>
  {/if}
</div>

{#snippet renderNode(node: Node, depth: number)}
  <li>
    <div
      class="flex items-center gap-2 rounded-md px-2 py-1.5 hover:bg-muted/40"
      style:padding-left="{depth * 1.25 + 0.5}rem"
    >
      {#if editingId === node.item.id}
        {#if eIsLeaf}
          <span class="flex-1 truncate text-sm">{node.item.description}</span>
          <Input bind:value={eQty} class="w-24" inputmode="numeric" placeholder="qty" />
          <span class="w-32 text-right text-sm">
            {formatMoney(eUnitCost * (eGoodsValid ? eGoodsQty : 0))}
          </span>
        {:else}
          <Input bind:value={eDesc} class="flex-1" />
          <MoneyInput bind:value={eCost} class="w-32" />
          <Select bind:value={eVendorId} class="w-36">
            <option value="">— No courier —</option>
            {#each couriers as c (c.id)}
              <option value={c.id}>{c.name}</option>
            {/each}
          </Select>
        {/if}
        <Select bind:value={eParentId} class="w-36" title="Nest this line under a cost line">
          <option value="">↳ Top level</option>
          {#each moveTargets as t (t.value)}
            <option value={t.value}>↳ {t.label}</option>
          {/each}
        </Select>
        <Button size="sm" disabled={busy} onclick={saveEdit}>Save</Button>
        <Button
          size="sm"
          variant="ghost"
          disabled={busy}
          onclick={() => (editingId = null)}>Cancel</Button
        >
      {:else}
        <span class="flex-1 truncate text-sm">
          {node.item.description}
          {#if node.item.purchaseItem}
            {@const pi = node.item.purchaseItem}
            {@const over =
              isDraft && pi.qtyDelivered + (node.item.qty ?? 0) > pi.qtyOrdered}
            <span
              class="ml-1 text-xs {over ? 'text-amber-600' : 'text-muted-foreground'}"
              title="Received of ordered on the linked PO line"
            >
              · PO {pi.qtyDelivered}{#if isDraft && node.item.qty}&nbsp;+{node.item
                  .qty}{/if} / {pi.qtyOrdered}
            </span>
          {:else if node.item.purchaseItemId}
            <span class="ml-1 text-xs text-muted-foreground">
              · PO line {node.item.purchaseItemId.slice(-6)}
            </span>
          {:else if node.item.vendor}
            <Badge class="ml-1 bg-sky-100 text-xs text-sky-700">
              → {node.item.vendor.name}
            </Badge>
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
          {#if ld?.isStock}
            <span
              class="w-40 text-right text-xs {ld.freightMinor > 0
                ? 'text-emerald-700'
                : 'text-muted-foreground'}"
              title="Landed unit cost = line value + freight share"
            >
              → {formatMoney(ld.landedUnitCostMinor)}/unit
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
              title="Add a line under this charge"
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
        onclick={() => (nMode = "goods")}>Goods line</Button
      >
      <Button
        size="sm"
        variant={nMode === "cost" ? "default" : "outline"}
        onclick={() => (nMode = "cost")}>Cost line</Button
      >
    </div>

    {#if nMode === "goods"}
      <div class="flex items-end gap-2">
        <label class="flex-1 space-y-1">
          <span class="text-xs font-medium">PO line</span>
          <Combobox
            options={poLineOptions}
            bind:value={nPoLineId}
            placeholder="Search a purchase line…"
          />
        </label>
        <label class="w-24 space-y-1">
          <span class="text-xs font-medium">Qty</span>
          <Input bind:value={nQty} inputmode="numeric" />
        </label>
        <div class="w-32 space-y-1">
          <span class="text-xs font-medium">Value</span>
          <p class="flex h-9 items-center justify-end rounded-md border bg-background px-3 text-sm">
            {formatMoney(nGoodsValue)}
          </p>
        </div>
        <Button size="sm" disabled={busy || !nGoodsValid} onclick={addItem}>Add</Button>
        <Button
          size="sm"
          variant="ghost"
          disabled={busy}
          onclick={() => (addingUnder = null)}>Cancel</Button
        >
      </div>
      {#if poLineOptions.length === 0}
        <p class="text-xs text-muted-foreground">
          No open PO lines left to receive.
        </p>
      {:else if nPoLine && Number.isFinite(nGoodsQty) && nGoodsQty > nPoLine.remaining}
        <p class="text-xs text-amber-600">
          Only {nPoLine.remaining} left on this PO line — commit rejects more than
          that across the whole delivery.
        </p>
      {/if}
    {:else}
      <div class="flex items-end gap-2">
        <label class="flex-1 space-y-1">
          <span class="text-xs font-medium">Description</span>
          <Input bind:value={nDesc} placeholder="Freight, customs, …" />
        </label>
        <label class="w-40 space-y-1">
          <span class="text-xs font-medium">Cost (Rp)</span>
          <MoneyInput bind:value={nCost} />
        </label>
        <label class="w-40 space-y-1">
          <span class="text-xs font-medium">Courier (AP)</span>
          <Select bind:value={nVendorId}>
            <option value="">— None —</option>
            {#each couriers as c (c.id)}
              <option value={c.id}>{c.name}</option>
            {/each}
          </Select>
        </label>
        <Button
          size="sm"
          disabled={busy || !nDesc.trim() || nCost == null}
          onclick={addItem}>Add</Button
        >
        <Button
          size="sm"
          variant="ghost"
          disabled={busy}
          onclick={() => (addingUnder = null)}>Cancel</Button
        >
      </div>
    {/if}
  </div>
{/snippet}
