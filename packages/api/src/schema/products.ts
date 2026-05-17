// Products GraphQL domain: categories, products, variants, price tiers.
// Money fields are integer minor units exposed as Float (safe past 2^31,
// unlike GraphQL Int). Field-level permissions: cost/price/tax edits each
// require their own key on top of `product.edit`.

import { eq } from "drizzle-orm";
import { GraphQLError } from "graphql";
import { productVariants } from "../db/schema/products.ts";
import { requirePermission } from "../lib/authz.ts";
import type { GraphQLContext } from "../lib/context.ts";
import { db } from "../lib/db.ts";
import * as products from "../services/product-service.ts";

export const typeDefs = /* GraphQL */ `
  enum ProductKind { physical service bundle }
  enum PriceMode { tax_inclusive tax_exclusive }
  enum VariantUnit { piece g ml mm }

  type Category {
    id: ID!
    name: String!
    parentId: ID
    minQty: Int
    minMarginBps: Int
    archivedAt: String
    createdAt: String!
  }

  type PriceTier {
    minQty: Float!
    priceMinor: Float!
  }

  type ProductVariant {
    id: ID!
    productId: ID!
    sku: String!
    barcode: String
    label: String
    unit: VariantUnit!
    qtyDecimals: Int!
    priceMinor: Float!
    costMinor: Float!
    totalQty: Float!
    sortOrder: Int!
    priceTiers: [PriceTier!]!
    "Components, if this variant belongs to a kind='bundle' product."
    bundleComponents: [BundleComponent!]!
  }

  "One component of a bundle: a variant and how many units the bundle holds."
  type BundleComponent {
    id: ID!
    bundleVariantId: ID!
    componentVariantId: ID!
    qty: Float!
  }

  input BundleComponentInput {
    componentVariantId: ID!
    qty: Int!
  }

  type Product {
    id: ID!
    "Internal, staff-facing name."
    name: String!
    "Optional public-facing name; null falls back to name."
    publicName: String
    "publicName ?? name — the name to show on receipts and the catalog."
    publicDisplayName: String!
    description: String
    kind: ProductKind!
    categoryId: ID
    taxRateBps: Int!
    priceMode: PriceMode!
    minQty: Int
    minMarginBps: Int
    "Default supplier — the reorder forecast inherits this vendor's lead time."
    primaryVendorId: ID
    "When false, the product is excluded from the reorder forecast."
    replenishMonitored: Boolean!
    archivedAt: String
    createdAt: String!
    variants: [ProductVariant!]!
  }

  input VariantInput {
    "Omit to auto-generate a SKU."
    sku: String
    barcode: String
    label: String
    unit: VariantUnit
    qtyDecimals: Int
    priceMinor: Float!
    costMinor: Float
    sortOrder: Int
  }

  input PriceTierInput {
    minQty: Float!
    priceMinor: Float!
  }

  extend type Query {
    categories: [Category!]!
    products(search: String, includeArchived: Boolean): [Product!]!
    product(id: ID!): Product
  }

  extend type Mutation {
    createCategory(name: String!, parentId: ID, minQty: Int, minMarginBps: Int): Category!
    updateCategory(id: ID!, name: String, parentId: ID, minQty: Int, minMarginBps: Int): Category!
    setCategoryArchived(id: ID!, archived: Boolean!): Category!
    deleteCategory(id: ID!): Boolean!

    createProduct(
      name: String!
      publicName: String
      description: String
      kind: ProductKind
      categoryId: ID
      taxRateBps: Int
      priceMode: PriceMode!
      minQty: Int
      minMarginBps: Int
      primaryVendorId: ID
      replenishMonitored: Boolean
      variants: [VariantInput!]!
    ): Product!
    updateProduct(
      id: ID!
      name: String
      publicName: String
      description: String
      kind: ProductKind
      categoryId: ID
      taxRateBps: Int
      priceMode: PriceMode
      minQty: Int
      minMarginBps: Int
      primaryVendorId: ID
      replenishMonitored: Boolean
    ): Product!
    setProductArchived(id: ID!, archived: Boolean!): Product!
    "Hard delete — root-only. Prefer archiving."
    hardDeleteProduct(id: ID!): Boolean!

    addVariant(productId: ID!, variant: VariantInput!): ProductVariant!
    updateVariant(
      id: ID!
      sku: String
      barcode: String
      label: String
      unit: VariantUnit
      qtyDecimals: Int
      priceMinor: Float
      costMinor: Float
      sortOrder: Int
    ): ProductVariant!
    deleteVariant(id: ID!): Boolean!
    setPriceTiers(variantId: ID!, tiers: [PriceTierInput!]!): [PriceTier!]!
    "Replace a bundle's components wholesale. The variant's product must be kind='bundle'."
    setBundleComponents(
      bundleVariantId: ID!
      components: [BundleComponentInput!]!
    ): [BundleComponent!]!
  }
`;

/** Map a ProductError to a GraphQLError; rethrow anything unexpected. */
function asGraphQLError(e: unknown): never {
  if (e instanceof products.ProductError) {
    throw new GraphQLError(e.message, { extensions: { code: e.code } });
  }
  throw e;
}

const iso = (v: Date | string | null | undefined): string | null =>
  v ? new Date(v).toISOString() : null;

type WithDates = { createdAt: Date | string; archivedAt: Date | string | null };

export const resolvers = {
  Category: {
    createdAt: (c: WithDates) => iso(c.createdAt),
    archivedAt: (c: WithDates) => iso(c.archivedAt),
  },
  Product: {
    createdAt: (p: WithDates) => iso(p.createdAt),
    archivedAt: (p: WithDates) => iso(p.archivedAt),
    publicDisplayName: (p: { name: string; publicName: string | null }) =>
      p.publicName ?? p.name,
    variants: async (p: { id: string; variants?: unknown[] }) => {
      if (Array.isArray(p.variants)) return p.variants;
      return db.select().from(productVariants).where(eq(productVariants.productId, p.id));
    },
  },
  ProductVariant: {
    priceTiers: (v: { id: string }) => products.getPriceTiers(v.id),
    bundleComponents: (v: { id: string }) => products.getBundleComponents(v.id),
  },

  Query: {
    categories: async (_: unknown, __: unknown, ctx: GraphQLContext) => {
      await requirePermission(ctx, "product.edit");
      return products.listCategories();
    },
    products: async (
      _: unknown,
      args: { search?: string | null; includeArchived?: boolean },
      ctx: GraphQLContext,
    ) => {
      await requirePermission(ctx, "product.edit");
      return products.listProducts(args);
    },
    product: async (_: unknown, args: { id: string }, ctx: GraphQLContext) => {
      await requirePermission(ctx, "product.edit");
      try {
        return await products.getProduct(args.id);
      } catch (e) {
        if (e instanceof products.ProductError && e.code === "PRODUCT_NOT_FOUND") return null;
        asGraphQLError(e);
      }
    },
  },

  Mutation: {
    createCategory: async (_: unknown, args: Record<string, unknown>, ctx: GraphQLContext) => {
      await requirePermission(ctx, "product.create");
      try {
        return await products.createCategory(args as never);
      } catch (e) {
        asGraphQLError(e);
      }
    },
    updateCategory: async (
      _: unknown,
      args: { id: string } & Record<string, unknown>,
      ctx: GraphQLContext,
    ) => {
      await requirePermission(ctx, "product.edit");
      const { id, ...patch } = args;
      try {
        return await products.updateCategory(id, patch as never);
      } catch (e) {
        asGraphQLError(e);
      }
    },
    setCategoryArchived: async (
      _: unknown,
      args: { id: string; archived: boolean },
      ctx: GraphQLContext,
    ) => {
      await requirePermission(ctx, "product.archive");
      try {
        return await products.setCategoryArchived(args.id, args.archived);
      } catch (e) {
        asGraphQLError(e);
      }
    },
    deleteCategory: async (
      _: unknown,
      args: { id: string },
      ctx: GraphQLContext,
    ): Promise<boolean> => {
      await requirePermission(ctx, "product.edit");
      try {
        await products.deleteCategory(args.id);
        return true;
      } catch (e) {
        asGraphQLError(e);
      }
    },

    createProduct: async (_: unknown, args: Record<string, unknown>, ctx: GraphQLContext) => {
      const viewer = await requirePermission(ctx, "product.create");
      try {
        return await products.createProduct({
          ...args,
          createdByUserId: viewer.userId,
        } as Parameters<typeof products.createProduct>[0]);
      } catch (e) {
        asGraphQLError(e);
      }
    },
    updateProduct: async (
      _: unknown,
      args: { id: string } & Record<string, unknown>,
      ctx: GraphQLContext,
    ) => {
      await requirePermission(ctx, "product.edit");
      if (args.taxRateBps !== undefined || args.priceMode !== undefined) {
        await requirePermission(ctx, "product.edit_tax");
      }
      const { id, ...patch } = args;
      try {
        return await products.updateProduct(id, patch as never);
      } catch (e) {
        asGraphQLError(e);
      }
    },
    setProductArchived: async (
      _: unknown,
      args: { id: string; archived: boolean },
      ctx: GraphQLContext,
    ) => {
      await requirePermission(ctx, "product.archive");
      try {
        return await products.setProductArchived(args.id, args.archived);
      } catch (e) {
        asGraphQLError(e);
      }
    },
    hardDeleteProduct: async (
      _: unknown,
      args: { id: string },
      ctx: GraphQLContext,
    ): Promise<boolean> => {
      await requirePermission(ctx, "product.hard_delete");
      try {
        await products.hardDeleteProduct(args.id);
        return true;
      } catch (e) {
        asGraphQLError(e);
      }
    },

    addVariant: async (
      _: unknown,
      args: { productId: string; variant: products.VariantInput },
      ctx: GraphQLContext,
    ) => {
      await requirePermission(ctx, "product.edit");
      try {
        return await products.addVariant(args.productId, args.variant);
      } catch (e) {
        asGraphQLError(e);
      }
    },
    updateVariant: async (
      _: unknown,
      args: { id: string } & Record<string, unknown>,
      ctx: GraphQLContext,
    ) => {
      await requirePermission(ctx, "product.edit");
      if (args.priceMinor !== undefined) await requirePermission(ctx, "product.edit_price");
      if (args.costMinor !== undefined) await requirePermission(ctx, "product.edit_cost");
      const { id, ...patch } = args;
      try {
        return await products.updateVariant(id, patch as never);
      } catch (e) {
        asGraphQLError(e);
      }
    },
    deleteVariant: async (
      _: unknown,
      args: { id: string },
      ctx: GraphQLContext,
    ): Promise<boolean> => {
      await requirePermission(ctx, "product.edit");
      try {
        await products.deleteVariant(args.id);
        return true;
      } catch (e) {
        asGraphQLError(e);
      }
    },
    setPriceTiers: async (
      _: unknown,
      args: { variantId: string; tiers: { minQty: number; priceMinor: number }[] },
      ctx: GraphQLContext,
    ) => {
      await requirePermission(ctx, "product.edit_price");
      try {
        return await products.setPriceTiers(args.variantId, args.tiers);
      } catch (e) {
        asGraphQLError(e);
      }
    },
    setBundleComponents: async (
      _: unknown,
      args: {
        bundleVariantId: string;
        components: { componentVariantId: string; qty: number }[];
      },
      ctx: GraphQLContext,
    ) => {
      await requirePermission(ctx, "product.edit");
      try {
        return await products.setBundleComponents(args.bundleVariantId, args.components);
      } catch (e) {
        asGraphQLError(e);
      }
    },
  },
};
