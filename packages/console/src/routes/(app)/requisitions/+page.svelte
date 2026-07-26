<script lang="ts">
  import { graphql } from "$houdini";
  import { goto } from "$app/navigation";
  import { formatMoney, matchesTokens, searchTokens, statusLabel } from "$lib/utils";
  import Badge from "$lib/components/ui/badge.svelte";
  import Button from "$lib/components/ui/button.svelte";
  import Input from "$lib/components/ui/input.svelte";
  import Pagination from "$lib/components/ui/pagination.svelte";
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

  async function createRequisition() {
    const name = window.prompt("Requisition name:");
    if (!name) return;
    creating = true;
    try {
      const res = await CreateRequisition.mutate({ name });
      if (res.data?.createRequisition) {
        goto(`/requisitions/${res.data.createRequisition.id}`);
      }
    } finally {
      creating = false;
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

<svelte:head><title>Purchase Requisitions · Retale Console</title></svelte:head>

<div class="space-y-4">
  <div class="flex items-center justify-between">
    <h1 class="text-xl font-semibold">Purchase Requisitions</h1>
    <div class="flex items-center gap-3">
      <div class="w-56">
        <Input type="search" placeholder="Search requisitions…" bind:value={search} />
      </div>
      <div class="flex items-center gap-1 rounded-md border p-1 bg-muted/30">
        {#each STATUSES as s}
          <button
            class="rounded px-3 py-1.5 text-sm font-medium capitalize transition-colors {statusFilter === s ? 'bg-background shadow-sm text-foreground' : 'text-muted-foreground hover:bg-muted/50'}"
            onclick={() => statusFilter = s}
          >
            {s === "all" ? "All" : s.replace('_', ' ')}
          </button>
        {/each}
      </div>
      <Button size="sm" onclick={createRequisition} disabled={creating}>New Requisition</Button>
    </div>
  </div>

  <div class="overflow-hidden rounded-lg border bg-card">
    <table class="w-full text-sm">
      <thead class="border-b bg-muted/50 text-left text-muted-foreground">
        <tr>
          <th class="px-4 py-2 font-medium">Name</th>
          <th class="px-4 py-2 font-medium">Date</th>
          <th class="px-4 py-2 font-medium">Items</th>
          <th class="px-4 py-2 font-medium">Status</th>
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
            <td class="px-4 py-2">{req.items.length} lines</td>
            <td class="px-4 py-2">
              <Badge class={statusClass(req.status)}>{req.status.replace('_', ' ')}</Badge>
            </td>
          </tr>
        {:else}
          <tr>
            <td colspan="4" class="px-4 py-8 text-center text-muted-foreground">
              No requisitions found.
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
