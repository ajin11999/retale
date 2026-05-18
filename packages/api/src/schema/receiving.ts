// Receiving check GraphQL domain: the resumable goods-in workflow over a
// single purchase. A check is a draft `PurchaseDelivery` (purchaseId set);
// these resolvers start/resume it, save counted lines as staff go, resolve
// scans, and commit. Commit and the cost machinery live in the deliveries
// domain — this is the purchase-scoped front door. Money / qty are Float
// (integer minor units / smallest-unit counts).

import { GraphQLError } from "graphql";
import { requirePermission } from "../lib/authz.ts";
import type { GraphQLContext } from "../lib/context.ts";
import { DeliveryError } from "../services/delivery-service.ts";
import * as receiving from "../services/receiving-service.ts";

export const typeDefs = /* GraphQL */ `
  "Completeness of a purchase line: counted nothing / some / all that was ordered."
  enum ReceivingLineStatus { not_started partial complete }

  "A purchase line as the receiving screen sees it, with the open draft folded in."
  type ReceivingCheckLine {
    purchaseItem: PurchaseItem!
    qtyOrdered: Float!
    "Qty received by already-committed deliveries."
    qtyDelivered: Float!
    "qtyOrdered − qtyDelivered: what is still owed before this check."
    remaining: Float!
    "Qty staged in the open draft check (this box), 0 if untouched."
    qtyInCheck: Float!
    "Completeness from committed deliveries only."
    status: ReceivingLineStatus!
    "Completeness once the draft commits — folds in qtyInCheck."
    provisionalStatus: ReceivingLineStatus!
  }

  extend type Query {
    "The open (draft) receiving check for a purchase, or null if none is in progress."
    openReceivingCheck(purchaseId: ID!): PurchaseDelivery
    "Every purchase line with ordered / delivered / remaining and completeness."
    receivingCheckLines(purchaseId: ID!): [ReceivingCheckLine!]!
    "Resolve a scanned barcode / SKU to the purchase line(s) it counts against."
    resolveReceivingScan(purchaseId: ID!, code: String!): [PurchaseItem!]!
  }

  extend type Mutation {
    "Start a receiving check for a purchase, or resume the one already open."
    startReceivingCheck(purchaseId: ID!, targetLocationId: ID!): PurchaseDelivery!
    "Upsert one counted line; qty 0 removes it. Save-as-you-go."
    setReceivingCheckLine(
      deliveryId: ID!
      purchaseItemId: ID!
      qty: Float!
    ): PurchaseDelivery!
    "Commit the check: draft → delivered, receiving stock via the delivery commit."
    commitReceivingCheck(deliveryId: ID!): PurchaseDelivery!
  }
`;

/** Map a Receiving / Delivery error to a GraphQLError; rethrow anything else. */
function asGraphQLError(e: unknown): never {
  if (e instanceof receiving.ReceivingError || e instanceof DeliveryError) {
    throw new GraphQLError(e.message, { extensions: { code: e.code } });
  }
  throw e;
}

export const resolvers = {
  Query: {
    openReceivingCheck: async (
      _: unknown,
      args: { purchaseId: string },
      ctx: GraphQLContext,
    ) => {
      await requirePermission(ctx, "delivery.draft");
      return (await receiving.getOpenCheck(args.purchaseId)) ?? null;
    },
    receivingCheckLines: async (
      _: unknown,
      args: { purchaseId: string },
      ctx: GraphQLContext,
    ) => {
      await requirePermission(ctx, "delivery.draft");
      try {
        return await receiving.getReceivingCheckLines(args.purchaseId);
      } catch (e) {
        asGraphQLError(e);
      }
    },
    resolveReceivingScan: async (
      _: unknown,
      args: { purchaseId: string; code: string },
      ctx: GraphQLContext,
    ) => {
      await requirePermission(ctx, "delivery.draft");
      try {
        return await receiving.resolveReceivingScan(args.purchaseId, args.code);
      } catch (e) {
        asGraphQLError(e);
      }
    },
  },

  Mutation: {
    startReceivingCheck: async (
      _: unknown,
      args: { purchaseId: string; targetLocationId: string },
      ctx: GraphQLContext,
    ) => {
      const viewer = await requirePermission(ctx, "delivery.draft");
      try {
        return await receiving.startReceivingCheck({
          purchaseId: args.purchaseId,
          targetLocationId: args.targetLocationId,
          userId: viewer.userId,
        });
      } catch (e) {
        asGraphQLError(e);
      }
    },
    setReceivingCheckLine: async (
      _: unknown,
      args: { deliveryId: string; purchaseItemId: string; qty: number },
      ctx: GraphQLContext,
    ) => {
      await requirePermission(ctx, "delivery.draft");
      try {
        return await receiving.setReceivingCheckLine(args);
      } catch (e) {
        asGraphQLError(e);
      }
    },
    commitReceivingCheck: async (
      _: unknown,
      args: { deliveryId: string },
      ctx: GraphQLContext,
    ) => {
      const viewer = await requirePermission(ctx, "delivery.commit");
      try {
        return await receiving.commitReceivingCheck(args.deliveryId, viewer.userId);
      } catch (e) {
        asGraphQLError(e);
      }
    },
  },

};
