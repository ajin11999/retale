<script module lang="ts">
  // Houdini computes the query variables for the auto-loaded ProductDetail
  // query from the route param.
  export function _ProductDetailVariables(event: {
    params: Record<string, string>;
  }) {
    return { id: event.params.id };
  }
</script>

<script lang="ts">
  import { graphql } from "$houdini";
  import { formatMoney } from "$lib/utils";
  import Badge from "$lib/components/ui/badge.svelte";
  import Button from "$lib/components/ui/button.svelte";
  import Input from "$lib/components/ui/input.svelte";
  import Select from "$lib/components/ui/select.svelte";
  import Textarea from "$lib/components/ui/textarea.svelte";

  const ProductDetail = graphql(`
    query ProductDetail($id: ID!) {
      product(id: $id) {
        id
        name
        publicName
        description
        kind
        categoryId
        taxRateBps
        priceMode
        minQty
        minMarginBps
        replenishMonitored
        archivedAt
        createdAt
        variants {
          id
          sku
          barcode
          label
          unit
          qtyDecimals
          priceMinor
          costMinor
          totalQty
          sortOrder
        }
      }
      categories {
        id
        name
      }
    }
  `);

  const UpdateProduct = graphql(`
    mutation ConsoleUpdateProduct(
      $id: ID!
      $name: String
      $publicName: String
      $description: String
      $kind: ProductKind
      $categoryId: ID
      $taxRateBps: Int
      $priceMode: PriceMode
      $minQty: Int
      $minMarginBps: Int
      $replenishMonitored: Boolean
    ) {
      updateProduct(
        id: $id
        name: $name
        publicName: $publicName
        description: $description
        kind: $kind
        categoryId: $categoryId
        taxRateBps: $taxRateBps
        priceMode: $priceMode
        minQty: $minQty
        minMarginBps: $minMarginBps
        replenishMonitored: $replenishMonitored
      ) {
        id
        name
        publicName
        description
        kind
        categoryId
        taxRateBps
        priceMode
        minQty
        minMarginBps
        replenishMonitored
        archivedAt
      }
    }
  `);

  const SetArchived = graphql(`
    mutation ConsoleSetProductArchived($id: ID!, $archived: Boolean!) {
      setProductArchived(id: $id, archived: $archived) {
        id
        archivedAt
      }
    }
  `);

  const UpdateVariant = graphql(`
    mutation ConsoleUpdateVariant(
      $id: ID!
      $sku: String
      $barcode: String
      $label: String
      $unit: VariantUnit
      $qtyDecimals: Int
      $priceMinor: Float
      $costMinor: Float
      $sortOrder: Int
    ) {
      updateVariant(
        id: $id
        sku: $sku
        barcode: $barcode
        label: $label
        unit: $unit
        qtyDecimals: $qtyDecimals
        priceMinor: $priceMinor
        costMinor: $costMinor
        sortOrder: $sortOrder
      ) {
        id
        sku
        barcode
        label
        unit
        qtyDecimals
        priceMinor
        costMinor
        totalQty
        sortOrder
      }
    }
  `);

  const AddVariant = graphql(`
    mutation ConsoleAddVariant($productId: ID!, $variant: VariantInput!) {
      addVariant(productId: $productId, variant: $variant) {
        id
      }
    }
  `);

  const DeleteVariant = graphql(`
    mutation ConsoleDeleteVariant($id: ID!) {
      deleteVariant(id: $id)
    }
  `);

  const KINDS = ["physical", "service", "bundle"];
  const PRICE_MODES = ["tax_inclusive", "tax_exclusive"];
  const UNITS = ["piece", "g", "ml", "mm"];

  const product = $derived($ProductDetail.data?.product);
  const categories = $derived($ProductDetail.data?.categories ?? []);

  // ---- Product-detail form -------------------------------------------------
  interface ProductForm {
    name: string;
    publicName: string;
    description: string;
    kind: string;
    categoryId: string;
    priceMode: string;
    taxRateBps: number | null;
    minQty: number | null;
    minMarginBps: number | null;
    replenishMonitored: boolean;
  }

  let form = $state<ProductForm>({
    name: "",
    publicName: "",
    description: "",
    kind: "physical",
    categoryId: "",
    priceMode: "tax_inclusive",
    taxRateBps: 0,
    minQty: null,
    minMarginBps: null,
    replenishMonitored: false,
  });

  // Reset the form when a different product loads — but not on a plain
  // refetch of the same product, so in-progress edits survive.
  let syncedId = $state("");
  $effect(() => {
    const p = product;
    if (p && p.id !== syncedId) {
      syncedId = p.id;
      form = {
        name: p.name,
        publicName: p.publicName ?? "",
        description: p.description ?? "",
        kind: p.kind,
        categoryId: p.categoryId ?? "",
        priceMode: p.priceMode,
        taxRateBps: p.taxRateBps,
        minQty: p.minQty ?? null,
        minMarginBps: p.minMarginBps ?? null,
        replenishMonitored: p.replenishMonitored,
      };
    }
  });

  let busy = $state(false);
  let feedback = $state<{ ok: boolean; text: string } | null>(null);

  /** Run a mutation, surfacing the first GraphQL error as feedback. */
  async function run(
    label: string,
    fn: () => Promise<{ errors?: readonly { message: string }[] | null }>,
  ): Promise<boolean> {
    busy = true;
    feedback = null;
    try {
      const res = await fn();
      if (res.errors?.length) {
        feedback = { ok: false, text: res.errors[0].message };
        return false;
      }
      feedback = { ok: true, text: `${label} saved.` };
      return true;
    } catch (e) {
      feedback = { ok: false, text: e instanceof Error ? e.message : String(e) };
      return false;
    } finally {
      busy = false;
    }
  }

  async function saveProduct() {
    if (!product) return;
    await run("Product", () =>
      UpdateProduct.mutate({
        id: product.id,
        name: form.name,
        publicName: form.publicName.trim() || null,
        description: form.description.trim() || null,
        kind: form.kind as never,
        categoryId: form.categoryId || null,
        priceMode: form.priceMode as never,
        taxRateBps: form.taxRateBps,
        minQty: form.minQty,
        minMarginBps: form.minMarginBps,
        replenishMonitored: form.replenishMonitored,
      }),
    );
  }

  async function toggleArchived() {
    if (!product) return;
    await run("Product", () =>
      SetArchived.mutate({ id: product.id, archived: product.archivedAt == null }),
    );
  }

  // ---- Variant editor ------------------------------------------------------
  interface VariantDraft {
    id: string | null; // null → a new variant
    sku: string;
    barcode: string;
    label: string;
    unit: string;
    qtyDecimals: number;
    priceMinor: number;
    costMinor: number;
    sortOrder: number;
  }

  let variantDraft = $state<VariantDraft | null>(null);

  function editVariant(v: NonNullable<typeof product>["variants"][number]) {
    variantDraft = {
      id: v.id,
      sku: v.sku,
      barcode: v.barcode ?? "",
      label: v.label ?? "",
      unit: v.unit,
      qtyDecimals: v.qtyDecimals,
      priceMinor: v.priceMinor,
      costMinor: v.costMinor,
      sortOrder: v.sortOrder,
    };
  }

  function newVariant() {
    variantDraft = {
      id: null,
      sku: "",
      barcode: "",
      label: "",
      unit: "piece",
      qtyDecimals: 0,
      priceMinor: 0,
      costMinor: 0,
      sortOrder: (product?.variants.length ?? 0) + 1,
    };
  }

  async function saveVariant() {
    const d = variantDraft;
    if (!d || !product) return;

    const ok = await run("Variant", async () => {
      if (d.id) {
        return UpdateVariant.mutate({
          id: d.id,
          // Omit SKU when blank — it is non-null on the variant and must
          // not be cleared; barcode/label may be cleared to null.
          sku: d.sku.trim() || undefined,
          barcode: d.barcode.trim() || null,
          label: d.label.trim() || null,
          unit: d.unit as never,
          qtyDecimals: d.qtyDecimals,
          priceMinor: d.priceMinor,
          costMinor: d.costMinor,
          sortOrder: d.sortOrder,
        });
      }
      return AddVariant.mutate({
        productId: product.id,
        variant: {
          sku: d.sku.trim() || undefined, // omit → API auto-generates
          barcode: d.barcode.trim() || undefined,
          label: d.label.trim() || undefined,
          unit: d.unit as never,
          qtyDecimals: d.qtyDecimals,
          priceMinor: d.priceMinor,
          costMinor: d.costMinor,
          sortOrder: d.sortOrder,
        },
      });
    });

    if (ok) {
      variantDraft = null;
      // Adds change the variant set — refetch to pull the new row.
      if (!d.id) await ProductDetail.fetch({ variables: { id: product.id } });
    }
  }

  async function deleteVariant(id: string) {
    if (!product || !confirm("Delete this variant?")) return;
    const ok = await run("Variant", () => DeleteVariant.mutate({ id }));
    if (ok) await ProductDetail.fetch({ variables: { id: product.id } });
  }

  const categoryName = (id: string | null | undefined) =>
    id ? (categories.find((c) => c.id === id)?.name ?? "Unknown") : "—";
</script>

<svelte:head>
  <title>{product ? product.name : "Product"} · Retale Console</title>
</svelte:head>

<div class="mx-auto max-w-3xl space-y-6">
  <a href="/products" class="text-sm text-muted-foreground hover:text-foreground"
    >← Back to products</a
  >

  {#if $ProductDetail.fetching && !product}
    <p class="text-sm text-muted-foreground">Loading…</p>
  {:else if !product}
    <p class="text-sm text-destructive">Product not found.</p>
  {:else}
    <div class="flex items-start justify-between gap-4">
      <div>
        <h1 class="text-xl font-semibold">{product.name}</h1>
        <p class="text-sm text-muted-foreground">
          {categoryName(product.categoryId)} · {product.kind}
        </p>
      </div>
      <div class="flex items-center gap-3">
        <Badge
          class={product.archivedAt
            ? "bg-muted text-muted-foreground"
            : "bg-emerald-100 text-emerald-700"}
        >
          {product.archivedAt ? "Archived" : "Active"}
        </Badge>
        <Button variant="outline" size="sm" disabled={busy} onclick={toggleArchived}>
          {product.archivedAt ? "Restore" : "Archive"}
        </Button>
      </div>
    </div>

    {#if feedback}
      <p class="text-sm {feedback.ok ? 'text-emerald-700' : 'text-destructive'}">
        {feedback.text}
      </p>
    {/if}

    <!-- Product details -->
    <section class="space-y-4 rounded-lg border bg-card p-5">
      <h2 class="text-sm font-semibold">Details</h2>

      <div class="grid grid-cols-2 gap-4">
        <label class="space-y-1">
          <span class="text-sm font-medium">Name</span>
          <Input bind:value={form.name} />
        </label>
        <label class="space-y-1">
          <span class="text-sm font-medium">Public name</span>
          <Input bind:value={form.publicName} placeholder="Falls back to name" />
        </label>
      </div>

      <label class="space-y-1">
        <span class="text-sm font-medium">Description</span>
        <Textarea bind:value={form.description} />
      </label>

      <div class="grid grid-cols-2 gap-4">
        <label class="space-y-1">
          <span class="text-sm font-medium">Kind</span>
          <Select bind:value={form.kind}>
            {#each KINDS as k (k)}<option value={k}>{k}</option>{/each}
          </Select>
        </label>
        <label class="space-y-1">
          <span class="text-sm font-medium">Category</span>
          <Select bind:value={form.categoryId}>
            <option value="">Uncategorized</option>
            {#each categories as c (c.id)}
              <option value={c.id}>{c.name}</option>
            {/each}
          </Select>
        </label>
        <label class="space-y-1">
          <span class="text-sm font-medium">Price mode</span>
          <Select bind:value={form.priceMode}>
            {#each PRICE_MODES as m (m)}<option value={m}>{m}</option>{/each}
          </Select>
        </label>
        <label class="space-y-1">
          <span class="text-sm font-medium">Tax rate (basis points)</span>
          <Input type="number" bind:value={form.taxRateBps} />
        </label>
        <label class="space-y-1">
          <span class="text-sm font-medium">Min qty</span>
          <Input type="number" bind:value={form.minQty} />
        </label>
        <label class="space-y-1">
          <span class="text-sm font-medium">Min margin (basis points)</span>
          <Input type="number" bind:value={form.minMarginBps} />
        </label>
      </div>

      <label class="flex items-center gap-2">
        <input type="checkbox" bind:checked={form.replenishMonitored} />
        <span class="text-sm font-medium">Monitored by the reorder forecast</span>
      </label>

      <div class="flex justify-end">
        <Button disabled={busy} onclick={saveProduct}>Save details</Button>
      </div>
    </section>

    <!-- Variants -->
    <section class="space-y-3 rounded-lg border bg-card p-5">
      <div class="flex items-center justify-between">
        <h2 class="text-sm font-semibold">
          Variants ({product.variants.length})
        </h2>
        <Button variant="outline" size="sm" disabled={busy} onclick={newVariant}>
          Add variant
        </Button>
      </div>

      <table class="w-full text-sm">
        <thead class="border-b text-left text-muted-foreground">
          <tr>
            <th class="py-1.5 font-medium">SKU</th>
            <th class="py-1.5 font-medium">Label</th>
            <th class="py-1.5 font-medium">Unit</th>
            <th class="py-1.5 text-right font-medium">Price</th>
            <th class="py-1.5 text-right font-medium">Cost</th>
            <th class="py-1.5 text-right font-medium">Stock</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {#each product.variants as v (v.id)}
            <tr class="border-b last:border-0">
              <td class="py-1.5 font-mono text-xs">{v.sku}</td>
              <td class="py-1.5">{v.label ?? "—"}</td>
              <td class="py-1.5">{v.unit}</td>
              <td class="py-1.5 text-right">{formatMoney(v.priceMinor)}</td>
              <td class="py-1.5 text-right">{formatMoney(v.costMinor)}</td>
              <td class="py-1.5 text-right">{v.totalQty}</td>
              <td class="py-1.5 text-right">
                <button
                  class="text-xs text-primary hover:underline"
                  onclick={() => editVariant(v)}>Edit</button
                >
                <button
                  class="ml-2 text-xs text-destructive hover:underline"
                  onclick={() => deleteVariant(v.id)}>Delete</button
                >
              </td>
            </tr>
          {/each}
          {#if product.variants.length === 0}
            <tr>
              <td colspan="7" class="py-6 text-center text-muted-foreground">
                No variants yet.
              </td>
            </tr>
          {/if}
        </tbody>
      </table>

      {#if variantDraft}
        <div class="space-y-3 rounded-md border bg-background p-4">
          <h3 class="text-sm font-semibold">
            {variantDraft.id ? "Edit variant" : "New variant"}
          </h3>
          <div class="grid grid-cols-3 gap-3">
            <label class="space-y-1">
              <span class="text-xs font-medium">SKU</span>
              <Input
                bind:value={variantDraft.sku}
                placeholder={variantDraft.id ? "" : "Auto-generated"}
              />
            </label>
            <label class="space-y-1">
              <span class="text-xs font-medium">Barcode</span>
              <Input bind:value={variantDraft.barcode} />
            </label>
            <label class="space-y-1">
              <span class="text-xs font-medium">Label</span>
              <Input bind:value={variantDraft.label} />
            </label>
            <label class="space-y-1">
              <span class="text-xs font-medium">Unit</span>
              <Select bind:value={variantDraft.unit}>
                {#each UNITS as u (u)}<option value={u}>{u}</option>{/each}
              </Select>
            </label>
            <label class="space-y-1">
              <span class="text-xs font-medium">Qty decimals</span>
              <Input type="number" bind:value={variantDraft.qtyDecimals} />
            </label>
            <label class="space-y-1">
              <span class="text-xs font-medium">Sort order</span>
              <Input type="number" bind:value={variantDraft.sortOrder} />
            </label>
            <label class="space-y-1">
              <span class="text-xs font-medium">Price (minor units)</span>
              <Input type="number" bind:value={variantDraft.priceMinor} />
            </label>
            <label class="space-y-1">
              <span class="text-xs font-medium">Cost (minor units)</span>
              <Input type="number" bind:value={variantDraft.costMinor} />
            </label>
          </div>
          <div class="flex justify-end gap-2">
            <Button
              variant="ghost"
              size="sm"
              disabled={busy}
              onclick={() => (variantDraft = null)}>Cancel</Button
            >
            <Button size="sm" disabled={busy} onclick={saveVariant}>
              {variantDraft.id ? "Save variant" : "Add variant"}
            </Button>
          </div>
        </div>
      {/if}
    </section>
  {/if}
</div>
