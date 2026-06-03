// Deliveries service: draft a goods receipt, edit its hierarchical cost tree,
// then commit it — the one transaction that turns a purchase order into stock.
// Commit emits `purchase_receive` movements (which recompute WAC), advances
// `purchase_items.qty_delivered`, and completes fully-received purchases.
// Cancelling a delivered delivery reverses the stock without re-valuing WAC.
// See docs/design-decisions.md → "Delivery commit".

import { and, asc, desc, eq, sql } from "drizzle-orm";
import { ulid } from "ulid";
import {
  purchaseDeliveries,
  purchaseDeliveryItems,
} from "../db/schema/deliveries.ts";
import { locations } from "../db/schema/locations.ts";
import { productVariants } from "../db/schema/products.ts";
import { purchaseItems, purchases } from "../db/schema/purchases.ts";
import { vendors } from "../db/schema/vendors.ts";
import { db } from "../lib/db.ts";
import { recordMovement } from "./stock-service.ts";
import {
  postPurchaseOnAccount,
  reverseDeliveryCharges,
} from "./vendor-service.ts";

export type DeliveryErrorCode =
  | "DELIVERY_NOT_FOUND"
  | "ITEM_NOT_FOUND"
  | "LOCATION_NOT_FOUND"
  | "PURCHASE_ITEM_NOT_FOUND"
  | "INVALID_INPUT"
  | "NOT_DRAFT"
  | "NOT_DELIVERED"
  | "OVER_DELIVERY"
  | "EMPTY_DELIVERY"
  | "HAS_CHILDREN";

export class DeliveryError extends Error {
  constructor(
    public code: DeliveryErrorCode,
    message?: string,
  ) {
    super(message ?? code);
    this.name = "DeliveryError";
  }
}

type Delivery = typeof purchaseDeliveries.$inferSelect;
type DeliveryItem = typeof purchaseDeliveryItems.$inferSelect;

/** A drizzle transaction handle; structurally a subset of `db`. */
type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

// --- Loads ---

async function loadDelivery(id: string): Promise<Delivery> {
  const row = await db.query.purchaseDeliveries.findFirst({
    where: eq(purchaseDeliveries.id, id),
  });
  if (!row) throw new DeliveryError("DELIVERY_NOT_FOUND");
  return row;
}

export { loadDelivery as getDelivery };

async function loadItem(id: string): Promise<DeliveryItem> {
  const row = await db.query.purchaseDeliveryItems.findFirst({
    where: eq(purchaseDeliveryItems.id, id),
  });
  if (!row) throw new DeliveryError("ITEM_NOT_FOUND");
  return row;
}

function assertDraft(d: Delivery): void {
  if (d.status !== "draft") {
    throw new DeliveryError("NOT_DRAFT", "delivery is no longer a draft");
  }
}

/** Recompute `totalCostMinor` from the tree's root nodes (parentItemId IS NULL). */
async function syncTotal(tx: Tx, deliveryId: string): Promise<void> {
  const rows = await tx
    .select({ total: sql<number>`COALESCE(SUM(${purchaseDeliveryItems.costMinor}), 0)` })
    .from(purchaseDeliveryItems)
    .where(
      and(
        eq(purchaseDeliveryItems.deliveryId, deliveryId),
        sql`${purchaseDeliveryItems.parentItemId} is null`,
      ),
    );
  await tx
    .update(purchaseDeliveries)
    .set({ totalCostMinor: Number(rows[0]?.total ?? 0) })
    .where(eq(purchaseDeliveries.id, deliveryId));
}

// --- Header ---

export function listDeliveries(status?: Delivery["status"]): Promise<Delivery[]> {
  return db
    .select()
    .from(purchaseDeliveries)
    .where(status ? eq(purchaseDeliveries.status, status) : undefined)
    .orderBy(desc(purchaseDeliveries.date), desc(purchaseDeliveries.createdAt));
}

export async function createDelivery(input: {
  date: string;
  biller?: string | null;
  targetLocationId: string;
  /** Set only when the delivery is a receiving check for a single purchase. */
  purchaseId?: string | null;
  createdByUserId: string;
}): Promise<Delivery> {
  if (!input.date?.trim()) throw new DeliveryError("INVALID_INPUT", "date is required");
  const location = await db.query.locations.findFirst({
    where: eq(locations.id, input.targetLocationId),
  });
  if (!location) throw new DeliveryError("LOCATION_NOT_FOUND");

  const id = ulid();
  await db.insert(purchaseDeliveries).values({
    id,
    date: input.date,
    biller: input.biller ?? null,
    targetLocationId: input.targetLocationId,
    purchaseId: input.purchaseId ?? null,
    createdByUserId: input.createdByUserId,
  });
  return loadDelivery(id);
}

/** Edit the delivery header. Allowed only while the delivery is a draft. */
export async function updateDelivery(
  id: string,
  patch: { date?: string; biller?: string | null; targetLocationId?: string },
): Promise<Delivery> {
  const delivery = await loadDelivery(id);
  assertDraft(delivery);

  if (patch.date !== undefined && !patch.date.trim()) {
    throw new DeliveryError("INVALID_INPUT", "date cannot be blank");
  }
  if (patch.targetLocationId !== undefined) {
    const location = await db.query.locations.findFirst({
      where: eq(locations.id, patch.targetLocationId),
    });
    if (!location) throw new DeliveryError("LOCATION_NOT_FOUND");
  }

  await db
    .update(purchaseDeliveries)
    .set({
      ...(patch.date !== undefined && { date: patch.date }),
      ...(patch.biller !== undefined && { biller: patch.biller }),
      ...(patch.targetLocationId !== undefined && {
        targetLocationId: patch.targetLocationId,
      }),
    })
    .where(eq(purchaseDeliveries.id, id));
  return loadDelivery(id);
}

/** Discard a draft delivery. Its cost tree cascade-deletes. Drafts only. */
export async function deleteDelivery(id: string): Promise<void> {
  const delivery = await loadDelivery(id);
  assertDraft(delivery);
  await db.delete(purchaseDeliveries).where(eq(purchaseDeliveries.id, id));
}

// --- Cost tree ---

export async function createDeliveryItem(input: {
  deliveryId: string;
  parentItemId?: string | null;
  purchaseItemId?: string | null;
  description: string;
  qty?: number | null;
  costMinor: number;
  /** Expedition this cost node is owed to. Cost nodes (no purchaseItemId) only. */
  vendorId?: string | null;
  sortOrder?: number;
}): Promise<DeliveryItem> {
  const delivery = await loadDelivery(input.deliveryId);
  assertDraft(delivery);
  if (!input.description.trim()) {
    throw new DeliveryError("INVALID_INPUT", "description is required");
  }
  if (!Number.isInteger(input.costMinor) || input.costMinor < 0) {
    throw new DeliveryError("INVALID_INPUT", "costMinor must be a non-negative integer");
  }
  if (input.parentItemId) {
    const parent = await loadItem(input.parentItemId);
    if (parent.deliveryId !== input.deliveryId) {
      throw new DeliveryError("INVALID_INPUT", "parent belongs to a different delivery");
    }
    // Only a cost node can group children; a goods leaf is terminal. This keeps
    // the cost tree well-formed for subtree freight allocation.
    if (parent.purchaseItemId != null) {
      throw new DeliveryError(
        "INVALID_INPUT",
        "cannot nest a line under a goods leaf — only cost nodes can group",
      );
    }
  }
  // A leaf points at a purchase line and needs a positive qty; a grouping
  // node has neither.
  if (input.purchaseItemId) {
    const pi = await db.query.purchaseItems.findFirst({
      where: eq(purchaseItems.id, input.purchaseItemId),
    });
    if (!pi) throw new DeliveryError("PURCHASE_ITEM_NOT_FOUND");
    if (input.qty == null || !Number.isInteger(input.qty) || input.qty <= 0) {
      throw new DeliveryError("INVALID_INPUT", "a leaf (purchaseItemId set) needs a positive qty");
    }
  } else if (input.qty != null) {
    throw new DeliveryError("INVALID_INPUT", "qty is only valid on a leaf with a purchaseItemId");
  }
  // A courier only makes sense on a freight/customs cost node, not a goods leaf.
  if (input.vendorId && input.purchaseItemId) {
    throw new DeliveryError(
      "INVALID_INPUT",
      "a courier (vendorId) is only valid on a cost node, not a goods leaf",
    );
  }

  const id = ulid();
  await db.transaction(async (tx) => {
    await tx.insert(purchaseDeliveryItems).values({
      id,
      deliveryId: input.deliveryId,
      parentItemId: input.parentItemId ?? null,
      purchaseItemId: input.purchaseItemId ?? null,
      vendorId: input.purchaseItemId ? null : (input.vendorId ?? null),
      description: input.description.trim(),
      qty: input.purchaseItemId ? (input.qty as number) : null,
      costMinor: input.costMinor,
      sortOrder: input.sortOrder ?? 0,
    });
    await syncTotal(tx, input.deliveryId);
  });
  return loadItem(id);
}

/** Edit a cost-tree node. Draft deliveries only. */
export async function updateDeliveryItem(
  id: string,
  patch: {
    description?: string;
    qty?: number | null;
    costMinor?: number;
    vendorId?: string | null;
    sortOrder?: number;
  },
): Promise<DeliveryItem> {
  const item = await loadItem(id);
  const delivery = await loadDelivery(item.deliveryId);
  assertDraft(delivery);

  if (patch.description !== undefined && !patch.description.trim()) {
    throw new DeliveryError("INVALID_INPUT", "description cannot be blank");
  }
  if (
    patch.costMinor !== undefined &&
    (!Number.isInteger(patch.costMinor) || patch.costMinor < 0)
  ) {
    throw new DeliveryError("INVALID_INPUT", "costMinor must be a non-negative integer");
  }
  if (patch.qty !== undefined) {
    if (!item.purchaseItemId) {
      throw new DeliveryError("INVALID_INPUT", "qty is only valid on a leaf");
    }
    if (patch.qty == null || !Number.isInteger(patch.qty) || patch.qty <= 0) {
      throw new DeliveryError("INVALID_INPUT", "leaf qty must be a positive integer");
    }
  }
  if (patch.vendorId != null && item.purchaseItemId) {
    throw new DeliveryError(
      "INVALID_INPUT",
      "a courier (vendorId) is only valid on a cost node, not a goods leaf",
    );
  }

  await db.transaction(async (tx) => {
    await tx
      .update(purchaseDeliveryItems)
      .set({
        ...(patch.description !== undefined && { description: patch.description.trim() }),
        ...(patch.qty !== undefined && { qty: patch.qty }),
        ...(patch.costMinor !== undefined && { costMinor: patch.costMinor }),
        ...(patch.vendorId !== undefined && { vendorId: patch.vendorId }),
        ...(patch.sortOrder !== undefined && { sortOrder: patch.sortOrder }),
      })
      .where(eq(purchaseDeliveryItems.id, id));
    await syncTotal(tx, item.deliveryId);
  });
  return loadItem(id);
}

/** Delete a cost-tree node; children reparent to its parent. Draft deliveries only. */
export async function deleteDeliveryItem(id: string): Promise<void> {
  const item = await loadItem(id);
  const delivery = await loadDelivery(item.deliveryId);
  assertDraft(delivery);

  await db.transaction(async (tx) => {
    await tx
      .update(purchaseDeliveryItems)
      .set({ parentItemId: item.parentItemId })
      .where(eq(purchaseDeliveryItems.parentItemId, id));
    await tx.delete(purchaseDeliveryItems).where(eq(purchaseDeliveryItems.id, id));
    await syncTotal(tx, item.deliveryId);
  });
}

export function listDeliveryItems(deliveryId: string): Promise<DeliveryItem[]> {
  return db
    .select()
    .from(purchaseDeliveryItems)
    .where(eq(purchaseDeliveryItems.deliveryId, deliveryId))
    .orderBy(asc(purchaseDeliveryItems.sortOrder));
}

/** Per-leaf landed cost preview — what `commitDelivery` will receive stock at. */
export interface LeafLanding {
  itemId: string;
  qty: number;
  /** The leaf's own line value (vendor cost × qty). */
  baseCostMinor: number;
  /** This leaf's value-weighted share of the freight / customs nodes. */
  freightMinor: number;
  /** baseCostMinor + freightMinor — the total cost capitalized into stock. */
  landedCostMinor: number;
  /** landedCostMinor / qty — the unit cost that feeds WAC on commit. */
  landedUnitCostMinor: number;
  /** False for a non-stock leaf (no variant) — excluded from freight. */
  isStock: boolean;
}

/**
 * Compute each leaf's landed cost for the editor preview, using the exact same
 * apportionment `commitDelivery` applies — so what the clerk sees is what the
 * commit will write. Non-leaf cost nodes (freight/customs) produce no row.
 */
export async function deliveryLeafLandings(deliveryId: string): Promise<LeafLanding[]> {
  const items = await db
    .select()
    .from(purchaseDeliveryItems)
    .where(eq(purchaseDeliveryItems.deliveryId, deliveryId))
    .orderBy(asc(purchaseDeliveryItems.sortOrder));
  const leaves = items.filter((i) => i.purchaseItemId != null);

  const lines = new Map<string, typeof purchaseItems.$inferSelect>();
  for (const pid of new Set(leaves.map((l) => l.purchaseItemId as string))) {
    const pi = await db.query.purchaseItems.findFirst({
      where: eq(purchaseItems.id, pid),
    });
    if (pi) lines.set(pid, pi);
  }

  const freightByLeaf = allocateFreightByValue(items, leaves, lines);
  return leaves.map((l) => {
    const qty = l.qty ?? 0;
    const freight = freightByLeaf.get(l.id) ?? 0;
    const landed = l.costMinor + freight;
    return {
      itemId: l.id,
      qty,
      baseCostMinor: l.costMinor,
      freightMinor: freight,
      landedCostMinor: landed,
      landedUnitCostMinor: qty > 0 ? Math.round(landed / qty) : 0,
      isStock: lines.get(l.purchaseItemId as string)?.variantId != null,
    };
  });
}

// --- Commit & cancel ---

/** Sum the leaf quantities of a delivery, keyed by purchase_item_id. */
function leafQtyByPurchaseItem(leaves: DeliveryItem[]): Map<string, number> {
  const byItem = new Map<string, number>();
  for (const leaf of leaves) {
    const pid = leaf.purchaseItemId as string;
    byItem.set(pid, (byItem.get(pid) ?? 0) + (leaf.qty as number));
  }
  return byItem;
}

/**
 * Apportion the delivery's cost nodes — every item with no `purchaseItemId`,
 * i.e. the freight / customs / grouping rows — onto the stock leaves, in
 * proportion to each leaf's line value (its own `costMinor`). This is the
 * landed-cost step: a product's received unit cost carries its share of the
 * delivery cost.
 *
 * Scope follows the cost tree. A cost node's cost spreads only over the stock
 * leaves **in its own subtree** — so nesting goods under a "Carton freight"
 * node confines that charge to those goods (the carton's Rp40k over its 24
 * bottles), while a broad "Customs" node wrapping everything spreads over all
 * of it. A leaf nested under several cost nodes carries each one's share. As a
 * convenience, a cost node with **no** goods in its subtree (a loose charge, or
 * one sitting as a sibling of flat leaves — the receiving-check shape) is
 * treated as delivery-wide and spreads over every stock leaf.
 *
 * Non-stock leaves (`variantId` null) are excluded everywhere — freight
 * capitalizes into goods of resale only (design-decisions.md → landed cost).
 * Largest-remainder rounding spreads each node to the cent. Returns the freight
 * minor units to add on top of each leaf's base cost, keyed by leaf id.
 */
function allocateFreightByValue(
  items: DeliveryItem[],
  leaves: DeliveryItem[],
  lines: Map<string, typeof purchaseItems.$inferSelect>,
): Map<string, number> {
  const out = new Map<string, number>();
  const isStock = (l: DeliveryItem) =>
    lines.get(l.purchaseItemId as string)?.variantId != null;
  const stockLeaves = leaves.filter(isStock);
  for (const l of stockLeaves) out.set(l.id, 0);
  if (stockLeaves.length === 0) return out;

  // parent id → child items, to walk a cost node's subtree.
  const childrenOf = new Map<string | null, DeliveryItem[]>();
  for (const it of items) {
    const key = it.parentItemId ?? null;
    const list = childrenOf.get(key);
    if (list) list.push(it);
    else childrenOf.set(key, [it]);
  }

  /** The stock leaves anywhere beneath `nodeId` (transitive). */
  function subtreeStockLeaves(nodeId: string): DeliveryItem[] {
    const acc: DeliveryItem[] = [];
    const walk = (id: string) => {
      for (const child of childrenOf.get(id) ?? []) {
        if (child.purchaseItemId != null) {
          if (isStock(child)) acc.push(child);
        } else {
          walk(child.id);
        }
      }
    };
    walk(nodeId);
    return acc;
  }

  // Spread one cost node's pool over a set of leaves by value, adding to `out`.
  const spread = (pool: number, targets: DeliveryItem[]) => {
    const base = targets.reduce((sum, l) => sum + l.costMinor, 0);
    if (pool <= 0 || base <= 0) return;
    const remainders: { id: string; rem: number }[] = [];
    let handed = 0;
    for (const l of targets) {
      const exact = (pool * l.costMinor) / base;
      const floor = Math.floor(exact);
      out.set(l.id, (out.get(l.id) ?? 0) + floor);
      remainders.push({ id: l.id, rem: exact - floor });
      handed += floor;
    }
    // Hand the leftover cents to the largest fractional shares first; the
    // leftover is always < the leaf count, so one pass over the top suffices.
    remainders.sort((a, b) => b.rem - a.rem);
    for (const { id } of remainders.slice(0, pool - handed)) {
      out.set(id, (out.get(id) ?? 0) + 1);
    }
  };

  for (const node of items) {
    if (node.purchaseItemId != null || node.costMinor <= 0) continue;
    const scoped = subtreeStockLeaves(node.id);
    spread(node.costMinor, scoped.length > 0 ? scoped : stockLeaves);
  }
  return out;
}

/** Re-evaluate every touched purchase: open ⇄ complete based on item delivery state. */
async function refreshPurchaseStatuses(tx: Tx, purchaseIds: Set<string>): Promise<void> {
  for (const pid of purchaseIds) {
    const items = await tx
      .select()
      .from(purchaseItems)
      .where(eq(purchaseItems.purchaseId, pid));
    const allDelivered = items.every((i) => i.qtyDelivered >= i.qtyOrdered);
    await tx
      .update(purchases)
      .set({ status: allDelivered ? "complete" : "open" })
      .where(
        and(
          eq(purchases.id, pid),
          eq(purchases.status, allDelivered ? "open" : "complete"),
        ),
      );
  }
}

/** Add `days` to a `YYYY-MM-DD` date string, returning `YYYY-MM-DD`. */
function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/**
 * Raise accounts payable for a committed delivery. The cost tree already splits
 * the two parties we owe: each leaf's base cost (vendor price × qty) is owed to
 * its purchase's supplier, and each freight/customs cost node tagged with a
 * `vendorId` is owed to that expedition. Ad-hoc purchases (null vendor) and
 * untagged freight raise no AP. A charge's due date is the delivery date plus
 * the vendor's net terms. Runs inside the commit transaction.
 */
async function postDeliveryAccountsPayable(
  tx: Tx,
  delivery: Delivery,
  items: DeliveryItem[],
  leaves: DeliveryItem[],
  lines: Map<string, typeof purchaseItems.$inferSelect>,
  userId: string,
): Promise<void> {
  // Supplier AP: each leaf's base cost, summed by the purchase's vendor.
  const purchaseVendor = new Map<string, string | null>();
  for (const pid of new Set([...lines.values()].map((pi) => pi.purchaseId))) {
    const p = await tx.query.purchases.findFirst({ where: eq(purchases.id, pid) });
    purchaseVendor.set(pid, p?.vendorId ?? null);
  }

  const owedByVendor = new Map<string, number>();
  const add = (vendorId: string, amount: number) =>
    owedByVendor.set(vendorId, (owedByVendor.get(vendorId) ?? 0) + amount);

  for (const leaf of leaves) {
    const pi = lines.get(leaf.purchaseItemId as string);
    if (!pi) continue;
    const vId = purchaseVendor.get(pi.purchaseId);
    if (vId) add(vId, leaf.costMinor);
  }

  // Courier AP: every cost node (no purchaseItemId) tagged with an expedition.
  for (const node of items) {
    if (node.purchaseItemId == null && node.vendorId && node.costMinor > 0) {
      add(node.vendorId, node.costMinor);
    }
  }
  if (owedByVendor.size === 0) return;

  // Each charge's due date needs the vendor's net terms (null = due on receipt).
  for (const [vendorId, amountMinor] of owedByVendor) {
    const v = await tx.query.vendors.findFirst({ where: eq(vendors.id, vendorId) });
    await postPurchaseOnAccount(tx, {
      vendorId,
      amountMinor,
      deliveryId: delivery.id,
      dueDate: addDays(delivery.date, v?.paymentTermsDays ?? 0),
      createdByUserId: userId,
    });
  }
}

/**
 * Commit a draft delivery. In one transaction: validate the partial-delivery
 * constraint per line, emit a `purchase_receive` movement for every stock leaf
 * (non-stock lines are receipt-only), advance `qty_delivered`, complete any
 * fully-received purchase, raise accounts payable to the supplier(s) and any
 * tagged expedition, and stamp the delivery `delivered`.
 */
export async function commitDelivery(id: string, userId: string): Promise<Delivery> {
  return db.transaction(async (tx) => {
    const delivery = await tx.query.purchaseDeliveries.findFirst({
      where: eq(purchaseDeliveries.id, id),
    });
    if (!delivery) throw new DeliveryError("DELIVERY_NOT_FOUND");
    if (delivery.status !== "draft") {
      throw new DeliveryError("NOT_DRAFT", "only a draft delivery can be committed");
    }

    const items = await tx
      .select()
      .from(purchaseDeliveryItems)
      .where(eq(purchaseDeliveryItems.deliveryId, id));
    const leaves = items.filter((i) => i.purchaseItemId != null);
    if (leaves.length === 0) {
      throw new DeliveryError("EMPTY_DELIVERY", "delivery has no lines to receive");
    }
    for (const leaf of leaves) {
      if (leaf.qty == null || leaf.qty <= 0) {
        throw new DeliveryError("INVALID_INPUT", `leaf ${leaf.id} has no positive qty`);
      }
    }

    // Load every referenced purchase line once.
    const byItem = leafQtyByPurchaseItem(leaves);
    const lines = new Map<string, typeof purchaseItems.$inferSelect>();
    for (const pid of byItem.keys()) {
      const pi = await tx.query.purchaseItems.findFirst({
        where: eq(purchaseItems.id, pid),
      });
      if (!pi) throw new DeliveryError("PURCHASE_ITEM_NOT_FOUND", pid);
      lines.set(pid, pi);
    }

    // 1. Partial-delivery constraint: cannot deliver more than ordered.
    for (const [pid, sumQty] of byItem) {
      const pi = lines.get(pid) as typeof purchaseItems.$inferSelect;
      if (pi.qtyDelivered + sumQty > pi.qtyOrdered) {
        throw new DeliveryError(
          "OVER_DELIVERY",
          `line ${pid}: ${pi.qtyDelivered}+${sumQty} exceeds ordered ${pi.qtyOrdered}`,
        );
      }
    }

    // Landed cost: spread the delivery's freight / customs nodes over the
    // stock leaves by line value, so each product's received unit cost carries
    // its share of the delivery cost.
    const freightByLeaf = allocateFreightByValue(items, leaves, lines);

    // 2 & 3. One purchase_receive movement per stock leaf; WAC recomputes
    // inside recordMovement. Non-stock lines (variantId null) are skipped.
    for (const leaf of leaves) {
      const pi = lines.get(leaf.purchaseItemId as string);
      if (!pi?.variantId) continue;
      const qty = leaf.qty as number;
      const landed = leaf.costMinor + (freightByLeaf.get(leaf.id) ?? 0);
      await recordMovement(
        {
          variantId: pi.variantId,
          locationId: delivery.targetLocationId,
          type: "purchase_receive",
          qtyDelta: qty,
          unitCost: Math.round(landed / qty),
          refType: "purchase",
          refId: delivery.id,
          createdByUserId: userId,
        },
        tx,
      );
    }

    // 4. Advance the denormalized qty_delivered on each line.
    for (const [pid, sumQty] of byItem) {
      await tx
        .update(purchaseItems)
        .set({ qtyDelivered: sql`${purchaseItems.qtyDelivered} + ${sumQty}` })
        .where(eq(purchaseItems.id, pid));
    }

    // 5. Complete any purchase whose lines are now all fully delivered.
    const purchaseIds = new Set([...lines.values()].map((pi) => pi.purchaseId));
    await refreshPurchaseStatuses(tx, purchaseIds);

    // 6. Raise AP: goods to the supplier(s), tagged freight to the expedition.
    await postDeliveryAccountsPayable(tx, delivery, items, leaves, lines, userId);

    // 7. Stamp the delivery delivered.
    await tx
      .update(purchaseDeliveries)
      .set({ status: "delivered", deliveredAt: new Date(), deliveredByUserId: userId })
      .where(eq(purchaseDeliveries.id, id));

    const row = await tx.query.purchaseDeliveries.findFirst({
      where: eq(purchaseDeliveries.id, id),
    });
    return row as Delivery;
  });
}

/**
 * Cancel a delivered delivery (root only). Reverses each `purchase_receive`
 * with an `adjustment_out` — stock returns but WAC is deliberately NOT
 * re-valued (the "gist accuracy" rule; use `cost_override` if it matters).
 * `qty_delivered` is rolled back and completed purchases reopen.
 */
export async function cancelDelivery(id: string, userId: string): Promise<Delivery> {
  return db.transaction(async (tx) => {
    const delivery = await tx.query.purchaseDeliveries.findFirst({
      where: eq(purchaseDeliveries.id, id),
    });
    if (!delivery) throw new DeliveryError("DELIVERY_NOT_FOUND");
    if (delivery.status !== "delivered") {
      throw new DeliveryError("NOT_DELIVERED", "only a delivered delivery can be cancelled");
    }

    const items = await tx
      .select()
      .from(purchaseDeliveryItems)
      .where(eq(purchaseDeliveryItems.deliveryId, id));
    const leaves = items.filter((i) => i.purchaseItemId != null && i.qty != null);
    const byItem = leafQtyByPurchaseItem(leaves);

    const lines = new Map<string, typeof purchaseItems.$inferSelect>();
    for (const pid of byItem.keys()) {
      const pi = await tx.query.purchaseItems.findFirst({
        where: eq(purchaseItems.id, pid),
      });
      if (pi) lines.set(pid, pi);
    }

    // Reverse the stock with non-cost-affecting outbound movements.
    for (const leaf of leaves) {
      const pi = lines.get(leaf.purchaseItemId as string);
      if (!pi?.variantId) continue;
      const variant = await tx.query.productVariants.findFirst({
        where: eq(productVariants.id, pi.variantId),
      });
      await recordMovement(
        {
          variantId: pi.variantId,
          locationId: delivery.targetLocationId,
          type: "adjustment_out",
          qtyDelta: -(leaf.qty as number),
          unitCost: variant?.costMinor ?? 0,
          refType: "purchase",
          refId: delivery.id,
          reason: "delivery cancelled",
          createdByUserId: userId,
        },
        tx,
      );
    }

    // Roll back qty_delivered on each line.
    for (const [pid, sumQty] of byItem) {
      if (!lines.has(pid)) continue;
      await tx
        .update(purchaseItems)
        .set({ qtyDelivered: sql`${purchaseItems.qtyDelivered} - ${sumQty}` })
        .where(eq(purchaseItems.id, pid));
    }

    // Reopen any purchase that is no longer fully delivered.
    const purchaseIds = new Set([...lines.values()].map((pi) => pi.purchaseId));
    await refreshPurchaseStatuses(tx, purchaseIds);

    // Reverse the AP this delivery raised (supplier + any expedition).
    await reverseDeliveryCharges(tx, id, userId);

    await tx
      .update(purchaseDeliveries)
      .set({ status: "cancelled" })
      .where(eq(purchaseDeliveries.id, id));

    const row = await tx.query.purchaseDeliveries.findFirst({
      where: eq(purchaseDeliveries.id, id),
    });
    return row as Delivery;
  });
}
