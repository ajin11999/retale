// Integration tests for the stock transfer lifecycle. These run against the
// local Docker MariaDB (DATABASE_URL) and WIPE the transfer / stock / product
// tables between tests, so point them only at a dev database.
//
//   bun test src/services/transfer-service.test.ts

import "../lib/load-env.ts";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { and, eq, sql } from "drizzle-orm";
import { ulid } from "ulid";
import { users } from "../db/schema/auth.ts";
import { locations } from "../db/schema/locations.ts";
import { products, productVariants } from "../db/schema/products.ts";
import { stockLocations } from "../db/schema/stock.ts";
import { db } from "../lib/db.ts";
import {
  cancelTransfer,
  createTransfer,
  dispatchTransfer,
  listTransferItems,
  receiveTransfer,
  transferStatus,
  TransferError,
  type TransferErrorCode,
} from "./transfer-service.ts";

let userId: string;
let sourceId: string;
let targetId: string;

async function wipe(): Promise<void> {
  await db.execute(sql`SET FOREIGN_KEY_CHECKS = 0`);
  for (const t of [
    "stock_transfer_items", "stock_transfers",
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
    name: "Transfer Test",
  });
});

afterAll(async () => {
  await wipe();
  await db.delete(users).where(eq(users.id, userId));
  // The shared pool is closed once globally — see src/test-setup.ts.
});

beforeEach(async () => {
  await wipe();
  sourceId = ulid();
  targetId = ulid();
  await db.insert(locations).values([
    { id: sourceId, name: "Warehouse" },
    { id: targetId, name: "Front Counter" },
  ]);
});

/** Seed a variant with `stockQty` units at the source location. */
async function seedVariant(stockQty: number): Promise<string> {
  const productId = ulid();
  const variantId = ulid();
  await db.insert(products).values({
    id: productId,
    name: "Widget",
    priceMode: "tax_exclusive",
  });
  await db.insert(productVariants).values({
    id: variantId,
    productId,
    sku: `SKU-${variantId}`,
    priceMinor: 1000,
    totalQty: stockQty,
  });
  await db.insert(stockLocations).values({
    id: ulid(),
    variantId,
    locationId: sourceId,
    qty: stockQty,
  });
  return variantId;
}

/** Stock qty for a (variant, location) pair. */
async function stockAt(variantId: string, locationId: string): Promise<number> {
  const rows = await db
    .select()
    .from(stockLocations)
    .where(
      and(
        eq(stockLocations.variantId, variantId),
        eq(stockLocations.locationId, locationId),
      ),
    );
  return rows[0]?.qty ?? 0;
}

async function expectError(
  code: TransferErrorCode,
  fn: () => Promise<unknown>,
): Promise<void> {
  try {
    await fn();
  } catch (e) {
    expect(e).toBeInstanceOf(TransferError);
    expect((e as TransferError).code).toBe(code);
    return;
  }
  throw new Error(`expected TransferError ${code}, nothing thrown`);
}

describe("creating transfers", () => {
  test("a draft transfer moves no stock", async () => {
    const variantId = await seedVariant(100);
    const transfer = await createTransfer({
      sourceLocationId: sourceId,
      targetLocationId: targetId,
      items: [{ variantId, qty: 30 }],
      createdByUserId: userId,
    });
    expect(transferStatus(transfer)).toBe("draft");
    expect(await listTransferItems(transfer.id)).toHaveLength(1);
    expect(await stockAt(variantId, sourceId)).toBe(100);
  });

  test("rejects a transfer to the same location", async () => {
    const variantId = await seedVariant(100);
    await expectError("SAME_LOCATION", () =>
      createTransfer({
        sourceLocationId: sourceId,
        targetLocationId: sourceId,
        items: [{ variantId, qty: 1 }],
        createdByUserId: userId,
      }),
    );
  });

  test("rejects an empty transfer", async () => {
    await expectError("EMPTY_TRANSFER", () =>
      createTransfer({
        sourceLocationId: sourceId,
        targetLocationId: targetId,
        items: [],
        createdByUserId: userId,
      }),
    );
  });
});

describe("the dispatch → receive lifecycle", () => {
  test("dispatch debits the source, receive credits the target", async () => {
    const variantId = await seedVariant(100);
    const transfer = await createTransfer({
      sourceLocationId: sourceId,
      targetLocationId: targetId,
      items: [{ variantId, qty: 30 }],
      createdByUserId: userId,
    });

    const dispatched = await dispatchTransfer(transfer.id, userId);
    expect(transferStatus(dispatched)).toBe("in_transit");
    expect(await stockAt(variantId, sourceId)).toBe(70);
    expect(await stockAt(variantId, targetId)).toBe(0);

    const received = await receiveTransfer(transfer.id, userId);
    expect(transferStatus(received)).toBe("received");
    expect(await stockAt(variantId, sourceId)).toBe(70);
    expect(await stockAt(variantId, targetId)).toBe(30);
  });

  test("rejects dispatching a transfer that is not a draft", async () => {
    const variantId = await seedVariant(100);
    const transfer = await createTransfer({
      sourceLocationId: sourceId,
      targetLocationId: targetId,
      items: [{ variantId, qty: 10 }],
      createdByUserId: userId,
    });
    await dispatchTransfer(transfer.id, userId);
    await expectError("NOT_DRAFT", () => dispatchTransfer(transfer.id, userId));
  });

  test("rejects receiving a transfer that was never dispatched", async () => {
    const variantId = await seedVariant(100);
    const transfer = await createTransfer({
      sourceLocationId: sourceId,
      targetLocationId: targetId,
      items: [{ variantId, qty: 10 }],
      createdByUserId: userId,
    });
    await expectError("NOT_IN_TRANSIT", () =>
      receiveTransfer(transfer.id, userId),
    );
  });
});

describe("cancellation", () => {
  test("cancelling a draft moves no stock", async () => {
    const variantId = await seedVariant(100);
    const transfer = await createTransfer({
      sourceLocationId: sourceId,
      targetLocationId: targetId,
      items: [{ variantId, qty: 30 }],
      createdByUserId: userId,
    });
    const cancelled = await cancelTransfer(transfer.id, "changed plan", userId);
    expect(transferStatus(cancelled)).toBe("cancelled");
    expect(await stockAt(variantId, sourceId)).toBe(100);
  });

  test("cancelling an in-transit transfer returns stock to the source", async () => {
    const variantId = await seedVariant(100);
    const transfer = await createTransfer({
      sourceLocationId: sourceId,
      targetLocationId: targetId,
      items: [{ variantId, qty: 30 }],
      createdByUserId: userId,
    });
    await dispatchTransfer(transfer.id, userId);
    expect(await stockAt(variantId, sourceId)).toBe(70);

    await cancelTransfer(transfer.id, "lost in transit", userId);
    expect(await stockAt(variantId, sourceId)).toBe(100);
    expect(await stockAt(variantId, targetId)).toBe(0);
  });

  test("a received transfer cannot be cancelled", async () => {
    const variantId = await seedVariant(100);
    const transfer = await createTransfer({
      sourceLocationId: sourceId,
      targetLocationId: targetId,
      items: [{ variantId, qty: 30 }],
      createdByUserId: userId,
    });
    await dispatchTransfer(transfer.id, userId);
    await receiveTransfer(transfer.id, userId);
    await expectError("ALREADY_RECEIVED", () =>
      cancelTransfer(transfer.id, "too late", userId),
    );
  });
});
