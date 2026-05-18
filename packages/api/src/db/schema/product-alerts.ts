// Product alerts: acknowledgeable signals about a product's pricing health —
// the margin-threshold system from docs/design-decisions.md → "Product
// alerts". Raised by a scan, never auto-closed: an alert stays open until a
// person acknowledges it, even if the underlying numbers recover.

import { relations } from "drizzle-orm";
import { index, json, mysqlEnum, mysqlTable, text, timestamp } from "drizzle-orm/mysql-core";
import { users } from "./auth.ts";
import { products } from "./products.ts";
import { ulidPk, ulidRef } from "./_helpers.ts";

/**
 * `low_margin` — a variant's margin is below the product/category threshold.
 * `negative_margin` — price is below cost (sells at a loss).
 * `negative_price` — price is negative (data error).
 * `data_anomaly` — cost is negative (data error).
 */
export const PRODUCT_ALERT_TYPES = [
  "low_margin",
  "negative_margin",
  "negative_price",
  "data_anomaly",
] as const;

/**
 * One alert about a product. `triggerContext` snapshots the offending
 * variants and the threshold at trigger time. At most one *open* alert per
 * `(productId, type)` — enforced by the raising scan (MariaDB has no partial
 * unique index).
 */
export const productAlerts = mysqlTable(
  "product_alerts",
  {
    id: ulidPk(),
    productId: ulidRef()
      .notNull()
      .references(() => products.id, { onDelete: "cascade" }),
    type: mysqlEnum(PRODUCT_ALERT_TYPES).notNull(),
    triggeredAt: timestamp()
      .notNull()
      .$defaultFn(() => new Date()),
    triggerContext: json(),
    acknowledgedAt: timestamp(),
    acknowledgedByUserId: ulidRef().references(() => users.id),
    resolutionNote: text(),
  },
  (t) => [
    index("product_alerts_product_id_idx").on(t.productId),
    index("product_alerts_type_idx").on(t.type),
  ],
);

export const productAlertsRelations = relations(productAlerts, ({ one }) => ({
  product: one(products, {
    fields: [productAlerts.productId],
    references: [products.id],
  }),
  acknowledgedBy: one(users, {
    fields: [productAlerts.acknowledgedByUserId],
    references: [users.id],
  }),
}));
