// Products domain: categories, products, variants, variant options, and
// qty-break price tiers. See docs/design-decisions.md → "Product structure".
//
// Money is integer minor units (BIGINT). Stock qty is an integer count of the
// variant's smallest `unit`. Images are deferred (filesystem concern).

import { relations, sql } from "drizzle-orm";
import {
  type AnyMySqlColumn,
  bigint,
  boolean,
  index,
  int,
  mysqlEnum,
  mysqlTable,
  primaryKey,
  text,
  timestamp,
  tinyint,
  unique,
  varchar,
} from "drizzle-orm/mysql-core";
import { users } from "./auth.ts";
import { trackingAccounts } from "./tracking.ts";
import { vendors } from "./vendors.ts";
import { timestamps, ulidPk, ulidRef } from "./_helpers.ts";

/**
 * Single-parent category hierarchy. One category per product. `minQty` and
 * `minMarginBps` are inherited by products that leave their own value null.
 */
export const productCategories = mysqlTable(
  "product_categories",
  {
    id: ulidPk(),
    name: varchar({ length: 200 }).notNull(),
    parentId: ulidRef().references((): AnyMySqlColumn => productCategories.id, {
      onDelete: "set null",
    }),
    minQty: int(),
    minMarginBps: int(),
    archivedAt: timestamp(),
    ...timestamps,
  },
  (t) => [index("product_categories_parent_id_idx").on(t.parentId)],
);

/**
 * Shared product identity. The sellable SKU lives on `product_variants`;
 * every product has at least one. `kind` distinguishes stock-tracked goods
 * from services (which skip stock movements and allow price overrides).
 */
export const products = mysqlTable(
  "products",
  {
    id: ulidPk(),
    name: varchar({ length: 300 }).notNull(),
    description: text(),
    kind: mysqlEnum(["physical", "service"]).notNull().default("physical"),
    categoryId: ulidRef().references(() => productCategories.id, { onDelete: "set null" }),
    taxRateBps: int().notNull().default(0),
    priceMode: mysqlEnum(["tax_inclusive", "tax_exclusive"]).notNull(),
    minQty: int(),
    minMarginBps: int(),
    // Default supplier — the reorder forecast inherits this vendor's lead time.
    primaryVendorId: ulidRef().references(() => vendors.id, {
      onDelete: "set null",
    }),
    // When false, the product is excluded from the reorder forecast.
    replenishMonitored: boolean().notNull().default(true),
    archivedAt: timestamp(),
    createdByUserId: ulidRef().references(() => users.id),
    // Lowercased name for LIKE search (fixes ProDuck empty-keyword bug at the
    // query layer). Stored + indexed. The expression uses an unqualified
    // column name, and carries no NOT NULL — both are MariaDB constraints on
    // generated columns. It is never actually null (derived from `name`).
    searchText: varchar({ length: 300 }).generatedAlwaysAs(sql`lower(\`name\`)`, {
      mode: "stored",
    }),
    ...timestamps,
  },
  (t) => [
    index("products_archived_at_idx").on(t.archivedAt),
    index("products_category_id_idx").on(t.categoryId),
    index("products_search_text_idx").on(t.searchText),
  ],
);

/**
 * The sellable SKU: price, cost (WAC), stock total, unit. `costMinor` and
 * `totalQty` are owned by the stock / purchase domains — product CRUD only
 * sets their initial values.
 */
export const productVariants = mysqlTable(
  "product_variants",
  {
    id: ulidPk(),
    productId: ulidRef()
      .notNull()
      .references(() => products.id, { onDelete: "cascade" }),
    sku: varchar({ length: 64 }).notNull().unique(),
    barcode: varchar({ length: 64 }),
    label: varchar({ length: 200 }),
    unit: mysqlEnum(["piece", "g", "ml", "mm"]).notNull().default("piece"),
    qtyDecimals: tinyint().notNull().default(0),
    priceMinor: bigint({ mode: "number" }).notNull(),
    costMinor: bigint({ mode: "number" }).notNull().default(0),
    totalQty: bigint({ mode: "number" }).notNull().default(0),
    sortOrder: int().notNull().default(0),
    trackingAccountId: ulidRef().references(() => trackingAccounts.id, {
      onDelete: "set null",
    }),
    trackingAttributionMode: mysqlEnum(["full", "percent"]).notNull().default("full"),
    trackingAttributionPctBps: int(),
    ...timestamps,
  },
  (t) => [
    index("product_variants_product_id_idx").on(t.productId),
    index("product_variants_barcode_idx").on(t.barcode),
  ],
);

/** Key/value options that compose a variant's label ("length" → "20mm"). */
export const productVariantOptions = mysqlTable(
  "product_variant_options",
  {
    variantId: ulidRef()
      .notNull()
      .references(() => productVariants.id, { onDelete: "cascade" }),
    optionName: varchar({ length: 100 }).notNull(),
    optionValue: varchar({ length: 200 }).notNull(),
  },
  (t) => [primaryKey({ columns: [t.variantId, t.optionName] })],
);

/** Qty-break pricing: highest `minQty` ≤ requested qty wins (below customer prices). */
export const productPriceTiers = mysqlTable(
  "product_price_tiers",
  {
    id: ulidPk(),
    variantId: ulidRef()
      .notNull()
      .references(() => productVariants.id, { onDelete: "cascade" }),
    minQty: bigint({ mode: "number" }).notNull(),
    priceMinor: bigint({ mode: "number" }).notNull(),
  },
  (t) => [unique("product_price_tiers_variant_min_qty_unique").on(t.variantId, t.minQty)],
);

// --- Relations ---

export const productCategoriesRelations = relations(productCategories, ({ one, many }) => ({
  parent: one(productCategories, {
    fields: [productCategories.parentId],
    references: [productCategories.id],
    relationName: "category_parent",
  }),
  children: many(productCategories, { relationName: "category_parent" }),
  products: many(products),
}));

export const productsRelations = relations(products, ({ one, many }) => ({
  category: one(productCategories, {
    fields: [products.categoryId],
    references: [productCategories.id],
  }),
  variants: many(productVariants),
}));

export const productVariantsRelations = relations(productVariants, ({ one, many }) => ({
  product: one(products, { fields: [productVariants.productId], references: [products.id] }),
  options: many(productVariantOptions),
  priceTiers: many(productPriceTiers),
}));

export const productVariantOptionsRelations = relations(productVariantOptions, ({ one }) => ({
  variant: one(productVariants, {
    fields: [productVariantOptions.variantId],
    references: [productVariants.id],
  }),
}));

export const productPriceTiersRelations = relations(productPriceTiers, ({ one }) => ({
  variant: one(productVariants, {
    fields: [productPriceTiers.variantId],
    references: [productVariants.id],
  }),
}));
