// Vendor variant code GraphQL domain: manage the vendor-part-number ↔ variant
// mapping. The receiving scan and reorder scan consume it internally; this
// surface is the staff-facing CRUD for maintaining it.

import { eq } from "drizzle-orm";
import { GraphQLError } from "graphql";
import { productVariants } from "../db/schema/products.ts";
import { requirePermission } from "../lib/authz.ts";
import type { GraphQLContext } from "../lib/context.ts";
import { db } from "../lib/db.ts";
import * as codes from "../services/vendor-variant-code-service.ts";
import * as vendorService from "../services/vendor-service.ts";

export const typeDefs = /* GraphQL */ `
  "A vendor's own part number for one of our product variants."
  type VendorVariantCode {
    id: ID!
    vendorId: ID!
    variantId: ID!
    "The vendor's catalogue / part number for the variant."
    code: String!
    "Marks the go-to vendor for this variant — at most one per variant."
    isPreferred: Boolean!
    createdAt: String!
    updatedAt: String!
    vendor: Vendor
    variant: ProductVariant
  }

  extend type Query {
    "Every variant code mapped for a vendor."
    codesForVendor(vendorId: ID!): [VendorVariantCode!]!
    "Every vendor that has a code mapped for a variant."
    codesForVariant(variantId: ID!): [VendorVariantCode!]!
  }

  extend type Mutation {
    "Upsert a vendor's code for a variant. isPreferred true demotes other vendors."
    setVendorVariantCode(
      vendorId: ID!
      variantId: ID!
      code: String!
      isPreferred: Boolean
    ): VendorVariantCode!
    deleteVendorVariantCode(id: ID!): Boolean!
  }
`;

/** Map a VendorVariantCodeError to a GraphQLError; rethrow anything else. */
function asGraphQLError(e: unknown): never {
  if (e instanceof codes.VendorVariantCodeError) {
    throw new GraphQLError(e.message, { extensions: { code: e.code } });
  }
  throw e;
}

const iso = (v: Date | string | null | undefined): string | null =>
  v ? new Date(v).toISOString() : null;

type CodeRow = Awaited<ReturnType<typeof codes.getVendorVariantCode>>;

export const resolvers = {
  VendorVariantCode: {
    createdAt: (c: CodeRow) => iso(c.createdAt),
    updatedAt: (c: CodeRow) => iso(c.updatedAt),
    vendor: (c: CodeRow) => vendorService.getVendor(c.vendorId),
    variant: (c: CodeRow) =>
      db.query.productVariants.findFirst({
        where: eq(productVariants.id, c.variantId),
      }),
  },

  Query: {
    codesForVendor: async (
      _: unknown,
      args: { vendorId: string },
      ctx: GraphQLContext,
    ) => {
      await requirePermission(ctx, "vendor.variant_code.manage");
      return codes.listCodesForVendor(args.vendorId);
    },
    codesForVariant: async (
      _: unknown,
      args: { variantId: string },
      ctx: GraphQLContext,
    ) => {
      await requirePermission(ctx, "vendor.variant_code.manage");
      return codes.listCodesForVariant(args.variantId);
    },
  },

  Mutation: {
    setVendorVariantCode: async (
      _: unknown,
      args: {
        vendorId: string;
        variantId: string;
        code: string;
        isPreferred?: boolean;
      },
      ctx: GraphQLContext,
    ) => {
      await requirePermission(ctx, "vendor.variant_code.manage");
      try {
        return await codes.setVendorVariantCode(args);
      } catch (e) {
        asGraphQLError(e);
      }
    },
    deleteVendorVariantCode: async (
      _: unknown,
      args: { id: string },
      ctx: GraphQLContext,
    ): Promise<boolean> => {
      await requirePermission(ctx, "vendor.variant_code.manage");
      try {
        await codes.deleteVendorVariantCode(args.id);
        return true;
      } catch (e) {
        asGraphQLError(e);
      }
    },
  },
};
