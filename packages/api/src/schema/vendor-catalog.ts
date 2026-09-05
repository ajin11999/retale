// Vendor catalog GraphQL domain: the vendor-pricelist reference DB. Rows are
// reference-only (never sellable SKUs); an optional link to a product variant
// powers PO creation and cross-vendor price compare. File ingest previews via
// the multipart POST /catalog-imports route; the clerk confirms through
// `confirmCatalogImport` here.

import { GraphQLError } from "graphql";
import { requirePermission } from "../lib/authz.ts";
import type { GraphQLContext } from "../lib/context.ts";
import { checkLlmHealth } from "../services/catalog-extract-service.ts";
import {
  confirmCatalogImport,
  type AcceptedCatalogRow,
} from "../services/catalog-import-service.ts";
import * as catalog from "../services/vendor-catalog-service.ts";
import * as vendorService from "../services/vendor-service.ts";

export const typeDefs = /* GraphQL */ `
  "One vendor's pricelist row — reference only, never a sellable SKU."
  type VendorCatalogItem {
    id: ID!
    vendorId: ID!
    "The vendor's own SKU / part number; empty when unknown."
    vendorCode: String!
    name: String!
    "Free-text unit as printed (pcs, dus, koli, roll, ...)."
    unitText: String
    "IDR unit price (literal rupiah)."
    priceMinor: Float!
    moq: Int
    leadTimeDays: Int
    validFrom: String
    validTo: String
    isActive: Boolean!
    mappedVariantId: ID
    note: String
    lastSeenAt: String
    archivedAt: String
    createdAt: String!
    updatedAt: String!
    "True when past validTo or unseen for 90+ days."
    isStale: Boolean!
    vendor: Vendor
    mappedVariant: ProductVariant
  }

  type VendorCatalogPrice {
    id: ID!
    itemId: ID!
    priceMinor: Float!
    validFrom: String
    createdAt: String!
  }

  "Audit row for one file → preview → confirm import cycle."
  type VendorCatalogImport {
    id: ID!
    vendorId: ID!
    fileName: String
    status: String!
    rowCount: Int!
    modelUsed: String
    errorCode: String
    errorMessage: String
    createdAt: String!
  }

  "One vendor's price for a variant we stock, cheapest first."
  type CatalogPriceComparison {
    item: VendorCatalogItem!
    vendorName: String!
    stale: Boolean!
  }

  "One accepted row for confirmCatalogImport."
  input CatalogImportRowInput {
    vendorCode: String!
    name: String!
    unitText: String
    priceMinor: Float
    moq: Int
    note: String
    matchedItemId: ID
  }

  "Summary of what a confirm wrote."
  type CatalogImportResult {
    created: Int!
    updated: Int!
    skipped: Int!
  }

  extend type Query {
    "Reference pricelist rows for a vendor."
    catalogItems(vendorId: ID!, search: String, includeArchived: Boolean): [VendorCatalogItem!]!
    catalogItem(id: ID!): VendorCatalogItem
    "Append-only price history for a catalog row."
    catalogPriceHistory(itemId: ID!): [VendorCatalogPrice!]!
    "Cheapest-first catalog prices linked to a variant, across vendors."
    catalogPriceCompare(variantId: ID!): [CatalogPriceComparison!]!
    "Import audit trail for a vendor."
    catalogImports(vendorId: ID!): [VendorCatalogImport!]!
    "True when the configured LLM endpoint answers (Settings page probe)."
    llmHealth: Boolean!
  }

  extend type Mutation {
    createCatalogItem(
      vendorId: ID!
      vendorCode: String
      name: String!
      unitText: String
      priceMinor: Float!
      moq: Int
      leadTimeDays: Int
      validFrom: String
      validTo: String
      mappedVariantId: ID
      note: String
    ): VendorCatalogItem!
    updateCatalogItem(
      id: ID!
      vendorCode: String
      name: String
      unitText: String
      priceMinor: Float
      moq: Int
      leadTimeDays: Int
      validFrom: String
      validTo: String
      isActive: Boolean
      note: String
    ): VendorCatalogItem!
    setCatalogItemArchived(id: ID!, archived: Boolean!): VendorCatalogItem!
    "Permanent delete (reference row only; variant links are SET NULL-safe)."
    hardDeleteCatalogItem(id: ID!): Boolean!
    "Link a catalog row to one of our variants (also upserts the vendor code mapping)."
    linkCatalogItem(id: ID!, variantId: ID!): VendorCatalogItem!
    unlinkCatalogItem(id: ID!): VendorCatalogItem!
    """
    Confirm an import preview: accepted rows with matchedItemId update existing
    items (price change appends history), rows without create new ones.
    """
    confirmCatalogImport(importId: ID!, vendorId: ID!, rows: [CatalogImportRowInput!]!): CatalogImportResult!
  }
`;

/** Map a VendorCatalogError to a GraphQLError; rethrow anything else. */
function asGraphQLError(e: unknown): never {
  if (e instanceof catalog.VendorCatalogError) {
    throw new GraphQLError(e.message, { extensions: { code: e.code } });
  }
  throw e;
}

const iso = (v: Date | string | null | undefined): string | null =>
  v ? new Date(v).toISOString() : null;

type ItemRow = Awaited<ReturnType<typeof catalog.getCatalogItem>>;

export const resolvers = {
  VendorCatalogItem: {
    isStale: (c: ItemRow) => catalog.isCatalogRowStale(c),
    createdAt: (c: ItemRow) => iso(c.createdAt),
    updatedAt: (c: ItemRow) => iso(c.updatedAt),
    lastSeenAt: (c: ItemRow) => iso(c.lastSeenAt),
    archivedAt: (c: ItemRow) => iso(c.archivedAt),
    vendor: (c: ItemRow) => vendorService.getVendor(c.vendorId),
    mappedVariant: async (c: ItemRow) => {
      if (!c.mappedVariantId) return null;
      const { db } = await import("../lib/db.ts");
      const { productVariants } = await import("../db/schema/products.ts");
      const { eq } = await import("drizzle-orm");
      return db.query.productVariants.findFirst({
        where: eq(productVariants.id, c.mappedVariantId),
      });
    },
  },
  VendorCatalogPrice: {
    createdAt: (p: { createdAt: Date | string }) => iso(p.createdAt),
  },
  VendorCatalogImport: {
    createdAt: (i: { createdAt: Date | string }) => iso(i.createdAt),
  },

  Query: {
    catalogItems: async (
      _: unknown,
      args: { vendorId: string; search?: string; includeArchived?: boolean },
      ctx: GraphQLContext,
    ) => {
      await requirePermission(ctx, "vendor.catalog.manage");
      return catalog.listCatalogItems(args.vendorId, {
        search: args.search,
        includeArchived: args.includeArchived ?? false,
      });
    },
    catalogItem: async (_: unknown, args: { id: string }, ctx: GraphQLContext) => {
      await requirePermission(ctx, "vendor.catalog.manage");
      try {
        return await catalog.getCatalogItem(args.id);
      } catch (e) {
        asGraphQLError(e);
      }
    },
    catalogPriceHistory: async (_: unknown, args: { itemId: string }, ctx: GraphQLContext) => {
      await requirePermission(ctx, "vendor.catalog.manage");
      return catalog.listCatalogPriceHistory(args.itemId);
    },
    catalogPriceCompare: async (_: unknown, args: { variantId: string }, ctx: GraphQLContext) => {
      await requirePermission(ctx, "vendor.catalog.manage");
      return catalog.compareCatalogPrices(args.variantId);
    },
    catalogImports: async (_: unknown, args: { vendorId: string }, ctx: GraphQLContext) => {
      await requirePermission(ctx, "vendor.catalog.manage");
      return catalog.listCatalogImports(args.vendorId);
    },
    llmHealth: async (_: unknown, _args: unknown, ctx: GraphQLContext) => {
      await requirePermission(ctx, "vendor.catalog.manage");
      return checkLlmHealth();
    },
  },

  Mutation: {
    createCatalogItem: async (
      _: unknown,
      args: {
        vendorId: string;
        vendorCode?: string;
        name: string;
        unitText?: string;
        priceMinor: number;
        moq?: number;
        leadTimeDays?: number;
        validFrom?: string;
        validTo?: string;
        mappedVariantId?: string;
        note?: string;
      },
      ctx: GraphQLContext,
    ) => {
      const viewer = await requirePermission(ctx, "vendor.catalog.manage");
      try {
        return await catalog.createCatalogItem(args, viewer.userId);
      } catch (e) {
        asGraphQLError(e);
      }
    },
    updateCatalogItem: async (
      _: unknown,
      args: { id: string } & catalog.UpdateCatalogItemInput,
      ctx: GraphQLContext,
    ) => {
      const viewer = await requirePermission(ctx, "vendor.catalog.manage");
      try {
        const { id, ...patch } = args;
        return await catalog.updateCatalogItem(id, patch, viewer.userId);
      } catch (e) {
        asGraphQLError(e);
      }
    },
    setCatalogItemArchived: async (
      _: unknown,
      args: { id: string; archived: boolean },
      ctx: GraphQLContext,
    ) => {
      await requirePermission(ctx, "vendor.catalog.manage");
      try {
        return await catalog.setCatalogItemArchived(args.id, args.archived);
      } catch (e) {
        asGraphQLError(e);
      }
    },
    hardDeleteCatalogItem: async (
      _: unknown,
      args: { id: string },
      ctx: GraphQLContext,
    ): Promise<boolean> => {
      await requirePermission(ctx, "vendor.hard_delete");
      try {
        await catalog.hardDeleteCatalogItem(args.id);
        return true;
      } catch (e) {
        asGraphQLError(e);
      }
    },
    linkCatalogItem: async (
      _: unknown,
      args: { id: string; variantId: string },
      ctx: GraphQLContext,
    ) => {
      await requirePermission(ctx, "vendor.catalog.manage");
      try {
        return await catalog.linkCatalogItem(args.id, args.variantId);
      } catch (e) {
        asGraphQLError(e);
      }
    },
    unlinkCatalogItem: async (_: unknown, args: { id: string }, ctx: GraphQLContext) => {
      await requirePermission(ctx, "vendor.catalog.manage");
      try {
        return await catalog.unlinkCatalogItem(args.id);
      } catch (e) {
        asGraphQLError(e);
      }
    },
    confirmCatalogImport: async (
      _: unknown,
      args: { importId: string; vendorId: string; rows: AcceptedCatalogRow[] },
      ctx: GraphQLContext,
    ) => {
      const viewer = await requirePermission(ctx, "vendor.catalog.import");
      try {
        return await confirmCatalogImport(
          { importId: args.importId, vendorId: args.vendorId, rows: args.rows ?? [] },
          viewer.userId,
        );
      } catch (e) {
        asGraphQLError(e);
      }
    },
  },
};
