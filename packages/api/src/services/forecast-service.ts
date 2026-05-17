// Reorder forecast: projects, from each monitored product's recent sales
// velocity, how long its stock will last and the date a purchase order must
// be placed by — accounting for the supplier's delivery lead time. A live
// read model; nothing is stored. See the "Product alerts" design note for the
// related (threshold-based, not yet built) low_stock alert.

import { and, eq, gte, isNull, sql } from "drizzle-orm";
import { orderItems, orders } from "../db/schema/orders.ts";
import { products, productVariants } from "../db/schema/products.ts";
import { vendors } from "../db/schema/vendors.ts";
import { db } from "../lib/db.ts";

export type ReorderStatus =
  | "order_now"
  | "order_soon"
  | "ok"
  | "insufficient_data";

/** Which window's rate the effective velocity was taken from. */
export type VelocityBasis = "baseline" | "recent" | "none";

export interface ReorderForecastRow {
  variantId: string;
  productId: string;
  productName: string;
  sku: string;
  /** Stock on hand, in the variant's smallest unit. */
  currentQty: number;
  /** Effective velocity: the higher of the baseline and recent rates. */
  velocityPerDay: number;
  /** Net units/day averaged over the full (default 30-day) window. */
  baselineVelocityPerDay: number;
  /** Net units/day averaged over the recent (default 7-day) window. */
  recentVelocityPerDay: number;
  /** Which rate `velocityPerDay` came from — `recent` means accelerating. */
  velocityBasis: VelocityBasis;
  /** `currentQty / velocity`; null when nothing is depleting. */
  daysOfCover: number | null;
  /** Lead time from the product's primary vendor; null when unknown. */
  leadTimeDays: number | null;
  /** ISO date (YYYY-MM-DD) a PO must be placed by; null when uncomputable. */
  orderByDate: string | null;
  status: ReorderStatus;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** Format a Date as a local `YYYY-MM-DD` stamp. */
function dateStamp(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/**
 * Forecast reorder timing for every monitored, physical, non-archived product
 * variant. Velocity is net sales/day (sales positive, returns negative); the
 * effective `velocityPerDay` is the *higher* of a baseline (30-day) and a
 * recent (7-day) rate, so a product selling fast lately is caught before a
 * flat average would notice. `orderByDate = today + daysOfCover − leadTime`.
 */
export async function reorderForecast(opts?: {
  /** Baseline window for the velocity average, in days. Default 30. */
  windowDays?: number;
  /** Recent window that catches acceleration, in days. Default 7. */
  recentWindowDays?: number;
  /** An orderBy within this many days counts as `order_soon`. Default 7. */
  soonHorizonDays?: number;
}): Promise<ReorderForecastRow[]> {
  const windowDays = Math.max(1, Math.floor(opts?.windowDays ?? 30));
  const recentWindowDays = Math.min(
    windowDays,
    Math.max(1, Math.floor(opts?.recentWindowDays ?? 7)),
  );
  const soonHorizon = Math.max(0, Math.floor(opts?.soonHorizonDays ?? 7));
  const since = new Date(Date.now() - windowDays * DAY_MS);
  const recentSince = new Date(Date.now() - recentWindowDays * DAY_MS);

  // Monitored physical products and their variants.
  const rows = await db
    .select({
      variantId: productVariants.id,
      sku: productVariants.sku,
      currentQty: productVariants.totalQty,
      productId: products.id,
      productName: products.name,
      primaryVendorId: products.primaryVendorId,
    })
    .from(productVariants)
    .innerJoin(products, eq(productVariants.productId, products.id))
    .where(
      and(
        eq(products.kind, "physical"),
        eq(products.replenishMonitored, true),
        isNull(products.archivedAt),
      ),
    );
  if (rows.length === 0) return [];

  // Net units sold per variant — over the full window, and within the recent
  // sub-window — in one pass (returns are negative qty).
  const velocityRows = await db
    .select({
      variantId: orderItems.variantId,
      netFull: sql<number>`SUM(${orderItems.qty})`,
      netRecent: sql<number>`SUM(CASE WHEN ${orderItems.createdAt} >= ${recentSince} THEN ${orderItems.qty} ELSE 0 END)`,
    })
    .from(orderItems)
    .innerJoin(orders, eq(orderItems.orderId, orders.id))
    .where(
      and(
        isNull(orderItems.voidedAt),
        isNull(orders.cancelledAt),
        gte(orderItems.createdAt, since),
      ),
    )
    .groupBy(orderItems.variantId);
  const netByVariant = new Map<string, { full: number; recent: number }>();
  for (const v of velocityRows) {
    if (v.variantId) {
      netByVariant.set(v.variantId, {
        full: Number(v.netFull ?? 0),
        recent: Number(v.netRecent ?? 0),
      });
    }
  }

  // Lead time per vendor referenced as a primary vendor.
  const vendorIds = [
    ...new Set(rows.map((r) => r.primaryVendorId).filter((id): id is string => !!id)),
  ];
  const leadByVendor = new Map<string, number | null>();
  if (vendorIds.length) {
    const vendorRows = await db
      .select({ id: vendors.id, leadTimeDays: vendors.leadTimeDays })
      .from(vendors);
    for (const v of vendorRows) leadByVendor.set(v.id, v.leadTimeDays);
  }

  const now = Date.now();
  return rows.map((r): ReorderForecastRow => {
    const net = netByVariant.get(r.variantId) ?? { full: 0, recent: 0 };
    // Negative net (more returned than sold) is not depletion — floor at 0.
    const baselineVelocityPerDay = Math.max(net.full, 0) / windowDays;
    const recentVelocityPerDay = Math.max(net.recent, 0) / recentWindowDays;
    const velocityPerDay = Math.max(baselineVelocityPerDay, recentVelocityPerDay);
    const velocityBasis: VelocityBasis =
      velocityPerDay <= 0
        ? "none"
        : recentVelocityPerDay > baselineVelocityPerDay
          ? "recent"
          : "baseline";
    const leadTimeDays = r.primaryVendorId
      ? leadByVendor.get(r.primaryVendorId) ?? null
      : null;

    let daysOfCover: number | null = null;
    let orderByDate: string | null = null;
    let status: ReorderStatus;

    if (velocityPerDay <= 0) {
      // Not depleting — no reorder pressure.
      status = "ok";
    } else {
      daysOfCover = r.currentQty / velocityPerDay;
      if (leadTimeDays == null) {
        // Velocity known but no lead time — can't place the order date.
        status = "insufficient_data";
      } else {
        const daysUntilOrder = daysOfCover - leadTimeDays;
        orderByDate = dateStamp(new Date(now + daysUntilOrder * DAY_MS));
        status =
          daysUntilOrder <= 0
            ? "order_now"
            : daysUntilOrder <= soonHorizon
              ? "order_soon"
              : "ok";
      }
    }

    return {
      variantId: r.variantId,
      productId: r.productId,
      productName: r.productName,
      sku: r.sku,
      currentQty: r.currentQty,
      velocityPerDay,
      baselineVelocityPerDay,
      recentVelocityPerDay,
      velocityBasis,
      daysOfCover,
      leadTimeDays,
      orderByDate,
      status,
    };
  });
}
