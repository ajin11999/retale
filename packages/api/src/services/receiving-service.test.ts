// Integration tests for the receiving check — the resumable goods-in workflow
// over a purchase. These run against the local Docker MariaDB (DATABASE_URL)
// and WIPE the purchase / delivery / stock / product tables between tests, so
// point them only at a dev database.
//
//   bun test src/services/receiving-service.test.ts

import "../lib/load-env.ts";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { eq, sql } from "drizzle-orm";
import { ulid } from "ulid";
import { users } from "../db/schema/auth.ts";
import { purchaseDeliveries } from "../db/schema/deliveries.ts";
import { locations } from "../db/schema/locations.ts";
import { products, productVariants } from "../db/schema/products.ts";
import { purchaseItems, purchases } from "../db/schema/purchases.ts";
import { stockMovements } from "../db/schema/stock.ts";
import { vendors } from "../db/schema/vendors.ts";
import { db } from "../lib/db.ts";
import { setVendorVariantCode } from "./vendor-variant-code-service.ts";
import {
  commitReceivingCheck,
  getReceivingCheckLines,
  ReceivingError,
  type ReceivingErrorCode,
  resolveReceivingScan,
  setReceivingCheckLine,
  startReceivingCheck,
} from "./receiving-service.ts";

let userId: string;

async function wipe(): Promise<void> {
  await db.execute(sql`SET FOREIGN_KEY_CHECKS = 0`);
  for (const t of [
    "stock_movements",
    "stock_locations",
    "purchase_delivery_items",
    "purchase_deliveries",
    "purchase_sends",
    "purchase_items",
    "purchase_sections",
    "purchases",
    "vendor_variant_codes",
    "product_variants",
    "products",
    "vendors",
    "locations",
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
    name: "Receiving Test",
  });
});

afterAll(async () => {
  await wipe();
  await db.delete(users).where(eq(users.id, userId));
});

beforeEach(wipe);

// --- Seed helpers ---

async function seedLocation(): Promise<string> {
  const id = ulid();
  await db.insert(locations).values({ id, name: "Warehouse" });
  return id;
}

/** Create a product + one variant with a known SKU and optional barcode. */
async function seedVariant(opts?: { barcode?: string }): Promise<string> {
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
    barcode: opts?.barcode ?? null,
    priceMinor: 1000,
  });
  return variantId;
}

/** Create an open purchase, optionally tied to a vendor. Returns its id. */
async function seedPurchase(vendorId?: string): Promise<string> {
  const id = ulid();
  await db.insert(purchases).values({
    id,
    vendorId: vendorId ?? null,
    snapshotVendorName: "Ad-hoc Supplier",
    date: "2026-05-18",
    createdByUserId: userId,
  });
  return id;
}

/** Create a vendor. Returns its id. */
async function seedVendor(): Promise<string> {
  const id = ulid();
  await db.insert(vendors).values({ id, name: "Acme Supply" });
  return id;
}

/** Append a line to a purchase. Returns the purchase line id. */
async function addItem(input: {
  purchaseId: string;
  variantId: string | null;
  qtyOrdered: number;
  unitCostMinor: number;
  qtyDelivered?: number;
  description?: string;
}): Promise<string> {
  const id = ulid();
  await db.insert(purchaseItems).values({
    id,
    purchaseId: input.purchaseId,
    variantId: input.variantId,
    description: input.description ?? null,
    qtyOrdered: input.qtyOrdered,
    qtyDelivered: input.qtyDelivered ?? 0,
    unitCostMinor: input.unitCostMinor,
  });
  return id;
}

// --- Query helpers ---

const getVariant = (id: string) =>
  db.query.productVariants.findFirst({ where: eq(productVariants.id, id) });

const getPurchaseItem = (id: string) =>
  db.query.purchaseItems.findFirst({ where: eq(purchaseItems.id, id) });

const getPurchase = (id: string) =>
  db.query.purchases.findFirst({ where: eq(purchases.id, id) });

/** Assert that a promise rejects with a ReceivingError carrying the given code. */
async function expectError(
  p: Promise<unknown>,
  code: ReceivingErrorCode,
): Promise<void> {
  const err = await p.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(ReceivingError);
  expect((err as ReceivingError).code).toBe(code);
}

// --- Tests ---

describe("startReceivingCheck", () => {
  test("creates a draft delivery tied to the purchase", async () => {
    const locationId = await seedLocation();
    const purchaseId = await seedPurchase();

    const check = await startReceivingCheck({ purchaseId, targetLocationId: locationId, userId });
    expect(check.status).toBe("draft");
    expect(check.purchaseId).toBe(purchaseId);
    expect(check.targetLocationId).toBe(locationId);
    // A receiving check is always an arrival — committing it must move stock.
    expect(check.kind).toBe("arrival");
  });

  test("resumes the existing open check instead of creating a second", async () => {
    const locationId = await seedLocation();
    const purchaseId = await seedPurchase();

    const first = await startReceivingCheck({ purchaseId, targetLocationId: locationId, userId });
    const second = await startReceivingCheck({ purchaseId, targetLocationId: locationId, userId });
    expect(second.id).toBe(first.id);

    const all = await db
      .select()
      .from(purchaseDeliveries)
      .where(eq(purchaseDeliveries.purchaseId, purchaseId));
    expect(all).toHaveLength(1);
  });

  test("rejects a missing or non-open purchase", async () => {
    const locationId = await seedLocation();
    await expectError(
      startReceivingCheck({ purchaseId: ulid(), targetLocationId: locationId, userId }),
      "PURCHASE_NOT_FOUND",
    );

    const purchaseId = await seedPurchase();
    await db
      .update(purchases)
      .set({ status: "cancelled" })
      .where(eq(purchases.id, purchaseId));
    await expectError(
      startReceivingCheck({ purchaseId, targetLocationId: locationId, userId }),
      "PURCHASE_NOT_OPEN",
    );
  });
});

describe("setReceivingCheckLine", () => {
  test("upserts a counted line and updates it on a re-count", async () => {
    const locationId = await seedLocation();
    const variantId = await seedVariant();
    const purchaseId = await seedPurchase();
    const itemId = await addItem({ purchaseId, variantId, qtyOrdered: 10, unitCostMinor: 500 });

    const check = await startReceivingCheck({ purchaseId, targetLocationId: locationId, userId });
    await setReceivingCheckLine({ deliveryId: check.id, purchaseItemId: itemId, qty: 4 });

    let lines = await getReceivingCheckLines(purchaseId);
    expect(lines[0]?.qtyInCheck).toBe(4);
    expect(lines[0]?.provisionalStatus).toBe("partial");

    // Re-count the same line — the leaf is updated, not duplicated.
    await setReceivingCheckLine({ deliveryId: check.id, purchaseItemId: itemId, qty: 10 });
    lines = await getReceivingCheckLines(purchaseId);
    expect(lines[0]?.qtyInCheck).toBe(10);
    expect(lines[0]?.provisionalStatus).toBe("complete");
  });

  test("qty 0 removes a previously counted line", async () => {
    const locationId = await seedLocation();
    const variantId = await seedVariant();
    const purchaseId = await seedPurchase();
    const itemId = await addItem({ purchaseId, variantId, qtyOrdered: 10, unitCostMinor: 500 });

    const check = await startReceivingCheck({ purchaseId, targetLocationId: locationId, userId });
    await setReceivingCheckLine({ deliveryId: check.id, purchaseItemId: itemId, qty: 5 });
    await setReceivingCheckLine({ deliveryId: check.id, purchaseItemId: itemId, qty: 0 });

    const lines = await getReceivingCheckLines(purchaseId);
    expect(lines[0]?.qtyInCheck).toBe(0);
    expect(lines[0]?.provisionalStatus).toBe("not_started");
  });

  test("rejects counting past what the line still owes", async () => {
    const locationId = await seedLocation();
    const variantId = await seedVariant();
    const purchaseId = await seedPurchase();
    // 6 of 10 already delivered — only 4 remain.
    const itemId = await addItem({
      purchaseId,
      variantId,
      qtyOrdered: 10,
      qtyDelivered: 6,
      unitCostMinor: 500,
    });

    const check = await startReceivingCheck({ purchaseId, targetLocationId: locationId, userId });
    await expectError(
      setReceivingCheckLine({ deliveryId: check.id, purchaseItemId: itemId, qty: 5 }),
      "OVER_DELIVERY",
    );
  });

  test("rejects a purchase line from another purchase", async () => {
    const locationId = await seedLocation();
    const variantId = await seedVariant();
    const purchaseId = await seedPurchase();
    const otherPurchaseId = await seedPurchase();
    const foreignItemId = await addItem({
      purchaseId: otherPurchaseId,
      variantId,
      qtyOrdered: 5,
      unitCostMinor: 500,
    });

    const check = await startReceivingCheck({ purchaseId, targetLocationId: locationId, userId });
    await expectError(
      setReceivingCheckLine({ deliveryId: check.id, purchaseItemId: foreignItemId, qty: 1 }),
      "WRONG_PURCHASE",
    );
  });
});

describe("resolveReceivingScan", () => {
  test("matches a barcode and a SKU to the purchase line", async () => {
    const variantId = await seedVariant({ barcode: "BARCODE-1" });
    const purchaseId = await seedPurchase();
    const itemId = await addItem({ purchaseId, variantId, qtyOrdered: 10, unitCostMinor: 500 });

    const byBarcode = await resolveReceivingScan(purchaseId, "BARCODE-1");
    expect(byBarcode.map((i) => i.id)).toEqual([itemId]);

    const variant = await getVariant(variantId);
    const bySku = await resolveReceivingScan(purchaseId, variant?.sku as string);
    expect(bySku.map((i) => i.id)).toEqual([itemId]);

    expect(await resolveReceivingScan(purchaseId, "no-such-code")).toEqual([]);
  });

  test("matches the vendor's part number for a purchase with a vendor", async () => {
    const vendorId = await seedVendor();
    const variantId = await seedVariant();
    const purchaseId = await seedPurchase(vendorId);
    const itemId = await addItem({ purchaseId, variantId, qtyOrdered: 10, unitCostMinor: 500 });
    await setVendorVariantCode({ vendorId, variantId, code: "VENDOR-PART-7" });

    const matches = await resolveReceivingScan(purchaseId, "VENDOR-PART-7");
    expect(matches.map((i) => i.id)).toEqual([itemId]);

    // The same code does not resolve on a purchase from a different vendor.
    const otherPurchaseId = await seedPurchase();
    expect(await resolveReceivingScan(otherPurchaseId, "VENDOR-PART-7")).toEqual([]);
  });

  test("returns every line when the variant appears on the purchase twice", async () => {
    const variantId = await seedVariant({ barcode: "BARCODE-2" });
    const purchaseId = await seedPurchase();
    const a = await addItem({ purchaseId, variantId, qtyOrdered: 4, unitCostMinor: 500 });
    const b = await addItem({ purchaseId, variantId, qtyOrdered: 6, unitCostMinor: 500 });

    const matches = await resolveReceivingScan(purchaseId, "BARCODE-2");
    expect(matches.map((i) => i.id).sort()).toEqual([a, b].sort());
  });
});

describe("commitReceivingCheck", () => {
  test("commits the check: stock received, line advanced, purchase completed", async () => {
    const locationId = await seedLocation();
    const variantId = await seedVariant();
    const purchaseId = await seedPurchase();
    const itemId = await addItem({ purchaseId, variantId, qtyOrdered: 10, unitCostMinor: 500 });

    const check = await startReceivingCheck({ purchaseId, targetLocationId: locationId, userId });
    await setReceivingCheckLine({ deliveryId: check.id, purchaseItemId: itemId, qty: 10 });
    const committed = await commitReceivingCheck(check.id, userId);
    expect(committed.status).toBe("delivered");

    const moves = await db
      .select()
      .from(stockMovements)
      .where(eq(stockMovements.variantId, variantId));
    expect(moves).toHaveLength(1);
    expect(moves[0]?.qtyDelta).toBe(10);
    expect(moves[0]?.unitCost).toBe(500);

    expect((await getVariant(variantId))?.totalQty).toBe(10);
    expect((await getPurchaseItem(itemId))?.qtyDelivered).toBe(10);
    expect((await getPurchase(purchaseId))?.status).toBe("complete");
  });

  test("a partial check leaves the purchase open and the line partial", async () => {
    const locationId = await seedLocation();
    const variantId = await seedVariant();
    const purchaseId = await seedPurchase();
    const itemId = await addItem({ purchaseId, variantId, qtyOrdered: 10, unitCostMinor: 500 });

    const check = await startReceivingCheck({ purchaseId, targetLocationId: locationId, userId });
    await setReceivingCheckLine({ deliveryId: check.id, purchaseItemId: itemId, qty: 6 });
    await commitReceivingCheck(check.id, userId);

    expect((await getPurchase(purchaseId))?.status).toBe("open");
    const lines = await getReceivingCheckLines(purchaseId);
    expect(lines[0]?.qtyDelivered).toBe(6);
    expect(lines[0]?.remaining).toBe(4);
    expect(lines[0]?.status).toBe("partial");
  });

  test("a committed check is no longer a resumable draft", async () => {
    const locationId = await seedLocation();
    const variantId = await seedVariant();
    const purchaseId = await seedPurchase();
    const itemId = await addItem({ purchaseId, variantId, qtyOrdered: 10, unitCostMinor: 500 });

    const check = await startReceivingCheck({ purchaseId, targetLocationId: locationId, userId });
    await setReceivingCheckLine({ deliveryId: check.id, purchaseItemId: itemId, qty: 4 });
    await commitReceivingCheck(check.id, userId);

    await expectError(commitReceivingCheck(check.id, userId), "NOT_DRAFT");
    // The purchase is still open, so a fresh check can be started for the rest.
    const next = await startReceivingCheck({ purchaseId, targetLocationId: locationId, userId });
    expect(next.id).not.toBe(check.id);
  });

  test("rejects committing a delivery that is not a receiving check", async () => {
    await expectError(commitReceivingCheck(ulid(), userId), "DELIVERY_NOT_FOUND");
  });
});
