// Shared column builders. Every master table reuses these so ID format and
// audit columns stay identical across the schema.

import { sql } from "drizzle-orm";
import { timestamp, varchar } from "drizzle-orm/mysql-core";
import { ulid } from "ulid";

// ULIDs are 26 chars, Crockford base32. Sortable, client-generatable.
export const ID_LENGTH = 26;

/** Primary key column: ULID, generated app-side if the caller omits one. */
export const ulidPk = () =>
  varchar({ length: ID_LENGTH })
    .primaryKey()
    .$defaultFn(() => ulid());

/** Foreign-key / reference column holding a ULID. Caller attaches `.references()`. */
export const ulidRef = () => varchar({ length: ID_LENGTH });

/**
 * Audit timestamps present on every master table (design decision #10).
 * Spread into a table definition: `...timestamps`.
 */
export const timestamps = {
  createdAt: timestamp()
    .notNull()
    .default(sql`CURRENT_TIMESTAMP`),
  updatedAt: timestamp()
    .notNull()
    .default(sql`CURRENT_TIMESTAMP`)
    .$onUpdate(() => sql`CURRENT_TIMESTAMP`),
};
