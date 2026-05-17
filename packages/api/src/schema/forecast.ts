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

  type ReorderForecastRow {
    variantId: ID!
    productId: ID!
    productName: String!
    sku: String!
    currentQty: Float!
    "Average net units sold per day over the velocity window."
    velocityPerDay: Float!
    "currentQty / velocity; null when nothing is depleting."
    daysOfCover: Float
    leadTimeDays: Int
    "ISO date (YYYY-MM-DD) the PO must be placed by; null when uncomputable."
    orderByDate: String
    status: ReorderStatus!
  }

  extend type Query {
    "Reorder forecast for every monitored physical product variant."
    reorderForecast(windowDays: Int, soonHorizonDays: Int): [ReorderForecastRow!]!
  }
`;

export const resolvers = {
  Query: {
    reorderForecast: async (
      _: unknown,
      args: { windowDays?: number; soonHorizonDays?: number },
      ctx: GraphQLContext,
    ) => {
      await requirePermission(ctx, "report.sales.view");
      return forecast.reorderForecast({
        windowDays: args.windowDays,
        soonHorizonDays: args.soonHorizonDays,
      });
    },
  },
};
