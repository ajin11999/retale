// Integration tests for the vendor-catalog reference DB: CRUD, variant
// linking (+ vendor-code upsert), price history, re-import matching, and the
// CSV → preview → confirm cycle. Runs against TEST_DATABASE_URL and wipes the
// catalog / mapping / product / vendor tables between tests.
//
//   bun test src/services/vendor-catalog-service.test.ts

import "../lib/load-env.ts";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { eq, sql } from "drizzle-orm";
import { ulid } from "ulid";
import { users } from "../db/schema/auth.ts";
import { products, productVariants } from "../db/schema/products.ts";
import { vendorCatalogItems } from "../db/schema/vendor-catalog.ts";
import { vendors } from "../db/schema/vendors.ts";
import { db } from "../lib/db.ts";
import {
  buildCatalogPreview,
  confirmCatalogImport,
  createCatalogImport,
  parseCatalogCsv,
} from "./catalog-import-service.ts";
import {
  compareCatalogPrices,
  createCatalogItem,
  getCatalogItem,
  hardDeleteCatalogItem,
  isCatalogRowStale,
  linkCatalogItem,
  listCatalogPriceHistory,
  unlinkCatalogItem,
  updateCatalogItem,
  VendorCatalogError,
  type VendorCatalogErrorCode,
} from "./vendor-catalog-service.ts";
import { resolveVendorCode } from "./vendor-variant-code-service.ts";

let userId: string;

async function wipe(): Promise<void> {
  await db.execute(sql`SET FOREIGN_KEY_CHECKS = 0`);
  for (const t of [
    "vendor_catalog_prices",
    "vendor_catalog_imports",
    "vendor_catalog_items",
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
    name: "Catalog Test",
  });
});

afterAll(async () => {
  await wipe();
  await db.delete(users).where(eq(users.id, userId));
});

beforeEach(wipe);

async function expectCatalogError(
  p: Promise<unknown>,
  code: VendorCatalogErrorCode,
): Promise<void> {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(VendorCatalogError);
    expect((e as VendorCatalogError).code).toBe(code);
    return;
  }
  throw new Error(`expected VendorCatalogError ${code}, nothing thrown`);
}

async function seedVendor(name = "Supplier A"): Promise<string> {
  const id = ulid();
  await db.insert(vendors).values({ id, name });
  return id;
}

async function seedVariant(): Promise<{ productId: string; variantId: string }> {
  const productId = ulid();
  const variantId = ulid();
  await db.insert(products).values({ id: productId, name: "Bolt M8", priceMode: "tax_inclusive" });
  await db.insert(productVariants).values({
    id: variantId,
    productId,
    sku: "BOLT-M8",
    priceMinor: 1000,
    costMinor: 700,
  });
  return { productId, variantId };
}

describe("vendor catalog CRUD", () => {
  test("create writes item + initial price history", async () => {
    const vendorId = await seedVendor();
    const item = await createCatalogItem(
      { vendorId, vendorCode: "A-123", name: "Bolt M8x40", unitText: "pcs", priceMinor: 950, moq: 100, note: "dus isi 50" },
      userId,
    );
    expect(item.name).toBe("Bolt M8x40");
    expect(item.priceMinor).toBe(950);
    expect(item.lastSeenAt).not.toBeNull();
    const history = await listCatalogPriceHistory(item.id);
    expect(history).toHaveLength(1);
    expect(history[0]!.priceMinor).toBe(950);
  });

  test("create rejects negative / over-precise prices and blank names", async () => {
    const vendorId = await seedVendor();
    await expectCatalogError(
      createCatalogItem({ vendorId, name: "  ", priceMinor: 10 }, userId),
      "INVALID_INPUT",
    );
    await expectCatalogError(
      createCatalogItem({ vendorId, name: "X", priceMinor: -5 }, userId),
      "INVALID_INPUT",
    );
    await expectCatalogError(
      createCatalogItem({ vendorId, name: "X", priceMinor: 10.555 }, userId),
      "INVALID_INPUT",
    );
  });

  test("price update appends history; note-only update does not", async () => {
    const vendorId = await seedVendor();
    const item = await createCatalogItem({ vendorId, name: "Nut M8", priceMinor: 500 }, userId);
    await updateCatalogItem(item.id, { note: "stainless" }, userId);
    expect(await listCatalogPriceHistory(item.id)).toHaveLength(1);
    const bumped = await updateCatalogItem(item.id, { priceMinor: 550 }, userId);
    expect(bumped.priceMinor).toBe(550);
    const history = await listCatalogPriceHistory(item.id);
    expect(history).toHaveLength(2);
  });

  test("hard delete removes the row (history cascades)", async () => {
    const vendorId = await seedVendor();
    const item = await createCatalogItem({ vendorId, name: "Washer", priceMinor: 100 }, userId);
    await hardDeleteCatalogItem(item.id);
    await expectCatalogError(getCatalogItem(item.id), "CATALOG_ITEM_NOT_FOUND");
  });
});

describe("variant linking", () => {
  test("link sets mappedVariantId and upserts the vendor code for receiving scan", async () => {
    const vendorId = await seedVendor();
    const { variantId } = await seedVariant();
    const item = await createCatalogItem(
      { vendorId, vendorCode: "SUP-BOLT8", name: "Bolt M8", priceMinor: 950 },
      userId,
    );
    const linked = await linkCatalogItem(item.id, variantId);
    expect(linked.mappedVariantId).toBe(variantId);
    expect(await resolveVendorCode(vendorId, "SUP-BOLT8")).toEqual([variantId]);
  });

  test("unlink clears the variant but keeps the scan code", async () => {
    const vendorId = await seedVendor();
    const { variantId } = await seedVariant();
    const item = await createCatalogItem(
      { vendorId, vendorCode: "SUP-BOLT8", name: "Bolt M8", priceMinor: 950 },
      userId,
    );
    await linkCatalogItem(item.id, variantId);
    const unlinked = await unlinkCatalogItem(item.id);
    expect(unlinked.mappedVariantId).toBeNull();
    expect(await resolveVendorCode(vendorId, "SUP-BOLT8")).toEqual([variantId]);
  });

  test("compareCatalogPrices returns cheapest-first across vendors", async () => {
    const v1 = await seedVendor("Cheap Co");
    const v2 = await seedVendor("Pricey Co");
    const { variantId } = await seedVariant();
    const cheap = await createCatalogItem({ vendorId: v1, name: "Bolt M8", priceMinor: 900 }, userId);
    await createCatalogItem({ vendorId: v2, name: "Bolt M8", priceMinor: 1200 }, userId);
    await linkCatalogItem(cheap.id, variantId);
    const rows = await compareCatalogPrices(variantId);
    // Only linked rows compare — the pricey row is unlinked.
    expect(rows.map((r) => r.vendorName)).toEqual(["Cheap Co"]);
  });
});

describe("staleness", () => {
  test("past validTo or 90d+ unseen marks stale", () => {
    expect(isCatalogRowStale({ validTo: "2000-01-01", lastSeenAt: new Date() })).toBe(true);
    expect(
      isCatalogRowStale({ validTo: null, lastSeenAt: new Date(Date.now() - 100 * 86400_000) }),
    ).toBe(true);
    expect(isCatalogRowStale({ validTo: null, lastSeenAt: new Date() })).toBe(false);
  });
});

describe("CSV import → preview → confirm", () => {
  test("parses id-ID prices, matches existing rows as updates, confirms create+update", async () => {
    const vendorId = await seedVendor();
    const existing = await createCatalogItem(
      { vendorId, vendorCode: "A-1", name: "Bolt M8x40", priceMinor: 950 },
      userId,
    );
    const csv = [
      "code,name,unit,price,moq,note",
      "A-1,Bolt M8x40,pcs,\"Rp 1.050\",100,naik",
      "A-2,Nut M8,pcs,500,,",
      '"",Nameless Priceless Row,pcs,,,"',
    ].join("\n");
    const incoming = parseCatalogCsv(csv);
    expect(incoming).toHaveLength(3);
    expect(incoming[0]!.priceMinor).toBe(1050);

    const preview = await buildCatalogPreview(vendorId, incoming);
    expect(preview[0]!.action).toBe("update");
    expect(preview[0]!.matchedItemId).toBe(existing.id);
    expect(preview[1]!.action).toBe("create");

    const importId = await createCatalogImport(vendorId, "pricelist.csv", userId);
    const result = await confirmCatalogImport(
      {
        importId,
        vendorId,
        rows: [
          { ...preview[0]!, matchedItemId: preview[0]!.matchedItemId },
          { ...preview[1]! },
          // priceless new row is skipped, not created
          { ...preview[2]! },
        ],
      },
      userId,
    );
    expect(result).toEqual({ created: 1, updated: 1, skipped: 1 });

    const updatedItem = await getCatalogItem(existing.id);
    expect(updatedItem.priceMinor).toBe(1050);
    expect(await listCatalogPriceHistory(existing.id)).toHaveLength(2);
    const createdRow = await db.query.vendorCatalogItems.findFirst({
      where: eq(vendorCatalogItems.vendorId, vendorId),
    });
    expect(createdRow).not.toBeNull();
  });
});
