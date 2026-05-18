// Integration tests for business settings and the purchase-order message
// renderer. Runs against the local Docker MariaDB (DATABASE_URL) and WIPEs
// the business / purchase / product tables between tests.
//
//   bun test src/services/purchase-message-service.test.ts

import "../lib/load-env.ts";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { eq, sql } from "drizzle-orm";
import { ulid } from "ulid";
import { users } from "../db/schema/auth.ts";
import { products, productVariants } from "../db/schema/products.ts";
import { vendors } from "../db/schema/vendors.ts";
import { db } from "../lib/db.ts";
import { getBusinessSettings, updateBusinessSettings } from "./business-service.ts";
import { renderPurchaseOrderMessage } from "./purchase-message-service.ts";
import {
  createItem,
  createPurchase,
  createSection,
  PurchaseError,
} from "./purchase-service.ts";
import { setVendorVariantCode } from "./vendor-variant-code-service.ts";

let userId: string;

async function wipe(): Promise<void> {
  await db.execute(sql`SET FOREIGN_KEY_CHECKS = 0`);
  for (const t of [
    "business_settings",
    "vendor_variant_codes",
    "purchase_items",
    "purchase_sections",
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
    name: "Message Test",
  });
});

afterAll(async () => {
  await wipe();
  await db.delete(users).where(eq(users.id, userId));
});

beforeEach(wipe);

async function seedVendor(): Promise<string> {
  const id = ulid();
  await db.insert(vendors).values({ id, name: "Acme Supply" });
  return id;
}

/** Create a product + one variant. Returns the variant id. */
async function seedVariant(productName: string, label?: string): Promise<string> {
  const productId = ulid();
  const variantId = ulid();
  await db.insert(products).values({
    id: productId,
    name: productName,
    priceMode: "tax_exclusive",
  });
  await db.insert(productVariants).values({
    id: variantId,
    productId,
    sku: `SKU-${variantId}`,
    label: label ?? null,
    priceMinor: 1000,
  });
  return variantId;
}

describe("business settings", () => {
  test("returns blank defaults before anything is saved", async () => {
    const s = await getBusinessSettings();
    expect(s.name).toBe("");
    expect(s.poGreeting).toBeNull();
  });

  test("upserts and patches only the given fields", async () => {
    await updateBusinessSettings({ name: "Frans Retail", poGreeting: "Hi vendor," });
    let s = await getBusinessSettings();
    expect(s.name).toBe("Frans Retail");
    expect(s.poGreeting).toBe("Hi vendor,");

    await updateBusinessSettings({ phone: "+62811" });
    s = await getBusinessSettings();
    expect(s.name).toBe("Frans Retail"); // untouched
    expect(s.phone).toBe("+62811");
  });
});

describe("renderPurchaseOrderMessage", () => {
  test("renders header, lines and total; wraps with greeting and footer", async () => {
    await updateBusinessSettings({
      name: "Frans Retail",
      poGreeting: "Dear supplier,",
      poFooter: "Thank you.",
    });
    const vendorId = await seedVendor();
    const variantId = await seedVariant("M6 Bolt");
    const purchase = await createPurchase({
      vendorId,
      date: "2026-05-18",
      createdByUserId: userId,
    });
    await createItem({
      purchaseId: purchase.id,
      variantId,
      qtyOrdered: 50,
      unitCostMinor: 2000,
    });

    const { subject, body } = await renderPurchaseOrderMessage(purchase.id);
    expect(subject).toBe("Purchase Order from Frans Retail");
    expect(body.startsWith("Dear supplier,")).toBe(true);
    expect(body.endsWith("Thank you.")).toBe(true);
    expect(body).toContain("From: Frans Retail");
    expect(body).toContain("To: Acme Supply");
    expect(body).toContain("M6 Bolt — 50 @ Rp 2.000 = Rp 100.000");
    expect(body).toContain("Total: Rp 100.000");
  });

  test("uses the vendor's code when mapped, the product name when not", async () => {
    const vendorId = await seedVendor();
    const mapped = await seedVariant("M6 Bolt");
    const unmapped = await seedVariant("M8 Nut");
    const purchase = await createPurchase({
      vendorId,
      date: "2026-05-18",
      createdByUserId: userId,
    });
    await createItem({ purchaseId: purchase.id, variantId: mapped, qtyOrdered: 1, unitCostMinor: 100 });
    await createItem({ purchaseId: purchase.id, variantId: unmapped, qtyOrdered: 1, unitCostMinor: 100 });
    await setVendorVariantCode({ vendorId, variantId: mapped, code: "ACME-BOLT-6" });

    const { body } = await renderPurchaseOrderMessage(purchase.id);
    expect(body).toContain("ACME-BOLT-6"); // mapped → vendor code
    expect(body).toContain("M8 Nut"); // unmapped → our product name
    expect(body).not.toContain("M6 Bolt"); // the mapped line shows the code, not our name
  });

  test("renders a non-stock line by its description, grouped by section", async () => {
    const purchase = await createPurchase({
      snapshotVendorName: "Ad-hoc Supplier",
      date: "2026-05-18",
      createdByUserId: userId,
    });
    const section = await createSection({ purchaseId: purchase.id, name: "Consumables" });
    await createItem({
      purchaseId: purchase.id,
      sectionId: section.id,
      variantId: null,
      description: "Shop rags",
      qtyOrdered: 5,
      unitCostMinor: 1500,
    });

    const { body } = await renderPurchaseOrderMessage(purchase.id);
    expect(body).toContain("Consumables");
    expect(body).toContain("Shop rags — 5 @ Rp 1.500 = Rp 7.500");
  });

  test("rejects an unknown purchase", async () => {
    const err = await renderPurchaseOrderMessage(ulid()).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(PurchaseError);
    expect((err as PurchaseError).code).toBe("PURCHASE_NOT_FOUND");
  });
});
