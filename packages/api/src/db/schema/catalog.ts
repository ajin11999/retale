// Online catalog domain: the publish log. The catalog itself is a static
// JSON snapshot served by a separate app — nothing about it lives in this
// database except this audit trail of when a snapshot was built and pushed.
// See docs/future-features.md → "Online catalog website".

import { relations } from "drizzle-orm";
import { int, mysqlEnum, mysqlTable, text, timestamp, varchar } from "drizzle-orm/mysql-core";
import { users } from "./auth.ts";
import { ulidPk, ulidRef } from "./_helpers.ts";

/** A publish is `manual` (a clerk pressed publish) or `scheduled` (the daily job). */
export const CATALOG_PUBLISH_TRIGGERS = ["manual", "scheduled"] as const;

/** Whether the snapshot build + push succeeded. */
export const CATALOG_PUBLISH_STATUSES = ["success", "error"] as const;

/**
 * One catalog publish attempt. Lets the admin see when the live catalog last
 * refreshed and whether it worked. `snapshotVersion` is the published
 * snapshot's id (also its filename on storage); null on a failed build.
 * `publishedByUserId` is null for the scheduled job — it runs as the system.
 */
export const catalogPublishes = mysqlTable("catalog_publishes", {
  id: ulidPk(),
  trigger: mysqlEnum(CATALOG_PUBLISH_TRIGGERS).notNull(),
  status: mysqlEnum(CATALOG_PUBLISH_STATUSES).notNull(),
  productCount: int().notNull().default(0),
  snapshotVersion: varchar({ length: 26 }),
  errorMessage: text(),
  publishedByUserId: ulidRef().references(() => users.id),
  createdAt: timestamp()
    .notNull()
    .$defaultFn(() => new Date()),
});

export const catalogPublishesRelations = relations(catalogPublishes, ({ one }) => ({
  publishedBy: one(users, {
    fields: [catalogPublishes.publishedByUserId],
    references: [users.id],
  }),
}));
