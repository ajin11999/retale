<script lang="ts">
  import NumericInput from "$lib/components/ui/numeric-input.svelte";
  import { CachePolicy, graphql } from "$houdini";
  import { goto } from "$app/navigation";
  import { page } from "$app/state";
  import { Check, Pencil, X } from "@lucide/svelte";
  import { formatMoney, matchesTokens, searchTokens, statusLabel, treePathMap } from "$lib/utils";
  import type { Viewer } from "../+layout.server";
  import Badge from "$lib/components/ui/badge.svelte";
  import Button from "$lib/components/ui/button.svelte";
  import IconButton from "$lib/components/ui/icon-button.svelte";
  import DuplicateHint from "$lib/components/ui/duplicate-hint.svelte";
  import Combobox from "$lib/components/ui/combobox.svelte";
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
        publicName
        description
        kind
        categoryId
        minQty
        minMarginBps
        archivedAt
        variants {
          id
          sku
          label
          priceMinor
          costMinor
          totalQty
        }
      }
      categories {
        id
        name
        parentId
      }
    }
  `);

  const CreateProduct = graphql(`
    mutation ConsoleCreateProduct(
      $name: String!
      $kind: ProductKind
      $categoryId: ID
      $priceMode: PriceMode!
      $costRatioBps: Int
      $variants: [VariantInput!]!
    ) {
      createProduct(
        name: $name
        kind: $kind
        categoryId: $categoryId
        priceMode: $priceMode
        costRatioBps: $costRatioBps
        variants: $variants
      ) {
        id
      }
    }
  `);

  // Quick-edit mutations. List-scoped document names so they don't collide with
  // the detail page's ConsoleUpdateProduct / ConsoleUpdateVariant.
  const TableEditUpdateProduct = graphql(`
    mutation ConsoleTableEditUpdateProduct(
      $id: ID!
      $name: String
      $publicName: String
      $description: String
      $categoryId: ID
      $minQty: Int
      $minMarginBps: Int
    ) {
      updateProduct(
        id: $id
        name: $name
        publicName: $publicName
        description: $description
        categoryId: $categoryId
        minQty: $minQty
        minMarginBps: $minMarginBps
      ) {
        id
        name
        publicName
        description
        categoryId
        minQty
        minMarginBps
      }
    }
  `);

  const UpdateProductName = graphql(`
    mutation ConsoleListUpdateProductName($id: ID!, $name: String!) {
      updateProduct(id: $id, name: $name) {
        id
        name
      }
    }
  `);

  const UpdateVariantPrice = graphql(`
    mutation ConsoleListUpdateVariantPrice($id: ID!, $priceMinor: Float!) {
      updateVariant(id: $id, priceMinor: $priceMinor) {
        id
        priceMinor
      }
    }
  `);

  // Bulk-action mutations, applied one product at a time over the selection.
  // A null categoryId moves the product to Uncategorized.
  const BulkUpdateCategory = graphql(`
    mutation ConsoleBulkUpdateProductCategory($id: ID!, $categoryId: ID) {
      updateProduct(id: $id, categoryId: $categoryId) {
        id
        categoryId
      }
    }
  `);

  const BulkDeleteProduct = graphql(`
    mutation ConsoleBulkHardDeleteProduct($id: ID!) {
      hardDeleteProduct(id: $id)
    }
  `);

  const BulkUpdateProductSettings = graphql(`
    mutation ConsoleBulkUpdateProductSettings($id: ID!, $minQty: Int, $minMarginBps: Int) {
      updateProduct(id: $id, minQty: $minQty, minMarginBps: $minMarginBps) {
        id
        minQty
        minMarginBps
      }
    }
  `);

  let { data }: { data: PageData } = $props();
  const ProductList = $derived(data.ProductList);

  // Breadcrumb path per category ("Electronics › Phones › Cases") so same-named
  // children under different parents are distinguishable in pickers + columns.
  const categoryPaths = $derived(
    treePathMap($ProductList.data?.categories ?? []),
  );

  const viewer = $derived(page.data.user as Viewer | undefined);
  const has = (key: string) => !!viewer && viewer.permissions.includes(key);
  const canCreate = $derived(has("product.create"));
  const canEdit = $derived(has("product.edit"));
  const canEditPrice = $derived(has("product.edit_price"));
  const canDelete = $derived(has("product.hard_delete"));

  const KINDS = ["physical", "service", "bundle", "open_price", "non_stock"];
  const PRICE_MODES = ["tax_inclusive", "tax_exclusive"];

  interface ProductDraft {
    name: string;
    categoryId: string;
    kind: string;
    priceMode: string;
    sku: string;
    priceMinor: number | null;
    costMinor: number | null;
    costRatioBps: number | null;
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
      costRatioBps: null,
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
        costRatioBps: d.kind === "open_price" ? d.costRatioBps : null,
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
    publicName: string | null;
    description: string | null;
    kind: string;
    categoryId: string | null;
    category: string;
    variants: number;
    // The lone variant's id when the product has exactly one — the quick-edit
    // target. `null` for zero- or multi-variant products (not quick-editable).
    variantId: string | null;
    minPrice: number;
    maxPrice: number;
    costMinor: number | null;
    stock: number;
    archived: boolean;
    minMarginBps: number | null;
    minQty: number | null;
    productMinMarginBps: number | null;
    haystack: string;
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
  // Archived products are hidden by default; toggled by the header checkbox.
  let showArchived = $state(false);
  let search = $state("");
  let maxMarginInput = $state("");
  let maxMarginFilter = $state<number | null>(null);
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

  let marginDebounceTimer: ReturnType<typeof setTimeout> | undefined;
  function onMarginInput(value: string) {
    maxMarginInput = value;
    clearTimeout(marginDebounceTimer);
    marginDebounceTimer = setTimeout(() => {
      const parsed = parseFloat(value);
      maxMarginFilter = isNaN(parsed) ? null : parsed * 100;
      pageIndex = 0;
    }, 500);
  }

  // Map products → rows once per data change (independent of the search term),
  // with a precomputed lowercase haystack so each query is a cheap substring
  // scan rather than a full re-map + lowercasing pass.
  const allRows = $derived.by<(Row & { haystack: string })[]>(() => {
    const result = $ProductList?.data;
    if (!result) return [];
    const catName = categoryPaths;
    return result.products.map((p) => {
      const prices = p.variants.map((v) => v.priceMinor);
      const category = p.categoryId
        ? (catName.get(p.categoryId) ?? "Unknown")
        : "Uncategorized";

      let variantHaystack = "";
      let minMarginBps: number | null = null;
      for (const v of p.variants) {
        variantHaystack += ` ${v.sku} ${v.label || ""}`;
        let marginBps: number | null = null;
        if (v.priceMinor > 0 && v.costMinor > 0) {
          marginBps = Math.round(((v.priceMinor - v.costMinor) / v.priceMinor) * 10000);
        } else if (v.priceMinor <= 0 && v.costMinor > 0) {
          marginBps = -10000;
        }
        if (marginBps !== null) {
          if (minMarginBps === null || marginBps < minMarginBps) {
            minMarginBps = marginBps;
          }
        }
      }

      return {
        id: p.id,
        name: p.name,
        publicName: p.publicName ?? null,
        description: p.description ?? null,
        kind: p.kind,
        categoryId: p.categoryId ?? null,
        category,
        variants: p.variants.length,
        variantId: p.variants.length === 1 ? p.variants[0].id : null,
        minPrice: prices.length ? Math.min(...prices) : 0,
        maxPrice: prices.length ? Math.max(...prices) : 0,
        costMinor: p.variants.length === 1 ? p.variants[0].costMinor : null,
        stock: p.variants.reduce((sum, v) => sum + v.totalQty, 0),
        archived: p.archivedAt != null,
        minMarginBps,
        minQty: p.minQty ?? null,
        productMinMarginBps: p.minMarginBps ?? null,
        haystack: `${p.name} ${category} ${p.kind} ${variantHaystack}`.toLowerCase(),
      };
    });
  });

  // Optional category filter, driven by `?category=<id>` (set from the
  // Categories screen's product-count links). The category's name, looked up
  // for the active-filter banner.
  const categoryFilter = $derived(page.url.searchParams.get("category"));
  const categoryFilterName = $derived(
    categoryFilter
      ? (categoryPaths.get(categoryFilter) ?? "this category")
      : null,
  );

  function clearCategoryFilter() {
    goto("/products", { keepFocus: true, noScroll: true });
  }

  // Combobox options for the new-product Category picker: a leading
  // "Uncategorized" row (empty value) then one row per category.
  const categoryOptions = $derived([
    { value: "", label: "Uncategorized" },
    ...($ProductList.data?.categories ?? []).map((c) => ({
      value: c.id,
      label: categoryPaths.get(c.id) ?? c.name,
    })),
  ]);

  const rows = $derived.by<Row[]>(() => {
    let base = allRows;
    if (!showArchived) base = base.filter((r) => !r.archived);
    if (categoryFilter) base = base.filter((r) => r.categoryId === categoryFilter);
    if (maxMarginFilter !== null) {
      const mm = maxMarginFilter;
      base = base.filter((r) => r.minMarginBps !== null && r.minMarginBps <= mm);
    }
    // AND-match whitespace tokens, so "sproc sss" matches "sprocket … sss"
    // regardless of word order — mirrors the server-side listProducts search
    // rather than a single contiguous match.
    const tokens = searchTokens(search);
    if (!tokens.length) return base;
    return base.filter((r) => matchesTokens(tokens, r.haystack));
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

  let tableEditMode = $state(false);
  const PAGE_SIZE = $derived(tableEditMode ? 50 : 15);
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

  // ---- Bulk selection ------------------------------------------------------
  // The checkbox column drives mass actions (delete, recategorize). Selection
  // is a set of product ids, pruned to the visible (filtered) set whenever the
  // filters change — so a row hidden by search/category/archived can never be
  // silently acted on. The header checkbox spans the whole filtered set, not
  // just the current page, so a bulk action can cover results across pages.
  let selectedIds = $state<string[]>([]);
  const selectedSet = $derived(new Set(selectedIds));

  $effect(() => {
    const visible = new Set(rows.map((r) => r.id));
    const pruned = selectedIds.filter((id) => visible.has(id));
    if (pruned.length !== selectedIds.length) selectedIds = pruned;
  });

  const allSelected = $derived(rows.length > 0 && selectedIds.length === rows.length);
  const someSelected = $derived(selectedIds.length > 0 && !allSelected);

  function toggleRow(id: string) {
    selectedIds = selectedSet.has(id)
      ? selectedIds.filter((x) => x !== id)
      : [...selectedIds, id];
  }
  function toggleAll() {
    selectedIds = allSelected ? [] : rows.map((r) => r.id);
  }
  // Native checkbox `indeterminate` is a DOM property, not an attribute.
  function indeterminate(el: HTMLInputElement, value: boolean) {
    el.indeterminate = value;
    return { update: (v: boolean) => (el.indeterminate = v) };
  }

  // `bulkCategoryPicked` distinguishes a deliberate "Uncategorized" (value "")
  // choice from the untouched initial state, so Move stays disabled until the
  // user actually picks a target.
  let bulkCategoryId = $state("");
  let bulkCategoryPicked = $state(false);
  let bulkBusy = $state(false);

  async function finishBulk(
    total: number,
    failed: number,
    firstError: string,
    pastVerb: string,
  ) {
    const ok = total - failed;
    feedback = failed
      ? { ok: false, text: `${pastVerb} ${ok} of ${total}; ${failed} failed — ${firstError}` }
      : { ok: true, text: `${ok} product${ok === 1 ? "" : "s"} ${pastVerb.toLowerCase()}.` };
    selectedIds = [];
    bulkBusy = false;
    await ProductList.fetch({ policy: CachePolicy.NetworkOnly });
  }

  async function bulkSetCategory() {
    const ids = [...selectedIds];
    if (!ids.length || !bulkCategoryPicked) return;
    bulkBusy = true;
    feedback = null;
    let failed = 0;
    let firstError = "";
    for (const id of ids) {
      const res = await BulkUpdateCategory.mutate({
        id,
        categoryId: bulkCategoryId || null,
      });
      if (res.errors?.length) {
        failed++;
        firstError ||= res.errors[0].message;
      }
    }
    bulkCategoryPicked = false;
    bulkCategoryId = "";
    await finishBulk(ids.length, failed, firstError, "Moved");
  }

  let showBulkEditModal = $state(false);
  let bulkMinMarginInput = $state<number | null>(null);
  let bulkMinQtyInput = $state<number | null>(null);
  let clearMinMargin = $state(false);
  let clearMinQty = $state(false);

  async function applyBulkEdit() {
    const ids = [...selectedIds];
    if (!ids.length) return;

    let minMarginBps: number | null | undefined = undefined;
    if (clearMinMargin) {
      minMarginBps = null;
    } else if (bulkMinMarginInput != null) {
      minMarginBps = Math.round(bulkMinMarginInput * 100);
    }

    let minQty: number | null | undefined = undefined;
    if (clearMinQty) {
      minQty = null;
    } else if (bulkMinQtyInput != null) {
      minQty = bulkMinQtyInput;
    }

    if (minMarginBps === undefined && minQty === undefined) {
      showBulkEditModal = false;
      return;
    }

    bulkBusy = true;
    feedback = null;
    let failed = 0;
    let firstError = "";

    for (const id of ids) {
      const res = await BulkUpdateProductSettings.mutate({
        id,
        minQty,
        minMarginBps,
      });
      if (res.errors?.length) {
        failed++;
        firstError ||= res.errors[0].message;
      }
    }

    showBulkEditModal = false;
    bulkMinMarginInput = null;
    bulkMinQtyInput = null;
    clearMinMargin = false;
    clearMinQty = false;
    await finishBulk(ids.length, failed, firstError, "Updated settings for");
  }

  async function bulkDelete() {
    const ids = [...selectedIds];
    if (!ids.length) return;
    if (
      !confirm(
        `Permanently delete ${ids.length} product${ids.length === 1 ? "" : "s"}? This cannot be undone.`,
      )
    )
      return;
    bulkBusy = true;
    feedback = null;
    let failed = 0;
    let firstError = "";
    for (const id of ids) {
      const res = await BulkDeleteProduct.mutate({ id });
      if (res.errors?.length) {
        failed++;
        firstError ||= res.errors[0].message;
      }
    }
    await finishBulk(ids.length, failed, firstError, "Deleted");
  }

  function priceLabel(r: Row): string {
    if (r.variants === 0) return "—";
    return r.minPrice === r.maxPrice
      ? formatMoney(r.minPrice)
      : `${formatMoney(r.minPrice)} – ${formatMoney(r.maxPrice)}`;
  }

  const sortGlyph = (key: SortKey) =>
    sortKey === key ? (sortDir === "asc" ? " ↑" : " ↓") : "";


  // ---- Table Edit State ----
  interface EditDraft {
    name: string;
    publicName: string;
    description: string;
    categoryId: string;
    priceMinor: number | null;
    minQty: number | null;
    minMarginBps: number | null;
  }

  let editingRows = $state<Map<string, EditDraft>>(new Map());
  let editBusy = $state(false);

  function ensureEditing(row: Row) {
    if (editingRows.has(row.id)) return;
    editingRows.set(row.id, {
      name: row.name,
      publicName: row.publicName ?? '',
      description: row.description ?? '',
      categoryId: row.categoryId ?? '',
      priceMinor: row.variants === 1 ? row.minPrice : null,
      minQty: row.minQty,
      minMarginBps: row.productMinMarginBps,
    });
    editingRows = new Map(editingRows);
  }

  function patchEdit(id: string, field: string, value: any) {
    const draft = editingRows.get(id);
    if (draft) {
      (draft as any)[field] = value;
      editingRows = new Map(editingRows);
    }
  }

  function cancelRow(id: string) {
    editingRows.delete(id);
    editingRows = new Map(editingRows);
  }

  async function saveRow(productId: string) {
    const draft = editingRows.get(productId);
    const original = allRows.find(r => r.id === productId);
    if (!draft || !original) return;

    editBusy = true;
    feedback = null;
    try {
      const productChanges: any = { id: productId };
      let hasProductChanges = false;
      if (draft.name !== original.name) { productChanges.name = draft.name; hasProductChanges = true; }
      if ((draft.publicName || null) !== (original.publicName || null)) { productChanges.publicName = draft.publicName || null; hasProductChanges = true; }
      if ((draft.description || null) !== (original.description || null)) { productChanges.description = draft.description || null; hasProductChanges = true; }
      if ((draft.categoryId || null) !== (original.categoryId || null)) { productChanges.categoryId = draft.categoryId || null; hasProductChanges = true; }
      if (draft.minQty !== original.minQty) { productChanges.minQty = draft.minQty; hasProductChanges = true; }
      if (draft.minMarginBps !== original.productMinMarginBps) { productChanges.minMarginBps = draft.minMarginBps; hasProductChanges = true; }

      if (hasProductChanges) {
        const res = await TableEditUpdateProduct.mutate(productChanges);
        if (res.errors?.length) { feedback = { ok: false, text: res.errors[0].message }; return; }
      }

      if (canEditPrice && original.variants === 1 && original.variantId && draft.priceMinor !== original.minPrice) {
        const res = await UpdateVariantPrice.mutate({ id: original.variantId, priceMinor: draft.priceMinor ?? 0 });
        if (res.errors?.length) { feedback = { ok: false, text: res.errors[0].message }; return; }
      }

      editingRows.delete(productId);
      editingRows = new Map(editingRows);
      await ProductList.fetch({ policy: CachePolicy.NetworkOnly });
    } catch (e) {
      feedback = { ok: false, text: e instanceof Error ? e.message : String(e) };
    } finally {
      editBusy = false;
    }
  }

  // ---- Inline quick edit (single-variant products only) --------------------
  // Rename the product and retune its lone variant's price in place, without
  // opening the detail page. Products with zero or multiple variants are
  // skipped — there's no single price to edit — so use the detail page there.
  let quick = $state<{
    id: string;
    variantId: string;
    name: string;
    priceMinor: number | null;
    focus: "name" | "price";
  } | null>(null);

  function startQuick(row: Row, focus: "name" | "price") {
    if (!canEdit || busy || row.variants !== 1 || !row.variantId) return;
    quick = {
      id: row.id,
      variantId: row.variantId,
      name: row.name,
      priceMinor: row.minPrice,
      focus,
    };
  }

  async function saveQuick() {
    const q = quick;
    if (!q || !q.name.trim()) return;
    const current = allRows.find((r) => r.id === q.id);
    busy = true;
    feedback = null;
    try {
      const name = q.name.trim();
      if (name !== current?.name) {
        const res = await UpdateProductName.mutate({ id: q.id, name });
        if (res.errors?.length) {
          feedback = { ok: false, text: res.errors[0].message };
          return;
        }
      }
      // Price is gated separately; skip it for staff without product.edit_price.
      if (canEditPrice) {
        const price = q.priceMinor ?? 0;
        if (price !== (current?.minPrice ?? 0)) {
          const res = await UpdateVariantPrice.mutate({
            id: q.variantId,
            priceMinor: price,
          });
          if (res.errors?.length) {
            feedback = { ok: false, text: res.errors[0].message };
            return;
          }
        }
      }
      quick = null;
      // The cached list won't reflect the edit without a round-trip.
      await ProductList.fetch({ policy: CachePolicy.NetworkOnly });
    } catch (e) {
      feedback = { ok: false, text: e instanceof Error ? e.message : String(e) };
    } finally {
      busy = false;
    }
  }

  function quickKeydown(e: KeyboardEvent) {
    if (e.key === "Enter") {
      e.preventDefault();
      saveQuick();
    } else if (e.key === "Escape") {
      e.preventDefault();
      quick = null;
    }
  }

  // Focus + select the name <input> on mount. MoneyInput self-focuses via its
  // own `autofocus` prop, so this only drives the name field.
  function autofocus(el: HTMLInputElement, enabled: boolean) {
    if (enabled) {
      el.focus();
      el.select();
    }
  }

  const quickInputClass =
    "flex h-7 w-full rounded-md border border-input bg-background px-2 py-1 " +
    "text-sm shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";
</script>

<svelte:head><title>Products · Retale Console</title></svelte:head>


{#snippet marginBadge(price: number, cost: number | null, minMarginBps: number | null)}
  {#if cost != null && price > 0}
    {@const marginPct = ((price - cost) / price) * 100}
    {@const belowMin = minMarginBps != null && marginPct * 100 < minMarginBps}
    <span class="inline-flex items-center rounded-full px-1.5 py-0.5 text-[10px] font-medium
      {marginPct <= 0 ? 'bg-red-100 text-red-700' :
       belowMin ? 'bg-amber-100 text-amber-700' :
       'bg-emerald-100 text-emerald-700'}">
      {marginPct.toFixed(1)}%
    </span>
  {/if}
{/snippet}

<div class="space-y-4">
  <div class="flex items-center justify-between gap-3">
    <h1 class="text-xl font-semibold">Products</h1>
    <div class="flex items-center gap-3">
      <label class="flex items-center gap-1.5 text-sm text-muted-foreground">
        <input type="checkbox" bind:checked={showArchived} class="size-4" />
        Show archived
      </label>
      <div class="w-64">
        <Input
          type="search"
          placeholder="Search products…"
          value={searchInput}
          oninput={(e) => onSearchInput(e.currentTarget.value)}
        />
      </div>
      <div class="w-32">
        <NumericInput
          placeholder="Max margin %"
          value={maxMarginInput}
          oninput={(e) => onMarginInput(e.currentTarget.value)}
        />
      </div>
      {#if canEdit}
        <Button
          size="sm"
          variant={tableEditMode ? "default" : "outline"}
          onclick={() => (tableEditMode = !tableEditMode)}
        >
          {tableEditMode ? "Exit table edit" : "Table edit"}
        </Button>
      {/if}
      {#if canCreate}
        <Button
          size="sm"
          variant="outline"
          onclick={() => goto("/products/bulk")}
        >
          Bulk add
        </Button>
      {/if}
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
            noun="product"
          />
        </label>
        <label class="space-y-1">
          <span class="text-xs font-medium">Category</span>
          <Combobox
            options={categoryOptions}
            bind:value={draft.categoryId}
            placeholder="Search category…"
          />
        </label>
        <label class="space-y-1">
          <span class="text-xs font-medium">Kind</span>
          <Select bind:value={draft.kind}>
            {#each KINDS as k (k)}<option value={k}>{k}</option>{/each}
          </Select>
        </label>
        {#if draft.kind === "open_price"}
          <label class="space-y-1">
            <span class="text-xs font-medium">Cost ratio (%)</span>
            <NumericInput
              step="0.1"
              value={draft.costRatioBps == null ? null : draft.costRatioBps / 100}
              oninput={(e) => {
                const n = Number.parseFloat(e.currentTarget.value);
                draft!.costRatioBps = Number.isFinite(n) ? Math.round(n * 100) : null;
              }}
            />
            <span class="text-xs text-muted-foreground"
              >Assumed cost as % of the entered sale price.</span
            >
          </label>
        {/if}
        {#if draft.kind === "non_stock"}
          <p class="col-span-2 text-xs text-muted-foreground">
            Cost-tracked, no stock — sells at a real price (overridable at the
            register) with its cost auto-maintained from purchases/landed cost.
            For resale-priced items like fasteners.
          </p>
        {/if}
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

  {#if selectedIds.length > 0 && (canEdit || canDelete)}
    <div
      class="flex flex-wrap items-center gap-3 rounded-md border bg-muted/40 px-3 py-2 text-sm"
    >
      <span class="font-medium">{selectedIds.length} selected</span>
      {#if canEdit}
        <div class="flex items-center gap-2">
          <div class="w-56">
            <Combobox
              options={categoryOptions}
              bind:value={bulkCategoryId}
              placeholder="Move to category…"
              onChange={() => (bulkCategoryPicked = true)}
            />
          </div>
          <Button
            size="sm"
            variant="outline"
            disabled={bulkBusy || !bulkCategoryPicked}
            onclick={bulkSetCategory}
          >
            Move
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={bulkBusy}
            onclick={() => (showBulkEditModal = true)}
          >
            Bulk edit
          </Button>
        </div>
      {/if}
      {#if canDelete}
        <Button
          size="sm"
          variant="destructive"
          disabled={bulkBusy}
          onclick={bulkDelete}
        >
          Delete
        </Button>
      {/if}
      <button
        class="ml-auto text-xs text-primary hover:underline"
        disabled={bulkBusy}
        onclick={() => (selectedIds = [])}
      >
        Clear
      </button>
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

      {#if tableEditMode}
        <table class="w-full text-sm">
          <thead class="border-b bg-muted/50 text-muted-foreground">
            <tr>
              <th class="px-3 py-2 text-left font-medium">Name</th>
              <th class="px-3 py-2 text-left font-medium">Public Name</th>
              <th class="px-3 py-2 text-left font-medium">Category</th>
              <th class="px-3 py-2 text-left font-medium">Price</th>
              <th class="px-3 py-2 text-left font-medium">Description</th>
              <th class="px-3 py-2 text-left font-medium">Min Qty</th>
              <th class="px-3 py-2 text-left font-medium">Min Margin</th>
              <th class="w-16 px-3 py-2"></th>
            </tr>
          </thead>
          <tbody>
            {#each pageRows as row (row.id)}
              {@const edit = editingRows.get(row.id)}
              {@const isDirty = edit != null}
              {@const mmBps = edit?.minMarginBps ?? row.productMinMarginBps}
              <tr class="border-b last:border-0 hover:bg-muted/40 {isDirty ? 'bg-amber-50/50 hover:bg-amber-50/70' : ''}">
                <td class="px-2 py-1">
                  <input class={quickInputClass} value={edit?.name ?? row.name}
                    onfocus={() => ensureEditing(row)}
                    oninput={(e) => patchEdit(row.id, 'name', e.currentTarget.value)} />
                </td>
                <td class="px-2 py-1">
                  <input class={quickInputClass} value={edit?.publicName ?? row.publicName ?? ''}
                    placeholder="(same as name)"
                    onfocus={() => ensureEditing(row)}
                    oninput={(e) => patchEdit(row.id, 'publicName', e.currentTarget.value)} />
                </td>
                <td class="px-2 py-1">
                  <div class="w-40">
                    <Combobox options={categoryOptions} value={edit?.categoryId ?? row.categoryId ?? ''}
                      onChange={(v) => { ensureEditing(row); patchEdit(row.id, 'categoryId', v); }} />
                  </div>
                </td>
                <td class="px-2 py-1">
                  {#if row.variants === 1}
                    <div class="flex items-center gap-2">
                      {#if canEditPrice}
                        <MoneyInput value={edit?.priceMinor ?? row.minPrice}
                          onfocus={() => ensureEditing(row)}
                          oninput={(v) => patchEdit(row.id, 'priceMinor', v)}
                          class="h-7 w-28 px-2" />
                      {:else}
                        <span class="w-28 text-muted-foreground">{priceLabel(row)}</span>
                      {/if}
                      {@render marginBadge(edit?.priceMinor ?? row.minPrice, row.costMinor, row.productMinMarginBps)}
                    </div>
                  {:else}
                    <div class="flex items-center gap-2">
                      <span class="text-muted-foreground">{priceLabel(row)}</span>
                      {@render marginBadge(row.minPrice, row.costMinor, row.productMinMarginBps)}
                    </div>
                  {/if}
                </td>
                <td class="px-2 py-1">
                  <input class={quickInputClass} value={edit?.description ?? row.description ?? ''}
                    onfocus={() => ensureEditing(row)}
                    oninput={(e) => patchEdit(row.id, 'description', e.currentTarget.value)} />
                </td>
                <td class="px-2 py-1">
                  <NumericInput value={edit?.minQty ?? row.minQty}
                    onfocus={() => ensureEditing(row)}
                    oninput={(e) => {
                      const v = e.currentTarget.value;
                      patchEdit(row.id, 'minQty', v ? Number(v) : null);
                    }} class="h-7 w-20" />
                </td>
                <td class="px-2 py-1">
                  <NumericInput value={mmBps != null ? mmBps / 100 : null}
                    onfocus={() => ensureEditing(row)}
                    oninput={(e) => {
                      const v = e.currentTarget.value;
                      patchEdit(row.id, 'minMarginBps', v ? Math.round(Number(v) * 100) : null);
                    }}
                    class="h-7 w-20" step="0.1" />
                </td>
                <td class="px-2 py-1 text-right whitespace-nowrap">
                  {#if isDirty}
                    <span class="inline-flex items-center gap-0.5">
                      <IconButton icon={Check} label="Save" variant="primary"
                        disabled={editBusy} onclick={() => saveRow(row.id)} />
                      <IconButton icon={X} label="Cancel"
                        disabled={editBusy} onclick={() => cancelRow(row.id)} />
                    </span>
                  {/if}
                </td>
              </tr>
            {/each}
            {#if pageRows.length === 0}
              <tr>
                <td colspan="8" class="px-4 py-10 text-center text-muted-foreground">
                  No products match.
                </td>
              </tr>
            {/if}
          </tbody>
        </table>
      {:else}
      <table class="w-full text-sm">
        <thead class="border-b bg-muted/50 text-muted-foreground">
          <tr>
            {#if canEdit || canDelete}
              <th class="w-8 px-4 py-2">
                <input
                  type="checkbox"
                  class="size-4 align-middle"
                  aria-label="Select all"
                  checked={allSelected}
                  use:indeterminate={someSelected}
                  onchange={toggleAll}
                />
              </th>
            {/if}
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
            <th class="px-4 py-2"></th>
          </tr>
        </thead>
        <tbody>
          {#each pageRows as row (row.id)}
            <tr class="border-b last:border-0 hover:bg-muted/40">
              {#if canEdit || canDelete}
                <td class="px-4 py-2">
                  <input
                    type="checkbox"
                    class="size-4 align-middle"
                    aria-label="Select {row.name}"
                    checked={selectedSet.has(row.id)}
                    onchange={() => toggleRow(row.id)}
                  />
                </td>
              {/if}
              <td class="px-4 py-2">
                {#if quick?.id === row.id}
                  <input
                    class={quickInputClass}
                    bind:value={quick.name}
                    onkeydown={quickKeydown}
                    use:autofocus={quick.focus === "name"}
                  />
                {:else}
                  <a
                    href={`/products/${row.id}`}
                    class="font-medium text-primary hover:underline"
                  >
                    {row.name}
                  </a>
                {/if}
              </td>
              <td class="px-4 py-2">{row.category}</td>
              <td class="px-4 py-2">{statusLabel(row.kind)}</td>
              <td class="px-4 py-2">{row.variants}</td>
              <td class="px-4 py-2">
                {#if quick?.id === row.id}
                  {#if canEditPrice}
                    <MoneyInput
                      autofocus={quick.focus === "price"}
                      bind:value={quick.priceMinor}
                      onkeydown={quickKeydown}
                      class="h-7 w-28 px-2"
                    />
                  {:else}
                    {priceLabel(row)}
                  {/if}
                {:else if canEdit && canEditPrice && row.variants === 1}
                  <button
                    type="button"
                    class="-mx-1 rounded px-1 hover:bg-accent"
                    title="Edit price"
                    disabled={busy}
                    onclick={() => startQuick(row, "price")}
                  >
                    {priceLabel(row)}
                  </button>
                {:else}
                  {priceLabel(row)}
                {/if}
              </td>
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
              <td class="px-4 py-2 text-right whitespace-nowrap">
                {#if quick?.id === row.id}
                  <span class="inline-flex items-center gap-0.5">
                    <IconButton
                      icon={Check}
                      label="Save"
                      variant="primary"
                      disabled={busy || !quick.name.trim()}
                      onclick={saveQuick}
                    />
                    <IconButton
                      icon={X}
                      label="Cancel"
                      disabled={busy}
                      onclick={() => (quick = null)}
                    />
                  </span>
                {:else if canEdit && row.variants === 1}
                  <IconButton
                    icon={Pencil}
                    label="Quick edit"
                    variant="primary"
                    disabled={busy}
                    onclick={() => startQuick(row, "name")}
                  />
                {/if}
              </td>
            </tr>
          {/each}
          {#if pageRows.length === 0}
            <tr>
              <td
                colspan={COLUMNS.length + 1 + (canEdit || canDelete ? 1 : 0)}
                class="px-4 py-10 text-center text-muted-foreground"
              >
                No products match.
              </td>
            </tr>
          {/if}
        </tbody>
      </table>
      {/if}
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

{#if showBulkEditModal}
  <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
  <!-- svelte-ignore a11y_click_events_have_key_events -->
  <div
    class="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
    role="presentation"
    onclick={(e) => e.target === e.currentTarget && (showBulkEditModal = false)}
  >
    <div
      class="flex w-full max-w-sm flex-col rounded-lg border bg-card shadow-xl"
      role="dialog"
      aria-modal="true"
      aria-label="Bulk edit product settings"
    >
      <div class="flex items-center justify-between border-b px-5 py-3">
        <h2 class="text-sm font-semibold">Bulk edit settings</h2>
        <button
          class="rounded-sm opacity-70 hover:opacity-100"
          onclick={() => (showBulkEditModal = false)}
        >
          <X class="size-4" />
        </button>
      </div>
      <div class="space-y-4 p-5">
        <label class="block space-y-1">
          <span class="text-xs font-medium">Minimum margin (%)</span>
          <NumericInput
            placeholder="Leave blank for no change"
            bind:value={bulkMinMarginInput}
            disabled={clearMinMargin || bulkBusy}
          />
          <label class="mt-1 flex items-center gap-1.5 text-xs text-muted-foreground">
            <input type="checkbox" bind:checked={clearMinMargin} disabled={bulkBusy} class="size-3" />
            Clear existing value
          </label>
        </label>
        <label class="block space-y-1">
          <span class="text-xs font-medium">Minimum quantity</span>
          <NumericInput
            placeholder="Leave blank for no change"
            bind:value={bulkMinQtyInput}
            disabled={clearMinQty || bulkBusy}
          />
          <label class="mt-1 flex items-center gap-1.5 text-xs text-muted-foreground">
            <input type="checkbox" bind:checked={clearMinQty} disabled={bulkBusy} class="size-3" />
            Clear existing value
          </label>
        </label>
      </div>
      <div class="flex items-center justify-end gap-2 border-t bg-muted/20 px-5 py-3 rounded-b-lg">
        <Button variant="ghost" size="sm" onclick={() => (showBulkEditModal = false)}>
          Cancel
        </Button>
        <Button size="sm" onclick={applyBulkEdit} disabled={bulkBusy}>
          Apply changes
        </Button>
      </div>
    </div>
  </div>
{/if}
