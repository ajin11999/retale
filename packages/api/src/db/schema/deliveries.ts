// Deliveries domain: an inbound goods receipt against purchase orders.
// `purchase_deliveries` is the header; `purchase_delivery_items` is a
// hierarchical cost tree — parent nodes group costs (freight, customs), leaf
// nodes (`purchase_item_id` set) allocate a landed cost to a purchase line.
// Committing a delivery is the only step that writes stock. A delivery links
// to purchases solely through its leaves. See docs/design-decisions.md →
// "Purchases & deliveries" → "Delivery commit".

import { relations } from "drizzle-orm";
import {
  bigint,
  boolean,
  date,
  foreignKey,
  index,
  int,
  mysqlEnum,
  mysqlTable,
  timestamp,
  varchar,
} from "drizzle-orm/mysql-core";
import { users } from "./auth.ts";
import { locations } from "./locations.ts";
import { purchaseItems, purchases } from "./purchases.ts";
import { vendors } from "./vendors.ts";
import { timestamps, ulidPk, ulidRef } from "./_helpers.ts";

/** `delivered` is set by the commit transaction; `cancelled` reverses it (root only). */
export const DELIVERY_STATUSES = ["draft", "delivered", "cancelled"] as const;

/**
 * Delivery header. Stock always lands at one `targetLocationId`. The cost tree
 * is editable only while `status = draft`; `totalCostMinor` is a denormalized
 * sum of the tree's root nodes, kept fresh on every tree edit, for list views.
 */
export const purchaseDeliveries = mysqlTable("purchase_deliveries", {
  id: ulidPk(),
  date: date({ mode: "string" }).notNull(),
  biller: varchar({ length: 200 }),
  targetLocationId: ulidRef()
    .notNull()
    .references(() => locations.id, { onDelete: "restrict" }),
  // Set when the delivery is a receiving check tied to a single purchase: it
  // is the resumable draft the purchase detail page reopens. Null marks a
  // hand-built delivery (e.g. a multi-purchase landed-cost receipt). SET NULL
  // on delete keeps a committed receiving check intact if its purchase is
  // later removed.
  purchaseId: ulidRef().references(() => purchases.id, { onDelete: "set null" }),
  status: mysqlEnum(DELIVERY_STATUSES).notNull().default("draft"),
  deliveredAt: timestamp(),
  deliveredByUserId: ulidRef().references(() => users.id),
  totalCostMinor: bigint({ mode: "number" }).notNull().default(0),
  createdByUserId: ulidRef().references(() => users.id),
  ...timestamps,
});

/**
 * A node in a delivery's cost tree. `parentItemId IS NULL` marks a root.
 * A leaf carries `purchaseItemId` + `qty` and allocates `costMinor` to that
 * purchase line; on commit it becomes a `purchase_receive` movement (unless
 * the purchase line is non-stock). A non-leaf node is a cost grouping.
 */
export const purchaseDeliveryItems = mysqlTable(
  "purchase_delivery_items",
  {
    id: ulidPk(),
    deliveryId: ulidRef()
      .notNull()
      .references(() => purchaseDeliveries.id, { onDelete: "cascade" }),
    // Self-referencing FK declared in the table-extras below — its
    // auto-generated name would exceed MySQL's 64-char identifier limit.
    parentItemId: ulidRef(),
    // Set only on leaves. SET NULL on delete demotes a dangling draft leaf to
    // a plain grouping node rather than blocking the purchase-line delete.
    purchaseItemId: ulidRef().references(() => purchaseItems.id, {
      onDelete: "set null",
    }),
    // Courier/expedition this cost node is owed to. Set only on freight/customs
    // cost nodes (no purchaseItemId); on commit the node's cost posts as
    // `purchase_on_account` to this vendor. Null = freight we absorb (no AP).
    // SET NULL on vendor delete drops the AP link but keeps the landed cost.
    vendorId: ulidRef().references(() => vendors.id, { onDelete: "set null" }),
    // Explicit delivery-wide scope: this cost node (a freight leg) spreads over
    // every stock leaf of the delivery instead of its own subtree. Root cost
    // nodes only; never inferred — an unflagged childless node allocates nothing.
    deliveryWide: boolean().notNull().default(false),
    // Narrows a deliveryWide leg to one purchase's leaves — for multi-PO
    // deliveries where an expedition invoices per PO. Requires deliveryWide.
    // FK declared in the table-extras below to keep the constraint name short.
    appliesToPurchaseId: ulidRef(),
    description: varchar({ length: 300 }).notNull(),
    // Set only on leaves; in the variant's smallest unit.
    qty: bigint({ mode: "number" }),
    costMinor: bigint({ mode: "number" }).notNull(),
    sortOrder: int().notNull().default(0),
  },
  (t) => [
    foreignKey({
      name: "pdi_parent_item_fk",
      columns: [t.parentItemId],
      foreignColumns: [t.id],
    }).onDelete("restrict"),
    foreignKey({
      name: "pdi_applies_purchase_fk",
      columns: [t.appliesToPurchaseId],
      foreignColumns: [purchases.id],
    }).onDelete("set null"),
    index("purchase_delivery_items_delivery_id_idx").on(t.deliveryId),
    index("purchase_delivery_items_purchase_item_id_idx").on(t.purchaseItemId),
  ],
);

export const purchaseDeliveriesRelations = relations(
  purchaseDeliveries,
  ({ one, many }) => ({
    targetLocation: one(locations, {
      fields: [purchaseDeliveries.targetLocationId],
      references: [locations.id],
    }),
    purchase: one(purchases, {
      fields: [purchaseDeliveries.purchaseId],
      references: [purchases.id],
    }),
    items: many(purchaseDeliveryItems),
  }),
);

export const purchaseDeliveryItemsRelations = relations(
  purchaseDeliveryItems,
  ({ one }) => ({
    delivery: one(purchaseDeliveries, {
      fields: [purchaseDeliveryItems.deliveryId],
      references: [purchaseDeliveries.id],
    }),
    parent: one(purchaseDeliveryItems, {
      fields: [purchaseDeliveryItems.parentItemId],
      references: [purchaseDeliveryItems.id],
      relationName: "delivery_item_parent",
    }),
    purchaseItem: one(purchaseItems, {
      fields: [purchaseDeliveryItems.purchaseItemId],
      references: [purchaseItems.id],
    }),
    vendor: one(vendors, {
      fields: [purchaseDeliveryItems.vendorId],
      references: [vendors.id],
    }),
  }),
);
