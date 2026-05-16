// Purchases domain: a purchase order (header `purchases`, flat `purchase_sections`,
// line `purchase_items`) plus an append-only `purchase_sends` log. Purchases are
// documents only — they touch no stock until a delivery is committed (Phase 3).
// `revision` is bumped by content edits; see docs/design-decisions.md →
// "Purchases & deliveries".

import { relations } from "drizzle-orm";
import {
  type AnyMySqlColumn,
  bigint,
  date,
  index,
  int,
  mysqlEnum,
  mysqlTable,
  text,
  timestamp,
  varchar,
} from "drizzle-orm/mysql-core";
import { users } from "./auth.ts";
import { productVariants } from "./products.ts";
import { vendors } from "./vendors.ts";
import { timestamps, ulidPk, ulidRef } from "./_helpers.ts";

/** `complete` is set by the delivery transaction; `cancelled` is manual. */
export const PURCHASE_STATUSES = ["open", "complete", "cancelled"] as const;

/** Channels a purchase order can be sent over. `manual` = clerk handled it off-system. */
export const PURCHASE_SEND_CHANNELS = ["whatsapp", "email", "manual"] as const;

/** A send row is `prepared` when the link is generated, `sent` once the clerk confirms. */
export const PURCHASE_SEND_STATUSES = ["prepared", "sent"] as const;

/**
 * Purchase order header. `vendorId` is nullable — a NULL vendor is an ad-hoc
 * one-off purchase carrying no AP. `snapshotVendorName` is always set: copied
 * from the vendor on create, or free-text for ad-hoc. Hard-deleting a vendor
 * nulls `vendorId` (ON DELETE SET NULL) while the snapshot preserves the name.
 */
export const purchases = mysqlTable("purchases", {
  id: ulidPk(),
  vendorId: ulidRef().references(() => vendors.id, { onDelete: "set null" }),
  snapshotVendorName: varchar({ length: 300 }).notNull(),
  date: date({ mode: "string" }).notNull(),
  sourceDocument: varchar({ length: 300 }),
  memo: text(),
  status: mysqlEnum(PURCHASE_STATUSES).notNull().default("open"),
  // Bumped by content edits (items, sections). Sending snapshots it but does
  // not bump it — `revision` tracks content only.
  revision: int().notNull().default(1),
  // Denormalized so list views can filter "not yet sent" without a join.
  lastSentAt: timestamp(),
  cancelledAt: timestamp(),
  cancelledByUserId: ulidRef().references(() => users.id),
  createdByUserId: ulidRef().references(() => users.id),
  ...timestamps,
});

/** Per-purchase, free-text, flat grouping. Items with `sectionId IS NULL` are "Uncategorized". */
export const purchaseSections = mysqlTable("purchase_sections", {
  id: ulidPk(),
  purchaseId: ulidRef()
    .notNull()
    .references(() => purchases.id, { onDelete: "cascade" }),
  name: varchar({ length: 200 }).notNull(),
  sortOrder: int().notNull().default(0),
});

/**
 * A purchase line. `variantId IS NULL` flags a non-stock line (workshop
 * consumable, tool) — those count toward the invoice total but are excluded
 * from landed-cost allocation and write no stock movement on delivery.
 * `qtyDelivered` is a denormalized running total kept by the delivery domain.
 */
export const purchaseItems = mysqlTable(
  "purchase_items",
  {
    id: ulidPk(),
    purchaseId: ulidRef()
      .notNull()
      .references(() => purchases.id, { onDelete: "cascade" }),
    sectionId: ulidRef().references((): AnyMySqlColumn => purchaseSections.id, {
      onDelete: "set null",
    }),
    variantId: ulidRef().references(() => productVariants.id, { onDelete: "set null" }),
    // Vendor free-text label. Required when variantId is null (it is the line).
    description: varchar({ length: 300 }),
    qtyOrdered: bigint({ mode: "number" }).notNull(),
    qtyDelivered: bigint({ mode: "number" }).notNull().default(0),
    unitCostMinor: bigint({ mode: "number" }).notNull(),
    sortOrder: int().notNull().default(0),
  },
  (t) => [
    index("purchase_items_purchase_id_idx").on(t.purchaseId),
    index("purchase_items_variant_id_idx").on(t.variantId),
  ],
);

/**
 * Append-only send log. Re-sending adds a row; `revision` snapshots
 * `purchases.revision` at send time so the UI can detect unsent edits
 * (`purchases.revision > MAX(purchase_sends.revision)`).
 */
export const purchaseSends = mysqlTable(
  "purchase_sends",
  {
    id: ulidPk(),
    purchaseId: ulidRef()
      .notNull()
      .references(() => purchases.id, { onDelete: "cascade" }),
    channel: mysqlEnum(PURCHASE_SEND_CHANNELS).notNull(),
    recipient: varchar({ length: 300 }).notNull(),
    revision: int().notNull(),
    status: mysqlEnum(PURCHASE_SEND_STATUSES).notNull().default("prepared"),
    sentAt: timestamp(),
    note: text(),
    createdByUserId: ulidRef().references(() => users.id),
    createdAt: timestamp()
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (t) => [index("purchase_sends_purchase_id_idx").on(t.purchaseId)],
);

// --- Relations ---

export const purchasesRelations = relations(purchases, ({ one, many }) => ({
  vendor: one(vendors, {
    fields: [purchases.vendorId],
    references: [vendors.id],
  }),
  sections: many(purchaseSections),
  items: many(purchaseItems),
  sends: many(purchaseSends),
}));

export const purchaseSectionsRelations = relations(purchaseSections, ({ one, many }) => ({
  purchase: one(purchases, {
    fields: [purchaseSections.purchaseId],
    references: [purchases.id],
  }),
  items: many(purchaseItems),
}));

export const purchaseItemsRelations = relations(purchaseItems, ({ one }) => ({
  purchase: one(purchases, {
    fields: [purchaseItems.purchaseId],
    references: [purchases.id],
  }),
  section: one(purchaseSections, {
    fields: [purchaseItems.sectionId],
    references: [purchaseSections.id],
  }),
  variant: one(productVariants, {
    fields: [purchaseItems.variantId],
    references: [productVariants.id],
  }),
}));

export const purchaseSendsRelations = relations(purchaseSends, ({ one }) => ({
  purchase: one(purchases, {
    fields: [purchaseSends.purchaseId],
    references: [purchases.id],
  }),
}));
