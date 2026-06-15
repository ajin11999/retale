// Products domain: categories, products, variants, variant options, and
// qty-break price tiers. See docs/design-decisions.md → "Product structure".
//
// Money is the literal rupiah value in DECIMAL(19,2) (see the `money` helper).
// Stock qty is an integer count of the variant's smallest `unit`. Images are
// deferred (filesystem concern).

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
import { money, timestamps, ulidPk, ulidRef } from "./_helpers.ts";

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
 * How a product's price shows on the online catalog: not at all, masked to
 * its order of magnitude, or in full. Default `exclude` — nothing leaks.
 */
export const ONLINE_PRICE_MODES = ["exclude", "peek", "show"] as const;

/**
 * How a product's stock shows on the online catalog: the real quantity, a
 * fuzzy band, or nothing. Default `hide` — conservative for items whose
 * count is uncertain.
 */
export const ONLINE_STOCK_MODES = ["show_real", "peek", "hide"] as const;

/**
 * Shared product identity. The sellable SKU lives on `product_variants`;
 * every product has at least one. `kind` distinguishes stock-tracked goods
 * from services (which skip stock movements and allow price overrides) and
 * `open_price` items — loose hardware (fasteners) sold by a guessed lump
 * price, no stock tracking, with cost derived from `costRatioBps`.
 */
export const products = mysqlTable(
  "products",
  {
    id: ulidPk(),
    // Internal, staff-facing name — used in admin lists and search.
    name: varchar({ length: 300 }).notNull(),
    // Optional public-facing name for POS receipts and the online catalog.
    // Null means public surfaces fall back to `name`.
    publicName: varchar({ length: 300 }),
    description: text(),
    kind: mysqlEnum(["physical", "service", "bundle", "open_price"]).notNull().default("physical"),
    categoryId: ulidRef().references(() => productCategories.id, { onDelete: "set null" }),
    taxRateBps: int().notNull().default(0),
    priceMode: mysqlEnum(["tax_inclusive", "tax_exclusive"]).notNull(),
    minQty: int(),
    minMarginBps: int(),
    // open_price only: snapshot cost = entered price × ratio ÷ 10000 (e.g.
    // 6000 = 60%). Null on every other kind; ignored when not open_price.
    costRatioBps: int(),
    // Default supplier — the reorder forecast inherits this vendor's lead time.
    primaryVendorId: ulidRef().references(() => vendors.id, {
      onDelete: "set null",
    }),
    // When false, the product is excluded from the reorder forecast.
    replenishMonitored: boolean().notNull().default(true),
    // Online catalog controls. `onlineVisible` is the master switch — false
    // means the product does not exist as far as the catalog is concerned.
    // The two modes govern how its price / stock render once visible. All
    // three default conservative; a product leaks nothing until opted in.
    onlineVisible: boolean().notNull().default(false),
    onlinePriceMode: mysqlEnum(ONLINE_PRICE_MODES).notNull().default("exclude"),
    onlineStockMode: mysqlEnum(ONLINE_STOCK_MODES).notNull().default("hide"),
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
    priceMinor: money().notNull(),
    costMinor: money().notNull().default(0),
    totalQty: bigint({ mode: "number" }).notNull().default(0),
    // Reorder thresholds, in the variant's smallest unit. `reorderPoint` is the
    // available-stock level at or below which the reorder scan suggests a
    // purchase; null = not tracked, excluded from the scan. `reorderQty` is the
    // suggested order quantity — null falls back to "enough to reach the point".
    reorderPoint: bigint({ mode: "number" }),
    reorderQty: bigint({ mode: "number" }),
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
    priceMinor: money().notNull(),
  },
  (t) => [unique("product_price_tiers_variant_min_qty_unique").on(t.variantId, t.minQty)],
);

/**
 * The composition of a `kind = 'bundle'` product. `bundleVariantId` is the
 * bundle's own (sellable) variant; each row names a component variant and how
 * many units of it the bundle contains. On sale the bundle line explodes into
 * one order line per component — see order-service. Component variants use
 * `restrict` on delete: a variant cannot be removed while a bundle needs it.
 */
export const bundleComponents = mysqlTable(
  "bundle_components",
  {
    id: ulidPk(),
    bundleVariantId: ulidRef()
      .notNull()
      .references(() => productVariants.id, { onDelete: "cascade" }),
    componentVariantId: ulidRef()
      .notNull()
      .references(() => productVariants.id, { onDelete: "restrict" }),
    qty: bigint({ mode: "number" }).notNull(),
  },
  (t) => [
    unique("bundle_components_bundle_component_unique").on(
      t.bundleVariantId,
      t.componentVariantId,
    ),
    index("bundle_components_bundle_variant_id_idx").on(t.bundleVariantId),
  ],
);

/**
 * A product's catalog gallery image. The Retale API optimizes every upload
 * (resize + WebP) before storing it on Vercel Blob — `detailUrl` is the
 * ~1280px image, `thumbnailUrl` the ~400px card image. `sortOrder` 0 is the
 * primary image (the card thumbnail). Product-level only; no per-variant
 * images. Rows cascade-delete with the product.
 */
export const productImages = mysqlTable(
  "product_images",
  {
    id: ulidPk(),
    productId: ulidRef()
      .notNull()
      .references(() => products.id, { onDelete: "cascade" }),
    detailUrl: varchar({ length: 500 }).notNull(),
    thumbnailUrl: varchar({ length: 500 }).notNull(),
    // Dimensions of the detail image, for layout / aspect-ratio hints.
    width: int().notNull(),
    height: int().notNull(),
    sortOrder: int().notNull().default(0),
    createdAt: timestamp()
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (t) => [index("product_images_product_id_idx").on(t.productId)],
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
  images: many(productImages),
}));

export const productImagesRelations = relations(productImages, ({ one }) => ({
  product: one(products, {
    fields: [productImages.productId],
    references: [products.id],
  }),
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
