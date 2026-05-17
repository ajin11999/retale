// Integration tests for the reorder scan and suggestion conversion. These run
// against the local Docker MariaDB (DATABASE_URL) and WIPE the reorder /
// purchase / product / vendor tables between tests — point them only at a dev
// database.
//
//   bun test src/services/reorder-service.test.ts

import "../lib/load-env.ts";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { eq, sql } from "drizzle-orm";
import { ulid } from "ulid";
import { users } from "../db/schema/auth.ts";
import { products, productVariants } from "../db/schema/products.ts";
import { purchaseItems, purchases } from "../db/schema/purchases.ts";
import { reorderSuggestions } from "../db/schema/reorder.ts";
import { vendors } from "../db/schema/vendors.ts";
import { db } from "../lib/db.ts";
import {
  convertSuggestions,
  dismissSuggestion,
  listSuggestions,
  ReorderError,
  type ReorderErrorCode,
  runReorderScan,
} from "./reorder-service.ts";

let userId: string;

async function wipe(): Promise<void> {
  await db.execute(sql`SET FOREIGN_KEY_CHECKS = 0`);
  for (const t of [
    "reorder_suggestions",
    "purchase_items",
    "purchases",
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
    name: "Reorder Test",
  });
});

afterAll(async () => {
  await wipe();
  await db.delete(users).where(eq(users.id, userId));
});

beforeEach(wipe);

/** Seed a variant; opts control reorder thresholds, stock and primary vendor. */
async function seedVariant(opts: {
  totalQty?: number;
  reorderPoint?: number | null;
  reorderQty?: number | null;
  primaryVendorId?: string | null;
  costMinor?: number;
  kind?: "physical" | "service";
  monitored?: boolean;
  archived?: boolean;
}): Promise<string> {
  const productId = ulid();
  const variantId = ulid();
  await db.insert(products).values({
    id: productId,
    name: "Widget",
    priceMode: "tax_exclusive",
    kind: opts.kind ?? "physical",
    primaryVendorId: opts.primaryVendorId ?? null,
    replenishMonitored: opts.monitored ?? true,
    archivedAt: opts.archived ? new Date() : null,
  });
  await db.insert(productVariants).values({
    id: variantId,
    productId,
    sku: `SKU-${variantId}`,
    priceMinor: 1000,
    costMinor: opts.costMinor ?? 0,
    totalQty: opts.totalQty ?? 0,
    reorderPoint: opts.reorderPoint ?? null,
    reorderQty: opts.reorderQty ?? null,
  });
  return variantId;
}

async function seedVendor(name = "Acme"): Promise<string> {
  const id = ulid();
  await db.insert(vendors).values({ id, name });
  return id;
}

/** Seed a purchase with one line for `variantId`. */
async function seedPurchase(opts: {
  vendorId: string | null;
  variantId: string;
  qtyOrdered: number;
  qtyDelivered?: number;
  status?: "open" | "complete" | "cancelled";
  date?: string;
}): Promise<string> {
  const purchaseId = ulid();
  await db.insert(purchases).values({
    id: purchaseId,
    vendorId: opts.vendorId,
    snapshotVendorName: "Vendor",
    date: opts.date ?? "2026-01-01",
    status: opts.status ?? "open",
  });
  await db.insert(purchaseItems).values({
    id: ulid(),
    purchaseId,
    variantId: opts.variantId,
    qtyOrdered: opts.qtyOrdered,
    qtyDelivered: opts.qtyDelivered ?? 0,
    unitCostMinor: 500,
  });
  return purchaseId;
}

async function expectError(
  fn: () => Promise<unknown>,
  code: ReorderErrorCode,
): Promise<void> {
  try {
    await fn();
    throw new Error(`expected ReorderError ${code}`);
  } catch (e) {
    expect(e).toBeInstanceOf(ReorderError);
    expect((e as ReorderError).code).toBe(code);
  }
}

describe("runReorderScan", () => {
  test("suggests a variant below its reorder point", async () => {
    const v = await seedVariant({ totalQty: 2, reorderPoint: 10 });
    const out = await runReorderScan();
    expect(out).toHaveLength(1);
    expect(out[0]!.variantId).toBe(v);
    expect(out[0]!.currentStock).toBe(2);
    expect(out[0]!.reorderPoint).toBe(10);
    expect(out[0]!.status).toBe("open");
  });

  test("ignores a variant with no reorder point", async () => {
    await seedVariant({ totalQty: 0, reorderPoint: null });
    expect(await runReorderScan()).toHaveLength(0);
  });

  test("ignores a variant at or above its reorder point", async () => {
    await seedVariant({ totalQty: 10, reorderPoint: 10 });
    expect(await runReorderScan()).toHaveLength(0);
  });

  test("nets out on-order stock so an open PO is not re-suggested", async () => {
    const vendorId = await seedVendor();
    const v = await seedVariant({ totalQty: 2, reorderPoint: 10 });
    // 8 on order → available 10, not below the point.
    await seedPurchase({ vendorId, variantId: v, qtyOrdered: 8 });
    expect(await runReorderScan()).toHaveLength(0);
  });

  test("counts only the undelivered part of an open PO as on-order", async () => {
    const vendorId = await seedVendor();
    const v = await seedVariant({ totalQty: 2, reorderPoint: 10 });
    // 8 ordered, 6 already delivered → 2 on order → available 4 < 10.
    await seedPurchase({ vendorId, variantId: v, qtyOrdered: 8, qtyDelivered: 6 });
    const out = await runReorderScan();
    expect(out).toHaveLength(1);
  });

  test("ignores cancelled purchases when computing on-order", async () => {
    const vendorId = await seedVendor();
    const v = await seedVariant({ totalQty: 2, reorderPoint: 10 });
    await seedPurchase({
      vendorId,
      variantId: v,
      qtyOrdered: 8,
      status: "cancelled",
    });
    expect(await runReorderScan()).toHaveLength(1);
  });

  test("skips service products and unmonitored / archived products", async () => {
    await seedVariant({ totalQty: 0, reorderPoint: 5, kind: "service" });
    await seedVariant({ totalQty: 0, reorderPoint: 5, monitored: false });
    await seedVariant({ totalQty: 0, reorderPoint: 5, archived: true });
    expect(await runReorderScan()).toHaveLength(0);
  });

  test("suggestedQty uses reorderQty when set", async () => {
    await seedVariant({ totalQty: 2, reorderPoint: 10, reorderQty: 50 });
    const out = await runReorderScan();
    expect(out[0]!.suggestedQty).toBe(50);
  });

  test("suggestedQty fills the gap to the point when reorderQty is null", async () => {
    await seedVariant({ totalQty: 2, reorderPoint: 10 });
    const out = await runReorderScan();
    expect(out[0]!.suggestedQty).toBe(8);
  });

  test("picks the last-used vendor over the primary vendor", async () => {
    const primary = await seedVendor("Primary");
    const lastUsed = await seedVendor("LastUsed");
    const v = await seedVariant({
      totalQty: 2,
      reorderPoint: 10,
      primaryVendorId: primary,
    });
    await seedPurchase({ vendorId: lastUsed, variantId: v, qtyOrdered: 1 });
    const out = await runReorderScan();
    expect(out[0]!.vendorId).toBe(lastUsed);
  });

  test("falls back to the primary vendor with no purchase history", async () => {
    const primary = await seedVendor("Primary");
    await seedVariant({ totalQty: 2, reorderPoint: 10, primaryVendorId: primary });
    const out = await runReorderScan();
    expect(out[0]!.vendorId).toBe(primary);
  });

  test("leaves vendor unassigned when there is no vendor at all", async () => {
    await seedVariant({ totalQty: 2, reorderPoint: 10 });
    const out = await runReorderScan();
    expect(out[0]!.vendorId).toBeNull();
  });

  test("a new scan supersedes the previous open set", async () => {
    await seedVariant({ totalQty: 2, reorderPoint: 10 });
    const first = await runReorderScan();
    const second = await runReorderScan();
    expect(second).toHaveLength(1);
    expect(second[0]!.id).not.toBe(first[0]!.id);
    expect(await listSuggestions("open")).toHaveLength(1);
  });

  test("a rescan keeps converted / dismissed rows", async () => {
    await seedVariant({ totalQty: 2, reorderPoint: 10 });
    const [s] = await runReorderScan();
    await dismissSuggestion(s!.id);
    await runReorderScan();
    expect(await listSuggestions("dismissed")).toHaveLength(1);
    expect(await listSuggestions("open")).toHaveLength(1);
  });
});

describe("dismissSuggestion", () => {
  test("marks an open suggestion dismissed", async () => {
    await seedVariant({ totalQty: 2, reorderPoint: 10 });
    const [s] = await runReorderScan();
    const out = await dismissSuggestion(s!.id);
    expect(out.status).toBe("dismissed");
  });

  test("is idempotent on an already-dismissed suggestion", async () => {
    await seedVariant({ totalQty: 2, reorderPoint: 10 });
    const [s] = await runReorderScan();
    await dismissSuggestion(s!.id);
    expect((await dismissSuggestion(s!.id)).status).toBe("dismissed");
  });

  test("rejects an unknown id", async () => {
    await expectError(() => dismissSuggestion(ulid()), "SUGGESTION_NOT_FOUND");
  });
});

describe("convertSuggestions", () => {
  test("creates one draft purchase per vendor and marks suggestions converted", async () => {
    const vendorA = await seedVendor("A");
    const vendorB = await seedVendor("B");
    const v1 = await seedVariant({
      totalQty: 0,
      reorderPoint: 10,
      reorderQty: 20,
      primaryVendorId: vendorA,
      costMinor: 700,
    });
    await seedVariant({
      totalQty: 0,
      reorderPoint: 5,
      reorderQty: 5,
      primaryVendorId: vendorA,
    });
    await seedVariant({
      totalQty: 0,
      reorderPoint: 3,
      reorderQty: 3,
      primaryVendorId: vendorB,
    });
    const open = await runReorderScan();
    const created = await convertSuggestions(
      open.map((s) => ({ suggestionId: s.id })),
      userId,
    );
    expect(created).toHaveLength(2); // vendor A and vendor B

    const items = await db.select().from(purchaseItems);
    expect(items).toHaveLength(3);
    // v1's line is priced at the variant's current cost.
    const v1Item = items.find((i) => i.variantId === v1);
    expect(v1Item!.unitCostMinor).toBe(700);
    expect(v1Item!.qtyOrdered).toBe(20);

    expect(await listSuggestions("converted")).toHaveLength(3);
    expect(await listSuggestions("open")).toHaveLength(0);
  });

  test("applies qty and vendor overrides", async () => {
    const original = await seedVendor("Original");
    const override = await seedVendor("Override");
    await seedVariant({
      totalQty: 0,
      reorderPoint: 10,
      reorderQty: 10,
      primaryVendorId: original,
    });
    const [s] = await runReorderScan();
    const created = await convertSuggestions(
      [{ suggestionId: s!.id, qty: 99, vendorId: override }],
      userId,
    );
    expect(created).toHaveLength(1);
    expect(created[0]!.vendorId).toBe(override);
    const items = await db.select().from(purchaseItems);
    expect(items[0]!.qtyOrdered).toBe(99);
  });

  test("rejects an unassigned suggestion with no vendor override", async () => {
    await seedVariant({ totalQty: 0, reorderPoint: 10 });
    const [s] = await runReorderScan();
    expect(s!.vendorId).toBeNull();
    await expectError(
      () => convertSuggestions([{ suggestionId: s!.id }], userId),
      "UNASSIGNED_VENDOR",
    );
  });

  test("converts an unassigned suggestion when a vendor is supplied", async () => {
    const vendorId = await seedVendor();
    await seedVariant({ totalQty: 0, reorderPoint: 10 });
    const [s] = await runReorderScan();
    const created = await convertSuggestions(
      [{ suggestionId: s!.id, vendorId }],
      userId,
    );
    expect(created).toHaveLength(1);
  });

  test("rejects converting an already-converted suggestion", async () => {
    const vendorId = await seedVendor();
    await seedVariant({ totalQty: 0, reorderPoint: 10, primaryVendorId: vendorId });
    const [s] = await runReorderScan();
    await convertSuggestions([{ suggestionId: s!.id }], userId);
    await expectError(
      () => convertSuggestions([{ suggestionId: s!.id }], userId),
      "NOT_OPEN",
    );
  });

  test("rejects an empty selection", async () => {
    await expectError(() => convertSuggestions([], userId), "EMPTY_SELECTION");
  });

  test("rejects an unknown vendor override", async () => {
    const vendorId = await seedVendor();
    await seedVariant({ totalQty: 0, reorderPoint: 10, primaryVendorId: vendorId });
    const [s] = await runReorderScan();
    await expectError(
      () => convertSuggestions([{ suggestionId: s!.id, vendorId: ulid() }], userId),
      "VENDOR_NOT_FOUND",
    );
  });
});
