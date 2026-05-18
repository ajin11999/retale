<script lang="ts">
  import "../app.css";
  import type { Snippet } from "svelte";
  import type { CatalogSnapshot } from "$lib/snapshot";

  let {
    children,
    data,
  }: {
    children: Snippet;
    data: { snapshot: CatalogSnapshot | null; error: string | null };
  } = $props();

  const publishedAt = $derived(
    data.snapshot ? new Date(data.snapshot.generatedAt).toLocaleString() : null,
  );
</script>

<header class="site-header">
  <div class="page">
    <h1><a href="/">Retale Catalog</a></h1>
  </div>
</header>

<div class="page">
  {@render children()}
</div>

<footer class="site-footer">
  <div class="page">
    {#if publishedAt}
      Prices and stock as of {publishedAt} — subject to confirmation.
    {:else}
      Catalog data unavailable.
    {/if}
  </div>
</footer>
