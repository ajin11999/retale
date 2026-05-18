// Integration tests for purchase-service. Currently covers `clonePurchase` —
// the recurring-order shortcut. Runs against the local Docker MariaDB
// (DATABASE_URL) and WIPEs the purchase / product / vendor tables between
// tests, so point it only at a dev database.
//
//   bun test src/services/purchase-service.test.ts

import "../lib/load-env.ts";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { eq, sql } from "drizzle-orm";
import { ulid } from "ulid";
import { users } from "../db/schema/auth.ts";
import { products, productVariants } from "../db/schema/products.ts";
import { purchaseItems, purchaseSections, purchases } from "../db/schema/purchases.ts";
import { db } from "../lib/db.ts";
import {
  cancelPurchase,
  clonePurchase,
  createItem,
  createPurchase,
  createSection,
  listItems,
  listSections,
  listSends,
  recordPurchaseSend,
} from "./purchase-service.ts";

let userId: string;

async function wipe(): Promise<void> {
  await db.execute(sql`SET FOREIGN_KEY_CHECKS = 0`);
  for (const t of [
    "purchase_sends",
    "purchase_items",
    "purchase_sections",
    "purchases",
    "product_variants",
    "products",
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
    name: "Purchase Test",
  });
});

afterAll(async () => {
  await wipe();
  await db.delete(users).where(eq(users.id, userId));
});

beforeEach(wipe);

/** Create a product + one variant; returns the variant id. */
async function seedVariant(): Promise<string> {
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
  });
  return variantId;
}

const today = () => new Date().toISOString().slice(0, 10);

describe("clonePurchase", () => {
  test("clones the header as a fresh open draft, dropping sourceDocument", async () => {
    const variantId = await seedVariant();
    const source = await createPurchase({
      snapshotVendorName: "Acme Supply",
      date: "2026-01-01",
      sourceDocument: "INV-001",
      memo: "monthly fastener basket",
      createdByUserId: userId,
    });
    await createItem({
      purchaseId: source.id,
      variantId,
      qtyOrdered: 50,
      unitCostMinor: 200,
    });

    const clone = await clonePurchase(source.id, userId);
    expect(clone.id).not.toBe(source.id);
    expect(clone.status).toBe("open");
    expect(clone.revision).toBe(1);
    expect(clone.date).toBe(today());
    expect(clone.snapshotVendorName).toBe("Acme Supply");
    expect(clone.memo).toBe("monthly fastener basket");
    expect(clone.sourceDocument).toBeNull();
    expect(clone.lastSentAt).toBeNull();
  });

  test("copies sections and items, remapping sections and resetting delivery", async () => {
    const variantId = await seedVariant();
    const source = await createPurchase({
      snapshotVendorName: "Acme Supply",
      date: "2026-01-01",
      createdByUserId: userId,
    });
    const section = await createSection({ purchaseId: source.id, name: "Bolts", sortOrder: 0 });
    await createItem({
      purchaseId: source.id,
      sectionId: section.id,
      variantId,
      qtyOrdered: 50,
      unitCostMinor: 200,
    });
    await createItem({
      purchaseId: source.id,
      variantId: null,
      description: "Shop rags",
      qtyOrdered: 5,
      unitCostMinor: 100,
    });
    // Simulate a partial delivery on the source line.
    await db
      .update(purchaseItems)
      .set({ qtyDelivered: 20 })
      .where(eq(purchaseItems.purchaseId, source.id));

    const clone = await clonePurchase(source.id, userId);

    const cloneSections = await listSections(clone.id);
    expect(cloneSections).toHaveLength(1);
    expect(cloneSections[0]?.id).not.toBe(section.id);
    expect(cloneSections[0]?.name).toBe("Bolts");

    const cloneItems = await listItems(clone.id);
    expect(cloneItems).toHaveLength(2);
    const stockLine = cloneItems.find((i) => i.variantId === variantId);
    expect(stockLine?.qtyOrdered).toBe(50);
    expect(stockLine?.qtyDelivered).toBe(0); // delivery progress is not copied
    expect(stockLine?.sectionId).toBe(cloneSections[0]?.id as string); // remapped
    const nonStockLine = cloneItems.find((i) => i.variantId === null);
    expect(nonStockLine?.description).toBe("Shop rags");

    // The source is untouched.
    expect((await listItems(source.id))[0]?.qtyDelivered).toBe(20);
  });

  test("clones a cancelled purchase into a fresh open one, without send history", async () => {
    const source = await createPurchase({
      snapshotVendorName: "Acme Supply",
      date: "2026-01-01",
      createdByUserId: userId,
    });
    await recordPurchaseSend({
      purchaseId: source.id,
      channel: "whatsapp",
      recipient: "+15550001",
      createdByUserId: userId,
    });
    await cancelPurchase(source.id, userId);

    const clone = await clonePurchase(source.id, userId);
    expect(clone.status).toBe("open");
    expect(await listSends(clone.id)).toHaveLength(0);
  });
});
