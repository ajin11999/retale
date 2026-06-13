// Integration tests for purchase-service — `clonePurchase` (the recurring-
// order shortcut) and `unmappedLines` (the pre-send vendor-code warning).
// Runs against the local Docker MariaDB (DATABASE_URL) and WIPEs the purchase
// / product / vendor tables between tests, so point it only at a dev database.
//
//   bun test src/services/purchase-service.test.ts

import "../lib/load-env.ts";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { eq, sql } from "drizzle-orm";
import { ulid } from "ulid";
import { users } from "../db/schema/auth.ts";
import { products, productVariants } from "../db/schema/products.ts";
import { purchaseItems, purchaseSections, purchases } from "../db/schema/purchases.ts";
import { vendors } from "../db/schema/vendors.ts";
import { db } from "../lib/db.ts";
import {
  cancelPurchase,
  clonePurchase,
  confirmPurchaseSend,
  createItem,
  createItems,
  createPurchase,
  createSection,
  getPurchase,
  lastVendorCosts,
  listItems,
  listSections,
  listSends,
  PurchaseError,
  type PurchaseErrorCode,
  recordPurchaseSend,
  resourcePurchaseItems,
  unmappedLines,
} from "./purchase-service.ts";
import { setVendorVariantCode } from "./vendor-variant-code-service.ts";

let userId: string;

async function wipe(): Promise<void> {
  await db.execute(sql`SET FOREIGN_KEY_CHECKS = 0`);
  for (const t of [
    "purchase_sends",
    "purchase_items",
    "purchase_sections",
    "purchases",
    "vendor_variant_codes",
    "product_variants",
    "products",
    "vendors",
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

/** Create a vendor; returns its id. */
async function seedVendor(): Promise<string> {
  const id = ulid();
  await db.insert(vendors).values({ id, name: "Acme Supply" });
  return id;
}

/** Assert a promise rejects with a PurchaseError carrying the given code. */
async function expectError(
  p: Promise<unknown>,
  code: PurchaseErrorCode,
): Promise<void> {
  const err = await p.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(PurchaseError);
  expect((err as PurchaseError).code).toBe(code);
}

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

describe("unmappedLines", () => {
  test("returns stock lines the vendor has no code mapping for", async () => {
    const vendorId = await seedVendor();
    const mappedVariant = await seedVariant();
    const unmappedVariant = await seedVariant();
    const purchase = await createPurchase({
      vendorId,
      date: "2026-01-01",
      createdByUserId: userId,
    });
    await createItem({
      purchaseId: purchase.id,
      variantId: mappedVariant,
      qtyOrdered: 1,
      unitCostMinor: 100,
    });
    const unmappedItem = await createItem({
      purchaseId: purchase.id,
      variantId: unmappedVariant,
      qtyOrdered: 1,
      unitCostMinor: 100,
    });
    await setVendorVariantCode({ vendorId, variantId: mappedVariant, code: "VC-1" });

    const out = await unmappedLines(purchase.id);
    expect(out.map((i) => i.id)).toEqual([unmappedItem.id]);
  });

  test("is empty when every stock line is mapped", async () => {
    const vendorId = await seedVendor();
    const variantId = await seedVariant();
    const purchase = await createPurchase({
      vendorId,
      date: "2026-01-01",
      createdByUserId: userId,
    });
    await createItem({
      purchaseId: purchase.id,
      variantId,
      qtyOrdered: 1,
      unitCostMinor: 100,
    });
    await setVendorVariantCode({ vendorId, variantId, code: "VC-1" });

    expect(await unmappedLines(purchase.id)).toHaveLength(0);
  });

  test("ignores non-stock lines and ad-hoc purchases with no vendor", async () => {
    // Non-stock line on a vendor PO — has no variant, so cannot be unmapped.
    const vendorId = await seedVendor();
    const withVendor = await createPurchase({
      vendorId,
      date: "2026-01-01",
      createdByUserId: userId,
    });
    await createItem({
      purchaseId: withVendor.id,
      variantId: null,
      description: "Shop rags",
      qtyOrdered: 1,
      unitCostMinor: 100,
    });
    expect(await unmappedLines(withVendor.id)).toHaveLength(0);

    // Ad-hoc purchase — no vendor to recognize parts, so no warning.
    const variantId = await seedVariant();
    const adHoc = await createPurchase({
      snapshotVendorName: "Ad-hoc",
      date: "2026-01-01",
      createdByUserId: userId,
    });
    await createItem({
      purchaseId: adHoc.id,
      variantId,
      qtyOrdered: 1,
      unitCostMinor: 100,
    });
    expect(await unmappedLines(adHoc.id)).toHaveLength(0);
  });
});

describe("recordPurchaseSend / confirmPurchaseSend", () => {
  async function seedPurchase(): Promise<string> {
    const p = await createPurchase({
      snapshotVendorName: "Acme",
      date: "2026-01-01",
      createdByUserId: userId,
    });
    return p.id;
  }

  test("a whatsapp send starts prepared and does not stamp lastSentAt", async () => {
    const purchaseId = await seedPurchase();
    const send = await recordPurchaseSend({
      purchaseId,
      channel: "whatsapp",
      recipient: "+15550001",
      createdByUserId: userId,
    });
    expect(send.status).toBe("prepared");
    expect(send.sentAt).toBeNull();
    expect((await getPurchase(purchaseId)).lastSentAt).toBeNull();
  });

  test("a manual send is sent at once and stamps lastSentAt", async () => {
    const purchaseId = await seedPurchase();
    const send = await recordPurchaseSend({
      purchaseId,
      channel: "manual",
      recipient: "walk-in",
      createdByUserId: userId,
    });
    expect(send.status).toBe("sent");
    expect(send.sentAt).not.toBeNull();
    expect((await getPurchase(purchaseId)).lastSentAt).not.toBeNull();
  });

  test("confirming a prepared send flips it to sent with the expected date", async () => {
    const purchaseId = await seedPurchase();
    const prepared = await recordPurchaseSend({
      purchaseId,
      channel: "email",
      recipient: "sales@acme.test",
      createdByUserId: userId,
    });

    const confirmed = await confirmPurchaseSend({
      id: prepared.id,
      expectedDeliveryDate: "2026-02-01",
    });
    expect(confirmed.status).toBe("sent");
    expect(confirmed.sentAt).not.toBeNull();
    expect(confirmed.expectedDeliveryDate).toBe("2026-02-01");
    expect((await getPurchase(purchaseId)).lastSentAt).not.toBeNull();
  });

  test("a send cannot be confirmed twice", async () => {
    const purchaseId = await seedPurchase();
    const prepared = await recordPurchaseSend({
      purchaseId,
      channel: "email",
      recipient: "sales@acme.test",
      createdByUserId: userId,
    });
    await confirmPurchaseSend({ id: prepared.id });
    await expectError(
      confirmPurchaseSend({ id: prepared.id }),
      "SEND_ALREADY_SENT",
    );
  });

  test("confirming an unknown send is rejected", async () => {
    await expectError(confirmPurchaseSend({ id: ulid() }), "SEND_NOT_FOUND");
  });
});

describe("createItems (bulk add)", () => {
  test("appends lines after the current max sortOrder and bumps revision once", async () => {
    const v1 = await seedVariant();
    const v2 = await seedVariant();
    const purchase = await createPurchase({
      snapshotVendorName: "Acme",
      date: "2026-01-01",
      createdByUserId: userId,
    });
    // An existing line so the batch must append after it.
    await createItem({
      purchaseId: purchase.id,
      variantId: v1,
      qtyOrdered: 5,
      unitCostMinor: 100,
    });
    const revBefore = (await getPurchase(purchase.id)).revision;

    const added = await createItems({
      purchaseId: purchase.id,
      lines: [
        { variantId: v2, qtyOrdered: 3, unitCostMinor: 200 },
        { variantId: null, description: "Freight", qtyOrdered: 1, unitCostMinor: 5000 },
      ],
    });

    expect(added).toHaveLength(2);
    // Returned in input order, appended after the existing line's sortOrder (0).
    expect(added[0]!.variantId).toBe(v2);
    expect(added[0]!.sortOrder).toBe(1);
    expect(added[1]!.description).toBe("Freight");
    expect(added[1]!.sortOrder).toBe(2);

    const items = await listItems(purchase.id);
    expect(items).toHaveLength(3);
    // A single bump for the whole batch, not one per line.
    expect((await getPurchase(purchase.id)).revision).toBe(revBefore + 1);
  });

  test("rejects a bad line and rolls the whole batch back", async () => {
    const v1 = await seedVariant();
    const purchase = await createPurchase({
      snapshotVendorName: "Acme",
      date: "2026-01-01",
      createdByUserId: userId,
    });
    await expectError(
      createItems({
        purchaseId: purchase.id,
        lines: [
          { variantId: v1, qtyOrdered: 3, unitCostMinor: 200 },
          { variantId: v1, qtyOrdered: 0, unitCostMinor: 200 },
        ],
      }),
      "INVALID_INPUT",
    );
    expect(await listItems(purchase.id)).toHaveLength(0);
  });

  test("rejects an empty batch", async () => {
    const purchase = await createPurchase({
      snapshotVendorName: "Acme",
      date: "2026-01-01",
      createdByUserId: userId,
    });
    await expectError(
      createItems({ purchaseId: purchase.id, lines: [] }),
      "INVALID_INPUT",
    );
  });
});

describe("lastVendorCosts", () => {
  test("returns each variant's cost from the vendor's newest purchase", async () => {
    const vendorId = await seedVendor();
    const v1 = await seedVariant();
    const v2 = await seedVariant();
    const older = await createPurchase({
      vendorId,
      date: "2026-01-01",
      createdByUserId: userId,
    });
    await createItem({ purchaseId: older.id, variantId: v1, qtyOrdered: 1, unitCostMinor: 100 });
    await createItem({ purchaseId: older.id, variantId: v2, qtyOrdered: 1, unitCostMinor: 900 });
    const newer = await createPurchase({
      vendorId,
      date: "2026-02-01",
      createdByUserId: userId,
    });
    await createItem({ purchaseId: newer.id, variantId: v1, qtyOrdered: 1, unitCostMinor: 150 });

    const costs = new Map(
      (await lastVendorCosts(vendorId)).map((c) => [c.variantId, c.unitCostMinor]),
    );
    // v1 comes from the newer purchase; v2 only appears on the older one.
    expect(costs.get(v1)).toBe(150);
    expect(costs.get(v2)).toBe(900);
  });

  test("ignores cancelled purchases, other vendors, and non-stock lines", async () => {
    const vendorId = await seedVendor();
    const otherVendorId = await seedVendor();
    const variantId = await seedVariant();

    const kept = await createPurchase({
      vendorId,
      date: "2026-01-01",
      createdByUserId: userId,
    });
    await createItem({ purchaseId: kept.id, variantId, qtyOrdered: 1, unitCostMinor: 100 });
    // A non-stock line never surfaces as a variant cost.
    await createItem({
      purchaseId: kept.id,
      variantId: null,
      description: "Freight",
      qtyOrdered: 1,
      unitCostMinor: 5000,
    });

    // Newer but cancelled — must not shadow the kept cost.
    const cancelled = await createPurchase({
      vendorId,
      date: "2026-02-01",
      createdByUserId: userId,
    });
    await createItem({ purchaseId: cancelled.id, variantId, qtyOrdered: 1, unitCostMinor: 999 });
    await cancelPurchase(cancelled.id, userId);

    // Newer but from a different vendor.
    const other = await createPurchase({
      vendorId: otherVendorId,
      date: "2026-03-01",
      createdByUserId: userId,
    });
    await createItem({ purchaseId: other.id, variantId, qtyOrdered: 1, unitCostMinor: 777 });

    const costs = await lastVendorCosts(vendorId);
    expect(costs).toHaveLength(1);
    expect(costs[0]!.variantId).toBe(variantId);
    expect(costs[0]!.unitCostMinor).toBe(100);
  });

  test("returns empty for a vendor with no purchase history", async () => {
    const vendorId = await seedVendor();
    expect(await lastVendorCosts(vendorId)).toHaveLength(0);
  });
});

describe("resourcePurchaseItems", () => {
  /** Create a vendor with a specific name; returns its id. */
  async function seedVendorNamed(name: string): Promise<string> {
    const id = ulid();
    await db.insert(vendors).values({ id, name });
    return id;
  }

  test("moves a full line to a new PO for the target vendor and deletes the source line", async () => {
    const abj = await seedVendorNamed("ABJ Bearing");
    const nsk = await seedVendorNamed("NSK Indonesia");
    const bbc = await seedVariant();
    const nskVariant = await seedVariant();
    const keep = await seedVariant();

    const source = await createPurchase({ vendorId: abj, date: "2026-01-01", createdByUserId: userId });
    const moved = await createItem({ purchaseId: source.id, variantId: bbc, qtyOrdered: 10, unitCostMinor: 200 });
    const kept = await createItem({ purchaseId: source.id, variantId: keep, qtyOrdered: 4, unitCostMinor: 300 });
    const revBefore = (await getPurchase(source.id)).revision;

    const newPo = await resourcePurchaseItems({
      sourcePurchaseId: source.id,
      targetVendorId: nsk,
      replacements: [{ sourceItemId: moved.id, variantId: nskVariant, qty: 10, unitCostMinor: 250 }],
      createdByUserId: userId,
    });

    expect(newPo.id).not.toBe(source.id);
    expect(newPo.status).toBe("open");
    expect(newPo.vendorId).toBe(nsk);
    expect(newPo.snapshotVendorName).toBe("NSK Indonesia");
    expect(newPo.memo).toContain(source.id);

    const newItems = await listItems(newPo.id);
    expect(newItems).toHaveLength(1);
    expect(newItems[0]!.variantId).toBe(nskVariant);
    expect(newItems[0]!.qtyOrdered).toBe(10);
    expect(newItems[0]!.unitCostMinor).toBe(250);

    // Source: the moved line is gone, the untouched line stays, revision bumped.
    const srcItems = await listItems(source.id);
    expect(srcItems.map((i) => i.id)).toEqual([kept.id]);
    expect((await getPurchase(source.id)).revision).toBe(revBefore + 1);
  });

  test("partially re-sources, leaving the remainder on the source line", async () => {
    const abj = await seedVendorNamed("ABJ Bearing");
    const nsk = await seedVendorNamed("NSK Indonesia");
    const bbc = await seedVariant();
    const nskVariant = await seedVariant();

    const source = await createPurchase({ vendorId: abj, date: "2026-01-01", createdByUserId: userId });
    const line = await createItem({ purchaseId: source.id, variantId: bbc, qtyOrdered: 10, unitCostMinor: 200 });

    const newPo = await resourcePurchaseItems({
      sourcePurchaseId: source.id,
      targetVendorId: nsk,
      replacements: [{ sourceItemId: line.id, variantId: nskVariant, qty: 4, unitCostMinor: 250 }],
      createdByUserId: userId,
    });

    // Source keeps 6 of the BBC line; the new PO carries 4 of the NSK variant.
    const srcItems = await listItems(source.id);
    expect(srcItems).toHaveLength(1);
    expect(srcItems[0]!.id).toBe(line.id);
    expect(srcItems[0]!.variantId).toBe(bbc);
    expect(srcItems[0]!.qtyOrdered).toBe(6);
    const newItems = await listItems(newPo.id);
    expect(newItems[0]!.qtyOrdered).toBe(4);
    expect(newItems[0]!.variantId).toBe(nskVariant);
  });

  test("defaults a moved line's cost to the target vendor's last-charged price", async () => {
    const abj = await seedVendorNamed("ABJ Bearing");
    const nsk = await seedVendorNamed("NSK Indonesia");
    const bbc = await seedVariant();
    const nskVariant = await seedVariant();

    // Establish NSK's last cost for the NSK variant via a prior purchase.
    const prior = await createPurchase({ vendorId: nsk, date: "2025-12-01", createdByUserId: userId });
    await createItem({ purchaseId: prior.id, variantId: nskVariant, qtyOrdered: 1, unitCostMinor: 333 });

    const source = await createPurchase({ vendorId: abj, date: "2026-01-01", createdByUserId: userId });
    const line = await createItem({ purchaseId: source.id, variantId: bbc, qtyOrdered: 5, unitCostMinor: 200 });

    const newPo = await resourcePurchaseItems({
      sourcePurchaseId: source.id,
      targetVendorId: nsk,
      replacements: [{ sourceItemId: line.id, variantId: nskVariant, qty: 5 }],
      createdByUserId: userId,
    });

    expect((await listItems(newPo.id))[0]!.unitCostMinor).toBe(333);
  });

  test("rejects re-sourcing a line that already has deliveries", async () => {
    const abj = await seedVendorNamed("ABJ Bearing");
    const nsk = await seedVendorNamed("NSK Indonesia");
    const bbc = await seedVariant();
    const nskVariant = await seedVariant();

    const source = await createPurchase({ vendorId: abj, date: "2026-01-01", createdByUserId: userId });
    const line = await createItem({ purchaseId: source.id, variantId: bbc, qtyOrdered: 10, unitCostMinor: 200 });
    await db.update(purchaseItems).set({ qtyDelivered: 3 }).where(eq(purchaseItems.id, line.id));

    await expectError(
      resourcePurchaseItems({
        sourcePurchaseId: source.id,
        targetVendorId: nsk,
        replacements: [{ sourceItemId: line.id, variantId: nskVariant, qty: 5, unitCostMinor: 250 }],
        createdByUserId: userId,
      }),
      "ITEM_LOCKED",
    );
  });

  test("rejects a qty above what the source line ordered, leaving it untouched", async () => {
    const abj = await seedVendorNamed("ABJ Bearing");
    const nsk = await seedVendorNamed("NSK Indonesia");
    const bbc = await seedVariant();
    const nskVariant = await seedVariant();

    const source = await createPurchase({ vendorId: abj, date: "2026-01-01", createdByUserId: userId });
    const line = await createItem({ purchaseId: source.id, variantId: bbc, qtyOrdered: 5, unitCostMinor: 200 });

    await expectError(
      resourcePurchaseItems({
        sourcePurchaseId: source.id,
        targetVendorId: nsk,
        replacements: [{ sourceItemId: line.id, variantId: nskVariant, qty: 6, unitCostMinor: 250 }],
        createdByUserId: userId,
      }),
      "INVALID_INPUT",
    );
    // Nothing trimmed — validation runs before any write.
    expect((await listItems(source.id))[0]!.qtyOrdered).toBe(5);
  });

  test("rejects an unknown target vendor and a non-open source", async () => {
    const abj = await seedVendorNamed("ABJ Bearing");
    const bbc = await seedVariant();
    const source = await createPurchase({ vendorId: abj, date: "2026-01-01", createdByUserId: userId });
    const line = await createItem({ purchaseId: source.id, variantId: bbc, qtyOrdered: 5, unitCostMinor: 200 });

    await expectError(
      resourcePurchaseItems({
        sourcePurchaseId: source.id,
        targetVendorId: ulid(),
        replacements: [{ sourceItemId: line.id, variantId: bbc, qty: 1, unitCostMinor: 200 }],
        createdByUserId: userId,
      }),
      "VENDOR_NOT_FOUND",
    );

    const nsk = await seedVendorNamed("NSK Indonesia");
    await cancelPurchase(source.id, userId);
    await expectError(
      resourcePurchaseItems({
        sourcePurchaseId: source.id,
        targetVendorId: nsk,
        replacements: [{ sourceItemId: line.id, variantId: bbc, qty: 1, unitCostMinor: 200 }],
        createdByUserId: userId,
      }),
      "NOT_OPEN",
    );
  });
});
