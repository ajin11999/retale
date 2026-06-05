// Reorder service: the reorder scan and the conversion of its suggestions
// into draft purchases. The scan compares each tracked variant's *available*
// stock (on-hand + on-order) against its `reorderPoint`, and writes an `open`
// suggestion set for staff to review. Converting selected suggestions creates
// one draft purchase per vendor. Nothing touches `purchases` until a staff
// member confirms a conversion. See docs/future-features.md →
// "Reorder-point → suggested reorders".

import { and, desc, eq, inArray, isNotNull, isNull, lt, ne, sql } from "drizzle-orm";
import { ulid } from "ulid";
import { products, productVariants } from "../db/schema/products.ts";
import { purchaseItems, purchases } from "../db/schema/purchases.ts";
import { reorderSuggestions } from "../db/schema/reorder.ts";
import { vendors } from "../db/schema/vendors.ts";
import { db } from "../lib/db.ts";
import { preferredVendorByVariant } from "./vendor-variant-code-service.ts";

export type ReorderErrorCode =
  | "SUGGESTION_NOT_FOUND"
  | "NOT_OPEN"
  | "UNASSIGNED_VENDOR"
  | "VENDOR_NOT_FOUND"
  | "INVALID_INPUT"
  | "EMPTY_SELECTION";

export class ReorderError extends Error {
  constructor(
    public code: ReorderErrorCode,
    message?: string,
  ) {
    super(message ?? code);
    this.name = "ReorderError";
  }
}

type Suggestion = typeof reorderSuggestions.$inferSelect;
type Purchase = typeof purchases.$inferSelect;

/** Format a Date as a local `YYYY-MM-DD` stamp. */
function dateStamp(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

// --- Reads ---

/** Suggestions, newest scan first; optionally filtered to one status. */
export function listSuggestions(
  status?: Suggestion["status"],
): Promise<Suggestion[]> {
  return db
    .select()
    .from(reorderSuggestions)
    .where(status ? eq(reorderSuggestions.status, status) : undefined)
    .orderBy(desc(reorderSuggestions.generatedAt));
}

async function loadSuggestion(id: string): Promise<Suggestion> {
  const row = await db.query.reorderSuggestions.findFirst({
    where: eq(reorderSuggestions.id, id),
  });
  if (!row) throw new ReorderError("SUGGESTION_NOT_FOUND");
  return row;
}

// --- Scan ---

/**
 * Scan every tracked variant and rebuild the `open` suggestion set.
 *
 * A variant is *tracked* when it has a `reorderPoint` and sits on a monitored,
 * non-archived physical product. It is suggested when
 * `available = onHand + onOrder` is below the point — netting out `onOrder`
 * so a variant that already has an open PO is not re-suggested every day.
 *
 * Vendor pick, in order: the variant's preferred vendor (its `isPreferred`
 * `vendor_variant_codes` mapping), then its last-used vendor (most recent
 * non-cancelled purchase that included it), then the product's primary
 * vendor, then unassigned. The suggested quantity is the variant's
 * `reorderQty`, or — when that is null — enough to bring `available` back up
 * to the point.
 *
 * The previous `open` set is discarded; `converted` / `dismissed` rows stay.
 */
export async function runReorderScan(): Promise<Suggestion[]> {
  // Tracked variants and their product's primary vendor.
  const candidates = await db
    .select({
      variantId: productVariants.id,
      totalQty: productVariants.totalQty,
      reorderPoint: productVariants.reorderPoint,
      reorderQty: productVariants.reorderQty,
      primaryVendorId: products.primaryVendorId,
    })
    .from(productVariants)
    .innerJoin(products, eq(productVariants.productId, products.id))
    .where(
      and(
        isNotNull(productVariants.reorderPoint),
        eq(products.kind, "physical"),
        eq(products.replenishMonitored, true),
        isNull(products.archivedAt),
      ),
    );

  const generatedAt = new Date();
  if (candidates.length === 0) {
    await db
      .delete(reorderSuggestions)
      .where(eq(reorderSuggestions.status, "open"));
    return [];
  }
  const candidateIds = candidates.map((c) => c.variantId);

  // On-order: Σ(ordered − delivered) over non-cancelled purchases, per variant.
  const onOrderRows = await db
    .select({
      variantId: purchaseItems.variantId,
      onOrder: sql<number>`SUM(${purchaseItems.qtyOrdered} - ${purchaseItems.qtyDelivered})`,
    })
    .from(purchaseItems)
    .innerJoin(purchases, eq(purchaseItems.purchaseId, purchases.id))
    .where(
      and(
        ne(purchases.status, "cancelled"),
        inArray(purchaseItems.variantId, candidateIds),
      ),
    )
    .groupBy(purchaseItems.variantId);
  const onOrderByVariant = new Map<string, number>();
  for (const r of onOrderRows) {
    if (r.variantId) onOrderByVariant.set(r.variantId, Number(r.onOrder ?? 0));
  }

  // Last-used vendor: first row per variant once ordered newest-first.
  const lastUsedRows = await db
    .select({
      variantId: purchaseItems.variantId,
      vendorId: purchases.vendorId,
    })
    .from(purchaseItems)
    .innerJoin(purchases, eq(purchaseItems.purchaseId, purchases.id))
    .where(
      and(
        isNotNull(purchases.vendorId),
        ne(purchases.status, "cancelled"),
        inArray(purchaseItems.variantId, candidateIds),
      ),
    )
    .orderBy(desc(purchases.date), desc(purchases.createdAt));
  const lastVendorByVariant = new Map<string, string>();
  for (const r of lastUsedRows) {
    if (r.variantId && r.vendorId && !lastVendorByVariant.has(r.variantId)) {
      lastVendorByVariant.set(r.variantId, r.vendorId);
    }
  }

  // Preferred vendor: an explicit `isPreferred` vendor_variant_codes mapping.
  const preferredByVariant = await preferredVendorByVariant(candidateIds);

  const rows: (typeof reorderSuggestions.$inferInsert)[] = [];
  for (const c of candidates) {
    const reorderPoint = c.reorderPoint as number;
    const onOrder = onOrderByVariant.get(c.variantId) ?? 0;
    const available = c.totalQty + onOrder;
    if (available >= reorderPoint) continue;

    const vendorId =
      preferredByVariant.get(c.variantId) ??
      lastVendorByVariant.get(c.variantId) ??
      c.primaryVendorId ??
      null;
    const suggestedQty =
      c.reorderQty != null
        ? c.reorderQty
        : Math.max(1, reorderPoint - available);

    rows.push({
      id: ulid(),
      variantId: c.variantId,
      vendorId,
      currentStock: c.totalQty,
      reorderPoint,
      suggestedQty,
      status: "open",
      generatedAt,
    });
  }

  await db.transaction(async (tx) => {
    await tx
      .delete(reorderSuggestions)
      .where(eq(reorderSuggestions.status, "open"));
    if (rows.length) await tx.insert(reorderSuggestions).values(rows);
  });

  return db
    .select()
    .from(reorderSuggestions)
    .where(eq(reorderSuggestions.status, "open"))
    .orderBy(desc(reorderSuggestions.generatedAt));
}

// --- Mutations on suggestions ---

/** Drop a suggestion from the review list without ordering it. */
export async function dismissSuggestion(id: string): Promise<Suggestion> {
  const suggestion = await loadSuggestion(id);
  if (suggestion.status === "dismissed") return suggestion;
  if (suggestion.status !== "open") {
    throw new ReorderError("NOT_OPEN", "only an open suggestion can be dismissed");
  }
  await db
    .update(reorderSuggestions)
    .set({ status: "dismissed" })
    .where(eq(reorderSuggestions.id, id));
  return loadSuggestion(id);
}

/** One selected suggestion, with optional staff overrides for qty / vendor. */
export interface ConvertLine {
  suggestionId: string;
  /** Override the suggested quantity. Defaults to the suggestion's value. */
  qty?: number;
  /** Override / assign the vendor. Defaults to the suggestion's vendor. */
  vendorId?: string;
}

/**
 * Convert selected open suggestions into draft purchases — one purchase per
 * vendor, each line a `purchase_item` priced at the variant's current cost.
 * Every selected suggestion must resolve to a vendor (its own or an override);
 * an unassigned line with no override is rejected. Atomic: either every
 * purchase is created and every suggestion marked `converted`, or nothing.
 */
export async function convertSuggestions(
  lines: ConvertLine[],
  createdByUserId: string,
): Promise<Purchase[]> {
  if (!lines.length) throw new ReorderError("EMPTY_SELECTION");

  // Resolve each line against its suggestion before opening the transaction.
  type Resolved = { suggestion: Suggestion; vendorId: string; qty: number };
  const resolved: Resolved[] = [];
  for (const line of lines) {
    const suggestion = await loadSuggestion(line.suggestionId);
    if (suggestion.status !== "open") {
      throw new ReorderError(
        "NOT_OPEN",
        `suggestion ${line.suggestionId} is already ${suggestion.status}`,
      );
    }
    const vendorId = line.vendorId ?? suggestion.vendorId;
    if (!vendorId) {
      throw new ReorderError(
        "UNASSIGNED_VENDOR",
        `suggestion ${line.suggestionId} has no vendor — assign one to convert it`,
      );
    }
    const qty = line.qty ?? suggestion.suggestedQty;
    if (!Number.isInteger(qty) || qty <= 0) {
      throw new ReorderError("INVALID_INPUT", "qty must be a positive integer");
    }
    resolved.push({ suggestion, vendorId, qty });
  }

  // Validate vendors and gather variant costs up front.
  const vendorIds = [...new Set(resolved.map((r) => r.vendorId))];
  const vendorRows = await db
    .select({ id: vendors.id, name: vendors.name })
    .from(vendors)
    .where(inArray(vendors.id, vendorIds));
  const vendorById = new Map(vendorRows.map((v) => [v.id, v.name]));
  for (const id of vendorIds) {
    if (!vendorById.has(id)) throw new ReorderError("VENDOR_NOT_FOUND", id);
  }

  const variantIds = [...new Set(resolved.map((r) => r.suggestion.variantId))];
  const variantRows = await db
    .select({ id: productVariants.id, costMinor: productVariants.costMinor })
    .from(productVariants)
    .where(inArray(productVariants.id, variantIds));
  const costByVariant = new Map(variantRows.map((v) => [v.id, v.costMinor]));

  const today = dateStamp(new Date());

  return db.transaction(async (tx) => {
    const created: Purchase[] = [];
    // One purchase per vendor.
    for (const vendorId of vendorIds) {
      const group = resolved.filter((r) => r.vendorId === vendorId);
      const purchaseId = ulid();
      await tx.insert(purchases).values({
        id: purchaseId,
        vendorId,
        snapshotVendorName: vendorById.get(vendorId) as string,
        date: today,
        memo: "Generated from reorder suggestions",
        createdByUserId,
      });
      await tx.insert(purchaseItems).values(
        group.map((r, i) => ({
          id: ulid(),
          purchaseId,
          variantId: r.suggestion.variantId,
          qtyOrdered: r.qty,
          unitCostMinor: costByVariant.get(r.suggestion.variantId) ?? 0,
          sortOrder: i,
        })),
      );
      const row = await tx.query.purchases.findFirst({
        where: eq(purchases.id, purchaseId),
      });
      created.push(row as Purchase);
    }
    // Mark every converted suggestion in one statement.
    await tx
      .update(reorderSuggestions)
      .set({ status: "converted" })
      .where(
        inArray(
          reorderSuggestions.id,
          resolved.map((r) => r.suggestion.id),
        ),
      );
    return created;
  });
}

// --- Retention ---

/** Resolved (converted/dismissed) suggestions older than this are purged. */
export const RESOLVED_RETENTION_DAYS = 90;

const MS_PER_DAY = 86_400_000;

/**
 * Hard-delete `converted` / `dismissed` suggestions older than `olderThanDays`
 * — table-bloat control. These rows are a light audit of what was acted on, so
 * they accumulate with usage; `open` rows are left alone (the scan rebuilds
 * them every run). Returns the count removed.
 */
export async function purgeResolvedSuggestions(
  olderThanDays: number = RESOLVED_RETENTION_DAYS,
): Promise<number> {
  const cutoff = new Date(Date.now() - olderThanDays * MS_PER_DAY);
  const res = await db.delete(reorderSuggestions).where(
    and(
      inArray(reorderSuggestions.status, ["converted", "dismissed"]),
      lt(reorderSuggestions.generatedAt, cutoff),
    ),
  );
  return res[0].affectedRows;
}
