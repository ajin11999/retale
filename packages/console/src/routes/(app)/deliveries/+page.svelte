<script lang="ts">
  import { graphql } from "$houdini";
  import { goto } from "$app/navigation";
  import { page } from "$app/state";
  import type { Viewer } from "../+layout.server";
  import { formatMoney, treePathMap } from "$lib/utils";
  import { t } from "$lib/i18n";
  import Badge from "$lib/components/ui/badge.svelte";
  import Button from "$lib/components/ui/button.svelte";
  import Combobox from "$lib/components/ui/combobox.svelte";
  import Input from "$lib/components/ui/input.svelte";
  import Pagination from "$lib/components/ui/pagination.svelte";
  import Select from "$lib/components/ui/select.svelte";
  import type { PageData } from "./$types";

  graphql(`
    query DeliveryList {
      deliveries {
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
      $targetLocationId: ID
      $kind: DeliveryKind
    ) {
      createDelivery(
        date: $date
        biller: $biller
        targetLocationId: $targetLocationId
        kind: $kind
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
  let kindFilter = $state<"all" | "transit" | "arrival">("all");
  const rows = $derived.by(() => {
    const list = deliveries.filter(
      (d) =>
        (statusFilter === "all" || d.status === statusFilter) &&
        (kindFilter === "all" || d.kind === kindFilter),
    );
    // Drafts first, then most recent delivery date.
    return [...list].sort((a, b) => {
      const ao = a.status === "draft" ? 0 : 1;
      const bo = b.status === "draft" ? 0 : 1;
      if (ao !== bo) return ao - bo;
      return new Date(b.date).getTime() - new Date(a.date).getTime();
    });
  });

  let pageNumber = $state(1);
  const pageSize = 50;
  $effect(() => {
    statusFilter;
    kindFilter;
    pageNumber = 1;
  });
  const paginatedRows = $derived(rows.slice((pageNumber - 1) * pageSize, pageNumber * pageSize));

  // ---- New delivery form ---------------------------------------------------
  let showNew = $state(false);
  const today = new Date().toISOString().slice(0, 10);
  let newDate = $state(today);
  let newBiller = $state("");
  let newTargetLocationId = $state("");
  let newKind = $state<"arrival" | "transit">("arrival");
  let busy = $state(false);
  let error = $state<string | null>(null);

  function resetNew() {
    showNew = false;
    newDate = today;
    newBiller = "";
    newTargetLocationId = "";
    newKind = "arrival";
  }

  async function createDelivery() {
    if (!newDate) return;
    if (newKind === "arrival" && !newTargetLocationId) return;
    busy = true;
    error = null;
    try {
      const res = await CreateDelivery.mutate({
        date: newDate,
        biller: newBiller.trim() || null,
        // A transit note has no target location.
        targetLocationId: newKind === "arrival" ? newTargetLocationId : null,
        kind: newKind,
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
    iso ? new Date(iso).toLocaleDateString("en-CA") : "—";

  function statusBadge(s: string) {
    if (s === "delivered") return "bg-emerald-100 text-emerald-700";
    if (s === "cancelled") return "bg-destructive/10 text-destructive";
    return "bg-amber-100 text-amber-800";
  }
</script>

<svelte:head><title>{t("deliveries.pageTitle")}</title></svelte:head>

<div class="space-y-4">
  <div class="flex items-center justify-between">
    <h1 class="text-xl font-semibold">{t("deliveries.title")}</h1>
    <div class="flex items-center gap-3">
      <Select bind:value={kindFilter} class="w-36">
        <option value="all">{t("deliveries.allKinds")}</option>
        <option value="transit">{t("deliveries.transit")}</option>
        <option value="arrival">{t("deliveries.arrival")}</option>
      </Select>
      <Select bind:value={statusFilter} class="w-40">
        <option value="all">{t("deliveries.allStatuses")}</option>
        <option value="draft">{t("deliveries.status.draft")}</option>
        <option value="delivered">{t("deliveries.status.delivered")}</option>
        <option value="cancelled">{t("deliveries.status.cancelled")}</option>
      </Select>
      <Button size="sm" disabled={busy || !canDraft} onclick={() => (showNew = true)}>
        {t("deliveries.newDelivery")}
      </Button>
    </div>
  </div>

  {#if error}
    <p class="text-sm text-destructive">{error}</p>
  {/if}

  {#if showNew}
    <div class="rounded-lg border bg-card p-4">
      <div class="grid grid-cols-[8rem_10rem_1fr_1fr_auto_auto] items-end gap-3">
        <label class="space-y-1">
          <span class="text-sm font-medium">{t("deliveries.kind")}</span>
          <Select bind:value={newKind}>
            <option value="arrival">{t("deliveries.arrival")}</option>
            <option value="transit">{t("deliveries.transit")}</option>
          </Select>
        </label>
        <label class="space-y-1">
          <span class="text-sm font-medium">{t("common.date")}</span>
          <Input type="date" bind:value={newDate} />
        </label>
        <label class="space-y-1">
          <span class="text-sm font-medium">{t("deliveries.billerOptional")}</span>
          <Input bind:value={newBiller} placeholder={t("deliveries.billerPlaceholder")} />
        </label>
        {#if newKind === "arrival"}
          <label class="space-y-1">
            <span class="text-sm font-medium">{t("deliveries.targetLocation")}</span>
            <Combobox
              options={locationOptions}
              bind:value={newTargetLocationId}
              placeholder={t("deliveries.searchLocation")}
            />
          </label>
        {:else}
          <p class="self-center text-xs text-muted-foreground">
            {t("deliveries.transitHint")}
          </p>
        {/if}
        <Button
          size="sm"
          disabled={busy || !newDate || (newKind === "arrival" && !newTargetLocationId)}
          onclick={createDelivery}>{t("deliveries.createDraft")}</Button
        >
        <Button variant="ghost" size="sm" disabled={busy} onclick={resetNew}>
          {t("common.cancel")}
        </Button>
      </div>
    </div>
  {/if}

  {#if $DeliveryList.fetching && deliveries.length === 0}
    <p class="text-sm text-muted-foreground">{t("common.loading")}</p>
  {:else if $DeliveryList.errors?.length}
    <p class="text-sm text-destructive">{$DeliveryList.errors[0].message}</p>
  {:else}
    <div class="overflow-hidden rounded-lg border bg-card">
      <table class="w-full text-sm">
        <thead class="border-b bg-muted/50 text-left text-muted-foreground">
          <tr>
            <th class="px-4 py-2 font-medium">{t("common.date")}</th>
            <th class="px-4 py-2 font-medium">{t("deliveries.biller")}</th>
            <th class="px-4 py-2 font-medium">{t("deliveries.target")}</th>
            <th class="px-4 py-2 font-medium">{t("deliveries.tiedToPo")}</th>
            <th class="px-4 py-2 text-right font-medium">{t("deliveries.lines")}</th>
            <th class="px-4 py-2 text-right font-medium">{t("deliveries.totalCost")}</th>
            <th class="px-4 py-2 font-medium">{t("common.status")}</th>
          </tr>
        </thead>
        <tbody>
          {#each paginatedRows as d (d.id)}
            <tr class="border-b last:border-0 hover:bg-muted/40">
              <td class="px-4 py-2">
                <a
                  href={`/deliveries/${d.id}`}
                  class="font-medium text-primary hover:underline"
                >
                  {fmtDate(d.date)}
                </a>
                {#if d.kind === "transit"}
                  <Badge class="ml-1 bg-violet-100 text-violet-700">{t("deliveries.transit")}</Badge>
                {/if}
              </td>
              <td class="px-4 py-2">{d.biller ?? "—"}</td>
              <td class="px-4 py-2"
                >{(d.targetLocationId
                  ? locationPaths.get(d.targetLocationId)
                  : null) ??
                  d.targetLocation?.name ??
                  (d.kind === "transit" ? t("deliveries.inTransit") : "—")}</td
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
                  <span class="text-xs text-muted-foreground">{t("deliveries.empty")}</span>
                {:else}
                  {d.lineCount}
                {/if}
              </td>
              <td class="px-4 py-2 text-right tabular-nums">{formatMoney(d.totalCostMinor)}</td>
              <td class="px-4 py-2">
                <Badge class={statusBadge(d.status)}>{t(`deliveries.status.${d.status}`)}</Badge>
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
                {t("deliveries.noDeliveries")}
              </td>
            </tr>
          {/if}
        </tbody>
      </table>
    </div>
    <div class="flex items-center justify-between">
      <p class="text-sm text-muted-foreground">
        {t("deliveries.count", { count: rows.length })}
      </p>
      <Pagination bind:page={pageNumber} {pageSize} totalItems={rows.length} />
    </div>
  {/if}
</div>
