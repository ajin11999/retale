// Integration tests for the delivery-commit logic — the transaction that
// turns a purchase order into stock. These run against the local Docker
// MariaDB (DATABASE_URL) and WIPE the purchase / stock / product tables
// between tests, so point them only at a dev database.
//
//   bun test src/services/delivery-service.test.ts

import "../lib/load-env.ts";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { and, eq, sql } from "drizzle-orm";
import { ulid } from "ulid";
import { purchaseDeliveryItems, purchaseDeliveries } from "../db/schema/deliveries.ts";
import { locations } from "../db/schema/locations.ts";
import { products, productVariants } from "../db/schema/products.ts";
import { purchaseItems, purchases } from "../db/schema/purchases.ts";
import { stockLocations, stockMovements } from "../db/schema/stock.ts";
import { users } from "../db/schema/auth.ts";
import { vendorLedger, vendors } from "../db/schema/vendors.ts";
import { db } from "../lib/db.ts";
import {
  cancelDelivery,
  commitDelivery,
  createDelivery,
  createDeliveryItem,
  DeliveryError,
  type DeliveryErrorCode,
} from "./delivery-service.ts";

let userId: string;

/** Truncate every domain table touched by these tests. Users are kept. */
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
    "vendor_ledger",
    "vendors",
    "product_variants",
    "products",
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
    name: "Delivery Test",
  });
});

afterAll(async () => {
  await wipe();
  await db.delete(users).where(eq(users.id, userId));
  // The shared pool is closed once globally — see src/test-setup.ts.
});

beforeEach(wipe);

// --- Seed helpers ---

async function seedLocation(): Promise<string> {
  const id = ulid();
  await db.insert(locations).values({ id, name: "Warehouse" });
  return id;
}

/**
 * Create a product + one variant. `totalQty` / `costMinor` seed pre-existing
 * stock so WAC blending can be exercised; when set, a matching stock_locations
 * row is written at `locationId`.
 */
async function seedVariant(opts?: {
  totalQty?: number;
  costMinor?: number;
  locationId?: string;
}): Promise<string> {
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
    costMinor: opts?.costMinor ?? 0,
    totalQty: opts?.totalQty ?? 0,
  });
  if (opts?.totalQty && opts.locationId) {
    await db.insert(stockLocations).values({
      id: ulid(),
      variantId,
      locationId: opts.locationId,
      qty: opts.totalQty,
    });
  }
  return variantId;
}

/** Create an open purchase with one line. Ad-hoc (no vendor) unless `vendorId`. */
async function seedPurchaseItem(input: {
  variantId: string | null;
  qtyOrdered: number;
  unitCostMinor: number;
  description?: string;
  vendorId?: string;
}): Promise<{ purchaseId: string; itemId: string }> {
  const purchaseId = ulid();
  const itemId = ulid();
  await db.insert(purchases).values({
    id: purchaseId,
    vendorId: input.vendorId ?? null,
    snapshotVendorName: "Ad-hoc Supplier",
    date: "2026-05-16",
    createdByUserId: userId,
  });
  await db.insert(purchaseItems).values({
    id: itemId,
    purchaseId,
    variantId: input.variantId,
    description: input.description ?? null,
    qtyOrdered: input.qtyOrdered,
    unitCostMinor: input.unitCostMinor,
  });
  return { purchaseId, itemId };
}

/** Create a vendor (supplier by default). Returns its id. */
async function seedVendor(opts?: {
  kind?: "supplier" | "expedition";
  paymentTermsDays?: number | null;
}): Promise<string> {
  const id = ulid();
  await db.insert(vendors).values({
    id,
    name: opts?.kind === "expedition" ? "JNE" : "Acme Supply",
    kind: opts?.kind ?? "supplier",
    paymentTermsDays: opts?.paymentTermsDays ?? null,
    createdByUserId: userId,
  });
  return id;
}

const ledgerFor = (vendorId: string) =>
  db.select().from(vendorLedger).where(eq(vendorLedger.vendorId, vendorId));

const getVendor = (id: string) =>
  db.query.vendors.findFirst({ where: eq(vendors.id, id) });

// --- Query helpers ---

const getVariant = (id: string) =>
  db.query.productVariants.findFirst({ where: eq(productVariants.id, id) });

const getPurchaseItem = (id: string) =>
  db.query.purchaseItems.findFirst({ where: eq(purchaseItems.id, id) });

const getPurchase = (id: string) =>
  db.query.purchases.findFirst({ where: eq(purchases.id, id) });

const getDelivery = (id: string) =>
  db.query.purchaseDeliveries.findFirst({ where: eq(purchaseDeliveries.id, id) });

const movementsFor = (variantId: string) =>
  db.select().from(stockMovements).where(eq(stockMovements.variantId, variantId));

/** Assert that a promise rejects with a DeliveryError carrying the given code. */
async function expectError(p: Promise<unknown>, code: DeliveryErrorCode): Promise<void> {
  const err = await p.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(DeliveryError);
  expect((err as DeliveryError).code).toBe(code);
}

const stockAt = async (variantId: string, locationId: string) => {
  const rows = await db
    .select()
    .from(stockLocations)
    .where(
      and(
        eq(stockLocations.variantId, variantId),
        eq(stockLocations.locationId, locationId),
      ),
    );
  return rows[0];
};

describe("commitDelivery", () => {
  test("receives stock, sets WAC from empty, and completes the purchase", async () => {
    const locationId = await seedLocation();
    const variantId = await seedVariant();
    const { purchaseId, itemId } = await seedPurchaseItem({
      variantId,
      qtyOrdered: 10,
      unitCostMinor: 500,
    });

    const delivery = await createDelivery({
      date: "2026-05-16",
      targetLocationId: locationId,
      createdByUserId: userId,
    });
    await createDeliveryItem({
      deliveryId: delivery.id,
      purchaseItemId: itemId,
      description: "Widgets",
      qty: 10,
      costMinor: 5000, // 500 per unit
    });

    const committed = await commitDelivery(delivery.id, userId);
    expect(committed.status).toBe("delivered");
    expect(committed.deliveredByUserId).toBe(userId);

    const moves = await movementsFor(variantId);
    expect(moves).toHaveLength(1);
    expect(moves[0]?.type).toBe("purchase_receive");
    expect(moves[0]?.qtyDelta).toBe(10);
    expect(moves[0]?.unitCost).toBe(500);
    expect(moves[0]?.locationId).toBe(locationId);

    const variant = await getVariant(variantId);
    expect(variant?.totalQty).toBe(10);
    expect(variant?.costMinor).toBe(500); // WAC from empty = received cost

    expect((await stockAt(variantId, locationId))?.qty).toBe(10);
    expect((await getPurchaseItem(itemId))?.qtyDelivered).toBe(10);
    expect((await getPurchase(purchaseId))?.status).toBe("complete");
  });

  test("blends WAC against pre-existing stock", async () => {
    const locationId = await seedLocation();
    // 10 units already on hand at cost 500.
    const variantId = await seedVariant({ totalQty: 10, costMinor: 500, locationId });
    const { itemId } = await seedPurchaseItem({
      variantId,
      qtyOrdered: 10,
      unitCostMinor: 700,
    });

    const delivery = await createDelivery({
      date: "2026-05-16",
      targetLocationId: locationId,
      createdByUserId: userId,
    });
    await createDeliveryItem({
      deliveryId: delivery.id,
      purchaseItemId: itemId,
      description: "Widgets",
      qty: 10,
      costMinor: 7000, // 700 per unit
    });
    await commitDelivery(delivery.id, userId);

    const variant = await getVariant(variantId);
    expect(variant?.totalQty).toBe(20);
    // (10*500 + 10*700) / 20 = 600
    expect(variant?.costMinor).toBe(600);
  });

  test("allocates a freight cost node across stock leaves by line value", async () => {
    const locationId = await seedLocation();
    const variantA = await seedVariant();
    const variantB = await seedVariant();
    // Line A value = 2 × 300 = 600; line B value = 8 × 50 = 400; base = 1000.
    const a = await seedPurchaseItem({ variantId: variantA, qtyOrdered: 2, unitCostMinor: 300 });
    const b = await seedPurchaseItem({ variantId: variantB, qtyOrdered: 8, unitCostMinor: 50 });

    const delivery = await createDelivery({
      date: "2026-05-16",
      targetLocationId: locationId,
      createdByUserId: userId,
    });
    await createDeliveryItem({
      deliveryId: delivery.id,
      purchaseItemId: a.itemId,
      description: "Line A",
      qty: 2,
      costMinor: 600,
    });
    await createDeliveryItem({
      deliveryId: delivery.id,
      purchaseItemId: b.itemId,
      description: "Line B",
      qty: 8,
      costMinor: 400,
    });
    // Freight node (no purchaseItemId): 100 to spread by value — 60 to A, 40 to B.
    await createDeliveryItem({
      deliveryId: delivery.id,
      description: "Freight",
      costMinor: 100,
    });

    await commitDelivery(delivery.id, userId);

    // A: (600 + 60) / 2 = 330 per unit; B: (400 + 40) / 8 = 55 per unit.
    expect((await getVariant(variantA))?.costMinor).toBe(330);
    expect((await getVariant(variantB))?.costMinor).toBe(55);
    const movesA = await movementsFor(variantA);
    expect(movesA[0]?.unitCost).toBe(330);
  });

  test("supports partial delivery across two deliveries", async () => {
    const locationId = await seedLocation();
    const variantId = await seedVariant();
    const { purchaseId, itemId } = await seedPurchaseItem({
      variantId,
      qtyOrdered: 10,
      unitCostMinor: 500,
    });

    const first = await createDelivery({
      date: "2026-05-16",
      targetLocationId: locationId,
      createdByUserId: userId,
    });
    await createDeliveryItem({
      deliveryId: first.id,
      purchaseItemId: itemId,
      description: "Widgets (partial)",
      qty: 6,
      costMinor: 3000,
    });
    await commitDelivery(first.id, userId);

    expect((await getPurchaseItem(itemId))?.qtyDelivered).toBe(6);
    expect((await getPurchase(purchaseId))?.status).toBe("open");

    const second = await createDelivery({
      date: "2026-05-17",
      targetLocationId: locationId,
      createdByUserId: userId,
    });
    await createDeliveryItem({
      deliveryId: second.id,
      purchaseItemId: itemId,
      description: "Widgets (rest)",
      qty: 4,
      costMinor: 2000,
    });
    await commitDelivery(second.id, userId);

    expect((await getPurchaseItem(itemId))?.qtyDelivered).toBe(10);
    expect((await getPurchase(purchaseId))?.status).toBe("complete");
    expect((await getVariant(variantId))?.totalQty).toBe(10);
  });

  test("rejects a delivery that exceeds the ordered quantity", async () => {
    const locationId = await seedLocation();
    const variantId = await seedVariant();
    const { itemId } = await seedPurchaseItem({
      variantId,
      qtyOrdered: 10,
      unitCostMinor: 500,
    });

    const delivery = await createDelivery({
      date: "2026-05-16",
      targetLocationId: locationId,
      createdByUserId: userId,
    });
    await createDeliveryItem({
      deliveryId: delivery.id,
      purchaseItemId: itemId,
      description: "Too many",
      qty: 11,
      costMinor: 5500,
    });

    await expectError(commitDelivery(delivery.id, userId), "OVER_DELIVERY");
    // Nothing was received.
    expect(await movementsFor(variantId)).toHaveLength(0);
    expect((await getDelivery(delivery.id))?.status).toBe("draft");
  });

  test("advances qty_delivered for a non-stock line without moving stock", async () => {
    const locationId = await seedLocation();
    const { itemId } = await seedPurchaseItem({
      variantId: null,
      qtyOrdered: 5,
      unitCostMinor: 200,
      description: "Shop rags",
    });

    const delivery = await createDelivery({
      date: "2026-05-16",
      targetLocationId: locationId,
      createdByUserId: userId,
    });
    await createDeliveryItem({
      deliveryId: delivery.id,
      purchaseItemId: itemId,
      description: "Shop rags",
      qty: 5,
      costMinor: 1000,
    });
    await commitDelivery(delivery.id, userId);

    expect((await getPurchaseItem(itemId))?.qtyDelivered).toBe(5);
    const allMovements = await db.select().from(stockMovements);
    expect(allMovements).toHaveLength(0);
  });

  test("refuses an empty delivery and a non-draft delivery", async () => {
    const locationId = await seedLocation();
    const variantId = await seedVariant();
    const { itemId } = await seedPurchaseItem({
      variantId,
      qtyOrdered: 10,
      unitCostMinor: 500,
    });

    const empty = await createDelivery({
      date: "2026-05-16",
      targetLocationId: locationId,
      createdByUserId: userId,
    });
    await expectError(commitDelivery(empty.id, userId), "EMPTY_DELIVERY");

    const delivery = await createDelivery({
      date: "2026-05-16",
      targetLocationId: locationId,
      createdByUserId: userId,
    });
    await createDeliveryItem({
      deliveryId: delivery.id,
      purchaseItemId: itemId,
      description: "Widgets",
      qty: 10,
      costMinor: 5000,
    });
    await commitDelivery(delivery.id, userId);
    // Committing again must fail — it is no longer a draft.
    await expectError(commitDelivery(delivery.id, userId), "NOT_DRAFT");
  });
});

describe("cancelDelivery", () => {
  test("reverses stock and reopens the purchase, leaving WAC untouched", async () => {
    const locationId = await seedLocation();
    const variantId = await seedVariant();
    const { purchaseId, itemId } = await seedPurchaseItem({
      variantId,
      qtyOrdered: 10,
      unitCostMinor: 500,
    });

    const delivery = await createDelivery({
      date: "2026-05-16",
      targetLocationId: locationId,
      createdByUserId: userId,
    });
    await createDeliveryItem({
      deliveryId: delivery.id,
      purchaseItemId: itemId,
      description: "Widgets",
      qty: 10,
      costMinor: 5000,
    });
    await commitDelivery(delivery.id, userId);

    const cancelled = await cancelDelivery(delivery.id, userId);
    expect(cancelled.status).toBe("cancelled");

    // A reversing adjustment_out exists; net stock is back to zero.
    const moves = await movementsFor(variantId);
    expect(moves).toHaveLength(2);
    const reversal = moves.find((m) => m.type === "adjustment_out");
    expect(reversal?.qtyDelta).toBe(-10);

    const variant = await getVariant(variantId);
    expect(variant?.totalQty).toBe(0);
    expect(variant?.costMinor).toBe(500); // WAC is NOT retroactively re-valued

    expect((await getPurchaseItem(itemId))?.qtyDelivered).toBe(0);
    expect((await getPurchase(purchaseId))?.status).toBe("open");
  });

  test("refuses to cancel a delivery that is not delivered", async () => {
    const locationId = await seedLocation();
    const draft = await createDelivery({
      date: "2026-05-16",
      targetLocationId: locationId,
      createdByUserId: userId,
    });
    await expectError(cancelDelivery(draft.id, userId), "NOT_DELIVERED");
  });
});

describe("delivery accounts payable", () => {
  test("commit raises supplier AP (goods) and courier AP (tagged freight)", async () => {
    const locationId = await seedLocation();
    const variantId = await seedVariant();
    const supplierId = await seedVendor({ paymentTermsDays: 30 });
    const courierId = await seedVendor({ kind: "expedition", paymentTermsDays: 7 });
    const { itemId } = await seedPurchaseItem({
      variantId,
      qtyOrdered: 10,
      unitCostMinor: 500,
      vendorId: supplierId,
    });

    const delivery = await createDelivery({
      date: "2026-05-16",
      targetLocationId: locationId,
      createdByUserId: userId,
    });
    await createDeliveryItem({
      deliveryId: delivery.id,
      purchaseItemId: itemId,
      description: "Widgets",
      qty: 10,
      costMinor: 5000, // base goods cost → supplier AP
    });
    await createDeliveryItem({
      deliveryId: delivery.id,
      description: "Freight",
      costMinor: 1000, // tagged to the courier → expedition AP
      vendorId: courierId,
    });
    await commitDelivery(delivery.id, userId);

    const supplierLedger = await ledgerFor(supplierId);
    expect(supplierLedger).toHaveLength(1);
    expect(supplierLedger[0]?.type).toBe("purchase_on_account");
    expect(supplierLedger[0]?.amountMinor).toBe(5000);
    expect(supplierLedger[0]?.refType).toBe("purchase_delivery");
    expect(supplierLedger[0]?.refId).toBe(delivery.id);
    expect(supplierLedger[0]?.dueDate).toBe("2026-06-15"); // +30 days
    expect((await getVendor(supplierId))?.balanceMinor).toBe(5000);

    const courierLedger = await ledgerFor(courierId);
    expect(courierLedger).toHaveLength(1);
    expect(courierLedger[0]?.amountMinor).toBe(1000);
    expect(courierLedger[0]?.dueDate).toBe("2026-05-23"); // +7 days
    expect((await getVendor(courierId))?.balanceMinor).toBe(1000);

    // The stock cost still capitalizes the freight (landed cost unchanged).
    expect((await getVariant(variantId))?.costMinor).toBe(600); // (5000+1000)/10
  });

  test("untagged freight raises no courier AP; supplier owes goods only", async () => {
    const locationId = await seedLocation();
    const variantId = await seedVariant();
    const supplierId = await seedVendor();
    const { itemId } = await seedPurchaseItem({
      variantId,
      qtyOrdered: 10,
      unitCostMinor: 500,
      vendorId: supplierId,
    });

    const delivery = await createDelivery({
      date: "2026-05-16",
      targetLocationId: locationId,
      createdByUserId: userId,
    });
    await createDeliveryItem({
      deliveryId: delivery.id,
      purchaseItemId: itemId,
      description: "Widgets",
      qty: 10,
      costMinor: 5000,
    });
    await createDeliveryItem({
      deliveryId: delivery.id,
      description: "Freight (absorbed)",
      costMinor: 1000, // no vendorId → no AP
    });
    await commitDelivery(delivery.id, userId);

    const supplierLedger = await ledgerFor(supplierId);
    expect(supplierLedger).toHaveLength(1);
    expect(supplierLedger[0]?.amountMinor).toBe(5000);
    // No terms on this supplier → due on the delivery date.
    expect(supplierLedger[0]?.dueDate).toBe("2026-05-16");
  });

  test("ad-hoc purchase (no vendor) raises no AP", async () => {
    const locationId = await seedLocation();
    const variantId = await seedVariant();
    const { itemId } = await seedPurchaseItem({
      variantId,
      qtyOrdered: 10,
      unitCostMinor: 500,
    });

    const delivery = await createDelivery({
      date: "2026-05-16",
      targetLocationId: locationId,
      createdByUserId: userId,
    });
    await createDeliveryItem({
      deliveryId: delivery.id,
      purchaseItemId: itemId,
      description: "Widgets",
      qty: 10,
      costMinor: 5000,
    });
    await commitDelivery(delivery.id, userId);

    expect(await db.select().from(vendorLedger)).toHaveLength(0);
  });

  test("cancel reverses supplier and courier AP back to zero", async () => {
    const locationId = await seedLocation();
    const variantId = await seedVariant();
    const supplierId = await seedVendor({ paymentTermsDays: 30 });
    const courierId = await seedVendor({ kind: "expedition" });
    const { itemId } = await seedPurchaseItem({
      variantId,
      qtyOrdered: 10,
      unitCostMinor: 500,
      vendorId: supplierId,
    });

    const delivery = await createDelivery({
      date: "2026-05-16",
      targetLocationId: locationId,
      createdByUserId: userId,
    });
    await createDeliveryItem({
      deliveryId: delivery.id,
      purchaseItemId: itemId,
      description: "Widgets",
      qty: 10,
      costMinor: 5000,
    });
    await createDeliveryItem({
      deliveryId: delivery.id,
      description: "Freight",
      costMinor: 1000,
      vendorId: courierId,
    });
    await commitDelivery(delivery.id, userId);
    await cancelDelivery(delivery.id, userId);

    const supplierLedger = await ledgerFor(supplierId);
    expect(supplierLedger).toHaveLength(2); // charge + refund_credit
    expect(supplierLedger.some((r) => r.type === "refund_credit" && r.amountMinor === -5000)).toBe(true);
    expect((await getVendor(supplierId))?.balanceMinor).toBe(0);

    expect((await getVendor(courierId))?.balanceMinor).toBe(0);
  });
});
