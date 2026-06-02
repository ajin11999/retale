// Seed the open-price fastener products — loose hardware sold by a guessed
// lump at the register (no per-size SKU, no stock tracking). Each entry below
// becomes one quick-tile button in the POS; `costRatioBps` derives the cost
// snapshot from the entered price (6000 = cost is 60% of price). Idempotent:
// skips any product whose name already exists.
//
//   bun run dev:seed-open-price
//
// EDIT the ITEMS list to your real fastener categories and cost ratios.

import { eq } from "drizzle-orm";
import {
  productCategories,
  products as productsTable,
} from "../src/db/schema/products.ts";
import { db, pool } from "../src/lib/db.ts";
import * as svc from "../src/services/product-service.ts";

/** Parent category these open-price products live under. */
const CATEGORY = "Fasteners";

interface OpenPriceItem {
  /** Shown on the POS quick-tile and on receipts. */
  name: string;
  /** Cost as a fraction of the entered price, in basis points (6000 = 60%). */
  costRatioBps: number;
}

// --- EDIT ME: your real categories + ratios -------------------------------
const ITEMS: OpenPriceItem[] = [
  { name: "Bolts — Zinc", costRatioBps: 6000 },
  { name: "Bolts — Stainless", costRatioBps: 7000 },
  { name: "Nuts", costRatioBps: 6000 },
  { name: "Washers", costRatioBps: 5500 },
  { name: "Screws", costRatioBps: 6000 },
];
// --------------------------------------------------------------------------

/** Find a category by name, or create it. */
async function ensureCategory(name: string): Promise<string> {
  const existing = await db
    .select()
    .from(productCategories)
    .where(eq(productCategories.name, name))
    .limit(1);
  if (existing[0]) return existing[0].id;
  const created = await svc.createCategory({ name });
  return created.id;
}

try {
  const creator = await db.query.users.findFirst();
  if (!creator) {
    console.error("No users exist. Bootstrap a root user first.");
    process.exit(1);
  }

  const categoryId = await ensureCategory(CATEGORY);

  let created = 0;
  let skipped = 0;
  for (const item of ITEMS) {
    const exists = await db
      .select()
      .from(productsTable)
      .where(eq(productsTable.name, item.name))
      .limit(1);
    if (exists.length) {
      skipped++;
      continue;
    }
    await svc.createProduct({
      name: item.name,
      kind: "open_price",
      categoryId,
      // A guessed lump is naturally tax-inclusive; set taxRateBps if these
      // should carry an explicit VAT breakdown.
      priceMode: "tax_inclusive",
      taxRateBps: 0,
      costRatioBps: item.costRatioBps,
      createdByUserId: creator.id,
      // No variants — createProduct auto-adds the single hidden placeholder.
      variants: [],
    });
    created++;
  }
  console.log(
    `Open-price seed done: ${created} created, ${skipped} already present, ` +
      `under category "${CATEGORY}".`,
  );
} finally {
  await pool.end();
}
