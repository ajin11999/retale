// Reorder suggestions domain: the output of the reorder scan. The scan
// compares each variant's available stock (on-hand + on-order) against its
// `reorderPoint` and writes a review list here — staff adjust and confirm,
// which converts `open` rows into draft purchases. Nothing is written to
// `purchases` until that confirmation. See docs/future-features.md →
// "Reorder-point → suggested reorders".

import { relations } from "drizzle-orm";
import {
  bigint,
  index,
  mysqlEnum,
  mysqlTable,
  timestamp,
} from "drizzle-orm/mysql-core";
import { productVariants } from "./products.ts";
import { vendors } from "./vendors.ts";
import { ulidPk, ulidRef } from "./_helpers.ts";

/**
 * Suggestion lifecycle. A new scan supersedes the previous `open` set;
 * `converted` / `dismissed` rows are kept as a light audit of what was acted on.
 */
export const REORDER_SUGGESTION_STATUSES = [
  "open",
  "converted",
  "dismissed",
] as const;

/**
 * One suggested reorder for a variant. `vendorId` null means the variant
 * landed in the "unassigned" bucket — no preferred or last-used vendor — and
 * staff must route it before converting. `currentStock` and `reorderPoint`
 * are snapshots at scan time so the review screen explains the suggestion
 * even after stock moves.
 */
export const reorderSuggestions = mysqlTable(
  "reorder_suggestions",
  {
    id: ulidPk(),
    variantId: ulidRef()
      .notNull()
      .references(() => productVariants.id, { onDelete: "cascade" }),
    vendorId: ulidRef().references(() => vendors.id, { onDelete: "set null" }),
    // On-hand stock snapshot at scan time, in the variant's smallest unit.
    currentStock: bigint({ mode: "number" }).notNull(),
    reorderPoint: bigint({ mode: "number" }).notNull(),
    suggestedQty: bigint({ mode: "number" }).notNull(),
    status: mysqlEnum(REORDER_SUGGESTION_STATUSES).notNull().default("open"),
    generatedAt: timestamp()
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (t) => [
    index("reorder_suggestions_status_idx").on(t.status),
    index("reorder_suggestions_vendor_id_idx").on(t.vendorId),
  ],
);

export const reorderSuggestionsRelations = relations(
  reorderSuggestions,
  ({ one }) => ({
    variant: one(productVariants, {
      fields: [reorderSuggestions.variantId],
      references: [productVariants.id],
    }),
    vendor: one(vendors, {
      fields: [reorderSuggestions.vendorId],
      references: [vendors.id],
    }),
  }),
);
