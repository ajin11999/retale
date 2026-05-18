// Online catalog GraphQL domain: per-product catalog settings, the publish
// action, and the publish log. The snapshot build / masking is internal —
// nothing here exposes raw catalog JSON.

import { GraphQLError } from "graphql";
import { requirePermission } from "../lib/authz.ts";
import type { GraphQLContext } from "../lib/context.ts";
import * as catalog from "../services/catalog-service.ts";

export const typeDefs = /* GraphQL */ `
  "How a product's price renders on the online catalog."
  enum OnlinePriceMode { exclude peek show }
  "How a product's stock renders on the online catalog."
  enum OnlineStockMode { show_real peek hide }
  enum CatalogPublishTrigger { manual scheduled }
  enum CatalogPublishStatus { success error }

  extend type Product {
    "Master switch — false means the product is absent from the catalog entirely."
    onlineVisible: Boolean!
    onlinePriceMode: OnlinePriceMode!
    onlineStockMode: OnlineStockMode!
  }

  "One catalog publish attempt — the audit trail of when the live catalog refreshed."
  type CatalogPublish {
    id: ID!
    trigger: CatalogPublishTrigger!
    status: CatalogPublishStatus!
    productCount: Int!
    "The published snapshot's version id; null if the build failed."
    snapshotVersion: String
    errorMessage: String
    publishedByUserId: ID
    createdAt: String!
  }

  extend type Query {
    "Catalog publish history, newest first."
    catalogPublishes(limit: Int): [CatalogPublish!]!
  }

  extend type Mutation {
    "Edit one product's catalog visibility / display modes."
    setProductCatalogSettings(
      id: ID!
      onlineVisible: Boolean
      onlinePriceMode: OnlinePriceMode
      onlineStockMode: OnlineStockMode
    ): Product!
    "Bulk show/hide products on the catalog. Returns the number updated."
    setProductsOnlineVisible(ids: [ID!]!, visible: Boolean!): Int!
    "Build a fresh snapshot and push it to the live catalog."
    publishCatalog: CatalogPublish!
  }
`;

/** Map a CatalogError to a GraphQLError; rethrow anything unexpected. */
function asGraphQLError(e: unknown): never {
  if (e instanceof catalog.CatalogError) {
    throw new GraphQLError(e.message, { extensions: { code: e.code } });
  }
  throw e;
}

const iso = (v: Date | string | null | undefined): string | null =>
  v ? new Date(v).toISOString() : null;

export const resolvers = {
  CatalogPublish: {
    createdAt: (p: { createdAt: Date | string }) => iso(p.createdAt),
  },

  Query: {
    catalogPublishes: async (
      _: unknown,
      args: { limit?: number },
      ctx: GraphQLContext,
    ) => {
      await requirePermission(ctx, "catalog.manage");
      return catalog.listCatalogPublishes(args.limit ?? 50);
    },
  },

  Mutation: {
    setProductCatalogSettings: async (
      _: unknown,
      args: {
        id: string;
        onlineVisible?: boolean;
        onlinePriceMode?: "exclude" | "peek" | "show";
        onlineStockMode?: "show_real" | "peek" | "hide";
      },
      ctx: GraphQLContext,
    ) => {
      await requirePermission(ctx, "catalog.manage");
      const { id, ...patch } = args;
      try {
        return await catalog.setProductCatalogSettings(id, patch);
      } catch (e) {
        asGraphQLError(e);
      }
    },
    setProductsOnlineVisible: async (
      _: unknown,
      args: { ids: string[]; visible: boolean },
      ctx: GraphQLContext,
    ): Promise<number> => {
      await requirePermission(ctx, "catalog.manage");
      try {
        return await catalog.setProductsOnlineVisible(args.ids, args.visible);
      } catch (e) {
        asGraphQLError(e);
      }
    },
    publishCatalog: async (_: unknown, __: unknown, ctx: GraphQLContext) => {
      const viewer = await requirePermission(ctx, "catalog.publish");
      try {
        return await catalog.publishCatalog("manual", viewer.userId);
      } catch (e) {
        asGraphQLError(e);
      }
    },
  },
};
