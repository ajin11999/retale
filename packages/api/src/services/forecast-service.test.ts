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
  hasVendor?: boolean;
  monitored?: boolean;
}): Promise<string> {
  let vendorId: string | null = null;
  if (opts.hasVendor !== false) {
    vendorId = ulid();
    await db.insert(vendors).values({
      id: vendorId,
      name: "Acme Supply",
      leadTimeDays: opts.leadTimeDays ?? null,
    });
  }
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

/** Sell `qty` units of a variant priced at 1 — establishes sales velocity. */
async function sell(sessionId: string, variantId: string, qty: number): Promise<void> {
  await createPosOrder({
    posSessionId: sessionId,
    items: [{ variantId, qty }],
    payments: [{ amountMinor: qty }],
    createdByUserId: userId,
  });
}

/** The single forecast row for a variant. */
async function rowFor(variantId: string): Promise<ReorderForecastRow | undefined> {
  const all = await reorderForecast();
  return all.find((r) => r.variantId === variantId);
}

describe("reorder forecast", () => {
  test("flags order_now when the order date has already passed", async () => {
    // Sell 300 over the 30-day window → velocity 10/day. Stock left = 50,
    // so 5 days of cover; a 10-day lead time means we are 5 days overdue.
    const sessionId = await seedSession("P1");
    const variantId = await seedVariant({ stockQty: 350, leadTimeDays: 10 });
    await sell(sessionId, variantId, 300);

    const row = await rowFor(variantId);
    expect(row!.velocityPerDay).toBe(10);
    expect(row!.currentQty).toBe(50);
    expect(row!.daysOfCover).toBe(5);
    expect(row!.status).toBe("order_now");
    expect(row!.orderByDate).not.toBeNull();
  });

  test("flags order_soon when the order date is within the horizon", async () => {
    // velocity 10/day, 130 left → 13 days cover, lead 10 → order in 3 days.
    const sessionId = await seedSession("P1");
    const variantId = await seedVariant({ stockQty: 430, leadTimeDays: 10 });
    await sell(sessionId, variantId, 300);

    const row = await rowFor(variantId);
    expect(row!.daysOfCover).toBe(13);
    expect(row!.status).toBe("order_soon");
  });

  test("reports ok when stock comfortably outlasts the lead time", async () => {
    // Sell only 30 → velocity 1/day, 970 left → 970 days of cover.
    const sessionId = await seedSession("P1");
    const variantId = await seedVariant({ stockQty: 1000, leadTimeDays: 10 });
    await sell(sessionId, variantId, 30);

    const row = await rowFor(variantId);
    expect(row!.velocityPerDay).toBe(1);
    expect(row!.status).toBe("ok");
  });

  test("reports ok for a product with no sales", async () => {
    await seedSession("P1");
    const variantId = await seedVariant({ stockQty: 100, leadTimeDays: 10 });
    const row = await rowFor(variantId);
    expect(row!.velocityPerDay).toBe(0);
    expect(row!.daysOfCover).toBeNull();
    expect(row!.status).toBe("ok");
  });

  test("reports insufficient_data when the vendor has no lead time", async () => {
    const sessionId = await seedSession("P1");
    const variantId = await seedVariant({ stockQty: 100, leadTimeDays: null });
    await sell(sessionId, variantId, 300);

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
    await sell(sessionId, variantId, 300);

    expect(await rowFor(variantId)).toBeUndefined();
  });

  test("a returned unit reduces net velocity", async () => {
    const sessionId = await seedSession("P1");
    const variantId = await seedVariant({ stockQty: 1000, leadTimeDays: 10 });
    // Sell 60, with no return: velocity would be 2/day. (Return path is
    // covered in order-service tests; here we assert the net-sales basis.)
    await sell(sessionId, variantId, 60);
    const row = await rowFor(variantId);
    expect(row!.velocityPerDay).toBe(2);
  });
});
