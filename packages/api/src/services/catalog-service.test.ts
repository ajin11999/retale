// Integration tests for catalog-service — masking, the snapshot builder, the
// per-product settings, and the publish log. Runs against the local Docker
// MariaDB (DATABASE_URL) and WIPEs the product / catalog tables between
// tests, so point it only at a dev database.
//
//   bun test src/services/catalog-service.test.ts

import "../lib/load-env.ts";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { eq, sql } from "drizzle-orm";
import { ulid } from "ulid";
import { users } from "../db/schema/auth.ts";
import { catalogPublishes } from "../db/schema/catalog.ts";
import { products, productVariants } from "../db/schema/products.ts";
import { db } from "../lib/db.ts";
import {
  buildCatalogSnapshot,
  CatalogError,
  type CatalogErrorCode,
  listCatalogPublishes,
  maskPricePeek,
  maskStockPeek,
  publishCatalog,
  purgeOldCatalogPublishes,
  setProductCatalogSettings,
  setProductsOnlineVisible,
} from "./catalog-service.ts";

let userId: string;

async function wipe(): Promise<void> {
  await db.execute(sql`SET FOREIGN_KEY_CHECKS = 0`);
  for (const t of [
    "catalog_publishes",
    "product_variants",
    "products",
    "product_categories",
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

/** Seed a product + one variant with catalog settings. Returns the product id. */
async function seedProduct(opts?: {
  publicName?: string;
  onlineVisible?: boolean;
  priceMode?: "exclude" | "peek" | "show";
  stockMode?: "show_real" | "peek" | "hide";
  priceMinor?: number;
  totalQty?: number;
  archived?: boolean;
}): Promise<string> {
  const productId = ulid();
  const variantId = ulid();
  await db.insert(products).values({
    id: productId,
    name: "Internal Name",
    publicName: opts?.publicName ?? null,
    priceMode: "tax_exclusive",
    onlineVisible: opts?.onlineVisible ?? false,
    onlinePriceMode: opts?.priceMode ?? "exclude",
    onlineStockMode: opts?.stockMode ?? "hide",
    archivedAt: opts?.archived ? new Date() : null,
  });
  await db.insert(productVariants).values({
    id: variantId,
    productId,
    sku: `SKU-${variantId}`,
    priceMinor: opts?.priceMinor ?? 250000,
    totalQty: opts?.totalQty ?? 0,
  });
  return productId;
}

async function expectError(
  p: Promise<unknown>,
  code: CatalogErrorCode,
): Promise<void> {
  const err = await p.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(CatalogError);
  expect((err as CatalogError).code).toBe(code);
}

describe("masking", () => {
  test("maskPricePeek keeps the leading digit and groups thousands", () => {
    expect(maskPricePeek(250000)).toBe("2xx.xxx");
    expect(maskPricePeek(1500)).toBe("1.xxx");
    expect(maskPricePeek(9)).toBe("9");
  });

  test("maskStockPeek fuzzes a count into a band", () => {
    expect(maskStockPeek(0)).toBe("potentially sold out");
    expect(maskStockPeek(3)).toBe("< 10");
    expect(maskStockPeek(25)).toBe("< 50");
    expect(maskStockPeek(200)).toBe("50+");
  });
});

describe("buildCatalogSnapshot", () => {
  test("includes only visible, non-archived products", async () => {
    const visible = await seedProduct({ onlineVisible: true });
    await seedProduct({ onlineVisible: false });
    await seedProduct({ onlineVisible: true, archived: true });

    const snap = await buildCatalogSnapshot();
    expect(snap.products.map((p) => p.id)).toEqual([visible]);
    expect(snap.version).toBeTruthy();
  });

  test("uses publicName when set", async () => {
    await seedProduct({ onlineVisible: true, publicName: "Public Name" });
    const snap = await buildCatalogSnapshot();
    expect(snap.products[0]?.name).toBe("Public Name");
  });

  test("price mode show exposes the real price, peek masks it, exclude omits", async () => {
    await seedProduct({ onlineVisible: true, priceMode: "show", priceMinor: 250000 });
    let v = (await buildCatalogSnapshot()).products[0]?.variants[0];
    expect(v?.priceMinor).toBe(250000);
    expect(v?.pricePeek).toBeUndefined();

    await wipe();
    await seedProduct({ onlineVisible: true, priceMode: "peek", priceMinor: 250000 });
    v = (await buildCatalogSnapshot()).products[0]?.variants[0];
    expect(v?.priceMinor).toBeUndefined();
    expect(v?.pricePeek).toBe("2xx.xxx");

    await wipe();
    await seedProduct({ onlineVisible: true, priceMode: "exclude", priceMinor: 250000 });
    v = (await buildCatalogSnapshot()).products[0]?.variants[0];
    expect(v?.priceMinor).toBeUndefined();
    expect(v?.pricePeek).toBeUndefined();
  });

  test("stock mode show_real exposes qty, peek fuzzes it, hide omits", async () => {
    await seedProduct({ onlineVisible: true, stockMode: "show_real", totalQty: 7 });
    let v = (await buildCatalogSnapshot()).products[0]?.variants[0];
    expect(v?.stockQty).toBe(7);
    expect(v?.stockPeek).toBeUndefined();

    await wipe();
    await seedProduct({ onlineVisible: true, stockMode: "peek", totalQty: 7 });
    v = (await buildCatalogSnapshot()).products[0]?.variants[0];
    expect(v?.stockQty).toBeUndefined();
    expect(v?.stockPeek).toBe("< 10");

    await wipe();
    await seedProduct({ onlineVisible: true, stockMode: "hide", totalQty: 7 });
    v = (await buildCatalogSnapshot()).products[0]?.variants[0];
    expect(v?.stockQty).toBeUndefined();
    expect(v?.stockPeek).toBeUndefined();
  });
});

describe("settings", () => {
  test("setProductCatalogSettings patches only the given fields", async () => {
    const id = await seedProduct({ onlineVisible: false, priceMode: "exclude" });
    const out = await setProductCatalogSettings(id, {
      onlineVisible: true,
      onlinePriceMode: "show",
    });
    expect(out.onlineVisible).toBe(true);
    expect(out.onlinePriceMode).toBe("show");
    expect(out.onlineStockMode).toBe("hide"); // untouched

    await expectError(
      setProductCatalogSettings(ulid(), { onlineVisible: true }),
      "PRODUCT_NOT_FOUND",
    );
  });

  test("setProductsOnlineVisible flips many products at once", async () => {
    const a = await seedProduct({ onlineVisible: false });
    const b = await seedProduct({ onlineVisible: false });
    const n = await setProductsOnlineVisible([a, b], true);
    expect(n).toBe(2);

    const snap = await buildCatalogSnapshot();
    expect(snap.products.map((p) => p.id).sort()).toEqual([a, b].sort());
    expect(await setProductsOnlineVisible([], true)).toBe(0);
  });
});

describe("publishCatalog", () => {
  test("logs an error row when the push target is not configured", async () => {
    // BLOB_READ_WRITE_TOKEN is unset in the test env.
    await seedProduct({ onlineVisible: true });
    await expectError(publishCatalog("manual", userId), "NOT_CONFIGURED");

    const log = await listCatalogPublishes();
    expect(log).toHaveLength(1);
    expect(log[0]?.status).toBe("error");
    expect(log[0]?.productCount).toBe(1);
    expect(log[0]?.trigger).toBe("manual");
  });
});

describe("purgeOldCatalogPublishes", () => {
  /** Insert `n` publish-log rows with staggered createdAt (newest last). */
  async function seedPublishes(n: number): Promise<void> {
    const rows = Array.from({ length: n }, (_, i) => ({
      id: ulid(),
      trigger: "scheduled" as const,
      status: "success" as const,
      productCount: 0,
      createdAt: new Date(Date.now() - (n - i) * 86_400_000),
    }));
    await db.insert(catalogPublishes).values(rows);
  }

  test("keeps the most recent `keep` rows and removes the rest", async () => {
    await seedPublishes(5);
    expect(await purgeOldCatalogPublishes(3)).toBe(2);

    const remaining = await listCatalogPublishes();
    expect(remaining).toHaveLength(3);
    // The survivors are the three newest, still newest-first.
    expect(remaining[0]!.createdAt >= remaining[2]!.createdAt).toBe(true);
  });

  test("removes nothing while at or under the cap", async () => {
    await seedPublishes(3);
    expect(await purgeOldCatalogPublishes(3)).toBe(0);
    expect(await listCatalogPublishes()).toHaveLength(3);
  });
});
