// Workshop settings: a single-row table of workshop-level configuration —
// the workshop's identity (shown in a rendered purchase order's header) and
// the configurable greeting / footer wrapped around the PO message body.
// Accessed as a singleton; see workshop-service.ts.

import { mysqlTable, text, varchar } from "drizzle-orm/mysql-core";
import { timestamps, ulidPk } from "./_helpers.ts";

/**
 * The one workshop-settings row. `name` / `phone` / `email` identify the
 * workshop on a sent purchase order; `poGreeting` / `poFooter` are the
 * configurable template text the PO message body is wrapped in.
 */
export const workshopSettings = mysqlTable("workshop_settings", {
  id: ulidPk(),
  name: varchar({ length: 200 }).notNull().default(""),
  phone: varchar({ length: 50 }),
  email: varchar({ length: 200 }),
  poGreeting: text(),
  poFooter: text(),
  ...timestamps,
});
