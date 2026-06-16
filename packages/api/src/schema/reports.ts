// Reports GraphQL domain: read-only aggregations — sales, cost/margin, AR/AP
// aging, cash-drawer variance. Each query is gated on its own report.* key.
// The service returns plain objects matching these types field-for-field, so
// no field resolvers are needed. Money is Float (integer minor units).

import { requirePermission } from "../lib/authz.ts";
import type { GraphQLContext } from "../lib/context.ts";
import * as reports from "../services/report-service.ts";

export const typeDefs = /* GraphQL */ `
  type SalesReportDay {
    date: String!
    orderCount: Int!
    revenueMinor: Float!
  }

  type SalesReport {
    periodStart: String!
    periodEnd: String!
    orderCount: Int!
    "Units sold, in each variant's smallest unit; nets returns."
    itemsSoldQty: Float!
    revenueMinor: Float!
    byDay: [SalesReportDay!]!
  }

  type ProfitReportDay {
    date: String!
    revenueMinor: Float!
    cogsMinor: Float!
  }

  type ProfitReport {
    periodStart: String!
    periodEnd: String!
    revenueMinor: Float!
    "Cost of goods sold — snapshot WAC × qty."
    cogsMinor: Float!
    grossMarginMinor: Float!
    "Gross margin as basis points of revenue; 0 when revenue is 0."
    marginBps: Int!
    byDay: [ProfitReportDay!]!
  }

  "One party's aged outstanding balance."
  type AgingRow {
    partyId: ID!
    partyName: String!
    balanceMinor: Float!
    bucket0_30: Float!
    bucket31_60: Float!
    bucket61_90: Float!
    bucket90plus: Float!
  }

  type AgingReport {
    asOf: String!
    rows: [AgingRow!]!
    totalBalanceMinor: Float!
  }

  type SessionVarianceRow {
    sessionId: ID!
    posCode: String!
    openedAt: String!
    closedAt: String
    openingCashMinor: Float!
    closingCashMinor: Float
    "Null for a force-closed (unreconciled) session."
    varianceMinor: Float
    forceClosed: Boolean!
  }

  type SessionVarianceReport {
    periodStart: String!
    periodEnd: String!
    sessions: [SessionVarianceRow!]!
    totalVarianceMinor: Float!
    unreconciledCount: Int!
  }

  "One variant's units / revenue / cost within a single POS session."
  type SessionVariantSale {
    "Null when the variant was hard-deleted; the snapshot fields still identify it."
    variantId: ID
    productName: String!
    variantLabel: String
    sku: String!
    "Units sold in the variant's smallest unit; nets returns."
    qtySold: Float!
    "Gross revenue — the sale price (price×qty − discount), before any worker cut."
    revenueMinor: Float!
    "COGS — snapshot WAC × qty."
    costMinor: Float!
  }

  extend type Query {
    "Sales volume — orders, units, revenue, by day."
    salesReport(periodStart: String!, periodEnd: String!): SalesReport!
    "Cost / margin — revenue vs COGS over the period."
    profitReport(periodStart: String!, periodEnd: String!): ProfitReport!
    "Customer debt aging as of now."
    arAgingReport: AgingReport!
    "Vendor debt aging as of now."
    apAgingReport: AgingReport!
    "Cash-drawer variance for sessions closed in the period."
    sessionVarianceReport(
      periodStart: String!
      periodEnd: String!
    ): SessionVarianceReport!
    "Per-variant units / revenue / cost for one POS session — gross sale price, a quick lookup (unlike the aggregate reports, it does not net attribution)."
    sessionVariantSales(sessionId: ID!): [SessionVariantSale!]!
  }
`;

export const resolvers = {
  Query: {
    salesReport: async (
      _: unknown,
      args: reports.DateRange,
      ctx: GraphQLContext,
    ) => {
      await requirePermission(ctx, "report.sales.view");
      return reports.salesReport(args);
    },
    profitReport: async (
      _: unknown,
      args: reports.DateRange,
      ctx: GraphQLContext,
    ) => {
      await requirePermission(ctx, "report.margin.view");
      return reports.profitReport(args);
    },
    arAgingReport: async (_: unknown, __: unknown, ctx: GraphQLContext) => {
      await requirePermission(ctx, "report.ar_aging.view");
      return reports.arAgingReport();
    },
    apAgingReport: async (_: unknown, __: unknown, ctx: GraphQLContext) => {
      await requirePermission(ctx, "report.ap_aging.view");
      return reports.apAgingReport();
    },
    sessionVarianceReport: async (
      _: unknown,
      args: reports.DateRange,
      ctx: GraphQLContext,
    ) => {
      await requirePermission(ctx, "report.session_variance.view");
      return reports.sessionVarianceReport(args);
    },
    sessionVariantSales: async (
      _: unknown,
      args: { sessionId: string },
      ctx: GraphQLContext,
    ) => {
      await requirePermission(ctx, "report.margin.view");
      return reports.sessionVariantSales(args.sessionId);
    },
  },
};
