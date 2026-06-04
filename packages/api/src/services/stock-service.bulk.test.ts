// Integration tests for the bulk stock editor's service surface:
// `getLocationStockLevels` and `bulkAdjustStock`. Runs against the local dev
// MariaDB (DATABASE_URL) and WIPEs stock / product tables between tests.
//
//   bun test src/services/stock-service.bulk.test.ts

import "../lib/load-env.ts";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { and, eq, isNull, sql } from "drizzle-orm";
import { ulid } from "ulid";
import { users } from "../db/schema/auth.ts";
import { locations } from "../db/schema/locations.ts";
import { products, productVariants } from "../db/schema/products.ts";
import { stockLocations, stockMovements } from "../db/schema/stock.ts";
import { db } from "../lib/db.ts";
import {
  bulkAdjustStock,
  getLocationStockLevels,
  StockError,
} from "./stock-service.ts";

let userId: string;
let locId: string;

async function wipe(): Promise<void> {
  await db.execute(sql`SET FOREIGN_KEY_CHECKS = 0`);
  for (const t of [
    "stock_movements", "stock_locations",
    "product_variants", "products", "locations",
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
    name: "Bulk Stock Test",
  });
});

afterAll(async () => {
  await wipe();
  await db.delete(users).where(eq(users.id, userId));
});

beforeEach(async () => {
  await wipe();
  locId = ulid();
  await db.insert(locations).values({ id: locId, name: "Warehouse" });
});

/** Seed a variant, optionally with `qty` units at `locationId` (null = root). */
async function seedVariant(opts: {
  name?: string;
  qty?: number;
  locationId?: string | null;
}): Promise<string> {
  const productId = ulid();
  const variantId = ulid();
  await db.insert(products).values({
    id: productId,
    name: opts.name ?? "Widget",
    priceMode: "tax_exclusive",
  });
  await db.insert(productVariants).values({
    id: variantId,
    productId,
    sku: `SKU-${variantId}`,
    priceMinor: 1000,
    totalQty: opts.qty ?? 0,
  });
  if (opts.qty != null) {
    await db.insert(stockLocations).values({
      id: ulid(),
      variantId,
      locationId: opts.locationId ?? null,
      qty: opts.qty,
    });
  }
  return variantId;
}

function onHand(variantId: string, locationId: string | null): Promise<number> {
  return db
    .select()
    .from(stockLocations)
    .where(
      and(
        eq(stockLocations.variantId, variantId),
        locationId == null
          ? isNull(stockLocations.locationId)
          : eq(stockLocations.locationId, locationId),
      ),
    )
    .then((r) => r[0]?.qty ?? 0);
}

describe("getLocationStockLevels", () => {
  test("returns one row per variant holding stock at the location", async () => {
    await seedVariant({ name: "Bravo", qty: 10, locationId: locId });
    await seedVariant({ name: "Alpha", qty: 4, locationId: locId });
    await seedVariant({ name: "Elsewhere", qty: 99, locationId: null }); // root only

    const rows = await getLocationStockLevels(locId);
    expect(rows.map((r) => r.productName)).toEqual(["Alpha", "Bravo"]); // name-sorted
    expect(rows.map((r) => r.onHand)).toEqual([4, 10]);
  });

  test("targets the root bucket when locationId is null", async () => {
    await seedVariant({ qty: 7, locationId: null });
    await seedVariant({ qty: 3, locationId: locId });

    const rows = await getLocationStockLevels(null);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.onHand).toBe(7);
  });
});

describe("bulkAdjustStock", () => {
  test("writes only the lines whose count differs, with the right sign", async () => {
    const down = await seedVariant({ qty: 10, locationId: locId });
    const up = await seedVariant({ qty: 5, locationId: locId });
    const same = await seedVariant({ qty: 8, locationId: locId });

    const adjusted = await bulkAdjustStock({
      locationId: locId,
      reason: "Stocktake",
      createdByUserId: userId,
      lines: [
        { variantId: down, countedQty: 8 }, // −2
        { variantId: up, countedQty: 12 }, // +7
        { variantId: same, countedQty: 8 }, // unchanged → skipped
      ],
    });

    expect(adjusted).toBe(2);
    expect(await onHand(down, locId)).toBe(8);
    expect(await onHand(up, locId)).toBe(12);
    expect(await onHand(same, locId)).toBe(8);

    const moves = await db
      .select()
      .from(stockMovements)
      .where(eq(stockMovements.variantId, down));
    expect(moves).toHaveLength(1);
    expect(moves[0]?.type).toBe("adjustment_out");
    expect(moves[0]?.qtyDelta).toBe(-2);
    expect(moves[0]?.reason).toBe("Stocktake");
  });

  test("counts a variant with no row here from zero", async () => {
    const v = await seedVariant({ qty: 0 }); // no stock_locations row at all

    const adjusted = await bulkAdjustStock({
      locationId: locId,
      reason: "Initial count",
      createdByUserId: userId,
      lines: [{ variantId: v, countedQty: 25 }],
    });

    expect(adjusted).toBe(1);
    expect(await onHand(v, locId)).toBe(25);
  });

  test("rejects a blank reason", async () => {
    const v = await seedVariant({ qty: 1, locationId: locId });
    let err: unknown;
    try {
      await bulkAdjustStock({
        locationId: locId,
        reason: "   ",
        createdByUserId: userId,
        lines: [{ variantId: v, countedQty: 2 }],
      });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(StockError);
    expect((err as StockError).code).toBe("INVALID_INPUT");
  });

  test("rolls back every line if one variant is invalid", async () => {
    const good = await seedVariant({ qty: 10, locationId: locId });
    let err: unknown;
    try {
      await bulkAdjustStock({
        locationId: locId,
        reason: "Stocktake",
        createdByUserId: userId,
        lines: [
          { variantId: good, countedQty: 5 },
          { variantId: ulid(), countedQty: 3 }, // nonexistent → VARIANT_NOT_FOUND
        ],
      });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(StockError);
    // The good line's change must not have committed.
    expect(await onHand(good, locId)).toBe(10);
  });
});
