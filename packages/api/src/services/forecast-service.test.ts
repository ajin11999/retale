// Integration tests for the reorder forecast. These run against the local
// Docker MariaDB (DATABASE_URL) and WIPE the order / product / vendor tables
// between tests, so point them only at a dev database.
//
//   bun test src/services/forecast-service.test.ts

import "../lib/load-env.ts";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { eq, sql } from "drizzle-orm";
import { ulid } from "ulid";
import { users } from "../db/schema/auth.ts";
import { locations } from "../db/schema/locations.ts";
import { orderItems } from "../db/schema/orders.ts";
import { products, productVariants } from "../db/schema/products.ts";
import { stockLocations } from "../db/schema/stock.ts";
import { vendors } from "../db/schema/vendors.ts";
import { db } from "../lib/db.ts";
import { reorderForecast, type ReorderForecastRow } from "./forecast-service.ts";
import { createPosOrder } from "./order-service.ts";
import { createPointOfSale, openSession } from "./pos-service.ts";

let userId: string;
let locationId: string;

async function wipe(): Promise<void> {
  await db.execute(sql`SET FOREIGN_KEY_CHECKS = 0`);
  for (const t of [
    "order_payments", "order_items", "orders",
    "stock_movements", "stock_locations",
    "product_variants", "products",
    "pos_sessions", "points_of_sale", "locations", "vendors",
  ]) {
    await db.execute(sql.raw(`DELETE FROM \`${t}\``));
  }
  await db.execute(sql`SET FOREIGN_KEY_CHECKS = 1`);
}

beforeAll(async () => {
  userId = ulid();
  await db.insert(users).values({
    id: userId,
    username: `test_${userId}`,
    passwordHash: "x",
    name: "Forecast Test",
  });
});

afterAll(async () => {
  await wipe();
  await db.delete(users).where(eq(users.id, userId));
  // The shared pool is closed once globally — see src/test-setup.ts.
});

beforeEach(async () => {
  await wipe();
  locationId = ulid();
  await db.insert(locations).values({ id: locationId, name: "Warehouse" });
});

/** Open a POS session; returns its id. `code` must be unique per test. */
async function seedSession(code: string): Promise<string> {
  const pos = await createPointOfSale({
    locationId,
    code,
    name: "Counter",
    createdByUserId: userId,
  });
  const session = await openSession({
    posId: pos.id,
    openingCashMinor: 0,
    openedByUserId: userId,
  });
  return session.id;
}

/**
 * Seed a monitored physical product + variant priced at 1/unit, stocked at
 * `stockQty`, optionally with a primary vendor carrying `leadTimeDays`.
 * Returns the variant id.
 */
async function seedVariant(opts: {
  stockQty: number;
  leadTimeDays?: number | null;
  monitored?: boolean;
}): Promise<string> {
  const vendorId = ulid();
  await db.insert(vendors).values({
    id: vendorId,
    name: "Acme Supply",
    leadTimeDays: opts.leadTimeDays ?? null,
  });
  const productId = ulid();
  const variantId = ulid();
  await db.insert(products).values({
    id: productId,
    name: "Widget",
    priceMode: "tax_exclusive",
    primaryVendorId: vendorId,
    replenishMonitored: opts.monitored ?? true,
  });
  await db.insert(productVariants).values({
    id: variantId,
    productId,
    sku: `SKU-${variantId}`,
    priceMinor: 1,
    totalQty: opts.stockQty,
  });
  await db.insert(stockLocations).values({
    id: ulid(),
    variantId,
    locationId,
    qty: opts.stockQty,
  });
  return variantId;
}

/**
 * Sell `qty` units of a variant priced at 1, then backdate the sale line's
 * `created_at` by `daysAgo` days so it lands in a chosen velocity window.
 */
async function sell(
  sessionId: string,
  variantId: string,
  qty: number,
  daysAgo = 0,
): Promise<void> {
  const order = await createPosOrder({
    posSessionId: sessionId,
    items: [{ variantId, qty }],
    payments: [{ amountMinor: qty }],
    createdByUserId: userId,
  });
  if (daysAgo > 0) {
    const when = new Date(Date.now() - daysAgo * 24 * 60 * 60 * 1000);
    await db
      .update(orderItems)
      .set({ createdAt: when })
      .where(eq(orderItems.orderId, order.id));
  }
}

/** The single forecast row for a variant. */
async function rowFor(variantId: string): Promise<ReorderForecastRow | undefined> {
  const all = await reorderForecast();
  return all.find((r) => r.variantId === variantId);
}

describe("reorder forecast", () => {
  test("baseline velocity drives order_now for a steady seller", async () => {
    // 300 sold 20 days ago — inside the 30-day window, outside the recent 7.
    const sessionId = await seedSession("P1");
    const variantId = await seedVariant({ stockQty: 350, leadTimeDays: 10 });
    await sell(sessionId, variantId, 300, 20);

    const row = await rowFor(variantId);
    expect(row!.baselineVelocityPerDay).toBe(10); // 300 / 30
    expect(row!.recentVelocityPerDay).toBe(0);
    expect(row!.velocityPerDay).toBe(10);
    expect(row!.velocityBasis).toBe("baseline");
    expect(row!.currentQty).toBe(50); // 350 - 300
    expect(row!.daysOfCover).toBe(5);
    expect(row!.status).toBe("order_now");
  });

  test("recent acceleration is caught before the flat average would notice", async () => {
    // 30 sold 20 days ago + 70 in the last 2 days. Baseline ≈ 3.3/day would
    // still look comfortable; the 7-day rate of 10/day flips it to order_now.
    const sessionId = await seedSession("P1");
    const variantId = await seedVariant({ stockQty: 150, leadTimeDays: 10 });
    await sell(sessionId, variantId, 30, 20);
    await sell(sessionId, variantId, 70, 2);

    const row = await rowFor(variantId);
    expect(row!.recentVelocityPerDay).toBe(10); // 70 / 7
    expect(row!.baselineVelocityPerDay).toBeCloseTo(100 / 30, 5);
    expect(row!.velocityPerDay).toBe(10);
    expect(row!.velocityBasis).toBe("recent");
    expect(row!.currentQty).toBe(50); // 150 - 100
    expect(row!.daysOfCover).toBe(5);
    expect(row!.status).toBe("order_now");
  });

  test("reports ok when stock comfortably outlasts the lead time", async () => {
    const sessionId = await seedSession("P1");
    const variantId = await seedVariant({ stockQty: 1000, leadTimeDays: 10 });
    await sell(sessionId, variantId, 30, 20); // 1/day baseline

    const row = await rowFor(variantId);
    expect(row!.velocityPerDay).toBe(1);
    expect(row!.status).toBe("ok");
  });

  test("reports ok with zero velocity for a product with no sales", async () => {
    await seedSession("P1");
    const variantId = await seedVariant({ stockQty: 100, leadTimeDays: 10 });
    const row = await rowFor(variantId);
    expect(row!.velocityPerDay).toBe(0);
    expect(row!.velocityBasis).toBe("none");
    expect(row!.daysOfCover).toBeNull();
    expect(row!.status).toBe("ok");
  });

  test("reports insufficient_data when the vendor has no lead time", async () => {
    const sessionId = await seedSession("P1");
    const variantId = await seedVariant({ stockQty: 100, leadTimeDays: null });
    await sell(sessionId, variantId, 70, 2);

    const row = await rowFor(variantId);
    expect(row!.velocityPerDay).toBeGreaterThan(0);
    expect(row!.leadTimeDays).toBeNull();
    expect(row!.orderByDate).toBeNull();
    expect(row!.status).toBe("insufficient_data");
  });

  test("excludes products with replenishment monitoring turned off", async () => {
    const sessionId = await seedSession("P1");
    const variantId = await seedVariant({
      stockQty: 350,
      leadTimeDays: 10,
      monitored: false,
    });
    await sell(sessionId, variantId, 300, 20);

    expect(await rowFor(variantId)).toBeUndefined();
  });
});
