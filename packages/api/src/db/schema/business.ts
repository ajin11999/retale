// Business settings: a single-row table of business-level configuration —
// the business's identity (shown in a rendered purchase order's header) and
// the configurable greeting / footer wrapped around the PO message body.
// Accessed as a singleton; see business-service.ts.

import { mysqlTable, text, varchar } from "drizzle-orm/mysql-core";
import { timestamps, ulidPk } from "./_helpers.ts";

/**
 * The one business-settings row. `name` / `phone` / `email` identify the
 * business on a sent purchase order; `poGreeting` / `poFooter` are the
 * configurable template text the PO message body is wrapped in.
 * `receiptGreeting` / `receiptFooter` are the customer-facing equivalents
 * wrapped around a sent order receipt.
 */
export const businessSettings = mysqlTable("business_settings", {
  id: ulidPk(),
  name: varchar({ length: 200 }).notNull().default(""),
  phone: varchar({ length: 50 }),
  email: varchar({ length: 200 }),
  // Public Blob URL of the business logo (PNG), shown on the PO letterhead.
  logoUrl: varchar({ length: 500 }),
  poGreeting: text(),
  poFooter: text(),
  receiptGreeting: text(),
  receiptFooter: text(),
  ...timestamps,
});
