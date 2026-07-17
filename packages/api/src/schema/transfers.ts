// Stock transfers GraphQL domain: the draft → dispatch → receive lifecycle
// for moving stock between locations, plus cancellation.

import { GraphQLError } from "graphql";
import { requirePermission } from "../lib/authz.ts";
import type { GraphQLContext } from "../lib/context.ts";
import * as transfers from "../services/transfer-service.ts";

export const typeDefs = /* GraphQL */ `
  enum TransferStatus { draft in_transit received cancelled }

  type StockTransfer {
    id: ID!
    targetLocationId: ID!
    status: TransferStatus!
    notes: String
    dispatchedAt: String
    receivedAt: String
    cancelledAt: String
    cancellationReason: String
    createdAt: String!
    items: [StockTransferItem!]!
  }

  type StockTransferItem {
    id: ID!
    transferId: ID!
    sourceLocationId: ID!
    variantId: ID!
    qty: Float!
  }

  input StockTransferItemInput {
    sourceLocationId: ID!
    variantId: ID!
    qty: Int!
  }

  extend type Query {
    stockTransfers(limit: Int): [StockTransfer!]!
    stockTransfer(id: ID!): StockTransfer
  }

  extend type Mutation {
    "Draft a transfer between two locations. Moves no stock yet."
    createStockTransfer(
      targetLocationId: ID!
      items: [StockTransferItemInput!]
      notes: String
    ): StockTransfer!
    "Dispatch a draft — debits stock from the source location."
    dispatchStockTransfer(id: ID!): StockTransfer!
    "Add lines to an existing draft stock transfer."
    addStockTransferItems(id: ID!, items: [StockTransferItemInput!]!): StockTransfer!
    "Remove a line from an existing draft stock transfer."
    removeStockTransferItem(id: ID!, itemId: ID!): StockTransfer!
    "Receive an in-transit transfer — credits stock to the target location."
    receiveStockTransfer(id: ID!): StockTransfer!
    "Cancel a transfer; an in-transit one has its stock returned to source."
    cancelStockTransfer(id: ID!, reason: String!): StockTransfer!
  }
`;

/** Map a TransferError to a GraphQLError; rethrow anything unexpected. */
function asGraphQLError(e: unknown): never {
  if (e instanceof transfers.TransferError) {
    throw new GraphQLError(e.message, { extensions: { code: e.code } });
  }
  throw e;
}

const iso = (v: Date | string | null | undefined): string | null =>
  v ? new Date(v).toISOString() : null;

type TransferRow = Awaited<ReturnType<typeof transfers.getTransfer>>;

export const resolvers = {
  StockTransfer: {
    status: (t: TransferRow) => transfers.transferStatus(t),
    dispatchedAt: (t: { dispatchedAt: Date | string | null }) => iso(t.dispatchedAt),
    receivedAt: (t: { receivedAt: Date | string | null }) => iso(t.receivedAt),
    cancelledAt: (t: { cancelledAt: Date | string | null }) => iso(t.cancelledAt),
    createdAt: (t: { createdAt: Date | string }) => iso(t.createdAt),
    items: (t: { id: string }) => transfers.listTransferItems(t.id),
  },

  Query: {
    stockTransfers: async (
      _: unknown,
      args: { limit?: number },
      ctx: GraphQLContext,
    ) => {
      await requirePermission(ctx, "stock.transfer.create");
      return transfers.listTransfers(args.limit ?? 100);
    },
    stockTransfer: async (
      _: unknown,
      args: { id: string },
      ctx: GraphQLContext,
    ) => {
      await requirePermission(ctx, "stock.transfer.create");
      try {
        return await transfers.getTransfer(args.id);
      } catch (e) {
        if (
          e instanceof transfers.TransferError &&
          e.code === "TRANSFER_NOT_FOUND"
        ) {
          return null;
        }
        asGraphQLError(e);
      }
    },
  },

  Mutation: {
    createStockTransfer: async (
      _: unknown,
      args: {
        targetLocationId: string;
        items?: { variantId: string; qty: number; sourceLocationId: string }[];
        notes?: string | null;
      },
      ctx: GraphQLContext,
    ) => {
      const viewer = await requirePermission(ctx, "stock.transfer.create");
      try {
        return await transfers.createTransfer({
          targetLocationId: args.targetLocationId,
          items: args.items,
          notes: args.notes ?? null,
          createdByUserId: viewer.userId,
        });
      } catch (e) {
        asGraphQLError(e);
      }
    },
    dispatchStockTransfer: async (
      _: unknown,
      args: { id: string },
      ctx: GraphQLContext,
    ) => {
      const viewer = await requirePermission(ctx, "stock.transfer.dispatch");
      try {
        return await transfers.dispatchTransfer(args.id, viewer.userId);
      } catch (e) {
        asGraphQLError(e);
      }
    },
    addStockTransferItems: async (
      _: unknown,
      args: { id: string; items: { variantId: string; qty: number; sourceLocationId: string }[] },
      ctx: GraphQLContext,
    ) => {
      await requirePermission(ctx, "stock.transfer.create");
      try {
        return await transfers.addTransferItems(args.id, args.items);
      } catch (e) {
        asGraphQLError(e);
      }
    },
    removeStockTransferItem: async (
      _: unknown,
      args: { id: string; itemId: string },
      ctx: GraphQLContext,
    ) => {
      await requirePermission(ctx, "stock.transfer.create");
      try {
        return await transfers.removeTransferItem(args.id, args.itemId);
      } catch (e) {
        asGraphQLError(e);
      }
    },
    receiveStockTransfer: async (
      _: unknown,
      args: { id: string },
      ctx: GraphQLContext,
    ) => {
      const viewer = await requirePermission(ctx, "stock.transfer.receive");
      try {
        return await transfers.receiveTransfer(args.id, viewer.userId);
      } catch (e) {
        asGraphQLError(e);
      }
    },
    cancelStockTransfer: async (
      _: unknown,
      args: { id: string; reason: string },
      ctx: GraphQLContext,
    ) => {
      const viewer = await requirePermission(ctx, "stock.transfer.cancel");
      try {
        return await transfers.cancelTransfer(args.id, args.reason, viewer.userId);
      } catch (e) {
        asGraphQLError(e);
      }
    },
  },
};
