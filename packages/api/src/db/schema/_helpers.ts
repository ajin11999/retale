// Shared column builders. Every master table reuses these so ID format and
// audit columns stay identical across the schema.

import { sql } from "drizzle-orm";
import { decimal, timestamp, varchar } from "drizzle-orm/mysql-core";
import { ulid } from "ulid";

// ULIDs are 26 chars, Crockford base32. Sortable, client-generatable.
export const ID_LENGTH = 26;

/**
 * A money column. Money is stored as the literal rupiah value in an exact
 * fixed-point `DECIMAL(19,2)` — `10.5` is stored as `10.50`, never scaled into
 * "minor units". `mode: "number"` maps it to a JS `number` on read (writes go
 * out as a string, which mysql2 handles). Use this for every price/cost/amount;
 * change the scale here if the currency's smallest denomination ever changes.
 * Field names keep their historical `*Minor` suffix — they now hold decimals.
 */
export const money = () => decimal({ precision: 19, scale: 2, mode: "number" });

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
