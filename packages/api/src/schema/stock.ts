// Stock GraphQL domain: read per-location stock and the movement ledger,
// post manual adjustments, and override a variant's weighted-average cost.
// Qty and money are Float (integer minor units; Float is safe past 2^31).

import { GraphQLError } from "graphql";
import { requirePermission } from "../lib/authz.ts";
import type { GraphQLContext } from "../lib/context.ts";
import * as stock from "../services/stock-service.ts";

export const typeDefs = /* GraphQL */ `
  enum StockMovementType {
    purchase_receive
    transfer_in
    transfer_out
    sale
    sale_return
    adjustment_in
    adjustment_out
    cost_override
    initial_import
  }

  enum StockRefType { purchase order transfer adjustment override import }

  type StockLocation {
    id: ID!
    variantId: ID!
    locationId: ID
    qty: Float!
  }

  type StockMovement {
    id: ID!
    variantId: ID!
    locationId: ID
    type: StockMovementType!
    qtyDelta: Float!
    unitCost: Float!
    previousCost: Float
    refType: StockRefType!
    refId: ID
    reason: String
    createdAt: String!
  }

  "A variant's on-hand at one location, with naming for the bulk count sheet."
  type LocationStockLevel {
    variantId: ID!
    productId: ID!
    productName: String!
    sku: String!
    label: String
    barcode: String
    unit: VariantUnit!
    qtyDecimals: Int!
    onHand: Float!
  }

  "One line of a bulk count: a variant and its counted on-hand at the location."
  input BulkStockCountInput {
    variantId: ID!
    countedQty: Float!
  }

  extend type ProductVariant {
    "Per-location stock rows for this variant (locationId null = unlocated root)."
    stock: [StockLocation!]!
  }

  extend type Query {
    variantStock(variantId: ID!): [StockLocation!]!
    variantStockMovements(variantId: ID!, limit: Int): [StockMovement!]!
    "Every variant holding stock at a location (locationId null = unlocated root)."
    locationStockLevels(locationId: ID): [LocationStockLevel!]!
  }

  extend type Mutation {
    "Manual stock write-on (positive) or write-off (negative). Reason required."
    adjustStock(variantId: ID!, locationId: ID, qtyDelta: Float!, reason: String!): StockMovement!
    "Snap a variant's weighted-average cost to an exact value."
    overrideVariantCost(variantId: ID!, unitCost: Float!, reason: String): StockMovement!
    """
    Reconcile several variants' on-hand at one location to counted values in one
    transaction (locationId null = unlocated root). Returns the number of lines
    that differed from the current on-hand and were adjusted.
    """
    bulkAdjustStock(locationId: ID, reason: String!, lines: [BulkStockCountInput!]!): Int!
  }
`;

/** Map a StockError to a GraphQLError; rethrow anything unexpected. */
function asGraphQLError(e: unknown): never {
  if (e instanceof stock.StockError) {
    throw new GraphQLError(e.message, { extensions: { code: e.code } });
  }
  throw e;
}

const iso = (v: Date | string | null | undefined): string | null =>
  v ? new Date(v).toISOString() : null;

export const resolvers = {
  StockMovement: {
    createdAt: (m: { createdAt: Date | string }) => iso(m.createdAt),
  },
  ProductVariant: {
    stock: (v: { id: string }) => stock.getVariantStock(v.id),
  },

  Query: {
    variantStock: async (
      _: unknown,
      args: { variantId: string },
      ctx: GraphQLContext,
    ) => {
      await requirePermission(ctx, "product.edit");
      try {
        return await stock.getVariantStock(args.variantId);
      } catch (e) {
        asGraphQLError(e);
      }
    },
    variantStockMovements: async (
      _: unknown,
      args: { variantId: string; limit?: number },
      ctx: GraphQLContext,
    ) => {
      await requirePermission(ctx, "report.cost.view");
      try {
        return await stock.listMovements(args.variantId, args.limit ?? 100);
      } catch (e) {
        asGraphQLError(e);
      }
    },
    locationStockLevels: async (
      _: unknown,
      args: { locationId?: string | null },
      ctx: GraphQLContext,
    ) => {
      await requirePermission(ctx, "stock.adjust");
      return stock.getLocationStockLevels(args.locationId ?? null);
    },
  },

  Mutation: {
    adjustStock: async (
      _: unknown,
      args: { variantId: string; locationId?: string | null; qtyDelta: number; reason: string },
      ctx: GraphQLContext,
    ) => {
      const viewer = await requirePermission(ctx, "stock.adjust");
      try {
        return await stock.adjustStock({
          variantId: args.variantId,
          locationId: args.locationId ?? null,
          qtyDelta: args.qtyDelta,
          reason: args.reason,
          createdByUserId: viewer.userId,
        });
      } catch (e) {
        asGraphQLError(e);
      }
    },
    overrideVariantCost: async (
      _: unknown,
      args: { variantId: string; unitCost: number; reason?: string | null },
      ctx: GraphQLContext,
    ) => {
      const viewer = await requirePermission(ctx, "product.edit_cost");
      try {
        return await stock.overrideCost({
          variantId: args.variantId,
          unitCost: args.unitCost,
          reason: args.reason ?? "",
          createdByUserId: viewer.userId,
        });
      } catch (e) {
        asGraphQLError(e);
      }
    },
    bulkAdjustStock: async (
      _: unknown,
      args: {
        locationId?: string | null;
        reason: string;
        lines: { variantId: string; countedQty: number }[];
      },
      ctx: GraphQLContext,
    ) => {
      const viewer = await requirePermission(ctx, "stock.adjust");
      try {
        return await stock.bulkAdjustStock({
          locationId: args.locationId ?? null,
          reason: args.reason,
          lines: args.lines,
          createdByUserId: viewer.userId,
        });
      } catch (e) {
        asGraphQLError(e);
      }
    },
  },
};
