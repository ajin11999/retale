// Vendors domain: supplier master rows plus an append-only AP ledger
// (`vendor_ledger`). `vendors.balance_minor` is a cached running total of the
// ledger — positive means we owe the vendor. Per-vendor variant-code mapping
// is deferred to the purchases/receiving phase.
// See docs/design-decisions.md → "Vendors".

import { relations, sql } from "drizzle-orm";
import {
  bigint,
  index,
  mysqlEnum,
  mysqlTable,
  text,
  timestamp,
  varchar,
} from "drizzle-orm/mysql-core";
import { users } from "./auth.ts";
import { posSessions } from "./pos.ts";
import { timestamps, ulidPk, ulidRef } from "./_helpers.ts";

/** Ledger event categories. `amount_minor` is positive when we owe more. */
export const VENDOR_LEDGER_TYPES = [
  "purchase_on_account",
  "payment",
  "refund_credit",
  "adjustment",
  "opening_balance",
] as const;

/** Source-document categories a ledger row can point back at via `refId`. */
export const VENDOR_LEDGER_REF_TYPES = [
  "purchase",
  "purchase_delivery",
  "payment",
  "adjustment",
  "import",
] as const;

/**
 * Supplier master row. Contact fields are denormalized and unvalidated — the
 * renderer for sent POs degrades gracefully when phone/email are missing.
 * `balanceMinor` is owned by the ledger writers below; vendor CRUD never sets
 * it. Hard delete is guarded against a non-zero balance.
 */
export const vendors = mysqlTable(
  "vendors",
  {
    id: ulidPk(),
    name: varchar({ length: 300 }).notNull(),
    phone: varchar({ length: 50 }),
    email: varchar({ length: 200 }),
    address: text(),
    taxId: varchar({ length: 100 }),
    notes: text(),
    // Cached sum of vendor_ledger.amount_minor. Positive = we owe them.
    balanceMinor: bigint({ mode: "number" }).notNull().default(0),
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
    index("vendors_archived_at_idx").on(t.archivedAt),
    index("vendors_phone_idx").on(t.phone),
    index("vendors_search_text_idx").on(t.searchText),
  ],
);

/**
 * Append-only AP ledger. Invariant: `vendors.balanceMinor` equals the SUM of
 * this table's `amountMinor` for the vendor, maintained in the same
 * transaction as every insert. `posSessionId` references the cashier shift a
 * cash event belongs to.
 */
export const vendorLedger = mysqlTable(
  "vendor_ledger",
  {
    id: ulidPk(),
    vendorId: ulidRef()
      .notNull()
      .references(() => vendors.id, { onDelete: "cascade" }),
    type: mysqlEnum(VENDOR_LEDGER_TYPES).notNull(),
    // Positive = we owe more (purchase on account); negative = we owe less
    // (payment, credit). Signed so the running balance is a plain SUM.
    amountMinor: bigint({ mode: "number" }).notNull(),
    refType: mysqlEnum(VENDOR_LEDGER_REF_TYPES),
    refId: ulidRef(),
    // Required for `adjustment` rows — checked in the service layer.
    note: text(),
    posSessionId: ulidRef().references(() => posSessions.id),
    createdByUserId: ulidRef().references(() => users.id),
    createdAt: timestamp()
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (t) => [
    index("vendor_ledger_vendor_id_idx").on(t.vendorId),
    index("vendor_ledger_created_at_idx").on(t.createdAt),
  ],
);

export const vendorsRelations = relations(vendors, ({ many }) => ({
  ledger: many(vendorLedger),
}));

export const vendorLedgerRelations = relations(vendorLedger, ({ one }) => ({
  vendor: one(vendors, {
    fields: [vendorLedger.vendorId],
    references: [vendors.id],
  }),
}));
