// Stock transfers domain: a stateful document for moving stock between
// locations. Lifecycle is draft → dispatched (stock leaves source) → received
// (stock arrives at target); a transfer may be cancelled before it is
// received. Status is derived from the timestamps, never stored. The stock
// itself moves through the `stock_movements` ledger (transfer_out / transfer_in
// rows) — see services/transfer-service.ts.

import { relations } from "drizzle-orm";
import { bigint, index, mysqlTable, timestamp, varchar } from "drizzle-orm/mysql-core";
import { users } from "./auth.ts";
import { locations } from "./locations.ts";
import { productVariants } from "./products.ts";
import { timestamps, ulidPk, ulidRef } from "./_helpers.ts";

/**
 * A stock transfer document. `dispatchedAt` / `receivedAt` / `cancelledAt`
 * encode the lifecycle; the service derives the status from them. Source and
 * target use `restrict` on delete — a location cannot be removed while a
 * transfer references it.
 */
export const stockTransfers = mysqlTable(
  "stock_transfers",
  {
    id: ulidPk(),
    sourceLocationId: ulidRef()
      .notNull()
      .references(() => locations.id, { onDelete: "restrict" }),
    targetLocationId: ulidRef()
      .notNull()
      .references(() => locations.id, { onDelete: "restrict" }),
    notes: varchar({ length: 500 }),
    dispatchedAt: timestamp(),
    receivedAt: timestamp(),
    cancelledAt: timestamp(),
    cancellationReason: varchar({ length: 255 }),
    createdByUserId: ulidRef().references(() => users.id),
    dispatchedByUserId: ulidRef().references(() => users.id),
    receivedByUserId: ulidRef().references(() => users.id),
    cancelledByUserId: ulidRef().references(() => users.id),
    ...timestamps,
  },
  (t) => [
    index("stock_transfers_source_location_id_idx").on(t.sourceLocationId),
    index("stock_transfers_target_location_id_idx").on(t.targetLocationId),
  ],
);

/** One line of a transfer: a variant and the quantity to move (positive). */
export const stockTransferItems = mysqlTable(
  "stock_transfer_items",
  {
    id: ulidPk(),
    transferId: ulidRef()
      .notNull()
      .references(() => stockTransfers.id, { onDelete: "cascade" }),
    variantId: ulidRef()
      .notNull()
      .references(() => productVariants.id, { onDelete: "restrict" }),
    qty: bigint({ mode: "number" }).notNull(),
  },
  (t) => [index("stock_transfer_items_transfer_id_idx").on(t.transferId)],
);

export const stockTransfersRelations = relations(stockTransfers, ({ one, many }) => ({
  sourceLocation: one(locations, {
    fields: [stockTransfers.sourceLocationId],
    references: [locations.id],
    relationName: "transfer_source",
  }),
  targetLocation: one(locations, {
    fields: [stockTransfers.targetLocationId],
    references: [locations.id],
    relationName: "transfer_target",
  }),
  items: many(stockTransferItems),
}));

export const stockTransferItemsRelations = relations(stockTransferItems, ({ one }) => ({
  transfer: one(stockTransfers, {
    fields: [stockTransferItems.transferId],
    references: [stockTransfers.id],
  }),
  variant: one(productVariants, {
    fields: [stockTransferItems.variantId],
    references: [productVariants.id],
  }),
}));
