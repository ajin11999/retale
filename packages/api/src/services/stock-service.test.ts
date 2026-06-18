// Unit tests for the non_stock guard in recordMovement: quantity-changing
// movements are rejected, while a cost-only `cost_override` is allowed and
// updates the variant cost without ever creating a stock_locations row.
//
//   bun test src/services/stock-service.test.ts

import "../lib/load-env.ts";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { eq, sql } from "drizzle-orm";
import { ulid } from "ulid";
import { users } from "../db/schema/auth.ts";
import { products, productVariants } from "../db/schema/products.ts";
import { stockLocations } from "../db/schema/stock.ts";
import { db } from "../lib/db.ts";
import { recordMovement, StockError } from "./stock-service.ts";

let userId: string;

async function wipe(): Promise<void> {
  await db.execute(sql`SET FOREIGN_KEY_CHECKS = 0`);
  for (const t of ["stock_movements", "stock_locations", "product_variants", "products"]) {
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
    name: "Stock Service Test",
  });
});

afterAll(async () => {
  await wipe();
  await db.delete(users).where(eq(users.id, userId));
});

beforeEach(wipe);

async function seedVariant(opts: {
  kind?: "physical" | "non_stock";
  costMinor?: number;
}): Promise<string> {
  const productId = ulid();
  const variantId = ulid();
  await db.insert(products).values({
    id: productId,
    name: "Fastener",
    kind: opts.kind ?? "physical",
    priceMode: "tax_exclusive",
  });
  await db.insert(productVariants).values({
    id: variantId,
    productId,
    sku: `SKU-${variantId}`,
    priceMinor: 5000,
    costMinor: opts.costMinor ?? 0,
  });
  return variantId;
}

function variantRow(variantId: string) {
  return db
    .select()
    .from(productVariants)
    .where(eq(productVariants.id, variantId))
    .then((r) => r[0]!);
}

describe("non_stock guard in recordMovement", () => {
  test("rejects a quantity-changing movement", async () => {
    const variantId = await seedVariant({ kind: "non_stock" });
    let err: unknown;
    try {
      await recordMovement({
        variantId,
        type: "purchase_receive",
        qtyDelta: 10,
        unitCost: 100,
        refType: "purchase",
        createdByUserId: userId,
      });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(StockError);
    expect((err as StockError).code).toBe("NON_STOCK_NO_QTY");
  });

  test("allows a cost_override, updating the cost with no stock row", async () => {
    const variantId = await seedVariant({ kind: "non_stock", costMinor: 3000 });

    await recordMovement({
      variantId,
      type: "cost_override",
      qtyDelta: 0,
      unitCost: 4200,
      refType: "purchase",
      createdByUserId: userId,
    });

    const v = await variantRow(variantId);
    expect(v.costMinor).toBe(4200);
    expect(v.totalQty).toBe(0);

    // The cost-only update must never materialise a stock_locations row.
    const rows = await db
      .select()
      .from(stockLocations)
      .where(eq(stockLocations.variantId, variantId));
    expect(rows).toHaveLength(0);
  });
});
