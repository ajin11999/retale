<script lang="ts">
  import { graphql } from "$houdini";
  import {
    getCoreRowModel,
    getFilteredRowModel,
    getPaginationRowModel,
    getSortedRowModel,
    type ColumnDef,
  } from "@tanstack/table-core";
  import { createSvelteTable } from "$lib/data-table.svelte";
  import { formatMoney } from "$lib/utils";
  import Badge from "$lib/components/ui/badge.svelte";
  import Button from "$lib/components/ui/button.svelte";
  import Input from "$lib/components/ui/input.svelte";
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

  let { data }: { data: PageData } = $props();
  const ProductList = $derived(data.ProductList);

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
  <div class="flex items-center justify-between">
    <h1 class="text-xl font-semibold">Products</h1>
    <div class="w-64">
      <Input
        type="search"
        placeholder="Search products…"
        value={(table.getState().globalFilter as string) ?? ""}
        oninput={(e) =>
          table.setGlobalFilter(e.currentTarget.value)}
      />
    </div>
  </div>

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
