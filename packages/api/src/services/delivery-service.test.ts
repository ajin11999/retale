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
  deleteDelivery,
  DeliveryError,
  type DeliveryErrorCode,
  updateDeliveryItem,
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

  test("allocates a freight cost node across the stock leaves nested under it by line value", async () => {
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
    // Freight node (no purchaseItemId): 100 to spread by value over the goods
    // nested under it — 60 to A, 40 to B. Goods sit inside the charge.
    const freight = await createDeliveryItem({
      deliveryId: delivery.id,
      description: "Freight",
      costMinor: 100,
    });
    await createDeliveryItem({
      deliveryId: delivery.id,
      parentItemId: freight.id,
      purchaseItemId: a.itemId,
      description: "Line A",
      qty: 2,
      costMinor: 600,
    });
    await createDeliveryItem({
      deliveryId: delivery.id,
      parentItemId: freight.id,
      purchaseItemId: b.itemId,
      description: "Line B",
      qty: 8,
      costMinor: 400,
    });

    await commitDelivery(delivery.id, userId);

    // A: (600 + 60) / 2 = 330 per unit; B: (400 + 40) / 8 = 55 per unit.
    expect((await getVariant(variantA))?.costMinor).toBe(330);
    expect((await getVariant(variantB))?.costMinor).toBe(55);
    const movesA = await movementsFor(variantA);
    expect(movesA[0]?.unitCost).toBe(330);
  });

  test("scopes a nested charge to its subtree; a delivery-wide charge spreads over all", async () => {
    const locationId = await seedLocation();
    const lube = await seedVariant();
    const pad = await seedVariant();
    // Lubricant: 24 bottles @ 1000 = 24000. Brake pad: 10 @ 2000 = 20000.
    const a = await seedPurchaseItem({ variantId: lube, qtyOrdered: 24, unitCostMinor: 1000 });
    const b = await seedPurchaseItem({ variantId: pad, qtyOrdered: 10, unitCostMinor: 2000 });

    const delivery = await createDelivery({
      date: "2026-05-16",
      targetLocationId: locationId,
      createdByUserId: userId,
    });
    // A delivery-wide "Customs" charge wrapping everything: 4400 over goods
    // value 44000 → lube 2400 (24/44), pad 2000 (20/44).
    const customs = await createDeliveryItem({
      deliveryId: delivery.id,
      description: "Customs",
      costMinor: 4400,
    });
    // A per-carton freight scoped to the lubricant only, nested under customs.
    const carton = await createDeliveryItem({
      deliveryId: delivery.id,
      parentItemId: customs.id,
      description: "Carton freight",
      costMinor: 40_000, // Rp40,000 for the one carton → /24 per bottle
    });
    // Lubricant leaf sits under the carton freight node (so it bears it).
    await createDeliveryItem({
      deliveryId: delivery.id,
      parentItemId: carton.id,
      purchaseItemId: a.itemId,
      description: "Lubricant 1L",
      qty: 24,
      costMinor: 24_000,
    });
    // Brake pad sits under customs only (not in the carton).
    await createDeliveryItem({
      deliveryId: delivery.id,
      parentItemId: customs.id,
      purchaseItemId: b.itemId,
      description: "Brake pad",
      qty: 10,
      costMinor: 20_000,
    });

    await commitDelivery(delivery.id, userId);

    // Lubricant: (24000 base + 2400 customs + 40000 carton) / 24 = 2766.67 → 2767.
    expect((await getVariant(lube))?.costMinor).toBe(2767);
    // Brake pad: (20000 base + 2000 customs) / 10 = 2200. Carton never touches it.
    expect((await getVariant(pad))?.costMinor).toBe(2200);
  });

  test("a charge with goods nested under it does not touch a sibling leaf", async () => {
    const locationId = await seedLocation();
    const inBox = await seedVariant();
    const loose = await seedVariant();
    const a = await seedPurchaseItem({ variantId: inBox, qtyOrdered: 4, unitCostMinor: 1000 });
    const b = await seedPurchaseItem({ variantId: loose, qtyOrdered: 4, unitCostMinor: 1000 });

    const delivery = await createDelivery({
      date: "2026-05-16",
      targetLocationId: locationId,
      createdByUserId: userId,
    });
    const boxFreight = await createDeliveryItem({
      deliveryId: delivery.id,
      description: "Box freight",
      costMinor: 4000,
    });
    // Only `a` is in the box; `b` is a root sibling, outside the charge.
    await createDeliveryItem({
      deliveryId: delivery.id,
      parentItemId: boxFreight.id,
      purchaseItemId: a.itemId,
      description: "Boxed",
      qty: 4,
      costMinor: 4000,
    });
    await createDeliveryItem({
      deliveryId: delivery.id,
      purchaseItemId: b.itemId,
      description: "Loose",
      qty: 4,
      costMinor: 4000,
    });

    await commitDelivery(delivery.id, userId);

    // Box freight (4000) lands entirely on `a`: (4000 + 4000)/4 = 2000.
    expect((await getVariant(inBox))?.costMinor).toBe(2000);
    // `b` carries none of it: 4000/4 = 1000.
    expect((await getVariant(loose))?.costMinor).toBe(1000);
  });

  test("a delivery-wide leg spreads over flat root leaves by value", async () => {
    const locationId = await seedLocation();
    const variantA = await seedVariant();
    const variantB = await seedVariant();
    const a = await seedPurchaseItem({ variantId: variantA, qtyOrdered: 2, unitCostMinor: 300 });
    const b = await seedPurchaseItem({ variantId: variantB, qtyOrdered: 8, unitCostMinor: 50 });

    const delivery = await createDelivery({
      date: "2026-05-16",
      targetLocationId: locationId,
      createdByUserId: userId,
    });
    // Flat leaves at root — the receiving-check shape — with a freight leg
    // beside them. Same numbers as the nested test above: 60 to A, 40 to B.
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
    await createDeliveryItem({
      deliveryId: delivery.id,
      description: "Leg 1: MKS JKT→PTK",
      costMinor: 100,
      deliveryWide: true,
    });

    await commitDelivery(delivery.id, userId);

    expect((await getVariant(variantA))?.costMinor).toBe(330);
    expect((await getVariant(variantB))?.costMinor).toBe(55);
  });

  test("multi-leg: an unscoped leg spreads delivery-wide, a PO-scoped leg over one PO; each courier gets its own AP", async () => {
    const locationId = await seedLocation();
    const variantA = await seedVariant();
    const variantB = await seedVariant();
    // Two POs in one delivery, equal values: A = B = 4 × 1000 = 4000.
    const a = await seedPurchaseItem({ variantId: variantA, qtyOrdered: 4, unitCostMinor: 1000 });
    const b = await seedPurchaseItem({ variantId: variantB, qtyOrdered: 4, unitCostMinor: 1000 });
    const courier1 = await seedVendor({ kind: "expedition" });
    const courier2 = await seedVendor({ kind: "expedition" });

    const delivery = await createDelivery({
      date: "2026-05-16",
      targetLocationId: locationId,
      createdByUserId: userId,
    });
    await createDeliveryItem({
      deliveryId: delivery.id,
      purchaseItemId: a.itemId,
      description: "PO-X goods",
      qty: 4,
      costMinor: 4000,
    });
    await createDeliveryItem({
      deliveryId: delivery.id,
      purchaseItemId: b.itemId,
      description: "PO-Y goods",
      qty: 4,
      costMinor: 4000,
    });
    // Leg 1: whole delivery → 400 to each PO's goods.
    await createDeliveryItem({
      deliveryId: delivery.id,
      description: "Leg 1: whole shipment",
      costMinor: 800,
      deliveryWide: true,
      vendorId: courier1,
    });
    // Leg 2: invoiced for PO-X only (weight bulked per PO) → 400 to A alone.
    await createDeliveryItem({
      deliveryId: delivery.id,
      description: "Leg 2: PO-X weight",
      costMinor: 400,
      deliveryWide: true,
      appliesToPurchaseId: a.purchaseId,
      vendorId: courier2,
    });

    await commitDelivery(delivery.id, userId);

    // A: (4000 + 400 + 400) / 4 = 1200. B: (4000 + 400) / 4 = 1100.
    expect((await getVariant(variantA))?.costMinor).toBe(1200);
    expect((await getVariant(variantB))?.costMinor).toBe(1100);
    // AP per courier is the invoiced leg amount, regardless of scope.
    const ap1 = await ledgerFor(courier1);
    const ap2 = await ledgerFor(courier2);
    expect(ap1).toHaveLength(1);
    expect(ap1[0]?.amountMinor).toBe(800);
    expect(ap2).toHaveLength(1);
    expect(ap2[0]?.amountMinor).toBe(400);
  });

  test("an un-flagged childless charge still allocates nothing (root or nested)", async () => {
    const locationId = await seedLocation();
    const variantId = await seedVariant();
    const { itemId } = await seedPurchaseItem({
      variantId,
      qtyOrdered: 4,
      unitCostMinor: 1000,
    });

    const delivery = await createDelivery({
      date: "2026-05-16",
      targetLocationId: locationId,
      createdByUserId: userId,
    });
    const group = await createDeliveryItem({
      deliveryId: delivery.id,
      description: "Customs group",
      costMinor: 0,
    });
    await createDeliveryItem({
      deliveryId: delivery.id,
      parentItemId: group.id,
      purchaseItemId: itemId,
      description: "Goods",
      qty: 4,
      costMinor: 4000,
    });
    // Childless, not delivery-wide: nested and root variants both inert.
    await createDeliveryItem({
      deliveryId: delivery.id,
      parentItemId: group.id,
      description: "Handling (nested, childless)",
      costMinor: 500,
    });
    await createDeliveryItem({
      deliveryId: delivery.id,
      description: "Loose charge (root, childless)",
      costMinor: 300,
    });

    await commitDelivery(delivery.id, userId);

    // Neither inert charge capitalizes: 4000 / 4 = 1000 flat.
    expect((await getVariant(variantId))?.costMinor).toBe(1000);
  });

  test("a leg scoped to a PO absent from the delivery capitalizes nothing but still posts courier AP", async () => {
    const locationId = await seedLocation();
    const variantId = await seedVariant();
    const present = await seedPurchaseItem({
      variantId,
      qtyOrdered: 4,
      unitCostMinor: 1000,
    });
    // A second purchase that ships separately — not in this delivery.
    const absent = await seedPurchaseItem({
      variantId: await seedVariant(),
      qtyOrdered: 1,
      unitCostMinor: 1,
    });
    const courier = await seedVendor({ kind: "expedition" });

    const delivery = await createDelivery({
      date: "2026-05-16",
      targetLocationId: locationId,
      createdByUserId: userId,
    });
    await createDeliveryItem({
      deliveryId: delivery.id,
      purchaseItemId: present.itemId,
      description: "Goods",
      qty: 4,
      costMinor: 4000,
    });
    await createDeliveryItem({
      deliveryId: delivery.id,
      description: "Leg for the other PO",
      costMinor: 400,
      deliveryWide: true,
      appliesToPurchaseId: absent.purchaseId,
      vendorId: courier,
    });

    await commitDelivery(delivery.id, userId);

    expect((await getVariant(variantId))?.costMinor).toBe(1000);
    const ap = await ledgerFor(courier);
    expect(ap).toHaveLength(1);
    expect(ap[0]?.amountMinor).toBe(400);
  });

  test("delivery-wide and PO-scope guard rails", async () => {
    const locationId = await seedLocation();
    const variantId = await seedVariant();
    const { purchaseId, itemId } = await seedPurchaseItem({
      variantId,
      qtyOrdered: 4,
      unitCostMinor: 1000,
    });
    const delivery = await createDelivery({
      date: "2026-05-16",
      targetLocationId: locationId,
      createdByUserId: userId,
    });

    // deliveryWide on a goods leaf.
    await expectError(
      createDeliveryItem({
        deliveryId: delivery.id,
        purchaseItemId: itemId,
        description: "Goods",
        qty: 4,
        costMinor: 4000,
        deliveryWide: true,
      }),
      "INVALID_INPUT",
    );

    const group = await createDeliveryItem({
      deliveryId: delivery.id,
      description: "Group",
      costMinor: 0,
    });
    // deliveryWide on a nested node.
    await expectError(
      createDeliveryItem({
        deliveryId: delivery.id,
        parentItemId: group.id,
        description: "Nested leg",
        costMinor: 100,
        deliveryWide: true,
      }),
      "INVALID_INPUT",
    );
    // PO scope without deliveryWide.
    await expectError(
      createDeliveryItem({
        deliveryId: delivery.id,
        description: "Scoped but not wide",
        costMinor: 100,
        appliesToPurchaseId: purchaseId,
      }),
      "INVALID_INPUT",
    );
    // Unknown purchase.
    await expectError(
      createDeliveryItem({
        deliveryId: delivery.id,
        description: "Leg",
        costMinor: 100,
        deliveryWide: true,
        appliesToPurchaseId: ulid(),
      }),
      "INVALID_INPUT",
    );

    const leg = await createDeliveryItem({
      deliveryId: delivery.id,
      description: "Leg",
      costMinor: 100,
      deliveryWide: true,
    });
    // Nothing can be created under a leg…
    await expectError(
      createDeliveryItem({
        deliveryId: delivery.id,
        parentItemId: leg.id,
        description: "Inside a leg",
        costMinor: 10,
      }),
      "INVALID_INPUT",
    );
    // …a leg cannot be nested without clearing its scope…
    await expectError(
      updateDeliveryItem(leg.id, { parentItemId: group.id }),
      "INVALID_INPUT",
    );
    // …and a node with children cannot be flagged delivery-wide.
    await createDeliveryItem({
      deliveryId: delivery.id,
      parentItemId: group.id,
      description: "Child charge",
      costMinor: 10,
    });
    await expectError(
      updateDeliveryItem(group.id, { deliveryWide: true }),
      "INVALID_INPUT",
    );
  });

  test("rejects nesting a line under a goods leaf", async () => {
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
    const leaf = await createDeliveryItem({
      deliveryId: delivery.id,
      purchaseItemId: itemId,
      description: "Widgets",
      qty: 10,
      costMinor: 5000,
    });
    await expectError(
      createDeliveryItem({
        deliveryId: delivery.id,
        parentItemId: leaf.id,
        description: "Freight under a leaf",
        costMinor: 100,
      }),
      "INVALID_INPUT",
    );
  });

  test("discards a draft whose goods are nested under a cost node", async () => {
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
    // Cost node created BEFORE the goods nested under it — the parent gets the
    // smaller ULID, so a plain deliveryId cascade would hit the RESTRICT
    // self-FK. deleteDelivery must flatten the tree first.
    const freight = await createDeliveryItem({
      deliveryId: delivery.id,
      description: "Freight",
      costMinor: 1000,
    });
    await createDeliveryItem({
      deliveryId: delivery.id,
      parentItemId: freight.id,
      purchaseItemId: itemId,
      description: "Widgets",
      qty: 10,
      costMinor: 5000,
    });

    await deleteDelivery(delivery.id);
    expect(await getDelivery(delivery.id)).toBeUndefined();
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
    const freight = await createDeliveryItem({
      deliveryId: delivery.id,
      description: "Freight",
      costMinor: 1000, // tagged to the courier → expedition AP
      vendorId: courierId,
    });
    await createDeliveryItem({
      deliveryId: delivery.id,
      parentItemId: freight.id, // goods sit under the freight → it capitalizes
      purchaseItemId: itemId,
      description: "Widgets",
      qty: 10,
      costMinor: 5000, // base goods cost → supplier AP
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
    const freight = await createDeliveryItem({
      deliveryId: delivery.id,
      description: "Freight (absorbed)",
      costMinor: 1000, // no vendorId → no AP
    });
    await createDeliveryItem({
      deliveryId: delivery.id,
      parentItemId: freight.id, // goods under the freight → it is absorbed into them
      purchaseItemId: itemId,
      description: "Widgets",
      qty: 10,
      costMinor: 5000,
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
