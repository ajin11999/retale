// Locations domain: a hierarchical forest of stock-holding places. Any node
// may hold stock (leaf or branch). Referenced by stock_locations, stock
// movements, and — once built — purchase deliveries, transfers, and POS.
// See docs/design-decisions.md → "Locations".

import { relations } from "drizzle-orm";
import {
  type AnyMySqlColumn,
  index,
  int,
  mysqlTable,
  text,
  timestamp,
  varchar,
} from "drizzle-orm/mysql-core";
import { users } from "./auth.ts";
import { timestamps, ulidPk, ulidRef } from "./_helpers.ts";

/**
 * Forest hierarchy: `parentId IS NULL` marks a root, and many roots are
 * allowed. `parentId` uses `restrict` on delete — a location with children
 * cannot be hard-deleted until they are reparented or removed first.
 */
export const locations = mysqlTable(
  "locations",
  {
    id: ulidPk(),
    parentId: ulidRef().references((): AnyMySqlColumn => locations.id, {
      onDelete: "restrict",
    }),
    name: varchar({ length: 200 }).notNull(),
    code: varchar({ length: 32 }),
    notes: text(),
    archivedAt: timestamp(),
    sortOrder: int().notNull().default(0),
    createdByUserId: ulidRef().references(() => users.id),
    ...timestamps,
  },
  (t) => [
    index("locations_parent_id_idx").on(t.parentId),
    index("locations_archived_at_idx").on(t.archivedAt),
  ],
);

export const locationsRelations = relations(locations, ({ one, many }) => ({
  parent: one(locations, {
    fields: [locations.parentId],
    references: [locations.id],
    relationName: "location_parent",
  }),
  children: many(locations, { relationName: "location_parent" }),
}));
