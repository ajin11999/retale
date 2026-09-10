<script lang="ts">
  import NumericInput from "$lib/components/ui/numeric-input.svelte";
  import { tick } from "svelte";
  import { fly } from "svelte/transition";
  import { graphql } from "$houdini";
  import { goto } from "$app/navigation";
  import { page } from "$app/state";
  import type { Viewer } from "../../+layout.server";
  import { formatMoney, matchesTokens, searchTokens } from "$lib/utils";
  import { t } from "$lib/i18n";
  import { refetchOnVisible } from "$lib/refetch-on-visible.svelte";
  import { dndzone, type DndEvent } from "svelte-dnd-action";
  import { flip } from "svelte/animate";
  import {
    AlertTriangle,
    ArrowDown,
    ArrowUp,
    Check,
    ChevronDown,
    ChevronRight,
    Pencil,
    Trash2,
    X,
    GripVertical
  } from "@lucide/svelte";
  import Badge from "$lib/components/ui/badge.svelte";
  import Button from "$lib/components/ui/button.svelte";
  import Combobox from "$lib/components/ui/combobox.svelte";
  import IconButton from "$lib/components/ui/icon-button.svelte";
  import DiscountModal from "./discount-modal.svelte";
  import Input from "$lib/components/ui/input.svelte";
  import MoneyInput from "$lib/components/ui/money-input.svelte";
  import Select from "$lib/components/ui/select.svelte";
  import Textarea from "$lib/components/ui/textarea.svelte";
  import type { PageData } from "./$types";
  import PullRequisitionModal from "./pull-requisition-modal.svelte";
  import MarkPaidModal from "./mark-paid-modal.svelte";

  let showDiscountModal = $state(false);

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
        paidAt
        paidAmountMinor
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
          baseCostMinor
          discount
          taxPct
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
  // excludePurchaseId keeps this PO's own lines from shadowing prior history,
  // so the price-change indicator compares against earlier POs.
  const VendorLastCostsQuery = graphql(`
    query PurchaseVendorLastCosts($vendorId: ID!, $excludePurchaseId: ID) {
      vendorLastCosts(vendorId: $vendorId, excludePurchaseId: $excludePurchaseId) {
        variantId
        unitCostMinor
      }
    }
  `);

  // Append the checked suggestions to this PO and flip them to converted.


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
      $baseCostMinor: Float
    ) {
      updatePurchaseItem(
        id: $id
        sectionId: $sectionId
        variantId: $variantId
        description: $description
        qtyOrdered: $qtyOrdered
        unitCostMinor: $unitCostMinor
        baseCostMinor: $baseCostMinor
      ) {
        # Select the mutated scalars so Houdini normalizes them straight into
        # the cache — inline cell edits then update instantly, no refetch wait.
        id
        sectionId
        variantId
        description
        qtyOrdered
        baseCostMinor
        discount
        taxPct
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
          baseCostMinor
          discount
          taxPct
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
    { value: "", label: t("purchases.adHocVendor") },
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
    id ? (variantOptions.find((v) => v.value === id)?.label ?? t("products.unknown")) : null;

  // ---- Unit-cost prefill ----------------------------------------------------
  // New lines prefill with what this vendor last charged for the variant; the
  // variant's current cost is only a fallback (landed costs inflate it past
  // the vendor's actual price). Ad-hoc purchases (no vendor) have no history,
  // so they prefill straight from current cost.
  $effect(() => {
    const vendorId = purchase?.vendorId;
    if (vendorId) {
      VendorLastCostsQuery.fetch({
        variables: { vendorId, excludePurchaseId: purchase?.id ?? null },
      });
    }
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

  // ---- Price-change indicator ----------------------------------------------
  // Compare each stock line's unit cost against what this vendor last charged
  // for the same variant on an earlier PO. Returns null when there is nothing
  // to compare (non-stock line, no history, or unchanged price).
  interface PriceDelta {
    dir: "up" | "down";
    deltaMinor: number;
    pct: number;
    lastMinor: number;
  }
  const priceDelta = (
    variantId: string | null | undefined,
    unitCostMinor: number,
  ): PriceDelta | null => {
    if (!variantId || !purchase?.vendorId) return null;
    const last = lastCostByVariant.get(variantId);
    if (last == null || last === unitCostMinor) return null;
    const deltaMinor = unitCostMinor - last;
    const pct = last !== 0 ? (deltaMinor / last) * 100 : 0;
    return { dir: deltaMinor > 0 ? "up" : "down", deltaMinor, pct, lastMinor: last };
  };
  const formatPct = (pct: number) =>
    `${pct > 0 ? "+" : ""}${pct.toLocaleString("en-US", { maximumFractionDigits: 1 })}%`;

  // ---- Viewer permissions --------------------------------------------------
  const viewer = $derived(page.data.user as Viewer | undefined);
  const has = (key: string) => !!viewer && viewer.permissions.includes(key);
  const canEdit = $derived(has("purchase.edit"));
  const canCancel = $derived(has("purchase.cancel"));
  const canCreate = $derived(has("purchase.create"));
  const canSend = $derived(has("purchase.send"));
  const canRecordPayment = $derived(has("vendor.record_payment"));
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
      feedback = { ok: true, text: label };
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
    dndSectionOrder = null;
    dndItemOrders = {};
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
    await run(t("purchaseDetail.savedPurchase"), () =>
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
    if (!purchase || !confirm(t("purchaseDetail.confirmCancel")))
      return;
    const ok = await run(t("purchaseDetail.savedPurchase"), () =>
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

  // ---- Prepaid (pay-before-send) -------------------------------------------
  // The mark-paid modal posts the vendor prepayment and stamps paidAt; the
  // delivery-time AP charge nets against it. Refetch so the Paid badge, the
  // (possibly newly attached) vendor header, and the ledger-backed totals
  // all reflect the result.
  let markPaidOpen = $state(false);
  const showMarkPaid = $derived(
    !!purchase &&
      purchase.status === "open" &&
      !purchase.paidAt &&
      editable &&
      canRecordPayment,
  );
  async function afterMarkPaid() {
    await refetch();
    // A newly attached vendor changes prefill history — re-pull last costs.
    const vendorId = purchase?.vendorId;
    if (vendorId) {
      VendorLastCostsQuery.fetch({
        variables: { vendorId, excludePurchaseId: purchase?.id ?? null },
      });
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
    const ok = await run(t("purchaseDetail.savedSection"), () =>
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
    const ok = await run(t("purchaseDetail.savedSection"), () => UpdateSection.mutate({ id, name }));
    if (ok) {
      editingSectionId = null;
      await refetch();
    }
  }

  async function deleteSection(id: string) {
    if (!confirm(t("purchaseDetail.confirmDeleteSection"))) return;
    const ok = await run(t("purchaseDetail.savedSection"), () => DeleteSection.mutate({ id }));
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

  const duplicateExistingLine = $derived.by(() => {
    if (!itemDraft || !itemDraft.variantId || !purchase) return null;
    return purchase.items.find(
      (i) => i.variantId === itemDraft!.variantId && i.id !== itemDraft!.id
    );
  });

  function ensureExpanded(key: string) {
    if (collapsed.has(key)) {
      const next = new Set(collapsed);
      next.delete(key);
      collapsed = next;
    }
  }

  // Move focus to a line-form field once it has rendered. Lets opening a new
  // line land the cursor in Variant, and picking a variant jump to Qty.
  async function focusLineField(id: "line-variant" | "line-qty") {
    await tick();
    const el = document.getElementById(id) as HTMLInputElement | null;
    el?.focus();
    el?.select?.();
    el?.scrollIntoView?.({ behavior: "smooth", block: "center" });
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
    ensureExpanded(UNGROUPED);
    if (lineSearch) lineSearch = "";
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
    ensureExpanded(draftGroupKey);
    focusLineField("line-variant");
  }

  async function saveItem() {
    const d = itemDraft;
    if (!d || !purchase) return;
    // A line is either a stock variant or a free-text non-stock line.
    if (!d.variantId && !d.description.trim()) {
      feedback = { ok: false, text: t("purchaseDetail.errorPickVariant") };
      return;
    }
    const isNew = !d.id;
    const existingItem = d.id ? items.find((x) => x.id === d.id) : null;
    const ok = await run(t("purchaseDetail.savedItem"), () =>
      d.id
        ? UpdateItem.mutate({
            id: d.id,
            sectionId: d.sectionId || null,
            variantId: d.variantId || null,
            description: d.description.trim() || null,
            qtyOrdered: d.qtyOrdered,
            unitCostMinor: d.unitCostMinor,
            ...(!existingItem?.discount && !existingItem?.taxPct
              ? { baseCostMinor: d.unitCostMinor }
              : {}),
          })
        : CreateItem.mutate({
            purchaseId: purchase.id,
            sectionId: d.sectionId || null,
            variantId: d.variantId || null,
            description: d.description.trim() || null,
            qtyOrdered: d.qtyOrdered,
            unitCostMinor: d.unitCostMinor ?? 0,
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
        feedback = { ok: true, text: t("purchaseDetail.createdProduct", { name }) };
        focusLineField("line-qty");
      }
    } catch (e) {
      feedback = { ok: false, text: e instanceof Error ? e.message : String(e) };
    } finally {
      busy = false;
    }
  }

  async function deleteItem(id: string) {
    const ok = await run(t("purchaseDetail.savedItem"), () => DeleteItem.mutate({ id }));
    if (ok) await refetch();
  }

  // ---- Bulk-add modal ------------------------------------------------------
  // Two ways to fill a PO fast: pick from the reorder scan (intent-driven, the
  // default tab), or sweep the catalog sorted by least stock (ad-hoc). Both end
  // in a single batch insert + refetch.
  let bulkOpen = $state(false);
  let pullModalOpen = $state(false);
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
    const ok = await run(t("purchaseDetail.savedLines"), () =>
      CreateItems.mutate({ purchaseId: purchase.id, lines }),
    );
    if (ok) {
      await refetch();
      closeBulk();
    }
  }

  // ---- Invoice import (offline OCR / PDF) ----------------------------------
  // Upload a vendor invoice (image or PDF); the API reads it offline (no AI, no
  // internet) and returns a preview of lines. The clerk confirms / fixes them in
  // a modal — unrecognized rows arrive blank with a notice — then they're
  // appended via the same bulk createPurchaseItems mutation as the by-stock tab.
  let invoiceFileInput = $state<HTMLInputElement | null>(null);
  let invoiceBusy = $state(false);
  let invoiceOpen = $state(false);
  let importSectionId = $state(""); // batch section for the whole import; "" = none

  interface ImportRow {
    include: boolean;
    recognized: boolean;
    variantId: string;
    description: string;
    qty: number;
    unitCostMinor: number | null;
    confidence: number;
    raw: string;
  }
  let importRows = $state<ImportRow[]>([]);
  const importIncludedCount = $derived(importRows.filter((r) => r.include).length);
  const importSectionOptions = $derived([
    { value: "", label: t("purchaseDetail.noSection") },
    ...sections.map((s) => ({ value: s.id, label: s.name })),
  ]);

  const openInvoicePicker = () => invoiceFileInput?.click();
  const closeInvoice = () => (invoiceOpen = false);

  async function onInvoiceFile(e: Event) {
    const input = e.currentTarget as HTMLInputElement;
    const file = input.files?.[0];
    input.value = ""; // let the same file be re-picked later
    if (!file || !purchase) return;
    invoiceBusy = true;
    feedback = null;
    try {
      const fd = new FormData();
      fd.append("file", file, file.name);
      const res = await fetch(`/purchases/${purchase.id}/recognize-invoice`, {
        method: "POST",
        body: fd,
      });
      if (!res.ok) {
        let msg = t("purchaseDetail.errorRecognitionFailed", { status: res.status });
        try {
          msg = ((await res.json()) as { message?: string }).message ?? msg;
        } catch {
          // non-JSON error body — keep the generic message
        }
        feedback = { ok: false, text: msg };
        return;
      }
      const { lines } = (await res.json()) as {
        lines: Array<{
          recognized: boolean;
          description: string;
          variantId: string | null;
          qty: number | null;
          unitCostMinor: number | null;
          confidence: number;
          raw: string;
        }>;
      };
      if (!lines.length) {
        feedback = { ok: false, text: t("purchaseDetail.errorNoLinesRead") };
        return;
      }
      importRows = lines.map((l) => ({
        include: true,
        recognized: l.recognized,
        variantId: l.variantId ?? "",
        description: l.description ?? "",
        qty: l.qty ?? 1,
        unitCostMinor: l.unitCostMinor,
        confidence: l.confidence,
        raw: l.raw,
      }));
      importSectionId = "";
      invoiceOpen = true;
    } catch (e) {
      feedback = { ok: false, text: e instanceof Error ? e.message : String(e) };
    } finally {
      invoiceBusy = false;
    }
  }

  // Quick-create a product from a modal row's variant combobox; returns the new
  // variant id (mirrors createProductForLine, but row-scoped).
  async function createProductForImport(name: string): Promise<string | null> {
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
        return null;
      }
      const variantId = res.data?.createProduct.variants[0]?.id ?? null;
      if (variantId) {
        await RefData.fetch({ policy: "NetworkOnly" });
        feedback = { ok: true, text: t("purchaseDetail.createdProduct", { name }) };
      }
      return variantId;
    } catch (e) {
      feedback = { ok: false, text: e instanceof Error ? e.message : String(e) };
      return null;
    } finally {
      busy = false;
    }
  }

  async function addImported() {
    if (!purchase) return;
    const chosen = importRows.filter((r) => r.include);
    if (chosen.length === 0) return;
    for (const r of chosen) {
      if (!r.variantId && !r.description.trim()) {
        feedback = { ok: false, text: t("purchaseDetail.errorLineNeedsProduct") };
        return;
      }
      const q = Number(r.qty);
      if (!Number.isFinite(q) || q < 1) {
        feedback = { ok: false, text: t("purchaseDetail.errorQtyAtLeastOne") };
        return;
      }
    }
    const lines = chosen.map((r) => ({
      sectionId: importSectionId || null,
      variantId: r.variantId || null,
      description: r.variantId ? null : r.description.trim(),
      qtyOrdered: Math.round(Number(r.qty)),
      unitCostMinor: r.unitCostMinor ?? 0,
    }));
    const ok = await run(t("purchaseDetail.savedLines"), () =>
      CreateItems.mutate({ purchaseId: purchase.id, lines }),
    );
    if (ok) {
      await refetch();
      closeInvoice();
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
      baseCostMinor?: number;
      description?: string | null;
    } = { id: c.id };

    if (c.field === "qty") {
      const n = Number(cellStr);
      if (!Number.isFinite(n) || n < 0) {
        feedback = { ok: false, text: t("purchaseDetail.errorQtyNonNegative") };
        return;
      }
      if (n < i.qtyDelivered) {
        feedback = {
          ok: false,
          text: t("purchaseDetail.errorQtyBelowDelivered", { count: i.qtyDelivered }),
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
      if (!i.discount && !i.taxPct) {
        patch.baseCostMinor = n;
      }
    } else {
      const d = cellStr.trim();
      if (!i.variantId && !d) {
        feedback = { ok: false, text: t("purchaseDetail.errorNonStockDescription") };
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

  // Split a line's display into product name / variant label / SKU so the
  // human-readable label stays in foreground text and only the machine SKU
  // is muted. The variant label format is "Name · SKU" or "Name · SKU ·
  // label". Prefer a direct catalog lookup (product names may contain "·");
  // fall back to splitting the flat label for variants missing from cache.
  const variantPartsById = $derived.by(() => {
    const m = new Map<string, { name: string; sku: string; label: string | null }>();
    for (const p of products) {
      for (const v of p.variants) {
        m.set(v.id, { name: p.name, sku: v.sku, label: v.label ?? null });
      }
    }
    return m;
  });
  const lineParts = (
    i: (typeof items)[number],
  ): { name: string; label: string | null; sku: string | null } => {
    if (!i.variantId) return { name: i.description ?? "—", label: null, sku: null };
    const hit = variantPartsById.get(i.variantId);
    if (hit) return hit;
    const full = variantLabel(i.variantId);
    if (!full) return { name: t("products.unknown"), label: null, sku: null };
    const segs = full.split(" · ");
    if (segs.length === 1) return { name: full, label: null, sku: null };
    if (segs.length === 2) return { name: segs[0], label: null, sku: segs[1] };
    return { name: segs[0], label: segs.slice(2).join(" · ") || null, sku: segs[1] };
  };

  // ---- Grouped / searchable / reorderable lines ----------------------------
  // Lines render grouped under their section (in section order), with an
  // "Ungrouped" bucket last. `items` arrives globally sorted by sortOrder, so
  // pushing in order preserves each group's internal order.
  const UNGROUPED = "__none";
  type Line = (typeof items)[number];
  interface Group {
    id: string;
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
      return { id: s.id, key: s.id, name: s.name, items: its, subtotal: its.reduce((a, i) => a + lineTotal(i), 0) };
    });
    const ung = bySection.get(UNGROUPED) ?? [];
    if (ung.length)
      out.push({ id: UNGROUPED, key: UNGROUPED, name: t("purchases.ungrouped"), items: ung, subtotal: ung.reduce((a, i) => a + lineTotal(i), 0) });
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
    doneKey: string,
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
          text: t(doneKey, { count: done }),
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
    if (!n || !confirm(t("purchaseDetail.confirmDeleteLines", { count: n })))
      return;
    await runBulk("purchaseDetail.bulkDeleted", (id) => DeleteItem.mutate({ id }));
  }

  // sectionId "" → move to no section. UpdateItem returns the changed sectionId,
  // which Houdini normalizes, so each line jumps to its new group at once.
  async function moveSelectedToSection(sectionId: string) {
    if (!selected.size) return;
    await runBulk("purchaseDetail.bulkMoved", (id) =>
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
  // Keep selection order (Set insertion order) so the modal lists lines in the
  // order they were ticked, not the PO's display order.
  function openResource() {
    const selOrder = new Map([...selected].map((id, idx) => [id, idx] as const));
    const chosen = items
      .filter((i) => selected.has(i.id) && i.qtyDelivered === 0)
      .sort((a, b) => (selOrder.get(a.id) ?? 0) - (selOrder.get(b.id) ?? 0));
    if (chosen.length === 0) {
      feedback = {
        ok: false,
        text: t("purchaseDetail.errorResourceNoDeliveries"),
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
      feedback = { ok: false, text: t("purchaseDetail.errorResourcePickPo") };
      return;
    }
    if (!useExisting && !resourceVendorId) {
      feedback = { ok: false, text: t("purchaseDetail.errorResourcePickVendor") };
      return;
    }
    for (const r of resourceRows) {
      if (r.sourceIsStock && !r.variantId) {
        feedback = { ok: false, text: t("purchaseDetail.errorResourceReplacement") };
        return;
      }
      if (!r.sourceIsStock && !r.description.trim()) {
        feedback = { ok: false, text: t("purchaseDetail.errorResourceDescription") };
        return;
      }
      if (!Number.isFinite(r.qty) || r.qty < 1 || r.qty > r.remaining) {
        feedback = { ok: false, text: t("purchaseDetail.errorResourceQty") };
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
      const destName = dest?.snapshotVendorName ?? t("purchaseDetail.theVendor");
      const where = useExisting
        ? t("purchaseDetail.resourceIntoPo", { name: destName })
        : t("purchaseDetail.resourceToNewPo", { name: destName });
      feedback = {
        ok: true,
        text: t("purchaseDetail.resourced", { count: n, where }),
        href: dest?.id ? `/purchases/${dest.id}` : undefined,
        linkText: dest?.id ? t("purchaseDetail.openIt") : undefined,
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

  // Drag and Drop
  const flipDurationMs = 200;
  let dndSectionOrder = $state.raw<any[] | null>(null);
  let dndItemOrders = $state.raw<Record<string, any[]>>({});

  function handleSectionConsider(e: CustomEvent<DndEvent>) {
    dndSectionOrder = e.detail.items;
  }

  async function handleSectionFinalize(e: CustomEvent<DndEvent>) {
    dndSectionOrder = e.detail.items;
    if (purchase) {
      const orderedIds = e.detail.items.map(x => x.id).filter(id => id !== UNGROUPED);
      await persistOrder(() => ReorderSections.mutate({ purchaseId: purchase.id, orderedIds }));
    }
  }

  function handleItemConsider(groupKey: string, e: CustomEvent<DndEvent>) {
    dndItemOrders = { ...dndItemOrders, [groupKey]: e.detail.items };
  }

  let dndTimeout: any;
  async function handleItemFinalize(groupKey: string, e: CustomEvent<DndEvent>) {
    const draggedId = e.detail.info.id;
    const currentSections = dndSectionOrder || visibleGroups;

    if (selected.has(draggedId) && selected.size > 1) {
      // 1. Gather all selected items from all sections
      const allSelectedItems: any[] = [];
      for (const g of currentSections) {
         const itemsForSec = dndItemOrders[g.key] || groups.find(x => x.key === g.key)?.items || [];
         for (const item of itemsForSec) {
            if (selected.has(item.id) && !allSelectedItems.some(i => i.id === item.id)) {
               allSelectedItems.push(item);
            }
         }
      }
      
      // 2. Remove all selected items from all sections locally
      let nextOrders = { ...dndItemOrders };
      for (const g of currentSections) {
         const currentList = nextOrders[g.key] || groups.find(x => x.key === g.key)?.items || [];
         nextOrders[g.key] = currentList.filter((i: any) => !selected.has(i.id));
      }
      
      // 3. Find the anchor to insert before
      const dropIdxInEvent = e.detail.items.findIndex(i => i.id === draggedId);
      const anchorItem = e.detail.items.slice(dropIdxInEvent + 1).find(i => !selected.has(i.id));
      
      // 4. Insert all gathered items into the target section
      const targetList = [...(nextOrders[groupKey] || groups.find(x => x.key === groupKey)?.items || [])];
      
      const cleanedTargetList = targetList.filter(i => !selected.has(i.id));
      
      const insertIdx = anchorItem ? cleanedTargetList.findIndex(i => i.id === anchorItem.id) : cleanedTargetList.length;
      
      if (insertIdx === -1) {
         cleanedTargetList.push(...allSelectedItems);
      } else {
         cleanedTargetList.splice(insertIdx, 0, ...allSelectedItems);
      }
      
      nextOrders[groupKey] = cleanedTargetList;
      dndItemOrders = nextOrders;
      
      // 5. Update DB section for moved items
      const newSecId = groupKey === "" ? null : groupKey;
      for (const item of allSelectedItems) {
         if ((item.sectionId || "") !== groupKey) {
            UpdateItem.mutate({ id: item.id, sectionId: newSecId });
            item.sectionId = newSecId;
         }
      }
    } else {
      dndItemOrders = { ...dndItemOrders, [groupKey]: e.detail.items };
      
      const movedItem = e.detail.items.find((i: any) => (i.sectionId || "") !== groupKey);
      if (movedItem) {
        const newSecId = groupKey === "" ? null : groupKey;
        UpdateItem.mutate({ id: movedItem.id, sectionId: newSecId });
        movedItem.sectionId = newSecId;
      }
    }

    clearTimeout(dndTimeout);
    dndTimeout = setTimeout(async () => {
      if (!purchase) return;
      const allItemIds: string[] = [];
      const currentSections = dndSectionOrder || visibleGroups;
      for (const g of currentSections) {
         const itemsForSec = dndItemOrders[g.key] || groups.find(x => x.key === g.key)?.items || [];
         allItemIds.push(...itemsForSec.map((x: any) => x.id));
      }
      itemOrder = allItemIds;
      await persistOrder(() => ReorderItems.mutate({ purchaseId: purchase.id, orderedIds: allItemIds }));
    }, 50);
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
    ensureExpanded(sectionId);
    if (lineSearch) lineSearch = "";
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
      if (!res.ok) throw new Error(t("purchaseDetail.pdfUnavailable", { status: res.status }));
      const blob = await res.blob();
      const file = new File([blob], `po-${purchase.id}.pdf`, {
        type: "application/pdf",
      });
      if (!navigator.canShare?.({ files: [file] })) {
        feedback = {
          ok: false,
          text: t("purchaseDetail.cantShare"),
        };
        return;
      }
      const caption = t("purchaseDetail.seeAttachedPdf", {
        subject: draft?.subject ?? t("purchaseDetail.purchaseOrder"),
      });
      await navigator.share({
        files: [file],
        title: draft?.subject ?? t("purchaseDetail.purchaseOrder"),
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
    const ok = await run(t("purchaseDetail.savedSend"), () =>
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
    const date = prompt(t("purchaseDetail.promptDeliveryDate"), "");
    if (date === null) return; // cancelled
    const ok = await run(t("purchaseDetail.savedSend"), () =>
      ConfirmSend.mutate({ id, expectedDeliveryDate: date.trim() || null }),
    );
    if (ok) await refetch();
  }

  const sends = $derived(purchase?.sends ?? []);
  const fmtDate = (iso: string | null | undefined) =>
    iso ? new Date(iso).toLocaleDateString("en-CA") : "—";

  const statusClass = (s: string) =>
    s === "open"
      ? "bg-sky-100 text-sky-700"
      : s === "complete"
        ? "bg-emerald-100 text-emerald-700"
        : "bg-muted text-muted-foreground";
</script>

<svelte:head>
  <title>
    {purchase ? purchase.snapshotVendorName : t("purchaseDetail.purchase")} · Retale Console
  </title>
</svelte:head>

<!-- Line-form keyboard shortcuts: Ctrl/Cmd+Enter saves (add several lines
     without the mouse), Esc closes. Esc inside the variant combobox closes its
     menu first — it only reaches here once the menu is already shut. -->
<svelte:window
  onkeydown={(e) => {
    // Esc closes an open modal first.
    if (invoiceOpen) {
      if (e.key === "Escape") {
        e.preventDefault();
        closeInvoice();
      }
      return;
    }
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
    >{t("purchaseDetail.backToPurchases")}</a
  >

  {#if $PurchaseDetail.fetching && !purchase}
    <p class="text-sm text-muted-foreground">{t("common.loading")}</p>
  {:else if !purchase}
    <p class="text-sm text-destructive">{t("purchaseDetail.notFound")}</p>
  {:else}
    <div class="flex items-start justify-between gap-4">
      <div>
        <h1 class="text-xl font-semibold">{purchase.snapshotVendorName}</h1>
        <p class="text-sm text-muted-foreground">
          {fmtDate(purchase.date)} · {t("purchaseDetail.revision")} {purchase.revision} ·
          {formatMoney(purchase.totalInvoiceCost)}
        </p>
      </div>
      <div class="flex items-center gap-3">
        <Badge class={statusClass(purchase.status)}>{t(`purchases.status.${purchase.status}`)}</Badge>
        {#if purchase.paidAt}
          <span
            title={t("purchaseDetail.paidBadgeTitle", { amount: formatMoney(purchase.paidAmountMinor ?? 0), date: fmtDate(purchase.paidAt) })}
          >
            <Badge class="bg-emerald-100 text-emerald-700">
              {t("purchaseDetail.paidBadge", { amount: formatMoney(purchase.paidAmountMinor ?? 0) })}
            </Badge>
          </span>
        {/if}
        {#if showMarkPaid}
          <Button
            variant="outline"
            size="sm"
            disabled={busy}
            onclick={() => (markPaidOpen = true)}>{t("purchaseDetail.markPaid")}</Button
          >
        {/if}
        {#if has("delivery.draft") && purchase.status !== "cancelled"}
          <a
            href="/purchases/{purchase.id}/receive"
            class="inline-flex h-8 items-center rounded-md border px-3 text-sm font-medium hover:bg-accent"
          >
            {t("purchaseDetail.receiveGoods")}
          </a>
        {/if}
        {#if canCreate}
          <Button
            variant="outline"
            size="sm"
            disabled={busy}
            onclick={clonePurchase}>{t("purchaseDetail.clonePO")}</Button
          >
        {/if}
        {#if canCancel && purchase.status !== "cancelled"}
          <Button
            variant="outline"
            size="sm"
            disabled={busy}
            onclick={cancelPurchase}>{t("purchaseDetail.cancelPO")}</Button
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
        {t("purchaseDetail.cancelledReadOnly")}
      </p>
    {:else if !canEdit}
      <p
        class="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800"
      >
        {t("purchaseDetail.readOnlyNotice")}
      </p>
    {/if}

    {#if purchase.hasUnsentChanges && purchase.lastSentAt}
      <p
        class="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800"
      >
        {t("purchaseDetail.unsentEditsNotice")}
      </p>
    {/if}

    <!-- Header -->
    <section class="space-y-4 rounded-lg border bg-card p-5">
      <h2 class="text-sm font-semibold">{t("purchaseDetail.details")}</h2>
      <div class="grid grid-cols-2 gap-4">
        <label class="space-y-1">
          <span class="text-sm font-medium">{t("common.vendor")}</span>
          <Combobox
            options={vendorOptions}
            bind:value={form.vendorId}
            placeholder={t("purchases.searchVendor")}
            disabled={!editable}
          />
        </label>
        <label class="space-y-1">
          <span class="text-sm font-medium">{t("purchases.adHocVendorName")}</span>
          <Input
            bind:value={form.snapshotVendorName}
            disabled={!editable || form.vendorId !== ""}
          />
        </label>
        <label class="space-y-1">
          <span class="text-sm font-medium">{t("common.date")}</span>
          <Input type="date" bind:value={form.date} disabled={!editable} />
        </label>
        <label class="space-y-1">
          <span class="text-sm font-medium">{t("purchaseDetail.sendByDate")}</span>
          <Input
            type="date"
            bind:value={form.sendDueDate}
            disabled={!editable}
          />
        </label>
        <label class="space-y-1">
          <span class="text-sm font-medium">{t("purchaseDetail.sourceDocument")}</span>
          <Input
            bind:value={form.sourceDocument}
            placeholder={t("purchases.vendorRef")}
            disabled={!editable}
          />
        </label>
      </div>
      <label class="space-y-1">
        <span class="text-sm font-medium">{t("purchaseDetail.memo")}</span>
        <Textarea
          bind:value={form.memo}
          disabled={!editable}
          class="h-20 resize-none"
        />
      </label>
      <div class="flex justify-end pt-2">
        <Button disabled={busy || !editable} onclick={saveHeader}>
          {t("purchaseDetail.saveDetails")}
        </Button>
      </div>
    </section>

    <!-- Items -->
    <section class="space-y-3 rounded-lg border bg-card p-5">
      <div class="flex items-center justify-between gap-3">
        <h2 class="text-sm font-semibold">{t("purchaseDetail.linesCount", { count: items.length })}</h2>
        <div class="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            disabled={busy || !editable}
            onclick={() => (newSectionName = "")}>{t("purchases.addSection")}</Button
          >
          <Button
            variant="outline"
            size="sm"
            disabled={busy || invoiceBusy || !editable}
            onclick={openInvoicePicker}
            >{invoiceBusy ? t("purchaseDetail.reading") : t("purchaseDetail.importInvoice")}</Button
          >
          <input
            bind:this={invoiceFileInput}
            type="file"
            accept="image/*,application/pdf"
            class="hidden"
            onchange={onInvoiceFile}
          />
          <Button
            variant="outline"
            size="sm"
            disabled={busy || !editable}
            onclick={openBulk}>{t("purchases.addMultiple")}</Button
          >
          <Button
            variant="outline"
            size="sm"
            disabled={busy || !editable}
            onclick={() => pullModalOpen = true}>{t("purchases.pullRequisition")}</Button
          >
          <Button
            variant="outline"
            size="sm"
            disabled={busy || !editable}
            onclick={newItem}>{t("purchases.addLine")}</Button
          >
        </div>
      </div>

      {#if newSectionName !== null}
        <div class="flex gap-2">
          <Input
            bind:value={newSectionName}
            placeholder={t("purchases.newSectionName")}
            onkeydown={(e) => e.key === "Enter" && addSection()}
          />
          <Button
            size="sm"
            disabled={busy || !newSectionName.trim()}
            onclick={addSection}>{t("common.add")}</Button
          >
          <Button
            variant="ghost"
            size="sm"
            disabled={busy}
            onclick={() => (newSectionName = null)}>{t("common.cancel")}</Button
          >
        </div>
      {/if}

      {#if items.length > 0 || sections.length > 0}
        <div class="flex flex-wrap items-center gap-2">
          <div class="w-56">
            <Input
              type="search"
              placeholder={t("purchases.searchLines")}
              bind:value={lineSearch}
            />
          </div>
          <div class="w-44">
            <Select bind:value={sectionFilter}>
              <option value="">{t("purchases.allSections")}</option>
              {#each sections as s (s.id)}
                <option value={s.id}>{s.name}</option>
              {/each}
              <option value={UNGROUPED}>{t("purchases.ungrouped")}</option>
            </Select>
          </div>
          {#if filtering && editable}
            <span class="text-xs text-muted-foreground">
              {t("purchaseDetail.reorderingPaused")}
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
            {t("purchaseDetail.linesSelected", { count: selectedCount })}
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
              <option value="__bulk" disabled>{t("purchases.moveToSection")}</option>
              {#each sections as s (s.id)}
                <option value={s.id}>{s.name}</option>
              {/each}
              <option value={UNGROUPED}>{t("purchaseDetail.noSection")}</option>
            </Select>
          </div>
          {#if purchase.status === "open"}
            <Button
              variant="outline"
              size="sm"
              disabled={busy}
              onclick={openResource}>{t("purchases.reSource")}</Button
            >
            <Button
              variant="outline"
              size="sm"
              disabled={busy}
              onclick={() => showDiscountModal = true}
            >
              {t("purchaseDiscount.title")}
            </Button>
          {/if}
          <Button
            variant="destructive"
            size="sm"
            disabled={busy}
            onclick={deleteSelected}>{t("purchases.deleteSelected")}</Button
          >
          <Button
            variant="ghost"
            size="sm"
            disabled={busy}
            onclick={clearSelection}>{t("common.clear")}</Button
          >
        </div>
      {/if}

      {#if items.length === 0 && sections.length === 0}
        <p class="py-6 text-center text-sm text-muted-foreground">{t("purchaseDetail.noLinesYet")}</p>
      {:else if visibleGroups.length === 0}
        <p class="py-6 text-center text-sm text-muted-foreground">
          {t("purchaseDetail.noLinesMatch")}
        </p>
      {/if}

      {#snippet lineForm()}
        {#if itemDraft}
          <div class="space-y-3 rounded-md border bg-background p-4">
            <h3 class="text-sm font-semibold">
              {itemDraft.id ? t("purchaseDetail.editLine") : t("purchaseDetail.newLine")}
            </h3>
            <div class="grid grid-cols-2 gap-3">
              <label class="space-y-1">
                <span class="text-xs font-medium">{t("purchaseDetail.variantStockLine")}</span>
                <Combobox
                  id="line-variant"
                  options={variantOptions}
                  bind:value={itemDraft.variantId}
                  placeholder={t("purchases.searchVariant")}
                  disabled={!editable}
                  onCreate={canCreateProduct && editable
                    ? createProductForLine
                    : undefined}
                  createLabel={(q) => t("purchaseDetail.createProduct", { name: q })}
                  onChange={(id) => {
                    if (itemDraft && id) itemDraft.unitCostMinor = prefillCost(id);
                    focusLineField("line-qty");
                  }}
                />
                {#if duplicateExistingLine}
                  <div class="mt-1 flex items-start gap-2 rounded border border-amber-200 bg-amber-50 p-2 text-xs text-amber-800">
                    <AlertTriangle class="size-4 shrink-0 text-amber-600" />
                    <div class="flex-1 space-y-1">
                      <p class="font-medium">{t("purchaseDetail.variantAlreadyOnOrder")}</p>
                      <button
                        type="button"
                        class="text-amber-700 underline hover:text-amber-900"
                        onclick={() => editItem(duplicateExistingLine)}
                      >
                        {t("purchaseDetail.editExistingLine")}
                      </button>
                    </div>
                  </div>
                {/if}
              </label>
              <label class="space-y-1">
                <span class="text-xs font-medium">{t("purchaseDetail.section")}</span>
                <Select bind:value={itemDraft.sectionId} disabled={!editable}>
                  <option value="">{t("purchaseDetail.noSection")}</option>
                  {#each sections as s (s.id)}
                    <option value={s.id}>{s.name}</option>
                  {/each}
                </Select>
              </label>
              <label class="space-y-1 col-span-2">
                <span class="text-xs font-medium">{t("common.description")}</span>
                <Input
                  bind:value={itemDraft.description}
                  placeholder={itemDraft.variantId
                    ? t("purchaseDetail.optionalNote")
                    : t("purchaseDetail.requiredNonStock")}
                  disabled={!editable}
                />
              </label>
              <label class="space-y-1">
                <span class="text-xs font-medium">{t("purchaseDetail.qtyOrdered")}</span>
                <NumericInput
                  id="line-qty"
                  bind:value={itemDraft.qtyOrdered}
                  disabled={!editable}
                />
              </label>
              <label class="space-y-1">
                <span class="text-xs font-medium">{t("purchaseDetail.unitCostRp")}</span>
                <MoneyInput bind:value={itemDraft.unitCostMinor} disabled={!editable} />
              </label>
            </div>
            <div class="flex items-center justify-end gap-2">
              {#if editable}
                <span class="mr-auto text-xs text-muted-foreground">
                  <kbd class="rounded border px-1 font-mono">Ctrl</kbd>+<kbd
                    class="rounded border px-1 font-mono">Enter</kbd
                  > {itemDraft.id ? t("purchaseDetail.toSave") : t("purchaseDetail.toAdd")}
                </span>
              {/if}
              <Button
                variant="ghost"
                size="sm"
                disabled={busy}
                onclick={() => (itemDraft = null)}>{t("common.cancel")}</Button
              >
              <Button size="sm" disabled={busy || !editable} onclick={saveItem}>
                {itemDraft.id ? t("purchaseDetail.saveLine") : t("purchases.addLine")}
              </Button>
            </div>
          </div>
        {/if}
      {/snippet}

      <div use:dndzone={{items: dndSectionOrder || visibleGroups, dragDisabled: busy || !editable || filtering || editingSectionId !== null || cellEdit !== null, flipDurationMs, dropTargetStyle: {}}} onconsider={handleSectionConsider} onfinalize={handleSectionFinalize} class="space-y-4">
      {#each dndSectionOrder || visibleGroups as g (g.id)}
        {@const sIdx = sections.findIndex((s) => s.id === g.key)}
        <div class="rounded-md border bg-card overflow-hidden" animate:flip={{duration: flipDurationMs}}>
          <!-- Group header -->
          <div class="flex items-center gap-2 border-b bg-muted/40 px-3 py-2">
            {#if canReorder}
              <GripVertical class="h-4 w-4 text-muted-foreground opacity-30 cursor-grab active:cursor-grabbing hover:opacity-100 transition-opacity" />
            {/if}
            <button
              class="text-muted-foreground hover:text-foreground"
              onclick={() => toggleCollapse(g.key)}
              aria-label={isOpen(g.key) ? t("purchaseDetail.collapse") : t("purchaseDetail.expand")}
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
                onclick={saveRenameSection}>{t("common.save")}</Button
              >
              <Button
                variant="ghost"
                size="sm"
                class="h-7"
                disabled={busy}
                onclick={() => (editingSectionId = null)}>{t("common.cancel")}</Button
              >
            {:else}
              <span class="text-sm font-medium">{g.name}</span>
              <span class="text-xs text-muted-foreground">
                {t("purchaseDetail.groupSummary", { count: g.items.length, amount: formatMoney(g.subtotal) })}
              </span>
            {/if}
            {#if sIdx >= 0 && editingSectionId !== g.key}
              <span class="ml-auto flex items-center gap-0.5">
                <IconButton
                  icon={Pencil}
                  label={t("purchaseDetail.renameSection")}
                  variant="primary"
                  disabled={busy || !editable}
                  onclick={() => startRenameSection(g.key, g.name)}
                />
                <IconButton
                  icon={Trash2}
                  label={t("purchaseDetail.deleteSection")}
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
                      <th class="w-8 px-2"></th>
                      <th class="w-8 px-3 py-2">
                        <input
                          type="checkbox"
                          class="size-4 cursor-pointer rounded border-input align-middle accent-primary"
                          checked={groupChecked(g)}
                          indeterminate={groupIndeterminate(g)}
                          onchange={() => toggleGroupSelect(g)}
                          aria-label={t("purchaseDetail.selectAllLinesIn", { name: g.name })}
                        />
                      </th>
                    {/if}
                    <th class="px-4 py-2 font-medium">{t("purchases.line")}</th>
                    <th class="px-4 py-2 text-right font-medium">{t("purchases.ordered")}</th>
                    <th class="px-4 py-2 text-right font-medium">{t("purchases.delivered")}</th>
                    <th class="px-4 py-2 text-right font-medium">{t("purchaseDetail.unitCost")}</th>
                    <th class="px-4 py-2 text-right font-medium">{t("purchaseDetail.lineTotal")}</th>
                    <th class="px-3"></th>
                  </tr>
                </thead>
                <tbody use:dndzone={{items: dndItemOrders[g.key] || g.visibleItems, dragDisabled: busy || !editable || filtering || cellEdit !== null, flipDurationMs, dropTargetStyle: {}}} onconsider={(e) => handleItemConsider(g.key, e)} onfinalize={(e) => handleItemFinalize(g.key, e)}>
                  {#each dndItemOrders[g.key] || g.visibleItems as i, idx (i.id)}
                    <tr animate:flip={{duration: flipDurationMs}}
                      class="border-b last:border-0 {selected.has(i.id)
                        ? 'bg-primary/10'
                        : 'even:bg-muted/40'} group/row"
                    >
                      {#if editable}
                        <td class="px-2 py-2 text-center w-8">
                          <GripVertical class="h-4 w-4 text-muted-foreground opacity-30 cursor-grab active:cursor-grabbing hover:opacity-100 transition-opacity inline-block" />
                        </td>
                      {/if}
                      {#if editable}
                        <td class="px-3 py-2">
                          <input
                            type="checkbox"
                            class="size-4 cursor-pointer rounded border-input align-middle accent-primary"
                            checked={selected.has(i.id)}
                            onchange={() => toggleSelect(i.id)}
                            aria-label={t("purchaseDetail.selectLine")}
                          />
                        </td>
                      {/if}
                      <td class="px-4 py-2">
                        {#if cellEdit?.id === i.id && cellEdit?.field === "desc"}
                          <input
                            bind:value={cellStr}
                            use:selectOnMount
                            onkeydown={cellKeydown}
                            onblur={commitCell}
                            autocomplete="off"
                            class="h-7 w-full rounded-md border border-input bg-background px-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                          />
                        {:else if editable && !i.variantId}
                          <button
                            type="button"
                            class="-mx-1 rounded px-1 text-left hover:bg-accent"
                            title={t("purchaseDetail.editDescription")}
                            onclick={() => startCellEdit(i, "desc")}
                            >{lineLabel(i)}</button
                          >
                        {:else}
                          {@const parts = lineParts(i)}
                          {parts.name}{#if parts.label}<span class="ml-1.5 font-medium text-foreground">· {parts.label}</span>{/if}{#if parts.sku}<span class="ml-1.5 font-mono text-xs text-muted-foreground">({parts.sku})</span>{/if}
                        {/if}
                      </td>
                      <td class="px-4 py-2 text-right tabular-nums">
                        {#if cellEdit?.id === i.id && cellEdit?.field === "qty"}
                          <NumericInput
                            
                            bind:value={cellStr}
                            autofocus={true}
                            onkeydown={cellKeydown}
                            onblur={commitCell}
                            class="h-7 w-20 rounded-md border border-input bg-background px-2 text-right text-sm tabular-nums focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                          />
                        {:else if editable}
                          <button
                            type="button"
                            class="-mx-1 rounded px-1 hover:bg-accent"
                            title={t("purchaseDetail.editQuantity")}
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
                            title={t("purchaseDetail.transitTitle") +
                              (i.transitFreightMinor > 0
                                ? " · " + t("purchaseDetail.freightBanked", { amount: formatMoney(i.transitFreightMinor) })
                                : "")}
                          >
                            {t("purchaseDetail.inTransit", { count: i.qtyInTransit })}
                          </span>
                        {/if}
                      </td>
                      <td class="px-4 py-2 text-right tabular-nums">
                        {#if cellEdit?.id === i.id && cellEdit?.field === "cost"}
                          <MoneyInput
                            autofocus
                            bind:value={cellMoney}
                            onkeydown={cellKeydown}
                            onblur={commitCell}
                            class="ml-auto h-7 w-28 px-2 text-right tabular-nums"
                          />
                        {:else if editable}
                          {@const delta = priceDelta(i.variantId, i.unitCostMinor)}
                          <div class="flex flex-col items-end leading-tight">
                            <button
                              type="button"
                              class="-mx-1 rounded px-1 hover:bg-accent font-medium text-sky-600"
                              title={t("purchaseDetail.editFinalUnitCost")}
                              onclick={() => startCellEdit(i, "cost")}
                              >{formatMoney(i.unitCostMinor)}</button
                            >
                            {#if delta}
                              <span
                                class="mt-0.5 inline-flex items-center gap-0.5 text-[11px] font-medium tabular-nums {delta.dir === 'up' ? 'text-red-600' : 'text-emerald-600'}"
                                title={t(delta.dir === "up" ? "purchaseDetail.priceUpTitle" : "purchaseDetail.priceDownTitle", { last: formatMoney(delta.lastMinor), delta: `${delta.deltaMinor > 0 ? "+" : "-"}${formatMoney(Math.abs(delta.deltaMinor))}`, pct: formatPct(delta.pct) })}
                              >
                                {#if delta.dir === "up"}<ArrowUp class="h-3 w-3" />{:else}<ArrowDown class="h-3 w-3" />{/if}
                                {delta.deltaMinor > 0 ? "+" : "-"}{formatMoney(Math.abs(delta.deltaMinor))} ({formatPct(delta.pct)})
                              </span>
                            {/if}
                            {#if i.discount || i.taxPct}
                              <span class="text-[10px] text-muted-foreground mt-0.5 truncate max-w-[150px]" title={t("purchaseDetail.costBreakdown", { base: formatMoney(i.baseCostMinor), discount: i.discount || t("purchaseDetail.none"), tax: i.taxPct ? i.taxPct + "%" : t("purchaseDetail.none") })}>
                                {formatMoney(i.baseCostMinor)} {i.discount ? `(-${i.discount})` : ''} {i.taxPct ? `(+${i.taxPct}%)` : ''}
                              </span>
                            {/if}
                          </div>
                        {:else}
                          {@const deltaRo = priceDelta(i.variantId, i.unitCostMinor)}
                          <div class="flex flex-col items-end leading-tight">
                            <span>{formatMoney(i.unitCostMinor)}</span>
                            {#if deltaRo}
                              <span
                                class="mt-0.5 inline-flex items-center gap-0.5 text-[11px] font-medium tabular-nums {deltaRo.dir === 'up' ? 'text-red-600' : 'text-emerald-600'}"
                                title={t(deltaRo.dir === "up" ? "purchaseDetail.priceUpTitle" : "purchaseDetail.priceDownTitle", { last: formatMoney(deltaRo.lastMinor), delta: `${deltaRo.deltaMinor > 0 ? "+" : "-"}${formatMoney(Math.abs(deltaRo.deltaMinor))}`, pct: formatPct(deltaRo.pct) })}
                              >
                                {#if deltaRo.dir === "up"}<ArrowUp class="h-3 w-3" />{:else}<ArrowDown class="h-3 w-3" />{/if}
                                {deltaRo.deltaMinor > 0 ? "+" : "-"}{formatMoney(Math.abs(deltaRo.deltaMinor))} ({formatPct(deltaRo.pct)})
                              </span>
                            {/if}
                            {#if i.discount || i.taxPct}
                              <span class="text-[10px] text-muted-foreground mt-0.5 truncate max-w-[150px]" title={t("purchaseDetail.costBreakdown", { base: formatMoney(i.baseCostMinor), discount: i.discount || t("purchaseDetail.none"), tax: i.taxPct ? i.taxPct + "%" : t("purchaseDetail.none") })}>
                                {formatMoney(i.baseCostMinor)} {i.discount ? `(-${i.discount})` : ''} {i.taxPct ? `(+${i.taxPct}%)` : ''}
                              </span>
                            {/if}
                          </div>
                        {/if}
                      </td>
                      <td class="px-4 py-2 text-right tabular-nums">{formatMoney(lineTotal(i))}</td>
                      <td class="px-3 py-2 text-right whitespace-nowrap">
                        <span class="inline-flex items-center gap-0.5 opacity-0 group-hover/row:opacity-100 transition-opacity">
                          <IconButton
                            icon={Pencil}
                            label={t("purchaseDetail.editLine")}
                            variant="primary"
                            disabled={busy || !editable}
                            onclick={() => editItem(i)}
                          />
                          <IconButton
                            icon={Trash2}
                            label={t("purchaseDetail.deleteLine")}
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
                {t("purchaseDetail.noLinesInSection")}
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
                  >{t("purchaseDetail.addLineTo", { name: g.name })}</button
                >
              </div>
            {/if}
          {/if}
        </div>
      {/each}
      </div>

      <!-- Fallback: the editor's target group isn't currently rendered (e.g. a
           filtered-out section, or an empty Ungrouped bucket). -->
      {#if itemDraft && !visibleGroups.some((g) => g.key === draftGroupKey)}
        {@render lineForm()}
      {/if}

    </section>

    <!-- Sends -->
    <section class="space-y-3 rounded-lg border bg-card p-5">
      <div class="flex items-center justify-between">
        <h2 class="text-sm font-semibold">{t("purchaseDetail.sendLog", { count: sends.length })}</h2>
        <Button
          variant="outline"
          size="sm"
          disabled={busy || !canSend || purchase.status === "cancelled"}
          onclick={startCompose}>{t("purchases.composeSend")}</Button
        >
      </div>

      {#if sends.length}
        <table class="w-full text-sm">
          <thead class="border-b text-left text-muted-foreground">
            <tr>
              <th class="px-4 py-2 font-medium">{t("purchaseDetail.channel")}</th>
              <th class="px-4 py-2 font-medium">{t("purchaseDetail.recipient")}</th>
              <th class="px-4 py-2 text-right font-medium">{t("purchaseDetail.rev")}</th>
              <th class="px-4 py-2 font-medium">{t("common.status")}</th>
              <th class="px-4 py-2 font-medium">{t("purchaseDetail.expected")}</th>
              <th class="px-3"></th>
            </tr>
          </thead>
          <tbody>
            {#each sends as s (s.id)}
              <tr class="border-b last:border-0 even:bg-muted/40">
                <td class="px-4 py-2">{t(`purchaseDetail.channel.${s.channel}`)}</td>
                <td class="px-4 py-2">{s.recipient}</td>
                <td class="px-4 py-2 text-right tabular-nums">{s.revision}</td>
                <td class="px-4 py-2">
                  <Badge
                    class={s.status === "sent"
                      ? "bg-emerald-100 text-emerald-700"
                      : "bg-sky-100 text-sky-700"}
                  >
                    {t(`purchaseDetail.sendStatus.${s.status}`)}
                  </Badge>
                </td>
                <td class="px-4 py-2">{fmtDate(s.expectedDeliveryDate)}</td>
                <td class="px-3 py-2 text-right">
                  {#if s.status === "prepared" && canSend}
                    <IconButton
                      icon={Check}
                      label={t("purchaseDetail.confirmSent")}
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
        <p class="text-sm text-muted-foreground">{t("purchaseDetail.notSentVendor")}</p>
      {/if}

      {#if composer}
        <div class="space-y-3 rounded-md border bg-background p-4">
          <h3 class="text-sm font-semibold">{t("purchases.composeSend")}</h3>
          <div class="grid grid-cols-2 gap-3">
            <label class="space-y-1">
              <span class="text-xs font-medium">{t("purchaseDetail.channel")}</span>
              <Select bind:value={composer.channel} onchange={preview}>
                {#each CHANNELS as c (c)}<option value={c}>{t(`purchaseDetail.channel.${c}`)}</option>{/each}
              </Select>
            </label>
            <label class="space-y-1">
              <span class="text-xs font-medium">
                {t("purchaseDetail.recipientOverride")}
                <span class="text-muted-foreground">{t("common.optional")}</span>
              </span>
              <Input
                bind:value={composer.recipientOverride}
                placeholder={composer.channel === "email"
                  ? t("purchaseDetail.vendorEmail")
                  : t("purchaseDetail.vendorPhone")}
                onblur={preview}
              />
            </label>
          </div>

          {#if composer.channel === "whatsapp"}
            <label class="space-y-1">
              <span class="text-xs font-medium">{t("purchaseDetail.format")}</span>
              <Select bind:value={composer.format}>
                <option value="text">{t("purchases.messageText")}</option>
                <option value="pdf">{t("purchaseDetail.pdfAttachment")}</option>
              </Select>
            </label>
          {/if}

          {#if previewing}
            <p class="text-sm text-muted-foreground">{t("purchaseDetail.renderingPreview")}</p>
          {:else if draft}
            <div class="space-y-2">
              {#if composer.channel !== "manual"}
                {@const pdfMode =
                  composer.channel === "whatsapp" && composer.format === "pdf"}
                <p class="text-xs">
                  <span class="font-medium">{t("purchaseDetail.recipientColon")}</span>
                  {draft.recipient ?? "—"}
                  {#if pdfMode}
                    <span class="text-muted-foreground"
                      >{t("purchaseDetail.pickContactShareSheet")}</span
                    >
                  {:else if !draft.recipientAvailable}
                    <Badge class="ml-1 bg-amber-100 text-amber-800">
                      {draft.recipient
                        ? t("purchaseDetail.unusableChannel")
                        : t("purchaseDetail.noneOnFile")}
                    </Badge>
                  {/if}
                </p>
              {/if}
              {#if composer.channel === "email"}
                <p class="text-xs">
                  <span class="font-medium">{t("purchaseDetail.subjectColon")}</span>
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
                  {t("purchaseDetail.manualSendHint")}
                </span>
              {:else if composer.channel === "whatsapp" && composer.format === "pdf"}
                <Button size="sm" disabled={busy || sharing} onclick={sharePdf}>
                  {sharing ? t("purchaseDetail.preparingPdf") : t("purchaseDetail.sendPdfWhatsApp")}
                </Button>
                <span class="text-xs text-muted-foreground">
                  {t("purchaseDetail.attachPdfHint")}
                </span>
              {:else if draft.deepLink}
                <a
                  href={draft.deepLink}
                  target="_blank"
                  rel="noopener noreferrer"
                  class="inline-flex h-9 items-center rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground hover:bg-primary/90"
                >
                  {t(composer.channel === "whatsapp"
                    ? "purchaseDetail.openInWhatsApp"
                    : "purchaseDetail.openInEmail")}
                </a>
              {:else}
                <span class="text-xs text-muted-foreground">
                  {t("purchaseDetail.needRecipient", { channel: composer.channel })}
                </span>
              {/if}
              <a
                href={pdfHref}
                target="_blank"
                rel="noopener noreferrer"
                class="inline-flex h-9 items-center rounded-md border px-4 text-sm font-medium hover:bg-accent"
              >
                {t("purchaseDetail.downloadPdf")}
              </a>
              <label class="flex items-center gap-1.5 text-xs text-muted-foreground">
                <input type="checkbox" bind:checked={pdfShowPrices} />
                {t("purchaseDetail.showPricesOnPdf")}
              </label>
            </div>
          {/if}

          <label class="space-y-1">
            <span class="text-xs font-medium">{t("purchaseDetail.sendNoteOptional")}</span>
            <Input bind:value={composer.note} placeholder={t("purchaseDetail.loggedWithSend")} />
          </label>
          <p class="text-xs text-muted-foreground">
            {@html t("purchaseDetail.sendLogHint")}
          </p>
          <div class="flex justify-end gap-2">
            <Button
              variant="ghost"
              size="sm"
              disabled={busy}
              onclick={() => (composer = null)}>{t("common.cancel")}</Button
            >
            <Button
              size="sm"
              disabled={busy || previewing || !logRecipient}
              onclick={logSend}>{t("purchases.recordSend")}</Button
            >
          </div>
        </div>
      {/if}
    </section>

    {#if invoiceOpen}
      <!-- Invoice import: confirm & fix the offline-recognized lines, then add
           them in one batch. Unrecognized rows start blank with a notice. -->
      <div
        class="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
        role="presentation"
        onclick={(e) => e.target === e.currentTarget && closeInvoice()}
      >
        <div
          class="flex max-h-[85vh] w-full max-w-3xl flex-col rounded-lg border bg-card shadow-xl"
          role="dialog"
          aria-modal="true"
          aria-label={t("purchaseDetail.importInvoiceLines")}
        >
          <div class="flex items-center justify-between gap-3 border-b px-5 py-3">
            <h2 class="text-sm font-semibold">{t("purchaseDetail.importInvoiceLines")}</h2>
            <IconButton icon={X} label={t("common.close")} variant="muted" onclick={closeInvoice} />
          </div>

          <div class="flex items-center gap-3 border-b px-5 py-2">
            <p class="text-xs text-muted-foreground">
              {t("purchaseDetail.importReviewHint")}
            </p>
            <label class="ml-auto flex items-center gap-2 text-xs">
              {t("purchaseDetail.section")}
              <Select bind:value={importSectionId} class="h-8 w-44">
                {#each importSectionOptions as o (o.value)}
                  <option value={o.value}>{o.label}</option>
                {/each}
              </Select>
            </label>
          </div>

          <div class="flex-1 space-y-2 overflow-auto px-5 py-4">
            {#each importRows as r, i (i)}
              <div class="rounded-md border p-3 {r.include ? '' : 'opacity-60'}">
                <div class="mb-2 flex items-center gap-2">
                  <input
                    type="checkbox"
                    bind:checked={r.include}
                    aria-label={t("purchaseDetail.includeLine", { n: i + 1 })}
                  />
                  <span class="text-xs font-medium">{t("purchaseDetail.lineNumber", { n: i + 1 })}</span>
                  {#if !r.recognized}
                    <span class="rounded bg-amber-100 px-2 py-0.5 text-xs text-amber-800">
                      {t("purchaseDetail.unrecognized")}
                    </span>
                  {/if}
                  {#if r.raw}
                    <span
                      class="ml-auto max-w-[55%] truncate text-xs text-muted-foreground"
                      title={r.raw}>{t("purchaseDetail.scanned", { raw: r.raw })}</span
                    >
                  {/if}
                </div>
                <Combobox
                  options={variantOptions}
                  bind:value={r.variantId}
                  placeholder={t("purchaseDetail.searchProductBlank")}
                  onCreate={canCreateProduct
                    ? async (q) => {
                        const id = await createProductForImport(q);
                        if (id) r.variantId = id;
                      }
                    : undefined}
                  createLabel={(q) => t("purchaseDetail.createProduct", { name: q })}
                  onChange={(id) => {
                    if (id && r.unitCostMinor == null) r.unitCostMinor = prefillCost(id);
                  }}
                />
                <div class="mt-2 flex gap-2">
                  <Input
                    bind:value={r.description}
                    placeholder={t("purchaseDetail.descriptionNonStock")}
                    class="flex-1"
                  />
                  <NumericInput min="1" bind:value={r.qty} class="w-20" aria-label={t("purchaseDetail.quantity")} />
                  <MoneyInput bind:value={r.unitCostMinor} placeholder={t("purchaseDetail.unitCost")} class="w-36" />
                </div>
              </div>
            {/each}
          </div>

          <div class="flex items-center justify-between gap-3 border-t px-5 py-3">
            <span class="text-xs text-muted-foreground">
              {t("purchaseDetail.selectedOf", { count: importIncludedCount, total: importRows.length })}
            </span>
            <div class="flex gap-2">
              <Button variant="outline" size="sm" onclick={closeInvoice}>{t("common.cancel")}</Button>
              <Button size="sm" disabled={busy || importIncludedCount === 0} onclick={addImported}>
                {t("purchaseDetail.addLines", { count: importIncludedCount })}
              </Button>
            </div>
          </div>
        </div>
      </div>
    {/if}

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
          aria-label={t("purchaseDetail.addMultipleLines")}
        >
          <div class="flex items-center justify-between gap-3 border-b px-5 py-3">
            <h2 class="text-sm font-semibold">{t("purchaseDetail.addMultipleLines")}</h2>
            <IconButton icon={X} label={t("common.close")} variant="muted" onclick={closeBulk} />
          </div>

          <div class="flex gap-1 border-b px-5">
            <button class={tabClass("reorder")} onclick={() => (bulkTab = "reorder")}>
              {t("purchaseDetail.reorderTab")}
            </button>
            <button class={tabClass("stock")} onclick={() => (bulkTab = "stock")}>
              {t("purchaseDetail.byStock")}
            </button>
          </div>

          <div class="flex-1 overflow-auto px-5 py-4">
            {#if bulkTab === "reorder"}
              <div class="mb-3 flex items-center justify-between gap-3">
                <p class="text-xs text-muted-foreground">
                  {purchase?.vendorId && !reorderAllVendors
                    ? t("purchaseDetail.openSuggestionsVendor")
                    : t("purchaseDetail.openSuggestions")}
                </p>
                {#if purchase?.vendorId}
                  <label class="flex items-center gap-2 text-xs">
                    <input type="checkbox" bind:checked={reorderAllVendors} />
                    {t("purchaseDetail.showAllVendors")}
                  </label>
                {/if}
              </div>

              {#if $ReorderSuggestionsQuery.fetching && suggestions.length === 0}
                <p class="py-8 text-center text-sm text-muted-foreground">{t("common.loading")}</p>
              {:else if reorderRows.length === 0}
                <p class="py-8 text-center text-sm text-muted-foreground">
                  {purchase?.vendorId && !reorderAllVendors
                    ? t("purchaseDetail.noOpenSuggestionsVendor")
                    : t("purchaseDetail.noOpenSuggestions")}
                </p>
              {:else}
                <table class="w-full text-sm">
                  <thead
                    class="border-b text-left text-xs text-muted-foreground"
                  >
                    <tr>
                      <th class="w-8 py-2"></th>
                      <th class="py-2 font-medium">{t("common.product")}</th>
                      <th class="py-2 text-right font-medium">{t("purchaseDetail.stock")}</th>
                      <th class="py-2 text-right font-medium">{t("purchaseDetail.point")}</th>
                      <th class="py-2 font-medium">{t("common.vendor")}</th>
                      <th class="py-2 font-medium">{t("purchaseDetail.orderQty")}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {#each reorderRows as s (s.id)}
                      {#if reorderPicks[s.id]}
                        {@const sLabel = variantPartsById.get(s.variantId)?.label}
                        <tr class="border-b last:border-0 hover:bg-muted/40">
                          <td class="py-2">
                            <input
                              type="checkbox"
                              bind:checked={reorderPicks[s.id].selected}
                            />
                          </td>
                          <td class="py-2">
                            <span class="font-medium">{s.productName}</span>{#if sLabel}<span class="ml-1.5 font-normal text-foreground">· {sLabel}</span>{/if}
                            <span
                              class="ml-1.5 font-mono text-xs text-muted-foreground"
                              >({s.sku})</span
                            >
                          </td>
                          <td class="py-2 text-right">{s.currentStock}</td>
                          <td class="py-2 text-right">{s.reorderPoint}</td>
                          <td class="py-2 text-xs text-muted-foreground">
                            {s.vendorName ?? "—"}
                          </td>
                          <td class="py-2">
                            <NumericInput
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
                  placeholder={t("purchaseDetail.filterByProduct")}
                  bind:value={stockSearch}
                />
              </div>
              {#if stockVisible.length === 0}
                <p class="py-8 text-center text-sm text-muted-foreground">
                  {t("purchaseDetail.noVariantsMatch")}
                </p>
              {:else}
                <table class="w-full text-sm">
                  <thead
                    class="border-b text-left text-xs text-muted-foreground"
                  >
                    <tr>
                      <th class="w-8 py-2"></th>
                      <th class="py-2 font-medium">{t("common.product")}</th>
                      <th class="py-2 text-right font-medium">{t("purchaseDetail.stock")}</th>
                      <th class="py-2 font-medium">{t("purchaseDetail.orderQty")}</th>
                      <th class="py-2 font-medium">{t("purchaseDetail.unitCostRp")}</th>
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
                            <NumericInput
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
                    {t("purchaseDetail.showingLowestStock", { count: STOCK_CAP })}
                  </p>
                {/if}
              {/if}
            {/if}
          </div>

          <div class="flex items-center justify-between gap-3 border-t px-5 py-3">
            <p class="text-sm text-muted-foreground">
              {t("common.selected", { count: bulkTab === "reorder" ? reorderSelectedCount : stockSelectedCount })}
            </p>
            <div class="flex items-center gap-2">
              <Button variant="ghost" size="sm" disabled={busy} onclick={closeBulk}>
                {t("common.cancel")}
              </Button>
              {#if bulkTab === "reorder"}
                <Button
                  size="sm"
                  disabled={busy || !editable || reorderSelectedCount === 0}
                  onclick={() => {}}
                >
                  {t("purchaseDetail.addLines", { count: reorderSelectedCount })}
                </Button>
              {:else}
                <Button
                  size="sm"
                  disabled={busy || !editable || stockSelectedCount === 0}
                  onclick={addStockSelected}
                >
                  {t("purchaseDetail.addLines", { count: stockSelectedCount })}
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
          aria-label={t("purchaseDetail.resourceTitle")}
        >
          <div class="flex items-center justify-between gap-3 border-b px-5 py-3">
            <h2 class="text-sm font-semibold">{t("purchaseDetail.resourceTitle")}</h2>
            <IconButton icon={X} label={t("common.close")} variant="muted" onclick={closeResource} />
          </div>

          <div class="flex-1 space-y-4 overflow-auto px-5 py-4">
            <p class="text-xs text-muted-foreground">
              {t("purchaseDetail.resourceHint")}
            </p>

            <div class="flex gap-1 border-b">
              <button
                type="button"
                class={resourceTabClass("existing")}
                onclick={() => (resourceMode = "existing")}
              >
                {t("purchaseDetail.addToExistingPo")}
              </button>
              <button
                type="button"
                class={resourceTabClass("new")}
                onclick={() => (resourceMode = "new")}
              >
                {t("purchaseDetail.createNewPo")}
              </button>
            </div>

            {#if resourceMode === "existing"}
              <label class="block space-y-1">
                <span class="text-sm font-medium">{t("purchaseDetail.addToOpenPo")}</span>
                <div class="max-w-md">
                  <Combobox
                    options={resourceTargetOptions}
                    bind:value={resourceTargetPurchaseId}
                    placeholder={t("purchaseDetail.searchOpenPurchases")}
                  />
                </div>
                {#if resourceTargetOptions.length === 0}
                  <span class="block text-xs text-muted-foreground">
                    {t("purchaseDetail.noOtherOpenPos")}
                  </span>
                {/if}
              </label>
            {:else}
              <label class="block space-y-1">
                <span class="text-sm font-medium">{t("purchaseDetail.newPoForVendor")}</span>
                <div class="max-w-sm">
                  <Combobox
                    options={vendors.map((v) => ({ value: v.id, label: v.name }))}
                    bind:value={resourceVendorId}
                    placeholder={t("purchases.searchVendor")}
                  />
                </div>
              </label>
            {/if}

            <table class="w-full text-sm">
              <thead class="border-b text-left text-xs text-muted-foreground">
                <tr>
                  <th class="py-2 font-medium">{t("purchaseDetail.fromLine")}</th>
                  <th class="py-2 font-medium">{t("purchaseDetail.replacement")}</th>
                  <th class="py-2 font-medium">{t("common.qty")}</th>
                  <th class="py-2 font-medium">{t("purchaseDetail.unitCostRp")}</th>
                </tr>
              </thead>
              <tbody>
                {#each resourceRows as r, idx (r.sourceItemId)}
                  <tr class="border-b align-top last:border-0">
                    <td class="py-2 pr-3">
                      <span class="font-medium">{r.sourceLabel}</span>
                      <span class="block text-xs text-muted-foreground">
                        {t("purchaseDetail.ofOrdered", { count: r.remaining })}
                      </span>
                    </td>
                    <td class="py-2 pr-3">
                      {#if r.sourceIsStock}
                        <div class="w-56">
                          <Combobox
                            options={variantOptions}
                            bind:value={resourceRows[idx].variantId}
                            placeholder={t("purchaseDetail.searchProduct")}
                          />
                        </div>
                      {:else}
                        <div class="w-56">
                          <Input
                            bind:value={resourceRows[idx].description}
                            placeholder={t("purchaseDetail.lineDescription")}
                          />
                        </div>
                      {/if}
                    </td>
                    <td class="py-2 pr-3">
                      <NumericInput
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
              {t("purchaseDetail.lineCount", { count: resourceRows.length })}
            </p>
            <div class="flex items-center gap-2">
              <Button variant="ghost" size="sm" disabled={busy} onclick={closeResource}>
                {t("common.cancel")}
              </Button>
              <Button
                size="sm"
                disabled={busy ||
                  (resourceMode === "existing" ? !resourceTargetPurchaseId : !resourceVendorId)}
                onclick={submitResource}
              >
                {t("purchaseDetail.resourceButton", { count: resourceRows.length })}
              </Button>
            </div>
          </div>
        </div>
      </div>
    {/if}
  {/if}
</div>

{#if purchase}
<PullRequisitionModal 
  bind:open={pullModalOpen} 
  purchaseId={purchase.id} 
  products={$RefData.data?.products ?? []} 
  prefillCost={prefillCost}
  onAdd={() => PurchaseDetail.fetch({ policy: 'NetworkOnly', variables: { id: purchase.id } })} 
/>
<DiscountModal
  bind:open={showDiscountModal}
  purchaseId={purchase.id}
  selectedItemIds={[...selected]}
  items={items}
  onSaved={() => {
    selected = new Set();
    PurchaseDetail.fetch({ policy: 'NetworkOnly', variables: { id: purchase.id } });
  }}
/>
<MarkPaidModal
  bind:open={markPaidOpen}
  purchaseId={purchase.id}
  purchaseVendorId={purchase.vendorId}
  vendorOptions={vendorOptions}
  invoiceTotal={purchase.totalInvoiceCost}
  onSaved={afterMarkPaid}
/>
{/if}
