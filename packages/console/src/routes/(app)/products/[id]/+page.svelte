<script lang="ts">
  import NumericInput from "$lib/components/ui/numeric-input.svelte";
  import { CachePolicy, graphql } from "$houdini";
  import { page } from "$app/state";
  import { marked } from "marked";
  import { Pencil, SlidersHorizontal, Trash2 } from "@lucide/svelte";
  import { formatMoney, statusLabel, treePathMap } from "$lib/utils";
  import { refetchOnVisible } from "$lib/refetch-on-visible.svelte";
  import type { Viewer } from "../../+layout.server";
  import Badge from "$lib/components/ui/badge.svelte";
  import Button from "$lib/components/ui/button.svelte";
  import Combobox from "$lib/components/ui/combobox.svelte";
  import IconButton from "$lib/components/ui/icon-button.svelte";
  import Input from "$lib/components/ui/input.svelte";
  import MoneyInput from "$lib/components/ui/money-input.svelte";
  import Select from "$lib/components/ui/select.svelte";
  import Textarea from "$lib/components/ui/textarea.svelte";
  import type { PageData } from "./$types";

  // Query document — Houdini scans this for codegen. The live store is
  // supplied by +page.ts through `data` (route-store wiring is unavailable).
  graphql(`
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
        costRatioBps
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
          interchangeGroupId
          stock {
            locationId
            qty
          }
          bundleComponents {
            id
            qty
            componentVariant {
              id
              sku
              label
              product {
                id
                name
              }
            }
          }
        }
        images {
          id
          detailUrl
          thumbnailUrl
          width
          height
          sortOrder
        }
        onlineVisible
        onlinePriceMode
        onlineStockMode
      }
      categories {
        id
        name
        parentId
      }
      interchangeGroups {
        id
        name
      }
      locations {
        id
        name
        parentId
      }
    }
  `);

  const AdjustStock = graphql(`
    mutation ConsoleAdjustStock(
      $variantId: ID!
      $locationId: ID
      $qtyDelta: Float!
      $reason: String!
    ) {
      adjustStock(
        variantId: $variantId
        locationId: $locationId
        qtyDelta: $qtyDelta
        reason: $reason
      ) {
        id
      }
    }
  `);

  let { data }: { data: PageData } = $props();
  const ProductDetail = $derived(data.ProductDetail);

  // A category created in another tab — e.g. the Categories screen — won't
  // appear in the category picker here, since Houdini serves the cached query.
  // Edits in progress are plain component state, so the refetch doesn't
  // disturb them.
  refetchOnVisible(() => {
    const id = page.params.id;
    if (id) {
      ProductDetail.fetch({ variables: { id }, policy: CachePolicy.NetworkOnly });
    }
  });

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
      $costRatioBps: Int
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
        costRatioBps: $costRatioBps
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
        costRatioBps
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
      $interchangeGroupId: ID
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
        interchangeGroupId: $interchangeGroupId
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
        interchangeGroupId
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

  const DeleteProductImage = graphql(`
    mutation ConsoleDeleteProductImage($id: ID!) {
      deleteProductImage(id: $id)
    }
  `);

  const ReorderProductImages = graphql(`
    mutation ConsoleReorderProductImages(
      $productId: ID!
      $orderedIds: [ID!]!
    ) {
      reorderProductImages(productId: $productId, orderedIds: $orderedIds) {
        id
        sortOrder
      }
    }
  `);

  const SetProductCatalogSettings = graphql(`
    mutation ConsoleSetProductCatalogSettings(
      $id: ID!
      $onlineVisible: Boolean
      $onlinePriceMode: OnlinePriceMode
      $onlineStockMode: OnlineStockMode
    ) {
      setProductCatalogSettings(
        id: $id
        onlineVisible: $onlineVisible
        onlinePriceMode: $onlinePriceMode
        onlineStockMode: $onlineStockMode
      ) {
        id
        onlineVisible
        onlinePriceMode
        onlineStockMode
      }
    }
  `);

  const KINDS = ["physical", "service", "bundle", "open_price", "non_stock"];
  const PRICE_MODES = ["tax_inclusive", "tax_exclusive"];
  const UNITS = ["piece", "g", "ml", "mm"];

  const product = $derived($ProductDetail.data?.product);
  const categories = $derived($ProductDetail.data?.categories ?? []);
  // Breadcrumb path per category ("Electronics › Phones › Cases") so same-named
  // children under different parents are distinguishable.
  const categoryPaths = $derived(treePathMap(categories));
  // Combobox options: a leading "Uncategorized" row (empty value) so the
  // category can be cleared, then one row per category.
  const categoryOptions = $derived([
    { value: "", label: "Uncategorized" },
    ...categories.map((c) => ({ value: c.id, label: categoryPaths.get(c.id) ?? c.name })),
  ]);
  const interchangeGroups = $derived($ProductDetail.data?.interchangeGroups ?? []);
  const interchangeGroupOptions = $derived([
    { value: "", label: "— None —" },
    ...interchangeGroups.map((g) => ({ value: g.id, label: g.name })),
  ]);
  const locations = $derived($ProductDetail.data?.locations ?? []);
  // Breadcrumb path per location ("Shelf 2 › Level 1") so same-named children
  // under different parents are distinguishable.
  const locationPaths = $derived(treePathMap(locations));
  const locationName = (id: string | null) =>
    id ? (locationPaths.get(id) ?? "Unknown") : "Unlocated";

  // ---- Viewer permissions --------------------------------------------------
  // The API gates product writes, with extra keys for tax / price / cost.
  // We mirror that here: disable fields the viewer can't change, and omit
  // those fields from mutations so a partial edit isn't rejected wholesale.
  const viewer = $derived(page.data.user as Viewer | undefined);
  const has = (key: string) => !!viewer && viewer.permissions.includes(key);
  const canEdit = $derived(has("product.edit"));
  const canEditTax = $derived(has("product.edit_tax"));
  const canEditPrice = $derived(has("product.edit_price"));
  const canEditCost = $derived(has("product.edit_cost"));
  const canArchive = $derived(has("product.archive"));
  const canAdjustStock = $derived(has("stock.adjust"));
  const canManageCatalog = $derived(has("catalog.manage"));

  const PRICE_MODES_ONLINE = ["exclude", "peek", "show"];
  const STOCK_MODES_ONLINE = ["show_real", "peek", "hide"];

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
    costRatioBps: number | null;
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
    costRatioBps: null,
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
        costRatioBps: p.costRatioBps ?? null,
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
        // Tax fields require product.edit_tax — omit them otherwise so an
        // edit to the other fields still goes through.
        priceMode: canEditTax ? (form.priceMode as never) : undefined,
        taxRateBps: canEditTax ? form.taxRateBps : undefined,
        minQty: form.minQty,
        minMarginBps: form.minMarginBps,
        // Cost ratio is meaningful only for open-price products; clear it
        // otherwise so a kind change doesn't leave a stale ratio behind.
        costRatioBps: form.kind === "open_price" ? form.costRatioBps : null,
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
    priceMinor: number | null;
    costMinor: number | null;
    sortOrder: number;
    interchangeGroupId: string;
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
      interchangeGroupId: v.interchangeGroupId ?? "",
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
      interchangeGroupId: "",
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
          // Price / cost edits each need their own permission key.
          priceMinor: canEditPrice ? (d.priceMinor ?? 0) : undefined,
          costMinor: canEditCost ? (d.costMinor ?? 0) : undefined,
          sortOrder: d.sortOrder,
          interchangeGroupId: d.interchangeGroupId || null,
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
          priceMinor: d.priceMinor ?? 0,
          costMinor: d.costMinor ?? 0,
          sortOrder: d.sortOrder,
          interchangeGroupId: d.interchangeGroupId || null,
        },
      });
    });

    if (ok) {
      variantDraft = null;
      // Adds change the variant set — refetch to pull the new row. The cached
      // query won't include it, so force a network round-trip (NetworkOnly).
      if (!d.id)
        await ProductDetail.fetch({
          variables: { id: product.id },
          policy: CachePolicy.NetworkOnly,
        });
    }
  }

  async function deleteVariant(id: string) {
    if (!product || !confirm("Delete this variant?")) return;
    const ok = await run("Variant", () => DeleteVariant.mutate({ id }));
    if (ok)
      await ProductDetail.fetch({
        variables: { id: product.id },
        policy: CachePolicy.NetworkOnly,
      });
  }

  // ---- Bulk add variants ---------------------------------------------------
  let bulkVariantDialog = $state<HTMLDialogElement>();
  let bulkVariantInput = $state("");
  let bulkVariantBusy = $state(false);

  function openBulkVariantDialog() {
    bulkVariantInput = "";
    bulkVariantDialog?.showModal();
  }

  function closeBulkVariantDialog() {
    bulkVariantDialog?.close();
  }

  async function saveBulkVariants() {
    if (!product) return;
    const labels = bulkVariantInput
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean);

    if (labels.length === 0) {
      closeBulkVariantDialog();
      return;
    }

    bulkVariantBusy = true;
    try {
      let currentOrder = product.variants.length;
      for (const label of labels) {
        currentOrder++;
        const res = await AddVariant.mutate({
          productId: product.id,
          variant: {
            label: label,
            unit: "piece",
            qtyDecimals: 0,
            priceMinor: 0,
            costMinor: 0,
            sortOrder: currentOrder,
          },
        });
        if (res.errors?.length) {
          throw new Error(res.errors[0].message);
        }
      }
      await ProductDetail.fetch({
        variables: { id: product.id },
        policy: CachePolicy.NetworkOnly,
      });
      closeBulkVariantDialog();
      feedback = { ok: true, text: `Bulk added ${labels.length} variant${labels.length === 1 ? '' : 's'}.` };
    } catch (e) {
      feedback = { ok: false, text: e instanceof Error ? e.message : String(e) };
      closeBulkVariantDialog();
    } finally {
      bulkVariantBusy = false;
    }
  }

  // ---- Inline cell edit ----------------------------------------------------
  // Click a variant's SKU / label / price / cost cell to edit just that field
  // in place — the common quick tweak, without opening the full variant form.
  // Unit stays in the form (structural); stock has its own adjustment flow.
  type VariantCellField = "sku" | "label" | "price" | "cost";
  let variantCellEdit = $state<{ id: string; field: VariantCellField } | null>(
    null,
  );
  // SKU + label edit through a raw <input> (string); price + cost edit through
  // MoneyInput (integer minor units), so they need separate bindings.
  let variantCellStr = $state("");
  let variantCellMoney = $state<number | null>(null);

  // Focus + select the inline <input> the moment it mounts, so you can type or
  // tab straight in. (MoneyInput does this itself via its `autofocus` prop.)
  function selectOnMount(node: HTMLInputElement) {
    node.focus();
    node.select();
  }

  function startVariantCellEdit(
    v: NonNullable<typeof product>["variants"][number],
    field: VariantCellField,
  ) {
    if (!canEdit) return;
    if (field === "price" && !canEditPrice) return;
    if (field === "cost" && !canEditCost) return;
    if (field === "price") variantCellMoney = v.priceMinor;
    else if (field === "cost") variantCellMoney = v.costMinor;
    else variantCellStr = field === "sku" ? v.sku : (v.label ?? "");
    variantCellEdit = { id: v.id, field };
  }

  // Commit the in-flight cell edit. Quiet — no busy/banner churn for a
  // one-field tweak; only surface failures. UpdateVariant returns the changed
  // scalars, which Houdini normalizes, so the cell updates at once (no refetch).
  async function commitVariantCell() {
    const c = variantCellEdit;
    if (!c || !product) return;
    const v = product.variants.find((x) => x.id === c.id);
    if (!v) {
      variantCellEdit = null;
      return;
    }

    const patch: {
      id: string;
      sku?: string;
      label?: string | null;
      priceMinor?: number;
      costMinor?: number;
    } = { id: c.id };

    if (c.field === "sku") {
      const s = variantCellStr.trim();
      if (!s) {
        feedback = { ok: false, text: "SKU can't be empty." };
        return;
      }
      if (s === v.sku) {
        variantCellEdit = null;
        return;
      }
      patch.sku = s;
    } else if (c.field === "label") {
      const s = variantCellStr.trim();
      if ((s || null) === (v.label ?? null)) {
        variantCellEdit = null;
        return;
      }
      patch.label = s || null;
    } else if (c.field === "price") {
      const n = variantCellMoney ?? 0;
      if (n === v.priceMinor) {
        variantCellEdit = null;
        return;
      }
      patch.priceMinor = n;
    } else {
      const n = variantCellMoney ?? 0;
      if (n === v.costMinor) {
        variantCellEdit = null;
        return;
      }
      patch.costMinor = n;
    }

    variantCellEdit = null;
    try {
      const res = await UpdateVariant.mutate(patch);
      if (res.errors?.length) {
        feedback = { ok: false, text: res.errors[0].message };
        return;
      }
    } catch (e) {
      feedback = { ok: false, text: e instanceof Error ? e.message : String(e) };
      return;
    }
    // The loaded ProductDetail store serves its cached copy and won't reflect
    // the mutation's normalized scalars without a network round-trip — refetch
    // NetworkOnly so the edited cell shows the new value (no hard refresh).
    await ProductDetail.fetch({
      variables: { id: product.id },
      policy: "NetworkOnly",
    });
  }

  // Enter commits, Escape abandons. Escape nulls the edit first so the input
  // unmounts and the resulting blur becomes a no-op (commitVariantCell guards).
  function variantCellKeydown(e: KeyboardEvent) {
    if (e.key === "Enter") {
      e.preventDefault();
      commitVariantCell();
    } else if (e.key === "Escape") {
      e.preventDefault();
      variantCellEdit = null;
    }
  }

  const categoryName = (id: string | null | undefined) =>
    id ? (categoryPaths.get(id) ?? "Unknown") : "Uncategorized";

  // ---- Variant margin pill -------------------------------------------------
  // Gross margin = (price − cost) / price, ignoring tax. Computed live: when a
  // row's price or cost cell is being inline-edited, read the in-flight
  // `variantCellMoney` so the pill moves as you type, before commit/refetch.
  function variantMarginBps(
    v: NonNullable<typeof product>["variants"][number],
  ): number | null {
    const editing = variantCellEdit?.id === v.id;
    const price =
      editing && variantCellEdit?.field === "price"
        ? (variantCellMoney ?? 0)
        : v.priceMinor;
    const cost =
      editing && variantCellEdit?.field === "cost"
        ? (variantCellMoney ?? 0)
        : v.costMinor;
    if (price <= 0) return null; // undefined margin
    return Math.round(((price - cost) / price) * 10000);
  }

  // Red below cost, orange below the product's own min-margin floor, green at
  // or above it. With no floor set, any positive margin reads green.
  function marginPillClass(bps: number | null): string {
    if (bps == null) return "bg-muted text-muted-foreground";
    if (bps < 0) return "bg-red-100 text-red-700";
    const floor = form.minMarginBps ?? 0;
    if (bps < floor) return "bg-orange-100 text-orange-700";
    return "bg-emerald-100 text-emerald-700";
  }

  const formatMarginBps = (bps: number | null): string =>
    bps == null ? "—" : `${(bps / 100).toFixed(1)}%`;

  // Min margin is stored in basis points but entered as a percent — humans
  // think "20%", not "2000 bps". Convert at the input boundary.
  const bpsToPct = (bps: number | null): number | null =>
    bps == null ? null : bps / 100;
  const pctToBps = (pct: string): number | null => {
    const n = Number.parseFloat(pct);
    return Number.isFinite(n) ? Math.round(n * 100) : null;
  };

  // ---- Stock adjustment ----------------------------------------------------
  // A manual write-on / write-off against one variant at one location.
  interface StockDraft {
    variantId: string;
    variantLabel: string;
    locationId: string; // "" → the unlocated root
    qtyDelta: number;
    reason: string;
  }
  let stockDraft = $state<StockDraft | null>(null);

  function adjustVariantStock(
    v: NonNullable<typeof product>["variants"][number],
  ) {
    stockDraft = {
      variantId: v.id,
      variantLabel: v.label ? `${v.sku} · ${v.label}` : v.sku,
      locationId: "",
      qtyDelta: 0,
      reason: "",
    };
  }

  async function saveStockAdjustment() {
    const d = stockDraft;
    if (!d || !product || !d.qtyDelta || !d.reason.trim()) return;
    const ok = await run("Stock", () =>
      AdjustStock.mutate({
        variantId: d.variantId,
        locationId: d.locationId || null,
        qtyDelta: d.qtyDelta,
        reason: d.reason.trim(),
      }),
    );
    if (ok) {
      stockDraft = null;
      // AdjustStock returns only { id } — refetch over the network so the
      // updated quantities show without a hard refresh.
      await ProductDetail.fetch({
        variables: { id: product.id },
        policy: CachePolicy.NetworkOnly,
      });
    }
  }

  // ---- Bundle components editor --------------------------------------------
  // Candidate catalog for the component picker — fetched on demand when an
  // editor opens, so it never loads for non-bundle products.
  const BundlePickerProducts = graphql(`
    query ConsoleBundlePickerProducts {
      products(includeArchived: false) {
        id
        name
        kind
        variants {
          id
          sku
          label
        }
      }
    }
  `);

  const SetBundleComponents = graphql(`
    mutation ConsoleSetBundleComponents(
      $bundleVariantId: ID!
      $components: [BundleComponentInput!]!
    ) {
      setBundleComponents(
        bundleVariantId: $bundleVariantId
        components: $components
      ) {
        id
      }
    }
  `);

  interface BundleRow {
    componentVariantId: string;
    productName: string;
    sku: string;
    label: string | null;
    qty: number;
  }

  let bundleDraft = $state<{ variantId: string; rows: BundleRow[] } | null>(
    null,
  );
  let bundleSearch = $state("");
  let bundlePickerOpen = $state(false);

  function editBundle(v: NonNullable<typeof product>["variants"][number]) {
    bundleDraft = {
      variantId: v.id,
      rows: v.bundleComponents.map((c) => ({
        componentVariantId: c.componentVariant.id,
        productName: c.componentVariant.product.name,
        sku: c.componentVariant.sku,
        label: c.componentVariant.label ?? null,
        qty: c.qty,
      })),
    };
    bundleSearch = "";
    void BundlePickerProducts.fetch({ policy: CachePolicy.NetworkOnly });
  }

  // Pickable variants: AND-match search tokens against name/SKU/label, minus
  // variants already in the draft, this product's own variants, and anything
  // bundle-kind (the API rejects nested bundles).
  const bundleCandidates = $derived.by<BundleRow[]>(() => {
    const d = bundleDraft;
    if (!d) return [];
    const taken = new Set(d.rows.map((r) => r.componentVariantId));
    const tokens = bundleSearch.trim().toLowerCase().split(/\s+/).filter(Boolean);
    const out: BundleRow[] = [];
    for (const p of $BundlePickerProducts.data?.products ?? []) {
      if (p.kind === "bundle") continue;
      for (const v of p.variants) {
        if (taken.has(v.id)) continue;
        const hay = `${p.name} ${v.sku} ${v.label ?? ""}`.toLowerCase();
        if (!tokens.every((t) => hay.includes(t))) continue;
        out.push({
          componentVariantId: v.id,
          productName: p.name,
          sku: v.sku,
          label: v.label ?? null,
          qty: 1,
        });
      }
    }
    return out.slice(0, 30);
  });

  function addBundleComponent(row: BundleRow) {
    bundleDraft?.rows.push(row);
    bundleSearch = "";
  }

  function removeBundleComponent(id: string) {
    if (!bundleDraft) return;
    bundleDraft.rows = bundleDraft.rows.filter(
      (r) => r.componentVariantId !== id,
    );
  }

  async function saveBundle() {
    const d = bundleDraft;
    if (!d || !product) return;
    if (d.rows.some((r) => !Number.isInteger(r.qty) || r.qty < 1)) {
      feedback = {
        ok: false,
        text: "Component quantities must be positive whole numbers.",
      };
      return;
    }
    const ok = await run("Bundle", () =>
      SetBundleComponents.mutate({
        bundleVariantId: d.variantId,
        components: d.rows.map((r) => ({
          componentVariantId: r.componentVariantId,
          qty: r.qty,
        })),
      }),
    );
    if (ok) {
      bundleDraft = null;
      // The mutation returns only ids — refetch so the component table shows
      // the new rows with their product names.
      await ProductDetail.fetch({
        variables: { id: product.id },
        policy: CachePolicy.NetworkOnly,
      });
    }
  }

  // Live markdown preview of the description. The content is authored by
  // staff with product.edit, so it is rendered trusted.
  const descriptionHtml = $derived(
    marked.parse(form.description, { async: false }),
  );

  // ---- Image gallery -------------------------------------------------------
  // Upload talks to the /images proxy route (same folder) which forwards the
  // multipart with the httpOnly access-token cookie attached.
  let uploadInput = $state<HTMLInputElement | null>(null);
  let uploading = $state(false);

  async function pickImages() {
    uploadInput?.click();
  }

  async function handleUpload(e: Event) {
    if (!product) return;
    const target = e.currentTarget as HTMLInputElement;
    const files = target.files ? Array.from(target.files) : [];
    target.value = ""; // allow re-picking the same file later
    if (files.length === 0) return;
    uploading = true;
    feedback = null;
    try {
      for (const file of files) {
        const body = new FormData();
        body.append("file", file);
        const res = await fetch(`/products/${product.id}/images`, {
          method: "POST",
          body,
        });
        if (!res.ok) {
          const text = await res.text();
          feedback = { ok: false, text: `Upload failed: ${text}` };
          return;
        }
      }
      feedback = {
        ok: true,
        text: `Uploaded ${files.length} image${files.length === 1 ? "" : "s"}.`,
      };
      await ProductDetail.fetch({
        variables: { id: product.id },
        policy: CachePolicy.NetworkOnly,
      });
    } catch (err) {
      feedback = {
        ok: false,
        text: err instanceof Error ? err.message : String(err),
      };
    } finally {
      uploading = false;
    }
  }

  async function removeImage(id: string) {
    if (!product || !confirm("Delete this image?")) return;
    const ok = await run("Image", () => DeleteProductImage.mutate({ id }));
    if (ok)
      await ProductDetail.fetch({
        variables: { id: product.id },
        policy: CachePolicy.NetworkOnly,
      });
  }

  // ---- Per-product catalog settings ---------------------------------------
  // Each toggle / select fires a single-field mutation against the API; the
  // server's setProductCatalogSettings ignores omitted fields.
  async function toggleOnlineVisible() {
    if (!product) return;
    const ok = await run("Catalog", () =>
      SetProductCatalogSettings.mutate({
        id: product.id,
        onlineVisible: !product.onlineVisible,
      }),
    );
    if (ok) await ProductDetail.fetch({ variables: { id: product.id } });
  }

  async function setOnlinePriceMode(mode: string) {
    if (!product || mode === product.onlinePriceMode) return;
    const ok = await run("Catalog", () =>
      SetProductCatalogSettings.mutate({
        id: product.id,
        onlinePriceMode: mode as never,
      }),
    );
    if (ok) await ProductDetail.fetch({ variables: { id: product.id } });
  }

  async function setOnlineStockMode(mode: string) {
    if (!product || mode === product.onlineStockMode) return;
    const ok = await run("Catalog", () =>
      SetProductCatalogSettings.mutate({
        id: product.id,
        onlineStockMode: mode as never,
      }),
    );
    if (ok) await ProductDetail.fetch({ variables: { id: product.id } });
  }

  // Reorder by swapping the picked image with its neighbour, then sending
  // the full ordered id list to the API (the server renumbers atomically).
  async function moveImage(id: string, direction: -1 | 1) {
    if (!product) return;
    const ordered = [...(product.images ?? [])]
      .sort((a, b) => a.sortOrder - b.sortOrder)
      .map((i) => i.id);
    const idx = ordered.indexOf(id);
    const target = idx + direction;
    if (idx < 0 || target < 0 || target >= ordered.length) return;
    [ordered[idx], ordered[target]] = [ordered[target], ordered[idx]];
    const ok = await run("Image order", () =>
      ReorderProductImages.mutate({
        productId: product.id,
        orderedIds: ordered,
      }),
    );
    if (ok)
      await ProductDetail.fetch({
        variables: { id: product.id },
        policy: CachePolicy.NetworkOnly,
      });
  }
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
          {categoryName(product.categoryId)} · {statusLabel(product.kind)}
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
        <Button
          variant="outline"
          size="sm"
          disabled={busy || !canArchive}
          onclick={toggleArchived}
        >
          {product.archivedAt ? "Restore" : "Archive"}
        </Button>
      </div>
    </div>

    {#if feedback}
      <p class="text-sm {feedback.ok ? 'text-emerald-700' : 'text-destructive'}">
        {feedback.text}
      </p>
    {/if}

    {#if !canEdit}
      <p
        class="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800"
      >
        You have read-only access to products — editing is disabled.
      </p>
    {/if}

    <!-- Product details -->
    <section class="space-y-4 rounded-lg border bg-card p-5">
      <h2 class="text-sm font-semibold">Details</h2>

      <div class="grid grid-cols-2 gap-4">
        <label class="space-y-1">
          <span class="text-sm font-medium">Name</span>
          <Input bind:value={form.name} disabled={!canEdit} />
        </label>
        <label class="space-y-1">
          <span class="text-sm font-medium">Public name</span>
          <Input
            bind:value={form.publicName}
            placeholder="Falls back to name"
            disabled={!canEdit}
          />
        </label>
      </div>

      <div class="space-y-1">
        <span class="text-sm font-medium">Description</span>
        <div class="grid grid-cols-2 gap-3">
          <Textarea
            bind:value={form.description}
            disabled={!canEdit}
            placeholder="Markdown supported…"
            class="h-48 resize-none"
          />
          <div
            class="md-preview h-48 overflow-auto rounded-md border bg-muted/30 px-3 py-2 text-sm"
            aria-label="Description preview"
          >
            {#if form.description.trim()}
              <!-- eslint-disable-next-line svelte/no-at-html-tags -->
              {@html descriptionHtml}
            {:else}
              <span class="text-muted-foreground">Nothing to preview.</span>
            {/if}
          </div>
        </div>
      </div>

      <div class="grid grid-cols-2 gap-4">
        <label class="space-y-1">
          <span class="text-sm font-medium">Kind</span>
          <Select bind:value={form.kind} disabled={!canEdit}>
            {#each KINDS as k (k)}<option value={k}>{statusLabel(k)}</option>{/each}
          </Select>
        </label>
        <label class="space-y-1">
          <span class="text-sm font-medium">Category</span>
          <Combobox
            options={categoryOptions}
            bind:value={form.categoryId}
            placeholder="Search category…"
            disabled={!canEdit}
          />
        </label>
        <label class="space-y-1">
          <span class="text-sm font-medium">Price mode</span>
          <Select bind:value={form.priceMode} disabled={!canEdit || !canEditTax}>
            {#each PRICE_MODES as m (m)}<option value={m}>{statusLabel(m)}</option>{/each}
          </Select>
        </label>
        <label class="space-y-1">
          <span class="text-sm font-medium">Tax rate (basis points)</span>
          <NumericInput
            bind:value={form.taxRateBps}
            disabled={!canEdit || !canEditTax}
          />
          {#if canEdit && !canEditTax}
            <span class="text-xs text-muted-foreground"
              >Requires the product.edit_tax permission.</span
            >
          {/if}
        </label>
        <label class="space-y-1">
          <span class="text-sm font-medium">Min qty</span>
          <NumericInput bind:value={form.minQty} disabled={!canEdit} />
        </label>
        <label class="space-y-1">
          <span class="text-sm font-medium">Min margin (%)</span>
          <NumericInput
            step="0.1"
            value={bpsToPct(form.minMarginBps)}
            oninput={(e) =>
              (form.minMarginBps = pctToBps(e.currentTarget.value))}
            disabled={!canEdit}
          />
        </label>
        {#if form.kind === "open_price"}
          <label class="space-y-1">
            <span class="text-sm font-medium">Cost ratio (%)</span>
            <NumericInput
              step="0.1"
              value={bpsToPct(form.costRatioBps)}
              oninput={(e) =>
                (form.costRatioBps = pctToBps(e.currentTarget.value))}
              disabled={!canEdit}
            />
            <span class="text-xs text-muted-foreground"
              >Assumed cost as % of the entered sale price.</span
            >
          </label>
        {/if}
        {#if form.kind === "non_stock"}
          <p class="col-span-2 text-xs text-muted-foreground">
            Cost-tracked, no stock — sells at a real price (overridable at the
            register) with its cost auto-maintained from purchases/landed cost.
            For resale-priced items like fasteners.
          </p>
        {/if}
      </div>

      <label class="flex items-center gap-2">
        <input
          type="checkbox"
          bind:checked={form.replenishMonitored}
          disabled={!canEdit}
        />
        <span class="text-sm font-medium">Monitored by the reorder forecast</span>
      </label>

      <div class="flex justify-end pt-2">
        <Button disabled={busy || !canEdit} onclick={saveProduct}>
          Save details
        </Button>
      </div>
    </section>

    <!-- Online catalog -->
    <section class="space-y-3 rounded-lg border bg-card p-5">
      <div class="flex items-center justify-between">
        <h2 class="text-sm font-semibold">Online catalog</h2>
        <label class="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={product.onlineVisible}
            disabled={busy || !canManageCatalog}
            onchange={toggleOnlineVisible}
          />
          Visible on the live catalog
        </label>
      </div>
      <div class="grid grid-cols-2 gap-3">
        <label class="space-y-1">
          <span class="text-sm font-medium">Price display</span>
          <Select
            value={product.onlinePriceMode}
            disabled={busy || !canManageCatalog}
            onchange={(e) =>
              setOnlinePriceMode(
                (e.currentTarget as HTMLSelectElement).value,
              )}
          >
            {#each PRICE_MODES_ONLINE as m (m)}<option value={m}>{statusLabel(m)}</option>{/each}
          </Select>
        </label>
        <label class="space-y-1">
          <span class="text-sm font-medium">Stock display</span>
          <Select
            value={product.onlineStockMode}
            disabled={busy || !canManageCatalog}
            onchange={(e) =>
              setOnlineStockMode(
                (e.currentTarget as HTMLSelectElement).value,
              )}
          >
            {#each STOCK_MODES_ONLINE as m (m)}<option value={m}>{statusLabel(m)}</option>{/each}
          </Select>
        </label>
      </div>
      {#if !canManageCatalog}
        <p class="text-xs text-muted-foreground">
          Requires the catalog.manage permission. Changes take effect on the
          next publish.
        </p>
      {:else}
        <p class="text-xs text-muted-foreground">
          Changes take effect on the next publish.
        </p>
      {/if}
    </section>

    <!-- Image gallery -->
    <section class="space-y-3 rounded-lg border bg-card p-5">
      <div class="flex items-center justify-between">
        <h2 class="text-sm font-semibold">
          Images ({product.images.length})
        </h2>
        <div>
          <input
            type="file"
            accept="image/*"
            multiple
            class="hidden"
            bind:this={uploadInput}
            onchange={handleUpload}
          />
          <Button
            size="sm"
            disabled={uploading || !canEdit}
            onclick={pickImages}
          >
            {uploading ? "Uploading…" : "Upload images"}
          </Button>
        </div>
      </div>

      {#if product.images.length === 0}
        <p class="text-sm text-muted-foreground">
          No images yet. The first image you upload becomes the catalog
          thumbnail.
        </p>
      {:else}
        <div class="grid grid-cols-4 gap-3">
          {#each [...product.images].sort((a, b) => a.sortOrder - b.sortOrder) as img, i (img.id)}
            <div class="group relative overflow-hidden rounded-md border bg-muted/30">
              <a href={img.detailUrl} target="_blank" rel="noopener">
                <img
                  src={img.thumbnailUrl}
                  alt=""
                  loading="lazy"
                  class="aspect-square w-full object-cover"
                />
              </a>
              {#if i === 0}
                <span
                  class="absolute left-1 top-1 rounded bg-primary px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-primary-foreground"
                >
                  Primary
                </span>
              {/if}
              {#if canEdit}
                <div
                  class="absolute inset-x-1 bottom-1 flex justify-between gap-1 opacity-0 transition-opacity group-hover:opacity-100"
                >
                  <div class="flex gap-1">
                    <button
                      type="button"
                      class="rounded bg-background/90 px-1.5 py-0.5 text-xs shadow disabled:opacity-30"
                      disabled={busy || i === 0}
                      onclick={() => moveImage(img.id, -1)}
                      aria-label="Move left">←</button
                    >
                    <button
                      type="button"
                      class="rounded bg-background/90 px-1.5 py-0.5 text-xs shadow disabled:opacity-30"
                      disabled={busy || i === product.images.length - 1}
                      onclick={() => moveImage(img.id, 1)}
                      aria-label="Move right">→</button
                    >
                  </div>
                  <button
                    type="button"
                    class="rounded bg-background/90 px-1.5 py-0.5 text-xs text-destructive shadow"
                    disabled={busy}
                    onclick={() => removeImage(img.id)}
                    aria-label="Delete">×</button
                  >
                </div>
              {/if}
            </div>
          {/each}
        </div>
      {/if}
    </section>

    <!-- Variants -->
    <section class="space-y-3 rounded-lg border bg-card p-5">
      <div class="flex items-center justify-between">
        <h2 class="text-sm font-semibold">
          Variants ({product.variants.length})
        </h2>
        <div class="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            disabled={busy || !canEdit}
            onclick={openBulkVariantDialog}
          >
            Bulk add
          </Button>
          <Button
            variant="outline"
            size="sm"
            disabled={busy || !canEdit}
            onclick={newVariant}
          >
            Add variant
          </Button>
        </div>
      </div>

      <table class="w-full text-sm">
        <thead class="border-b text-left text-muted-foreground">
          <tr>
            <th class="py-1.5 font-medium">SKU</th>
            <th class="py-1.5 font-medium">Label</th>
            <th class="py-1.5 font-medium">Unit</th>
            <th class="py-1.5 text-right font-medium">Price</th>
            <th class="py-1.5 text-right font-medium">Cost</th>
            <th class="py-1.5 text-right font-medium">Margin</th>
            <th class="py-1.5 text-right font-medium">Stock</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {#each product.variants as v (v.id)}
            {@const m = variantMarginBps(v)}
            <tr class="border-b last:border-0">
              <td class="py-1.5 font-mono text-xs">
                {#if variantCellEdit?.id === v.id && variantCellEdit.field === "sku"}
                  <input
                    bind:value={variantCellStr}
                    use:selectOnMount
                    onkeydown={variantCellKeydown}
                    onblur={commitVariantCell}
                    class="h-7 w-full rounded-md border border-input bg-background px-2 font-mono text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  />
                {:else if canEdit}
                  <button
                    type="button"
                    class="-mx-1 rounded px-1 text-left hover:bg-accent"
                    title="Edit SKU"
                    onclick={() => startVariantCellEdit(v, "sku")}>{v.sku}</button
                  >
                {:else}
                  {v.sku}
                {/if}
              </td>
              <td class="py-1.5">
                {#if variantCellEdit?.id === v.id && variantCellEdit.field === "label"}
                  <input
                    bind:value={variantCellStr}
                    use:selectOnMount
                    onkeydown={variantCellKeydown}
                    onblur={commitVariantCell}
                    class="h-7 w-full rounded-md border border-input bg-background px-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  />
                {:else if canEdit}
                  <button
                    type="button"
                    class="-mx-1 rounded px-1 text-left hover:bg-accent"
                    title="Edit label"
                    onclick={() => startVariantCellEdit(v, "label")}
                    >{v.label ?? "—"}</button
                  >
                {:else}
                  {v.label ?? "—"}
                {/if}
              </td>
              <td class="py-1.5">{v.unit}</td>
              <td class="py-1.5 text-right tabular-nums">
                {#if variantCellEdit?.id === v.id && variantCellEdit.field === "price"}
                  <MoneyInput
                    autofocus
                    bind:value={variantCellMoney}
                    onkeydown={variantCellKeydown}
                    onblur={commitVariantCell}
                    class="ml-auto h-7 w-28 px-2 text-right tabular-nums"
                  />
                {:else if canEdit && canEditPrice}
                  <button
                    type="button"
                    class="-mx-1 rounded px-1 hover:bg-accent"
                    title="Edit price"
                    onclick={() => startVariantCellEdit(v, "price")}
                    >{formatMoney(v.priceMinor)}</button
                  >
                {:else}
                  {formatMoney(v.priceMinor)}
                {/if}
              </td>
              <td class="py-1.5 text-right tabular-nums">
                {#if variantCellEdit?.id === v.id && variantCellEdit.field === "cost"}
                  <MoneyInput
                    autofocus
                    bind:value={variantCellMoney}
                    onkeydown={variantCellKeydown}
                    onblur={commitVariantCell}
                    class="ml-auto h-7 w-28 px-2 text-right tabular-nums"
                  />
                {:else if canEdit && canEditCost}
                  <button
                    type="button"
                    class="-mx-1 rounded px-1 hover:bg-accent"
                    title="Edit cost"
                    onclick={() => startVariantCellEdit(v, "cost")}
                    >{formatMoney(v.costMinor)}</button
                  >
                {:else}
                  {formatMoney(v.costMinor)}
                {/if}
              </td>
              <td class="py-1.5 text-right">
                <span
                  class="inline-block rounded-full px-2 py-0.5 text-xs font-medium tabular-nums {marginPillClass(
                    m,
                  )}"
                  title="Gross margin (tax ignored)"
                >
                  {formatMarginBps(m)}
                </span>
              </td>
              <td class="py-1.5 text-right">{v.totalQty}</td>
              <td class="py-1.5 text-right">
                <span class="inline-flex items-center gap-0.5">
                <IconButton
                  icon={Pencil}
                  label="Edit variant"
                  variant="primary"
                  disabled={!canEdit}
                  onclick={() => editVariant(v)}
                />
                <IconButton
                  icon={Trash2}
                  label="Delete variant"
                  variant="destructive"
                  disabled={!canEdit}
                  onclick={() => deleteVariant(v.id)}
                />
                </span>
              </td>
            </tr>
          {/each}
          {#if product.variants.length === 0}
            <tr>
              <td colspan="8" class="py-6 text-center text-muted-foreground">
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
                disabled={!canEdit}
              />
            </label>
            <label class="space-y-1">
              <span class="text-xs font-medium">Barcode</span>
              <Input bind:value={variantDraft.barcode} disabled={!canEdit} />
            </label>
            <label class="space-y-1">
              <span class="text-xs font-medium">Label</span>
              <Input bind:value={variantDraft.label} disabled={!canEdit} />
            </label>
            <label class="space-y-1">
              <span class="text-xs font-medium">Unit</span>
              <Select bind:value={variantDraft.unit} disabled={!canEdit}>
                {#each UNITS as u (u)}<option value={u}>{u}</option>{/each}
              </Select>
            </label>
            <label class="space-y-1">
              <span class="text-xs font-medium">Qty decimals</span>
              <NumericInput
                bind:value={variantDraft.qtyDecimals}
                disabled={!canEdit}
              />
            </label>
            <label class="space-y-1">
              <span class="text-xs font-medium">Sort order</span>
              <NumericInput
                bind:value={variantDraft.sortOrder}
                disabled={!canEdit}
              />
            </label>
            <label class="space-y-1">
              <span class="text-xs font-medium">Interchange group</span>
              <Combobox
                options={interchangeGroupOptions}
                bind:value={variantDraft.interchangeGroupId}
                placeholder="Search group…"
                disabled={!canEdit}
              />
            </label>
            <label class="space-y-1">
              <span class="text-xs font-medium">Price (Rp)</span>
              <MoneyInput
                bind:value={variantDraft.priceMinor}
                disabled={!canEdit || (variantDraft.id != null && !canEditPrice)}
              />
              {#if variantDraft.id != null && canEdit && !canEditPrice}
                <span class="text-xs text-muted-foreground"
                  >Requires product.edit_price.</span
                >
              {/if}
            </label>
            <label class="space-y-1">
              <span class="text-xs font-medium">Cost (Rp)</span>
              <MoneyInput
                bind:value={variantDraft.costMinor}
                disabled={!canEdit || (variantDraft.id != null && !canEditCost)}
              />
              {#if variantDraft.id != null && canEdit && !canEditCost}
                <span class="text-xs text-muted-foreground"
                  >Requires product.edit_cost.</span
                >
              {/if}
            </label>
          </div>
          <div class="flex justify-end gap-2">
            <Button
              variant="ghost"
              size="sm"
              disabled={busy}
              onclick={() => (variantDraft = null)}>Cancel</Button
            >
            <Button size="sm" disabled={busy || !canEdit} onclick={saveVariant}>
              {variantDraft.id ? "Save variant" : "Add variant"}
            </Button>
          </div>
        </div>
      {/if}

      <dialog
        bind:this={bulkVariantDialog}
        class="m-auto w-full max-w-lg rounded-lg border bg-background p-0 shadow-lg backdrop:bg-black/50"
        onclose={() => (bulkVariantInput = "")}
      >
        <div class="flex flex-col">
          <div class="border-b p-4">
            <h3 class="text-lg font-semibold">Bulk add variants</h3>
            <p class="mt-1 text-sm text-muted-foreground">
              Enter variant labels, one per line. They will be added with zero price/cost.
            </p>
          </div>
          <div class="p-4">
            <Textarea
              bind:value={bulkVariantInput}
              disabled={bulkVariantBusy}
              placeholder="Small&#10;Medium&#10;Large"
              class="h-48 resize-none"
            />
          </div>
          <div class="flex justify-end gap-2 border-t bg-muted/40 p-4">
            <Button
              variant="ghost"
              disabled={bulkVariantBusy}
              onclick={closeBulkVariantDialog}>Cancel</Button
            >
            <Button disabled={bulkVariantBusy} onclick={saveBulkVariants}>
              {bulkVariantBusy ? "Saving…" : "Add variants"}
            </Button>
          </div>
        </div>
      </dialog>
    </section>

    {#if product.kind === "bundle"}
      <section class="space-y-3 rounded-lg border bg-card p-5">
        <h2 class="text-sm font-semibold">Bundle components</h2>
        {#each product.variants as v (v.id)}
          <div class="space-y-1">
            <div class="flex items-center justify-between">
              <span class="text-sm font-medium">
                {v.label ? `${v.sku} · ${v.label}` : v.sku}
              </span>
              {#if bundleDraft?.variantId !== v.id}
                <IconButton
                  icon={Pencil}
                  label="Edit components"
                  variant="primary"
                  disabled={busy || !canEdit}
                  onclick={() => editBundle(v)}
                />
              {/if}
            </div>

            {#if bundleDraft?.variantId === v.id}
              <div class="space-y-2 rounded-md border bg-background p-3">
                {#if bundleDraft.rows.length > 0}
                  <table class="w-full text-sm">
                    <tbody>
                      {#each bundleDraft.rows as row (row.componentVariantId)}
                        <tr class="border-b last:border-0">
                          <td class="py-1">
                            {row.productName}
                            {#if row.label}
                              <span class="ml-1 text-xs text-muted-foreground">
                                {row.label}
                              </span>
                            {/if}
                          </td>
                          <td class="py-1 font-mono text-xs text-muted-foreground">
                            {row.sku}
                          </td>
                          <td class="w-20 py-1">
                            <NumericInput
                              min={1}
                              step={1}
                              bind:value={row.qty}
                              class="h-8 text-right"
                            />
                          </td>
                          <td class="w-10 py-1 text-right">
                            <IconButton
                              icon={Trash2}
                              label="Remove component"
                              variant="destructive"
                              onclick={() =>
                                removeBundleComponent(row.componentVariantId)}
                            />
                          </td>
                        </tr>
                      {/each}
                    </tbody>
                  </table>
                {:else}
                  <p class="text-sm text-muted-foreground">No components.</p>
                {/if}

                <div class="relative">
                  <Input
                    type="search"
                    placeholder="Add component — search product or SKU…"
                    bind:value={bundleSearch}
                    onfocus={() => (bundlePickerOpen = true)}
                    onblur={() => setTimeout(() => (bundlePickerOpen = false), 150)}
                    autocomplete="off"
                    class="h-8"
                    disabled={busy}
                  />
                  {#if bundlePickerOpen && bundleCandidates.length > 0}
                    <ul
                      class="absolute top-full z-10 mt-1 max-h-72 w-full overflow-auto rounded-md border bg-popover shadow-md"
                    >
                      {#each bundleCandidates as cand (cand.componentVariantId)}
                        <li>
                          <button
                            type="button"
                            class="flex w-full items-center justify-between px-3 py-2 text-left text-sm hover:bg-muted/60"
                            onmousedown={(e) => e.preventDefault()}
                            onclick={() => addBundleComponent(cand)}
                          >
                            <span class="font-medium">{cand.productName}</span>
                            <span class="font-mono text-xs text-muted-foreground">
                              {cand.sku}{cand.label ? ` · ${cand.label}` : ""}
                            </span>
                          </button>
                        </li>
                      {/each}
                    </ul>
                  {:else if bundlePickerOpen && bundleSearch.trim()}
                    <div
                      class="absolute top-full z-10 mt-1 w-full rounded-md border bg-popover px-3 py-2 text-sm text-muted-foreground shadow-md"
                    >
                      No matches.
                    </div>
                  {/if}
                </div>

                <div class="flex justify-end gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={busy}
                    onclick={() => (bundleDraft = null)}
                  >
                    Cancel
                  </Button>
                  <Button size="sm" disabled={busy} onclick={saveBundle}>
                    Save components
                  </Button>
                </div>
              </div>
            {:else if v.bundleComponents.length > 0}
              <table class="w-full text-sm">
                <tbody>
                  {#each v.bundleComponents as comp (comp.id)}
                    <tr class="border-b last:border-0">
                      <td class="py-1">
                        {comp.componentVariant.product.name}
                        {#if comp.componentVariant.label}
                          <span class="ml-1 text-xs text-muted-foreground">
                            {comp.componentVariant.label}
                          </span>
                        {/if}
                      </td>
                      <td class="py-1 font-mono text-xs text-muted-foreground">
                        {comp.componentVariant.sku}
                      </td>
                      <td class="py-1 text-right">×{comp.qty}</td>
                    </tr>
                  {/each}
                </tbody>
              </table>
            {:else}
              <p class="text-sm text-muted-foreground">
                No components yet — this bundle can't be sold until it has some.
              </p>
            {/if}
          </div>
        {/each}
        {#if product.variants.length === 0}
          <p class="text-sm text-muted-foreground">No variants.</p>
        {/if}
      </section>
    {/if}

    <!-- Stock by location -->
    <section class="space-y-3 rounded-lg border bg-card p-5">
      <h2 class="text-sm font-semibold">Stock by location</h2>
      {#each product.variants as v (v.id)}
        <div class="space-y-1">
          <div class="flex items-center justify-between">
            <span class="text-sm font-medium">
              {v.label ? `${v.sku} · ${v.label}` : v.sku}
              <span class="ml-1 text-xs text-muted-foreground"
                >({v.totalQty} total)</span
              >
            </span>
            <IconButton
              icon={SlidersHorizontal}
              label="Adjust stock"
              variant="primary"
              disabled={busy || !canAdjustStock}
              onclick={() => adjustVariantStock(v)}
            />
          </div>
          <table class="w-full text-sm">
            <tbody>
              {#each v.stock as s (s.locationId ?? "root")}
                <tr class="border-b last:border-0">
                  <td class="py-1 text-muted-foreground">
                    {locationName(s.locationId)}
                  </td>
                  <td class="py-1 text-right">{s.qty}</td>
                </tr>
              {/each}
              {#if v.stock.length === 0}
                <tr>
                  <td class="py-1 text-muted-foreground" colspan="2">
                    No stock rows.
                  </td>
                </tr>
              {/if}
            </tbody>
          </table>
        </div>
      {/each}
      {#if product.variants.length === 0}
        <p class="text-sm text-muted-foreground">No variants to stock.</p>
      {/if}

      {#if stockDraft}
        <div class="space-y-3 rounded-md border bg-background p-4">
          <h3 class="text-sm font-semibold">
            Adjust stock — {stockDraft.variantLabel}
          </h3>
          <div class="grid grid-cols-2 gap-3">
            <label class="space-y-1">
              <span class="text-xs font-medium">Location</span>
              <Select bind:value={stockDraft.locationId}>
                <option value="">Unlocated (root)</option>
                {#each locations as l (l.id)}
                  <option value={l.id}>{l.name}</option>
                {/each}
              </Select>
            </label>
            <label class="space-y-1">
              <span class="text-xs font-medium">
                Quantity delta (± smallest unit)
              </span>
              <NumericInput bind:value={stockDraft.qtyDelta} />
            </label>
            <label class="space-y-1 col-span-2">
              <span class="text-xs font-medium">Reason (required)</span>
              <Input bind:value={stockDraft.reason} />
            </label>
          </div>
          <p class="text-xs text-muted-foreground">
            Positive writes stock on; negative writes it off.
          </p>
          <div class="flex justify-end gap-2">
            <Button
              variant="ghost"
              size="sm"
              disabled={busy}
              onclick={() => (stockDraft = null)}>Cancel</Button
            >
            <Button
              size="sm"
              disabled={busy || !stockDraft.qtyDelta || !stockDraft.reason.trim()}
              onclick={saveStockAdjustment}>Apply adjustment</Button
            >
          </div>
        </div>
      {/if}
    </section>
  {/if}
</div>
