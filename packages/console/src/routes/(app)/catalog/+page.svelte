<script lang="ts">
  import { graphql } from "$houdini";
  import { page } from "$app/state";
  import type { Viewer } from "../+layout.server";
  import Badge from "$lib/components/ui/badge.svelte";
  import Button from "$lib/components/ui/button.svelte";
  import Input from "$lib/components/ui/input.svelte";
  import Select from "$lib/components/ui/select.svelte";
  import type { PageData } from "./$types";

  graphql(`
    query CatalogManage {
      products(includeArchived: false) {
        id
        name
        publicName
        kind
        categoryId
        archivedAt
        onlineVisible
        onlinePriceMode
        onlineStockMode
      }
      categories {
        id
        name
      }
      catalogPublishes(limit: 25) {
        id
        trigger
        status
        productCount
        snapshotVersion
        errorMessage
        publishedByUserId
        createdAt
      }
    }
  `);

  const BulkSetVisible = graphql(`
    mutation ConsoleBulkSetCatalogVisible($ids: [ID!]!, $visible: Boolean!) {
      setProductsOnlineVisible(ids: $ids, visible: $visible)
    }
  `);

  const PublishCatalog = graphql(`
    mutation ConsolePublishCatalog {
      publishCatalog {
        id
        status
        productCount
        snapshotVersion
        errorMessage
        createdAt
      }
    }
  `);

  let { data }: { data: PageData } = $props();
  const Store = $derived(data.CatalogManage);
  const products = $derived($Store.data?.products ?? []);
  const categories = $derived($Store.data?.categories ?? []);
  const categoryName = (id: string | null | undefined) =>
    id ? (categories.find((c) => c.id === id)?.name ?? "—") : "—";
  const publishes = $derived($Store.data?.catalogPublishes ?? []);

  const viewer = $derived(page.data.user as Viewer | undefined);
  const has = (key: string) => !!viewer && viewer.permissions.includes(key);
  const canManage = $derived(has("catalog.manage"));
  const canPublish = $derived(has("catalog.publish"));

  // ---- Filter / search -----------------------------------------------------
  let search = $state("");
  let visibilityFilter = $state<"all" | "visible" | "hidden">("all");

  const rows = $derived.by(() => {
    const q = search.trim().toLowerCase();
    let list = products;
    if (visibilityFilter !== "all") {
      const want = visibilityFilter === "visible";
      list = list.filter((p) => p.onlineVisible === want);
    }
    if (q) {
      list = list.filter(
        (p) =>
          p.name.toLowerCase().includes(q) ||
          (p.publicName ?? "").toLowerCase().includes(q),
      );
    }
    // Hidden first then alpha — the manager's goal is usually to find
    // products that should be shown.
    return [...list].sort((a, b) => {
      const av = a.onlineVisible ? 1 : 0;
      const bv = b.onlineVisible ? 1 : 0;
      return av - bv || a.name.localeCompare(b.name);
    });
  });

  const visibleCount = $derived(products.filter((p) => p.onlineVisible).length);

  // ---- Selection -----------------------------------------------------------
  let selection = $state<Set<string>>(new Set());
  const allRowsSelected = $derived(
    rows.length > 0 && rows.every((p) => selection.has(p.id)),
  );

  function toggleRow(id: string) {
    const next = new Set(selection);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    selection = next;
  }

  function toggleAllRows() {
    const next = new Set(selection);
    if (allRowsSelected) for (const r of rows) next.delete(r.id);
    else for (const r of rows) next.add(r.id);
    selection = next;
  }

  let busy = $state(false);
  let error = $state<string | null>(null);
  let info = $state<string | null>(null);

  async function bulkSet(visible: boolean) {
    if (selection.size === 0) return;
    busy = true;
    error = null;
    info = null;
    try {
      const res = await BulkSetVisible.mutate({
        ids: [...selection],
        visible,
      });
      if (res.errors?.length) {
        error = res.errors[0].message;
        return;
      }
      info = `${visible ? "Showed" : "Hid"} ${res.data?.setProductsOnlineVisible ?? 0} product(s).`;
      selection = new Set();
      await Store.fetch();
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    } finally {
      busy = false;
    }
  }

  async function publish() {
    if (
      !confirm(
        "Build a fresh snapshot and push it to the live catalog?",
      )
    )
      return;
    busy = true;
    error = null;
    info = null;
    try {
      const res = await PublishCatalog.mutate(null);
      if (res.errors?.length) {
        error = res.errors[0].message;
        return;
      }
      const r = res.data?.publishCatalog;
      info =
        r?.status === "success"
          ? `Published ${r.productCount} product(s).`
          : `Publish failed: ${r?.errorMessage ?? "unknown error"}`;
      await Store.fetch();
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    } finally {
      busy = false;
    }
  }

  const fmtDateTime = (iso: string | null | undefined) =>
    iso ? new Date(iso).toLocaleString("id-ID") : "—";
</script>

<svelte:head><title>Catalog · Retale Console</title></svelte:head>

<div class="space-y-4">
  <div class="flex items-center justify-between">
    <div>
      <h1 class="text-xl font-semibold">Catalog</h1>
      <p class="text-sm text-muted-foreground">
        {visibleCount} of {products.length} products are visible on the live
        catalog.
      </p>
    </div>
    <div class="flex items-center gap-2">
      <Select bind:value={visibilityFilter} class="w-40">
        <option value="all">All products</option>
        <option value="visible">Visible only</option>
        <option value="hidden">Hidden only</option>
      </Select>
      <div class="w-64">
        <Input
          type="search"
          placeholder="Search products…"
          bind:value={search}
        />
      </div>
      <Button size="sm" disabled={busy || !canPublish} onclick={publish}>
        Publish catalog
      </Button>
    </div>
  </div>

  {#if error}
    <p class="text-sm text-destructive">{error}</p>
  {/if}
  {#if info}
    <p class="text-sm text-emerald-700">{info}</p>
  {/if}

  {#if selection.size > 0}
    <div
      class="flex items-center justify-between rounded-md border bg-card px-3 py-2 text-sm"
    >
      <span>
        {selection.size} selected
      </span>
      <div class="flex gap-2">
        <Button
          size="sm"
          variant="outline"
          disabled={busy || !canManage}
          onclick={() => bulkSet(true)}>Show selected</Button
        >
        <Button
          size="sm"
          variant="outline"
          disabled={busy || !canManage}
          onclick={() => bulkSet(false)}>Hide selected</Button
        >
        <Button
          size="sm"
          variant="ghost"
          onclick={() => (selection = new Set())}>Clear</Button
        >
      </div>
    </div>
  {/if}

  {#if $Store.fetching && products.length === 0}
    <p class="text-sm text-muted-foreground">Loading…</p>
  {:else if $Store.errors?.length}
    <p class="text-sm text-destructive">{$Store.errors[0].message}</p>
  {:else}
    <div class="overflow-hidden rounded-lg border bg-card">
      <table class="w-full text-sm">
        <thead class="border-b bg-muted/50 text-left text-muted-foreground">
          <tr>
            <th class="w-10 px-4 py-2">
              <input
                type="checkbox"
                checked={allRowsSelected}
                disabled={rows.length === 0}
                onchange={toggleAllRows}
              />
            </th>
            <th class="px-4 py-2 font-medium">Product</th>
            <th class="px-4 py-2 font-medium">Category</th>
            <th class="px-4 py-2 font-medium">Visibility</th>
            <th class="px-4 py-2 font-medium">Price mode</th>
            <th class="px-4 py-2 font-medium">Stock mode</th>
          </tr>
        </thead>
        <tbody>
          {#each rows as p (p.id)}
            <tr class="border-b last:border-0 hover:bg-muted/40">
              <td class="px-4 py-2">
                <input
                  type="checkbox"
                  checked={selection.has(p.id)}
                  onchange={() => toggleRow(p.id)}
                />
              </td>
              <td class="px-4 py-2">
                <a
                  href={`/products/${p.id}`}
                  class="font-medium text-primary hover:underline"
                >
                  {p.name}
                </a>
                {#if p.publicName && p.publicName !== p.name}
                  <p class="text-xs text-muted-foreground">{p.publicName}</p>
                {/if}
              </td>
              <td class="px-4 py-2 text-muted-foreground">
                {categoryName(p.categoryId)}
              </td>
              <td class="px-4 py-2">
                {#if p.onlineVisible}
                  <Badge class="bg-emerald-100 text-emerald-700">visible</Badge>
                {:else}
                  <Badge class="bg-muted text-muted-foreground">hidden</Badge>
                {/if}
              </td>
              <td class="px-4 py-2 font-mono text-xs">{p.onlinePriceMode}</td>
              <td class="px-4 py-2 font-mono text-xs">{p.onlineStockMode}</td>
            </tr>
          {/each}
          {#if rows.length === 0}
            <tr>
              <td colspan="6" class="px-4 py-10 text-center text-muted-foreground">
                No products match.
              </td>
            </tr>
          {/if}
        </tbody>
      </table>
    </div>

    <!-- Publish history -->
    <section>
      <h2 class="mb-2 text-sm font-semibold">
        Publish history
        <span class="ml-1 text-xs font-normal text-muted-foreground">
          ({publishes.length})
        </span>
      </h2>
      <div class="overflow-hidden rounded-lg border bg-card">
        <table class="w-full text-sm">
          <thead class="border-b bg-muted/50 text-left text-muted-foreground">
            <tr>
              <th class="px-4 py-2 font-medium">When</th>
              <th class="px-4 py-2 font-medium">Trigger</th>
              <th class="px-4 py-2 font-medium">Status</th>
              <th class="px-4 py-2 text-right font-medium">Products</th>
              <th class="px-4 py-2 font-medium">Snapshot</th>
            </tr>
          </thead>
          <tbody>
            {#each publishes as pub (pub.id)}
              <tr class="border-b last:border-0">
                <td class="px-4 py-2">{fmtDateTime(pub.createdAt)}</td>
                <td class="px-4 py-2 capitalize">{pub.trigger}</td>
                <td class="px-4 py-2">
                  {#if pub.status === "success"}
                    <Badge class="bg-emerald-100 text-emerald-700">success</Badge>
                  {:else}
                    <Badge class="bg-destructive/10 text-destructive">error</Badge>
                  {/if}
                  {#if pub.errorMessage}
                    <p class="mt-1 text-xs text-destructive">
                      {pub.errorMessage}
                    </p>
                  {/if}
                </td>
                <td class="px-4 py-2 text-right">{pub.productCount}</td>
                <td class="px-4 py-2 font-mono text-xs text-muted-foreground">
                  {pub.snapshotVersion ?? "—"}
                </td>
              </tr>
            {/each}
            {#if publishes.length === 0}
              <tr>
                <td colspan="5" class="px-4 py-6 text-center text-muted-foreground">
                  No publishes yet.
                </td>
              </tr>
            {/if}
          </tbody>
        </table>
      </div>
    </section>
  {/if}
</div>
