<script lang="ts">
  import { graphql } from "$houdini";
  import { goto } from "$app/navigation";
  import { formatMoney, matchesTokens, searchTokens } from "$lib/utils";
  import Badge from "$lib/components/ui/badge.svelte";
  import Button from "$lib/components/ui/button.svelte";
  import Input from "$lib/components/ui/input.svelte";
  import Pagination from "$lib/components/ui/pagination.svelte";
  import { t } from "$lib/i18n";
  import type { PageData } from "./$types";
  import { page } from "$app/state";

  graphql(`
    query RequisitionList {
      requisitions(includeCancelled: true) {
        id
        name
        status
        createdAt
        items {
          id
        }
      }
    }
  `);

  const CreateRequisition = graphql(`
    mutation ConsoleCreateRequisition($name: String!) {
      createRequisition(name: $name) {
        id
      }
    }
  `);

  let { data } = $props<{ data: PageData }>();
  const RequisitionList = $derived(data.RequisitionList);

  let search = $state("");
  let statusFilter = $state("all");
  const STATUSES = ["all", "draft", "open", "partially_ordered", "fully_ordered", "cancelled"];

  const statusClass = (s: string) =>
    s === "open" ? "bg-sky-100 text-sky-700"
    : s === "draft" ? "bg-muted text-muted-foreground"
    : s === "partially_ordered" ? "bg-amber-100 text-amber-800"
    : s === "fully_ordered" ? "bg-emerald-100 text-emerald-700"
    : "bg-muted text-muted-foreground";

  let creating = $state(false);
  let showCreate = $state(false);
  let newName = $state("");

  async function createRequisition() {
    const name = newName.trim();
    if (!name) return;
    creating = true;
    try {
      const res = await CreateRequisition.mutate({ name });
      if (res.data?.createRequisition) {
        goto(`/requisitions/${res.data.createRequisition.id}`);
      }
    } finally {
      creating = false;
      showCreate = false;
      newName = "";
    }
  }

  // Filter & Pagination
  let filteredRequisitions = $derived(
    ($RequisitionList.data?.requisitions ?? []).filter((req: any) => {
      if (statusFilter !== "all" && req.status !== statusFilter) return false;
      if (search && !matchesTokens(searchTokens(search), req.name)) return false;
      return true;
    })
  );

  let currentPage = $state(1);
  const perPage = 25;
  let paginatedRequisitions = $derived(
    filteredRequisitions.slice((currentPage - 1) * perPage, currentPage * perPage)
  );
</script>

<svelte:head><title>{t("requisitions.pageTitle")}</title></svelte:head>

<div class="space-y-4">
  <div class="flex items-center justify-between">
    <h1 class="text-xl font-semibold">{t("requisitions.title")}</h1>
    <div class="flex items-center gap-3">
      <div class="w-56">
        <Input type="search" placeholder={t("requisitions.searchRequisitions")} bind:value={search} />
      </div>
      <div class="flex items-center gap-1 rounded-md border p-1 bg-muted/30">
        {#each STATUSES as s}
          <button
            class="rounded px-3 py-1.5 text-sm font-medium capitalize transition-colors {statusFilter === s ? 'bg-background shadow-sm text-foreground' : 'text-muted-foreground hover:bg-muted/50'}"
            onclick={() => statusFilter = s}
          >
            {s === "all" ? t("requisitions.all") : (t(`requisitions.status.${s}`) || s.replace('_', ' '))}
          </button>
        {/each}
      </div>
      {#if showCreate}
        <div class="flex items-center gap-2">
          <Input placeholder={t("requisitions.requisitionName")} bind:value={newName} class="w-48" onkeydown={(e: any) => e.key === 'Enter' && createRequisition()} autofocus />
          <Button size="sm" onclick={createRequisition} disabled={creating}>{t("common.create")}</Button>
          <Button size="sm" variant="ghost" onclick={() => showCreate = false}>{t("common.cancel")}</Button>
        </div>
      {:else}
        <Button size="sm" onclick={() => showCreate = true}>{t("requisitions.newRequisition")}</Button>
      {/if}
    </div>
  </div>

  <div class="overflow-hidden rounded-lg border bg-card">
    <table class="w-full text-sm">
      <thead class="border-b bg-muted/50 text-left text-muted-foreground">
        <tr>
          <th class="px-4 py-2 font-medium">{t("common.name")}</th>
          <th class="px-4 py-2 font-medium">{t("requisitions.date")}</th>
          <th class="px-4 py-2 font-medium">{t("requisitions.items")}</th>
          <th class="px-4 py-2 font-medium">{t("common.status")}</th>
        </tr>
      </thead>
      <tbody>
        {#each paginatedRequisitions as req}
          <tr class="border-b last:border-0 hover:bg-muted/40">
            <td class="px-4 py-2">
              <a href={`/requisitions/${req.id}`} class="font-medium text-primary hover:underline">
                {req.name}
              </a>
            </td>
            <td class="px-4 py-2">{new Date(Number(req.createdAt)).toLocaleDateString()}</td>
            <td class="px-4 py-2">{t("requisitions.lines", { count: req.items.length })}</td>
            <td class="px-4 py-2">
              <Badge class={statusClass(req.status)}>{t(`requisitions.status.${req.status}`) || req.status.replace('_', ' ')}</Badge>
            </td>
          </tr>
        {:else}
          <tr>
            <td colspan="4" class="px-4 py-8 text-center text-muted-foreground">
              {t("requisitions.noRequisitionsFound")}
            </td>
          </tr>
        {/each}
      </tbody>
    </table>
  </div>
  
  {#if filteredRequisitions.length > perPage}
    <div class="flex justify-center">
      <Pagination totalItems={filteredRequisitions.length} pageSize={perPage} bind:page={currentPage} />
    </div>
  {/if}
</div>
