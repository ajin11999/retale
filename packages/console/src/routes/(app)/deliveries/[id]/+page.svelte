<script lang="ts">
  import { graphql } from "$houdini";
  import { page } from "$app/state";
  import type { Viewer } from "../../+layout.server";
  import { formatMoney } from "$lib/utils";
  import Badge from "$lib/components/ui/badge.svelte";
  import Button from "$lib/components/ui/button.svelte";
  import Input from "$lib/components/ui/input.svelte";
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
          description
          qty
          costMinor
          sortOrder
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
      $description: String!
      $qty: Float
      $costMinor: Float!
    ) {
      createDeliveryItem(
        deliveryId: $deliveryId
        parentItemId: $parentItemId
        description: $description
        qty: $qty
        costMinor: $costMinor
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
    ) {
      updateDeliveryItem(
        id: $id
        description: $description
        qty: $qty
        costMinor: $costMinor
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
  const items = $derived(delivery?.items ?? []);

  // Server-computed landed cost per leaf, keyed by item id — the same
  // apportionment commit will apply, so the preview can't drift from it.
  const landingByItem = $derived.by(() => {
    type Landing = NonNullable<typeof delivery>["leafLandings"][number];
    const m = new Map<string, Landing>();
    for (const l of delivery?.leafLandings ?? []) m.set(l.itemId, l);
    return m;
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
      await Detail.fetch();
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    } finally {
      busy = false;
    }
  }

  // ---- Item add / edit / delete -------------------------------------------
  // addingUnder: id of the parent (or "" for a root). null means no form open.
  let addingUnder = $state<string | null | "">(null);
  let nDesc = $state("");
  let nCost = $state<string>("");
  let nQty = $state<string>("");

  function startAdd(parentId: string | "") {
    addingUnder = parentId;
    nDesc = "";
    nCost = "";
    nQty = "";
  }

  async function addItem() {
    if (!delivery || addingUnder === null) return;
    const cost = Number(nCost);
    if (!nDesc.trim() || !Number.isFinite(cost)) return;
    const qty = nQty.trim() ? Number(nQty) : null;
    busy = true;
    error = null;
    try {
      const res = await CreateDeliveryItem.mutate({
        deliveryId: delivery.id,
        parentItemId: addingUnder === "" ? null : addingUnder,
        description: nDesc.trim(),
        qty,
        costMinor: Math.round(cost),
      });
      if (res.errors?.length) {
        error = res.errors[0].message;
        return;
      }
      addingUnder = null;
      await Detail.fetch();
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    } finally {
      busy = false;
    }
  }

  let editingId = $state<string | null>(null);
  let eDesc = $state("");
  let eCost = $state<string>("");
  let eQty = $state<string>("");

  function startEdit(it: Item) {
    editingId = it.id;
    eDesc = it.description;
    eCost = String(it.costMinor);
    eQty = it.qty == null ? "" : String(it.qty);
  }

  async function saveEdit() {
    if (!editingId) return;
    const cost = Number(eCost);
    if (!eDesc.trim() || !Number.isFinite(cost)) return;
    const qty = eQty.trim() ? Number(eQty) : null;
    busy = true;
    error = null;
    try {
      const res = await UpdateDeliveryItem.mutate({
        id: editingId,
        description: eDesc.trim(),
        qty,
        costMinor: Math.round(cost),
      });
      if (res.errors?.length) {
        error = res.errors[0].message;
        return;
      }
      editingId = null;
      await Detail.fetch();
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    } finally {
      busy = false;
    }
  }

  async function removeItem(id: string) {
    if (!confirm("Delete this cost line and its children?")) return;
    busy = true;
    error = null;
    try {
      const res = await DeleteDeliveryItem.mutate({ id });
      if (res.errors?.length) {
        error = res.errors[0].message;
        return;
      }
      await Detail.fetch();
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
      await Detail.fetch();
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
      await Detail.fetch();
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
            Total {formatMoney(delivery.totalCostMinor)}
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
            Add root line
          </Button>
        {/if}
      </div>
      <p class="mb-3 text-xs text-muted-foreground">
        Freight / customs cost lines are spread across product lines by value;
        each product shows its landed unit cost (→ /unit).
      </p>

      {#if addingUnder === ""}
        <div class="mb-3 flex items-end gap-2 rounded-md border bg-muted/40 p-3">
          <label class="flex-1 space-y-1">
            <span class="text-xs font-medium">Description</span>
            <Input bind:value={nDesc} />
          </label>
          <label class="w-32 space-y-1">
            <span class="text-xs font-medium">Qty</span>
            <Input bind:value={nQty} inputmode="decimal" />
          </label>
          <label class="w-40 space-y-1">
            <span class="text-xs font-medium">Cost (minor)</span>
            <Input bind:value={nCost} inputmode="numeric" />
          </label>
          <Button size="sm" disabled={busy || !nDesc.trim() || !nCost} onclick={addItem}>
            Add
          </Button>
          <Button
            size="sm"
            variant="ghost"
            disabled={busy}
            onclick={() => (addingUnder = null)}>Cancel</Button
          >
        </div>
      {/if}

      {#if items.length === 0}
        <p class="text-sm text-muted-foreground">
          No cost lines yet{editable ? " — add a root line to get started." : "."}
        </p>
      {:else}
        <ul class="space-y-1">
          {#each tree as node (node.item.id)}
            {@render renderNode(node, 0)}
          {/each}
        </ul>
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
        <Input bind:value={eDesc} class="flex-1" />
        <Input bind:value={eQty} class="w-24" inputmode="decimal" placeholder="qty" />
        <Input bind:value={eCost} class="w-32" inputmode="numeric" />
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
          {#if node.item.purchaseItemId}
            <span class="ml-1 text-xs text-muted-foreground">
              · PO line {node.item.purchaseItemId.slice(-6)}
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
        {#if editable && !node.item.purchaseItemId}
          <Button size="sm" variant="ghost" onclick={() => startAdd(node.item.id)}>
            +
          </Button>
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
      <div
        class="mt-1 flex items-end gap-2 rounded-md border bg-muted/40 p-2"
        style:margin-left="{(depth + 1) * 1.25}rem"
      >
        <label class="flex-1 space-y-1">
          <span class="text-xs font-medium">Description</span>
          <Input bind:value={nDesc} />
        </label>
        <label class="w-24 space-y-1">
          <span class="text-xs font-medium">Qty</span>
          <Input bind:value={nQty} inputmode="decimal" />
        </label>
        <label class="w-32 space-y-1">
          <span class="text-xs font-medium">Cost (minor)</span>
          <Input bind:value={nCost} inputmode="numeric" />
        </label>
        <Button size="sm" disabled={busy || !nDesc.trim() || !nCost} onclick={addItem}>
          Add
        </Button>
        <Button
          size="sm"
          variant="ghost"
          disabled={busy}
          onclick={() => (addingUnder = null)}>Cancel</Button
        >
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
