<script lang="ts">
  import { graphql } from "$houdini";
  import { goto } from "$app/navigation";
  import { page } from "$app/state";
  import { formatMoney } from "$lib/utils";
  import type { Viewer } from "../+layout.server";
  import Badge from "$lib/components/ui/badge.svelte";
  import Button from "$lib/components/ui/button.svelte";
  import DuplicateHint from "$lib/components/ui/duplicate-hint.svelte";
  import Input from "$lib/components/ui/input.svelte";
  import MoneyInput from "$lib/components/ui/money-input.svelte";
  import Select from "$lib/components/ui/select.svelte";
  import type { PageData } from "./$types";

  // Query document — Houdini scans this for codegen. The live store is
  // supplied by +page.ts through `data` (Houdini's route-store wiring does
  // not run under this toolchain, so the component never gets its own).
  graphql(`
    query ProductList {
      products(includeArchived: true) {
        id
        name
        kind
        categoryId
        archivedAt
        variants {
          id
          priceMinor
          totalQty
        }
      }
      categories {
        id
        name
      }
    }
  `);

  const CreateProduct = graphql(`
    mutation ConsoleCreateProduct(
      $name: String!
      $kind: ProductKind
      $categoryId: ID
      $priceMode: PriceMode!
      $variants: [VariantInput!]!
    ) {
      createProduct(
        name: $name
        kind: $kind
        categoryId: $categoryId
        priceMode: $priceMode
        variants: $variants
      ) {
        id
      }
    }
  `);

  let { data }: { data: PageData } = $props();
  const ProductList = $derived(data.ProductList);

  const viewer = $derived(page.data.user as Viewer | undefined);
  const canCreate = $derived(
    !!viewer && viewer.permissions.includes("product.create"),
  );

  const KINDS = ["physical", "service", "bundle"];
  const PRICE_MODES = ["tax_inclusive", "tax_exclusive"];

  interface ProductDraft {
    name: string;
    categoryId: string;
    kind: string;
    priceMode: string;
    sku: string;
    priceMinor: number | null;
    costMinor: number | null;
  }

  let draft = $state<ProductDraft | null>(null);
  let busy = $state(false);
  let feedback = $state<{ ok: boolean; text: string } | null>(null);

  function newProduct() {
    draft = {
      name: "",
      categoryId: "",
      kind: "physical",
      priceMode: "tax_inclusive",
      sku: "",
      priceMinor: 0,
      costMinor: 0,
    };
    feedback = null;
  }

  async function saveProduct() {
    const d = draft;
    if (!d || !d.name.trim()) return;
    busy = true;
    feedback = null;
    try {
      const res = await CreateProduct.mutate({
        name: d.name.trim(),
        kind: d.kind as never,
        categoryId: d.categoryId || null,
        priceMode: d.priceMode as never,
        variants: [
          {
            sku: d.sku.trim() || undefined,
            priceMinor: d.priceMinor ?? 0,
            costMinor: d.costMinor ?? 0,
          },
        ],
      });
      if (res.errors?.length) {
        feedback = { ok: false, text: res.errors[0].message };
        return;
      }
      const id = res.data?.createProduct.id;
      draft = null;
      if (id) await goto(`/products/${id}`);
    } catch (e) {
      feedback = { ok: false, text: e instanceof Error ? e.message : String(e) };
    } finally {
      busy = false;
    }
  }

  interface Row {
    id: string;
    name: string;
    kind: string;
    categoryId: string | null;
    category: string;
    variants: number;
    minPrice: number;
    maxPrice: number;
    stock: number;
    archived: boolean;
  }

  // Filtering/sorting/pagination run in plain runes here rather than through a
  // TanStack table. The adapter wraps its options/state in a Proxy that
  // TanStack reads thousands of times while rebuilding row models on every
  // change; with a non-trivial product list that compounds into a visible
  // freeze per query. Plain derivations keep it to one cheap pass.
  //
  // `searchInput` tracks the field; `search` (debounced 0.5s) drives filtering,
  // so we re-filter/sort at most once per pause, not per keystroke.
  let searchInput = $state("");
  let search = $state("");
  let debounceTimer: ReturnType<typeof setTimeout> | undefined;

  function onSearchInput(value: string) {
    searchInput = value;
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      search = value.trim();
      // Filtered set shrinks — jump back so results aren't on a stale page.
      pageIndex = 0;
    }, 500);
  }

  // Map products → rows once per data change (independent of the search term),
  // with a precomputed lowercase haystack so each query is a cheap substring
  // scan rather than a full re-map + lowercasing pass.
  const allRows = $derived.by<(Row & { haystack: string })[]>(() => {
    const result = $ProductList?.data;
    if (!result) return [];
    const catName = new Map(result.categories.map((c) => [c.id, c.name]));
    return result.products.map((p) => {
      const prices = p.variants.map((v) => v.priceMinor);
      const category = p.categoryId
        ? (catName.get(p.categoryId) ?? "Unknown")
        : "Uncategorized";
      return {
        id: p.id,
        name: p.name,
        kind: p.kind,
        categoryId: p.categoryId ?? null,
        category,
        variants: p.variants.length,
        minPrice: prices.length ? Math.min(...prices) : 0,
        maxPrice: prices.length ? Math.max(...prices) : 0,
        stock: p.variants.reduce((sum, v) => sum + v.totalQty, 0),
        archived: p.archivedAt != null,
        haystack: `${p.name} ${category} ${p.kind}`.toLowerCase(),
      };
    });
  });

  // Optional category filter, driven by `?category=<id>` (set from the
  // Categories screen's product-count links). The category's name, looked up
  // for the active-filter banner.
  const categoryFilter = $derived(page.url.searchParams.get("category"));
  const categoryFilterName = $derived(
    categoryFilter
      ? ($ProductList?.data?.categories.find((c) => c.id === categoryFilter)
          ?.name ?? "this category")
      : null,
  );

  function clearCategoryFilter() {
    goto("/products", { keepFocus: true, noScroll: true });
  }

  const rows = $derived.by<Row[]>(() => {
    let base = allRows;
    if (categoryFilter) base = base.filter((r) => r.categoryId === categoryFilter);
    const q = search.toLowerCase();
    if (!q) return base;
    return base.filter((r) => r.haystack.includes(q));
  });

  type SortKey = "name" | "category" | "kind" | "variants" | "minPrice" | "stock" | "archived";
  const COLUMNS: { key: SortKey; id: string; header: string }[] = [
    { key: "name", id: "name", header: "Product" },
    { key: "category", id: "category", header: "Category" },
    { key: "kind", id: "kind", header: "Kind" },
    { key: "variants", id: "variants", header: "Variants" },
    { key: "minPrice", id: "price", header: "Price" },
    { key: "stock", id: "stock", header: "Stock" },
    { key: "archived", id: "status", header: "Status" },
  ];

  const PAGE_SIZE = 15;
  let sortKey = $state<SortKey>("name");
  let sortDir = $state<"asc" | "desc">("asc");
  let pageIndex = $state(0);

  function toggleSort(key: SortKey) {
    if (sortKey === key) {
      sortDir = sortDir === "asc" ? "desc" : "asc";
    } else {
      sortKey = key;
      sortDir = "asc";
    }
  }

  const sorted = $derived.by<Row[]>(() => {
    const dir = sortDir === "asc" ? 1 : -1;
    return [...rows].sort((a, b) => {
      const av = a[sortKey];
      const bv = b[sortKey];
      if (typeof av === "number" && typeof bv === "number") {
        return (av - bv) * dir;
      }
      return String(av).localeCompare(String(bv)) * dir;
    });
  });

  const pageCount = $derived(Math.max(Math.ceil(sorted.length / PAGE_SIZE), 1));
  // Clamp so a stale pageIndex (after the result set shrinks) still resolves.
  const currentPage = $derived(Math.min(pageIndex, pageCount - 1));
  const pageRows = $derived(
    sorted.slice(currentPage * PAGE_SIZE, currentPage * PAGE_SIZE + PAGE_SIZE),
  );

  function prevPage() {
    pageIndex = Math.max(currentPage - 1, 0);
  }
  function nextPage() {
    pageIndex = Math.min(currentPage + 1, pageCount - 1);
  }

  function priceLabel(r: Row): string {
    if (r.variants === 0) return "—";
    return r.minPrice === r.maxPrice
      ? formatMoney(r.minPrice)
      : `${formatMoney(r.minPrice)} – ${formatMoney(r.maxPrice)}`;
  }

  const sortGlyph = (key: SortKey) =>
    sortKey === key ? (sortDir === "asc" ? " ↑" : " ↓") : "";
</script>

<svelte:head><title>Products · Retale Console</title></svelte:head>

<div class="space-y-4">
  <div class="flex items-center justify-between gap-3">
    <h1 class="text-xl font-semibold">Products</h1>
    <div class="flex items-center gap-2">
      <div class="w-64">
        <Input
          type="search"
          placeholder="Search products…"
          value={searchInput}
          oninput={(e) => onSearchInput(e.currentTarget.value)}
        />
      </div>
      <Button size="sm" disabled={busy || !canCreate} onclick={newProduct}>
        Add product
      </Button>
    </div>
  </div>

  {#if feedback}
    <p class="text-sm {feedback.ok ? 'text-emerald-700' : 'text-destructive'}">
      {feedback.text}
    </p>
  {/if}

  {#if categoryFilter}
    <div
      class="flex items-center justify-between rounded-md border bg-muted/40 px-3 py-2 text-sm"
    >
      <span>
        Showing products in <span class="font-medium">{categoryFilterName}</span>
      </span>
      <button
        class="text-xs text-primary hover:underline"
        onclick={clearCategoryFilter}>Clear filter</button
      >
    </div>
  {/if}

  {#if draft}
    <div class="space-y-3 rounded-lg border bg-card p-5">
      <h2 class="text-sm font-semibold">New product</h2>
      <div class="grid grid-cols-2 gap-3">
        <label class="relative space-y-1">
          <span class="text-xs font-medium">Name</span>
          <Input bind:value={draft.name} placeholder="Product name" />
          <DuplicateHint
            query={draft.name}
            items={allRows}
            hrefFor={(id) => `/products/${id}`}
            noun="product"
          />
        </label>
        <label class="space-y-1">
          <span class="text-xs font-medium">Category</span>
          <Select bind:value={draft.categoryId}>
            <option value="">Uncategorized</option>
            {#each $ProductList.data?.categories ?? [] as c (c.id)}
              <option value={c.id}>{c.name}</option>
            {/each}
          </Select>
        </label>
        <label class="space-y-1">
          <span class="text-xs font-medium">Kind</span>
          <Select bind:value={draft.kind}>
            {#each KINDS as k (k)}<option value={k}>{k}</option>{/each}
          </Select>
        </label>
        <label class="space-y-1">
          <span class="text-xs font-medium">Price mode</span>
          <Select bind:value={draft.priceMode}>
            {#each PRICE_MODES as m (m)}<option value={m}>{m}</option>{/each}
          </Select>
        </label>
        <label class="space-y-1">
          <span class="text-xs font-medium">SKU</span>
          <Input bind:value={draft.sku} placeholder="Auto-generated" />
        </label>
        <div></div>
        <label class="space-y-1">
          <span class="text-xs font-medium">Price (Rp)</span>
          <MoneyInput bind:value={draft.priceMinor} />
        </label>
        <label class="space-y-1">
          <span class="text-xs font-medium">Cost (Rp)</span>
          <MoneyInput bind:value={draft.costMinor} />
        </label>
      </div>
      <p class="text-xs text-muted-foreground">
        Creates the product with one initial variant. Add more variants and
        details after saving.
      </p>
      <div class="flex justify-end gap-2">
        <Button
          variant="ghost"
          size="sm"
          disabled={busy}
          onclick={() => (draft = null)}
        >
          Cancel
        </Button>
        <Button
          size="sm"
          disabled={busy || !draft.name.trim()}
          onclick={saveProduct}
        >
          Create product
        </Button>
      </div>
    </div>
  {/if}

  {#if $ProductList.fetching}
    <p class="text-sm text-muted-foreground">Loading…</p>
  {:else if $ProductList.errors?.length}
    <p class="text-sm text-destructive">
      {$ProductList.errors[0].message}
    </p>
  {:else}
    <div class="overflow-hidden rounded-lg border bg-card">
      <table class="w-full text-sm">
        <thead class="border-b bg-muted/50 text-muted-foreground">
          <tr>
            {#each COLUMNS as col (col.id)}
              <th class="px-4 py-2 text-left font-medium">
                <button
                  class="inline-flex items-center hover:text-foreground"
                  onclick={() => toggleSort(col.key)}
                >
                  {col.header}{sortGlyph(col.key)}
                </button>
              </th>
            {/each}
          </tr>
        </thead>
        <tbody>
          {#each pageRows as row (row.id)}
            <tr class="border-b last:border-0 hover:bg-muted/40">
              <td class="px-4 py-2">
                <a
                  href={`/products/${row.id}`}
                  class="font-medium text-primary hover:underline"
                >
                  {row.name}
                </a>
              </td>
              <td class="px-4 py-2">{row.category}</td>
              <td class="px-4 py-2">{row.kind}</td>
              <td class="px-4 py-2">{row.variants}</td>
              <td class="px-4 py-2">{priceLabel(row)}</td>
              <td class="px-4 py-2">{row.stock}</td>
              <td class="px-4 py-2">
                <Badge
                  class={row.archived
                    ? "bg-muted text-muted-foreground"
                    : "bg-emerald-100 text-emerald-700"}
                >
                  {row.archived ? "Archived" : "Active"}
                </Badge>
              </td>
            </tr>
          {/each}
          {#if pageRows.length === 0}
            <tr>
              <td
                colspan={COLUMNS.length}
                class="px-4 py-10 text-center text-muted-foreground"
              >
                No products match.
              </td>
            </tr>
          {/if}
        </tbody>
      </table>
    </div>

    <div class="flex items-center justify-between text-sm text-muted-foreground">
      <span>
        {sorted.length} product{sorted.length === 1 ? "" : "s"}
      </span>
      <div class="flex items-center gap-2">
        <Button
          variant="outline"
          size="sm"
          disabled={currentPage <= 0}
          onclick={prevPage}
        >
          Previous
        </Button>
        <span>
          Page {currentPage + 1} of {pageCount}
        </span>
        <Button
          variant="outline"
          size="sm"
          disabled={currentPage >= pageCount - 1}
          onclick={nextPage}
        >
          Next
        </Button>
      </div>
    </div>
  {/if}
</div>
