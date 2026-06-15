// POS domain: physical registers (`points_of_sale`) and cashier shifts
// (`pos_sessions`). A session reconciles the cash drawer at close and groups
// orders/payments for reporting. See docs/design-decisions.md → "Points of
// Sale" and "POS sessions".

import { relations, sql } from "drizzle-orm";
import {
  boolean,
  index,
  json,
  mysqlTable,
  text,
  timestamp,
  unique,
  varchar,
} from "drizzle-orm/mysql-core";
import { users } from "./auth.ts";
import { locations } from "./locations.ts";
import { money, timestamps, ulidPk, ulidRef } from "./_helpers.ts";

/**
 * Physical register / checkout terminal, bound to the location where its cash
 * drawer sits. `code` is short (1–4 chars) and unique — it prefixes
 * `orders.display_number`. Many POS may share one location. An archived POS
 * cannot open new sessions but keeps all history.
 */
export const pointsOfSale = mysqlTable(
  "points_of_sale",
  {
    id: ulidPk(),
    locationId: ulidRef()
      .notNull()
      .references(() => locations.id, { onDelete: "restrict" }),
    code: varchar({ length: 16 }).notNull().unique(),
    name: varchar({ length: 200 }).notNull(),
    notes: text(),
    archivedAt: timestamp(),
    createdByUserId: ulidRef().references(() => users.id),
    ...timestamps,
  },
  (t) => [
    index("points_of_sale_location_id_idx").on(t.locationId),
    index("points_of_sale_archived_at_idx").on(t.archivedAt),
  ],
);

/**
 * Cashier shift. One cashier owns a session start to finish. Variance is
 * computed and stored at close, never blocked. `forceClosed` rows leave
 * `closingCashMinor`/`varianceMinor` null so reports show "unreconciled".
 *
 * "One open session per POS" — MariaDB has no partial unique index, so
 * `openPosId` is a generated column equal to `posId` while the session is
 * open and NULL once closed. A UNIQUE index on it rejects a second open
 * session (NULLs never collide). Same generated-column constraints as
 * elsewhere: unqualified column refs, no NOT NULL.
 */
export const posSessions = mysqlTable(
  "pos_sessions",
  {
    id: ulidPk(),
    posId: ulidRef()
      .notNull()
      .references(() => pointsOfSale.id, { onDelete: "restrict" }),
    openedByUserId: ulidRef()
      .notNull()
      .references(() => users.id),
    openedAt: timestamp()
      .notNull()
      .$defaultFn(() => new Date()),
    openingCashMinor: money().notNull(),
    closedByUserId: ulidRef().references(() => users.id),
    closedAt: timestamp(),
    // Null when force-closed.
    closingCashMinor: money(),
    varianceMinor: money(),
    forceClosed: boolean().notNull().default(false),
    // Denormalized totals snapshot, written at close.
    zReportJson: json(),
    notes: text(),
    // posId while open, NULL once closed — see table comment.
    openPosId: ulidRef().generatedAlwaysAs(
      sql`if(\`closed_at\` is null, \`pos_id\`, null)`,
      { mode: "stored" },
    ),
    ...timestamps,
  },
  (t) => [
    index("pos_sessions_pos_id_idx").on(t.posId),
    index("pos_sessions_opened_by_user_id_idx").on(t.openedByUserId),
    unique("pos_sessions_one_open_per_pos_unique").on(t.openPosId),
  ],
);

export const pointsOfSaleRelations = relations(pointsOfSale, ({ one, many }) => ({
  location: one(locations, {
    fields: [pointsOfSale.locationId],
    references: [locations.id],
  }),
  sessions: many(posSessions),
}));

export const posSessionsRelations = relations(posSessions, ({ one }) => ({
  pos: one(pointsOfSale, {
    fields: [posSessions.posId],
    references: [pointsOfSale.id],
  }),
}));
