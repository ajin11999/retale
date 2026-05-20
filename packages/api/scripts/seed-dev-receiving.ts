// DEV ONLY — seed enough state to exercise the receiving workflow:
// a stock location, a vendor, barcodes on a handful of variants, and an
// open purchase with line items against them. Idempotent: re-running it
// reuses the same vendor / location and creates a fresh purchase only if
// none from this seed is still open.
//
//   bun run dev:seed-receiving

import { and, eq } from "drizzle-orm";
import { vendors as vendorsTable } from "../src/db/schema/vendors.ts";
import { locations as locationsTable } from "../src/db/schema/locations.ts";
import { productVariants } from "../src/db/schema/products.ts";
import { purchases as purchasesTable } from "../src/db/schema/purchases.ts";
import { db, pool } from "../src/lib/db.ts";
import * as purchaseSvc from "../src/services/purchase-service.ts";
import * as locationSvc from "../src/services/location-service.ts";
import * as vendorSvc from "../src/services/vendor-service.ts";

const VENDOR_NAME = "Acme Supply (dev)";
const LOCATION_NAME = "Main warehouse (dev)";
const PURCHASE_MEMO = "dev:seed-receiving";

try {
  const creator = await db.query.users.findFirst();
  if (!creator) {
    console.error("No users exist. Run dev:seed-user first.");
    process.exit(1);
  }

  // --- Location ----------------------------------------------------------
  let location = await db.query.locations.findFirst({
    where: eq(locationsTable.name, LOCATION_NAME),
  });
  if (!location) {
    location = await locationSvc.createLocation({
      name: LOCATION_NAME,
      createdByUserId: creator.id,
    });
    console.log(`Created location "${LOCATION_NAME}".`);
  }

  // --- Vendor ------------------------------------------------------------
  let vendor = await db.query.vendors.findFirst({
    where: eq(vendorsTable.name, VENDOR_NAME),
  });
  if (!vendor) {
    vendor = await vendorSvc.createVendor({
      name: VENDOR_NAME,
      phone: "+62 555 0100",
      email: "acme@example.invalid",
      leadTimeDays: 3,
      createdByUserId: creator.id,
    });
    console.log(`Created vendor "${VENDOR_NAME}".`);
  }

  // --- Variants + barcodes ----------------------------------------------
  // Five variants are enough to see scan / partial / complete states. Assign
  // a deterministic barcode where none exists so the scan input has hits.
  const variants = await db
    .select()
    .from(productVariants)
    .limit(5);
  if (variants.length === 0) {
    console.error("No product variants exist. Run dev:seed-products first.");
    process.exit(1);
  }
  for (const [i, v] of variants.entries()) {
    if (!v.barcode) {
      const barcode = `DEV${String(i + 1).padStart(4, "0")}`;
      await db
        .update(productVariants)
        .set({ barcode })
        .where(eq(productVariants.id, v.id));
      console.log(`Set barcode ${barcode} on ${v.sku}.`);
    }
  }

  // --- Purchase ----------------------------------------------------------
  // Skip if a seed-tagged open purchase is already around — keeps the
  // script idempotent during repeat runs.
  const existing = await db.query.purchases.findFirst({
    where: and(
      eq(purchasesTable.vendorId, vendor.id),
      eq(purchasesTable.memo, PURCHASE_MEMO),
      eq(purchasesTable.status, "open"),
    ),
  });
  if (existing) {
    console.log(
      `Open seed purchase already exists: /purchases/${existing.id}`,
    );
    process.exit(0);
  }

  const today = new Date().toISOString().slice(0, 10);
  const purchase = await purchaseSvc.createPurchase({
    vendorId: vendor.id,
    date: today,
    memo: PURCHASE_MEMO,
    createdByUserId: creator.id,
  });

  let lineCount = 0;
  for (const [i, v] of variants.entries()) {
    // Round-ish, varied quantities; cost copies the variant cost so the
    // landed-cost math has something sensible to anchor on.
    const qty = 5 + i * 5;
    await purchaseSvc.createItem({
      purchaseId: purchase.id,
      variantId: v.id,
      qtyOrdered: qty,
      unitCostMinor: v.costMinor || 1000,
      sortOrder: i + 1,
    });
    lineCount++;
  }

  console.log(
    `\nSeeded purchase /purchases/${purchase.id} — ${lineCount} lines, vendor "${vendor.name}", target location "${location.name}".`,
  );
  console.log(
    `Receive it at:  /purchases/${purchase.id}/receive`,
  );
} finally {
  await pool.end();
}
