// Product alert service: the margin-threshold alert system. `scanProductAlerts`
// evaluates every product's variants against its margin threshold and raises
// `product_alerts` for breaches and data anomalies; `evaluateProductAlerts`
// does one product. Idempotent — never a second open alert for the same
// (product, type). A scan also auto-resolves: an open alert whose condition no
// longer holds (e.g. the price was fixed) is acknowledged automatically with
// AUTO_RESOLVE_NOTE, so fixing the numbers clears the alert without a manual
// ack. See docs/design-decisions.md → "Product alerts".

import { and, desc, eq, inArray, isNotNull, isNull, lt } from "drizzle-orm";
import { ulid } from "ulid";
import { productAlerts, type PRODUCT_ALERT_TYPES } from "../db/schema/product-alerts.ts";
import { productCategories, products, productVariants } from "../db/schema/products.ts";
import { db } from "../lib/db.ts";

export type ProductAlertErrorCode =
  | "ALERT_NOT_FOUND"
  | "ALREADY_ACKNOWLEDGED"
  | "PRODUCT_NOT_FOUND";

export class ProductAlertError extends Error {
  constructor(
    public code: ProductAlertErrorCode,
    message?: string,
  ) {
    super(message ?? code);
    this.name = "ProductAlertError";
  }
}

type ProductAlert = typeof productAlerts.$inferSelect;
type ProductAlertType = (typeof PRODUCT_ALERT_TYPES)[number];

/** Acknowledged alerts older than this are purged by the retention job. */
export const ACK_RETENTION_DAYS = 365;

/** Resolution note stamped on alerts the scan auto-acknowledges. */
export const AUTO_RESOLVE_NOTE = "Auto-resolved: condition no longer met.";

const MS_PER_DAY = 86_400_000;

// --- Classification ---

interface VariantContext {
  variantId: string;
  sku: string;
  priceMinor: number;
  costMinor: number;
  marginBps: number | null;
}

/**
 * Classify one variant's price/cost against a margin threshold. Returns the
 * alert type it triggers, or null when healthy. `cost = 0` (cost not yet
 * established from a receipt) is skipped — there's nothing to measure against.
 * A `price = 0` on a variant that *does* have a cost is not a free item: it is
 * unpriced and would sell at a loss, so it raises `negative_margin` (its margin
 * can't be expressed as a %, so `marginBps` is null).
 */
export function classifyVariant(
  priceMinor: number,
  costMinor: number,
  thresholdBps: number | null,
): { type: ProductAlertType; marginBps: number | null } | null {
  if (priceMinor < 0) return { type: "negative_price", marginBps: null };
  if (costMinor < 0) return { type: "data_anomaly", marginBps: null };
  if (costMinor === 0) return null; // no cost basis yet — can't assess margin
  if (priceMinor === 0) return { type: "negative_margin", marginBps: null };
  const marginBps = Math.round(((priceMinor - costMinor) / priceMinor) * 10000);
  if (priceMinor < costMinor) return { type: "negative_margin", marginBps };
  if (thresholdBps != null && marginBps < thresholdBps) {
    return { type: "low_margin", marginBps };
  }
  return null;
}

/** Group the alert types a set of variants triggers, with per-variant context. */
function triggeredTypes(
  variants: { id: string; sku: string; priceMinor: number; costMinor: number }[],
  thresholdBps: number | null,
): Map<ProductAlertType, VariantContext[]> {
  const out = new Map<ProductAlertType, VariantContext[]>();
  for (const v of variants) {
    const hit = classifyVariant(v.priceMinor, v.costMinor, thresholdBps);
    if (!hit) continue;
    const list = out.get(hit.type) ?? [];
    list.push({
      variantId: v.id,
      sku: v.sku,
      priceMinor: v.priceMinor,
      costMinor: v.costMinor,
      marginBps: hit.marginBps,
    });
    out.set(hit.type, list);
  }
  return out;
}

// --- Reads ---

async function loadAlert(id: string): Promise<ProductAlert> {
  const row = await db.query.productAlerts.findFirst({
    where: eq(productAlerts.id, id),
  });
  if (!row) throw new ProductAlertError("ALERT_NOT_FOUND");
  return row;
}

export { loadAlert as getProductAlert };

/** Alerts, newest first; optionally filtered to open or acknowledged only. */
export function listProductAlerts(opts?: {
  acknowledged?: boolean;
}): Promise<ProductAlert[]> {
  const filter =
    opts?.acknowledged === undefined
      ? undefined
      : opts.acknowledged
        ? isNotNull(productAlerts.acknowledgedAt)
        : isNull(productAlerts.acknowledgedAt);
  return db
    .select()
    .from(productAlerts)
    .where(filter)
    .orderBy(desc(productAlerts.triggeredAt));
}

// --- Evaluation ---

interface EvaluatedProduct {
  productId: string;
  thresholdBps: number | null;
  triggered: Map<ProductAlertType, VariantContext[]>;
}

/** An open (unacknowledged) alert, as loaded for reconciliation. */
interface OpenAlertRow {
  id: string;
  productId: string;
  type: string;
}

/**
 * Reconcile a set of evaluated products against their currently-open alerts:
 *  - raise: insert an alert for each triggered (product, type) with no open
 *    alert yet;
 *  - resolve: auto-acknowledge any open alert whose type is no longer triggered
 *    (the underlying numbers recovered), stamping AUTO_RESOLVE_NOTE.
 *
 * Only products in `evaluated` are reconciled — open alerts for products
 * outside the scan (e.g. archived, so we can't reassess them) are left as-is.
 * Returns the alerts raised (resolves happen silently).
 */
async function syncAlerts(
  evaluated: EvaluatedProduct[],
  openAlerts: OpenAlertRow[],
): Promise<ProductAlert[]> {
  const openByProduct = new Map<string, Map<string, string>>();
  for (const r of openAlerts) {
    const byType = openByProduct.get(r.productId) ?? new Map<string, string>();
    byType.set(r.type, r.id);
    openByProduct.set(r.productId, byType);
  }

  const now = new Date();
  const toInsert: (typeof productAlerts.$inferInsert)[] = [];
  const toResolve: string[] = [];

  for (const p of evaluated) {
    const open = openByProduct.get(p.productId) ?? new Map<string, string>();
    for (const [type, variants] of p.triggered) {
      if (open.has(type)) continue; // already open — keep it idempotent
      toInsert.push({
        id: ulid(),
        productId: p.productId,
        type,
        triggeredAt: now,
        triggerContext: { thresholdBps: p.thresholdBps, variants },
      });
    }
    for (const [type, id] of open) {
      if (!p.triggered.has(type as ProductAlertType)) toResolve.push(id);
    }
  }

  if (toResolve.length > 0) {
    await db
      .update(productAlerts)
      .set({ acknowledgedAt: now, resolutionNote: AUTO_RESOLVE_NOTE })
      .where(inArray(productAlerts.id, toResolve));
  }

  if (toInsert.length === 0) return [];
  await db.insert(productAlerts).values(toInsert);
  return db
    .select()
    .from(productAlerts)
    .where(
      inArray(
        productAlerts.id,
        toInsert.map((r) => r.id as string),
      ),
    );
}

/**
 * Evaluate one product and raise any new margin / anomaly alerts. The margin
 * threshold resolves product → category (product value wins); null on both
 * means no `low_margin` check. Anomalies (negative price/cost/margin) fire
 * regardless of threshold.
 */
export async function evaluateProductAlerts(
  productId: string,
): Promise<ProductAlert[]> {
  const product = await db.query.products.findFirst({
    where: eq(products.id, productId),
  });
  if (!product) throw new ProductAlertError("PRODUCT_NOT_FOUND");

  let thresholdBps = product.minMarginBps;
  if (thresholdBps == null && product.categoryId) {
    const category = await db.query.productCategories.findFirst({
      where: eq(productCategories.id, product.categoryId),
    });
    thresholdBps = category?.minMarginBps ?? null;
  }

  const variants = await db
    .select()
    .from(productVariants)
    .where(eq(productVariants.productId, productId));

  const openRows = await db
    .select({
      id: productAlerts.id,
      productId: productAlerts.productId,
      type: productAlerts.type,
    })
    .from(productAlerts)
    .where(
      and(eq(productAlerts.productId, productId), isNull(productAlerts.acknowledgedAt)),
    );

  return syncAlerts(
    [{ productId, thresholdBps, triggered: triggeredTypes(variants, thresholdBps) }],
    openRows,
  );
}

/**
 * Scan every non-archived product and raise new alerts. Bulk-loads in a
 * handful of queries — retail catalogs are small. Returns the alerts raised.
 */
export async function scanProductAlerts(): Promise<ProductAlert[]> {
  const allProducts = await db
    .select({
      id: products.id,
      categoryId: products.categoryId,
      minMarginBps: products.minMarginBps,
    })
    .from(products)
    .where(isNull(products.archivedAt));
  if (allProducts.length === 0) return [];

  const categories = await db
    .select({ id: productCategories.id, minMarginBps: productCategories.minMarginBps })
    .from(productCategories);
  const categoryThreshold = new Map(categories.map((c) => [c.id, c.minMarginBps]));

  const variants = await db
    .select({
      id: productVariants.id,
      productId: productVariants.productId,
      sku: productVariants.sku,
      priceMinor: productVariants.priceMinor,
      costMinor: productVariants.costMinor,
    })
    .from(productVariants);
  const variantsByProduct = new Map<string, (typeof variants)[number][]>();
  for (const v of variants) {
    const list = variantsByProduct.get(v.productId) ?? [];
    list.push(v);
    variantsByProduct.set(v.productId, list);
  }

  const openRows = await db
    .select({
      id: productAlerts.id,
      productId: productAlerts.productId,
      type: productAlerts.type,
    })
    .from(productAlerts)
    .where(isNull(productAlerts.acknowledgedAt));

  const evaluated = allProducts.map((p) => {
    const thresholdBps =
      p.minMarginBps ??
      (p.categoryId ? (categoryThreshold.get(p.categoryId) ?? null) : null);
    return {
      productId: p.id,
      thresholdBps,
      triggered: triggeredTypes(variantsByProduct.get(p.id) ?? [], thresholdBps),
    };
  });

  return syncAlerts(evaluated, openRows);
}

// --- Acknowledge & retention ---

/** Acknowledge an alert — a person has seen it. Acknowledged once, never reopened. */
export async function acknowledgeProductAlert(input: {
  id: string;
  userId: string;
  resolutionNote?: string | null;
}): Promise<ProductAlert> {
  const alert = await loadAlert(input.id);
  if (alert.acknowledgedAt) {
    throw new ProductAlertError(
      "ALREADY_ACKNOWLEDGED",
      "this alert has already been acknowledged",
    );
  }
  await db
    .update(productAlerts)
    .set({
      acknowledgedAt: new Date(),
      acknowledgedByUserId: input.userId,
      resolutionNote: input.resolutionNote?.trim() || null,
    })
    .where(eq(productAlerts.id, input.id));
  return loadAlert(input.id);
}

/**
 * Hard-delete acknowledged alerts older than `olderThanDays` — table-bloat
 * control. Open alerts are never purged. Returns the count removed.
 */
export async function purgeAcknowledgedProductAlerts(
  olderThanDays: number = ACK_RETENTION_DAYS,
): Promise<number> {
  const cutoff = new Date(Date.now() - olderThanDays * MS_PER_DAY);
  const stale = await db
    .select({ id: productAlerts.id })
    .from(productAlerts)
    .where(
      and(
        isNotNull(productAlerts.acknowledgedAt),
        lt(productAlerts.acknowledgedAt, cutoff),
      ),
    );
  if (stale.length === 0) return 0;
  await db.delete(productAlerts).where(
    inArray(
      productAlerts.id,
      stale.map((s) => s.id),
    ),
  );
  return stale.length;
}
