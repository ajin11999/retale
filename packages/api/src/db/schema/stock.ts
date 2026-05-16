// Stock domain: an append-only `stock_movements` ledger plus a per-location
// running total cache in `stock_locations`. Stock is tracked per variant (the
// sellable SKU) — the variant carries the denormalized `total_qty` and the
// weighted-average `cost_minor`. See docs/design-decisions.md → "Cost
// accounting" and "Stock movement types".

import { relations } from "drizzle-orm";
import { bigint, index, mysqlEnum, mysqlTable, timestamp, unique, varchar } from "drizzle-orm/mysql-core";
import { users } from "./auth.ts";
import { locations } from "./locations.ts";
import { productVariants } from "./products.ts";
import { timestamps, ulidPk, ulidRef } from "./_helpers.ts";

/** The nine recognized movement types. Only `purchase_receive`, `cost_override`,
 *  and `initial_import` change a variant's WAC `cost_minor`. */
export const STOCK_MOVEMENT_TYPES = [
  "purchase_receive",
  "transfer_in",
  "transfer_out",
  "sale",
  "sale_return",
  "adjustment_in",
  "adjustment_out",
  "cost_override",
  "initial_import",
] as const;

/** Source-document categories a movement can point back at via `refId`. */
export const STOCK_REF_TYPES = [
  "purchase",
  "order",
  "transfer",
  "adjustment",
  "override",
  "import",
] as const;

/**
 * Cached running total of stock for a (variant, location) pair. `locationId`
 * is nullable — the NULL row is the "unlocated root" bucket for stock not yet
 * pinned to a place. May go negative (selling into negative stock is allowed).
 */
export const stockLocations = mysqlTable(
  "stock_locations",
  {
    id: ulidPk(),
    variantId: ulidRef()
      .notNull()
      .references(() => productVariants.id, { onDelete: "cascade" }),
    locationId: ulidRef().references(() => locations.id, { onDelete: "restrict" }),
    qty: bigint({ mode: "number" }).notNull().default(0),
    ...timestamps,
  },
  (t) => [
    unique("stock_locations_variant_location_unique").on(t.variantId, t.locationId),
    index("stock_locations_location_id_idx").on(t.locationId),
  ],
);

/**
 * Append-only ledger row. Never updated except the documented post-delivery
 * `unitCost` correction. `qtyDelta` is positive inbound, negative outbound,
 * zero for `cost_override`. `unitCost` is the per-unit cost of this movement
 * (for outbound rows, the WAC at the time).
 */
export const stockMovements = mysqlTable(
  "stock_movements",
  {
    id: ulidPk(),
    variantId: ulidRef()
      .notNull()
      .references(() => productVariants.id, { onDelete: "cascade" }),
    locationId: ulidRef().references(() => locations.id, { onDelete: "set null" }),
    type: mysqlEnum(STOCK_MOVEMENT_TYPES).notNull(),
    qtyDelta: bigint({ mode: "number" }).notNull(),
    unitCost: bigint({ mode: "number" }).notNull().default(0),
    // Only set on cost_override rows — the WAC before the override, for audit.
    previousCost: bigint({ mode: "number" }),
    refType: mysqlEnum(STOCK_REF_TYPES).notNull(),
    refId: ulidRef(),
    reason: varchar({ length: 500 }),
    createdByUserId: ulidRef().references(() => users.id),
    createdAt: timestamp()
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (t) => [
    index("stock_movements_variant_id_idx").on(t.variantId),
    index("stock_movements_location_id_idx").on(t.locationId),
    index("stock_movements_ref_idx").on(t.refType, t.refId),
    index("stock_movements_created_at_idx").on(t.createdAt),
  ],
);

export const stockLocationsRelations = relations(stockLocations, ({ one }) => ({
  variant: one(productVariants, {
    fields: [stockLocations.variantId],
    references: [productVariants.id],
  }),
  location: one(locations, {
    fields: [stockLocations.locationId],
    references: [locations.id],
  }),
}));

export const stockMovementsRelations = relations(stockMovements, ({ one }) => ({
  variant: one(productVariants, {
    fields: [stockMovements.variantId],
    references: [productVariants.id],
  }),
  location: one(locations, {
    fields: [stockMovements.locationId],
    references: [locations.id],
  }),
}));
