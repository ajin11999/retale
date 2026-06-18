// Deliveries service: draft a goods receipt, edit its hierarchical cost tree,
// then commit it — the one transaction that turns a purchase order into stock.
// Commit emits `purchase_receive` movements (which recompute WAC), advances
// `purchase_items.qty_delivered`, and completes fully-received purchases.
// Cancelling a delivered delivery reverses the stock without re-valuing WAC.
// See docs/design-decisions.md → "Delivery commit".

import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import { ulid } from "ulid";
import {
  purchaseDeliveries,
  purchaseDeliveryItems,
} from "../db/schema/deliveries.ts";
import { locations } from "../db/schema/locations.ts";
import { productVariants, products } from "../db/schema/products.ts";
import { purchaseItems, purchases } from "../db/schema/purchases.ts";
import { vendors } from "../db/schema/vendors.ts";
import { db } from "../lib/db.ts";
import { allocateProportional, isMoney, roundMoney } from "../lib/money.ts";
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
  | "HAS_CHILDREN"
  | "BUNDLE_NOT_STOCKED";

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

type PurchaseItemRow = typeof purchaseItems.$inferSelect;

/** Batch-load purchase lines by id into a map, in one query. */
async function loadPurchaseItemsByIds(
  exec: typeof db | Tx,
  ids: string[],
): Promise<Map<string, PurchaseItemRow>> {
  const map = new Map<string, PurchaseItemRow>();
  if (ids.length === 0) return map;
  const rows = await exec
    .select()
    .from(purchaseItems)
    .where(inArray(purchaseItems.id, ids));
  for (const row of rows) map.set(row.id, row);
  return map;
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

export function listDeliveries(
  status?: Delivery["status"],
  kind?: Delivery["kind"],
): Promise<Delivery[]> {
  const conditions = [
    ...(status ? [eq(purchaseDeliveries.status, status)] : []),
    ...(kind ? [eq(purchaseDeliveries.kind, kind)] : []),
  ];
  return db
    .select()
    .from(purchaseDeliveries)
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(desc(purchaseDeliveries.date), desc(purchaseDeliveries.createdAt));
}

export async function createDelivery(input: {
  /** Immutable after creation. Defaults to arrival (the warehouse receipt). */
  kind?: Delivery["kind"];
  date: string;
  biller?: string | null;
  /** Required for an arrival; must be absent for a transit hop. */
  targetLocationId?: string | null;
  /** Set only when the delivery is a receiving check for a single purchase. */
  purchaseId?: string | null;
  createdByUserId: string;
}): Promise<Delivery> {
  const kind = input.kind ?? "arrival";
  if (!input.date?.trim()) throw new DeliveryError("INVALID_INPUT", "date is required");
  if (kind === "transit") {
    if (input.targetLocationId != null) {
      throw new DeliveryError("INVALID_INPUT", "a transit delivery has no target location");
    }
  } else {
    if (input.targetLocationId == null) {
      throw new DeliveryError("INVALID_INPUT", "an arrival delivery needs a target location");
    }
    const location = await db.query.locations.findFirst({
      where: eq(locations.id, input.targetLocationId),
    });
    if (!location) throw new DeliveryError("LOCATION_NOT_FOUND");
  }

  const id = ulid();
  await db.insert(purchaseDeliveries).values({
    id,
    kind,
    date: input.date,
    biller: input.biller ?? null,
    targetLocationId: input.targetLocationId ?? null,
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
    if (delivery.kind === "transit") {
      throw new DeliveryError("INVALID_INPUT", "a transit delivery has no target location");
    }
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
  await db.transaction(async (tx) => {
    // Break the self-referential parent links first. That FK is RESTRICT, so the
    // deliveryId cascade can't drop a parent node while a child still points at
    // it (the cascade deletes by PK order, which need not be child-first).
    // Flattening every item to a root lets the cascade remove them all cleanly.
    await tx
      .update(purchaseDeliveryItems)
      .set({ parentItemId: null })
      .where(eq(purchaseDeliveryItems.deliveryId, id));
    await tx.delete(purchaseDeliveries).where(eq(purchaseDeliveries.id, id));
  });
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
  if (!isMoney(input.costMinor) || input.costMinor < 0) {
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
    /** Reparent this node: a cost node to group under, or null for the root. */
    parentItemId?: string | null;
  },
): Promise<DeliveryItem> {
  const item = await loadItem(id);
  const delivery = await loadDelivery(item.deliveryId);
  assertDraft(delivery);

  // Reparenting: the new parent must be a cost node in this delivery, and the
  // move must not create a cycle (parent cannot sit inside the moved subtree).
  if (patch.parentItemId !== undefined && patch.parentItemId !== null) {
    if (patch.parentItemId === id) {
      throw new DeliveryError("INVALID_INPUT", "an item cannot be its own parent");
    }
    const parent = await loadItem(patch.parentItemId);
    if (parent.deliveryId !== item.deliveryId) {
      throw new DeliveryError("INVALID_INPUT", "parent belongs to a different delivery");
    }
    if (parent.purchaseItemId != null) {
      throw new DeliveryError(
        "INVALID_INPUT",
        "cannot nest a line under a goods leaf — only cost nodes can group",
      );
    }
    const all = await listDeliveryItems(item.deliveryId);
    const subtree = new Set<string>([id]);
    const collect = (pid: string) => {
      for (const it of all) {
        if (it.parentItemId === pid && !subtree.has(it.id)) {
          subtree.add(it.id);
          collect(it.id);
        }
      }
    };
    collect(id);
    if (subtree.has(patch.parentItemId)) {
      throw new DeliveryError("INVALID_INPUT", "cannot move an item under its own descendant");
    }
  }

  if (patch.description !== undefined && !patch.description.trim()) {
    throw new DeliveryError("INVALID_INPUT", "description cannot be blank");
  }
  if (
    patch.costMinor !== undefined &&
    (!isMoney(patch.costMinor) || patch.costMinor < 0)
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
        ...(patch.parentItemId !== undefined && { parentItemId: patch.parentItemId }),
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

/** Count of goods leaves (received product lines) — for list-view summaries. */
export async function deliveryLineCount(deliveryId: string): Promise<number> {
  const rows = await db
    .select({ n: sql<number>`count(*)` })
    .from(purchaseDeliveryItems)
    .where(
      and(
        eq(purchaseDeliveryItems.deliveryId, deliveryId),
        sql`${purchaseDeliveryItems.purchaseItemId} is not null`,
      ),
    );
  return Number(rows[0]?.n ?? 0);
}

/** The purchase line a goods leaf receives against — for PO-progress display. */
export function getLinkedPurchaseItem(
  purchaseItemId: string,
): Promise<typeof purchaseItems.$inferSelect | undefined> {
  return db.query.purchaseItems.findFirst({
    where: eq(purchaseItems.id, purchaseItemId),
  });
}

/** Per-leaf landed cost preview — what `commitDelivery` will receive stock at. */
export interface LeafLanding {
  itemId: string;
  qty: number;
  /** The leaf's own line value (vendor cost × qty). */
  baseCostMinor: number;
  /** This leaf's value-weighted share of the freight / customs nodes. */
  freightMinor: number;
  /** Accumulated transit-hop cost picked up on arrival (qty × pooled rate). */
  transitFreightMinor: number;
  /** base + freight + transit — the total cost capitalized into stock. */
  landedCostMinor: number;
  /** landedCostMinor / qty — the unit cost that feeds WAC on commit. */
  landedUnitCostMinor: number;
  /** False for a non-stock leaf (no variant) — excluded from freight. */
  isStock: boolean;
}

/** A purchase line's accumulated transit state, from committed transit hops. */
export interface TransitSummary {
  /** Σ over committed transit leaves of (allocatedFreight / qty) — see D2 note below. */
  ratePerUnit: number;
  /** Total freight banked against this line across all committed transit hops. */
  bankedFreightMinor: number;
  /** Largest single-hop qty — a proxy for "units currently in transit" before
   * subtracting what has already arrived (multi-hop notes repeat the same units,
   * so summing across hops would double-count). */
  maxHopQty: number;
}

/**
 * The transit cost pool: what committed (status `delivered`) transit deliveries
 * have banked against each purchase line. The per-unit rate is the SUM of each
 * hop-leaf's own rate (`allocatedFreight / qty`), NOT pooled-freight ÷ pooled-qty:
 * serial hops carry the same units on every note, so pooling quantities would
 * divide the rate by the hop count and lose freight. Known imprecision: if one
 * purchase line is split across *parallel* transit notes, every arriving unit
 * picks up all batches' rates (over-applied) — accepted "gist accuracy"
 * trade-off of having no explicit transit→arrival chaining.
 *
 * Cancelled transit deliveries drop out via the status filter; arrivals never
 * decrement the pool (the rate simply applies to whatever arrives).
 */
export async function transitRateByPurchaseItem(
  exec: typeof db | Tx,
  purchaseItemIds: string[],
): Promise<Map<string, TransitSummary>> {
  const out = new Map<string, TransitSummary>();
  if (purchaseItemIds.length === 0) return out;
  const rows = await exec
    .select({
      purchaseItemId: purchaseDeliveryItems.purchaseItemId,
      deliveryId: purchaseDeliveryItems.deliveryId,
      qty: purchaseDeliveryItems.qty,
      allocatedFreightMinor: purchaseDeliveryItems.allocatedFreightMinor,
    })
    .from(purchaseDeliveryItems)
    .innerJoin(
      purchaseDeliveries,
      eq(purchaseDeliveryItems.deliveryId, purchaseDeliveries.id),
    )
    .where(
      and(
        inArray(purchaseDeliveryItems.purchaseItemId, purchaseItemIds),
        eq(purchaseDeliveries.kind, "transit"),
        eq(purchaseDeliveries.status, "delivered"),
      ),
    );

  // Per-hop qty first (a delivery may carry one line in several leaves), so
  // maxHopQty reflects whole notes, not individual boxes.
  const hopQty = new Map<string, Map<string, number>>(); // pid → deliveryId → qty
  for (const r of rows) {
    const pid = r.purchaseItemId as string;
    const qty = r.qty ?? 0;
    const entry = out.get(pid) ?? { ratePerUnit: 0, bankedFreightMinor: 0, maxHopQty: 0 };
    if (qty > 0) {
      entry.ratePerUnit += (r.allocatedFreightMinor ?? 0) / qty;
      entry.bankedFreightMinor += r.allocatedFreightMinor ?? 0;
    }
    out.set(pid, entry);
    const byDelivery = hopQty.get(pid) ?? new Map<string, number>();
    byDelivery.set(r.deliveryId, (byDelivery.get(r.deliveryId) ?? 0) + qty);
    hopQty.set(pid, byDelivery);
  }
  for (const [pid, byDelivery] of hopQty) {
    const entry = out.get(pid);
    if (entry) entry.maxHopQty = Math.max(...byDelivery.values(), 0);
  }
  return out;
}

/**
 * Compute each leaf's landed cost for the editor preview, using the exact same
 * apportionment `commitDelivery` applies — so what the clerk sees is what the
 * commit will write. Non-leaf cost nodes (freight/customs) produce no row.
 * For an arrival the landed cost includes the transit pickup; for a transit
 * delivery `freightMinor` is the share that will bank to the pool and the
 * landed figures are not meaningful (the console hides them).
 */
export async function deliveryLeafLandings(deliveryId: string): Promise<LeafLanding[]> {
  const delivery = await loadDelivery(deliveryId);
  const items = await db
    .select()
    .from(purchaseDeliveryItems)
    .where(eq(purchaseDeliveryItems.deliveryId, deliveryId))
    .orderBy(asc(purchaseDeliveryItems.sortOrder));
  const leaves = items.filter((i) => i.purchaseItemId != null);

  const lines = await loadPurchaseItemsByIds(
    db,
    [...new Set(leaves.map((l) => l.purchaseItemId as string))],
  );

  const freightByLeaf = allocateFreightByValue(items, leaves, lines);
  const pool =
    delivery.kind === "arrival"
      ? await transitRateByPurchaseItem(db, [...lines.keys()])
      : new Map<string, TransitSummary>();
  return leaves.map((l) => {
    const qty = l.qty ?? 0;
    const freight = freightByLeaf.get(l.id) ?? 0;
    const isStock = lines.get(l.purchaseItemId as string)?.variantId != null;
    const rate = pool.get(l.purchaseItemId as string)?.ratePerUnit ?? 0;
    const transit = isStock ? roundMoney(qty * rate) : 0;
    const landed = roundMoney(l.costMinor + freight + transit);
    return {
      itemId: l.id,
      qty,
      baseCostMinor: l.costMinor,
      freightMinor: freight,
      transitFreightMinor: transit,
      landedCostMinor: landed,
      landedUnitCostMinor: qty > 0 ? roundMoney(landed / qty) : 0,
      isStock,
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
 * Scope follows the cost tree's shape — no flags:
 *
 * - A cost node **with children** spreads only over the stock leaves in its own
 *   subtree — nesting goods under a "Carton freight" node confines that charge
 *   to those goods (the carton's Rp40k over its 24 bottles). A leaf nested
 *   under several cost nodes carries each one's share.
 * - A **childless** cost node spreads over the stock leaves of its *parent's*
 *   subtree — its siblings and their descendants. At root level that is every
 *   stock leaf of the delivery, so a one-line "Truck freight 500k" charges the
 *   whole note; dropped inside a goods group it charges just that group.
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
    // Spread the pool over the leaves by value, rounded to whole 0.01s so the
    // shares sum back to the pool exactly (largest-remainder).
    const shares = allocateProportional(pool, targets.map((l) => l.costMinor));
    targets.forEach((l, i) => {
      out.set(l.id, roundMoney((out.get(l.id) ?? 0) + shares[i]!));
    });
  };

  for (const node of items) {
    if (node.purchaseItemId != null || node.costMinor <= 0) continue;
    // Shape-based scope: a grouping with children charges its own subtree; a
    // childless cost line charges its parent's subtree (the whole delivery
    // when it sits at the root).
    const hasChildren = (childrenOf.get(node.id) ?? []).length > 0;
    const targets = hasChildren
      ? subtreeStockLeaves(node.id)
      : node.parentItemId == null
        ? stockLeaves
        : subtreeStockLeaves(node.parentItemId);
    spread(node.costMinor, targets);
  }
  return out;
}

/** Re-evaluate every touched purchase: open ⇄ complete based on item delivery state. */
async function refreshPurchaseStatuses(tx: Tx, purchaseIds: Set<string>): Promise<void> {
  const ids = [...purchaseIds];
  if (ids.length === 0) return;

  // Load every touched purchase's lines in one query, then group by purchase.
  const items = await tx
    .select()
    .from(purchaseItems)
    .where(inArray(purchaseItems.purchaseId, ids));
  const byPurchase = new Map<string, PurchaseItemRow[]>();
  for (const it of items) {
    const list = byPurchase.get(it.purchaseId);
    if (list) list.push(it);
    else byPurchase.set(it.purchaseId, [it]);
  }

  const toComplete: string[] = [];
  const toOpen: string[] = [];
  for (const pid of ids) {
    const lineItems = byPurchase.get(pid) ?? [];
    const allDelivered = lineItems.every((i) => i.qtyDelivered >= i.qtyOrdered);
    (allDelivered ? toComplete : toOpen).push(pid);
  }

  // Two bulk updates; each keeps the opposite-status guard so we only write rows
  // that actually flip.
  if (toComplete.length > 0) {
    await tx
      .update(purchases)
      .set({ status: "complete" })
      .where(and(inArray(purchases.id, toComplete), eq(purchases.status, "open")));
  }
  if (toOpen.length > 0) {
    await tx
      .update(purchases)
      .set({ status: "open" })
      .where(and(inArray(purchases.id, toOpen), eq(purchases.status, "complete")));
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
 *
 * A transit hop passes `includeGoods: false`: its leaves are only the freight
 * allocation basis — the goods themselves are billed once, at arrival.
 */
async function postDeliveryAccountsPayable(
  tx: Tx,
  delivery: Delivery,
  items: DeliveryItem[],
  leaves: DeliveryItem[],
  lines: Map<string, typeof purchaseItems.$inferSelect>,
  userId: string,
  includeGoods: boolean,
): Promise<void> {
  const owedByVendor = new Map<string, number>();
  const add = (vendorId: string, amount: number) =>
    owedByVendor.set(vendorId, (owedByVendor.get(vendorId) ?? 0) + amount);

  if (includeGoods) {
    // Supplier AP: each leaf's base cost, summed by the purchase's vendor.
    const purchaseVendor = new Map<string, string | null>();
    const purchaseIds = [...new Set([...lines.values()].map((pi) => pi.purchaseId))];
    if (purchaseIds.length > 0) {
      const rows = await tx
        .select()
        .from(purchases)
        .where(inArray(purchases.id, purchaseIds));
      for (const p of rows) purchaseVendor.set(p.id, p.vendorId ?? null);
    }
    for (const leaf of leaves) {
      const pi = lines.get(leaf.purchaseItemId as string);
      if (!pi) continue;
      const vId = purchaseVendor.get(pi.purchaseId);
      if (vId) add(vId, leaf.costMinor);
    }
  }

  // Courier AP: every cost node (no purchaseItemId) tagged with an expedition.
  for (const node of items) {
    if (node.purchaseItemId == null && node.vendorId && node.costMinor > 0) {
      add(node.vendorId, node.costMinor);
    }
  }
  if (owedByVendor.size === 0) return;

  // Each charge's due date needs the vendor's net terms (null = due on receipt).
  const vendorRows = await tx
    .select()
    .from(vendors)
    .where(inArray(vendors.id, [...owedByVendor.keys()]));
  const termsByVendor = new Map(vendorRows.map((v) => [v.id, v.paymentTermsDays]));
  for (const [vendorId, amountMinor] of owedByVendor) {
    await postPurchaseOnAccount(tx, {
      vendorId,
      amountMinor,
      deliveryId: delivery.id,
      dueDate: addDays(delivery.date, termsByVendor.get(vendorId) ?? 0),
      createdByUserId: userId,
    });
  }
}

/**
 * Commit a draft delivery — one transaction, branching on `kind`.
 *
 * **Transit**: validate each line's qty against `qtyOrdered` (a note cannot
 * carry more than was ordered; hops are NOT cumulative — the same units ride
 * every hop's note), freeze each stock leaf's freight share into
 * `allocatedFreightMinor` (banking it to the transit pool), raise AP to the
 * tagged expedition(s) only, and stamp `delivered`. No stock, no
 * `qty_delivered`, no purchase completion, no goods AP.
 *
 * **Arrival**: validate the partial-delivery constraint per line, emit a
 * `purchase_receive` movement for every stock leaf at the landed unit cost —
 * base + own freight share + transit pickup (qty × pooled rate) — advance
 * `qty_delivered`, complete any fully-received purchase, raise accounts
 * payable to the supplier(s) and any tagged expedition, and stamp `delivered`.
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
    const lines = await loadPurchaseItemsByIds(tx, [...byItem.keys()]);
    for (const pid of byItem.keys()) {
      if (!lines.has(pid)) throw new DeliveryError("PURCHASE_ITEM_NOT_FOUND", pid);
    }

    // Landed cost: spread the delivery's freight / customs nodes over the
    // stock leaves by line value.
    const freightByLeaf = allocateFreightByValue(items, leaves, lines);

    if (delivery.kind === "transit") {
      // A single note cannot carry more of a line than was ordered. Not
      // checked against qtyDelivered or other hops: transit precedes delivery
      // and multi-hop legitimately repeats the same units.
      for (const [pid, sumQty] of byItem) {
        const pi = lines.get(pid) as typeof purchaseItems.$inferSelect;
        if (sumQty > pi.qtyOrdered) {
          throw new DeliveryError(
            "OVER_DELIVERY",
            `line ${pid}: ${sumQty} exceeds ordered ${pi.qtyOrdered}`,
          );
        }
      }

      // Bank each stock leaf's freight share into the transit pool.
      for (const leaf of leaves) {
        const pi = lines.get(leaf.purchaseItemId as string);
        if (!pi?.variantId) continue;
        await tx
          .update(purchaseDeliveryItems)
          .set({ allocatedFreightMinor: freightByLeaf.get(leaf.id) ?? 0 })
          .where(eq(purchaseDeliveryItems.id, leaf.id));
      }

      // Freight AP only — the goods are billed once, at arrival.
      await postDeliveryAccountsPayable(tx, delivery, items, leaves, lines, userId, false);

      await tx
        .update(purchaseDeliveries)
        .set({ status: "delivered", deliveredAt: new Date(), deliveredByUserId: userId })
        .where(eq(purchaseDeliveries.id, id));
      const row = await tx.query.purchaseDeliveries.findFirst({
        where: eq(purchaseDeliveries.id, id),
      });
      return row as Delivery;
    }

    // --- Arrival ---
    if (delivery.targetLocationId == null) {
      throw new DeliveryError("INVALID_INPUT", "an arrival delivery needs a target location");
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

    // Transit pickup: the per-unit rate each line accumulated across committed
    // transit hops (0 for direct-shipped lines absent from the pool).
    const pool = await transitRateByPurchaseItem(tx, [...byItem.keys()]);

    // 2 & 3. One purchase_receive movement per stock leaf; WAC recomputes
    // inside recordMovement. Non-stock lines (variantId null) are skipped.
    for (const leaf of leaves) {
      const pi = lines.get(leaf.purchaseItemId as string);
      if (!pi?.variantId) continue;

      // Resolve the variant's product kind: bundles cannot be received at all,
      // and non_stock items take a cost-only receipt (no stock moves).
      const v = await tx.query.productVariants.findFirst({ where: eq(productVariants.id, pi.variantId) });
      const prd = v
        ? await tx.query.products.findFirst({ where: eq(products.id, v.productId) })
        : undefined;
      if (prd?.kind === "bundle") {
        throw new DeliveryError("BUNDLE_NOT_STOCKED", `variant ${pi.variantId} is a bundle — it cannot be received as stock`);
      }

      const qty = leaf.qty as number;
      const rate = pool.get(leaf.purchaseItemId as string)?.ratePerUnit ?? 0;
      const landed = roundMoney(
        leaf.costMinor + (freightByLeaf.get(leaf.id) ?? 0) + qty * rate,
      );
      const unitCost = roundMoney(landed / qty);

      // non_stock: set the variant cost to this landed per-unit but hold no
      // stock. cost_override (qtyDelta 0) leaves totalQty at 0 and writes no
      // stock_locations row, while still recording previous/next cost for audit.
      if (prd?.kind === "non_stock") {
        await recordMovement(
          {
            variantId: pi.variantId,
            type: "cost_override",
            qtyDelta: 0,
            unitCost,
            refType: "purchase",
            refId: delivery.id,
            createdByUserId: userId,
          },
          tx,
        );
        continue;
      }

      await recordMovement(
        {
          variantId: pi.variantId,
          locationId: delivery.targetLocationId,
          type: "purchase_receive",
          qtyDelta: qty,
          unitCost,
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
    await postDeliveryAccountsPayable(tx, delivery, items, leaves, lines, userId, true);

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
 * Cancel a delivered delivery (root only).
 *
 * **Transit**: reverses the freight AP and stamps `cancelled` — its pool
 * contribution disappears via the status filter. Arrivals committed *before*
 * the cancel keep their baked landed cost ("gist accuracy"); arrivals
 * committed after pick up the reduced rate.
 *
 * **Arrival**: reverses each `purchase_receive` with an `adjustment_out` —
 * stock returns but WAC is deliberately NOT re-valued (the "gist accuracy"
 * rule; use `cost_override` if it matters). `qty_delivered` is rolled back and
 * completed purchases reopen. The transit pool is NOT restored or decremented —
 * it is rate-based, so a later re-receipt simply picks up the then-current rate.
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

    if (delivery.kind === "transit") {
      await reverseDeliveryCharges(tx, id, userId);
      await tx
        .update(purchaseDeliveries)
        .set({ status: "cancelled" })
        .where(eq(purchaseDeliveries.id, id));
      const row = await tx.query.purchaseDeliveries.findFirst({
        where: eq(purchaseDeliveries.id, id),
      });
      return row as Delivery;
    }

    const items = await tx
      .select()
      .from(purchaseDeliveryItems)
      .where(eq(purchaseDeliveryItems.deliveryId, id));
    const leaves = items.filter((i) => i.purchaseItemId != null && i.qty != null);
    const byItem = leafQtyByPurchaseItem(leaves);

    const lines = await loadPurchaseItemsByIds(tx, [...byItem.keys()]);

    // Batch-load the variants behind these lines for their fallback unit cost.
    const variantIds = [
      ...new Set(
        [...lines.values()]
          .map((pi) => pi.variantId)
          .filter((v): v is string => v != null),
      ),
    ];
    const variants = new Map<string, typeof productVariants.$inferSelect>();
    if (variantIds.length > 0) {
      const rows = await tx
        .select()
        .from(productVariants)
        .where(inArray(productVariants.id, variantIds));
      for (const v of rows) variants.set(v.id, v);
    }

    // non_stock variants never received stock — there is nothing to reverse,
    // and their cost is left as-is (mirroring the "WAC not re-valued on cancel"
    // rule). Identify them so the reversal loop can skip them.
    const nonStockVariants = new Set<string>();
    if (variantIds.length > 0) {
      const rows = await tx
        .select({ variantId: productVariants.id })
        .from(productVariants)
        .innerJoin(products, eq(products.id, productVariants.productId))
        .where(and(inArray(productVariants.id, variantIds), eq(products.kind, "non_stock")));
      for (const r of rows) nonStockVariants.add(r.variantId);
    }

    // Reverse the stock with non-cost-affecting outbound movements.
    for (const leaf of leaves) {
      const pi = lines.get(leaf.purchaseItemId as string);
      if (!pi?.variantId) continue;
      if (nonStockVariants.has(pi.variantId)) continue;
      const variant = variants.get(pi.variantId);
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
