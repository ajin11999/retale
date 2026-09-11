// Integration tests for product merge (compacting products into variants).
// Covers: happy path (variants + images move, labels applied, sources
// deleted), stock rows travelling with the variant, and the kind / priceMode
// / self guards. Runs against the local Docker MariaDB and WIPES the product
// tables between tests.
//
//   bun test src/services/product-merge.test.ts

import "../lib/load-env.ts";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { eq, sql } from "drizzle-orm";
import { ulid } from "ulid";
import { users } from "../db/schema/auth.ts";
import { productImages, productVariants, products } from "../db/schema/products.ts";
import { stockLocations } from "../db/schema/stock.ts";
import { db } from "../lib/db.ts";
import {
  createProduct,
  getProduct,
  mergeProducts,
  ProductError,
  type ProductErrorCode,
} from "./product-service.ts";

let userId: string;

async function wipe(): Promise<void> {
  await db.execute(sql`SET FOREIGN_KEY_CHECKS = 0`);
  for (const t of [
    "stock_locations",
    "stock_movements",
    "product_images",
    "product_variant_options",
    "product_price_tiers",
    "bundle_components",
    "product_variants",
    "product_alerts",
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
    name: "Merge Test",
  });
});

afterAll(async () => {
  await wipe();
  await db.delete(users).where(eq(users.id, userId));
});

beforeEach(wipe);

async function seedTarget() {
  return createProduct({
    name: "Bearing NKN",
    priceMode: "tax_exclusive",
    variants: [{ sku: `T-${ulid().slice(-6)}`, label: "6201 2RS", priceMinor: 50000 }],
    createdByUserId: userId,
  });
}

async function expectError(p: Promise<unknown>, code: ProductErrorCode): Promise<void> {
  const err = await p.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(ProductError);
  expect((err as ProductError).code).toBe(code);
}

describe("mergeProducts", () => {
  test("moves variants + images, applies labels, deletes sources", async () => {
    const target = await seedTarget();
    const source = await createProduct({
      name: "Bearing 6301 2RS NKN",
      priceMode: "tax_exclusive",
      variants: [{ sku: `S-${ulid().slice(-6)}`, label: "old label", priceMinor: 60000 }],
      createdByUserId: userId,
    });
    const sourceVariantId = source.variants[0]?.id as string;
    const imageId = ulid();
    await db.insert(productImages).values({
      id: imageId,
      productId: source.id,
      detailUrl: `https://blob.test/detail-${imageId}.webp`,
      thumbnailUrl: `https://blob.test/thumb-${imageId}.webp`,
      width: 100,
      height: 100,
      sortOrder: 0,
    });

    const merged = await mergeProducts(target.id, [source.id], [
      { variantId: sourceVariantId, label: "6301 2RS" },
    ]);

    // Target now holds both variants; the moved one carries its new label.
    expect(merged.variants).toHaveLength(2);
    const moved = merged.variants.find((v) => v.id === sourceVariantId);
    expect(moved?.productId).toBe(target.id);
    expect(moved?.label).toBe("6301 2RS");

    // The image followed the variant to the target product.
    const images = await db
      .select()
      .from(productImages)
      .where(eq(productImages.productId, target.id));
    expect(images.map((i) => i.id)).toContain(imageId);

    // The source product is gone; fetching it fails.
    await expectError(getProduct(source.id), "PRODUCT_NOT_FOUND");
  });

  test("stock rows travel with the moved variant", async () => {
    const target = await seedTarget();
    const source = await createProduct({
      name: "Bearing 6302 NKN",
      priceMode: "tax_exclusive",
      variants: [{ sku: `S-${ulid().slice(-6)}`, priceMinor: 1000 }],
      createdByUserId: userId,
    });
    const sourceVariantId = source.variants[0]?.id as string;
    await db.insert(stockLocations).values({
      id: ulid(),
      variantId: sourceVariantId,
      locationId: null,
      qty: 7,
    });

    await mergeProducts(target.id, [source.id]);

    const rows = await db
      .select()
      .from(stockLocations)
      .where(eq(stockLocations.variantId, sourceVariantId));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.qty).toBe(7);
    const variant = await db
      .select()
      .from(productVariants)
      .where(eq(productVariants.id, sourceVariantId));
    expect(variant[0]?.productId).toBe(target.id);
  });

  test("merges several sources at once", async () => {
    const target = await seedTarget();
    const s1 = await createProduct({
      name: "Bearing 6301 NKN",
      priceMode: "tax_exclusive",
      variants: [{ priceMinor: 100 }],
      createdByUserId: userId,
    });
    const s2 = await createProduct({
      name: "Bearing 6302 NKN",
      priceMode: "tax_exclusive",
      variants: [{ priceMinor: 200 }],
      createdByUserId: userId,
    });

    const merged = await mergeProducts(target.id, [s1.id, s2.id]);
    expect(merged.variants).toHaveLength(3);
    const remaining = await db.select({ id: products.id }).from(products);
    expect(remaining.map((r) => r.id)).toEqual([target.id]);
  });

  test("rejects kind mismatch", async () => {
    const target = await seedTarget();
    const service = await createProduct({
      name: "Install service",
      kind: "service",
      priceMode: "tax_exclusive",
      variants: [{ priceMinor: 100 }],
      createdByUserId: userId,
    });
    await expectError(mergeProducts(target.id, [service.id]), "INVALID_INPUT");
  });

  test("rejects priceMode mismatch", async () => {
    const target = await seedTarget();
    const other = await createProduct({
      name: "Bearing 6303 NKN",
      priceMode: "tax_inclusive",
      variants: [{ priceMinor: 100 }],
      createdByUserId: userId,
    });
    await expectError(mergeProducts(target.id, [other.id]), "INVALID_INPUT");
  });

  test("rejects empty sources and self-merge", async () => {
    const target = await seedTarget();
    await expectError(mergeProducts(target.id, []), "INVALID_INPUT");
    await expectError(mergeProducts(target.id, [target.id]), "INVALID_INPUT");
  });

  test("rejects labels for variants outside the sources", async () => {
    const target = await seedTarget();
    const source = await createProduct({
      name: "Bearing 6304 NKN",
      priceMode: "tax_exclusive",
      variants: [{ priceMinor: 100 }],
      createdByUserId: userId,
    });
    const targetVariantId = target.variants[0]?.id;
    expect(targetVariantId).toBeDefined();
    await expectError(
      mergeProducts(target.id, [source.id], [
        { variantId: targetVariantId as string, label: "sneaky" },
      ]),
      "INVALID_INPUT",
    );
  });

  test("rejects bundle and open_price products", async () => {
    const bundleTarget = await createProduct({
      name: "Kit",
      kind: "bundle",
      priceMode: "tax_exclusive",
      variants: [{ priceMinor: 100 }],
      createdByUserId: userId,
    });
    const plain = await createProduct({
      name: "Bearing 6305 NKN",
      priceMode: "tax_exclusive",
      variants: [{ priceMinor: 100 }],
      createdByUserId: userId,
    });
    await expectError(mergeProducts(bundleTarget.id, [plain.id]), "INVALID_INPUT");
    await expectError(mergeProducts(plain.id, [bundleTarget.id]), "INVALID_INPUT");
  });
});
