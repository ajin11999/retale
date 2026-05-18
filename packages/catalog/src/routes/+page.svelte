<script lang="ts">
  import { fromPriceLabel, type CatalogSnapshot } from "$lib/snapshot";

  let {
    data,
  }: { data: { snapshot: CatalogSnapshot | null; error: string | null } } =
    $props();

  let query = $state("");
  let categoryId = $state("");

  const snapshot = $derived(data.snapshot);
  const categories = $derived(snapshot?.categories ?? []);

  const filtered = $derived.by(() => {
    if (!snapshot) return [];
    const q = query.trim().toLowerCase();
    return snapshot.products.filter((p) => {
      if (categoryId && p.categoryId !== categoryId) return false;
      if (q && !p.name.toLowerCase().includes(q)) return false;
      return true;
    });
  });

  function categoryName(id: string | null): string {
    if (!id) return "Uncategorized";
    return categories.find((c) => c.id === id)?.name ?? "Uncategorized";
  }
</script>

<svelte:head><title>Retale Catalog</title></svelte:head>

{#if data.error}
  <p class="empty">{data.error}</p>
{:else if snapshot}
  <div class="controls">
    <input
      type="search"
      placeholder="Search products…"
      bind:value={query}
      aria-label="Search products"
    />
    <select bind:value={categoryId} aria-label="Filter by category">
      <option value="">All categories</option>
      {#each categories as c (c.id)}
        <option value={c.id}>{c.name}</option>
      {/each}
    </select>
  </div>

  {#if filtered.length === 0}
    <p class="empty">No products match your search.</p>
  {:else}
    <p class="muted">{filtered.length} product{filtered.length === 1 ? "" : "s"}</p>
    <div class="grid">
      {#each filtered as p (p.id)}
        {@const price = fromPriceLabel(p)}
        {@const cover = p.images[0]}
        <a class="card" href="/product/{p.id}">
          {#if cover}
            <img
              class="card-img"
              src={cover.thumbnailUrl}
              alt={p.name}
              loading="lazy"
            />
          {:else}
            <div class="card-img placeholder">No image</div>
          {/if}
          <h3>{p.name}</h3>
          <div class="category">{categoryName(p.categoryId)}</div>
          {#if price}
            <div class="price">{price}</div>
          {:else}
            <div class="stock">Price on request</div>
          {/if}
        </a>
      {/each}
    </div>
  {/if}
{/if}
