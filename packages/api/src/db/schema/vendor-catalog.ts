// Vendor catalog: a vendor's pricelist / catalogue stored as reference rows,
// deliberately separated from our sellable `products` / `product_variants`.
// A row optionally links to one of our variants (`mappedVariantId`) so the PO
// editor, RFQ compare, and receiving scan can jump from a vendor offering to
// our SKU — but the link is nullable with ON DELETE SET NULL, so deleting a
// product never destroys vendor history. Prices are IDR-only (literal rupiah
// in DECIMAL(19,2) via `money()`); units are free-text `unitText`
// (pcs/dus/koli/roll/...) with no conversion in v1.

import { relations, sql } from "drizzle-orm";
import {
  boolean,
  date,
  index,
  int,
  json,
  mysqlEnum,
  mysqlTable,
  text,
  timestamp,
  unique,
  varchar,
} from "drizzle-orm/mysql-core";
import { users } from "./auth.ts";
import { productVariants } from "./products.ts";
import { vendors } from "./vendors.ts";
import { money, timestamps, ulidPk, ulidRef } from "./_helpers.ts";

export const VENDOR_CATALOG_IMPORT_STATUSES = [
  "pending",
  "ready",
  "confirmed",
  "failed",
] as const;

export const vendorCatalogItems = mysqlTable(
  "vendor_catalog_items",
  {
    id: ulidPk(),
    vendorId: ulidRef()
      .notNull()
      .references(() => vendors.id, { onDelete: "cascade" }),
    // The vendor's own SKU / part number. Empty string = unknown; dedupe
    // matches on (vendorId, lower(vendorCode)) when non-empty.
    vendorCode: varchar({ length: 100 }).notNull().default(""),
    name: varchar({ length: 300 }).notNull(),
    // Free-text unit of measure as printed on the pricelist.
    unitText: varchar({ length: 50 }),
    // IDR literal, e.g. 10500.50. No currency column (IDR-only v1).
    priceMinor: money().notNull(),
    moq: int(),
    leadTimeDays: int(),
    validFrom: date({ mode: "string" }),
    validTo: date({ mode: "string" }),
    isActive: boolean().notNull().default(true),
    // Optional link to our sellable variant. SET NULL on variant delete.
    mappedVariantId: ulidRef().references(() => productVariants.id, {
      onDelete: "set null",
    }),
    note: text(),
    sourceImportId: ulidRef(),
    lastSeenAt: timestamp(),
    archivedAt: timestamp(),
    createdByUserId: ulidRef().references(() => users.id),
    searchText: varchar({ length: 400 }).generatedAlwaysAs(
      sql`lower(concat(\`name\`, ' ', coalesce(\`vendor_code\`, '')))`,
      { mode: "stored" },
    ),
    ...timestamps,
  },
  (t) => [
    index("vendor_catalog_items_vendor_id_idx").on(t.vendorId),
    index("vendor_catalog_items_mapped_variant_idx").on(t.mappedVariantId),
    index("vendor_catalog_items_search_text_idx").on(t.searchText),
    index("vendor_catalog_items_archived_at_idx").on(t.archivedAt),
    unique("vendor_catalog_items_vendor_code_unique").on(t.vendorId, t.vendorCode, t.name),
  ],
);

/** Append-only price history. Written on create + every confirmed price change. */
export const vendorCatalogPrices = mysqlTable(
  "vendor_catalog_prices",
  {
    id: ulidPk(),
    itemId: ulidRef()
      .notNull()
      .references(() => vendorCatalogItems.id, { onDelete: "cascade" }),
    priceMinor: money().notNull(),
    validFrom: date({ mode: "string" }),
    sourceImportId: ulidRef(),
    createdByUserId: ulidRef().references(() => users.id),
    createdAt: timestamp()
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (t) => [index("vendor_catalog_prices_item_id_idx").on(t.itemId)],
);

/** Audit row for every file → preview → confirm import cycle. */
export const vendorCatalogImports = mysqlTable(
  "vendor_catalog_imports",
  {
    id: ulidPk(),
    vendorId: ulidRef()
      .notNull()
      .references(() => vendors.id, { onDelete: "cascade" }),
    fileName: varchar({ length: 300 }),
    status: mysqlEnum(VENDOR_CATALOG_IMPORT_STATUSES).notNull().default("pending"),
    rowCount: int().notNull().default(0),
    modelUsed: varchar({ length: 200 }),
    // NOTE: drizzle-orm on MariaDB reads json() back as an unparsed string —
    // callers must JSON.parse when reading (see db-migrate skill gotchas).
    tokenUsageJson: json(),
    errorCode: varchar({ length: 100 }),
    errorMessage: text(),
    createdByUserId: ulidRef().references(() => users.id),
    createdAt: timestamp()
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (t) => [index("vendor_catalog_imports_vendor_id_idx").on(t.vendorId)],
);

export const vendorCatalogItemsRelations = relations(vendorCatalogItems, ({ one, many }) => ({
  vendor: one(vendors, {
    fields: [vendorCatalogItems.vendorId],
    references: [vendors.id],
  }),
  mappedVariant: one(productVariants, {
    fields: [vendorCatalogItems.mappedVariantId],
    references: [productVariants.id],
  }),
  prices: many(vendorCatalogPrices),
}));

export const vendorCatalogPricesRelations = relations(vendorCatalogPrices, ({ one }) => ({
  item: one(vendorCatalogItems, {
    fields: [vendorCatalogPrices.itemId],
    references: [vendorCatalogItems.id],
  }),
}));
