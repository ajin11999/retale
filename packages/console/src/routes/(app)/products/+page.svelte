<script lang="ts">
  import { graphql } from "$houdini";
  import { goto } from "$app/navigation";
  import { page } from "$app/state";
  import {
    getCoreRowModel,
    getFilteredRowModel,
    getPaginationRowModel,
    getSortedRowModel,
    type ColumnDef,
  } from "@tanstack/table-core";
  import { createSvelteTable } from "$lib/data-table.svelte";
  import { formatMoney } from "$lib/utils";
  import type { Viewer } from "../+layout.server";
  import Badge from "$lib/components/ui/badge.svelte";
  import Button from "$lib/components/ui/button.svelte";
  import Input from "$lib/components/ui/input.svelte";
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
    priceMinor: number;
    costMinor: number;
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
            priceMinor: d.priceMinor,
            costMinor: d.costMinor,
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
    category: string;
    variants: number;
    minPrice: number;
    maxPrice: number;
    stock: number;
    archived: boolean;
  }

  const rows = $derived.by<Row[]>(() => {
    const result = $ProductList?.data;
    if (!result) return [];
    const catName = new Map(result.categories.map((c) => [c.id, c.name]));
    return result.products.map((p) => {
      const prices = p.variants.map((v) => v.priceMinor);
      return {
        id: p.id,
        name: p.name,
        kind: p.kind,
        category: p.categoryId
          ? (catName.get(p.categoryId) ?? "Unknown")
          : "Uncategorized",
        variants: p.variants.length,
        minPrice: prices.length ? Math.min(...prices) : 0,
        maxPrice: prices.length ? Math.max(...prices) : 0,
        stock: p.variants.reduce((sum, v) => sum + v.totalQty, 0),
        archived: p.archivedAt != null,
      };
    });
  });

  const columns: ColumnDef<Row>[] = [
    { accessorKey: "name", header: "Product" },
    { accessorKey: "category", header: "Category" },
    { accessorKey: "kind", header: "Kind" },
    { accessorKey: "variants", header: "Variants" },
    { accessorKey: "minPrice", id: "price", header: "Price" },
    { accessorKey: "stock", header: "Stock" },
    { accessorKey: "archived", id: "status", header: "Status" },
  ];

  const table = createSvelteTable<Row>({
    get data() {
      return rows;
    },
    columns,
    initialState: { pagination: { pageSize: 15 } },
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
    getPaginationRowModel: getPaginationRowModel(),
  });

  function priceLabel(r: Row): string {
    if (r.variants === 0) return "—";
    return r.minPrice === r.maxPrice
      ? formatMoney(r.minPrice)
      : `${formatMoney(r.minPrice)} – ${formatMoney(r.maxPrice)}`;
  }

  const sortGlyph = (dir: false | "asc" | "desc") =>
    dir === "asc" ? " ↑" : dir === "desc" ? " ↓" : "";
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
          value={(table.getState().globalFilter as string) ?? ""}
          oninput={(e) =>
            table.setGlobalFilter(e.currentTarget.value)}
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

  {#if draft}
    <div class="space-y-3 rounded-lg border bg-card p-5">
      <h2 class="text-sm font-semibold">New product</h2>
      <div class="grid grid-cols-2 gap-3">
        <label class="space-y-1">
          <span class="text-xs font-medium">Name</span>
          <Input bind:value={draft.name} placeholder="Product name" />
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
          <span class="text-xs font-medium">Price (minor units)</span>
          <Input type="number" bind:value={draft.priceMinor} />
        </label>
        <label class="space-y-1">
          <span class="text-xs font-medium">Cost (minor units)</span>
          <Input type="number" bind:value={draft.costMinor} />
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
          {#each table.getHeaderGroups() as headerGroup (headerGroup.id)}
            <tr>
              {#each headerGroup.headers as header (header.id)}
                <th class="px-4 py-2 text-left font-medium">
                  <button
                    class="inline-flex items-center hover:text-foreground"
                    onclick={header.column.getToggleSortingHandler()}
                  >
                    {header.column.columnDef.header}{sortGlyph(
                      header.column.getIsSorted(),
                    )}
                  </button>
                </th>
              {/each}
            </tr>
          {/each}
        </thead>
        <tbody>
          {#each table.getRowModel().rows as row (row.id)}
            <tr class="border-b last:border-0 hover:bg-muted/40">
              {#each row.getVisibleCells() as cell (cell.id)}
                <td class="px-4 py-2">
                  {#if cell.column.id === "name"}
                    <a
                      href={`/products/${row.original.id}`}
                      class="font-medium text-primary hover:underline"
                    >
                      {row.original.name}
                    </a>
                  {:else if cell.column.id === "price"}
                    {priceLabel(row.original)}
                  {:else if cell.column.id === "status"}
                    <Badge
                      class={row.original.archived
                        ? "bg-muted text-muted-foreground"
                        : "bg-emerald-100 text-emerald-700"}
                    >
                      {row.original.archived ? "Archived" : "Active"}
                    </Badge>
                  {:else}
                    {cell.getValue()}
                  {/if}
                </td>
              {/each}
            </tr>
          {/each}
          {#if table.getRowModel().rows.length === 0}
            <tr>
              <td
                colspan={columns.length}
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
        {table.getFilteredRowModel().rows.length} product{table.getFilteredRowModel()
          .rows.length === 1
          ? ""
          : "s"}
      </span>
      <div class="flex items-center gap-2">
        <Button
          variant="outline"
          size="sm"
          disabled={!table.getCanPreviousPage()}
          onclick={() => table.previousPage()}
        >
          Previous
        </Button>
        <span>
          Page {table.getState().pagination.pageIndex + 1} of
          {Math.max(table.getPageCount(), 1)}
        </span>
        <Button
          variant="outline"
          size="sm"
          disabled={!table.getCanNextPage()}
          onclick={() => table.nextPage()}
        >
          Next
        </Button>
      </div>
    </div>
  {/if}
</div>
