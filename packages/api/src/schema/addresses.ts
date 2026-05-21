// Address-book GraphQL domain: CRUD over the business's ship-to addresses,
// plus setDefaultAddress. Admin-gated (admin.settings.manage) — these are
// business-level configuration, like the PO template. The PO renderer and the
// per-vendor default ship-to consume these rows.

import { GraphQLError } from "graphql";
import { requirePermission } from "../lib/authz.ts";
import type { GraphQLContext } from "../lib/context.ts";
import * as addresses from "../services/address-service.ts";

export const typeDefs = /* GraphQL */ `
  "One of the business's ship-to addresses (store, warehouse, ...)."
  type Address {
    id: ID!
    label: String!
    recipientName: String
    phone: String
    "Free-text postal block (multi-line)."
    line: String!
    notes: String
    "The fallback ship-to when a vendor has no explicit default."
    isDefault: Boolean!
    archivedAt: String
    createdAt: String!
    updatedAt: String!
  }

  extend type Query {
    addresses(includeArchived: Boolean): [Address!]!
    address(id: ID!): Address
    "Active addresses for the vendor ship-to picker. Gated on vendor.edit so a clerk can choose one without settings access."
    shipToAddresses: [Address!]!
  }

  extend type Mutation {
    createAddress(
      label: String!
      recipientName: String
      phone: String
      line: String!
      notes: String
      isDefault: Boolean
    ): Address!
    updateAddress(
      id: ID!
      label: String
      recipientName: String
      phone: String
      line: String
      notes: String
      isDefault: Boolean
    ): Address!
    "Promote one address to the single default ship-to."
    setDefaultAddress(id: ID!): Address!
    setAddressArchived(id: ID!, archived: Boolean!): Address!
    "Hard delete. Vendors pointing here revert to the fallback address."
    deleteAddress(id: ID!): Boolean!
  }
`;

function asGraphQLError(e: unknown): never {
  if (e instanceof addresses.AddressError) {
    throw new GraphQLError(e.message, { extensions: { code: e.code } });
  }
  throw e;
}

const iso = (v: Date | string | null | undefined): string | null =>
  v ? new Date(v).toISOString() : null;

export const resolvers = {
  Address: {
    createdAt: (a: { createdAt: Date | string }) => iso(a.createdAt),
    updatedAt: (a: { updatedAt: Date | string }) => iso(a.updatedAt),
    archivedAt: (a: { archivedAt: Date | string | null }) => iso(a.archivedAt),
  },

  Query: {
    addresses: async (
      _: unknown,
      args: { includeArchived?: boolean },
      ctx: GraphQLContext,
    ) => {
      await requirePermission(ctx, "admin.settings.manage");
      return addresses.listAddresses(args.includeArchived ?? false);
    },
    address: async (_: unknown, args: { id: string }, ctx: GraphQLContext) => {
      await requirePermission(ctx, "admin.settings.manage");
      try {
        return await addresses.getAddress(args.id);
      } catch (e) {
        if (e instanceof addresses.AddressError && e.code === "ADDRESS_NOT_FOUND") {
          return null;
        }
        asGraphQLError(e);
      }
    },
    shipToAddresses: async (_: unknown, __: unknown, ctx: GraphQLContext) => {
      await requirePermission(ctx, "vendor.edit");
      return addresses.listAddresses(false);
    },
  },

  Mutation: {
    createAddress: async (
      _: unknown,
      args: Record<string, unknown>,
      ctx: GraphQLContext,
    ) => {
      const viewer = await requirePermission(ctx, "admin.settings.manage");
      try {
        return await addresses.createAddress({
          ...args,
          createdByUserId: viewer.userId,
        } as Parameters<typeof addresses.createAddress>[0]);
      } catch (e) {
        asGraphQLError(e);
      }
    },
    updateAddress: async (
      _: unknown,
      args: { id: string } & Record<string, unknown>,
      ctx: GraphQLContext,
    ) => {
      await requirePermission(ctx, "admin.settings.manage");
      const { id, ...patch } = args;
      try {
        return await addresses.updateAddress(id, patch as never);
      } catch (e) {
        asGraphQLError(e);
      }
    },
    setDefaultAddress: async (_: unknown, args: { id: string }, ctx: GraphQLContext) => {
      await requirePermission(ctx, "admin.settings.manage");
      try {
        return await addresses.setDefaultAddress(args.id);
      } catch (e) {
        asGraphQLError(e);
      }
    },
    setAddressArchived: async (
      _: unknown,
      args: { id: string; archived: boolean },
      ctx: GraphQLContext,
    ) => {
      await requirePermission(ctx, "admin.settings.manage");
      try {
        return await addresses.setAddressArchived(args.id, args.archived);
      } catch (e) {
        asGraphQLError(e);
      }
    },
    deleteAddress: async (
      _: unknown,
      args: { id: string },
      ctx: GraphQLContext,
    ): Promise<boolean> => {
      await requirePermission(ctx, "admin.settings.manage");
      try {
        await addresses.deleteAddress(args.id);
        return true;
      } catch (e) {
        asGraphQLError(e);
      }
    },
  },
};
