// Product image GraphQL domain: read the gallery, delete and reorder images.
// Uploading is not here — that is the multipart POST /product-images route,
// the natural transport for a binary file.

import { GraphQLError } from "graphql";
import { requirePermission } from "../lib/authz.ts";
import type { GraphQLContext } from "../lib/context.ts";
import * as images from "../services/product-image-service.ts";

export const typeDefs = /* GraphQL */ `
  "A product's catalog gallery image — optimized WebP on Vercel Blob."
  type ProductImage {
    id: ID!
    productId: ID!
    "≤1280px image for the product detail page."
    detailUrl: String!
    "≤400px image for catalog grid cards."
    thumbnailUrl: String!
    width: Int!
    height: Int!
    "0 is the primary image (the card thumbnail)."
    sortOrder: Int!
    createdAt: String!
  }

  extend type Product {
    "Gallery images, ordered; sortOrder 0 first."
    images: [ProductImage!]!
  }

  extend type Query {
    productImages(productId: ID!): [ProductImage!]!
  }

  extend type Mutation {
    deleteProductImage(id: ID!): Boolean!
    "Renumber a product's images to the given id order (0-based)."
    reorderProductImages(productId: ID!, orderedIds: [ID!]!): [ProductImage!]!
  }
`;

/** Map an ImageError to a GraphQLError; rethrow anything unexpected. */
function asGraphQLError(e: unknown): never {
  if (e instanceof images.ImageError) {
    throw new GraphQLError(e.message, { extensions: { code: e.code } });
  }
  throw e;
}

const iso = (v: Date | string | null | undefined): string | null =>
  v ? new Date(v).toISOString() : null;

export const resolvers = {
  ProductImage: {
    createdAt: (i: { createdAt: Date | string }) => iso(i.createdAt),
  },

  Product: {
    images: (p: { id: string }) => images.listProductImages(p.id),
  },

  Query: {
    productImages: async (
      _: unknown,
      args: { productId: string },
      ctx: GraphQLContext,
    ) => {
      await requirePermission(ctx, "product.edit");
      return images.listProductImages(args.productId);
    },
  },

  Mutation: {
    deleteProductImage: async (
      _: unknown,
      args: { id: string },
      ctx: GraphQLContext,
    ): Promise<boolean> => {
      await requirePermission(ctx, "product.edit");
      try {
        await images.deleteProductImage(args.id);
        return true;
      } catch (e) {
        asGraphQLError(e);
      }
    },
    reorderProductImages: async (
      _: unknown,
      args: { productId: string; orderedIds: string[] },
      ctx: GraphQLContext,
    ) => {
      await requirePermission(ctx, "product.edit");
      try {
        return await images.reorderProductImages(args.productId, args.orderedIds);
      } catch (e) {
        asGraphQLError(e);
      }
    },
  },
};
