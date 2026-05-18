// Journal export GraphQL domain: a balanced, period-bounded double-entry
// journal derived from the existing ledgers, for import into external
// accounting software. Read-only; gated on `report.journal_export`. The
// service returns plain objects matching these types field-for-field, so no
// field resolvers are needed. The `journal.csv` / `summary.csv` flavours are
// served as files by http/journal-csv-route.ts. Money is Float (minor units).

import { requirePermission } from "../lib/authz.ts";
import type { GraphQLContext } from "../lib/context.ts";
import * as journal from "../services/journal-service.ts";

export const typeDefs = /* GraphQL */ `
  "One side of a journal entry — exactly one of debit/credit is nonzero."
  type JournalLine {
    "Account-category key from the fixed catalog (lib/account-categories.ts)."
    accountCategory: String!
    debitMinor: Float!
    creditMinor: Float!
  }

  "A balanced journal entry: the sum of debits equals the sum of credits."
  type JournalEntry {
    "ISO timestamp of the underlying event."
    date: String!
    refType: String!
    refId: ID!
    description: String!
    "'customer', 'vendor', or null for a walk-in / internal event."
    partyType: String
    partyId: ID
    "Snapshot name — survives a hard-deleted party."
    partyName: String
    lines: [JournalLine!]!
  }

  "Monthly debit/credit totals for one account category."
  type JournalSummaryRow {
    "YYYY-MM."
    month: String!
    accountCategory: String!
    debitTotalMinor: Float!
    creditTotalMinor: Float!
  }

  "A non-fatal export issue — an untagged event, an imbalance, an unknown category."
  type JournalWarning {
    kind: String!
    refType: String
    refId: ID
    message: String!
  }

  type JournalExport {
    periodStart: String!
    periodEnd: String!
    entries: [JournalEntry!]!
    "Monthly aggregates by account category."
    summary: [JournalSummaryRow!]!
    "Events that could not be classified, plus any balance-check failures."
    warnings: [JournalWarning!]!
  }

  extend type Query {
    "Balanced double-entry journal for the period, for external accounting."
    journalExport(periodStart: String!, periodEnd: String!): JournalExport!
  }
`;

export const resolvers = {
  Query: {
    journalExport: async (
      _: unknown,
      args: journal.DateRange,
      ctx: GraphQLContext,
    ) => {
      await requirePermission(ctx, "report.journal_export");
      return journal.journalExport(args);
    },
  },
};
