<script lang="ts">
  import NumericInput from "$lib/components/ui/numeric-input.svelte";
  import { tick } from "svelte";
  import { CachePolicy, graphql } from "$houdini";
  import { page } from "$app/state";
  import { Trash2 } from "@lucide/svelte";
  import type { Viewer } from "../../+layout.server";
  import { formatMoney } from "$lib/utils";
  import { refetchOnVisible } from "$lib/refetch-on-visible.svelte";
  import Badge from "$lib/components/ui/badge.svelte";
  import Button from "$lib/components/ui/button.svelte";
  import IconButton from "$lib/components/ui/icon-button.svelte";
  import Input from "$lib/components/ui/input.svelte";
  import MoneyInput from "$lib/components/ui/money-input.svelte";
  import Pagination from "$lib/components/ui/pagination.svelte";
  import Select from "$lib/components/ui/select.svelte";
  import Textarea from "$lib/components/ui/textarea.svelte";
  import { t } from "$lib/i18n";
  import type { PageData } from "./$types";

  graphql(`
    query OrderDetail($id: ID!) {
      order(id: $id) {
        id
        displayNumber
        status
        customerId
        snapshotCustomerName
        posSessionId
        totalMinor
        closedAt
        cancelledAt
        cancellationReason
        note
        returnOfOrderId
        createdAt
        items {
          id
          productId
          qty
          discountMinor
          displayName
          snapshotProductName
          snapshotPublicName
          snapshotBundleName
          snapshotProductSku
          snapshotVariantLabel
          snapshotUnit
          snapshotCategoryName
          snapshotPriceMinor
          snapshotCostMinor
          lineTotalMinor
          voidedAt
          voidReason
        }
        payments {
          id
          method
          amountMinor
          createdAt
        }
      }
    }
  `);

  // Catalog for the variant picker. Split out of OrderDetail so refetch() (run
  // after adding a line or payment) only re-pulls the order rows, never the
  // whole product catalog. Loaded once in +page.ts.
  graphql(`
    query OrderEditorProducts {
      products(includeArchived: false) {
        id
        name
        kind
        variants {
          id
          sku
          label
          unit
          priceMinor
          costMinor
        }
      }
    }
  `);

  // Fetched imperatively when the send composer opens / its channel changes —
  // the API renders the receipt body and resolves the wa.me / mailto: deep link.
  const SendDraftQuery = graphql(`
    query ConsoleOrderSendDraft(
      $orderId: ID!
      $channel: OrderSendChannel!
      $recipientOverride: String
    ) {
      orderSendDraft(
        orderId: $orderId
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

  // Each item-mutating mutation re-selects the FULL item shape the OrderDetail
  // query reads (plus the live variant totalQty for the products screen's stock)
  // so the cache stays internally consistent. The store itself isn't live from
  // the cache (the queries are loaded manually in +page.ts), so every handler
  // refetch()s the order after a successful mutation to surface the new data.
  const AddItem = graphql(`
    mutation ConsoleAddCustomerSaleItem(
      $orderId: ID!
      $item: PosOrderItemInput!
    ) {
      addCustomerSaleItem(orderId: $orderId, item: $item) {
        id
        status
        totalMinor
        items {
          id
          productId
          qty
          discountMinor
          displayName
          snapshotProductName
          snapshotPublicName
          snapshotBundleName
          snapshotProductSku
          snapshotVariantLabel
          snapshotUnit
          snapshotCategoryName
          snapshotPriceMinor
          snapshotCostMinor
          lineTotalMinor
          voidedAt
          voidReason
          variant {
            id
            totalQty
          }
        }
      }
    }
  `);

  const UpdateItem = graphql(`
    mutation ConsoleUpdateCustomerSaleItem(
      $orderItemId: ID!
      $qty: Int
      $discountMinor: Float
      $priceOverrideMinor: Float
      $displayNameOverride: String
    ) {
      updateCustomerSaleItem(
        orderItemId: $orderItemId
        qty: $qty
        discountMinor: $discountMinor
        priceOverrideMinor: $priceOverrideMinor
        displayNameOverride: $displayNameOverride
      ) {
        id
        status
        totalMinor
        items {
          id
          productId
          qty
          discountMinor
          displayName
          snapshotProductName
          snapshotPublicName
          snapshotBundleName
          snapshotProductSku
          snapshotVariantLabel
          snapshotUnit
          snapshotCategoryName
          snapshotPriceMinor
          snapshotCostMinor
          lineTotalMinor
          voidedAt
          voidReason
          variant {
            id
            totalQty
          }
        }
      }
    }
  `);

  const VoidItem = graphql(`
    mutation ConsoleVoidCustomerSaleItem($orderItemId: ID!) {
      voidCustomerSaleItem(orderItemId: $orderItemId) {
        id
        status
        totalMinor
        items {
          id
          productId
          qty
          discountMinor
          displayName
          snapshotProductName
          snapshotPublicName
          snapshotBundleName
          snapshotProductSku
          snapshotVariantLabel
          snapshotUnit
          snapshotCategoryName
          snapshotPriceMinor
          snapshotCostMinor
          lineTotalMinor
          voidedAt
          voidReason
          variant {
            id
            totalQty
          }
        }
      }
    }
  `);

  const AddPayment = graphql(`
    mutation ConsoleAddCustomerSalePayment(
      $orderId: ID!
      $amountMinor: Float!
    ) {
      addCustomerSalePayment(orderId: $orderId, amountMinor: $amountMinor) {
        id
        status
        totalMinor
        payments {
          id
          method
          amountMinor
          createdAt
        }
      }
    }
  `);

  const UpdateNote = graphql(`
    mutation ConsoleUpdateCustomerSaleNote($orderId: ID!, $note: String) {
      updateCustomerSaleNote(orderId: $orderId, note: $note) {
        id
        note
      }
    }
  `);

  const CloseSale = graphql(`
    mutation ConsoleCloseCustomerSale($orderId: ID!) {
      closeCustomerSale(orderId: $orderId) {
        id
        status
        displayNumber
        closedAt
      }
    }
  `);

  const CancelSale = graphql(`
    mutation ConsoleCancelCustomerSale($orderId: ID!, $reason: String!) {
      cancelCustomerSale(orderId: $orderId, reason: $reason) {
        id
        status
        totalMinor
        cancelledAt
        cancellationReason
        items {
          id
          productId
          qty
          discountMinor
          displayName
          snapshotProductName
          snapshotPublicName
          snapshotBundleName
          snapshotProductSku
          snapshotVariantLabel
          snapshotUnit
          snapshotCategoryName
          snapshotPriceMinor
          snapshotCostMinor
          lineTotalMinor
          voidedAt
          voidReason
          variant {
            id
            totalQty
          }
        }
      }
    }
  `);

  let { data }: { data: PageData } = $props();
  const OrderDetail = $derived(data.OrderDetail);
  const OrderEditorProducts = $derived(data.OrderEditorProducts);

  // A product created in another tab won't appear in the item picker —
  // Houdini serves the cached catalog. Re-pull when the tab becomes visible.
  refetchOnVisible(() =>
    OrderEditorProducts.fetch({ policy: CachePolicy.NetworkOnly }),
  );
  const order = $derived($OrderDetail.data?.order ?? null);
  const products = $derived($OrderEditorProducts.data?.products ?? []);
  const isOpen = $derived(order?.status === "open");

  // Adding a line or payment changes a list's membership, which Houdini's cache
  // does not surface from a mutation result the way it does scalar edits to an
  // existing row — so re-pull the (catalog-free) order after those operations.
  const refetch = () => {
    if (!order) return Promise.resolve();
    return OrderDetail.fetch({ variables: { id: order.id }, policy: "NetworkOnly" });
  };

  // ---- Viewer permissions --------------------------------------------------
  const viewer = $derived(page.data.user as Viewer | undefined);
  const has = (key: string) => !!viewer && viewer.permissions.includes(key);
  const canEdit = $derived(has("order.edit_customer_sale"));
  const canVoid = $derived(has("order.void_item"));
  const canClose = $derived(has("order.close_customer_sale"));
  const canCancel = $derived(has("order.cancel_customer_sale"));
  const canSend = $derived(has("order.send"));

  let busy = $state(false);
  let error = $state<string | null>(null);

  async function run(fn: () => Promise<{ errors?: readonly { message: string }[] | null }>): Promise<boolean> {
    busy = true;
    error = null;
    try {
      const res = await fn();
      if (res.errors?.length) {
        error = res.errors[0].message;
        return false;
      }
      return true;
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
      return false;
    } finally {
      busy = false;
    }
  }

  // ---- Variant picker ------------------------------------------------------
  interface PickRow {
    variantId: string;
    productId: string;
    productName: string;
    productKind: string;
    sku: string;
    label: string | null;
    priceMinor: number;
    costMinor: number;
    unit: string;
  }

  const pickRows = $derived.by<PickRow[]>(() => {
    const out: PickRow[] = [];
    for (const p of products) {
      for (const v of p.variants) {
        out.push({
          variantId: v.id,
          productId: p.id,
          productName: p.name,
          productKind: p.kind,
          sku: v.sku,
          label: v.label ?? null,
          priceMinor: v.priceMinor,
          costMinor: v.costMinor,
          unit: v.unit,
        });
      }
    }
    return out.sort((a, b) => {
      const p = a.productName.localeCompare(b.productName);
      return p !== 0 ? p : a.sku.localeCompare(b.sku);
    });
  });

  let variantSearch = $state("");
  let pickerOpen = $state(false);
  let highlight = $state(0);
  let addQty = $state(1);
  let addDiscount = $state<number | null>(0);
  let addPriceOverride = $state<number | null>(null); // null → use variant price
  // Selected draft (after picking from the list, before pressing Add).
  let draft = $state<{ row: PickRow; productKind: string } | null>(null);
  // Qty field of the draft — focused right after a product is picked so the
  // cashier can type the quantity without reaching for the mouse or tabbing.
  let qtyInput = $state<HTMLInputElement | null>(null);

  const pickMatches = $derived.by(() => {
    // AND-match each whitespace-separated token against the row's combined
    // name/SKU/label text. Tokens may match different parts, so a query like
    // "nkn 6201" still finds "Bearing \ 6201 2RS \ NKN" even though that string
    // never contains the two words contiguously.
    const tokens = variantSearch.trim().toLowerCase().split(/\s+/).filter(Boolean);
    const filtered = tokens.length
      ? pickRows.filter((r) => {
          const hay = `${r.productName} ${r.sku} ${r.label ?? ""}`.toLowerCase();
          return tokens.every((t) => hay.includes(t));
        })
      : pickRows;
    return filtered.slice(0, 30);
  });

  $effect(() => {
    void variantSearch;
    highlight = 0;
  });

  async function selectVariant(row: PickRow) {
    draft = { row, productKind: row.productKind };
    addQty = 1;
    addDiscount = 0;
    addPriceOverride = null;
    pickerOpen = false;
    variantSearch = `${row.productName} · ${row.sku}`;
    // Jump straight to Qty once the draft block has rendered.
    await tick();
    qtyInput?.focus();
    qtyInput?.select();
  }

  // Enter anywhere in the draft fields adds the line — saves tabbing to the
  // button. commitDraft re-validates (busy / qty / price-kind), so a stray
  // Enter on an incomplete draft is a no-op.
  function onDraftKey(e: KeyboardEvent) {
    if (e.key === "Enter") {
      e.preventDefault();
      void commitDraft();
    }
  }

  function clearDraft() {
    draft = null;
    addQty = 1;
    addDiscount = 0;
    addPriceOverride = null;
    variantSearch = "";
  }

  async function commitDraft() {
    if (!order || !draft || addQty < 1) return;
    // Capture the narrowed values — both are reassignable $state, so the async
    // mutation callback below would otherwise see them widened back to null.
    const o = order;
    const d = draft;
    const priceOverrideMinor = addPriceOverride ?? undefined;
    const discount = addDiscount ?? 0;
    const ok = await run(() =>
      AddItem.mutate({
        orderId: o.id,
        item: {
          variantId: d.row.variantId,
          qty: addQty,
          discountMinor: discount || undefined,
          priceOverrideMinor,
        },
      }),
    );
    if (ok) {
      clearDraft();
      await refetch();
    }
  }

  function onPickerKey(e: KeyboardEvent) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      pickerOpen = true;
      if (pickMatches.length) highlight = (highlight + 1) % pickMatches.length;
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      if (pickMatches.length)
        highlight = (highlight - 1 + pickMatches.length) % pickMatches.length;
    } else if (e.key === "Enter") {
      if (pickMatches.length === 0) return;
      e.preventDefault();
      const target =
        pickMatches.length === 1
          ? pickMatches[0]
          : pickMatches[highlight] ?? pickMatches[0];
      selectVariant(target);
    } else if (e.key === "Escape") {
      pickerOpen = false;
    }
  }

  async function deleteLine(itemId: string) {
    const ok = await run(() => VoidItem.mutate({ orderItemId: itemId }));
    if (ok) await refetch();
  }

  // ---- Inline per-line quick edit ------------------------------------------
  // Click a cell to edit it in place. Each commit sends just the one changed
  // field, then refetch()s the order so the line + server-computed totals
  // reflect the change (these queries are loaded manually in +page.ts, so the
  // store isn't live from the cache). Bundle component lines and voided lines
  // aren't editable.
  type CellField = "qty" | "name" | "price" | "discount";
  let cellEdit = $state<{ id: string; field: CellField } | null>(null);
  // qty + name edit through a raw <input> (string); price + discount through
  // MoneyInput (integer minor units), so they need separate bindings.
  let cellStr = $state("");
  let cellMoney = $state<number | null>(null);

  type LineItem = NonNullable<typeof order>["items"][number];
  const lineEditable = (i: LineItem) =>
    isOpen && canEdit && !i.voidedAt && !i.snapshotBundleName;

  // Margin % off the net line price (price − per-unit discount) vs. the snapshot
  // cost — handy for judging an override or discount at a glance. Null when
  // there's no meaningful margin to show (free line, zero/negative net).
  function marginPct(i: LineItem): number | null {
    const price = i.snapshotPriceMinor;
    if (price <= 0 || i.qty <= 0) return null;
    const net = price - i.discountMinor / i.qty;
    if (net <= 0) return null;
    return ((net - i.snapshotCostMinor) / net) * 100;
  }

  // Live margin for the add-line draft, off the same net-price-vs-cost basis as
  // the per-line pill — so an override or discount can be judged before adding.
  const draftMargin = $derived.by<number | null>(() => {
    if (!draft || addQty < 1) return null;
    const price = addPriceOverride ?? draft.row.priceMinor;
    if (price <= 0) return null;
    const net = price - (addDiscount ?? 0) / addQty;
    if (net <= 0) return null;
    return ((net - draft.row.costMinor) / net) * 100;
  });

  const marginBadgeClass = (m: number) =>
    m < 0
      ? "bg-destructive/10 text-destructive"
      : m < 10
        ? "bg-amber-100 text-amber-800"
        : "bg-emerald-100 text-emerald-700";

  // Focus + select the inline <input> the moment it mounts, so you can type or
  // tab straight in. (MoneyInput does this itself via its `autofocus` prop.)
  function selectOnMount(node: HTMLInputElement) {
    node.focus();
    node.select();
  }

  function startCellEdit(i: LineItem, field: CellField) {
    if (!lineEditable(i)) return;
    if (field === "price") cellMoney = i.snapshotPriceMinor;
    else if (field === "discount") cellMoney = i.discountMinor;
    else if (field === "qty") cellStr = String(i.qty);
    else cellStr = i.displayName;
    cellEdit = { id: i.id, field };
  }

  async function commitCell() {
    const c = cellEdit;
    if (!c) return;
    const i = (order?.items ?? []).find((x) => x.id === c.id);
    if (!i) {
      cellEdit = null;
      return;
    }

    const patch: {
      orderItemId: string;
      qty?: number;
      priceOverrideMinor?: number;
      discountMinor?: number;
      displayNameOverride?: string;
    } = { orderItemId: c.id };

    if (c.field === "qty") {
      const n = Number(cellStr);
      if (!Number.isInteger(n) || n < 1) {
        error = t("orderDetail.qtyPositive");
        return;
      }
      if (n === i.qty) {
        cellEdit = null;
        return;
      }
      patch.qty = n;
    } else if (c.field === "price") {
      const n = cellMoney ?? 0;
      if (n === i.snapshotPriceMinor) {
        cellEdit = null;
        return;
      }
      patch.priceOverrideMinor = n;
    } else if (c.field === "discount") {
      const n = cellMoney ?? 0;
      if (n === i.discountMinor) {
        cellEdit = null;
        return;
      }
      patch.discountMinor = n;
    } else {
      // Empty string clears the override back to the product's default name.
      const d = cellStr.trim();
      if (d === i.displayName) {
        cellEdit = null;
        return;
      }
      patch.displayNameOverride = d;
    }

    cellEdit = null;
    const ok = await run(() => UpdateItem.mutate(patch));
    if (ok) await refetch();
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

  // ---- Order note ----------------------------------------------------------
  // Editable only while open. Synced from the order only when a different order
  // loads (guarded by noteSyncedId), so an in-progress edit isn't clobbered when
  // the cache re-emits the same order after an unrelated mutation.
  let noteDraft = $state("");
  let noteSyncedId = $state("");
  $effect(() => {
    if (order && order.id !== noteSyncedId) {
      noteSyncedId = order.id;
      noteDraft = order.note ?? "";
    }
  });
  const noteDirty = $derived(!!order && noteDraft.trim() !== (order.note ?? ""));

  async function saveNote() {
    if (!order) return;
    const ok = await run(() =>
      UpdateNote.mutate({ orderId: order.id, note: noteDraft.trim() }),
    );
    if (ok) await refetch();
  }

  // ---- Payment entry -------------------------------------------------------
  let payAmount = $state<number | null>(null);

  async function recordPayment() {
    if (!order) return;
    const amt = payAmount ?? 0;
    if (amt <= 0) {
      error = t("orderDetail.paymentPositive");
      return;
    }
    const ok = await run(() =>
      AddPayment.mutate({ orderId: order.id, amountMinor: amt }),
    );
    if (ok) {
      payAmount = null;
      await refetch();
    }
  }

  async function closeSale() {
    if (!order) return;
    const ok = await run(() => CloseSale.mutate({ orderId: order.id }));
    if (ok) await refetch();
  }

  async function cancelSale() {
    if (!order) return;
    const reason = prompt(t("orderDetail.cancelReasonPrompt"))?.trim();
    if (!reason) return;
    const ok = await run(() => CancelSale.mutate({ orderId: order.id, reason }));
    if (ok) await refetch();
  }

  const fmt = (iso: string | null | undefined) =>
    iso ? new Date(iso).toLocaleString("id-ID") : "—";

  function statusBadge(s: string) {
    if (s === "closed") return "bg-emerald-100 text-emerald-700";
    if (s === "cancelled") return "bg-destructive/10 text-destructive";
    return "bg-amber-100 text-amber-800";
  }

  // Voided lines are hidden from the list; only live lines are shown/totalled.
  const visibleItems = $derived((order?.items ?? []).filter((i) => !i.voidedAt));

  let itemsPage = $state(1);
  const pageSize = 50;
  const paginatedItems = $derived(visibleItems.slice((itemsPage - 1) * pageSize, itemsPage * pageSize));

  let paymentsPage = $state(1);
  const paginatedPayments = $derived((order?.payments ?? []).slice((paymentsPage - 1) * pageSize, paymentsPage * pageSize));

  // Sum of live (non-voided) lines — sanity check against the cached total.
  const computed = $derived(
    visibleItems.reduce((acc, i) => acc + i.lineTotalMinor, 0),
  );
  const computedCost = $derived(
    visibleItems.reduce((acc, i) => acc + i.snapshotCostMinor * i.qty, 0),
  );
  const computedMargin = $derived(computed - computedCost);
  const computedMarginPct = $derived(
    computed > 0 ? (computedMargin / computed) * 100 : null,
  );
  const paid = $derived(
    (order?.payments ?? []).reduce((acc, p) => acc + p.amountMinor, 0),
  );

  // ---- Send to customer — deep-link composer -------------------------------
  // Renders the order as a receipt and offers a WhatsApp / email deep link (or
  // a shareable PDF). Composer-only: opening a link or sharing the PDF is the
  // send — nothing is logged.
  const CHANNELS = ["whatsapp", "email", "manual"];
  interface Composer {
    channel: string;
    recipientOverride: string;
    /** WhatsApp only: "text" = wa.me deep link, "pdf" = share the receipt PDF. */
    format: "text" | "pdf";
  }
  let composer = $state<Composer | null>(null);
  let previewing = $state(false);
  let sharing = $state(false);

  // The rendered draft (body + resolved recipient + deep link) for the current
  // composer channel / recipient.
  const sendDraft = $derived($SendDraftQuery.data?.orderSendDraft);
  // The receipt PDF goes through the console's own cookie-authenticated proxy.
  const pdfHref = $derived(order ? `/orders/${order.id}/receipt.pdf` : "#");

  async function previewSend() {
    const c = composer;
    if (!c || !order) return;
    previewing = true;
    error = null;
    try {
      // NetworkOnly — the rendered body embeds the business name / greeting /
      // footer and the customer's contact, none of which are query variables,
      // so a cached draft would keep showing stale details. Always re-render.
      await SendDraftQuery.fetch({
        policy: "NetworkOnly",
        variables: {
          orderId: order.id,
          channel: c.channel as never,
          recipientOverride: c.recipientOverride.trim() || null,
        },
      });
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    } finally {
      previewing = false;
    }
  }

  function startCompose() {
    composer = { channel: "whatsapp", recipientOverride: "", format: "text" };
    previewSend();
  }

  /**
   * Share the receipt PDF via the device's native share sheet (Web Share API)
   * so the clerk can pick WhatsApp and the PDF goes as an attachment — a wa.me
   * link can only carry text, never a file. The OS share sheet picks the
   * recipient. A dismissed share sheet (AbortError) is a no-op, not a failure.
   */
  async function sharePdf() {
    if (!order) return;
    sharing = true;
    error = null;
    try {
      const res = await fetch(pdfHref, { credentials: "same-origin" });
      if (!res.ok) throw new Error(t("orderDetail.pdfUnavailable", { status: res.status }));
      const blob = await res.blob();
      const file = new File([blob], `receipt-${order.id}.pdf`, {
        type: "application/pdf",
      });
      if (!navigator.canShare?.({ files: [file] })) {
        error = t("orderDetail.cantShare");
        return;
      }
      const caption = t("orderDetail.seeAttachedPdf", {
        subject: sendDraft?.subject ?? t("orderDetail.receipt"),
      });
      await navigator.share({
        files: [file],
        title: sendDraft?.subject ?? t("orderDetail.receipt"),
        text: caption,
      });
    } catch (e) {
      if (e instanceof DOMException && e.name === "AbortError") return; // dismissed
      error = e instanceof Error ? e.message : String(e);
    } finally {
      sharing = false;
    }
  }
</script>

<svelte:head>
  <title>{t("orderDetail.pageTitle")}</title>
</svelte:head>

<div class="space-y-4">
  <a href="/orders" class="text-sm text-primary hover:underline">{t("orderDetail.backToOrders")}</a>

  {#if $OrderDetail.fetching && !order}
    <p class="text-sm text-muted-foreground">{t("common.loading")}</p>
  {:else if $OrderDetail.errors?.length}
    <p class="text-sm text-destructive">{$OrderDetail.errors[0].message}</p>
  {:else if !order}
    <p class="text-sm text-muted-foreground">{t("orderDetail.notFound")}</p>
  {:else}
    <div class="flex items-start justify-between">
      <div>
        <h1 class="text-xl font-semibold">
          {order.displayNumber ?? t("orderDetail.orderLabel", { id: order.id.slice(-8) })}
        </h1>
        <p class="text-sm text-muted-foreground">
          {order.snapshotCustomerName ?? t("orderDetail.walkIn")} · {t("orderDetail.created", { date: fmt(order.createdAt) })}
          {#if order.closedAt}· {t("orderDetail.closed", { date: fmt(order.closedAt) })}{/if}
          {#if order.cancelledAt}· {t("orderDetail.cancelled", { date: fmt(order.cancelledAt) })}{/if}
        </p>
        {#if order.posSessionId}
          <p class="text-xs text-muted-foreground">
            {t("orderDetail.session")}
            <a
              href={`/sessions/${order.posSessionId}`}
              class="font-mono text-primary hover:underline"
            >
              {order.posSessionId.slice(-8)}
            </a>
          </p>
        {/if}
        {#if order.returnOfOrderId}
          <p class="text-xs text-muted-foreground">
            {t("orderDetail.returnOf")}
            <a
              href={`/orders/${order.returnOfOrderId}`}
              class="font-mono text-primary hover:underline"
            >
              {order.returnOfOrderId.slice(-8)}
            </a>
          </p>
        {/if}
      </div>
      <Badge class={statusBadge(order.status)}>{t(`orders.status.${order.status}`)}</Badge>
    </div>

    <!-- Summary metrics -->
    <div class="grid grid-cols-2 gap-3 sm:grid-cols-4">
      <div class="rounded-lg border bg-card p-3">
        <span class="text-xs font-medium text-muted-foreground">{t("orderDetail.totalRevenue")}</span>
        <div class="text-lg font-semibold">{formatMoney(order.totalMinor)}</div>
      </div>
      <div class="rounded-lg border bg-card p-3">
        <span class="text-xs font-medium text-muted-foreground">{t("orderDetail.totalCost")}</span>
        <div class="text-lg font-semibold">{formatMoney(computedCost)}</div>
      </div>
      <div class="rounded-lg border bg-card p-3">
        <span class="text-xs font-medium text-muted-foreground">{t("products.margin")}</span>
        <div class="flex items-center gap-1.5">
          <span class="text-lg font-semibold">{formatMoney(computedMargin)}</span>
          {#if computedMarginPct != null}
            <Badge class={marginBadgeClass(computedMarginPct)}>
              {computedMarginPct.toFixed(1)}%
            </Badge>
          {/if}
        </div>
      </div>
      <div class="rounded-lg border bg-card p-3">
        <span class="text-xs font-medium text-muted-foreground">{t("orderDetail.paidOutstanding")}</span>
        <div class="text-lg font-semibold {computed - paid > 0 ? 'text-amber-700' : 'text-emerald-700'}">
          {formatMoney(paid)} / {formatMoney(computed - paid)}
        </div>
      </div>
    </div>

    {#if order.cancellationReason}
      <div class="rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm">
        <span class="font-medium">{t("orderDetail.cancelledLabel")}</span>
        {order.cancellationReason}
      </div>
    {/if}

    {#if error}
      <p class="text-sm text-destructive">{error}</p>
    {/if}

    <!-- Order note -->
    {#if isOpen}
      <div class="space-y-2 rounded-lg border bg-card p-4">
        <h2 class="text-sm font-semibold">{t("common.note")}</h2>
        <Textarea
          bind:value={noteDraft}
          disabled={busy || !canEdit}
          placeholder={t("orderDetail.notePlaceholder")}
          class="h-20 resize-none"
        />
        <div class="flex justify-end">
          <Button
            size="sm"
            disabled={busy || !canEdit || !noteDirty}
            onclick={saveNote}
          >
            {t("orderDetail.saveNote")}
          </Button>
        </div>
      </div>
    {:else if order.note}
      <div class="space-y-1 rounded-lg border bg-card p-4">
        <h2 class="text-sm font-semibold">{t("common.note")}</h2>
        <p class="whitespace-pre-wrap text-sm text-muted-foreground">{order.note}</p>
      </div>
    {/if}

    <!-- Items + add line -->
    <div class="rounded-lg border bg-card">
      <div class="overflow-hidden {isOpen ? 'rounded-t-lg' : 'rounded-lg'}">
        <table class="w-full text-sm">
        <thead class="border-b bg-muted/50 text-left text-muted-foreground">
          <tr>
            <th class="px-4 py-2 font-medium">{t("orderDetail.item")}</th>
            <th class="px-4 py-2 text-right font-medium">{t("common.qty")}</th>
            <th class="px-4 py-2 text-right font-medium">{t("common.cost")}</th>
            <th class="px-4 py-2 text-right font-medium">{t("common.price")}</th>
            <th class="px-4 py-2 text-right font-medium">{t("orderDetail.discount")}</th>
            <th class="px-4 py-2 text-right font-medium">{t("orderDetail.lineTotal")}</th>
            {#if isOpen}<th></th>{/if}
          </tr>
        </thead>
        <tbody>
          {#each paginatedItems as i (i.id)}
            {@const margin = marginPct(i)}
            <tr class="border-b align-top last:border-0">
              <td class="px-4 py-2">
                {#if cellEdit?.id === i.id && cellEdit.field === "name"}
                  <input
                    bind:value={cellStr}
                    use:selectOnMount
                    onkeydown={cellKeydown}
                    onblur={commitCell}
                    placeholder={i.snapshotProductName}
                    autocomplete="off"
                    class="h-7 w-full rounded-md border border-input bg-background px-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  />
                {:else if lineEditable(i)}
                  <button
                    type="button"
                    class="-mx-1 rounded px-1 text-left font-medium hover:bg-accent"
                    title={t("orderDetail.editNameTitle")}
                    onclick={() => startCellEdit(i, "name")}>{i.displayName}</button
                  >
                {:else}
                  <div class="font-medium">{i.displayName}</div>
                {/if}
                <div class="text-xs">
                  {#if i.snapshotVariantLabel}
                    <span class="font-medium text-foreground">{i.snapshotVariantLabel}</span>
                    <span class="text-muted-foreground"> · </span>
                  {/if}
                  <span class="font-mono text-xs text-muted-foreground">({i.snapshotProductSku})</span><span class="text-muted-foreground"> · {i.snapshotUnit}</span>
                  {#if i.snapshotCategoryName}
                    <span class="text-muted-foreground"> · {i.snapshotCategoryName}</span>
                  {/if}
                </div>
                {#if margin != null}
                  <div class="mt-1">
                    <Badge class={marginBadgeClass(margin)}>
                      {t("orderDetail.marginLabel", { value: margin.toFixed(1) })}
                    </Badge>
                  </div>
                {/if}
              </td>
              <td class="px-4 py-2 text-right">
                {#if cellEdit?.id === i.id && cellEdit.field === "qty"}
                  <NumericInput
                    
                    min="1"
                    bind:value={cellStr}
                    autofocus={true}
                    onkeydown={cellKeydown}
                    onblur={commitCell}
                    class="h-7 w-16 rounded-md border border-input bg-background px-2 text-right text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  />
                {:else if lineEditable(i)}
                  <button
                    type="button"
                    class="-mx-1 rounded px-1 hover:bg-accent"
                    title={t("orderDetail.editQty")}
                    onclick={() => startCellEdit(i, "qty")}>{i.qty}</button
                  >
                {:else}
                  {i.qty}
                {/if}
              </td>
              <td class="px-4 py-2 text-right text-muted-foreground">
                {formatMoney(i.snapshotCostMinor)}
              </td>
              <td class="px-4 py-2 text-right">
                {#if cellEdit?.id === i.id && cellEdit.field === "price"}
                  <MoneyInput
                    autofocus
                    bind:value={cellMoney}
                    onkeydown={cellKeydown}
                    onblur={commitCell}
                    class="ml-auto h-7 w-28 px-2 text-right"
                  />
                {:else if lineEditable(i)}
                  <button
                    type="button"
                    class="-mx-1 rounded px-1 hover:bg-accent"
                    title={t("products.editPrice")}
                    onclick={() => startCellEdit(i, "price")}
                    >{formatMoney(i.snapshotPriceMinor)}</button
                  >
                {:else}
                  {formatMoney(i.snapshotPriceMinor)}
                {/if}
              </td>
              <td class="px-4 py-2 text-right">
                {#if cellEdit?.id === i.id && cellEdit.field === "discount"}
                  <MoneyInput
                    autofocus
                    bind:value={cellMoney}
                    onkeydown={cellKeydown}
                    onblur={commitCell}
                    class="ml-auto h-7 w-28 px-2 text-right"
                  />
                {:else if lineEditable(i)}
                  <button
                    type="button"
                    class="-mx-1 rounded px-1 hover:bg-accent"
                    title={t("orderDetail.editDiscount")}
                    onclick={() => startCellEdit(i, "discount")}
                    >{i.discountMinor ? formatMoney(i.discountMinor) : "—"}</button
                  >
                {:else}
                  {i.discountMinor ? formatMoney(i.discountMinor) : "—"}
                {/if}
              </td>
              <td class="px-4 py-2 text-right font-medium">
                {formatMoney(i.lineTotalMinor)}
              </td>
              {#if isOpen}
                <td class="px-4 py-2 text-right whitespace-nowrap">
                  <IconButton
                    icon={Trash2}
                    label={t("orderDetail.deleteLine")}
                    variant="destructive"
                    disabled={busy || !canVoid}
                    onclick={() => deleteLine(i.id)}
                  />
                </td>
              {/if}
            </tr>
          {/each}
          {#if visibleItems.length === 0}
            <tr>
              <td
                colspan={isOpen ? 7 : 6}
                class="px-4 py-8 text-center text-muted-foreground"
              >
                {t("orderDetail.noItems")}
              </td>
            </tr>
          {/if}
        </tbody>
        <tfoot class="bg-muted/30">
          <!-- The lines total and the order's stored total should always agree;
               surface both only when they drift so the mismatch is visible. -->
          {#if computed !== order.totalMinor}
            <tr>
              <td
                colspan={isOpen ? 6 : 5}
                class="px-4 py-2 text-right font-medium"
              >
                {t("orderDetail.linesTotal")}
              </td>
              <td class="px-4 py-2 text-right font-medium">
                {formatMoney(computed)}
              </td>
            </tr>
          {/if}
          <tr>
            <td
              colspan={isOpen ? 6 : 5}
              class="px-4 py-2 text-right font-medium text-muted-foreground"
            >
              {t("orderDetail.totalCost")}
            </td>
            <td class="px-4 py-2 text-right font-medium text-muted-foreground">
              {formatMoney(computedCost)}
            </td>
          </tr>
          <tr>
            <td
              colspan={isOpen ? 6 : 5}
              class="px-4 py-2 text-right font-medium"
            >
              {t("products.margin")}
            </td>
            <td class="px-4 py-2 text-right font-medium">
              <span>{formatMoney(computedMargin)}</span>
              {#if computedMarginPct != null}
                <Badge class="{marginBadgeClass(computedMarginPct)} ml-1">
                  {computedMarginPct.toFixed(1)}%
                </Badge>
              {/if}
            </td>
          </tr>
          <tr>
            <td
              colspan={isOpen ? 6 : 5}
              class="px-4 py-2 text-right font-medium"
            >
              {t("common.total")}
            </td>
            <td
              class="px-4 py-2 text-right font-medium
                {computed !== order.totalMinor ? 'text-destructive' : ''}"
            >
              {formatMoney(order.totalMinor)}
            </td>
          </tr>
        </tfoot>
      </table>
      </div>
      <div class="border-t p-2 flex justify-end bg-muted/10">
        <Pagination bind:page={itemsPage} {pageSize} totalItems={visibleItems.length} />
      </div>

      {#if isOpen}
        <!-- Add line — compact, attached to the bottom of the list -->
        <div class="space-y-2 border-t p-3">
          <div class="relative">
            <Input
              type="search"
              placeholder={t("orderDetail.addLineSearch")}
              bind:value={variantSearch}
              onfocus={() => (pickerOpen = true)}
              onblur={() => setTimeout(() => (pickerOpen = false), 150)}
              onkeydown={onPickerKey}
              autocomplete="off"
              class="h-8"
              disabled={busy || !canEdit}
            />
            {#if pickerOpen && pickMatches.length > 0}
              <ul
                class="absolute bottom-full z-10 mb-1 max-h-72 w-full overflow-auto rounded-md border bg-popover shadow-md"
              >
                {#each pickMatches as v, i (v.variantId)}
                  <li>
                    <button
                      type="button"
                      class="flex w-full items-center justify-between px-3 py-2 text-left text-sm hover:bg-muted/60 {i ===
                      highlight
                        ? 'bg-muted/60'
                        : ''}"
                      onmousedown={(e) => e.preventDefault()}
                      onmouseenter={() => (highlight = i)}
                      onclick={() => selectVariant(v)}
                    >
                      <span>
                        <span class="font-medium">{v.productName}</span>
                        <span class="ml-2 font-mono text-xs text-muted-foreground">
                          {v.sku}{v.label ? ` · ${v.label}` : ""}
                        </span>
                        {#if v.productKind !== "physical"}
                          <span class="ml-2 text-xs text-muted-foreground">
                            ({v.productKind})
                          </span>
                        {/if}
                      </span>
                      <span class="text-xs text-muted-foreground">
                        {formatMoney(v.priceMinor)}
                      </span>
                    </button>
                  </li>
                {/each}
              </ul>
            {:else if pickerOpen && variantSearch.trim()}
              <div
                class="absolute bottom-full z-10 mb-1 w-full rounded-md border bg-popover px-3 py-2 text-sm text-muted-foreground shadow-md"
              >
                {t("products.noMatches")}
              </div>
            {/if}
          </div>

          {#if draft}
            <div
              class="flex flex-wrap items-end gap-2 rounded-md border bg-background p-2"
            >
              <div class="min-w-[8rem] flex-1">
                <div class="truncate text-sm font-medium">
                  {draft.row.productName}
                </div>
                <div class="truncate text-xs text-muted-foreground">
                  {draft.row.sku}{draft.row.label ? ` · ${draft.row.label}` : ""}
                  · {draft.row.unit} · {t("orderDetail.costPrefix", { value: formatMoney(draft.row.costMinor) })} · {t("orderDetail.basePrefix", { value: formatMoney(draft.row.priceMinor) })}
                  {#if draft.productKind !== "physical"}
                    · {draft.productKind}
                  {/if}
                </div>
              </div>
              <label class="space-y-0.5">
                <span class="block text-[11px] font-medium text-muted-foreground">
                  {t("common.qty")}
                </span>
                <NumericInput
                  min={1}
                  bind:value={addQty}
                  bind:ref={qtyInput}
                  onkeydown={onDraftKey}
                  class="h-8 w-16"
                  disabled={busy || !canEdit}
                />
              </label>
              <label class="space-y-0.5">
                <span class="block text-[11px] font-medium text-muted-foreground">
                  {t("orderDetail.discRp")}
                </span>
                <MoneyInput
                  bind:value={addDiscount}
                  onkeydown={onDraftKey}
                  class="h-8 w-24"
                  disabled={busy || !canEdit}
                />
              </label>
              <label class="space-y-0.5">
                <span class="block text-[11px] font-medium text-muted-foreground">
                  {t("products.priceRp")}
                </span>
                <MoneyInput
                  placeholder={draft.productKind === "open_price"
                    ? t("orderDetail.required")
                    : t("orderDetail.base")}
                  bind:value={addPriceOverride}
                  onkeydown={onDraftKey}
                  class="h-8 w-28"
                  disabled={busy || !canEdit}
                />
              </label>
              {#if draftMargin != null}
                <Badge class="{marginBadgeClass(draftMargin)} self-end">
                  {t("orderDetail.marginLabel", { value: draftMargin.toFixed(1) })}
                </Badge>
              {/if}
              <Button
                size="sm"
                disabled={busy || !canEdit || addQty < 1}
                onclick={commitDraft}
              >
                {t("common.add")}
              </Button>
              <Button variant="ghost" size="sm" disabled={busy} onclick={clearDraft}>
                {t("common.cancel")}
              </Button>
            </div>
          {/if}
        </div>
      {/if}
    </div>

    {#if isOpen && canEdit}
      <p class="text-xs text-muted-foreground">
        {t("orderDetail.editHint")}
      </p>
    {/if}

    <!-- Payments -->
    <div>
      <h2 class="mb-2 text-sm font-semibold">{t("orderDetail.payments")}</h2>
      <div class="overflow-hidden rounded-lg border bg-card">
        <table class="w-full text-sm">
          <thead class="border-b bg-muted/50 text-left text-muted-foreground">
            <tr>
              <th class="px-4 py-2 font-medium">{t("orderDetail.method")}</th>
              <th class="px-4 py-2 font-medium">{t("orders.when")}</th>
              <th class="px-4 py-2 text-right font-medium">{t("common.amount")}</th>
            </tr>
          </thead>
          <tbody>
            {#each paginatedPayments as p (p.id)}
              <tr class="border-b last:border-0">
                <td class="px-4 py-2 capitalize">{t(`orderDetail.method.${p.method}`)}</td>
                <td class="px-4 py-2">{fmt(p.createdAt)}</td>
                <td class="px-4 py-2 text-right">{formatMoney(p.amountMinor)}</td>
              </tr>
            {/each}
            {#if order.payments.length === 0}
              <tr>
                <td colspan="3" class="px-4 py-6 text-center text-muted-foreground">
                  {t("orderDetail.noPayments")}
                </td>
              </tr>
            {/if}
          </tbody>
          <tfoot class="bg-muted/30">
            <tr>
              <td colspan="2" class="px-4 py-2 text-right font-medium">
                {t("orderDetail.paidTotal")}
              </td>
              <td class="px-4 py-2 text-right font-medium">
                {formatMoney(paid)}
              </td>
            </tr>
            <tr>
              <td colspan="2" class="px-4 py-2 text-right font-medium">
                {t("orderDetail.outstanding")}
              </td>
              <td
                class="px-4 py-2 text-right font-medium {computed - paid > 0
                  ? 'text-amber-700'
                  : 'text-emerald-700'}"
              >
                {formatMoney(computed - paid)}
              </td>
            </tr>
          </tfoot>
        </table>
        <div class="border-t p-2 flex justify-end bg-muted/10">
          <Pagination bind:page={paymentsPage} {pageSize} totalItems={order?.payments.length ?? 0} />
        </div>
      </div>
    </div>

    {#if isOpen}
      <!-- Payment / close / cancel -->
      <div class="space-y-3 rounded-lg border bg-card p-4">
        <h2 class="text-sm font-semibold">{t("orderDetail.recordPayment")}</h2>
        <div class="flex items-end gap-2">
          <label class="flex-1 space-y-1">
            <span class="text-xs font-medium">{t("orderDetail.amountRp")}</span>
            <MoneyInput
              bind:value={payAmount}
              placeholder={String(Math.max(computed - paid, 0))}
              disabled={busy || !canEdit}
            />
          </label>
          <Button
            size="sm"
            disabled={busy || !canEdit || !payAmount}
            onclick={recordPayment}
          >
            {t("orderDetail.addPayment")}
          </Button>
        </div>
        <p class="text-xs text-muted-foreground">
          {t("orderDetail.paymentHelp")}
        </p>

        <div class="flex flex-wrap gap-2 border-t pt-3">
          <Button
            size="sm"
            disabled={busy || !canClose}
            onclick={closeSale}
          >
            {t("orderDetail.closeSale")}
          </Button>
          <Button
            size="sm"
            variant="destructive"
            disabled={busy || !canCancel}
            onclick={cancelSale}
          >
            {t("orderDetail.cancelSale")}
          </Button>
        </div>
        <p class="text-xs text-muted-foreground">
          {t("orderDetail.closeCancelHelp")}
        </p>
      </div>
    {/if}

    <!-- Send to customer -->
    <section class="space-y-3 rounded-lg border bg-card p-4">
      <div class="flex items-center justify-between">
        <h2 class="text-sm font-semibold">{t("orderDetail.sendToCustomer")}</h2>
        <Button
          variant="outline"
          size="sm"
          disabled={busy || !canSend || order.status === "cancelled"}
          onclick={startCompose}>{t("orderDetail.compose")}</Button
        >
      </div>

      {#if !composer}
        <p class="text-sm text-muted-foreground">
          {t("orderDetail.sendHint", { name: order.snapshotCustomerName ?? t("orderDetail.theCustomer") })}
        </p>
      {:else}
        <div class="space-y-3 rounded-md border bg-background p-4">
          <div class="grid grid-cols-2 gap-3">
            <label class="space-y-1">
              <span class="text-xs font-medium">{t("orderDetail.channel")}</span>
              <Select bind:value={composer.channel} onchange={previewSend}>
                {#each CHANNELS as c (c)}<option value={c}>{t(`orderDetail.channel.${c}`)}</option>{/each}
              </Select>
            </label>
            <label class="space-y-1">
              <span class="text-xs font-medium">
                {t("orderDetail.recipientOverride")}
                <span class="text-muted-foreground">({t("common.optional")})</span>
              </span>
              <Input
                bind:value={composer.recipientOverride}
                placeholder={composer.channel === "email"
                  ? t("orderDetail.customerEmail")
                  : t("orderDetail.customerPhone")}
                onblur={previewSend}
              />
            </label>
          </div>

          {#if composer.channel === "whatsapp"}
            <label class="space-y-1">
              <span class="text-xs font-medium">{t("orderDetail.format")}</span>
              <Select bind:value={composer.format}>
                <option value="text">{t("orderDetail.messageText")}</option>
                <option value="pdf">{t("orderDetail.pdfAttachment")}</option>
              </Select>
            </label>
          {/if}

          {#if previewing}
            <p class="text-sm text-muted-foreground">{t("orderDetail.renderingPreview")}</p>
          {:else if sendDraft}
            <div class="space-y-2">
              {#if composer.channel !== "manual"}
                {@const pdfMode =
                  composer.channel === "whatsapp" && composer.format === "pdf"}
                <p class="text-xs">
                  <span class="font-medium">{t("orderDetail.recipient")}</span>
                  {sendDraft.recipient ?? "—"}
                  {#if pdfMode}
                    <span class="text-muted-foreground"
                      >{t("orderDetail.pickContactShareSheet")}</span
                    >
                  {:else if !sendDraft.recipientAvailable}
                    <Badge class="ml-1 bg-amber-100 text-amber-800">
                      {sendDraft.recipient
                        ? t("orderDetail.unusableChannel")
                        : t("orderDetail.noneOnFile")}
                    </Badge>
                  {/if}
                </p>
              {/if}
              {#if composer.channel === "email"}
                <p class="text-xs">
                  <span class="font-medium">{t("orderDetail.subject")}</span>
                  {sendDraft.subject}
                </p>
              {/if}
              <Textarea
                value={sendDraft.body}
                readonly
                class="h-56 resize-none font-mono text-xs"
              />
            </div>

            <div class="flex flex-wrap items-center gap-2">
              {#if composer.channel === "manual"}
                <span class="text-xs text-muted-foreground">
                  {t("orderDetail.manualSendHint")}
                </span>
              {:else if composer.channel === "whatsapp" && composer.format === "pdf"}
                <Button size="sm" disabled={busy || sharing} onclick={sharePdf}>
                  {sharing ? t("orderDetail.preparingPdf") : t("orderDetail.sendPdfWhatsApp")}
                </Button>
                <span class="text-xs text-muted-foreground">
                  {t("orderDetail.attachPdfHint")}
                </span>
              {:else if sendDraft.deepLink}
                <a
                  href={sendDraft.deepLink}
                  target="_blank"
                  rel="noopener noreferrer"
                  class="inline-flex h-9 items-center rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground hover:bg-primary/90"
                >
                  {composer.channel === "whatsapp" ? t("orderDetail.openInWhatsApp") : t("orderDetail.openInEmail")}
                </a>
              {:else}
                <span class="text-xs text-muted-foreground">
                  {t("orderDetail.needRecipient", { channel: composer.channel })}
                </span>
              {/if}
              <a
                href={pdfHref}
                target="_blank"
                rel="noopener noreferrer"
                class="inline-flex h-9 items-center rounded-md border px-4 text-sm font-medium hover:bg-accent"
              >
                {t("orderDetail.downloadPdf")}
              </a>
            </div>
          {/if}

          <p class="text-xs text-muted-foreground">
            {t("orderDetail.sendDirectNote")}
          </p>
          <div class="flex justify-end">
            <Button
              variant="ghost"
              size="sm"
              disabled={busy}
              onclick={() => (composer = null)}>{t("common.close")}</Button
            >
          </div>
        </div>
      {/if}
    </section>
  {/if}
</div>
