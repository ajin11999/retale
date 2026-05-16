// Stock service: the one place that writes the `stock_movements` ledger and
// keeps the `stock_locations` cache and the variant's `total_qty` / `cost_minor`
// in sync. Other domains (orders, purchases, transfers) call `modifyStock` or
// `recordMovement` rather than touching stock tables directly.
//
// Money is integer minor units; qty is an integer count of the variant's
// smallest unit. See docs/design-decisions.md → "Cost accounting".

import { and, desc, eq, isNull, sql } from "drizzle-orm";
import { ulid } from "ulid";
import { productVariants } from "../db/schema/products.ts";
import {
  STOCK_MOVEMENT_TYPES,
  STOCK_REF_TYPES,
  stockLocations,
  stockMovements,
} from "../db/schema/stock.ts";
import { db } from "../lib/db.ts";

export type MovementType = (typeof STOCK_MOVEMENT_TYPES)[number];
export type RefType = (typeof STOCK_REF_TYPES)[number];

/** A drizzle transaction handle; structurally a subset of `db`. */
type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
type Exec = typeof db | Tx;

/** Movement types that recompute the variant's weighted-average `cost_minor`. */
const COST_AFFECTING: ReadonlySet<MovementType> = new Set([
  "purchase_receive",
  "cost_override",
  "initial_import",
]);

export type StockErrorCode =
  | "VARIANT_NOT_FOUND"
  | "INVALID_INPUT"
  | "NO_STOCK_TO_PULL";

export class StockError extends Error {
  constructor(
    public code: StockErrorCode,
    message?: string,
  ) {
    super(message ?? code);
    this.name = "StockError";
  }
}

type Variant = typeof productVariants.$inferSelect;
type Movement = typeof stockMovements.$inferSelect;
type StockRow = typeof stockLocations.$inferSelect;

async function loadVariant(exec: Exec, id: string): Promise<Variant> {
  const row = await exec.query.productVariants.findFirst({
    where: eq(productVariants.id, id),
  });
  if (!row) throw new StockError("VARIANT_NOT_FOUND");
  return row;
}

/** Match a (variant, location) stock row, treating a null location as the root bucket. */
function stockRowWhere(variantId: string, locationId: string | null) {
  return and(
    eq(stockLocations.variantId, variantId),
    locationId == null
      ? isNull(stockLocations.locationId)
      : eq(stockLocations.locationId, locationId),
  );
}

export interface RecordMovementInput {
  variantId: string;
  locationId?: string | null;
  type: MovementType;
  /** Positive inbound, negative outbound, zero for `cost_override`. */
  qtyDelta: number;
  /** Per-unit cost of this movement, minor units. Required for cost-affecting types. */
  unitCost?: number;
  refType: RefType;
  refId?: string | null;
  reason?: string | null;
  createdByUserId: string;
}

/**
 * Weighted-average cost after receiving `recvQty` units at `recvCost` each on
 * top of `curQty` units at `curCost`. Negative-balance-safe: a non-positive
 * running balance resets the average to the received cost.
 */
function weightedAverage(
  curQty: number,
  curCost: number,
  recvQty: number,
  recvCost: number,
): number {
  if (curQty <= 0 || curQty + recvQty <= 0) return recvCost;
  return Math.round((curQty * curCost + recvQty * recvCost) / (curQty + recvQty));
}

async function recordMovementTx(tx: Tx, input: RecordMovementInput): Promise<Movement> {
  const variant = await loadVariant(tx, input.variantId);
  const locationId = input.locationId ?? null;

  if (COST_AFFECTING.has(input.type) && input.unitCost == null) {
    throw new StockError("INVALID_INPUT", `${input.type} requires a unitCost`);
  }
  if (input.type === "cost_override" && input.qtyDelta !== 0) {
    throw new StockError("INVALID_INPUT", "cost_override must have qtyDelta = 0");
  }

  // --- Ledger row ---
  const movementId = ulid();
  let nextCost: number | null = null;
  let previousCost: number | null = null;

  if (input.type === "cost_override") {
    previousCost = variant.costMinor;
    nextCost = input.unitCost ?? variant.costMinor;
  } else if (COST_AFFECTING.has(input.type)) {
    nextCost = weightedAverage(
      variant.totalQty,
      variant.costMinor,
      input.qtyDelta,
      input.unitCost ?? 0,
    );
  }

  await tx.insert(stockMovements).values({
    id: movementId,
    variantId: input.variantId,
    locationId,
    type: input.type,
    qtyDelta: input.qtyDelta,
    unitCost: input.unitCost ?? 0,
    previousCost,
    refType: input.refType,
    refId: input.refId ?? null,
    reason: input.reason ?? null,
    createdByUserId: input.createdByUserId,
  });

  // --- Per-location running total cache ---
  if (input.qtyDelta !== 0) {
    const existing = await tx
      .select()
      .from(stockLocations)
      .where(stockRowWhere(input.variantId, locationId));
    const current = existing[0];
    if (current) {
      await tx
        .update(stockLocations)
        .set({ qty: current.qty + input.qtyDelta })
        .where(eq(stockLocations.id, current.id));
    } else {
      await tx.insert(stockLocations).values({
        id: ulid(),
        variantId: input.variantId,
        locationId,
        qty: input.qtyDelta,
      });
    }
  }

  // --- Denormalized totals on the variant ---
  const totals = await tx
    .select({ total: sql<number>`COALESCE(SUM(${stockLocations.qty}), 0)` })
    .from(stockLocations)
    .where(eq(stockLocations.variantId, input.variantId));

  await tx
    .update(productVariants)
    .set({
      totalQty: Number(totals[0]?.total ?? 0),
      ...(nextCost != null && { costMinor: nextCost }),
    })
    .where(eq(productVariants.id, input.variantId));

  const row = await tx.query.stockMovements.findFirst({
    where: eq(stockMovements.id, movementId),
  });
  return row as Movement;
}

/**
 * Write one ledger movement. Pass an existing `tx` to enlist in a caller's
 * transaction (order creation, delivery commit); omit it to run standalone.
 */
export function recordMovement(input: RecordMovementInput, tx?: Tx): Promise<Movement> {
  return tx ? recordMovementTx(tx, input) : db.transaction((t) => recordMovementTx(t, input));
}

export interface ModifyStockInput extends Omit<RecordMovementInput, "locationId"> {
  /**
   * Where to apply the change. For inbound moves, defaults to the root bucket.
   * For outbound moves, when omitted the location holding the most stock is
   * drained first (ProDuck parity); the root bucket is the last resort.
   */
  preferredLocationId?: string | null;
}

async function pickOutboundLocation(
  exec: Exec,
  variantId: string,
): Promise<string | null> {
  const rows = await exec
    .select()
    .from(stockLocations)
    .where(eq(stockLocations.variantId, variantId))
    .orderBy(desc(stockLocations.qty));
  const best = rows.find((r) => r.qty > 0) ?? rows[0];
  return best ? best.locationId : null;
}

async function modifyStockTx(tx: Tx, input: ModifyStockInput): Promise<Movement> {
  const { preferredLocationId, ...rest } = input;
  let locationId = preferredLocationId ?? null;
  if (preferredLocationId == null && input.qtyDelta < 0) {
    locationId = await pickOutboundLocation(tx, input.variantId);
  }
  return recordMovementTx(tx, { ...rest, locationId });
}

/**
 * Apply a stock change, choosing a location automatically for outbound moves.
 * This is the entry point order creation and returns use.
 */
export function modifyStock(input: ModifyStockInput, tx?: Tx): Promise<Movement> {
  return tx ? modifyStockTx(tx, input) : db.transaction((t) => modifyStockTx(t, input));
}

/** A manual stock write-on / write-off. Positive `qtyDelta` adds, negative removes. */
export function adjustStock(input: {
  variantId: string;
  locationId?: string | null;
  qtyDelta: number;
  reason: string;
  createdByUserId: string;
}): Promise<Movement> {
  if (input.qtyDelta === 0) {
    throw new StockError("INVALID_INPUT", "adjustment qtyDelta must be non-zero");
  }
  if (!input.reason.trim()) {
    throw new StockError("INVALID_INPUT", "adjustment reason is required");
  }
  return recordMovement({
    variantId: input.variantId,
    locationId: input.locationId ?? null,
    type: input.qtyDelta > 0 ? "adjustment_in" : "adjustment_out",
    qtyDelta: input.qtyDelta,
    refType: "adjustment",
    reason: input.reason.trim(),
    createdByUserId: input.createdByUserId,
  });
}

/** Admin escape hatch: snap the variant's WAC to an exact value. */
export function overrideCost(input: {
  variantId: string;
  unitCost: number;
  reason: string;
  createdByUserId: string;
}): Promise<Movement> {
  if (input.unitCost < 0) {
    throw new StockError("INVALID_INPUT", "cost must not be negative");
  }
  return recordMovement({
    variantId: input.variantId,
    type: "cost_override",
    qtyDelta: 0,
    unitCost: input.unitCost,
    refType: "override",
    reason: input.reason.trim() || null,
    createdByUserId: input.createdByUserId,
  });
}

/** Per-location stock rows for a variant. */
export async function getVariantStock(variantId: string): Promise<StockRow[]> {
  await loadVariant(db, variantId);
  return db.select().from(stockLocations).where(eq(stockLocations.variantId, variantId));
}

/** Recent ledger entries for a variant, newest first. */
export async function listMovements(variantId: string, limit = 100): Promise<Movement[]> {
  await loadVariant(db, variantId);
  return db
    .select()
    .from(stockMovements)
    .where(eq(stockMovements.variantId, variantId))
    .orderBy(desc(stockMovements.createdAt))
    .limit(Math.min(Math.max(limit, 1), 500));
}
