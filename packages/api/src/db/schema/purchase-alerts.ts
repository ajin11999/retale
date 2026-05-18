// Purchase alerts: acknowledgeable signals about a purchase order. A sibling
// to the (locked, product-keyed) `product_alerts` design — purchase-scoped
// because the only type so far, `delivery_overdue`, is about a whole PO, not
// one product. Raised by a scan, never auto-closed: an alert stays open until
// a person acknowledges it. See docs/future-features.md → "No-delivery
// reminder alert" and docs/design-decisions.md → "Product alerts".

import { relations } from "drizzle-orm";
import { index, json, mysqlEnum, mysqlTable, text, timestamp } from "drizzle-orm/mysql-core";
import { users } from "./auth.ts";
import { purchases } from "./purchases.ts";
import { ulidPk, ulidRef } from "./_helpers.ts";

/**
 * `delivery_overdue` — a sent PO past due with stock still owed.
 * `send_due` — a draft PO whose "send by" date has arrived, still unsent.
 */
export const PURCHASE_ALERT_TYPES = ["delivery_overdue", "send_due"] as const;

/**
 * One alert about a purchase. `triggerContext` snapshots the values that
 * justified the alert at trigger time (so the dashboard can explain it even
 * after the world moves on). At most one *open* alert per `(purchaseId, type)`
 * — enforced by the raising scan, since MariaDB has no partial unique index.
 */
export const purchaseAlerts = mysqlTable(
  "purchase_alerts",
  {
    id: ulidPk(),
    purchaseId: ulidRef()
      .notNull()
      .references(() => purchases.id, { onDelete: "cascade" }),
    type: mysqlEnum(PURCHASE_ALERT_TYPES).notNull(),
    triggeredAt: timestamp()
      .notNull()
      .$defaultFn(() => new Date()),
    triggerContext: json(),
    acknowledgedAt: timestamp(),
    acknowledgedByUserId: ulidRef().references(() => users.id),
    resolutionNote: text(),
  },
  (t) => [
    index("purchase_alerts_purchase_id_idx").on(t.purchaseId),
    index("purchase_alerts_type_idx").on(t.type),
  ],
);

export const purchaseAlertsRelations = relations(purchaseAlerts, ({ one }) => ({
  purchase: one(purchases, {
    fields: [purchaseAlerts.purchaseId],
    references: [purchases.id],
  }),
  acknowledgedBy: one(users, {
    fields: [purchaseAlerts.acknowledgedByUserId],
    references: [users.id],
  }),
}));
