// Product alerts GraphQL domain: list alerts, run the margin scan, acknowledge.
// `triggerContext` is surfaced as a JSON string the dashboard parses to show
// which variants breached and by how much.

import { GraphQLError } from "graphql";
import { requirePermission } from "../lib/authz.ts";
import type { GraphQLContext } from "../lib/context.ts";
import * as alerts from "../services/product-alert-service.ts";
import * as productService from "../services/product-service.ts";

export const typeDefs = /* GraphQL */ `
  enum ProductAlertType { low_margin negative_margin negative_price data_anomaly }

  "An acknowledgeable signal about a product's pricing health."
  type ProductAlert {
    id: ID!
    productId: ID!
    product: Product
    type: ProductAlertType!
    triggeredAt: String!
    "JSON snapshot of the breaching variants + threshold at trigger time."
    triggerContext: String
    acknowledgedAt: String
    acknowledgedByUserId: ID
    resolutionNote: String
  }

  extend type Query {
    "Product alerts, newest first. acknowledged: true / false / omitted (all)."
    productAlerts(acknowledged: Boolean): [ProductAlert!]!
  }

  extend type Mutation {
    "Scan every product's margins and raise new alerts. Returns the new alerts."
    scanProductAlerts: [ProductAlert!]!
    "Acknowledge an alert — a person has seen it."
    acknowledgeProductAlert(id: ID!, resolutionNote: String): ProductAlert!
  }
`;

/** Map a ProductAlertError to a GraphQLError; rethrow anything unexpected. */
function asGraphQLError(e: unknown): never {
  if (e instanceof alerts.ProductAlertError) {
    throw new GraphQLError(e.message, { extensions: { code: e.code } });
  }
  throw e;
}

const iso = (v: Date | string | null | undefined): string | null =>
  v ? new Date(v).toISOString() : null;

type AlertRow = Awaited<ReturnType<typeof alerts.getProductAlert>>;

export const resolvers = {
  ProductAlert: {
    triggeredAt: (a: AlertRow) => iso(a.triggeredAt),
    acknowledgedAt: (a: AlertRow) => iso(a.acknowledgedAt),
    triggerContext: (a: AlertRow) =>
      a.triggerContext == null
        ? null
        : typeof a.triggerContext === "string"
          ? a.triggerContext
          : JSON.stringify(a.triggerContext),
    product: async (a: AlertRow) => {
      try {
        return await productService.getProduct(a.productId);
      } catch {
        return null;
      }
    },
  },

  Query: {
    productAlerts: async (
      _: unknown,
      args: { acknowledged?: boolean },
      ctx: GraphQLContext,
    ) => {
      await requirePermission(ctx, "alert.acknowledge");
      return alerts.listProductAlerts(
        args.acknowledged === undefined ? {} : { acknowledged: args.acknowledged },
      );
    },
  },

  Mutation: {
    scanProductAlerts: async (_: unknown, __: unknown, ctx: GraphQLContext) => {
      await requirePermission(ctx, "product.edit");
      try {
        return await alerts.scanProductAlerts();
      } catch (e) {
        asGraphQLError(e);
      }
    },
    acknowledgeProductAlert: async (
      _: unknown,
      args: { id: string; resolutionNote?: string | null },
      ctx: GraphQLContext,
    ) => {
      const viewer = await requirePermission(ctx, "alert.acknowledge");
      try {
        return await alerts.acknowledgeProductAlert({
          id: args.id,
          userId: viewer.userId,
          resolutionNote: args.resolutionNote ?? null,
        });
      } catch (e) {
        asGraphQLError(e);
      }
    },
  },
};
