// Reorder service: the reorder scan and the conversion of its suggestions
// into draft purchases. The scan compares each tracked variant's *available*
// stock (on-hand + on-order) against its `reorderPoint`, and writes an `open`
// suggestion set for staff to review. Converting selected suggestions creates
// one draft purchase per vendor. Nothing touches `purchases` until a staff
// member confirms a conversion. See docs/future-features.md →
// "Reorder-point → suggested reorders".

import { and, desc, eq, inArray, isNotNull, isNull, lt, ne, or, sql } from "drizzle-orm";
import { ulid } from "ulid";
import { interchangeGroups, products, productVariants } from "../db/schema/products.ts";
import { purchaseItems, purchases } from "../db/schema/purchases.ts";
import { purchaseRequisitions, purchaseRequisitionItems } from "../db/schema/requisitions.ts";
import { reorderSuggestions } from "../db/schema/reorder.ts";
import { vendors } from "../db/schema/vendors.ts";
import { db } from "../lib/db.ts";
import { lastVendorCosts } from "./purchase-service.ts";
import { preferredVendorByVariant } from "./vendor-variant-code-service.ts";
import { reorderForecast } from "./forecast-service.ts";

export type ReorderErrorCode =
  | "SUGGESTION_NOT_FOUND"
  | "NOT_OPEN"
  | "UNASSIGNED_VENDOR"
  | "VENDOR_NOT_FOUND"
  | "INVALID_INPUT"
  | "EMPTY_SELECTION"
  | "PURCHASE_NOT_FOUND"
  | "PURCHASE_NOT_OPEN";

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
 * A variant is *tracked* when it has an effective reorder point — its own
 * `reorderPoint`, or, failing that, its product's `minQty` — and sits on a
 * monitored, non-archived physical product. It is suggested when
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
  // Substitute groups (InterchangeGroups)
  const substituteGroupsRows = await db
    .select({
      interchangeGroupId: interchangeGroups.id,
      minQty: interchangeGroups.minQty,
      preferredVariantId: interchangeGroups.preferredVariantId,
    })
    .from(interchangeGroups)
    .where(
      and(
        isNotNull(interchangeGroups.minQty),
        isNotNull(interchangeGroups.preferredVariantId)
      )
    );
  const substituteGroupMap = new Map(substituteGroupsRows.map((sg) => [sg.interchangeGroupId, sg]));

  let groupVariantRows: { interchangeGroupId: string | null; variantId: string; totalQty: number }[] = [];
  if (substituteGroupsRows.length > 0) {
    groupVariantRows = await db
      .select({
        interchangeGroupId: productVariants.interchangeGroupId,
        variantId: productVariants.id,
        totalQty: productVariants.totalQty,
      })
      .from(productVariants)
      .where(isNotNull(productVariants.interchangeGroupId));
  }

  // Tracked variants and their product's primary vendor.
  const candidates = await db
    .select({
      variantId: productVariants.id,
      totalQty: productVariants.totalQty,
      reorderPoint: productVariants.reorderPoint,
      reorderQty: productVariants.reorderQty,
      minQty: products.minQty,
      primaryVendorId: products.primaryVendorId,
      interchangeGroupId: productVariants.interchangeGroupId,
    })
    .from(productVariants)
    .innerJoin(products, eq(productVariants.productId, products.id))
    .where(
      and(
        // Tracked if the variant has its own point or the product sets minQty.
        or(isNotNull(productVariants.reorderPoint), isNotNull(products.minQty)),
        eq(products.kind, "physical"),
        eq(products.replenishMonitored, true),
        isNull(products.archivedAt),
      ),
    );

  const generatedAt = new Date();
  
  const candidateVariantIds = new Set<string>(candidates.map((c) => c.variantId));
  for (const row of groupVariantRows) candidateVariantIds.add(row.variantId);
  for (const sg of substituteGroupsRows) candidateVariantIds.add(sg.preferredVariantId as string);

  const candidateIds = Array.from(candidateVariantIds);

  if (candidateIds.length === 0) {
    await db
      .delete(reorderSuggestions)
      .where(eq(reorderSuggestions.status, "open"));
    return [];
  }

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

  let preferredVariantsInfoMap = new Map<string, { reorderQty: number | null, primaryVendorId: string | null }>();
  if (substituteGroupsRows.length > 0) {
    const preferredVariantIds = substituteGroupsRows.map(sg => sg.preferredVariantId as string);
    const prefInfo = await db
      .select({
        variantId: productVariants.id,
        reorderQty: productVariants.reorderQty,
        primaryVendorId: products.primaryVendorId,
      })
      .from(productVariants)
      .innerJoin(products, eq(productVariants.productId, products.id))
      .where(inArray(productVariants.id, preferredVariantIds));
    preferredVariantsInfoMap = new Map(prefInfo.map(info => [info.variantId, info]));
  }

  const rows: (typeof reorderSuggestions.$inferInsert)[] = [];

  for (const sg of substituteGroupsRows) {
    let aggregateStock = 0;
    const variantsInGroup = groupVariantRows.filter((r) => r.interchangeGroupId === sg.interchangeGroupId);
    for (const v of variantsInGroup) {
      aggregateStock += v.totalQty + (onOrderByVariant.get(v.variantId) ?? 0);
    }
    
    if (aggregateStock <= (sg.minQty as number)) {
      const preferredId = sg.preferredVariantId as string;
      const prefInfo = preferredVariantsInfoMap.get(preferredId);
      const vendorId =
        preferredByVariant.get(preferredId) ??
        lastVendorByVariant.get(preferredId) ??
        prefInfo?.primaryVendorId ??
        null;
      
      const suggestedQty = prefInfo?.reorderQty != null 
        ? prefInfo.reorderQty 
        : Math.max(1, (sg.minQty as number) - aggregateStock);

      rows.push({
        id: ulid(),
        variantId: preferredId,
        vendorId,
        currentStock: aggregateStock,
        reorderPoint: sg.minQty as number,
        suggestedQty,
        status: "open",
        generatedAt,
      });
    }
  }

  for (const c of candidates) {
    if (c.interchangeGroupId && substituteGroupMap.has(c.interchangeGroupId)) continue;

    const reorderPoint = (c.reorderPoint ?? c.minQty) as number;
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
}

/**
 * Convert selected open suggestions into a draft purchase requisition.
 * All lines go into a single requisition.
 */
export async function convertSuggestionsToRequisition(
  name: string,
  lines: ConvertLine[],
  createdByUserId: string,
) {
  if (!lines.length) throw new ReorderError("EMPTY_SELECTION");

  type Resolved = { suggestion: Suggestion; qty: number };
  const resolved: Resolved[] = [];
  for (const line of lines) {
    const suggestion = await loadSuggestion(line.suggestionId);
    if (suggestion.status !== "open") {
      throw new ReorderError(
        "NOT_OPEN",
        `suggestion ${line.suggestionId} is already ${suggestion.status}`,
      );
    }
    const qty = line.qty ?? suggestion.suggestedQty;
    if (!Number.isInteger(qty) || qty <= 0) {
      throw new ReorderError("INVALID_INPUT", "qty must be a positive integer");
    }
    resolved.push({ suggestion, qty });
  }

  return db.transaction(async (tx) => {
    const requisitionId = ulid();
    await tx.insert(purchaseRequisitions).values({
      id: requisitionId,
      name,
      status: "draft",
      createdByUserId,
    });
    
    if (resolved.length > 0) {
      await tx.insert(purchaseRequisitionItems).values(
        resolved.map((r, i) => ({
          id: ulid(),
          requisitionId,
          variantId: r.suggestion.variantId,
          qtyRequested: r.qty,
          sortOrder: i,
        })),
      );
    }
    
    await tx
      .update(reorderSuggestions)
      .set({ status: "converted" })
      .where(
        inArray(
          reorderSuggestions.id,
          resolved.map((r) => r.suggestion.id),
        ),
      );
      
    const row = await tx.query.purchaseRequisitions.findFirst({
      where: eq(purchaseRequisitions.id, requisitionId),
    });
    return row!;
  });
}

/** One selected suggestion to append to an existing PO, with optional qty override. */
export interface AddReorderLine {
  suggestionId: string;
  /** Override the suggested quantity. Defaults to the suggestion's value. */
  qty?: number;
}

type PurchaseRequisitionItem = typeof purchaseRequisitionItems.$inferSelect;

/**
 * Append selected open suggestions as lines on an *existing* requisition.
 */
export async function addSuggestionsToRequisition(
  requisitionId: string,
  lines: AddReorderLine[],
): Promise<PurchaseRequisitionItem[]> {
  if (!lines.length) throw new ReorderError("EMPTY_SELECTION");

  const requisition = await db.query.purchaseRequisitions.findFirst({
    where: eq(purchaseRequisitions.id, requisitionId),
  });
  if (!requisition) throw new ReorderError("PURCHASE_NOT_FOUND");
  if (requisition.status === "cancelled") {
    throw new ReorderError("PURCHASE_NOT_OPEN", "requisition is cancelled");
  }

  // Resolve each line against its suggestion before opening the transaction.
  type Resolved = { suggestion: Suggestion; qty: number };
  const resolved: Resolved[] = [];
  for (const line of lines) {
    const suggestion = await loadSuggestion(line.suggestionId);
    if (suggestion.status !== "open") {
      throw new ReorderError(
        "NOT_OPEN",
        `suggestion ${line.suggestionId} is already ${suggestion.status}`,
      );
    }
    const qty = line.qty ?? suggestion.suggestedQty;
    if (!Number.isInteger(qty) || qty <= 0) {
      throw new ReorderError("INVALID_INPUT", "qty must be a positive integer");
    }
    resolved.push({ suggestion, qty });
  }

  const ids = await db.transaction(async (tx) => {
    const [{ maxSort } = { maxSort: null }] = await tx
      .select({ maxSort: sql<number | null>`max(${purchaseRequisitionItems.sortOrder})` })
      .from(purchaseRequisitionItems)
      .where(eq(purchaseRequisitionItems.requisitionId, requisitionId));
    let next = (maxSort ?? -1) + 1;
    const rows = resolved.map((r) => ({
      id: ulid(),
      requisitionId,
      variantId: r.suggestion.variantId,
      qtyRequested: r.qty,
      sortOrder: next++,
    }));
    await tx.insert(purchaseRequisitionItems).values(rows);
    await tx
      .update(reorderSuggestions)
      .set({ status: "converted" })
      .where(
        inArray(
          reorderSuggestions.id,
          resolved.map((r) => r.suggestion.id),
        ),
      );
    return rows.map((r) => r.id);
  });

  return db.query.purchaseRequisitionItems.findMany({
    where: inArray(purchaseRequisitionItems.id, ids),
    orderBy: (pi, { asc }) => asc(pi.sortOrder),
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

// --- Budget Sandbox ---

export interface BudgetReorderPlanLine {
  suggestionId: string;
  variantId: string;
  vendorId: string | null;
  suggestedQty: number;
  estimatedUnitCost: number;
  estimatedTotalCost: number;
  priorityScore: number;
  status: string;
}

export interface BudgetReorderPlan {
  totalEstimatedCost: number;
  remainingBudget: number;
  lines: BudgetReorderPlanLine[];
}

export async function simulateBudgetReorder(budgetAmount: number): Promise<BudgetReorderPlan> {
  const suggestions = await runReorderScan();
  if (suggestions.length === 0) {
    return { totalEstimatedCost: 0, remainingBudget: budgetAmount, lines: [] };
  }
  
  const forecast = await reorderForecast();
  const forecastByVariant = new Map(forecast.map(f => [f.variantId, f]));
  
  const variantIds = [...new Set(suggestions.map((s) => s.variantId))];
  const variantRows = await db
    .select({ id: productVariants.id, costMinor: productVariants.costMinor })
    .from(productVariants)
    .where(inArray(productVariants.id, variantIds));
  const costByVariant = new Map(variantRows.map((v) => [v.id, v.costMinor]));

  const vendorIds = [...new Set(suggestions.map((s) => s.vendorId).filter((id): id is string => !!id))];
  const lastCostByVendor = new Map<string, Map<string, number>>();
  for (const vendorId of vendorIds) {
    const last = await lastVendorCosts(vendorId);
    lastCostByVendor.set(vendorId, new Map(last.map((c) => [c.variantId, c.unitCostMinor])));
  }
  
  type ScoredSuggestion = {
    suggestion: typeof suggestions[0];
    status: string;
    velocity: number;
    score: number;
    unitCost: number;
  };
  
  const scored: ScoredSuggestion[] = suggestions.map(s => {
    const f = forecastByVariant.get(s.variantId);
    const status = f?.status ?? "unknown";
    const velocity = f?.velocityPerDay ?? 0;
    
    let score = velocity * 100;
    if (status === "order_now") score += 100000;
    else if (status === "order_soon") score += 50000;
    else if (s.currentStock <= s.reorderPoint) score += 25000;
    
    const unitCostMinor = (s.vendorId ? lastCostByVendor.get(s.vendorId)?.get(s.variantId) : undefined) ?? costByVariant.get(s.variantId) ?? 0;
    const unitCost = unitCostMinor;
    
    return { suggestion: s, status, velocity, score, unitCost };
  });
  
  scored.sort((a, b) => b.score - a.score);
  
  let remaining = budgetAmount;
  let totalCost = 0;
  const lines: BudgetReorderPlanLine[] = [];
  
  for (const item of scored) {
    if (remaining <= 0) break;
    
    const suggestedQty = item.suggestion.suggestedQty;
    const lineCost = suggestedQty * item.unitCost;
    
    if (remaining >= lineCost) {
      lines.push({
        suggestionId: item.suggestion.id,
        variantId: item.suggestion.variantId,
        vendorId: item.suggestion.vendorId,
        suggestedQty,
        estimatedUnitCost: item.unitCost,
        estimatedTotalCost: lineCost,
        priorityScore: item.score,
        status: item.status,
      });
      remaining -= lineCost;
      totalCost += lineCost;
    } else {
      if (item.unitCost > 0) {
        const affordableQty = Math.floor(remaining / item.unitCost);
        if (affordableQty > 0) {
          const partialCost = affordableQty * item.unitCost;
          lines.push({
            suggestionId: item.suggestion.id,
            variantId: item.suggestion.variantId,
            vendorId: item.suggestion.vendorId,
            suggestedQty: affordableQty,
            estimatedUnitCost: item.unitCost,
            estimatedTotalCost: partialCost,
            priorityScore: item.score,
            status: item.status,
          });
          remaining -= partialCost;
          totalCost += partialCost;
        }
      }
    }
  }
  
  return {
    totalEstimatedCost: totalCost,
    remainingBudget: remaining,
    lines,
  };
}
