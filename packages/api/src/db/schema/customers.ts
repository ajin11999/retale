// Customers domain: customer master rows, an append-only AR ledger
// (`customer_ledger`), and per-customer variant price overrides
// (`customer_prices`). `customers.balanceMinor` is a cached running total of
// the ledger — positive means the customer owes us.
// See docs/design-decisions.md → "Customers" and "Payments & customer debt".

import { relations, sql } from "drizzle-orm";
import {
  bigint,
  index,
  mysqlEnum,
  mysqlTable,
  text,
  timestamp,
  unique,
  varchar,
} from "drizzle-orm/mysql-core";
import { users } from "./auth.ts";
import { productVariants } from "./products.ts";
import { timestamps, ulidPk, ulidRef } from "./_helpers.ts";

/** Ledger event categories. `amount_minor` is positive when the customer owes more. */
export const CUSTOMER_LEDGER_TYPES = [
  "sale_on_account",
  "payment",
  "refund_credit",
  "adjustment",
  "opening_balance",
] as const;

/** Source-document categories a ledger row can point back at via `refId`. */
export const CUSTOMER_LEDGER_REF_TYPES = [
  "order",
  "order_item",
  "payment",
  "refund",
  "adjustment",
  "import",
] as const;

/**
 * Customer master row. Contact fields are denormalized and unvalidated — a
 * workshop customer is "Pak Budi" first, a phone number maybe. `balanceMinor`
 * is owned by the ledger writers below; customer CRUD never sets it.
 * `creditLimitMinor` is null when the customer has no limit. Hard delete is
 * guarded against a non-zero balance (root may still override later, once the
 * orders domain supplies the "no non-cancelled orders" half of the rule).
 */
export const customers = mysqlTable(
  "customers",
  {
    id: ulidPk(),
    name: varchar({ length: 300 }).notNull(),
    phone: varchar({ length: 50 }),
    email: varchar({ length: 200 }),
    address: text(),
    notes: text(),
    // Cached sum of customer_ledger.amount_minor. Positive = they owe us.
    balanceMinor: bigint({ mode: "number" }).notNull().default(0),
    // null = no credit limit.
    creditLimitMinor: bigint({ mode: "number" }),
    archivedAt: timestamp(),
    createdByUserId: ulidRef().references(() => users.id),
    // Lowercased name + phone for LIKE search. Stored + indexed; same MariaDB
    // generated-column constraints as products.searchText (unqualified column
    // names, no NOT NULL).
    searchText: varchar({ length: 400 }).generatedAlwaysAs(
      sql`lower(concat(\`name\`, ' ', coalesce(\`phone\`, '')))`,
      { mode: "stored" },
    ),
    ...timestamps,
  },
  (t) => [
    index("customers_archived_at_idx").on(t.archivedAt),
    index("customers_phone_idx").on(t.phone),
    index("customers_search_text_idx").on(t.searchText),
  ],
);

/**
 * Append-only AR ledger. Invariant: `customers.balanceMinor` equals the SUM of
 * this table's `amountMinor` for the customer, maintained in the same
 * transaction as every insert. `posSessionId` carries no FK yet — the POS
 * sessions domain is not built; the constraint is added when it is.
 */
export const customerLedger = mysqlTable(
  "customer_ledger",
  {
    id: ulidPk(),
    customerId: ulidRef()
      .notNull()
      .references(() => customers.id, { onDelete: "cascade" }),
    type: mysqlEnum(CUSTOMER_LEDGER_TYPES).notNull(),
    // Positive = the customer owes more (sale on account); negative = they owe
    // less (payment, credit). Signed so the running balance is a plain SUM.
    amountMinor: bigint({ mode: "number" }).notNull(),
    refType: mysqlEnum(CUSTOMER_LEDGER_REF_TYPES),
    refId: ulidRef(),
    // Required for `adjustment` rows — checked in the service layer.
    note: text(),
    // FK to pos_sessions is added when that domain is built.
    posSessionId: ulidRef(),
    createdByUserId: ulidRef().references(() => users.id),
    createdAt: timestamp()
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (t) => [
    index("customer_ledger_customer_id_idx").on(t.customerId),
    index("customer_ledger_created_at_idx").on(t.createdAt),
  ],
);

/**
 * Per-customer price override for a specific variant. Keyed on
 * `(customerId, variantId)`; resolves above qty-tier and base price (see
 * docs/design-decisions.md → "Pricing layers"). Both sides cascade-delete.
 */
export const customerPrices = mysqlTable(
  "customer_prices",
  {
    id: ulidPk(),
    customerId: ulidRef()
      .notNull()
      .references(() => customers.id, { onDelete: "cascade" }),
    variantId: ulidRef()
      .notNull()
      .references(() => productVariants.id, { onDelete: "cascade" }),
    priceMinor: bigint({ mode: "number" }).notNull(),
    ...timestamps,
  },
  (t) => [
    unique("customer_prices_customer_variant_unique").on(t.customerId, t.variantId),
    index("customer_prices_variant_id_idx").on(t.variantId),
  ],
);

export const customersRelations = relations(customers, ({ many }) => ({
  ledger: many(customerLedger),
  prices: many(customerPrices),
}));

export const customerLedgerRelations = relations(customerLedger, ({ one }) => ({
  customer: one(customers, {
    fields: [customerLedger.customerId],
    references: [customers.id],
  }),
}));

export const customerPricesRelations = relations(customerPrices, ({ one }) => ({
  customer: one(customers, {
    fields: [customerPrices.customerId],
    references: [customers.id],
  }),
  variant: one(productVariants, {
    fields: [customerPrices.variantId],
    references: [productVariants.id],
  }),
}));
