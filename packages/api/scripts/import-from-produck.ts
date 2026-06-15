// One-shot ProDuck → Retale importer. Reads ProDuck's Products and Vendors and
// rebuilds Retale's product + vendor masters from scratch. Per
// docs/design-decisions.md:
//
//   - Destructive / wipe-and-restore. NOT idempotent. Run once, on a fresh
//     Retale install. Re-running wipes and re-imports.
//   - Products and vendors only — no users, roles, categories, locations,
//     stock, customers, POS, or any historical orders/purchases/landed costs.
//   - Imported products carry no category (categoryId = null) and no stock
//     (totalQty = 0, no stock ledger).
//   - ProDuck bigint IDs are discarded; Retale assigns fresh ULIDs.
//
// Usage:
//   PRODUCK_DATABASE_URL=mysql://user:pass@host:3306/produck \
//     bun run packages/api/scripts/import-from-produck.ts
//
// `DATABASE_URL` (the Retale target) is read from the usual environment.

import "../src/lib/load-env.ts";
import { sql } from "drizzle-orm";
import mysql from "mysql2/promise";
import { ulid } from "ulid";
import { productVariants, products, vendors } from "../src/db/schema/index.ts";
import { db, pool } from "../src/lib/db.ts";
import { roundMoney } from "../src/lib/money.ts";

// --- Configuration -------------------------------------------------------

/** Insert batch size — keeps MariaDB packet sizes comfortable. */
const CHUNK = 500;

// --- Helpers -------------------------------------------------------------

/** A drizzle transaction handle. */
type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/** A ProDuck money decimal (string from the driver) → a 2-decimal amount. */
function toMinor(value: unknown): number {
  return roundMoney(Number(value ?? 0));
}

/** Empty/whitespace strings become null; otherwise the trimmed string. */
function nullable(value: unknown): string | null {
  const s = typeof value === "string" ? value.trim() : value == null ? "" : String(value);
  return s.length ? s : null;
}

/** Insert rows in chunks; a no-op for an empty array. */
async function insertAll<T>(
  tx: Tx,
  table: Parameters<Tx["insert"]>[0],
  rows: T[],
): Promise<void> {
  for (let i = 0; i < rows.length; i += CHUNK) {
    await tx.insert(table).values(rows.slice(i, i + CHUNK) as never);
  }
}

interface Counts {
  [table: string]: number;
}

// --- Main ----------------------------------------------------------------

async function main(): Promise<void> {
  const produckUrl = process.env.PRODUCK_DATABASE_URL;
  if (!produckUrl) {
    throw new Error("Missing required environment variable: PRODUCK_DATABASE_URL");
  }

  console.log("Connecting to ProDuck source…");
  const source = mysql.createPool(produckUrl);

  /** Read a ProDuck table, optionally filtering a soft-delete flag. */
  async function read(table: string, notDeletedColumn?: string): Promise<Record<string, unknown>[]> {
    const where = notDeletedColumn ? ` WHERE \`${notDeletedColumn}\` = 0` : "";
    const [rows] = await source.query(`SELECT * FROM \`${table}\`${where}`);
    return rows as Record<string, unknown>[];
  }

  console.log("Reading ProDuck Products and Vendors…");
  const srcProducts = await read("Products", "Deleted");
  const srcVendors = await read("Vendors", "IsDeleted");
  await source.end();

  const counts: Counts = {};

  await db.transaction(async (tx) => {
    // --- Wipe ------------------------------------------------------------
    // Only the product and vendor subtrees. Intended for a fresh install,
    // so transactional tables that reference these (orders, purchases, …)
    // are assumed empty; FK checks are disabled for the deletes regardless.
    console.log("Wiping Retale product + vendor tables…");
    await tx.execute(sql`SET FOREIGN_KEY_CHECKS = 0`);
    const wipeTables = [
      "vendor_variant_codes",
      "stock_movements", "stock_locations",
      "product_price_tiers", "product_variant_options", "product_variants",
      "products",
      "vendor_ledger", "vendors",
    ];
    for (const t of wipeTables) {
      await tx.execute(sql.raw(`DELETE FROM \`${t}\``));
    }

    // --- Products + variants --------------------------------------------
    // ProDuck has no variants — each product becomes one product + one
    // variant. No category, no stock.
    const productRows: (typeof products.$inferInsert)[] = [];
    const variantRows: (typeof productVariants.$inferInsert)[] = [];
    for (const p of srcProducts) {
      const productId = ulid();
      const variantId = ulid();
      productRows.push({
        id: productId,
        name: String(p.Name),
        kind: "physical",
        categoryId: null,
        taxRateBps: 0,
        priceMode: "tax_exclusive",
      });
      variantRows.push({
        id: variantId,
        productId,
        sku: `SKU-${variantId}`,
        barcode: nullable(p.Barcode),
        unit: "piece",
        priceMinor: toMinor(p.Price),
        costMinor: toMinor(p.Cost),
        totalQty: 0,
      });
    }
    await insertAll(tx, products, productRows);
    await insertAll(tx, productVariants, variantRows);
    counts.products = productRows.length;
    counts.product_variants = variantRows.length;

    // --- Vendors ---------------------------------------------------------
    const vendorRows: (typeof vendors.$inferInsert)[] = srcVendors.map((v) => ({
      id: ulid(),
      name: String(v.Name),
      phone: nullable(v.Contact),
      notes: nullable(v.Description),
    }));
    await insertAll(tx, vendors, vendorRows);
    counts.vendors = vendorRows.length;

    await tx.execute(sql`SET FOREIGN_KEY_CHECKS = 1`);
  });

  // --- Report ------------------------------------------------------------
  console.log("\nImport complete. Rows written:");
  for (const [table, n] of Object.entries(counts)) {
    console.log(`  ${table.padEnd(22)} ${n}`);
  }
}

main()
  .then(() => pool.end())
  .then(() => process.exit(0))
  .catch(async (err) => {
    console.error("\nImport failed — no changes committed.");
    console.error(err);
    await pool.end();
    process.exit(1);
  });
