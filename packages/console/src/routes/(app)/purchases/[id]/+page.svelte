<script lang="ts">
  import { tick } from "svelte";
  import { fly } from "svelte/transition";
  import { graphql } from "$houdini";
  import { goto } from "$app/navigation";
  import { page } from "$app/state";
  import type { Viewer } from "../../+layout.server";
  import { formatMoney, matchesTokens, searchTokens, statusLabel } from "$lib/utils";
  import { refetchOnVisible } from "$lib/refetch-on-visible.svelte";
  import {
    ArrowDown,
    ArrowUp,
    Check,
    ChevronDown,
    ChevronRight,
    Pencil,
    Trash2,
    X,
  } from "@lucide/svelte";
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
    query PurchaseDetail($id: ID!) {
      purchase(id: $id) {
        id
        vendorId
        snapshotVendorName
        date
        sourceDocument
        memo
        sendDueDate
        status
        revision
        lastSentAt
        totalInvoiceCost
        hasUnsentChanges
        sections {
          id
          name
          sortOrder
        }
        items {
          id
          sectionId
          variantId
          description
          qtyOrdered
          qtyDelivered
          qtyInTransit
          transitFreightMinor
          unitCostMinor
          sortOrder
        }
        sends {
          id
          channel
          recipient
          revision
          status
          sentAt
          expectedDeliveryDate
          note
          createdAt
        }
        unmappedLines {
          id
        }
      }
    }
  `);

  // Vendor + catalog lookups for the header picker and line variant combobox.
  // Split out of PurchaseDetail so refetch() (after every line/section edit) only
  // re-pulls the small purchase row — never the whole catalog. Loaded once.
  graphql(`
    query PurchaseEditorRefData {
      vendors {
        id
        name
      }
      products(includeArchived: true) {
        id
        name
        kind
        variants {
          id
          sku
          label
          totalQty
          costMinor
          reorderPoint
        }
      }
    }
  `);

  const UpdatePurchase = graphql(`
    mutation ConsoleUpdatePurchase(
      $id: ID!
      $vendorId: ID
      $snapshotVendorName: String
      $date: String
      $sourceDocument: String
      $memo: String
      $sendDueDate: String
    ) {
      updatePurchase(
        id: $id
        vendorId: $vendorId
        snapshotVendorName: $snapshotVendorName
        date: $date
        sourceDocument: $sourceDocument
        memo: $memo
        sendDueDate: $sendDueDate
      ) {
        # Return the edited fields so Houdini updates its normalised cache —
        # otherwise the page serves stale header values until a hard refresh.
        id
        vendorId
        snapshotVendorName
        date
        sourceDocument
        memo
        sendDueDate
      }
    }
  `);

  const CancelPurchase = graphql(`
    mutation ConsoleCancelPurchase($id: ID!) {
      cancelPurchase(id: $id) {
        id
        status
      }
    }
  `);

  const ClonePurchase = graphql(`
    mutation ConsoleClonePurchase($id: ID!) {
      clonePurchase(id: $id) {
        id
      }
    }
  `);

  const CreateSection = graphql(`
    mutation ConsoleCreatePurchaseSection($purchaseId: ID!, $name: String!) {
      createPurchaseSection(purchaseId: $purchaseId, name: $name) {
        id
      }
    }
  `);

  const UpdateSection = graphql(`
    mutation ConsoleUpdatePurchaseSection($id: ID!, $name: String!) {
      updatePurchaseSection(id: $id, name: $name) {
        id
        name
      }
    }
  `);

  const DeleteSection = graphql(`
    mutation ConsoleDeletePurchaseSection($id: ID!) {
      deletePurchaseSection(id: $id)
    }
  `);

  const CreateItem = graphql(`
    mutation ConsoleCreatePurchaseItem(
      $purchaseId: ID!
      $sectionId: ID
      $variantId: ID
      $description: String
      $qtyOrdered: Float!
      $unitCostMinor: Float!
    ) {
      createPurchaseItem(
        purchaseId: $purchaseId
        sectionId: $sectionId
        variantId: $variantId
        description: $description
        qtyOrdered: $qtyOrdered
        unitCostMinor: $unitCostMinor
      ) {
        id
      }
    }
  `);

  // Bulk-add the checked variants from the "By stock" tab in one round-trip.
  const CreateItems = graphql(`
    mutation ConsoleCreatePurchaseItems(
      $purchaseId: ID!
      $lines: [PurchaseLineInput!]!
    ) {
      createPurchaseItems(purchaseId: $purchaseId, lines: $lines) {
        id
      }
    }
  `);

  // Open reorder suggestions for the bulk-add modal's "Reorder" tab. Fetched
  // imperatively when the modal opens (keeps the page load lean).
  const ReorderSuggestionsQuery = graphql(`
    query PurchaseReorderSuggestions {
      reorderSuggestions(status: open) {
        id
        variantId
        productName
        sku
        vendorId
        vendorName
        currentStock
        reorderPoint
        suggestedQty
      }
    }
  `);

  // What this PO's vendor last charged per variant (latest non-cancelled PO).
  // Prefills new-line unit costs — the variant's current cost is only a
  // fallback, since landed costs inflate it past the vendor's actual price.
  const VendorLastCostsQuery = graphql(`
    query PurchaseVendorLastCosts($vendorId: ID!) {
      vendorLastCosts(vendorId: $vendorId) {
        variantId
        unitCostMinor
      }
    }
  `);

  // Append the checked suggestions to this PO and flip them to converted.
  const AddReorderToPurchase = graphql(`
    mutation ConsoleAddReorderSuggestionsToPurchase(
      $purchaseId: ID!
      $lines: [AddReorderLineInput!]!
    ) {
      addReorderSuggestionsToPurchase(purchaseId: $purchaseId, lines: $lines) {
        id
      }
    }
  `);

  // Quick-create a product without leaving the PO. Mirrors the products page's
  // create defaults (physical, tax-inclusive, one auto-SKU variant); we select
  // the returned variant on the line.
  const CreateProductInline = graphql(`
    mutation ConsoleCreateProductInline(
      $name: String!
      $kind: ProductKind
      $priceMode: PriceMode!
      $variants: [VariantInput!]!
    ) {
      createProduct(
        name: $name
        kind: $kind
        priceMode: $priceMode
        variants: $variants
      ) {
        id
        variants {
          id
        }
      }
    }
  `);

  const UpdateItem = graphql(`
    mutation ConsoleUpdatePurchaseItem(
      $id: ID!
      $sectionId: ID
      $variantId: ID
      $description: String
      $qtyOrdered: Float
      $unitCostMinor: Float
    ) {
      updatePurchaseItem(
        id: $id
        sectionId: $sectionId
        variantId: $variantId
        description: $description
        qtyOrdered: $qtyOrdered
        unitCostMinor: $unitCostMinor
      ) {
        # Select the mutated scalars so Houdini normalizes them straight into
        # the cache — inline cell edits then update instantly, no refetch wait.
        id
        sectionId
        variantId
        description
        qtyOrdered
        unitCostMinor
        sortOrder
      }
    }
  `);

  const DeleteItem = graphql(`
    mutation ConsoleDeletePurchaseItem($id: ID!) {
      deletePurchaseItem(id: $id)
    }
  `);

  // Re-source selected lines onto another PO for a different vendor (pre-delivery
  // reconciliation) — an existing open PO (targetPurchaseId) or a new one
  // (targetVendorId). Trims the source lines; returns the destination PO.
  const ResourcePurchaseItems = graphql(`
    mutation ConsoleResourcePurchaseItems(
      $sourcePurchaseId: ID!
      $targetPurchaseId: ID
      $targetVendorId: ID
      $replacements: [ResourceLineInput!]!
    ) {
      resourcePurchaseItems(
        sourcePurchaseId: $sourcePurchaseId
        targetPurchaseId: $targetPurchaseId
        targetVendorId: $targetVendorId
        replacements: $replacements
      ) {
        # Return the destination PO's full line list + header so Houdini refreshes
        # its normalized cache. Otherwise an existing target PO keeps serving its
        # stale (pre-append) lines until a hard refresh — returning the parent with
        # its items updates the cached list (a bare child item would not).
        id
        snapshotVendorName
        revision
        totalInvoiceCost
        hasUnsentChanges
        items {
          id
          sectionId
          variantId
          description
          qtyOrdered
          qtyDelivered
          qtyInTransit
          transitFreightMinor
          unitCostMinor
          sortOrder
        }
        unmappedLines {
          id
        }
      }
    }
  `);

  // The re-source destination vendor's last-charged costs — shown as the cost a
  // moved line will default to (the API applies the same default server-side).
  const ResourceVendorCostsQuery = graphql(`
    query PurchaseResourceVendorCosts($vendorId: ID!) {
      vendorLastCosts(vendorId: $vendorId) {
        variantId
        unitCostMinor
      }
    }
  `);

  // Open POs to re-source *into* (the "add to existing" mode). Pulled when the
  // dialog opens; the source PO itself is filtered out client-side.
  const ResourceTargetsQuery = graphql(`
    query PurchaseResourceTargets {
      purchases(status: open) {
        id
        snapshotVendorName
        vendorId
        date
      }
    }
  `);

  const ReorderSections = graphql(`
    mutation ConsoleReorderPurchaseSections($purchaseId: ID!, $orderedIds: [ID!]!) {
      reorderPurchaseSections(purchaseId: $purchaseId, orderedIds: $orderedIds) {
        id
      }
    }
  `);

  const ReorderItems = graphql(`
    mutation ConsoleReorderPurchaseItems($purchaseId: ID!, $orderedIds: [ID!]!) {
      reorderPurchaseItems(purchaseId: $purchaseId, orderedIds: $orderedIds) {
        id
      }
    }
  `);

  const RecordSend = graphql(`
    mutation ConsoleRecordPurchaseSend(
      $purchaseId: ID!
      $channel: PurchaseSendChannel!
      $recipient: String!
      $note: String
    ) {
      recordPurchaseSend(
        purchaseId: $purchaseId
        channel: $channel
        recipient: $recipient
        note: $note
      ) {
        id
      }
    }
  `);

  const ConfirmSend = graphql(`
    mutation ConsoleConfirmPurchaseSend($id: ID!, $expectedDeliveryDate: String) {
      confirmPurchaseSend(id: $id, expectedDeliveryDate: $expectedDeliveryDate) {
        id
        status
      }
    }
  `);

  // Fetched imperatively when the composer opens / its channel changes — the
  // API renders the message body and resolves the wa.me / mailto: deep link.
  const SendDraftQuery = graphql(`
    query ConsolePurchaseSendDraft(
      $purchaseId: ID!
      $channel: PurchaseSendChannel!
      $recipientOverride: String
    ) {
      purchaseSendDraft(
        purchaseId: $purchaseId
        channel: $channel
        recipientOverride: $recipientOverride
      ) {
        channel
        recipient
        recipientAvailable
        subject
        body
        deepLink
      }
    }
  `);

  let { data }: { data: PageData } = $props();
  const PurchaseDetail = $derived(data.PurchaseDetail);
  const RefData = $derived(data.PurchaseEditorRefData);

  const purchase = $derived($PurchaseDetail.data?.purchase);

  // A vendor or product created in another tab won't appear in the pickers —
  // Houdini serves the cached ref data. Re-pull it when the tab becomes
  // visible again. Line/section edits in progress are plain component state,
  // so the refetch doesn't disturb them.
  refetchOnVisible(() => RefData.fetch({ policy: "NetworkOnly" }));

  const vendors = $derived($RefData.data?.vendors ?? []);
  // Searchable Combobox options for the header vendor; the leading empty row
  // keeps the "ad-hoc vendor" (no vendor on file) choice.
  const vendorOptions = $derived([
    { value: "", label: "— Ad-hoc vendor —" },
    ...vendors.map((v) => ({ value: v.id, label: v.name })),
  ]);
  const products = $derived(($RefData.data?.products ?? []).filter(p => p.kind !== "bundle"));

  // Flat variant options for the item editor — "Product · SKU (label)".
  // `value`/`label` shape feeds the searchable Combobox directly.
  interface VariantOption {
    value: string;
    label: string;
  }
  const variantOptions = $derived.by<VariantOption[]>(() => {
    const out: VariantOption[] = [];
    for (const p of products) {
      for (const v of p.variants) {
        const suffix = v.label ? `${v.sku} · ${v.label}` : v.sku;
        out.push({ value: v.id, label: `${p.name} · ${suffix}` });
      }
    }
    return out.sort((a, b) => a.label.localeCompare(b.label));
  });
  const variantLabel = (id: string | null | undefined) =>
    id ? (variantOptions.find((v) => v.value === id)?.label ?? "Unknown") : null;

  // ---- Unit-cost prefill ----------------------------------------------------
  // New lines prefill with what this vendor last charged for the variant; the
  // variant's current cost is only a fallback (landed costs inflate it past
  // the vendor's actual price). Ad-hoc purchases (no vendor) have no history,
  // so they prefill straight from current cost.
  $effect(() => {
    const vendorId = purchase?.vendorId;
    if (vendorId) VendorLastCostsQuery.fetch({ variables: { vendorId } });
  });
  const lastCostByVariant = $derived.by(() => {
    if (!purchase?.vendorId) return new Map<string, number>();
    return new Map(
      ($VendorLastCostsQuery.data?.vendorLastCosts ?? []).map((c) => [
        c.variantId,
        c.unitCostMinor,
      ]),
    );
  });
  const currentCostByVariant = $derived.by(() => {
    const m = new Map<string, number>();
    for (const p of products) for (const v of p.variants) m.set(v.id, v.costMinor);
    return m;
  });
  const prefillCost = (variantId: string) =>
    lastCostByVariant.get(variantId) ?? currentCostByVariant.get(variantId) ?? 0;

  // ---- Viewer permissions --------------------------------------------------
  const viewer = $derived(page.data.user as Viewer | undefined);
  const has = (key: string) => !!viewer && viewer.permissions.includes(key);
  const canEdit = $derived(has("purchase.edit"));
  const canCancel = $derived(has("purchase.cancel"));
  const canCreate = $derived(has("purchase.create"));
  const canSend = $derived(has("purchase.send"));
  // Gate the combobox's on-the-fly "Create product" row.
  const canCreateProduct = $derived(has("product.create"));

  // A cancelled purchase is a frozen document — editing is closed.
  const editable = $derived(canEdit && purchase?.status !== "cancelled");

  // ---- Header form ---------------------------------------------------------
  interface HeaderForm {
    vendorId: string;
    snapshotVendorName: string;
    date: string;
    sourceDocument: string;
    memo: string;
    sendDueDate: string;
  }
  let form = $state<HeaderForm>({
    vendorId: "",
    snapshotVendorName: "",
    date: "",
    sourceDocument: "",
    memo: "",
    sendDueDate: "",
  });

  const dateInput = (iso: string | null | undefined) =>
    iso ? new Date(iso).toISOString().slice(0, 10) : "";

  // Reset the form when a different purchase loads — not on a plain refetch,
  // so in-progress edits survive.
  let syncedId = $state("");
  $effect(() => {
    const p = purchase;
    if (p && p.id !== syncedId) {
      syncedId = p.id;
      form = {
        vendorId: p.vendorId ?? "",
        snapshotVendorName: p.snapshotVendorName,
        date: dateInput(p.date),
        sourceDocument: p.sourceDocument ?? "",
        memo: p.memo ?? "",
        sendDueDate: dateInput(p.sendDueDate),
      };
    }
  });

  let busy = $state(false);
  // `href`/`linkText` render an optional follow-up link in the banner (e.g.
  // "Open it →" pointing at the PO a re-source just created).
  let feedback = $state<{
    ok: boolean;
    text: string;
    href?: string;
    linkText?: string;
  } | null>(null);

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

  // Force a network round-trip: the line / section / send mutations return only
  // `{ id }`, so Houdini's normalized cache never learns the new or changed
  // rows (and the server-computed header total/revision must be recomputed).
  // The default CacheOrNetwork policy would then re-serve the stale cached list
  // — NetworkOnly guarantees the refetched list reflects the edit. This re-pulls
  // only the purchase row; the vendor/catalog lookups live in their own query.
  const refetch = () => {
    // The network result becomes the new truth — drop any optimistic reorder.
    itemOrder = null;
    sectionOrder = null;
    return (
      purchase &&
      PurchaseDetail.fetch({ variables: { id: purchase.id }, policy: "NetworkOnly" })
    );
  };

  // Re-sort `rows` by an optional desired id sequence; ids missing from the
  // sequence keep their server position at the end (stable). Null = server
  // order. This drives optimistic line/section reorder without a refetch —
  // Houdini's cached list does not reorder when only `sortOrder` changes.
  function applyOrder<T extends { id: string }>(
    rows: readonly T[],
    order: string[] | null,
  ): T[] {
    if (!order) return [...rows];
    const pos = new Map(order.map((id, i) => [id, i]));
    return [...rows].sort(
      (a, b) => (pos.get(a.id) ?? Infinity) - (pos.get(b.id) ?? Infinity),
    );
  }

  async function saveHeader() {
    if (!purchase) return;
    await run("Purchase", () =>
      UpdatePurchase.mutate({
        id: purchase.id,
        vendorId: form.vendorId || null,
        // Ad-hoc name only matters with no vendor on file; the API derives
        // the snapshot from the vendor otherwise.
        snapshotVendorName: form.vendorId
          ? undefined
          : form.snapshotVendorName.trim() || undefined,
        date: form.date,
        sourceDocument: form.sourceDocument.trim() || null,
        memo: form.memo.trim() || null,
        sendDueDate: form.sendDueDate || null,
      }),
    );
  }

  async function cancelPurchase() {
    if (!purchase || !confirm("Cancel this purchase? This cannot be undone."))
      return;
    const ok = await run("Purchase", () =>
      CancelPurchase.mutate({ id: purchase.id }),
    );
    if (ok) await refetch();
  }

  async function clonePurchase() {
    if (!purchase) return;
    busy = true;
    feedback = null;
    try {
      const res = await ClonePurchase.mutate({ id: purchase.id });
      if (res.errors?.length) {
        feedback = { ok: false, text: res.errors[0].message };
        return;
      }
      const id = res.data?.clonePurchase.id;
      if (id) await goto(`/purchases/${id}`);
    } catch (e) {
      feedback = { ok: false, text: e instanceof Error ? e.message : String(e) };
    } finally {
      busy = false;
    }
  }

  // ---- Sections ------------------------------------------------------------
  // Section management lives on the group headers (rename inline, delete,
  // reorder) plus a single "Add section" affordance in the Lines toolbar.
  let newSectionName = $state<string | null>(null); // null = add form closed
  let editingSectionId = $state<string | null>(null);
  let editingSectionName = $state("");

  async function addSection() {
    const name = (newSectionName ?? "").trim();
    if (!purchase || !name) return;
    const ok = await run("Section", () =>
      CreateSection.mutate({ purchaseId: purchase.id, name }),
    );
    if (ok) {
      newSectionName = null;
      await refetch();
    }
  }

  function startRenameSection(id: string, name: string) {
    editingSectionId = id;
    editingSectionName = name;
  }

  async function saveRenameSection() {
    const id = editingSectionId;
    const name = editingSectionName.trim();
    if (!id || !name) return;
    const ok = await run("Section", () => UpdateSection.mutate({ id, name }));
    if (ok) {
      editingSectionId = null;
      await refetch();
    }
  }

  async function deleteSection(id: string) {
    if (!confirm("Delete this section? Its items move to no section.")) return;
    const ok = await run("Section", () => DeleteSection.mutate({ id }));
    if (ok) await refetch();
  }

  type PurchaseSection = NonNullable<typeof purchase>["sections"][number];
  // `sectionOrder` holds the desired id sequence after an optimistic move;
  // `sections` re-sorts the server list by it (see applyOrder). refetch()
  // clears the override back to server truth.
  let sectionOrder = $state<string[] | null>(null);
  const sections = $derived(applyOrder(purchase?.sections ?? [], sectionOrder));

  // ---- Items ---------------------------------------------------------------
  interface ItemDraft {
    id: string | null; // null → a new item
    sectionId: string;
    variantId: string;
    description: string;
    qtyOrdered: number;
    unitCostMinor: number | null;
  }
  let itemDraft = $state<ItemDraft | null>(null);
  // The group the line editor is anchored to (its key), so the form renders
  // inside that section instead of detached at the bottom. Fixed when the form
  // opens, so changing the Section dropdown mid-edit doesn't make it jump.
  let draftGroupKey = $state<string | null>(null);

  // Move focus to a line-form field once it has rendered. Lets opening a new
  // line land the cursor in Variant, and picking a variant jump to Qty.
  async function focusLineField(id: "line-variant" | "line-qty") {
    await tick();
    const el = document.getElementById(id) as HTMLInputElement | null;
    el?.focus();
    el?.select?.();
  }

  function newItem() {
    itemDraft = {
      id: null,
      sectionId: "",
      variantId: "",
      description: "",
      qtyOrdered: 1,
      unitCostMinor: 0,
    };
    draftGroupKey = UNGROUPED;
    focusLineField("line-variant");
  }

  function editItem(i: NonNullable<typeof purchase>["items"][number]) {
    itemDraft = {
      id: i.id,
      sectionId: i.sectionId ?? "",
      variantId: i.variantId ?? "",
      description: i.description ?? "",
      qtyOrdered: i.qtyOrdered,
      unitCostMinor: i.unitCostMinor,
    };
    draftGroupKey = i.sectionId ?? UNGROUPED;
  }

  async function saveItem() {
    const d = itemDraft;
    if (!d || !purchase) return;
    // A line is either a stock variant or a free-text non-stock line.
    if (!d.variantId && !d.description.trim()) {
      feedback = { ok: false, text: "Pick a variant or enter a description." };
      return;
    }
    const unitCostMinor = d.unitCostMinor ?? 0;
    const isNew = !d.id;
    const ok = await run("Item", () =>
      d.id
        ? UpdateItem.mutate({
            id: d.id,
            sectionId: d.sectionId || null,
            variantId: d.variantId || null,
            description: d.description.trim() || null,
            qtyOrdered: d.qtyOrdered,
            unitCostMinor,
          })
        : CreateItem.mutate({
            purchaseId: purchase.id,
            sectionId: d.sectionId || null,
            variantId: d.variantId || null,
            description: d.description.trim() || null,
            qtyOrdered: d.qtyOrdered,
            unitCostMinor,
          }),
    );
    if (ok) {
      await refetch();
      if (isNew) {
        // Keep adding: reset the draft (same section), leave the form open, and
        // drop the cursor back in Variant for the next line.
        itemDraft = {
          id: null,
          sectionId: d.sectionId,
          variantId: "",
          description: "",
          qtyOrdered: 1,
          unitCostMinor: 0,
        };
        focusLineField("line-variant");
      } else {
        itemDraft = null;
      }
    }
  }

  // Combobox quick-create: spin up a product named after the typed query, then
  // select its auto-created variant on the open line draft. The new product
  // lives in the ref-data query (not the purchase row), so we re-pull that —
  // refetch() only re-fetches PurchaseDetail and would never surface it. The
  // ref-data refetch is what lets variantOptions resolve the new variant's
  // label so the combobox shows it selected (and lists it without a hard reload).
  async function createProductForLine(name: string) {
    const d = itemDraft;
    if (!d) return;
    busy = true;
    feedback = null;
    try {
      const res = await CreateProductInline.mutate({
        name,
        kind: "physical" as never,
        priceMode: "tax_inclusive" as never,
        variants: [{ priceMinor: 0, costMinor: 0 }],
      });
      if (res.errors?.length) {
        feedback = { ok: false, text: res.errors[0].message };
        return;
      }
      const variantId = res.data?.createProduct.variants[0]?.id;
      if (variantId) {
        await RefData.fetch({ policy: "NetworkOnly" });
        d.variantId = variantId;
        feedback = { ok: true, text: `Created “${name}”.` };
        focusLineField("line-qty");
      }
    } catch (e) {
      feedback = { ok: false, text: e instanceof Error ? e.message : String(e) };
    } finally {
      busy = false;
    }
  }

  async function deleteItem(id: string) {
    const ok = await run("Item", () => DeleteItem.mutate({ id }));
    if (ok) await refetch();
  }

  // ---- Bulk-add modal ------------------------------------------------------
  // Two ways to fill a PO fast: pick from the reorder scan (intent-driven, the
  // default tab), or sweep the catalog sorted by least stock (ad-hoc). Both end
  // in a single batch insert + refetch.
  let bulkOpen = $state(false);
  let bulkTab = $state<"reorder" | "stock">("reorder");
  // Reorder tab: default-scope to this PO's vendor; toggle shows all vendors.
  let reorderAllVendors = $state(false);
  // Per-row picks, keyed by suggestion id / variant id.
  interface BulkPick {
    selected: boolean;
    qty: number;
    unitCostMinor: number | null;
  }
  let reorderPicks = $state<Record<string, BulkPick>>({});
  let stockPicks = $state<Record<string, BulkPick>>({});
  let stockSearch = $state("");

  const suggestions = $derived(
    $ReorderSuggestionsQuery.data?.reorderSuggestions ?? [],
  );
  // Filter to the PO's vendor by default; suggestions with no vendor always show.
  const reorderRows = $derived(
    reorderAllVendors
      ? suggestions
      : suggestions.filter(
          (s) => !purchase?.vendorId || s.vendorId === purchase.vendorId,
        ),
  );

  // Flat variant list with stock/cost, sorted least-stock-first, name-filtered.
  interface StockRow {
    variantId: string;
    label: string;
    totalQty: number;
    costMinor: number;
    reorderPoint: number | null;
  }
  const stockRows = $derived.by<StockRow[]>(() => {
    const out: StockRow[] = [];
    for (const p of products) {
      for (const v of p.variants) {
        const suffix = v.label ? `${v.sku} · ${v.label}` : v.sku;
        out.push({
          variantId: v.id,
          label: `${p.name} · ${suffix}`,
          totalQty: v.totalQty,
          costMinor: v.costMinor,
          reorderPoint: v.reorderPoint ?? null,
        });
      }
    }
    const tokens = stockSearch.trim().toLowerCase().split(/\s+/).filter(Boolean);
    const matched = tokens.length
      ? out.filter((r) => {
          const hay = r.label.toLowerCase();
          return tokens.every((t) => hay.includes(t));
        })
      : out;
    return matched.sort((a, b) => a.totalQty - b.totalQty);
  });

  // Default order qty for a by-stock row: close the reorder gap, else 1.
  const stockDefaultQty = (r: StockRow) =>
    r.reorderPoint != null ? Math.max(1, r.reorderPoint - r.totalQty) : 1;

  async function openBulk() {
    bulkOpen = true;
    bulkTab = "reorder";
    stockSearch = "";
    // Refresh the vendor's last-charged costs before seeding, so the by-stock
    // picks prefill from them rather than a stale (or still-loading) store.
    if (purchase?.vendorId) {
      await VendorLastCostsQuery.fetch({
        variables: { vendorId: purchase.vendorId },
        policy: "NetworkOnly",
      });
    }
    // Seed every variant's by-stock pick up front so the row's qty / cost
    // inputs have a stable object to bind to (default qty = reorder gap).
    const sp: Record<string, BulkPick> = {};
    for (const r of stockRows) {
      sp[r.variantId] = {
        selected: false,
        qty: stockDefaultQty(r),
        unitCostMinor: prefillCost(r.variantId),
      };
    }
    stockPicks = sp;
    // Pull fresh suggestions every open — a scan may have run since last time.
    await ReorderSuggestionsQuery.fetch({ policy: "NetworkOnly" });
    const picks: Record<string, BulkPick> = {};
    for (const s of suggestions) {
      picks[s.id] = { selected: false, qty: s.suggestedQty, unitCostMinor: null };
    }
    reorderPicks = picks;
  }

  function closeBulk() {
    bulkOpen = false;
  }

  // Count / add from the pick maps (not the filtered row lists) so a selection
  // survives changing the search or the vendor toggle.
  const reorderSelectedCount = $derived(
    Object.values(reorderPicks).filter((p) => p.selected).length,
  );
  const stockSelectedCount = $derived(
    Object.values(stockPicks).filter((p) => p.selected).length,
  );

  // The catalog can be large; render only the first slice of the (sorted,
  // filtered) list and nudge the user to narrow by name for the rest. Selected
  // rows still count toward the batch even when scrolled out by the cap.
  const STOCK_CAP = 60;
  const stockVisible = $derived(stockRows.slice(0, STOCK_CAP));
  const stockTruncated = $derived(stockRows.length > STOCK_CAP);

  const tabClass = (t: "reorder" | "stock") =>
    bulkTab === t
      ? "border-b-2 border-primary px-3 py-2 text-sm font-medium"
      : "border-b-2 border-transparent px-3 py-2 text-sm text-muted-foreground hover:text-foreground";

  async function addReorderSelected() {
    if (!purchase) return;
    const lines = Object.entries(reorderPicks)
      .filter(([, p]) => p.selected)
      .map(([suggestionId, p]) => ({
        suggestionId,
        qty: Math.round(p.qty),
      }));
    if (lines.length === 0) return;
    const ok = await run("Lines", () =>
      AddReorderToPurchase.mutate({ purchaseId: purchase.id, lines }),
    );
    if (ok) {
      await refetch();
      closeBulk();
    }
  }

  async function addStockSelected() {
    if (!purchase) return;
    const lines = Object.entries(stockPicks)
      .filter(([, p]) => p.selected)
      .map(([variantId, p]) => ({
        variantId,
        qtyOrdered: Math.round(p.qty),
        unitCostMinor: p.unitCostMinor ?? 0,
      }));
    if (lines.length === 0) return;
    const ok = await run("Lines", () =>
      CreateItems.mutate({ purchaseId: purchase.id, lines }),
    );
    if (ok) {
      await refetch();
      closeBulk();
    }
  }

  // ---- Inline cell edit ----------------------------------------------------
  // Click a line's qty / unit-cost / (free-text) description cell to edit just
  // that field in place — the common quick tweak, without the full line form.
  // Variant + section stay in the form: they're structural, not quick edits.
  type CellField = "qty" | "cost" | "desc";
  let cellEdit = $state<{ id: string; field: CellField } | null>(null);
  // Qty + description edit through a raw <input> (string); unit cost edits
  // through MoneyInput (integer minor units), so they need separate bindings.
  let cellStr = $state("");
  let cellMoney = $state<number | null>(null);

  // Focus + select the inline <input> the moment it mounts, so you can type or
  // tab straight in. Actions only attach to elements, hence the raw <input>.
  // (MoneyInput does this itself via its `autofocus` prop.)
  function selectOnMount(node: HTMLInputElement) {
    node.focus();
    node.select();
  }

  function startCellEdit(i: Line, field: CellField) {
    if (!editable) return;
    if (field === "cost") cellMoney = i.unitCostMinor;
    else cellStr = field === "qty" ? String(i.qtyOrdered) : (i.description ?? "");
    cellEdit = { id: i.id, field };
  }

  // Commit the in-flight cell edit. Quiet like persistOrder — no busy/banner
  // churn for a one-field tweak; only surface failures. The mutation returns
  // the changed scalars (Houdini normalizes them, so the cell updates at once);
  // the trailing refetch refreshes the header's server-computed total.
  async function commitCell() {
    const c = cellEdit;
    if (!c || !purchase) return;
    const i = items.find((x) => x.id === c.id);
    if (!i) {
      cellEdit = null;
      return;
    }

    const patch: {
      id: string;
      qtyOrdered?: number;
      unitCostMinor?: number;
      description?: string | null;
    } = { id: c.id };

    if (c.field === "qty") {
      const n = Number(cellStr);
      if (!Number.isFinite(n) || n < 0) {
        feedback = { ok: false, text: "Quantity must be a non-negative number." };
        return;
      }
      if (n < i.qtyDelivered) {
        feedback = {
          ok: false,
          text: `Can't order fewer than the ${i.qtyDelivered} already delivered.`,
        };
        return;
      }
      if (n === i.qtyOrdered) {
        cellEdit = null;
        return;
      }
      patch.qtyOrdered = n;
    } else if (c.field === "cost") {
      const n = cellMoney ?? 0;
      if (n === i.unitCostMinor) {
        cellEdit = null;
        return;
      }
      patch.unitCostMinor = n;
    } else {
      const d = cellStr.trim();
      if (!i.variantId && !d) {
        feedback = { ok: false, text: "A non-stock line needs a description." };
        return;
      }
      if ((d || null) === (i.description ?? null)) {
        cellEdit = null;
        return;
      }
      patch.description = d || null;
    }

    cellEdit = null;
    try {
      const res = await UpdateItem.mutate(patch);
      if (res.errors?.length) {
        feedback = { ok: false, text: res.errors[0].message };
      }
    } catch (e) {
      feedback = { ok: false, text: e instanceof Error ? e.message : String(e) };
    }
    await refetch();
  }

  // Enter commits, Escape abandons. Escape nulls the edit first so the input
  // unmounts and the resulting blur becomes a no-op (commitCell guards null).
  function cellKeydown(e: KeyboardEvent) {
    if (e.key === "Enter") {
      e.preventDefault();
      commitCell();
    } else if (e.key === "Escape") {
      e.preventDefault();
      cellEdit = null;
    }
  }

  type PurchaseLine = NonNullable<typeof purchase>["items"][number];
  // Same optimistic-reorder scheme as `sectionOrder` above, for lines.
  let itemOrder = $state<string[] | null>(null);
  const items = $derived(applyOrder(purchase?.items ?? [], itemOrder));
  const lineLabel = (i: (typeof items)[number]) =>
    variantLabel(i.variantId) ?? i.description ?? "—";

  // ---- Grouped / searchable / reorderable lines ----------------------------
  // Lines render grouped under their section (in section order), with an
  // "Ungrouped" bucket last. `items` arrives globally sorted by sortOrder, so
  // pushing in order preserves each group's internal order.
  const UNGROUPED = "__none";
  type Line = (typeof items)[number];
  interface Group {
    key: string; // section id, or UNGROUPED
    name: string;
    items: Line[];
    subtotal: number;
  }

  const lineTotal = (i: Line) => i.qtyOrdered * i.unitCostMinor;

  // Delivered-column badge: emerald once a line is fully received, amber while
  // partially received. A line with nothing received stays a plain number, so
  // a freshly-created PO (all zeros) shows no badges.
  const deliveryBadgeClass = (i: Line) =>
    i.qtyDelivered >= i.qtyOrdered
      ? "bg-emerald-100 text-emerald-700"
      : "bg-amber-100 text-amber-800";

  const groups = $derived.by<Group[]>(() => {
    const bySection = new Map<string, Line[]>();
    for (const i of items) {
      const k = i.sectionId ?? UNGROUPED;
      const list = bySection.get(k) ?? [];
      list.push(i);
      bySection.set(k, list);
    }
    const out: Group[] = sections.map((s) => {
      const its = bySection.get(s.id) ?? [];
      return { key: s.id, name: s.name, items: its, subtotal: its.reduce((a, i) => a + lineTotal(i), 0) };
    });
    const ung = bySection.get(UNGROUPED) ?? [];
    if (ung.length)
      out.push({ key: UNGROUPED, name: "Ungrouped", items: ung, subtotal: ung.reduce((a, i) => a + lineTotal(i), 0) });
    return out;
  });

  // Search + section filter. Reordering is disabled while either is active —
  // moving a row relative to hidden rows would be ambiguous.
  let lineSearch = $state("");
  let sectionFilter = $state(""); // "" = all; section id; or UNGROUPED
  const queryTokens = $derived(searchTokens(lineSearch.trim()));
  const filtering = $derived(queryTokens.length > 0 || !!sectionFilter);
  const canReorder = $derived(editable && !filtering);

  const lineMatches = (i: Line) =>
    matchesTokens(queryTokens, lineLabel(i), i.description);

  interface VisibleGroup extends Group {
    visibleItems: Line[];
  }
  const visibleGroups = $derived.by<VisibleGroup[]>(() =>
    groups
      .filter((g) => !sectionFilter || g.key === sectionFilter)
      .map((g) => ({ ...g, visibleItems: g.items.filter(lineMatches) }))
      // While searching, drop groups with no matches; otherwise keep empty
      // sections so lines can still be added to them.
      .filter((g) => !queryTokens.length || g.visibleItems.length > 0),
  );

  // Collapse state by group key; a search forces everything open.
  let collapsed = $state<Set<string>>(new Set());
  const isOpen = (key: string) => queryTokens.length > 0 || !collapsed.has(key);
  function toggleCollapse(key: string) {
    const next = new Set(collapsed);
    next.has(key) ? next.delete(key) : next.add(key);
    collapsed = next;
  }

  // ---- Bulk selection + actions -------------------------------------------
  // Tick lines to act on several at once. Selection is by line id and survives
  // collapse/scroll; an effect prunes ids that no longer exist. The actions
  // reuse the single-line mutations in a loop — a PO carries few enough lines
  // that no batch endpoint is warranted.
  let selected = $state<Set<string>>(new Set());
  const selectedCount = $derived(selected.size);

  // Drop selected ids that have vanished (deleted here or elsewhere) so the
  // count and toolbar never reference ghosts after a refetch.
  $effect(() => {
    const live = new Set(items.map((i) => i.id));
    if ([...selected].some((id) => !live.has(id)))
      selected = new Set([...selected].filter((id) => live.has(id)));
  });

  function toggleSelect(id: string) {
    const next = new Set(selected);
    next.has(id) ? next.delete(id) : next.add(id);
    selected = next;
  }

  // A group's header checkbox: checked when every visible line is selected,
  // indeterminate when only some are.
  const groupChecked = (g: VisibleGroup) =>
    g.visibleItems.length > 0 && g.visibleItems.every((i) => selected.has(i.id));
  const groupIndeterminate = (g: VisibleGroup) =>
    g.visibleItems.some((i) => selected.has(i.id)) && !groupChecked(g);

  function toggleGroupSelect(g: VisibleGroup) {
    const next = new Set(selected);
    const all = groupChecked(g);
    for (const i of g.visibleItems) all ? next.delete(i.id) : next.add(i.id);
    selected = next;
  }

  const clearSelection = () => (selected = new Set());

  // Run `fn` for every selected id in turn, stopping at the first error. Like
  // run() but tallies how many succeeded, then clears the selection + refetches.
  async function runBulk(
    verb: string,
    fn: (id: string) => Promise<{ errors?: readonly { message: string }[] | null }>,
  ) {
    const ids = [...selected];
    if (!purchase || ids.length === 0) return;
    busy = true;
    feedback = null;
    let done = 0;
    try {
      for (const id of ids) {
        const res = await fn(id);
        if (res.errors?.length) {
          feedback = { ok: false, text: res.errors[0].message };
          break;
        }
        done++;
      }
      if (!feedback)
        feedback = {
          ok: true,
          text: `${verb} ${done} line${done === 1 ? "" : "s"}.`,
        };
    } catch (e) {
      feedback = { ok: false, text: e instanceof Error ? e.message : String(e) };
    } finally {
      busy = false;
    }
    selected = new Set();
    await refetch();
  }

  async function deleteSelected() {
    const n = selected.size;
    if (
      !n ||
      !confirm(
        `Delete ${n} selected line${n === 1 ? "" : "s"}? This cannot be undone.`,
      )
    )
      return;
    await runBulk("Deleted", (id) => DeleteItem.mutate({ id }));
  }

  // sectionId "" → move to no section. UpdateItem returns the changed sectionId,
  // which Houdini normalizes, so each line jumps to its new group at once.
  async function moveSelectedToSection(sectionId: string) {
    if (!selected.size) return;
    await runBulk("Moved", (id) =>
      UpdateItem.mutate({ id, sectionId: sectionId || null }),
    );
  }

  // ---- Re-source modal -----------------------------------------------------
  // Split the selected (undelivered) lines onto a fresh PO for a different
  // vendor — the pre-delivery reconciliation move when a vendor's invoice comes
  // back short. Each line is swapped to the substitute vendor's own variant
  // (a different brand); the source lines are trimmed by what moves.
  interface ResourceRow {
    sourceItemId: string;
    sourceLabel: string;
    sourceIsStock: boolean;
    variantId: string; // replacement variant (stock lines)
    description: string; // replacement label (non-stock lines)
    remaining: number; // qtyOrdered (re-sourced lines have no deliveries)
    qty: number;
    unitCostMinor: number | null;
  }
  let resourceOpen = $state(false);
  let resourceMode = $state<"existing" | "new">("existing");
  let resourceTargetPurchaseId = $state("");
  let resourceVendorId = $state("");
  let resourceRows = $state<ResourceRow[]>([]);

  // Open POs to re-source into, excluding this one. `value`/`label` feed the
  // existing-PO Combobox directly.
  const resourceTargets = $derived(
    ($ResourceTargetsQuery.data?.purchases ?? []).filter((p) => p.id !== purchase?.id),
  );
  const resourceTargetOptions = $derived(
    resourceTargets.map((p) => ({
      value: p.id,
      label: `${p.snapshotVendorName} · ${fmtDate(p.date)}`,
    })),
  );

  // The destination vendor drives the per-line cost default: the chosen PO's
  // vendor when adding to an existing PO, else the picked vendor.
  const resourceDestVendorId = $derived(
    resourceMode === "existing"
      ? (resourceTargets.find((p) => p.id === resourceTargetPurchaseId)?.vendorId ?? "")
      : resourceVendorId,
  );

  // That vendor's last-charged cost per variant — for the per-line "→ Rp" hint.
  const resourceCostByVariant = $derived(
    new Map(
      ($ResourceVendorCostsQuery.data?.vendorLastCosts ?? []).map((c) => [
        c.variantId,
        c.unitCostMinor,
      ]),
    ),
  );
  $effect(() => {
    if (resourceOpen && resourceDestVendorId)
      ResourceVendorCostsQuery.fetch({ variables: { vendorId: resourceDestVendorId } });
  });

  // Only lines with no deliveries can be re-sourced (matches the API's lock).
  function openResource() {
    const chosen = items.filter((i) => selected.has(i.id) && i.qtyDelivered === 0);
    if (chosen.length === 0) {
      feedback = {
        ok: false,
        text: "Re-sourcing applies only to selected lines with no deliveries yet.",
      };
      return;
    }
    resourceRows = chosen.map((i) => ({
      sourceItemId: i.id,
      sourceLabel: lineLabel(i),
      sourceIsStock: !!i.variantId,
      variantId: i.variantId ?? "",
      description: i.description ?? "",
      remaining: i.qtyOrdered,
      qty: i.qtyOrdered,
      unitCostMinor: null,
    }));
    resourceMode = "existing";
    resourceTargetPurchaseId = "";
    resourceVendorId = "";
    // Pull open POs for the "add to existing" picker.
    ResourceTargetsQuery.fetch({ policy: "NetworkOnly" });
    resourceOpen = true;
  }

  const closeResource = () => (resourceOpen = false);

  // Tab styling for the destination mode toggle (mirrors the bulk modal's tabs).
  const resourceTabClass = (m: "existing" | "new") =>
    resourceMode === m
      ? "border-b-2 border-primary px-3 py-2 text-sm font-medium"
      : "border-b-2 border-transparent px-3 py-2 text-sm text-muted-foreground hover:text-foreground";

  // The cost a row will land at: the clerk's override, else the destination
  // vendor's last price for the chosen variant, else 0 — mirrors the API default.
  const resourceRowCost = (r: ResourceRow) =>
    r.unitCostMinor ??
    (r.variantId ? resourceCostByVariant.get(r.variantId) : undefined) ??
    0;

  async function submitResource() {
    if (!purchase) return;
    const useExisting = resourceMode === "existing";
    if (useExisting && !resourceTargetPurchaseId) {
      feedback = { ok: false, text: "Pick a PO to re-source into." };
      return;
    }
    if (!useExisting && !resourceVendorId) {
      feedback = { ok: false, text: "Pick a vendor to re-source to." };
      return;
    }
    for (const r of resourceRows) {
      if (r.sourceIsStock && !r.variantId) {
        feedback = { ok: false, text: "Pick a replacement product for every line." };
        return;
      }
      if (!r.sourceIsStock && !r.description.trim()) {
        feedback = { ok: false, text: "Enter a description for every non-stock line." };
        return;
      }
      if (!Number.isFinite(r.qty) || r.qty < 1 || r.qty > r.remaining) {
        feedback = { ok: false, text: "Each quantity must be between 1 and its ordered amount." };
        return;
      }
    }
    const replacements = resourceRows.map((r) => ({
      sourceItemId: r.sourceItemId,
      variantId: r.sourceIsStock ? r.variantId || null : null,
      description: r.sourceIsStock ? null : r.description.trim() || null,
      qty: Math.round(r.qty),
      unitCostMinor: r.unitCostMinor,
    }));
    const n = replacements.length;

    busy = true;
    feedback = null;
    try {
      const res = await ResourcePurchaseItems.mutate({
        sourcePurchaseId: purchase.id,
        targetPurchaseId: useExisting ? resourceTargetPurchaseId : null,
        targetVendorId: useExisting ? null : resourceVendorId,
        replacements,
      });
      if (res.errors?.length) {
        feedback = { ok: false, text: res.errors[0].message };
        return;
      }
      const dest = res.data?.resourcePurchaseItems;
      resourceOpen = false;
      selected = new Set();
      // The mutation returns only the destination PO, so Houdini's cache never
      // learns that the source lines were trimmed. Re-pull this PO (NetworkOnly)
      // so its lines update in place — same pattern as every other edit here.
      // Stay put (reconciliation continues) and offer the destination as a link.
      await refetch();
      const destName = dest?.snapshotVendorName ?? "the vendor";
      const where = useExisting ? `into the PO for ${destName}` : `to a new PO for ${destName}`;
      feedback = {
        ok: true,
        text: `Re-sourced ${n} line${n === 1 ? "" : "s"} ${where}.`,
        href: dest?.id ? `/purchases/${dest.id}` : undefined,
        linkText: dest?.id ? "Open it →" : undefined,
      };
    } catch (e) {
      feedback = { ok: false, text: e instanceof Error ? e.message : String(e) };
    } finally {
      busy = false;
    }
  }

  // Persist a reorder quietly: the list already moved optimistically, so we
  // skip the busy/feedback churn that `run()` does — toggling `busy` disables
  // (and de-focuses) the arrow button you just clicked, and the "saved" banner
  // appearing/disappearing shifts the page height on every move. Only surface
  // failures, and revert to server truth when one happens.
  async function persistOrder(
    fn: () => Promise<{ errors?: readonly { message: string }[] | null }>,
  ): Promise<void> {
    try {
      const res = await fn();
      if (res.errors?.length) {
        feedback = { ok: false, text: res.errors[0].message };
        await refetch();
      }
    } catch (e) {
      feedback = { ok: false, text: e instanceof Error ? e.message : String(e) };
      await refetch();
    }
  }

  // Keep the keyboard/click focus on the arrow after a move: the keyed {#each}
  // relocates the row's DOM node, which drops focus, so the same logical arrow
  // ends up unfocused. Re-focus the clicked button once the list re-renders,
  // unless the move pushed it to an end (where that arrow is now disabled).
  async function restoreFocus(btn: HTMLElement) {
    await tick();
    if (!(btn as HTMLButtonElement).disabled) btn.focus();
  }

  async function moveSection(index: number, dir: -1 | 1, btn?: HTMLElement) {
    if (!purchase) return;
    const arr = [...sections];
    const j = index + dir;
    if (j < 0 || j >= arr.length) return;
    [arr[index], arr[j]] = [arr[j], arr[index]];
    sectionOrder = arr.map((s) => s.id); // optimistic — no full-page refetch
    if (btn) await restoreFocus(btn);
    await persistOrder(() =>
      ReorderSections.mutate({ purchaseId: purchase.id, orderedIds: arr.map((s) => s.id) }),
    );
  }

  async function moveLine(group: Group, index: number, dir: -1 | 1, btn?: HTMLElement) {
    if (!purchase) return;
    const arr = [...group.items];
    const j = index + dir;
    if (j < 0 || j >= arr.length) return;
    [arr[index], arr[j]] = [arr[j], arr[index]];
    // Rebuild the full purchase-wide order (grouped display order) with this
    // group's items in their new sequence — reorderItems wants every id once.
    const orderedIds = groups.flatMap((g) =>
      (g.key === group.key ? arr : g.items).map((i) => i.id),
    );
    // Optimistic — apply the new order via the derived list; the table updates
    // instantly with no full-page refetch.
    itemOrder = orderedIds;
    if (btn) await restoreFocus(btn);
    await persistOrder(() =>
      ReorderItems.mutate({ purchaseId: purchase.id, orderedIds }),
    );
  }

  function newItemInSection(sectionId: string) {
    itemDraft = {
      id: null,
      sectionId: sectionId === UNGROUPED ? "" : sectionId,
      variantId: "",
      description: "",
      qtyOrdered: 1,
      unitCostMinor: 0,
    };
    draftGroupKey = sectionId;
    focusLineField("line-variant");
  }

  // ---- Sends — deep-link composer -----------------------------------------
  const CHANNELS = ["whatsapp", "email", "manual"];
  interface Composer {
    channel: string;
    recipientOverride: string;
    note: string;
    /** WhatsApp only: "text" = wa.me deep link, "pdf" = share the PO PDF. */
    format: "text" | "pdf";
  }
  let composer = $state<Composer | null>(null);
  let previewing = $state(false);
  let sharing = $state(false);

  // The rendered draft (body + resolved recipient + deep link) for the
  // current composer channel / recipient.
  const draft = $derived($SendDraftQuery.data?.purchaseSendDraft);
  // Prices on the printed PO are hidden by default; the clerk opts in here.
  let pdfShowPrices = $state(false);
  // The PDF goes through the console's own cookie-authenticated proxy route.
  const pdfHref = $derived(
    purchase
      ? `/purchases/${purchase.id}/po.pdf${pdfShowPrices ? "?prices=1" : ""}`
      : "#",
  );

  async function preview() {
    const c = composer;
    if (!c || !purchase) return;
    previewing = true;
    feedback = null;
    try {
      // NetworkOnly — the rendered body embeds the business name / greeting /
      // footer and the vendor's contact, none of which are query variables, so
      // a cached draft would keep showing the old business details after a
      // settings edit. Always re-render server-side.
      await SendDraftQuery.fetch({
        policy: "NetworkOnly",
        variables: {
          purchaseId: purchase.id,
          channel: c.channel as never,
          recipientOverride: c.recipientOverride.trim() || null,
        },
      });
    } catch (e) {
      feedback = { ok: false, text: e instanceof Error ? e.message : String(e) };
    } finally {
      previewing = false;
    }
  }

  function startCompose() {
    composer = { channel: "whatsapp", recipientOverride: "", note: "", format: "text" };
    preview();
  }

  /**
   * Share the PO PDF via the device's native share sheet (Web Share API) so the
   * clerk can pick WhatsApp and the PDF goes as an attachment — a wa.me link can
   * only carry text, never a file. The OS share sheet picks the recipient, so
   * the resolved number is informational only here. Respects the price-visibility
   * toggle by reusing the same proxied PDF URL as the Download PDF link. A
   * dismissed share sheet (AbortError) is a no-op, not a failure.
   */
  async function sharePdf() {
    if (!purchase) return;
    sharing = true;
    feedback = null;
    try {
      const res = await fetch(pdfHref, { credentials: "same-origin" });
      if (!res.ok) throw new Error(`PDF unavailable (${res.status})`);
      const blob = await res.blob();
      const file = new File([blob], `po-${purchase.id}.pdf`, {
        type: "application/pdf",
      });
      if (!navigator.canShare?.({ files: [file] })) {
        feedback = {
          ok: false,
          text: "This device can't share files. Use Download PDF, then attach it in WhatsApp.",
        };
        return;
      }
      const caption = `${draft?.subject ?? "Purchase Order"} — see the attached PDF.`;
      await navigator.share({
        files: [file],
        title: draft?.subject ?? "Purchase Order",
        text: caption,
      });
    } catch (e) {
      if (e instanceof DOMException && e.name === "AbortError") return; // dismissed
      feedback = { ok: false, text: e instanceof Error ? e.message : String(e) };
    } finally {
      sharing = false;
    }
  }

  // The recipient to log: an explicit override wins, else the resolved one.
  const logRecipient = $derived(
    composer?.recipientOverride.trim() || draft?.recipient || "",
  );

  /** Log the send to the purchase's append-only send history. */
  async function logSend() {
    const c = composer;
    if (!c || !purchase || !logRecipient) return;
    const ok = await run("Send", () =>
      RecordSend.mutate({
        purchaseId: purchase.id,
        channel: c.channel as never,
        recipient: logRecipient,
        note: c.note.trim() || null,
      }),
    );
    if (ok) {
      composer = null;
      await refetch();
    }
  }

  async function confirmSend(id: string) {
    const date = prompt("Expected delivery date (YYYY-MM-DD, optional):", "");
    if (date === null) return; // cancelled
    const ok = await run("Send", () =>
      ConfirmSend.mutate({ id, expectedDeliveryDate: date.trim() || null }),
    );
    if (ok) await refetch();
  }

  const sends = $derived(purchase?.sends ?? []);
  const fmtDate = (iso: string | null | undefined) =>
    iso ? new Date(iso).toLocaleDateString("id-ID") : "—";

  const statusClass = (s: string) =>
    s === "open"
      ? "bg-sky-100 text-sky-700"
      : s === "complete"
        ? "bg-emerald-100 text-emerald-700"
        : "bg-muted text-muted-foreground";
</script>

<svelte:head>
  <title>
    {purchase ? purchase.snapshotVendorName : "Purchase"} · Retale Console
  </title>
</svelte:head>

<!-- Line-form keyboard shortcuts: Ctrl/Cmd+Enter saves (add several lines
     without the mouse), Esc closes. Esc inside the variant combobox closes its
     menu first — it only reaches here once the menu is already shut. -->
<svelte:window
  onkeydown={(e) => {
    // Esc closes an open modal first.
    if (resourceOpen) {
      if (e.key === "Escape") {
        e.preventDefault();
        closeResource();
      }
      return;
    }
    if (bulkOpen) {
      if (e.key === "Escape") {
        e.preventDefault();
        closeBulk();
      }
      return;
    }
    if (!itemDraft || busy) return;
    if ((e.ctrlKey || e.metaKey) && e.key === "Enter" && editable) {
      e.preventDefault();
      saveItem();
    } else if (e.key === "Escape") {
      e.preventDefault();
      itemDraft = null;
    }
  }}
/>

<div
  class="mx-auto max-w-5xl space-y-6"
  class:pb-24={selectedCount > 0 && editable}
>
  <a
    href="/purchases"
    class="text-sm text-muted-foreground hover:text-foreground"
    >← Back to purchases</a
  >

  {#if $PurchaseDetail.fetching && !purchase}
    <p class="text-sm text-muted-foreground">Loading…</p>
  {:else if !purchase}
    <p class="text-sm text-destructive">Purchase not found.</p>
  {:else}
    <div class="flex items-start justify-between gap-4">
      <div>
        <h1 class="text-xl font-semibold">{purchase.snapshotVendorName}</h1>
        <p class="text-sm text-muted-foreground">
          {fmtDate(purchase.date)} · revision {purchase.revision} ·
          {formatMoney(purchase.totalInvoiceCost)}
        </p>
      </div>
      <div class="flex items-center gap-3">
        <Badge class={statusClass(purchase.status)}>{statusLabel(purchase.status)}</Badge>
        {#if has("delivery.draft") && purchase.status !== "cancelled"}
          <a
            href="/purchases/{purchase.id}/receive"
            class="inline-flex h-8 items-center rounded-md border px-3 text-sm font-medium hover:bg-accent"
          >
            Receive goods
          </a>
        {/if}
        {#if canCreate}
          <Button
            variant="outline"
            size="sm"
            disabled={busy}
            onclick={clonePurchase}>Clone</Button
          >
        {/if}
        {#if canCancel && purchase.status !== "cancelled"}
          <Button
            variant="outline"
            size="sm"
            disabled={busy}
            onclick={cancelPurchase}>Cancel</Button
          >
        {/if}
      </div>
    </div>

    {#if feedback}
      <p class="text-sm {feedback.ok ? 'text-emerald-700' : 'text-destructive'}">
        {feedback.text}
        {#if feedback.href && feedback.linkText}
          <a href={feedback.href} class="font-medium underline">{feedback.linkText}</a>
        {/if}
      </p>
    {/if}

    {#if purchase.status === "cancelled"}
      <p
        class="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800"
      >
        This purchase is cancelled — it is read-only.
      </p>
    {:else if !canEdit}
      <p
        class="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800"
      >
        You have read-only access to purchases — editing is disabled.
      </p>
    {/if}

    {#if purchase.hasUnsentChanges && purchase.lastSentAt}
      <p
        class="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800"
      >
        This purchase has edits not covered by the latest confirmed send.
      </p>
    {/if}

    <!-- Header -->
    <section class="space-y-4 rounded-lg border bg-card p-5">
      <h2 class="text-sm font-semibold">Details</h2>
      <div class="grid grid-cols-2 gap-4">
        <label class="space-y-1">
          <span class="text-sm font-medium">Vendor</span>
          <Combobox
            options={vendorOptions}
            bind:value={form.vendorId}
            placeholder="Search vendor…"
            disabled={!editable}
          />
        </label>
        <label class="space-y-1">
          <span class="text-sm font-medium">Ad-hoc vendor name</span>
          <Input
            bind:value={form.snapshotVendorName}
            disabled={!editable || form.vendorId !== ""}
          />
        </label>
        <label class="space-y-1">
          <span class="text-sm font-medium">Date</span>
          <Input type="date" bind:value={form.date} disabled={!editable} />
        </label>
        <label class="space-y-1">
          <span class="text-sm font-medium">Send-by date</span>
          <Input
            type="date"
            bind:value={form.sendDueDate}
            disabled={!editable}
          />
        </label>
        <label class="space-y-1">
          <span class="text-sm font-medium">Source document</span>
          <Input
            bind:value={form.sourceDocument}
            placeholder="Vendor quote / invoice ref"
            disabled={!editable}
          />
        </label>
      </div>
      <label class="space-y-1">
        <span class="text-sm font-medium">Memo</span>
        <Textarea
          bind:value={form.memo}
          disabled={!editable}
          class="h-20 resize-none"
        />
      </label>
      <div class="flex justify-end pt-2">
        <Button disabled={busy || !editable} onclick={saveHeader}>
          Save details
        </Button>
      </div>
    </section>

    <!-- Items -->
    <section class="space-y-3 rounded-lg border bg-card p-5">
      <div class="flex items-center justify-between gap-3">
        <h2 class="text-sm font-semibold">Lines ({items.length})</h2>
        <div class="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            disabled={busy || !editable}
            onclick={() => (newSectionName = "")}>Add section</Button
          >
          <Button
            variant="outline"
            size="sm"
            disabled={busy || !editable}
            onclick={openBulk}>Add multiple</Button
          >
          <Button
            variant="outline"
            size="sm"
            disabled={busy || !editable}
            onclick={newItem}>Add line</Button
          >
        </div>
      </div>

      {#if newSectionName !== null}
        <div class="flex gap-2">
          <Input
            bind:value={newSectionName}
            placeholder="New section name"
            onkeydown={(e) => e.key === "Enter" && addSection()}
          />
          <Button
            size="sm"
            disabled={busy || !newSectionName.trim()}
            onclick={addSection}>Add</Button
          >
          <Button
            variant="ghost"
            size="sm"
            disabled={busy}
            onclick={() => (newSectionName = null)}>Cancel</Button
          >
        </div>
      {/if}

      {#if items.length > 0 || sections.length > 0}
        <div class="flex flex-wrap items-center gap-2">
          <div class="w-56">
            <Input
              type="search"
              placeholder="Search lines…"
              bind:value={lineSearch}
            />
          </div>
          <div class="w-44">
            <Select bind:value={sectionFilter}>
              <option value="">All sections</option>
              {#each sections as s (s.id)}
                <option value={s.id}>{s.name}</option>
              {/each}
              <option value={UNGROUPED}>Ungrouped</option>
            </Select>
          </div>
          {#if filtering && editable}
            <span class="text-xs text-muted-foreground">
              Reordering is paused while filtering — clear the search/filter to
              reorder.
            </span>
          {/if}
        </div>
      {/if}

      {#if selectedCount > 0 && editable}
        <!-- Floating bulk-actions bar: fixed overlay so ticking a line never
             shifts the table. Renders only while a selection is active. -->
        <div
          class="fixed bottom-6 left-1/2 z-50 flex -translate-x-1/2 flex-wrap items-center gap-2 rounded-lg border border-primary/40 bg-card px-3 py-2 shadow-lg"
          transition:fly={{ y: 12, duration: 150 }}
        >
          <span class="text-sm font-medium">
            {selectedCount} line{selectedCount === 1 ? "" : "s"} selected
          </span>
          <div class="w-48">
            <Select
              value="__bulk"
              disabled={busy}
              onchange={(e) => {
                const v = e.currentTarget.value;
                e.currentTarget.value = "__bulk"; // snap back to the prompt
                if (v !== "__bulk")
                  moveSelectedToSection(v === UNGROUPED ? "" : v);
              }}
            >
              <option value="__bulk" disabled>Move to section…</option>
              {#each sections as s (s.id)}
                <option value={s.id}>{s.name}</option>
              {/each}
              <option value={UNGROUPED}>— No section —</option>
            </Select>
          </div>
          {#if purchase.status === "open"}
            <Button
              variant="outline"
              size="sm"
              disabled={busy}
              onclick={openResource}>Re-source…</Button
            >
          {/if}
          <Button
            variant="destructive"
            size="sm"
            disabled={busy}
            onclick={deleteSelected}>Delete selected</Button
          >
          <Button
            variant="ghost"
            size="sm"
            disabled={busy}
            onclick={clearSelection}>Clear</Button
          >
        </div>
      {/if}

      {#if items.length === 0 && sections.length === 0}
        <p class="py-6 text-center text-sm text-muted-foreground">No lines yet.</p>
      {:else if visibleGroups.length === 0}
        <p class="py-6 text-center text-sm text-muted-foreground">
          No lines match.
        </p>
      {/if}

      {#snippet lineForm()}
        {#if itemDraft}
          <div class="space-y-3 rounded-md border bg-background p-4">
            <h3 class="text-sm font-semibold">
              {itemDraft.id ? "Edit line" : "New line"}
            </h3>
            <div class="grid grid-cols-2 gap-3">
              <label class="space-y-1">
                <span class="text-xs font-medium">Variant (stock line)</span>
                <Combobox
                  id="line-variant"
                  options={variantOptions}
                  bind:value={itemDraft.variantId}
                  placeholder="Search variant… (leave blank for non-stock line)"
                  disabled={!editable}
                  onCreate={canCreateProduct && editable
                    ? createProductForLine
                    : undefined}
                  createLabel={(q) => `Create product “${q}”`}
                  onChange={(id) => {
                    if (itemDraft && id) itemDraft.unitCostMinor = prefillCost(id);
                    focusLineField("line-qty");
                  }}
                />
              </label>
              <label class="space-y-1">
                <span class="text-xs font-medium">Section</span>
                <Select bind:value={itemDraft.sectionId} disabled={!editable}>
                  <option value="">— No section —</option>
                  {#each sections as s (s.id)}
                    <option value={s.id}>{s.name}</option>
                  {/each}
                </Select>
              </label>
              <label class="space-y-1 col-span-2">
                <span class="text-xs font-medium">Description</span>
                <Input
                  bind:value={itemDraft.description}
                  placeholder={itemDraft.variantId
                    ? "Optional note"
                    : "Required for a non-stock line"}
                  disabled={!editable}
                />
              </label>
              <label class="space-y-1">
                <span class="text-xs font-medium">Qty ordered</span>
                <Input
                  id="line-qty"
                  type="number"
                  bind:value={itemDraft.qtyOrdered}
                  disabled={!editable}
                />
              </label>
              <label class="space-y-1">
                <span class="text-xs font-medium">Unit cost (Rp)</span>
                <MoneyInput bind:value={itemDraft.unitCostMinor} disabled={!editable} />
              </label>
            </div>
            <div class="flex items-center justify-end gap-2">
              {#if editable}
                <span class="mr-auto text-xs text-muted-foreground">
                  <kbd class="rounded border px-1 font-mono">Ctrl</kbd>+<kbd
                    class="rounded border px-1 font-mono">Enter</kbd
                  > to {itemDraft.id ? "save" : "add"}
                </span>
              {/if}
              <Button
                variant="ghost"
                size="sm"
                disabled={busy}
                onclick={() => (itemDraft = null)}>Cancel</Button
              >
              <Button size="sm" disabled={busy || !editable} onclick={saveItem}>
                {itemDraft.id ? "Save line" : "Add line"}
              </Button>
            </div>
          </div>
        {/if}
      {/snippet}

      {#each visibleGroups as g (g.key)}
        {@const sIdx = sections.findIndex((s) => s.id === g.key)}
        <div class="rounded-md border">
          <!-- Group header -->
          <div class="flex items-center gap-2 border-b bg-muted/40 px-3 py-2">
            <button
              class="text-muted-foreground hover:text-foreground"
              onclick={() => toggleCollapse(g.key)}
              aria-label={isOpen(g.key) ? "Collapse" : "Expand"}
            >
              {#if isOpen(g.key)}
                <ChevronDown class="size-4" />
              {:else}
                <ChevronRight class="size-4" />
              {/if}
            </button>
            {#if editingSectionId === g.key}
              <Input
                bind:value={editingSectionName}
                class="h-7 max-w-xs"
                onkeydown={(e) => {
                  if (e.key === "Enter") saveRenameSection();
                  if (e.key === "Escape") editingSectionId = null;
                }}
              />
              <Button
                size="sm"
                class="h-7"
                disabled={busy || !editingSectionName.trim()}
                onclick={saveRenameSection}>Save</Button
              >
              <Button
                variant="ghost"
                size="sm"
                class="h-7"
                disabled={busy}
                onclick={() => (editingSectionId = null)}>Cancel</Button
              >
            {:else}
              <span class="text-sm font-medium">{g.name}</span>
              <span class="text-xs text-muted-foreground">
                {g.items.length} line{g.items.length === 1 ? "" : "s"} ·
                {formatMoney(g.subtotal)}
              </span>
            {/if}
            {#if sIdx >= 0 && editingSectionId !== g.key}
              <span class="ml-auto flex items-center gap-0.5">
                <IconButton
                  icon={ArrowUp}
                  label="Move section up"
                  disabled={busy || !canReorder || sIdx === 0}
                  onclick={(e) => moveSection(sIdx, -1, e.currentTarget)}
                />
                <IconButton
                  icon={ArrowDown}
                  label="Move section down"
                  disabled={busy || !canReorder || sIdx === sections.length - 1}
                  onclick={(e) => moveSection(sIdx, 1, e.currentTarget)}
                />
                <IconButton
                  icon={Pencil}
                  label="Rename section"
                  variant="primary"
                  disabled={busy || !editable}
                  onclick={() => startRenameSection(g.key, g.name)}
                />
                <IconButton
                  icon={Trash2}
                  label="Delete section"
                  variant="destructive"
                  disabled={busy || !editable}
                  onclick={() => deleteSection(g.key)}
                />
              </span>
            {/if}
          </div>

          {#if isOpen(g.key)}
            {#if g.visibleItems.length > 0}
              <table class="w-full text-sm">
                <thead class="border-b text-left text-muted-foreground">
                  <tr>
                    {#if editable}
                      <th class="w-8 px-3 py-2">
                        <input
                          type="checkbox"
                          class="size-4 cursor-pointer rounded border-input align-middle accent-primary"
                          checked={groupChecked(g)}
                          indeterminate={groupIndeterminate(g)}
                          onchange={() => toggleGroupSelect(g)}
                          aria-label="Select all lines in {g.name}"
                        />
                      </th>
                    {/if}
                    <th class="px-4 py-2 font-medium">Line</th>
                    <th class="px-4 py-2 text-right font-medium">Ordered</th>
                    <th class="px-4 py-2 text-right font-medium">Delivered</th>
                    <th class="px-4 py-2 text-right font-medium">Unit cost</th>
                    <th class="px-4 py-2 text-right font-medium">Line total</th>
                    <th class="px-3"></th>
                  </tr>
                </thead>
                <tbody>
                  {#each g.visibleItems as i, idx (i.id)}
                    <tr
                      class="border-b last:border-0 {selected.has(i.id)
                        ? 'bg-primary/10'
                        : 'even:bg-muted/40'}"
                    >
                      {#if editable}
                        <td class="px-3 py-2">
                          <input
                            type="checkbox"
                            class="size-4 cursor-pointer rounded border-input align-middle accent-primary"
                            checked={selected.has(i.id)}
                            onchange={() => toggleSelect(i.id)}
                            aria-label="Select line"
                          />
                        </td>
                      {/if}
                      <td class="px-4 py-2">
                        {#if cellEdit?.id === i.id && cellEdit.field === "desc"}
                          <input
                            bind:value={cellStr}
                            use:selectOnMount
                            onkeydown={cellKeydown}
                            onblur={commitCell}
                            class="h-7 w-full rounded-md border border-input bg-background px-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                          />
                        {:else if editable && !i.variantId}
                          <button
                            type="button"
                            class="-mx-1 rounded px-1 text-left hover:bg-accent"
                            title="Edit description"
                            onclick={() => startCellEdit(i, "desc")}
                            >{lineLabel(i)}</button
                          >
                        {:else}
                          {lineLabel(i)}
                        {/if}
                      </td>
                      <td class="px-4 py-2 text-right tabular-nums">
                        {#if cellEdit?.id === i.id && cellEdit.field === "qty"}
                          <input
                            type="number"
                            bind:value={cellStr}
                            use:selectOnMount
                            onkeydown={cellKeydown}
                            onblur={commitCell}
                            class="h-7 w-20 rounded-md border border-input bg-background px-2 text-right text-sm tabular-nums focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                          />
                        {:else if editable}
                          <button
                            type="button"
                            class="-mx-1 rounded px-1 hover:bg-accent"
                            title="Edit quantity"
                            onclick={() => startCellEdit(i, "qty")}
                            >{i.qtyOrdered}</button
                          >
                        {:else}
                          {i.qtyOrdered}
                        {/if}
                      </td>
                      <td class="px-4 py-2 text-right tabular-nums">
                        {#if i.qtyDelivered > 0}
                          <Badge class={deliveryBadgeClass(i)}>
                            {i.qtyDelivered}
                          </Badge>
                        {:else}
                          {i.qtyDelivered}
                        {/if}
                        {#if i.qtyInTransit > 0}
                          <span
                            class="block text-xs text-violet-700"
                            title={`On committed transit notes, not yet arrived` +
                              (i.transitFreightMinor > 0
                                ? ` · ${formatMoney(i.transitFreightMinor)} freight banked`
                                : "")}
                          >
                            {i.qtyInTransit} in transit
                          </span>
                        {/if}
                      </td>
                      <td class="px-4 py-2 text-right tabular-nums">
                        {#if cellEdit?.id === i.id && cellEdit.field === "cost"}
                          <MoneyInput
                            autofocus
                            bind:value={cellMoney}
                            onkeydown={cellKeydown}
                            onblur={commitCell}
                            class="ml-auto h-7 w-28 px-2 text-right tabular-nums"
                          />
                        {:else if editable}
                          <button
                            type="button"
                            class="-mx-1 rounded px-1 hover:bg-accent"
                            title="Edit unit cost (minor units)"
                            onclick={() => startCellEdit(i, "cost")}
                            >{formatMoney(i.unitCostMinor)}</button
                          >
                        {:else}
                          {formatMoney(i.unitCostMinor)}
                        {/if}
                      </td>
                      <td class="px-4 py-2 text-right tabular-nums">{formatMoney(lineTotal(i))}</td>
                      <td class="px-3 py-2 text-right whitespace-nowrap">
                        <span class="inline-flex items-center gap-0.5">
                          <IconButton
                            icon={ArrowUp}
                            label="Move line up"
                            disabled={busy || !canReorder || idx === 0}
                            onclick={(e) => moveLine(g, idx, -1, e.currentTarget)}
                          />
                          <IconButton
                            icon={ArrowDown}
                            label="Move line down"
                            disabled={busy ||
                              !canReorder ||
                              idx === g.visibleItems.length - 1}
                            onclick={(e) => moveLine(g, idx, 1, e.currentTarget)}
                          />
                          <IconButton
                            icon={Pencil}
                            label="Edit line"
                            variant="primary"
                            disabled={busy || !editable}
                            onclick={() => editItem(i)}
                          />
                          <IconButton
                            icon={Trash2}
                            label="Delete line"
                            variant="destructive"
                            disabled={busy || !editable}
                            onclick={() => deleteItem(i.id)}
                          />
                        </span>
                      </td>
                    </tr>
                  {/each}
                </tbody>
              </table>
            {:else}
              <p class="px-3 py-3 text-xs text-muted-foreground">
                No lines in this section.
              </p>
            {/if}
            {#if itemDraft && draftGroupKey === g.key}
              <div class="border-t p-3">{@render lineForm()}</div>
            {:else if editable && !queryTokens.length}
              <div class="border-t px-3 py-2">
                <button
                  class="text-xs text-primary hover:underline disabled:cursor-not-allowed disabled:opacity-40"
                  disabled={busy}
                  onclick={() => newItemInSection(g.key)}
                  >+ Add line to {g.name}</button
                >
              </div>
            {/if}
          {/if}
        </div>
      {/each}

      <!-- Fallback: the editor's target group isn't currently rendered (e.g. a
           filtered-out section, or an empty Ungrouped bucket). -->
      {#if itemDraft && !visibleGroups.some((g) => g.key === draftGroupKey)}
        {@render lineForm()}
      {/if}

    </section>

    <!-- Sends -->
    <section class="space-y-3 rounded-lg border bg-card p-5">
      <div class="flex items-center justify-between">
        <h2 class="text-sm font-semibold">Send log ({sends.length})</h2>
        <Button
          variant="outline"
          size="sm"
          disabled={busy || !canSend || purchase.status === "cancelled"}
          onclick={startCompose}>Compose send</Button
        >
      </div>

      {#if sends.length}
        <table class="w-full text-sm">
          <thead class="border-b text-left text-muted-foreground">
            <tr>
              <th class="px-4 py-2 font-medium">Channel</th>
              <th class="px-4 py-2 font-medium">Recipient</th>
              <th class="px-4 py-2 text-right font-medium">Rev</th>
              <th class="px-4 py-2 font-medium">Status</th>
              <th class="px-4 py-2 font-medium">Expected</th>
              <th class="px-3"></th>
            </tr>
          </thead>
          <tbody>
            {#each sends as s (s.id)}
              <tr class="border-b last:border-0 even:bg-muted/40">
                <td class="px-4 py-2">{s.channel}</td>
                <td class="px-4 py-2">{s.recipient}</td>
                <td class="px-4 py-2 text-right tabular-nums">{s.revision}</td>
                <td class="px-4 py-2">
                  <Badge
                    class={s.status === "sent"
                      ? "bg-emerald-100 text-emerald-700"
                      : "bg-sky-100 text-sky-700"}
                  >
                    {s.status}
                  </Badge>
                </td>
                <td class="px-4 py-2">{fmtDate(s.expectedDeliveryDate)}</td>
                <td class="px-3 py-2 text-right">
                  {#if s.status === "prepared" && canSend}
                    <IconButton
                      icon={Check}
                      label="Confirm sent"
                      variant="primary"
                      disabled={busy}
                      onclick={() => confirmSend(s.id)}
                    />
                  {/if}
                </td>
              </tr>
            {/each}
          </tbody>
        </table>
      {:else}
        <p class="text-sm text-muted-foreground">Not sent to the vendor yet.</p>
      {/if}

      {#if composer}
        <div class="space-y-3 rounded-md border bg-background p-4">
          <h3 class="text-sm font-semibold">Compose send</h3>
          <div class="grid grid-cols-2 gap-3">
            <label class="space-y-1">
              <span class="text-xs font-medium">Channel</span>
              <Select bind:value={composer.channel} onchange={preview}>
                {#each CHANNELS as c (c)}<option value={c}>{c}</option>{/each}
              </Select>
            </label>
            <label class="space-y-1">
              <span class="text-xs font-medium">
                Recipient override
                <span class="text-muted-foreground">(optional)</span>
              </span>
              <Input
                bind:value={composer.recipientOverride}
                placeholder={composer.channel === "email"
                  ? "Vendor email"
                  : "Vendor phone"}
                onblur={preview}
              />
            </label>
          </div>

          {#if composer.channel === "whatsapp"}
            <label class="space-y-1">
              <span class="text-xs font-medium">Format</span>
              <Select bind:value={composer.format}>
                <option value="text">Message text</option>
                <option value="pdf">PDF attachment</option>
              </Select>
            </label>
          {/if}

          {#if previewing}
            <p class="text-sm text-muted-foreground">Rendering preview…</p>
          {:else if draft}
            <div class="space-y-2">
              {#if composer.channel !== "manual"}
                {@const pdfMode =
                  composer.channel === "whatsapp" && composer.format === "pdf"}
                <p class="text-xs">
                  <span class="font-medium">Recipient:</span>
                  {draft.recipient ?? "—"}
                  {#if pdfMode}
                    <span class="text-muted-foreground"
                      >— you'll pick the contact in the share sheet</span
                    >
                  {:else if !draft.recipientAvailable}
                    <Badge class="ml-1 bg-amber-100 text-amber-800">
                      {draft.recipient
                        ? "unusable for this channel"
                        : "none on file — add an override"}
                    </Badge>
                  {/if}
                </p>
              {/if}
              {#if composer.channel === "email"}
                <p class="text-xs">
                  <span class="font-medium">Subject:</span>
                  {draft.subject}
                </p>
              {/if}
              <Textarea
                value={draft.body}
                readonly
                class="h-56 resize-none font-mono text-xs"
              />
            </div>

            <div class="flex flex-wrap items-center gap-2">
              {#if composer.channel === "manual"}
                <span class="text-xs text-muted-foreground">
                  Manual send — copy the message above and send it off-system.
                </span>
              {:else if composer.channel === "whatsapp" && composer.format === "pdf"}
                <Button size="sm" disabled={busy || sharing} onclick={sharePdf}>
                  {sharing ? "Preparing PDF…" : "Send PDF to WhatsApp"}
                </Button>
                <span class="text-xs text-muted-foreground">
                  Attaches the PO PDF with a short caption — pick the vendor in
                  the share sheet.
                </span>
              {:else if draft.deepLink}
                <a
                  href={draft.deepLink}
                  target="_blank"
                  rel="noopener noreferrer"
                  class="inline-flex h-9 items-center rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground hover:bg-primary/90"
                >
                  Open in {composer.channel === "whatsapp"
                    ? "WhatsApp"
                    : "email"}
                </a>
              {:else}
                <span class="text-xs text-muted-foreground">
                  Add a usable recipient to enable the
                  {composer.channel} link.
                </span>
              {/if}
              <a
                href={pdfHref}
                target="_blank"
                rel="noopener noreferrer"
                class="inline-flex h-9 items-center rounded-md border px-4 text-sm font-medium hover:bg-accent"
              >
                Download PDF
              </a>
              <label class="flex items-center gap-1.5 text-xs text-muted-foreground">
                <input type="checkbox" bind:checked={pdfShowPrices} />
                Show prices on PDF
              </label>
            </div>
          {/if}

          <label class="space-y-1">
            <span class="text-xs font-medium">Send note (optional)</span>
            <Input bind:value={composer.note} placeholder="Logged with the send" />
          </label>
          <p class="text-xs text-muted-foreground">
            Opening the link doesn't log anything. Record the send once it's
            actually away — whatsapp / email log as <em>prepared</em> (confirm
            later); manual logs as sent at once.
          </p>
          <div class="flex justify-end gap-2">
            <Button
              variant="ghost"
              size="sm"
              disabled={busy}
              onclick={() => (composer = null)}>Cancel</Button
            >
            <Button
              size="sm"
              disabled={busy || previewing || !logRecipient}
              onclick={logSend}>Record this send</Button
            >
          </div>
        </div>
      {/if}
    </section>

    {#if bulkOpen}
      <!-- Bulk-add modal: a centered overlay with two tabs. Backdrop click /
           Esc closes (Esc handled by the window listener above). Both tabs end
           in a single batch insert + refetch. -->
      <div
        class="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
        role="presentation"
        onclick={(e) => e.target === e.currentTarget && closeBulk()}
      >
        <div
          class="flex max-h-[85vh] w-full max-w-3xl flex-col rounded-lg border bg-card shadow-xl"
          role="dialog"
          aria-modal="true"
          aria-label="Add multiple lines"
        >
          <div class="flex items-center justify-between gap-3 border-b px-5 py-3">
            <h2 class="text-sm font-semibold">Add multiple lines</h2>
            <IconButton icon={X} label="Close" variant="muted" onclick={closeBulk} />
          </div>

          <div class="flex gap-1 border-b px-5">
            <button class={tabClass("reorder")} onclick={() => (bulkTab = "reorder")}>
              Reorder suggestions
            </button>
            <button class={tabClass("stock")} onclick={() => (bulkTab = "stock")}>
              By stock
            </button>
          </div>

          <div class="flex-1 overflow-auto px-5 py-4">
            {#if bulkTab === "reorder"}
              <div class="mb-3 flex items-center justify-between gap-3">
                <p class="text-xs text-muted-foreground">
                  Open suggestions{purchase?.vendorId && !reorderAllVendors
                    ? " for this vendor"
                    : ""}. Adding marks them converted.
                </p>
                {#if purchase?.vendorId}
                  <label class="flex items-center gap-2 text-xs">
                    <input type="checkbox" bind:checked={reorderAllVendors} />
                    Show all vendors
                  </label>
                {/if}
              </div>

              {#if $ReorderSuggestionsQuery.fetching && suggestions.length === 0}
                <p class="py-8 text-center text-sm text-muted-foreground">Loading…</p>
              {:else if reorderRows.length === 0}
                <p class="py-8 text-center text-sm text-muted-foreground">
                  No open suggestions{purchase?.vendorId && !reorderAllVendors
                    ? " for this vendor"
                    : ""}. Run a scan on the Reorder screen to generate them.
                </p>
              {:else}
                <table class="w-full text-sm">
                  <thead
                    class="border-b text-left text-xs text-muted-foreground"
                  >
                    <tr>
                      <th class="w-8 py-2"></th>
                      <th class="py-2 font-medium">Product</th>
                      <th class="py-2 text-right font-medium">Stock</th>
                      <th class="py-2 text-right font-medium">Point</th>
                      <th class="py-2 font-medium">Vendor</th>
                      <th class="py-2 font-medium">Order qty</th>
                    </tr>
                  </thead>
                  <tbody>
                    {#each reorderRows as s (s.id)}
                      {#if reorderPicks[s.id]}
                        <tr class="border-b last:border-0 hover:bg-muted/40">
                          <td class="py-2">
                            <input
                              type="checkbox"
                              bind:checked={reorderPicks[s.id].selected}
                            />
                          </td>
                          <td class="py-2">
                            <span class="font-medium">{s.productName}</span>
                            <span
                              class="ml-1 font-mono text-xs text-muted-foreground"
                              >{s.sku}</span
                            >
                          </td>
                          <td class="py-2 text-right">{s.currentStock}</td>
                          <td class="py-2 text-right">{s.reorderPoint}</td>
                          <td class="py-2 text-xs text-muted-foreground">
                            {s.vendorName ?? "—"}
                          </td>
                          <td class="py-2">
                            <Input
                              type="number"
                              class="w-24"
                              bind:value={reorderPicks[s.id].qty}
                            />
                          </td>
                        </tr>
                      {/if}
                    {/each}
                  </tbody>
                </table>
              {/if}
            {:else}
              <div class="mb-3">
                <Input
                  type="search"
                  placeholder="Filter by product name…"
                  bind:value={stockSearch}
                />
              </div>
              {#if stockVisible.length === 0}
                <p class="py-8 text-center text-sm text-muted-foreground">
                  No variants match.
                </p>
              {:else}
                <table class="w-full text-sm">
                  <thead
                    class="border-b text-left text-xs text-muted-foreground"
                  >
                    <tr>
                      <th class="w-8 py-2"></th>
                      <th class="py-2 font-medium">Product</th>
                      <th class="py-2 text-right font-medium">Stock</th>
                      <th class="py-2 font-medium">Order qty</th>
                      <th class="py-2 font-medium">Unit cost (Rp)</th>
                    </tr>
                  </thead>
                  <tbody>
                    {#each stockVisible as r (r.variantId)}
                      {#if stockPicks[r.variantId]}
                        <tr class="border-b last:border-0 hover:bg-muted/40">
                          <td class="py-2">
                            <input
                              type="checkbox"
                              bind:checked={stockPicks[r.variantId].selected}
                            />
                          </td>
                          <td class="py-2 font-medium">{r.label}</td>
                          <td class="py-2 text-right">{r.totalQty}</td>
                          <td class="py-2">
                            <Input
                              type="number"
                              class="w-24"
                              bind:value={stockPicks[r.variantId].qty}
                            />
                          </td>
                          <td class="py-2">
                            <div class="w-32">
                              <MoneyInput
                                bind:value={stockPicks[r.variantId].unitCostMinor}
                              />
                            </div>
                          </td>
                        </tr>
                      {/if}
                    {/each}
                  </tbody>
                </table>
                {#if stockTruncated}
                  <p class="pt-3 text-center text-xs text-muted-foreground">
                    Showing the {STOCK_CAP} lowest-stock matches — refine the
                    filter to see more.
                  </p>
                {/if}
              {/if}
            {/if}
          </div>

          <div class="flex items-center justify-between gap-3 border-t px-5 py-3">
            <p class="text-sm text-muted-foreground">
              {bulkTab === "reorder" ? reorderSelectedCount : stockSelectedCount} selected
            </p>
            <div class="flex items-center gap-2">
              <Button variant="ghost" size="sm" disabled={busy} onclick={closeBulk}>
                Cancel
              </Button>
              {#if bulkTab === "reorder"}
                <Button
                  size="sm"
                  disabled={busy || !editable || reorderSelectedCount === 0}
                  onclick={addReorderSelected}
                >
                  Add {reorderSelectedCount} line{reorderSelectedCount === 1 ? "" : "s"}
                </Button>
              {:else}
                <Button
                  size="sm"
                  disabled={busy || !editable || stockSelectedCount === 0}
                  onclick={addStockSelected}
                >
                  Add {stockSelectedCount} line{stockSelectedCount === 1 ? "" : "s"}
                </Button>
              {/if}
            </div>
          </div>
        </div>
      </div>
    {/if}

    {#if resourceOpen}
      <!-- Re-source modal: move the selected lines onto a new PO for a different
           vendor, swapping each to that vendor's own variant. Backdrop / Esc
           closes (Esc via the window listener above). -->
      <div
        class="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
        role="presentation"
        onclick={(e) => e.target === e.currentTarget && closeResource()}
      >
        <div
          class="flex max-h-[85vh] w-full max-w-3xl flex-col rounded-lg border bg-card shadow-xl"
          role="dialog"
          aria-modal="true"
          aria-label="Re-source lines to another vendor"
        >
          <div class="flex items-center justify-between gap-3 border-b px-5 py-3">
            <h2 class="text-sm font-semibold">Re-source to another vendor</h2>
            <IconButton icon={X} label="Close" variant="muted" onclick={closeResource} />
          </div>

          <div class="flex-1 space-y-4 overflow-auto px-5 py-4">
            <p class="text-xs text-muted-foreground">
              Moves these lines onto another open PO and trims them off this one —
              add them to a pending PO you've already started, or spin up a new one.
              Pick the destination vendor's own product for each line; cost defaults
              to what they last charged.
            </p>

            <div class="flex gap-1 border-b">
              <button
                type="button"
                class={resourceTabClass("existing")}
                onclick={() => (resourceMode = "existing")}
              >
                Add to existing PO
              </button>
              <button
                type="button"
                class={resourceTabClass("new")}
                onclick={() => (resourceMode = "new")}
              >
                Create new PO
              </button>
            </div>

            {#if resourceMode === "existing"}
              <label class="block space-y-1">
                <span class="text-sm font-medium">Add to open PO</span>
                <div class="max-w-md">
                  <Combobox
                    options={resourceTargetOptions}
                    bind:value={resourceTargetPurchaseId}
                    placeholder="Search open purchases…"
                  />
                </div>
                {#if resourceTargetOptions.length === 0}
                  <span class="block text-xs text-muted-foreground">
                    No other open POs — switch to “Create new PO”.
                  </span>
                {/if}
              </label>
            {:else}
              <label class="block space-y-1">
                <span class="text-sm font-medium">New PO for vendor</span>
                <div class="max-w-sm">
                  <Combobox
                    options={vendors.map((v) => ({ value: v.id, label: v.name }))}
                    bind:value={resourceVendorId}
                    placeholder="Search vendor…"
                  />
                </div>
              </label>
            {/if}

            <table class="w-full text-sm">
              <thead class="border-b text-left text-xs text-muted-foreground">
                <tr>
                  <th class="py-2 font-medium">From line</th>
                  <th class="py-2 font-medium">Replacement</th>
                  <th class="py-2 font-medium">Qty</th>
                  <th class="py-2 font-medium">Unit cost (Rp)</th>
                </tr>
              </thead>
              <tbody>
                {#each resourceRows as r, idx (r.sourceItemId)}
                  <tr class="border-b align-top last:border-0">
                    <td class="py-2 pr-3">
                      <span class="font-medium">{r.sourceLabel}</span>
                      <span class="block text-xs text-muted-foreground">
                        of {r.remaining} ordered
                      </span>
                    </td>
                    <td class="py-2 pr-3">
                      {#if r.sourceIsStock}
                        <div class="w-56">
                          <Combobox
                            options={variantOptions}
                            bind:value={resourceRows[idx].variantId}
                            placeholder="Search product…"
                          />
                        </div>
                      {:else}
                        <div class="w-56">
                          <Input
                            bind:value={resourceRows[idx].description}
                            placeholder="Line description"
                          />
                        </div>
                      {/if}
                    </td>
                    <td class="py-2 pr-3">
                      <Input
                        type="number"
                        class="w-20"
                        bind:value={resourceRows[idx].qty}
                      />
                    </td>
                    <td class="py-2">
                      <div class="w-32">
                        <MoneyInput bind:value={resourceRows[idx].unitCostMinor} />
                      </div>
                      {#if resourceRows[idx].unitCostMinor == null && resourceDestVendorId}
                        <span class="mt-1 block text-xs text-muted-foreground">
                          → {formatMoney(resourceRowCost(resourceRows[idx]))}
                        </span>
                      {/if}
                    </td>
                  </tr>
                {/each}
              </tbody>
            </table>
          </div>

          <div class="flex items-center justify-between gap-3 border-t px-5 py-3">
            <p class="text-sm text-muted-foreground">
              {resourceRows.length} line{resourceRows.length === 1 ? "" : "s"}
            </p>
            <div class="flex items-center gap-2">
              <Button variant="ghost" size="sm" disabled={busy} onclick={closeResource}>
                Cancel
              </Button>
              <Button
                size="sm"
                disabled={busy ||
                  (resourceMode === "existing" ? !resourceTargetPurchaseId : !resourceVendorId)}
                onclick={submitResource}
              >
                Re-source {resourceRows.length} line{resourceRows.length === 1 ? "" : "s"}
              </Button>
            </div>
          </div>
        </div>
      </div>
    {/if}
  {/if}
</div>
