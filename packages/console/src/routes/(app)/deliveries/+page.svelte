<script lang="ts">
  import { graphql } from "$houdini";
  import { goto } from "$app/navigation";
  import { page } from "$app/state";
  import type { Viewer } from "../+layout.server";
  import { formatMoney, treePathMap } from "$lib/utils";
  import Badge from "$lib/components/ui/badge.svelte";
  import Button from "$lib/components/ui/button.svelte";
  import Combobox from "$lib/components/ui/combobox.svelte";
  import Input from "$lib/components/ui/input.svelte";
  import Select from "$lib/components/ui/select.svelte";
  import type { PageData } from "./$types";

  graphql(`
    query DeliveryList {
      deliveries {
        id
        date
        biller
        targetLocationId
        targetLocation { id name }
        purchaseId
        status
        deliveredAt
        totalCostMinor
        lineCount
      }
      locations(includeArchived: false) {
        id
        name
        parentId
      }
    }
  `);

  const CreateDelivery = graphql(`
    mutation ConsoleCreateDelivery(
      $date: String!
      $biller: String
      $targetLocationId: ID!
    ) {
      createDelivery(
        date: $date
        biller: $biller
        targetLocationId: $targetLocationId
      ) {
        id
      }
    }
  `);

  let { data }: { data: PageData } = $props();
  const DeliveryList = $derived(data.DeliveryList);
  const deliveries = $derived($DeliveryList.data?.deliveries ?? []);
  const locations = $derived($DeliveryList.data?.locations ?? []);
  // Breadcrumb path per location ("Shelf 2 › Level 1") so same-named children
  // under different parents are distinguishable.
  const locationPaths = $derived(treePathMap(locations));
  const locationName = (id: string) => locationPaths.get(id) ?? "—";
  const locationOptions = $derived(
    locations.map((l) => ({ value: l.id, label: locationName(l.id) })),
  );

  const viewer = $derived(page.data.user as Viewer | undefined);
  const has = (key: string) => !!viewer && viewer.permissions.includes(key);
  const canDraft = $derived(has("delivery.draft"));

  // ---- Filter --------------------------------------------------------------
  let statusFilter = $state<"all" | "draft" | "delivered" | "cancelled">("all");
  const rows = $derived.by(() => {
    const list =
      statusFilter === "all"
        ? deliveries
        : deliveries.filter((d) => d.status === statusFilter);
    // Drafts first, then most recent delivery date.
    return [...list].sort((a, b) => {
      const ao = a.status === "draft" ? 0 : 1;
      const bo = b.status === "draft" ? 0 : 1;
      if (ao !== bo) return ao - bo;
      return new Date(b.date).getTime() - new Date(a.date).getTime();
    });
  });

  // ---- New delivery form ---------------------------------------------------
  let showNew = $state(false);
  const today = new Date().toISOString().slice(0, 10);
  let newDate = $state(today);
  let newBiller = $state("");
  let newTargetLocationId = $state("");
  let busy = $state(false);
  let error = $state<string | null>(null);

  function resetNew() {
    showNew = false;
    newDate = today;
    newBiller = "";
    newTargetLocationId = "";
  }

  async function createDelivery() {
    if (!newDate || !newTargetLocationId) return;
    busy = true;
    error = null;
    try {
      const res = await CreateDelivery.mutate({
        date: newDate,
        biller: newBiller.trim() || null,
        targetLocationId: newTargetLocationId,
      });
      if (res.errors?.length) {
        error = res.errors[0].message;
        return;
      }
      const id = res.data?.createDelivery.id;
      resetNew();
      if (id) await goto(`/deliveries/${id}`);
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

<svelte:head><title>Deliveries · Retale Console</title></svelte:head>

<div class="space-y-4">
  <div class="flex items-center justify-between">
    <h1 class="text-xl font-semibold">Deliveries</h1>
    <div class="flex items-center gap-3">
      <Select bind:value={statusFilter} class="w-40">
        <option value="all">All statuses</option>
        <option value="draft">Draft</option>
        <option value="delivered">Delivered</option>
        <option value="cancelled">Cancelled</option>
      </Select>
      <Button size="sm" disabled={busy || !canDraft} onclick={() => (showNew = true)}>
        New delivery
      </Button>
    </div>
  </div>

  {#if error}
    <p class="text-sm text-destructive">{error}</p>
  {/if}

  {#if showNew}
    <div class="rounded-lg border bg-card p-4">
      <div class="grid grid-cols-[10rem_1fr_1fr_auto_auto] items-end gap-3">
        <label class="space-y-1">
          <span class="text-sm font-medium">Date</span>
          <Input type="date" bind:value={newDate} />
        </label>
        <label class="space-y-1">
          <span class="text-sm font-medium">Biller (optional)</span>
          <Input bind:value={newBiller} placeholder="e.g. PT Sumber Sejahtera" />
        </label>
        <label class="space-y-1">
          <span class="text-sm font-medium">Target location</span>
          <Combobox
            options={locationOptions}
            bind:value={newTargetLocationId}
            placeholder="Search location…"
          />
        </label>
        <Button
          size="sm"
          disabled={busy || !newDate || !newTargetLocationId}
          onclick={createDelivery}>Create draft</Button
        >
        <Button variant="ghost" size="sm" disabled={busy} onclick={resetNew}>
          Cancel
        </Button>
      </div>
    </div>
  {/if}

  {#if $DeliveryList.fetching && deliveries.length === 0}
    <p class="text-sm text-muted-foreground">Loading…</p>
  {:else if $DeliveryList.errors?.length}
    <p class="text-sm text-destructive">{$DeliveryList.errors[0].message}</p>
  {:else}
    <div class="overflow-hidden rounded-lg border bg-card">
      <table class="w-full text-sm">
        <thead class="border-b bg-muted/50 text-left text-muted-foreground">
          <tr>
            <th class="px-4 py-2 font-medium">Date</th>
            <th class="px-4 py-2 font-medium">Biller</th>
            <th class="px-4 py-2 font-medium">Target</th>
            <th class="px-4 py-2 font-medium">Tied to PO</th>
            <th class="px-4 py-2 text-right font-medium">Lines</th>
            <th class="px-4 py-2 text-right font-medium">Total cost</th>
            <th class="px-4 py-2 font-medium">Status</th>
          </tr>
        </thead>
        <tbody>
          {#each rows as d (d.id)}
            <tr class="border-b last:border-0 hover:bg-muted/40">
              <td class="px-4 py-2">
                <a
                  href={`/deliveries/${d.id}`}
                  class="font-medium text-primary hover:underline"
                >
                  {fmtDate(d.date)}
                </a>
              </td>
              <td class="px-4 py-2">{d.biller ?? "—"}</td>
              <td class="px-4 py-2"
                >{locationPaths.get(d.targetLocationId) ??
                  d.targetLocation?.name ??
                  "—"}</td
              >
              <td class="px-4 py-2">
                {#if d.purchaseId}
                  <a
                    href={`/purchases/${d.purchaseId}`}
                    class="font-mono text-xs text-primary hover:underline"
                  >
                    {d.purchaseId.slice(-8)}
                  </a>
                {:else}
                  —
                {/if}
              </td>
              <td class="px-4 py-2 text-right tabular-nums">
                {#if d.lineCount === 0}
                  <span class="text-xs text-muted-foreground">empty</span>
                {:else}
                  {d.lineCount}
                {/if}
              </td>
              <td class="px-4 py-2 text-right tabular-nums">{formatMoney(d.totalCostMinor)}</td>
              <td class="px-4 py-2">
                <Badge class={statusBadge(d.status)}>{d.status}</Badge>
                {#if d.deliveredAt}
                  <span class="ml-1 block text-xs text-muted-foreground">
                    {fmtDate(d.deliveredAt)}
                  </span>
                {/if}
              </td>
            </tr>
          {/each}
          {#if rows.length === 0}
            <tr>
              <td colspan="7" class="px-4 py-10 text-center text-muted-foreground">
                No deliveries to show.
              </td>
            </tr>
          {/if}
        </tbody>
      </table>
    </div>
    <p class="text-sm text-muted-foreground">
      {rows.length} deliver{rows.length === 1 ? "y" : "ies"}
    </p>
  {/if}
</div>
