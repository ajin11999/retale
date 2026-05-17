// Vendors GraphQL domain: supplier CRUD, archive, root-only hard delete, and
// the two AP ledger writers (record payment, adjust balance). Money is Float
// (integer minor units; Float is exact past 2^31).

import { GraphQLError } from "graphql";
import { requirePermission } from "../lib/authz.ts";
import type { GraphQLContext } from "../lib/context.ts";
import * as vendors from "../services/vendor-service.ts";

export const typeDefs = /* GraphQL */ `
  enum VendorLedgerType {
    purchase_on_account
    payment
    refund_credit
    adjustment
    opening_balance
  }

  enum VendorLedgerRefType { purchase purchase_delivery payment adjustment import }

  type Vendor {
    id: ID!
    name: String!
    phone: String
    email: String
    address: String
    taxId: String
    notes: String
    "Typical delivery lead time in days; feeds the reorder forecast."
    leadTimeDays: Int
    "Cached AP balance, minor units. Positive = we owe the vendor."
    balanceMinor: Float!
    archivedAt: String
    createdAt: String!
    updatedAt: String!
  }

  type VendorLedgerEntry {
    id: ID!
    vendorId: ID!
    type: VendorLedgerType!
    "Signed minor units. Positive = we owe more; negative = we owe less."
    amountMinor: Float!
    refType: VendorLedgerRefType
    refId: ID
    note: String
    posSessionId: ID
    createdAt: String!
  }

  extend type Query {
    vendors(includeArchived: Boolean): [Vendor!]!
    vendor(id: ID!): Vendor
    vendorLedger(vendorId: ID!, limit: Int): [VendorLedgerEntry!]!
  }

  extend type Mutation {
    createVendor(
      name: String!
      phone: String
      email: String
      address: String
      taxId: String
      notes: String
      leadTimeDays: Int
    ): Vendor!
    updateVendor(
      id: ID!
      name: String
      phone: String
      email: String
      address: String
      taxId: String
      notes: String
      leadTimeDays: Int
    ): Vendor!
    setVendorArchived(id: ID!, archived: Boolean!): Vendor!
    "Hard delete — root-only. Refused if the vendor carries a non-zero AP balance."
    hardDeleteVendor(id: ID!): Boolean!
    "Record a payment to a vendor. amountMinor is the positive sum paid."
    recordVendorPayment(
      vendorId: ID!
      amountMinor: Float!
      posSessionId: ID
      note: String
    ): Vendor!
    "Root-only manual balance correction. Signed amountMinor; note required."
    adjustVendorBalance(vendorId: ID!, amountMinor: Float!, note: String!): Vendor!
  }
`;

/** Map a VendorError to a GraphQLError; rethrow anything unexpected. */
function asGraphQLError(e: unknown): never {
  if (e instanceof vendors.VendorError) {
    throw new GraphQLError(e.message, { extensions: { code: e.code } });
  }
  throw e;
}

const iso = (v: Date | string | null | undefined): string | null =>
  v ? new Date(v).toISOString() : null;

export const resolvers = {
  Vendor: {
    createdAt: (v: { createdAt: Date | string }) => iso(v.createdAt),
    updatedAt: (v: { updatedAt: Date | string }) => iso(v.updatedAt),
    archivedAt: (v: { archivedAt: Date | string | null }) => iso(v.archivedAt),
  },
  VendorLedgerEntry: {
    createdAt: (e: { createdAt: Date | string }) => iso(e.createdAt),
  },

  Query: {
    vendors: async (
      _: unknown,
      args: { includeArchived?: boolean },
      ctx: GraphQLContext,
    ) => {
      await requirePermission(ctx, "vendor.edit");
      return vendors.listVendors(args.includeArchived ?? false);
    },
    vendor: async (_: unknown, args: { id: string }, ctx: GraphQLContext) => {
      await requirePermission(ctx, "vendor.edit");
      try {
        return await vendors.getVendor(args.id);
      } catch (e) {
        if (e instanceof vendors.VendorError && e.code === "VENDOR_NOT_FOUND") {
          return null;
        }
        asGraphQLError(e);
      }
    },
    vendorLedger: async (
      _: unknown,
      args: { vendorId: string; limit?: number },
      ctx: GraphQLContext,
    ) => {
      await requirePermission(ctx, "report.ap_aging.view");
      try {
        return await vendors.listVendorLedger(args.vendorId, args.limit ?? 100);
      } catch (e) {
        asGraphQLError(e);
      }
    },
  },

  Mutation: {
    createVendor: async (
      _: unknown,
      args: Record<string, unknown>,
      ctx: GraphQLContext,
    ) => {
      const viewer = await requirePermission(ctx, "vendor.create");
      try {
        return await vendors.createVendor({
          ...args,
          createdByUserId: viewer.userId,
        } as Parameters<typeof vendors.createVendor>[0]);
      } catch (e) {
        asGraphQLError(e);
      }
    },
    updateVendor: async (
      _: unknown,
      args: { id: string } & Record<string, unknown>,
      ctx: GraphQLContext,
    ) => {
      await requirePermission(ctx, "vendor.edit");
      const { id, ...patch } = args;
      try {
        return await vendors.updateVendor(id, patch as never);
      } catch (e) {
        asGraphQLError(e);
      }
    },
    setVendorArchived: async (
      _: unknown,
      args: { id: string; archived: boolean },
      ctx: GraphQLContext,
    ) => {
      await requirePermission(ctx, "vendor.archive");
      try {
        return await vendors.setVendorArchived(args.id, args.archived);
      } catch (e) {
        asGraphQLError(e);
      }
    },
    hardDeleteVendor: async (
      _: unknown,
      args: { id: string },
      ctx: GraphQLContext,
    ): Promise<boolean> => {
      await requirePermission(ctx, "vendor.hard_delete");
      try {
        await vendors.hardDeleteVendor(args.id);
        return true;
      } catch (e) {
        asGraphQLError(e);
      }
    },
    recordVendorPayment: async (
      _: unknown,
      args: {
        vendorId: string;
        amountMinor: number;
        posSessionId?: string | null;
        note?: string | null;
      },
      ctx: GraphQLContext,
    ) => {
      const viewer = await requirePermission(ctx, "vendor.record_payment");
      try {
        return await vendors.recordVendorPayment({
          vendorId: args.vendorId,
          amountMinor: args.amountMinor,
          posSessionId: args.posSessionId ?? null,
          note: args.note ?? null,
          createdByUserId: viewer.userId,
        });
      } catch (e) {
        asGraphQLError(e);
      }
    },
    adjustVendorBalance: async (
      _: unknown,
      args: { vendorId: string; amountMinor: number; note: string },
      ctx: GraphQLContext,
    ) => {
      const viewer = await requirePermission(ctx, "vendor.adjustment");
      try {
        return await vendors.adjustVendorBalance({
          vendorId: args.vendorId,
          amountMinor: args.amountMinor,
          note: args.note,
          createdByUserId: viewer.userId,
        });
      } catch (e) {
        asGraphQLError(e);
      }
    },
  },
};
