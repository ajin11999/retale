// Deliveries GraphQL domain: draft a goods receipt, edit its hierarchical cost
// tree, and commit it — the only operation in the API that turns a purchase
// order into stock. Money / qty are Float (integer minor units / smallest-unit
// counts; Float is exact past 2^31).

import { GraphQLError } from "graphql";
import { requirePermission } from "../lib/authz.ts";
import type { GraphQLContext } from "../lib/context.ts";
import * as deliveries from "../services/delivery-service.ts";
import * as locations from "../services/location-service.ts";

export const typeDefs = /* GraphQL */ `
  enum DeliveryStatus { draft delivered cancelled }

  type PurchaseDelivery {
    id: ID!
    date: String!
    biller: String
    targetLocationId: ID!
    targetLocation: Location
    "Set when this delivery is a receiving check tied to a single purchase."
    purchaseId: ID
    status: DeliveryStatus!
    deliveredAt: String
    "Denormalized sum of the cost tree's root nodes — for list views."
    totalCostMinor: Float!
    createdAt: String!
    updatedAt: String!
    items: [PurchaseDeliveryItem!]!
  }

  type PurchaseDeliveryItem {
    id: ID!
    deliveryId: ID!
    "Null on a root node; otherwise the cost-tree parent."
    parentItemId: ID
    "Set only on a leaf — the purchase line this node receives against."
    purchaseItemId: ID
    description: String!
    "Set only on a leaf; in the variant's smallest unit."
    qty: Float
    costMinor: Float!
    sortOrder: Int!
  }

  extend type Query {
    deliveries(status: DeliveryStatus): [PurchaseDelivery!]!
    delivery(id: ID!): PurchaseDelivery
  }

  extend type Mutation {
    createDelivery(date: String!, biller: String, targetLocationId: ID!): PurchaseDelivery!
    updateDelivery(
      id: ID!
      date: String
      biller: String
      targetLocationId: ID
    ): PurchaseDelivery!
    "Discard a draft delivery and its cost tree."
    deleteDelivery(id: ID!): Boolean!

    createDeliveryItem(
      deliveryId: ID!
      parentItemId: ID
      purchaseItemId: ID
      description: String!
      qty: Float
      costMinor: Float!
      sortOrder: Int
    ): PurchaseDeliveryItem!
    updateDeliveryItem(
      id: ID!
      description: String
      qty: Float
      costMinor: Float
      sortOrder: Int
    ): PurchaseDeliveryItem!
    deleteDeliveryItem(id: ID!): Boolean!

    "Commit a draft delivery: receives stock, recomputes WAC, advances the PO."
    commitDelivery(id: ID!): PurchaseDelivery!
    "Reverse a delivered delivery (root only). Stock returns; WAC is not re-valued."
    cancelDelivery(id: ID!): PurchaseDelivery!
  }
`;

/** Map a DeliveryError to a GraphQLError; rethrow anything unexpected. */
function asGraphQLError(e: unknown): never {
  if (e instanceof deliveries.DeliveryError) {
    throw new GraphQLError(e.message, { extensions: { code: e.code } });
  }
  throw e;
}

const iso = (v: Date | string | null | undefined): string | null =>
  v ? new Date(v).toISOString() : null;

type DeliveryRow = Awaited<ReturnType<typeof deliveries.getDelivery>>;

export const resolvers = {
  PurchaseDelivery: {
    createdAt: (d: DeliveryRow) => iso(d.createdAt),
    updatedAt: (d: DeliveryRow) => iso(d.updatedAt),
    deliveredAt: (d: DeliveryRow) => iso(d.deliveredAt),
    targetLocation: (d: DeliveryRow) => locations.getLocation(d.targetLocationId),
    items: (d: DeliveryRow) => deliveries.listDeliveryItems(d.id),
  },

  Query: {
    deliveries: async (
      _: unknown,
      args: { status?: DeliveryRow["status"] },
      ctx: GraphQLContext,
    ) => {
      await requirePermission(ctx, "delivery.draft");
      return deliveries.listDeliveries(args.status);
    },
    delivery: async (_: unknown, args: { id: string }, ctx: GraphQLContext) => {
      await requirePermission(ctx, "delivery.draft");
      try {
        return await deliveries.getDelivery(args.id);
      } catch (e) {
        if (e instanceof deliveries.DeliveryError && e.code === "DELIVERY_NOT_FOUND") {
          return null;
        }
        asGraphQLError(e);
      }
    },
  },

  Mutation: {
    createDelivery: async (
      _: unknown,
      args: { date: string; biller?: string | null; targetLocationId: string },
      ctx: GraphQLContext,
    ) => {
      const viewer = await requirePermission(ctx, "delivery.draft");
      try {
        return await deliveries.createDelivery({
          date: args.date,
          biller: args.biller ?? null,
          targetLocationId: args.targetLocationId,
          createdByUserId: viewer.userId,
        });
      } catch (e) {
        asGraphQLError(e);
      }
    },
    updateDelivery: async (
      _: unknown,
      args: { id: string } & Record<string, unknown>,
      ctx: GraphQLContext,
    ) => {
      await requirePermission(ctx, "delivery.draft");
      const { id, ...patch } = args;
      try {
        return await deliveries.updateDelivery(id, patch as never);
      } catch (e) {
        asGraphQLError(e);
      }
    },
    deleteDelivery: async (
      _: unknown,
      args: { id: string },
      ctx: GraphQLContext,
    ): Promise<boolean> => {
      await requirePermission(ctx, "delivery.draft");
      try {
        await deliveries.deleteDelivery(args.id);
        return true;
      } catch (e) {
        asGraphQLError(e);
      }
    },

    createDeliveryItem: async (
      _: unknown,
      args: Record<string, unknown>,
      ctx: GraphQLContext,
    ) => {
      await requirePermission(ctx, "delivery.draft");
      try {
        return await deliveries.createDeliveryItem(
          args as Parameters<typeof deliveries.createDeliveryItem>[0],
        );
      } catch (e) {
        asGraphQLError(e);
      }
    },
    updateDeliveryItem: async (
      _: unknown,
      args: { id: string } & Record<string, unknown>,
      ctx: GraphQLContext,
    ) => {
      await requirePermission(ctx, "delivery.draft");
      const { id, ...patch } = args;
      try {
        return await deliveries.updateDeliveryItem(id, patch as never);
      } catch (e) {
        asGraphQLError(e);
      }
    },
    deleteDeliveryItem: async (
      _: unknown,
      args: { id: string },
      ctx: GraphQLContext,
    ): Promise<boolean> => {
      await requirePermission(ctx, "delivery.draft");
      try {
        await deliveries.deleteDeliveryItem(args.id);
        return true;
      } catch (e) {
        asGraphQLError(e);
      }
    },

    commitDelivery: async (_: unknown, args: { id: string }, ctx: GraphQLContext) => {
      const viewer = await requirePermission(ctx, "delivery.commit");
      try {
        return await deliveries.commitDelivery(args.id, viewer.userId);
      } catch (e) {
        asGraphQLError(e);
      }
    },
    cancelDelivery: async (_: unknown, args: { id: string }, ctx: GraphQLContext) => {
      const viewer = await requirePermission(ctx, "delivery.cancel");
      try {
        return await deliveries.cancelDelivery(args.id, viewer.userId);
      } catch (e) {
        asGraphQLError(e);
      }
    },
  },
};
