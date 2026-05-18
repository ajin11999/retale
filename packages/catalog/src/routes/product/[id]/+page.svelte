<script lang="ts">
  import {
    priceLabel,
    stockLabel,
    type CatalogProduct,
    type CatalogSnapshot,
  } from "$lib/snapshot";

  let {
    data,
  }: {
    data: {
      product: CatalogProduct;
      snapshot: CatalogSnapshot | null;
      error: string | null;
    };
  } = $props();

  const product = $derived(data.product);
  const categoryName = $derived(
    data.snapshot?.categories.find((c) => c.id === product.categoryId)?.name ??
      "Uncategorized",
  );
</script>

<svelte:head><title>{product.name} — Retale Catalog</title></svelte:head>

<a class="back-link" href="/">← Back to catalog</a>

<h2>{product.name}</h2>
<div class="category">{categoryName}</div>

{#each product.variants as v (v.id)}
  {@const price = priceLabel(v)}
  {@const stock = stockLabel(v)}
  <div class="variant-row">
    <span>{v.label ?? "Standard"}</span>
    <span>
      {#if price}<span class="price">{price}</span>{/if}
      {#if stock}<span class="stock"> · {stock}</span>{/if}
      {#if !price && !stock}<span class="muted">On request</span>{/if}
    </span>
  </div>
{/each}

{#if product.description}
  <p class="description">{product.description}</p>
{/if}
