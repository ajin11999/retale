// Address book: our own ship-to locations (stores, warehouses). A purchase
// order's "Ship To" block is filled from one of these — chosen per vendor
// (`vendors.defaultShipToAddressId`) or falling back to the row flagged
// `isDefault`. The address body is a single free-text block, matching how
// `vendors.address` is stored; the renderer wraps it as-is.

import { boolean, index, mysqlTable, text, timestamp, varchar } from "drizzle-orm/mysql-core";
import { users } from "./auth.ts";
import { timestamps, ulidPk, ulidRef } from "./_helpers.ts";

/**
 * One of the business's ship-to addresses. `label` names it ("Main Store",
 * "Gudang Cakung"); `line` is the free-text postal block; `recipientName` /
 * `phone` are the receiving contact. At most one row should carry
 * `isDefault` — enforced by the service, not the schema. Soft-archived rather
 * than deleted when it has been used as a vendor default (the FK is SET NULL,
 * but archiving keeps the record around).
 */
export const addresses = mysqlTable(
  "addresses",
  {
    id: ulidPk(),
    label: varchar({ length: 200 }).notNull(),
    recipientName: varchar({ length: 300 }),
    phone: varchar({ length: 50 }),
    // Free-text postal block (multi-line allowed).
    line: text().notNull(),
    notes: text(),
    // The fallback ship-to when a vendor has no explicit default. Service keeps
    // at most one row true.
    isDefault: boolean().notNull().default(false),
    archivedAt: timestamp(),
    createdByUserId: ulidRef().references(() => users.id),
    ...timestamps,
  },
  (t) => [index("addresses_archived_at_idx").on(t.archivedAt)],
);
