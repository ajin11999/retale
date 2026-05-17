// One-shot ProDuck → Retale importer. Reads ProDuck's master tables and
// rebuilds Retale's masters from scratch. Per docs/design-decisions.md:
//
//   - Destructive / wipe-and-restore. NOT idempotent. Run once, on a fresh
//     Retale install. Re-running wipes and re-imports.
//   - Master tables only — no historical orders, purchases, or landed costs.
//   - ProDuck bigint IDs are discarded; Retale assigns fresh ULIDs and the
//     old→new mapping is held in memory so foreign keys can be rewritten.
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
import {
  customers,
  locations,
  pointsOfSale,
  productCategories,
  productVariants,
  products,
  rolePermissions,
  roles,
  stockLocations,
  stockMovements,
  userRoles,
  users,
  vendors,
} from "../src/db/schema/index.ts";
import { db, pool } from "../src/lib/db.ts";

// --- Configuration -------------------------------------------------------

/**
 * ProDuck claim whose holders become Retale root users (`users.isRoot`).
 * Match is case-insensitive. Edit this if your ProDuck uses a different name.
 */
const ROOT_CLAIM_NAME = "root";

/** Insert batch size — keeps MariaDB packet sizes comfortable. */
const CHUNK = 500;

// --- Helpers -------------------------------------------------------------

/** A drizzle transaction handle. */
type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/** Round a ProDuck decimal (string from the driver) to integer minor units. */
function toMinor(value: unknown): number {
  return Math.round(Number(value ?? 0));
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

  console.log("Reading ProDuck master tables…");
  const srcClaims = await read("Claims");
  const srcUsers = await read("Users", "IsDeleted");
  const srcClaimUser = await read("ClaimUser");
  const srcCategories = await read("ProductCategories");
  const srcProducts = await read("Products", "Deleted");
  const srcLocations = await read("Locations");
  const srcStock = await read("StockLocation");
  const srcCustomers = await read("Customers", "IsDeleted");
  const srcVendors = await read("Vendors", "IsDeleted");
  const srcPos = await read("PointOfSale", "IsDeleted");
  await source.end();

  const counts: Counts = {};
  const warnings: string[] = [];

  await db.transaction(async (tx) => {
    // --- Wipe ------------------------------------------------------------
    // Template roles (and their permissions) survive; everything else goes.
    console.log("Wiping Retale tables…");
    await tx.execute(sql`SET FOREIGN_KEY_CHECKS = 0`);
    const wipeTables = [
      "sessions", "user_roles", "order_payments", "order_items", "orders",
      "customer_ledger", "customer_prices", "customers",
      "vendor_ledger", "vendors",
      "purchase_delivery_items", "purchase_deliveries", "purchase_items",
      "purchase_sends", "purchase_sections", "purchases",
      "tracking_account_ledger", "tracking_accounts",
      "stock_movements", "stock_locations",
      "product_price_tiers", "product_variant_options", "product_variants",
      "products", "product_categories",
      "pos_sessions", "points_of_sale", "locations",
      "users",
    ];
    for (const t of wipeTables) {
      await tx.execute(sql.raw(`DELETE FROM \`${t}\``));
    }
    // Non-template roles only; role_permissions cascade via their roleId FK.
    await tx.execute(
      sql`DELETE FROM role_permissions WHERE role_id IN (SELECT id FROM roles WHERE is_template = 0)`,
    );
    await tx.execute(sql`DELETE FROM roles WHERE is_template = 0`);

    // --- Roles (from ProDuck claims) -------------------------------------
    // Existing template roles are reused on a name collision.
    const existing = await tx.select({ id: roles.id, name: roles.name }).from(roles);
    const roleByName = new Map(existing.map((r) => [r.name.toLowerCase(), r.id]));
    const roleMap = new Map<number, string>(); // ProDuck claim id → role ULID
    const roleRows: (typeof roles.$inferInsert)[] = [];
    for (const c of srcClaims) {
      const name = String(c.Name).slice(0, 50);
      const collision = roleByName.get(name.toLowerCase());
      if (collision) {
        roleMap.set(Number(c.Id), collision);
        continue;
      }
      const id = ulid();
      roleMap.set(Number(c.Id), id);
      roleByName.set(name.toLowerCase(), id);
      roleRows.push({ id, name, isTemplate: false });
    }
    await insertAll(tx, roles, roleRows);
    counts.roles = roleRows.length;

    // --- Users -----------------------------------------------------------
    const rootClaimIds = new Set(
      srcClaims
        .filter((c) => String(c.Name).toLowerCase() === ROOT_CLAIM_NAME.toLowerCase())
        .map((c) => Number(c.Id)),
    );
    const rootUserIds = new Set(
      srcClaimUser
        .filter((cu) => rootClaimIds.has(Number(cu.ClaimsId)))
        .map((cu) => Number(cu.UsersId)),
    );
    const userMap = new Map<number, string>();
    const userRows: (typeof users.$inferInsert)[] = [];
    for (const u of srcUsers) {
      const id = ulid();
      userMap.set(Number(u.Id), id);
      userRows.push({
        id,
        username: String(u.Username),
        passwordHash: String(u.Password), // Argon2 — same algorithm, carries over
        name: nullable(u.Name) ?? String(u.Username),
        isRoot: rootUserIds.has(Number(u.Id)),
      });
    }
    await insertAll(tx, users, userRows);
    counts.users = userRows.length;
    if (rootUserIds.size === 0) {
      warnings.push(
        `No ProDuck claim named "${ROOT_CLAIM_NAME}" — no user was made root. ` +
          `The first-user bootstrap flow remains the only way in.`,
      );
    }

    // --- User ↔ role assignments ----------------------------------------
    const userRoleRows: (typeof userRoles.$inferInsert)[] = [];
    for (const cu of srcClaimUser) {
      const userId = userMap.get(Number(cu.UsersId));
      const roleId = roleMap.get(Number(cu.ClaimsId));
      if (userId && roleId) userRoleRows.push({ userId, roleId });
    }
    await insertAll(tx, userRoles, userRoleRows);
    counts.user_roles = userRoleRows.length;

    // --- Locations (+ an auto-created home for imported POS) -------------
    const mainLocationId = ulid();
    const locationRows: (typeof locations.$inferInsert)[] = [
      { id: mainLocationId, name: "Main" },
    ];
    const locationMap = new Map<number, string>();
    for (const l of srcLocations) {
      const id = ulid();
      locationMap.set(Number(l.Id), id);
      locationRows.push({ id, name: String(l.Name) });
    }
    // Second pass: rewrite parent links now that every id is mapped.
    for (const l of srcLocations) {
      if (l.LocationId == null) continue;
      const row = locationRows.find((r) => r.id === locationMap.get(Number(l.Id)));
      if (row) row.parentId = locationMap.get(Number(l.LocationId)) ?? null;
    }
    await insertAll(tx, locations, locationRows);
    counts.locations = locationRows.length;

    // --- Product categories ---------------------------------------------
    const categoryMap = new Map<number, string>();
    const categoryRows: (typeof productCategories.$inferInsert)[] = [];
    for (const c of srcCategories) {
      const id = ulid();
      categoryMap.set(Number(c.Id), id);
      const minQty = Number(c.MinQty ?? 0);
      categoryRows.push({ id, name: String(c.Name), minQty: minQty > 0 ? minQty : null });
    }
    for (const c of srcCategories) {
      if (c.ProductCategoryId == null) continue;
      const row = categoryRows.find((r) => r.id === categoryMap.get(Number(c.Id)));
      if (row) row.parentId = categoryMap.get(Number(c.ProductCategoryId)) ?? null;
    }
    await insertAll(tx, productCategories, categoryRows);
    counts.product_categories = categoryRows.length;

    // --- Products + variants --------------------------------------------
    // ProDuck has no variants — each product becomes one product + one
    // variant. Stock totals are summed from StockLocation below.
    const stockByProduct = new Map<number, number>();
    for (const s of srcStock) {
      const pid = Number(s.ProductId);
      stockByProduct.set(pid, (stockByProduct.get(pid) ?? 0) + Number(s.Stock ?? 0));
    }
    const variantByProduct = new Map<number, { variantId: string; costMinor: number }>();
    const productRows: (typeof products.$inferInsert)[] = [];
    const variantRows: (typeof productVariants.$inferInsert)[] = [];
    for (const p of srcProducts) {
      const productId = ulid();
      const variantId = ulid();
      const costMinor = toMinor(p.Cost);
      variantByProduct.set(Number(p.Id), { variantId, costMinor });
      productRows.push({
        id: productId,
        name: String(p.Name),
        kind: "physical",
        categoryId: p.CategoryId == null ? null : categoryMap.get(Number(p.CategoryId)) ?? null,
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
        costMinor,
        totalQty: stockByProduct.get(Number(p.Id)) ?? 0,
      });
    }
    await insertAll(tx, products, productRows);
    await insertAll(tx, productVariants, variantRows);
    counts.products = productRows.length;
    counts.product_variants = variantRows.length;

    // --- Stock: cache rows + an initial_import ledger movement -----------
    const stockRows: (typeof stockLocations.$inferInsert)[] = [];
    const movementRows: (typeof stockMovements.$inferInsert)[] = [];
    let skippedStock = 0;
    for (const s of srcStock) {
      const qty = Number(s.Stock ?? 0);
      if (qty === 0) continue;
      const variant = variantByProduct.get(Number(s.ProductId));
      if (!variant) {
        skippedStock++; // stock for a deleted/filtered product
        continue;
      }
      const locationId = s.LocationId == null ? null : locationMap.get(Number(s.LocationId)) ?? null;
      stockRows.push({ id: ulid(), variantId: variant.variantId, locationId, qty });
      movementRows.push({
        id: ulid(),
        variantId: variant.variantId,
        locationId,
        type: "initial_import",
        qtyDelta: qty,
        unitCost: variant.costMinor,
        refType: "import",
      });
    }
    await insertAll(tx, stockLocations, stockRows);
    await insertAll(tx, stockMovements, movementRows);
    counts.stock_locations = stockRows.length;
    counts.stock_movements = movementRows.length;
    if (skippedStock) {
      warnings.push(`${skippedStock} StockLocation row(s) skipped — product was deleted/filtered.`);
    }

    // --- Customers -------------------------------------------------------
    // ProDuck has no AR balance column, so no opening_balance ledger rows.
    const customerRows: (typeof customers.$inferInsert)[] = srcCustomers.map((c) => ({
      id: ulid(),
      name: String(c.Name),
      phone: nullable(c.Phone),
      address: nullable(c.Address),
    }));
    await insertAll(tx, customers, customerRows);
    counts.customers = customerRows.length;

    // --- Vendors ---------------------------------------------------------
    const vendorRows: (typeof vendors.$inferInsert)[] = srcVendors.map((v) => ({
      id: ulid(),
      name: String(v.Name),
      phone: nullable(v.Contact),
      notes: nullable(v.Description),
    }));
    await insertAll(tx, vendors, vendorRows);
    counts.vendors = vendorRows.length;

    // --- Points of sale --------------------------------------------------
    // ProDuck POS rows have no location; all are attached to "Main". Codes
    // are generated P1, P2, … since ProDuck has none.
    const posRows: (typeof pointsOfSale.$inferInsert)[] = srcPos.map((p, i) => ({
      id: ulid(),
      locationId: mainLocationId,
      code: `P${i + 1}`,
      name: String(p.Name),
      notes: nullable(p.Description),
    }));
    await insertAll(tx, pointsOfSale, posRows);
    counts.points_of_sale = posRows.length;

    await tx.execute(sql`SET FOREIGN_KEY_CHECKS = 1`);
  });

  // --- Report ------------------------------------------------------------
  console.log("\nImport complete. Rows written:");
  for (const [table, n] of Object.entries(counts)) {
    console.log(`  ${table.padEnd(22)} ${n}`);
  }
  if (warnings.length) {
    console.log("\nWarnings:");
    for (const w of warnings) console.log(`  ! ${w}`);
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
