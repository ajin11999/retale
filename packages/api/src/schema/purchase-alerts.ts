// Purchase alerts GraphQL domain: list alerts, run the no-delivery scan, and
// acknowledge. `triggerContext` is surfaced as a JSON string — the dashboard
// parses it to explain why an alert fired.

import { GraphQLError } from "graphql";
import { requirePermission } from "../lib/authz.ts";
import type { GraphQLContext } from "../lib/context.ts";
import * as alerts from "../services/purchase-alert-service.ts";
import * as purchaseService from "../services/purchase-service.ts";

export const typeDefs = /* GraphQL */ `
  enum PurchaseAlertType { delivery_overdue }

  "An acknowledgeable signal about a purchase order."
  type PurchaseAlert {
    id: ID!
    purchaseId: ID!
    purchase: Purchase
    type: PurchaseAlertType!
    triggeredAt: String!
    "JSON snapshot of the values that justified the alert at trigger time."
    triggerContext: String
    acknowledgedAt: String
    acknowledgedByUserId: ID
    resolutionNote: String
  }

  extend type Query {
    "Purchase alerts, newest first. acknowledged: true / false / omitted (all)."
    purchaseAlerts(acknowledged: Boolean): [PurchaseAlert!]!
  }

  extend type Mutation {
    "Scan sent-but-undelivered POs and raise overdue alerts. Returns the new alerts."
    scanDeliveryOverdue(graceDays: Int): [PurchaseAlert!]!
    "Acknowledge an alert — a person has seen it."
    acknowledgePurchaseAlert(id: ID!, resolutionNote: String): PurchaseAlert!
  }
`;

/** Map a PurchaseAlertError to a GraphQLError; rethrow anything unexpected. */
function asGraphQLError(e: unknown): never {
  if (e instanceof alerts.PurchaseAlertError) {
    throw new GraphQLError(e.message, { extensions: { code: e.code } });
  }
  throw e;
}

const iso = (v: Date | string | null | undefined): string | null =>
  v ? new Date(v).toISOString() : null;

type AlertRow = Awaited<ReturnType<typeof alerts.getPurchaseAlert>>;

export const resolvers = {
  PurchaseAlert: {
    triggeredAt: (a: AlertRow) => iso(a.triggeredAt),
    acknowledgedAt: (a: AlertRow) => iso(a.acknowledgedAt),
    // The json column can read back as a string or a parsed object — hand the
    // client a string either way.
    triggerContext: (a: AlertRow) =>
      a.triggerContext == null
        ? null
        : typeof a.triggerContext === "string"
          ? a.triggerContext
          : JSON.stringify(a.triggerContext),
    purchase: async (a: AlertRow) => {
      try {
        return await purchaseService.getPurchase(a.purchaseId);
      } catch {
        return null;
      }
    },
  },

  Query: {
    purchaseAlerts: async (
      _: unknown,
      args: { acknowledged?: boolean },
      ctx: GraphQLContext,
    ) => {
      await requirePermission(ctx, "alert.acknowledge");
      return alerts.listPurchaseAlerts(
        args.acknowledged === undefined ? {} : { acknowledged: args.acknowledged },
      );
    },
  },

  Mutation: {
    scanDeliveryOverdue: async (
      _: unknown,
      args: { graceDays?: number },
      ctx: GraphQLContext,
    ) => {
      await requirePermission(ctx, "purchase.edit");
      try {
        return await alerts.raiseDeliveryOverdueAlerts(
          args.graceDays ?? alerts.DEFAULT_GRACE_DAYS,
        );
      } catch (e) {
        asGraphQLError(e);
      }
    },
    acknowledgePurchaseAlert: async (
      _: unknown,
      args: { id: string; resolutionNote?: string | null },
      ctx: GraphQLContext,
    ) => {
      const viewer = await requirePermission(ctx, "alert.acknowledge");
      try {
        return await alerts.acknowledgePurchaseAlert({
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
