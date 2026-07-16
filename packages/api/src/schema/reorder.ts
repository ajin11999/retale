// Reorder suggestions GraphQL domain: run the reorder scan, review its
// suggestions, and convert selected ones into draft purchases. The scan and
// conversion are buyer actions (`purchase.create`); reading the list only
// needs report access. See services/reorder-service.ts.

import { GraphQLError } from "graphql";
import { eq } from "drizzle-orm";
import { products, productVariants } from "../db/schema/products.ts";
import { vendors } from "../db/schema/vendors.ts";
import { requirePermission } from "../lib/authz.ts";
import type { GraphQLContext } from "../lib/context.ts";
import { db } from "../lib/db.ts";
import * as reorder from "../services/reorder-service.ts";

export const typeDefs = /* GraphQL */ `
  enum ReorderSuggestionStatus { open converted dismissed }

  type ReorderSuggestion {
    id: ID!
    variantId: ID!
    "Product name of the suggested variant."
    productName: String!
    "SKU of the suggested variant."
    sku: String!
    "Chosen vendor; null means the suggestion is unassigned."
    vendorId: ID
    "Chosen vendor's name; null when unassigned."
    vendorName: String
    "On-hand stock snapshot at scan time."
    currentStock: Float!
    reorderPoint: Float!
    suggestedQty: Float!
    status: ReorderSuggestionStatus!
    generatedAt: String!
  }

  "One selected suggestion to convert, with optional staff overrides."
  input ConvertReorderLineInput {
    suggestionId: ID!
    "Override the suggested quantity."
    qty: Int
    "Override / assign the vendor."
    vendorId: ID
  }

  "One selected suggestion to append to an existing PO, with optional qty override."
  input AddReorderLineInput {
    suggestionId: ID!
    "Override the suggested quantity."
    qty: Int
  }

  type BudgetReorderPlanLine {
    variantId: ID!
    productName: String!
    sku: String!
    suggestedQty: Float!
    estimatedUnitCost: Float!
    estimatedTotalCost: Float!
    vendorId: ID
    vendorName: String
    priorityScore: Float!
    status: String!
  }

  type BudgetReorderPlan {
    totalEstimatedCost: Float!
    remainingBudget: Float!
    lines: [BudgetReorderPlanLine!]!
  }

  extend type Query {
    "Reorder suggestions, newest scan first; optionally filtered by status."
    reorderSuggestions(status: ReorderSuggestionStatus): [ReorderSuggestion!]!
    "Simulate a reorder plan constrained by a specific budget."
    reorderBudgetSandbox(budgetAmount: Float!): BudgetReorderPlan!
  }

  extend type Mutation {
    "Rescan tracked variants and rebuild the open suggestion set."
    runReorderScan: [ReorderSuggestion!]!
    "Convert selected open suggestions into draft purchases (one per vendor)."
    convertReorderSuggestions(lines: [ConvertReorderLineInput!]!): [Purchase!]!
    "Append selected open suggestions as lines on an existing purchase; marks them converted."
    addReorderSuggestionsToPurchase(purchaseId: ID!, lines: [AddReorderLineInput!]!): [PurchaseItem!]!
    "Drop a suggestion from the review list without ordering it."
    dismissReorderSuggestion(id: ID!): ReorderSuggestion!
  }
`;

/** Map a ReorderError to a GraphQLError; rethrow anything unexpected. */
function asGraphQLError(e: unknown): never {
  if (e instanceof reorder.ReorderError) {
    throw new GraphQLError(e.message, { extensions: { code: e.code } });
  }
  throw e;
}

const iso = (v: Date | string | null | undefined): string | null =>
  v ? new Date(v).toISOString() : null;

type SuggestionRow = { variantId: string; vendorId: string | null };

export const resolvers = {
  ReorderSuggestion: {
    generatedAt: (s: { generatedAt: Date | string }) => iso(s.generatedAt),
    productName: async (s: SuggestionRow) => {
      const row = await db
        .select({ name: products.name })
        .from(productVariants)
        .innerJoin(products, eq(productVariants.productId, products.id))
        .where(eq(productVariants.id, s.variantId))
        .limit(1);
      return row[0]?.name ?? "";
    },
    sku: async (s: SuggestionRow) => {
      const row = await db
        .select({ sku: productVariants.sku })
        .from(productVariants)
        .where(eq(productVariants.id, s.variantId))
        .limit(1);
      return row[0]?.sku ?? "";
    },
    vendorName: async (s: SuggestionRow) => {
      if (!s.vendorId) return null;
      const row = await db
        .select({ name: vendors.name })
        .from(vendors)
        .where(eq(vendors.id, s.vendorId))
        .limit(1);
      return row[0]?.name ?? null;
    },
  },

  BudgetReorderPlanLine: {
    productName: async (s: SuggestionRow) => {
      const row = await db.select({ name: products.name }).from(productVariants).innerJoin(products, eq(productVariants.productId, products.id)).where(eq(productVariants.id, s.variantId)).limit(1);
      return row[0]?.name ?? "";
    },
    sku: async (s: SuggestionRow) => {
      const row = await db.select({ sku: productVariants.sku }).from(productVariants).where(eq(productVariants.id, s.variantId)).limit(1);
      return row[0]?.sku ?? "";
    },
    vendorName: async (s: SuggestionRow) => {
      if (!s.vendorId) return null;
      const row = await db.select({ name: vendors.name }).from(vendors).where(eq(vendors.id, s.vendorId)).limit(1);
      return row[0]?.name ?? null;
    },
  },

  Query: {
    reorderSuggestions: async (
      _: unknown,
      args: { status?: "open" | "converted" | "dismissed" },
      ctx: GraphQLContext,
    ) => {
      await requirePermission(ctx, "report.sales.view");
      return reorder.listSuggestions(args.status);
    },
    reorderBudgetSandbox: async (
      _: unknown,
      args: { budgetAmount: number },
      ctx: GraphQLContext,
    ) => {
      await requirePermission(ctx, "purchase.create");
      return reorder.simulateBudgetReorder(args.budgetAmount);
    },
  },

  Mutation: {
    runReorderScan: async (_: unknown, __: unknown, ctx: GraphQLContext) => {
      await requirePermission(ctx, "purchase.create");
      return reorder.runReorderScan();
    },
    convertReorderSuggestions: async (
      _: unknown,
      args: { lines: reorder.ConvertLine[] },
      ctx: GraphQLContext,
    ) => {
      const viewer = await requirePermission(ctx, "purchase.create");
      try {
        return await reorder.convertSuggestions(args.lines, viewer.userId);
      } catch (e) {
        asGraphQLError(e);
      }
    },
    addReorderSuggestionsToPurchase: async (
      _: unknown,
      args: { purchaseId: string; lines: reorder.AddReorderLine[] },
      ctx: GraphQLContext,
    ) => {
      await requirePermission(ctx, "purchase.create");
      try {
        return await reorder.addSuggestionsToPurchase(args.purchaseId, args.lines);
      } catch (e) {
        asGraphQLError(e);
      }
    },
    dismissReorderSuggestion: async (
      _: unknown,
      args: { id: string },
      ctx: GraphQLContext,
    ) => {
      await requirePermission(ctx, "purchase.create");
      try {
        return await reorder.dismissSuggestion(args.id);
      } catch (e) {
        asGraphQLError(e);
      }
    },
  },
};
