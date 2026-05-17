// Reorder forecast GraphQL domain: a single read-only query projecting when
// each monitored product needs reordering. Computed live from sales velocity
// and supplier lead time — see services/forecast-service.ts.

import { requirePermission } from "../lib/authz.ts";
import type { GraphQLContext } from "../lib/context.ts";
import * as forecast from "../services/forecast-service.ts";

export const typeDefs = /* GraphQL */ `
  enum ReorderStatus {
    "Order date has passed — place the PO now."
    order_now
    "Order date is within the soon-horizon."
    order_soon
    "Stock is comfortable."
    ok
    "Selling, but the primary vendor has no lead time set."
    insufficient_data
  }

  enum VelocityBasis {
    "Velocity came from the full baseline window."
    baseline
    "Velocity came from the recent window — the product is accelerating."
    recent
    "Nothing is selling."
    none
  }

  type ReorderForecastRow {
    variantId: ID!
    productId: ID!
    productName: String!
    sku: String!
    currentQty: Float!
    "Effective velocity — the higher of the baseline and recent rates."
    velocityPerDay: Float!
    "Net units/day over the full baseline window."
    baselineVelocityPerDay: Float!
    "Net units/day over the recent window."
    recentVelocityPerDay: Float!
    velocityBasis: VelocityBasis!
    "currentQty / velocity; null when nothing is depleting."
    daysOfCover: Float
    leadTimeDays: Int
    "ISO date (YYYY-MM-DD) the PO must be placed by; null when uncomputable."
    orderByDate: String
    status: ReorderStatus!
  }

  extend type Query {
    "Reorder forecast for every monitored physical product variant."
    reorderForecast(
      windowDays: Int
      recentWindowDays: Int
      soonHorizonDays: Int
    ): [ReorderForecastRow!]!
  }
`;

export const resolvers = {
  Query: {
    reorderForecast: async (
      _: unknown,
      args: {
        windowDays?: number;
        recentWindowDays?: number;
        soonHorizonDays?: number;
      },
      ctx: GraphQLContext,
    ) => {
      await requirePermission(ctx, "report.sales.view");
      return forecast.reorderForecast({
        windowDays: args.windowDays,
        recentWindowDays: args.recentWindowDays,
        soonHorizonDays: args.soonHorizonDays,
      });
    },
  },
};
