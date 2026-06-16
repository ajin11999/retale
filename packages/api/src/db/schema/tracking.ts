// Tracking accounts domain: internal subsidiary accounts for money owed
// to/from non-customer-non-vendor parties — mechanics, staff, partners, owner
// draws, internal funds. Structurally a sibling of customer_ledger /
// vendor_ledger: a hierarchical named entity, a cached balance, and an
// append-only per-event ledger. See docs/design-decisions.md → "Tracking
// accounts".

import { relations } from "drizzle-orm";
import {
  type AnyMySqlColumn,
  foreignKey,
  index,
  mysqlEnum,
  mysqlTable,
  text,
  timestamp,
  varchar,
} from "drizzle-orm/mysql-core";
import { users } from "./auth.ts";
import { posSessions } from "./pos.ts";
import { money, timestamps, ulidPk, ulidRef } from "./_helpers.ts";

/** Ledger event categories. `amount_minor` is positive when the balance grows. */
export const TRACKING_LEDGER_TYPES = [
  "attribution",
  "payout",
  "deposit",
  "adjustment",
  "opening_balance",
] as const;

/** Source-document categories a ledger row can point back at via `refId`. */
export const TRACKING_LEDGER_REF_TYPES = [
  "order_item",
  "order",
  // A bulked attribution row covering a whole POS session — `refId` is the
  // session id. POS attribution posts one row per account per session, not per
  // line item; see postBulkAttribution in order-service.ts.
  "pos_session",
  "manual",
  "import",
  "adjustment",
] as const;

/**
 * A named bucket money flows through. The hierarchy is a forest (any number of
 * roots); `parentId` uses `restrict` on delete. `accountCategory` is the
 * balance side and `counterCategory` the offsetting side used when an
 * attribution posts — both carry the accounting meaning explicitly, so there
 * is no `kind` enum. `balanceMinor` is owned by the ledger writers; CRUD never
 * sets it. Positive balance = the business owes the account.
 */
export const trackingAccounts = mysqlTable(
  "tracking_accounts",
  {
    id: ulidPk(),
    parentId: ulidRef().references((): AnyMySqlColumn => trackingAccounts.id, {
      onDelete: "restrict",
    }),
    name: varchar({ length: 300 }).notNull(),
    code: varchar({ length: 64 }),
    accountCategory: varchar({ length: 100 }).notNull(),
    counterCategory: varchar({ length: 100 }).notNull(),
    notes: text(),
    balanceMinor: money().notNull().default(0),
    archivedAt: timestamp(),
    createdByUserId: ulidRef().references(() => users.id),
    ...timestamps,
  },
  (t) => [
    index("tracking_accounts_parent_id_idx").on(t.parentId),
    index("tracking_accounts_archived_at_idx").on(t.archivedAt),
  ],
);

/**
 * Append-only ledger. Invariant: `trackingAccounts.balanceMinor` equals the
 * SUM of this table's `amountMinor` for the account, maintained in the same
 * transaction as every insert. `counterCategoryOverride` lets an adjustment
 * hit a different offsetting category than the account's default.
 */
export const trackingAccountLedger = mysqlTable(
  "tracking_account_ledger",
  {
    id: ulidPk(),
    // FK named explicitly: the drizzle-derived name would exceed MariaDB's
    // 64-char identifier limit. See `tracking_account_ledger_account_id_fk` below.
    trackingAccountId: ulidRef().notNull(),
    type: mysqlEnum(TRACKING_LEDGER_TYPES).notNull(),
    // Positive = balance increases (attribution, deposit).
    amountMinor: money().notNull(),
    refType: mysqlEnum(TRACKING_LEDGER_REF_TYPES),
    refId: ulidRef(),
    counterCategoryOverride: varchar({ length: 100 }),
    // Required for `adjustment` rows — checked in the service layer.
    note: text(),
    posSessionId: ulidRef().references(() => posSessions.id),
    createdByUserId: ulidRef().references(() => users.id),
    createdAt: timestamp()
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (t) => [
    foreignKey({
      name: "tracking_account_ledger_account_id_fk",
      columns: [t.trackingAccountId],
      foreignColumns: [trackingAccounts.id],
    }).onDelete("cascade"),
    index("tracking_account_ledger_account_id_idx").on(
      t.trackingAccountId,
      t.createdAt,
    ),
    index("tracking_account_ledger_ref_idx").on(t.refType, t.refId),
  ],
);

export const trackingAccountsRelations = relations(
  trackingAccounts,
  ({ one, many }) => ({
    parent: one(trackingAccounts, {
      fields: [trackingAccounts.parentId],
      references: [trackingAccounts.id],
      relationName: "tracking_account_parent",
    }),
    children: many(trackingAccounts, {
      relationName: "tracking_account_parent",
    }),
    ledger: many(trackingAccountLedger),
  }),
);

export const trackingAccountLedgerRelations = relations(
  trackingAccountLedger,
  ({ one }) => ({
    account: one(trackingAccounts, {
      fields: [trackingAccountLedger.trackingAccountId],
      references: [trackingAccounts.id],
    }),
  }),
);
