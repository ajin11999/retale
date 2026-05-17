// Orders domain: `orders`, `order_items`, `order_payments`. One `orders` table
// backs both POS orders (atomic, closed on create, tied to a POS session) and
// Console customer sales (stateful, open until explicitly closed). Order
// status is derived, never stored — see docs/design-decisions.md → "Order
// lifecycle" and "Payments & customer debt".
//
// Money is integer minor units. `order_items` carries a full snapshot of the
// product at sale time so products stay truly deletable.

import { relations } from "drizzle-orm";
import {
  type AnyMySqlColumn,
  bigint,
  index,
  int,
  mysqlEnum,
  mysqlTable,
  timestamp,
  varchar,
} from "drizzle-orm/mysql-core";
import { users } from "./auth.ts";
import { customers } from "./customers.ts";
import { posSessions } from "./pos.ts";
import { products, productVariants } from "./products.ts";
import { timestamps, ulidPk, ulidRef } from "./_helpers.ts";

/** Payment methods. Cash-only for v1; the enum is extensible. */
export const ORDER_PAYMENT_METHODS = ["cash"] as const;

/**
 * A sale. POS orders set `closedAt`/`posSessionId` on create; Console sales
 * leave them null until close. `displayNumber` is the human-facing receipt
 * label (`<pos-code>-<YYYY-MM-DD>-<seq>`), assigned at close — null while a
 * Console sale is open. `returnOfOrderId` links a return order to its
 * original. `totalMinor` is the cached sum of live (non-voided) line totals.
 */
export const orders = mysqlTable(
  "orders",
  {
    id: ulidPk(),
    // Unique when present; null while a Console sale is open. MySQL unique
    // indexes permit multiple nulls, so open sales don't collide.
    displayNumber: varchar({ length: 64 }).unique(),
    customerId: ulidRef().references(() => customers.id, { onDelete: "set null" }),
    // Preserves the customer name on the order after a hard-delete. Null for walk-in.
    snapshotCustomerName: varchar({ length: 300 }),
    posSessionId: ulidRef().references(() => posSessions.id),
    totalMinor: bigint({ mode: "number" }).notNull().default(0),
    closedAt: timestamp(),
    closedByUserId: ulidRef().references(() => users.id),
    cancelledAt: timestamp(),
    cancelledByUserId: ulidRef().references(() => users.id),
    cancellationReason: varchar({ length: 255 }),
    returnOfOrderId: ulidRef().references((): AnyMySqlColumn => orders.id, {
      onDelete: "set null",
    }),
    createdByUserId: ulidRef().references(() => users.id),
    ...timestamps,
  },
  (t) => [
    index("orders_customer_id_idx").on(t.customerId),
    index("orders_pos_session_id_idx").on(t.posSessionId),
    index("orders_closed_at_idx").on(t.closedAt),
    index("orders_return_of_order_id_idx").on(t.returnOfOrderId),
  ],
);

/**
 * One sold line. `variantId`/`productId` are live references (null after a
 * hard-delete); the `snapshot*` columns are the immutable source of truth for
 * reports and reprints. `qty` is an integer count of the variant's smallest
 * unit — negative on return orders. A voided line keeps its row for audit.
 */
export const orderItems = mysqlTable(
  "order_items",
  {
    id: ulidPk(),
    orderId: ulidRef()
      .notNull()
      .references(() => orders.id, { onDelete: "cascade" }),
    variantId: ulidRef().references(() => productVariants.id, {
      onDelete: "set null",
    }),
    productId: ulidRef().references(() => products.id, { onDelete: "set null" }),
    // Set on return-order lines: the original line being returned. Enables
    // per-line over-return checks across multiple partial returns.
    returnOfOrderItemId: ulidRef().references(
      (): AnyMySqlColumn => orderItems.id,
      { onDelete: "set null" },
    ),
    qty: bigint({ mode: "number" }).notNull(),
    discountMinor: bigint({ mode: "number" }).notNull().default(0),
    // --- Snapshot of the product at sale time (locked field set) ---
    snapshotProductName: varchar({ length: 300 }).notNull(),
    snapshotProductSku: varchar({ length: 64 }).notNull(),
    snapshotProductBarcode: varchar({ length: 64 }),
    snapshotVariantLabel: varchar({ length: 200 }),
    snapshotUnit: mysqlEnum(["piece", "g", "ml", "mm"]).notNull(),
    snapshotCategoryName: varchar({ length: 200 }),
    // Price actually charged per smallest unit.
    snapshotPriceMinor: bigint({ mode: "number" }).notNull(),
    // WAC at sale time; 0 for services.
    snapshotCostMinor: bigint({ mode: "number" }).notNull(),
    snapshotTaxRateBps: int().notNull(),
    snapshotPriceMode: mysqlEnum(["tax_inclusive", "tax_exclusive"]).notNull(),
    // Survives a hard-delete of the tracking account. Tracking domain pending.
    snapshotTrackingAccountName: varchar({ length: 200 }),
    // FK to tracking_accounts is added when that domain is built.
    attributionAccountId: ulidRef(),
    attributionAmountMinor: bigint({ mode: "number" }).notNull().default(0),
    voidedAt: timestamp(),
    voidedByUserId: ulidRef().references(() => users.id),
    voidReason: varchar({ length: 255 }),
    createdAt: timestamp()
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (t) => [
    index("order_items_order_id_idx").on(t.orderId),
    index("order_items_variant_id_idx").on(t.variantId),
  ],
);

/**
 * A payment against an order. `amountMinor` is net of change (a 100k tender on
 * a 73k order is a 73k row). Negative on return orders. `posSessionId` records
 * which drawer the cash landed in.
 */
export const orderPayments = mysqlTable(
  "order_payments",
  {
    id: ulidPk(),
    orderId: ulidRef()
      .notNull()
      .references(() => orders.id, { onDelete: "cascade" }),
    method: mysqlEnum(ORDER_PAYMENT_METHODS).notNull(),
    amountMinor: bigint({ mode: "number" }).notNull(),
    posSessionId: ulidRef().references(() => posSessions.id),
    createdByUserId: ulidRef().references(() => users.id),
    createdAt: timestamp()
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (t) => [
    index("order_payments_order_id_idx").on(t.orderId),
    index("order_payments_pos_session_id_idx").on(t.posSessionId),
  ],
);

export const ordersRelations = relations(orders, ({ one, many }) => ({
  customer: one(customers, {
    fields: [orders.customerId],
    references: [customers.id],
  }),
  posSession: one(posSessions, {
    fields: [orders.posSessionId],
    references: [posSessions.id],
  }),
  returnOf: one(orders, {
    fields: [orders.returnOfOrderId],
    references: [orders.id],
    relationName: "order_return",
  }),
  returns: many(orders, { relationName: "order_return" }),
  items: many(orderItems),
  payments: many(orderPayments),
}));

export const orderItemsRelations = relations(orderItems, ({ one }) => ({
  order: one(orders, { fields: [orderItems.orderId], references: [orders.id] }),
  variant: one(productVariants, {
    fields: [orderItems.variantId],
    references: [productVariants.id],
  }),
}));

export const orderPaymentsRelations = relations(orderPayments, ({ one }) => ({
  order: one(orders, {
    fields: [orderPayments.orderId],
    references: [orders.id],
  }),
}));
