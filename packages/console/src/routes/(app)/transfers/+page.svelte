<script lang="ts">
  import { graphql } from "$houdini";
  import { page } from "$app/state";
  import { goto } from "$app/navigation";
  import type { Viewer } from "../+layout.server";
  import Badge from "$lib/components/ui/badge.svelte";
  import Button from "$lib/components/ui/button.svelte";
  import Pagination from "$lib/components/ui/pagination.svelte";
  import { statusLabel, treePathMap } from "$lib/utils";
  import type { PageData } from "./$types";

  // Query document — Houdini scans this for codegen.
  graphql(`
    query TransferList {
      stockTransfers(limit: 100) {
        id
        targetLocationId
        status
        createdAt
        items {
          id
          sourceLocationId
        }
      }
      locations {
        id
        name
        parentId
      }
    }
  `);

  let { data }: { data: PageData } = $props();
  const TransferList = $derived(data.TransferList);
  const transfers = $derived($TransferList.data?.stockTransfers ?? []);

  let pageNumber = $state(1);
  const pageSize = 50;
  const paginatedTransfers = $derived(transfers.slice((pageNumber - 1) * pageSize, pageNumber * pageSize));

  const locations = $derived($TransferList.data?.locations ?? []);

  const locationPaths = $derived(treePathMap(locations));
  const locationName = (id: string) => locationPaths.get(id) ?? "Unknown";

  const viewer = $derived(page.data.user as Viewer | undefined);
  const has = (key: string) => !!viewer && viewer.permissions.includes(key);
  const canCreate = $derived(has("stock.transfer.create"));

  const statusClass = (s: string) =>
    s === "draft"
      ? "bg-muted text-muted-foreground"
      : s === "in_transit"
        ? "bg-sky-100 text-sky-700"
        : s === "received"
          ? "bg-emerald-100 text-emerald-700"
          : "bg-amber-100 text-amber-800";
  const fmtDate = (iso: string) => new Date(iso).toLocaleDateString("en-CA");

  function formatSources(items: any[]) {
    if (!items || items.length === 0) return "—";
    const uniqueSources = Array.from(new Set(items.map((i) => i.sourceLocationId)));
    if (uniqueSources.length === 1) return locationName(uniqueSources[0] as string);
    return "Multiple";
  }
</script>

<svelte:head><title>Stock transfers · Retale Console</title></svelte:head>

<div class="space-y-4">
  <div class="flex items-center justify-between">
    <h1 class="text-xl font-semibold">Stock transfers</h1>
    <Button size="sm" disabled={!canCreate} onclick={() => goto("/transfers/new")}>
      New transfer
    </Button>
  </div>

  {#if $TransferList.fetching && transfers.length === 0}
    <p class="text-sm text-muted-foreground">Loading…</p>
  {:else if $TransferList.errors?.length}
    <p class="text-sm text-destructive">{$TransferList.errors[0].message}</p>
  {:else}
    <div class="overflow-hidden rounded-lg border bg-card">
      <table class="w-full text-sm">
        <thead class="border-b bg-muted/50 text-left text-muted-foreground">
          <tr>
            <th class="px-4 py-2 font-medium">From → To</th>
            <th class="px-4 py-2 text-right font-medium">Lines</th>
            <th class="px-4 py-2 font-medium">Created</th>
            <th class="px-4 py-2 font-medium">Status</th>
          </tr>
        </thead>
        <tbody>
          {#each paginatedTransfers as t (t.id)}
            <tr class="border-b last:border-0 hover:bg-muted/40">
              <td class="px-4 py-2">
                <a
                  href={`/transfers/${t.id}`}
                  class="font-medium text-primary hover:underline"
                >
                  {formatSources(t.items)} →
                  {locationName(t.targetLocationId)}
                </a>
              </td>
              <td class="px-4 py-2 text-right">{t.items.length}</td>
              <td class="px-4 py-2">{fmtDate(t.createdAt)}</td>
              <td class="px-4 py-2">
                <Badge class={statusClass(t.status)}>{statusLabel(t.status)}</Badge>
              </td>
            </tr>
          {/each}
          {#if transfers.length === 0}
            <tr>
              <td colspan="4" class="px-4 py-10 text-center text-muted-foreground">
                No transfers yet.
              </td>
            </tr>
          {/if}
        </tbody>
      </table>
    </div>
    <div class="flex items-center justify-between">
      <p class="text-sm text-muted-foreground">
        {transfers.length} transfer{transfers.length === 1 ? "" : "s"}
      </p>
      <Pagination bind:page={pageNumber} {pageSize} totalItems={transfers.length} />
    </div>
  {/if}
</div>
