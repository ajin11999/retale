// Receiving check service: the physical goods-in workflow. A receiving check
// is a resumable draft `purchase_delivery` tied to one purchase — staff count
// lines as a vendor's box is unpacked, the draft saves progress as they go,
// and committing hands off to the existing delivery-commit machinery (stock
// movements + WAC recompute). It is a thin, purchase-scoped layer over
// delivery-service: every check is a flat-cost-tree delivery whose leaves are
// the counted purchase lines. See docs/future-features.md → "Delivery
// completeness UI + API — receiving check".

import { and, eq, inArray, or } from "drizzle-orm";
import { purchaseDeliveries, purchaseDeliveryItems } from "../db/schema/deliveries.ts";
import { productVariants } from "../db/schema/products.ts";
import { purchaseItems, purchases } from "../db/schema/purchases.ts";
import { db } from "../lib/db.ts";
import * as deliveries from "./delivery-service.ts";
import { resolveVendorCode } from "./vendor-variant-code-service.ts";

export type ReceivingErrorCode =
  | "PURCHASE_NOT_FOUND"
  | "PURCHASE_NOT_OPEN"
  | "DELIVERY_NOT_FOUND"
  | "NOT_RECEIVING_CHECK"
  | "NOT_DRAFT"
  | "PURCHASE_ITEM_NOT_FOUND"
  | "WRONG_PURCHASE"
  | "INVALID_INPUT"
  | "OVER_DELIVERY";

export class ReceivingError extends Error {
  constructor(
    public code: ReceivingErrorCode,
    message?: string,
  ) {
    super(message ?? code);
    this.name = "ReceivingError";
  }
}

type Delivery = typeof purchaseDeliveries.$inferSelect;
type PurchaseItem = typeof purchaseItems.$inferSelect;

/** Today as `YYYY-MM-DD`, the delivery header's `date` format. */
function today(): string {
  return new Date().toISOString().slice(0, 10);
}

/** Load a delivery and assert it is a draft receiving check (purchaseId set). */
async function loadCheck(deliveryId: string): Promise<Delivery> {
  const delivery = await db.query.purchaseDeliveries.findFirst({
    where: eq(purchaseDeliveries.id, deliveryId),
  });
  if (!delivery) throw new ReceivingError("DELIVERY_NOT_FOUND");
  if (!delivery.purchaseId) {
    throw new ReceivingError(
      "NOT_RECEIVING_CHECK",
      "this delivery is not a receiving check",
    );
  }
  return delivery;
}

/** The open draft check for a purchase, or null if none is in progress. */
export function getOpenCheck(purchaseId: string): Promise<Delivery | undefined> {
  return db.query.purchaseDeliveries.findFirst({
    where: and(
      eq(purchaseDeliveries.purchaseId, purchaseId),
      eq(purchaseDeliveries.status, "draft"),
    ),
  });
}

/**
 * Start a receiving check for a purchase, or resume the one already open.
 * The single target location is fixed up front (design rule: one delivery →
 * one location). Only `open` purchases can be received — `complete` has
 * nothing left, `cancelled` is void.
 */
export async function startReceivingCheck(input: {
  purchaseId: string;
  targetLocationId: string;
  userId: string;
}): Promise<Delivery> {
  const purchase = await db.query.purchases.findFirst({
    where: eq(purchases.id, input.purchaseId),
  });
  if (!purchase) throw new ReceivingError("PURCHASE_NOT_FOUND");
  if (purchase.status !== "open") {
    throw new ReceivingError(
      "PURCHASE_NOT_OPEN",
      `purchase is ${purchase.status}; nothing to receive`,
    );
  }

  const existing = await getOpenCheck(input.purchaseId);
  if (existing) return existing;

  return deliveries.createDelivery({
    date: today(),
    targetLocationId: input.targetLocationId,
    purchaseId: input.purchaseId,
    createdByUserId: input.userId,
  });
}

/** The leaf of a check that receives against a given purchase line, if any. */
async function leafFor(
  deliveryId: string,
  purchaseItemId: string,
): Promise<typeof purchaseDeliveryItems.$inferSelect | undefined> {
  return db.query.purchaseDeliveryItems.findFirst({
    where: and(
      eq(purchaseDeliveryItems.deliveryId, deliveryId),
      eq(purchaseDeliveryItems.purchaseItemId, purchaseItemId),
    ),
  });
}

/**
 * Upsert one counted line in a check — the save-as-you-go primitive. `qty` is
 * what is in *this* box, in the variant's smallest unit; `qty = 0` removes the
 * line. Rejects counting past what is still owed on the purchase line.
 */
export async function setReceivingCheckLine(input: {
  deliveryId: string;
  purchaseItemId: string;
  qty: number;
}): Promise<Delivery> {
  const delivery = await loadCheck(input.deliveryId);
  if (delivery.status !== "draft") {
    throw new ReceivingError("NOT_DRAFT", "the check has already been committed");
  }
  if (!Number.isInteger(input.qty) || input.qty < 0) {
    throw new ReceivingError("INVALID_INPUT", "qty must be a non-negative integer");
  }

  const pi = await db.query.purchaseItems.findFirst({
    where: eq(purchaseItems.id, input.purchaseItemId),
  });
  if (!pi) throw new ReceivingError("PURCHASE_ITEM_NOT_FOUND");
  if (pi.purchaseId !== delivery.purchaseId) {
    throw new ReceivingError(
      "WRONG_PURCHASE",
      "purchase line belongs to a different purchase",
    );
  }

  const existing = await leafFor(input.deliveryId, input.purchaseItemId);

  if (input.qty === 0) {
    if (existing) await deliveries.deleteDeliveryItem(existing.id);
    return deliveries.getDelivery(input.deliveryId);
  }

  if (pi.qtyDelivered + input.qty > pi.qtyOrdered) {
    throw new ReceivingError(
      "OVER_DELIVERY",
      `counting ${input.qty} would exceed the ${pi.qtyOrdered - pi.qtyDelivered} still owed`,
    );
  }

  // Cost just flows from the PO line — a receiving check counts quantity, not
  // money. The delivery commit needs a positive costMinor to derive unit cost.
  const costMinor = pi.unitCostMinor * input.qty;

  if (existing) {
    await deliveries.updateDeliveryItem(existing.id, { qty: input.qty, costMinor });
  } else {
    await deliveries.createDeliveryItem({
      deliveryId: input.deliveryId,
      purchaseItemId: input.purchaseItemId,
      description: await lineLabel(pi),
      qty: input.qty,
      costMinor,
      sortOrder: pi.sortOrder,
    });
  }
  return deliveries.getDelivery(input.deliveryId);
}

/** A human label for a check leaf — the PO line text, else the variant SKU. */
async function lineLabel(pi: PurchaseItem): Promise<string> {
  if (pi.description?.trim()) return pi.description.trim();
  if (pi.variantId) {
    const variant = await db.query.productVariants.findFirst({
      where: eq(productVariants.id, pi.variantId),
    });
    if (variant) return variant.label?.trim() || variant.sku;
  }
  return "Receiving line";
}

/**
 * Resolve a scanned code to the purchase line(s) it counts against. The code
 * is matched against our own variant barcode / SKU, and — when the purchase
 * has a vendor — against that vendor's part numbers (`vendor_variant_codes`),
 * so a scan of the vendor's own label on the box resolves. More than one
 * result means the same variant appears on several lines and staff must pick.
 * Non-stock lines (no variant) have no code and are never returned here.
 */
export async function resolveReceivingScan(
  purchaseId: string,
  code: string,
): Promise<PurchaseItem[]> {
  const trimmed = code.trim();
  if (!trimmed) throw new ReceivingError("INVALID_INPUT", "scan code is empty");

  const purchase = await db.query.purchases.findFirst({
    where: eq(purchases.id, purchaseId),
  });
  if (!purchase) throw new ReceivingError("PURCHASE_NOT_FOUND");

  const ownMatches = await db
    .select({ id: productVariants.id })
    .from(productVariants)
    .where(
      or(eq(productVariants.barcode, trimmed), eq(productVariants.sku, trimmed)),
    );
  const variantIds = new Set(ownMatches.map((v) => v.id));

  if (purchase.vendorId) {
    for (const vid of await resolveVendorCode(purchase.vendorId, trimmed)) {
      variantIds.add(vid);
    }
  }
  if (variantIds.size === 0) return [];

  return db
    .select()
    .from(purchaseItems)
    .where(
      and(
        eq(purchaseItems.purchaseId, purchaseId),
        inArray(purchaseItems.variantId, [...variantIds]),
      ),
    );
}

/**
 * Commit a receiving check: draft → delivered via the existing delivery
 * commit (stock movements, WAC recompute, purchase completion). The
 * partial-delivery constraint is re-validated inside that transaction.
 */
export async function commitReceivingCheck(
  deliveryId: string,
  userId: string,
): Promise<Delivery> {
  const delivery = await loadCheck(deliveryId);
  if (delivery.status !== "draft") {
    throw new ReceivingError("NOT_DRAFT", "the check has already been committed");
  }
  return deliveries.commitDelivery(deliveryId, userId);
}

/** Completeness of a line, from committed delivery state vs. ordered qty. */
export type ReceivingLineStatus = "not_started" | "partial" | "complete";

export function lineStatus(delivered: number, ordered: number): ReceivingLineStatus {
  if (delivered <= 0) return "not_started";
  if (delivered >= ordered) return "complete";
  return "partial";
}

/** A purchase line as the receiving screen sees it, with the draft folded in. */
export interface ReceivingCheckLine {
  purchaseItem: PurchaseItem;
  qtyOrdered: number;
  qtyDelivered: number;
  remaining: number;
  /** Qty staged in the current draft check (this box), 0 if untouched. */
  qtyInCheck: number;
  /** Completeness from committed deliveries only. */
  status: ReceivingLineStatus;
  /** Completeness once the draft is committed — folds in `qtyInCheck`. */
  provisionalStatus: ReceivingLineStatus;
}

/**
 * The receiving screen's line list for a purchase: every purchase line with
 * ordered / delivered / remaining and both committed and provisional status.
 * `deliveryId` is the open draft check, if one is in progress.
 */
export async function getReceivingCheckLines(
  purchaseId: string,
): Promise<ReceivingCheckLine[]> {
  const purchase = await db.query.purchases.findFirst({
    where: eq(purchases.id, purchaseId),
  });
  if (!purchase) throw new ReceivingError("PURCHASE_NOT_FOUND");

  const lines = await db
    .select()
    .from(purchaseItems)
    .where(eq(purchaseItems.purchaseId, purchaseId))
    .orderBy(purchaseItems.sortOrder);

  const check = await getOpenCheck(purchaseId);
  const stagedByItem = new Map<string, number>();
  if (check) {
    const items = await deliveries.listDeliveryItems(check.id);
    for (const it of items) {
      if (it.purchaseItemId && it.qty != null) {
        stagedByItem.set(
          it.purchaseItemId,
          (stagedByItem.get(it.purchaseItemId) ?? 0) + it.qty,
        );
      }
    }
  }

  return lines.map((pi) => {
    const qtyInCheck = stagedByItem.get(pi.id) ?? 0;
    return {
      purchaseItem: pi,
      qtyOrdered: pi.qtyOrdered,
      qtyDelivered: pi.qtyDelivered,
      remaining: pi.qtyOrdered - pi.qtyDelivered,
      qtyInCheck,
      status: lineStatus(pi.qtyDelivered, pi.qtyOrdered),
      provisionalStatus: lineStatus(pi.qtyDelivered + qtyInCheck, pi.qtyOrdered),
    };
  });
}
