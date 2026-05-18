// Integration tests for vendor-variant-code-service — the vendor-part-number
// ↔ variant mapping and its two lookups. Runs against the local Docker
// MariaDB (DATABASE_URL) and WIPEs the mapping / product / vendor tables
// between tests, so point it only at a dev database.
//
//   bun test src/services/vendor-variant-code-service.test.ts

import "../lib/load-env.ts";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { eq, sql } from "drizzle-orm";
import { ulid } from "ulid";
import { users } from "../db/schema/auth.ts";
import { products, productVariants } from "../db/schema/products.ts";
import { vendors } from "../db/schema/vendors.ts";
import { db } from "../lib/db.ts";
import {
  deleteVendorVariantCode,
  listCodesForVariant,
  preferredVendorByVariant,
  resolveVendorCode,
  setVendorVariantCode,
  VendorVariantCodeError,
  type VendorVariantCodeErrorCode,
} from "./vendor-variant-code-service.ts";

let userId: string;

async function wipe(): Promise<void> {
  await db.execute(sql`SET FOREIGN_KEY_CHECKS = 0`);
  for (const t of [
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
    name: "VVC Test",
  });
});

afterAll(async () => {
  await wipe();
  await db.delete(users).where(eq(users.id, userId));
});

beforeEach(wipe);

async function seedVendor(name = "Acme"): Promise<string> {
  const id = ulid();
  await db.insert(vendors).values({ id, name });
  return id;
}

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

async function expectError(
  p: Promise<unknown>,
  code: VendorVariantCodeErrorCode,
): Promise<void> {
  const err = await p.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(VendorVariantCodeError);
  expect((err as VendorVariantCodeError).code).toBe(code);
}

describe("setVendorVariantCode", () => {
  test("inserts then upserts the same vendor/variant pair", async () => {
    const vendorId = await seedVendor();
    const variantId = await seedVariant();

    const first = await setVendorVariantCode({ vendorId, variantId, code: "VC-1" });
    expect(first.code).toBe("VC-1");
    expect(first.isPreferred).toBe(false);

    const second = await setVendorVariantCode({ vendorId, variantId, code: "VC-2" });
    expect(second.id).toBe(first.id); // same row, not a duplicate
    expect(second.code).toBe("VC-2");

    expect(await listCodesForVariant(variantId)).toHaveLength(1);
  });

  test("marking a mapping preferred demotes the variant's other vendors", async () => {
    const variantId = await seedVariant();
    const vendorA = await seedVendor("A");
    const vendorB = await seedVendor("B");

    const a = await setVendorVariantCode({
      vendorId: vendorA,
      variantId,
      code: "A-1",
      isPreferred: true,
    });
    expect(a.isPreferred).toBe(true);

    // B becomes preferred — A must be demoted.
    await setVendorVariantCode({
      vendorId: vendorB,
      variantId,
      code: "B-1",
      isPreferred: true,
    });

    const codes = await listCodesForVariant(variantId);
    const preferred = codes.filter((c) => c.isPreferred);
    expect(preferred).toHaveLength(1);
    expect(preferred[0]?.vendorId).toBe(vendorB);
  });

  test("rejects a blank code, missing vendor, missing variant", async () => {
    const vendorId = await seedVendor();
    const variantId = await seedVariant();
    await expectError(
      setVendorVariantCode({ vendorId, variantId, code: "  " }),
      "INVALID_INPUT",
    );
    await expectError(
      setVendorVariantCode({ vendorId: ulid(), variantId, code: "X" }),
      "VENDOR_NOT_FOUND",
    );
    await expectError(
      setVendorVariantCode({ vendorId, variantId: ulid(), code: "X" }),
      "VARIANT_NOT_FOUND",
    );
  });
});

describe("deleteVendorVariantCode", () => {
  test("removes a mapping and rejects an unknown id", async () => {
    const vendorId = await seedVendor();
    const variantId = await seedVariant();
    const row = await setVendorVariantCode({ vendorId, variantId, code: "VC-1" });

    await deleteVendorVariantCode(row.id);
    expect(await listCodesForVariant(variantId)).toHaveLength(0);

    await expectError(deleteVendorVariantCode(ulid()), "CODE_NOT_FOUND");
  });
});

describe("lookups", () => {
  test("resolveVendorCode maps a vendor's code back to the variant", async () => {
    const vendorId = await seedVendor();
    const variantId = await seedVariant();
    await setVendorVariantCode({ vendorId, variantId, code: "PART-99" });

    expect(await resolveVendorCode(vendorId, "PART-99")).toEqual([variantId]);
    expect(await resolveVendorCode(vendorId, "  PART-99 ")).toEqual([variantId]);
    expect(await resolveVendorCode(vendorId, "nope")).toEqual([]);
    // A different vendor's code does not resolve.
    expect(await resolveVendorCode(ulid(), "PART-99")).toEqual([]);
  });

  test("preferredVendorByVariant returns only the preferred mappings", async () => {
    const variantId = await seedVariant();
    const otherVariantId = await seedVariant();
    const vendorId = await seedVendor();
    await setVendorVariantCode({ vendorId, variantId, code: "P-1", isPreferred: true });
    await setVendorVariantCode({ vendorId, variantId: otherVariantId, code: "P-2" });

    const map = await preferredVendorByVariant([variantId, otherVariantId]);
    expect(map.get(variantId)).toBe(vendorId);
    expect(map.has(otherVariantId)).toBe(false); // not preferred
    expect((await preferredVendorByVariant([])).size).toBe(0);
  });
});
