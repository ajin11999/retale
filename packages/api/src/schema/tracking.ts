// Tracking accounts GraphQL domain: hierarchical CRUD, archive, root-only hard
// delete, and the manual ledger writers (payout, deposit, adjustment).
// Money is Float (integer minor units; Float is exact past 2^31).

import { GraphQLError } from "graphql";
import { requirePermission } from "../lib/authz.ts";
import type { GraphQLContext } from "../lib/context.ts";
import * as tracking from "../services/tracking-service.ts";

export const typeDefs = /* GraphQL */ `
  enum TrackingLedgerType {
    attribution
    payout
    deposit
    adjustment
    opening_balance
  }

  enum TrackingLedgerRefType { order_item order pos_session manual import adjustment }

  type TrackingAccount {
    id: ID!
    parentId: ID
    name: String!
    code: String
    "Balance side, e.g. 'liability.tracking.staff'."
    accountCategory: String!
    "Offsetting side on attribution, e.g. 'expense.commission'."
    counterCategory: String!
    notes: String
    "Cached balance, minor units. Positive = the business owes the account."
    balanceMinor: Float!
    archivedAt: String
    createdAt: String!
    updatedAt: String!
    "Variants whose sales attribute revenue to this account."
    linkedVariants: [TrackingLinkedVariant!]!
  }

  "A variant whose sales attribute to a tracking account."
  type TrackingLinkedVariant {
    variantId: ID!
    productId: ID!
    productName: String!
    sku: String!
    label: String
  }

  "A variant that could be linked to a tracking account, with its current link if any."
  type AssignableTrackingVariant {
    variantId: ID!
    productId: ID!
    productName: String!
    sku: String!
    label: String
    currentTrackingAccountId: ID
    currentTrackingAccountName: String
  }

  type TrackingAccountLedgerEntry {
    id: ID!
    trackingAccountId: ID!
    type: TrackingLedgerType!
    "Signed minor units. Positive = balance increases."
    amountMinor: Float!
    refType: TrackingLedgerRefType
    refId: ID
    counterCategoryOverride: String
    note: String
    posSessionId: ID
    createdAt: String!
  }

  extend type Query {
    trackingAccounts(includeArchived: Boolean): [TrackingAccount!]!
    trackingAccount(id: ID!): TrackingAccount
    trackingAccountLedger(accountId: ID!, limit: Int): [TrackingAccountLedgerEntry!]!
    "All non-archived variants, marked with their current tracking-account link if any."
    assignableTrackingVariants: [AssignableTrackingVariant!]!
  }

  extend type Mutation {
    createTrackingAccount(
      name: String!
      accountCategory: String!
      counterCategory: String!
      parentId: ID
      code: String
      notes: String
    ): TrackingAccount!
    updateTrackingAccount(
      id: ID!
      name: String
      accountCategory: String
      counterCategory: String
      parentId: ID
      code: String
      notes: String
    ): TrackingAccount!
    setTrackingAccountArchived(id: ID!, archived: Boolean!): TrackingAccount!
    "Hard delete — root-only. Refused if the account has children or a non-zero balance."
    hardDeleteTrackingAccount(id: ID!): Boolean!
    "Pay an account out of the drawer. amountMinor is the positive sum paid."
    recordTrackingPayout(
      accountId: ID!
      amountMinor: Float!
      posSessionId: ID
      note: String
    ): TrackingAccount!
    "Advance cash into an account. amountMinor is the positive sum deposited."
    recordTrackingDeposit(
      accountId: ID!
      amountMinor: Float!
      posSessionId: ID
      note: String
    ): TrackingAccount!
    "Root-only manual balance correction. Signed amountMinor; note required."
    adjustTrackingBalance(
      accountId: ID!
      amountMinor: Float!
      note: String!
      counterCategoryOverride: String
    ): TrackingAccount!
    "Replace the set of variants whose sales attribute to this account."
    setTrackingAccountVariants(
      accountId: ID!
      variantIds: [ID!]!
    ): [TrackingLinkedVariant!]!
  }
`;

/** Map a TrackingError to a GraphQLError; rethrow anything unexpected. */
function asGraphQLError(e: unknown): never {
  if (e instanceof tracking.TrackingError) {
    throw new GraphQLError(e.message, { extensions: { code: e.code } });
  }
  throw e;
}

const iso = (v: Date | string | null | undefined): string | null =>
  v ? new Date(v).toISOString() : null;

export const resolvers = {
  TrackingAccount: {
    createdAt: (a: { createdAt: Date | string }) => iso(a.createdAt),
    updatedAt: (a: { updatedAt: Date | string }) => iso(a.updatedAt),
    archivedAt: (a: { archivedAt: Date | string | null }) => iso(a.archivedAt),
    linkedVariants: (a: { id: string }) => tracking.listLinkedVariants(a.id),
  },
  TrackingAccountLedgerEntry: {
    createdAt: (e: { createdAt: Date | string }) => iso(e.createdAt),
  },

  Query: {
    trackingAccounts: async (
      _: unknown,
      args: { includeArchived?: boolean },
      ctx: GraphQLContext,
    ) => {
      await requirePermission(ctx, "tracking_account.edit");
      return tracking.listTrackingAccounts(args.includeArchived ?? false);
    },
    trackingAccount: async (
      _: unknown,
      args: { id: string },
      ctx: GraphQLContext,
    ) => {
      await requirePermission(ctx, "tracking_account.edit");
      try {
        return await tracking.getTrackingAccount(args.id);
      } catch (e) {
        if (
          e instanceof tracking.TrackingError &&
          e.code === "ACCOUNT_NOT_FOUND"
        ) {
          return null;
        }
        asGraphQLError(e);
      }
    },
    trackingAccountLedger: async (
      _: unknown,
      args: { accountId: string; limit?: number },
      ctx: GraphQLContext,
    ) => {
      await requirePermission(ctx, "tracking_account.edit");
      try {
        return await tracking.listTrackingAccountLedger(
          args.accountId,
          args.limit ?? 100,
        );
      } catch (e) {
        asGraphQLError(e);
      }
    },
    assignableTrackingVariants: async (
      _: unknown,
      __: unknown,
      ctx: GraphQLContext,
    ) => {
      await requirePermission(ctx, "tracking_account.edit");
      return tracking.listAssignableVariants();
    },
  },

  Mutation: {
    createTrackingAccount: async (
      _: unknown,
      args: Record<string, unknown>,
      ctx: GraphQLContext,
    ) => {
      const viewer = await requirePermission(ctx, "tracking_account.create");
      try {
        return await tracking.createTrackingAccount({
          ...args,
          createdByUserId: viewer.userId,
        } as Parameters<typeof tracking.createTrackingAccount>[0]);
      } catch (e) {
        asGraphQLError(e);
      }
    },
    updateTrackingAccount: async (
      _: unknown,
      args: { id: string } & Record<string, unknown>,
      ctx: GraphQLContext,
    ) => {
      await requirePermission(ctx, "tracking_account.edit");
      const { id, ...patch } = args;
      try {
        return await tracking.updateTrackingAccount(id, patch as never);
      } catch (e) {
        asGraphQLError(e);
      }
    },
    setTrackingAccountArchived: async (
      _: unknown,
      args: { id: string; archived: boolean },
      ctx: GraphQLContext,
    ) => {
      await requirePermission(ctx, "tracking_account.archive");
      try {
        return await tracking.setTrackingAccountArchived(args.id, args.archived);
      } catch (e) {
        asGraphQLError(e);
      }
    },
    hardDeleteTrackingAccount: async (
      _: unknown,
      args: { id: string },
      ctx: GraphQLContext,
    ): Promise<boolean> => {
      await requirePermission(ctx, "tracking_account.hard_delete");
      try {
        await tracking.hardDeleteTrackingAccount(args.id);
        return true;
      } catch (e) {
        asGraphQLError(e);
      }
    },
    recordTrackingPayout: async (
      _: unknown,
      args: {
        accountId: string;
        amountMinor: number;
        posSessionId?: string | null;
        note?: string | null;
      },
      ctx: GraphQLContext,
    ) => {
      const viewer = await requirePermission(ctx, "tracking_account.payout");
      try {
        return await tracking.recordTrackingPayout({
          accountId: args.accountId,
          amountMinor: args.amountMinor,
          posSessionId: args.posSessionId ?? null,
          note: args.note ?? null,
          createdByUserId: viewer.userId,
        });
      } catch (e) {
        asGraphQLError(e);
      }
    },
    recordTrackingDeposit: async (
      _: unknown,
      args: {
        accountId: string;
        amountMinor: number;
        posSessionId?: string | null;
        note?: string | null;
      },
      ctx: GraphQLContext,
    ) => {
      const viewer = await requirePermission(ctx, "tracking_account.deposit");
      try {
        return await tracking.recordTrackingDeposit({
          accountId: args.accountId,
          amountMinor: args.amountMinor,
          posSessionId: args.posSessionId ?? null,
          note: args.note ?? null,
          createdByUserId: viewer.userId,
        });
      } catch (e) {
        asGraphQLError(e);
      }
    },
    setTrackingAccountVariants: async (
      _: unknown,
      args: { accountId: string; variantIds: string[] },
      ctx: GraphQLContext,
    ) => {
      await requirePermission(ctx, "tracking_account.edit");
      try {
        return await tracking.setTrackingAccountVariants(
          args.accountId,
          args.variantIds,
        );
      } catch (e) {
        asGraphQLError(e);
      }
    },
    adjustTrackingBalance: async (
      _: unknown,
      args: {
        accountId: string;
        amountMinor: number;
        note: string;
        counterCategoryOverride?: string | null;
      },
      ctx: GraphQLContext,
    ) => {
      const viewer = await requirePermission(ctx, "tracking_account.adjustment");
      try {
        return await tracking.adjustTrackingBalance({
          accountId: args.accountId,
          amountMinor: args.amountMinor,
          note: args.note,
          counterCategoryOverride: args.counterCategoryOverride ?? null,
          createdByUserId: viewer.userId,
        });
      } catch (e) {
        asGraphQLError(e);
      }
    },
  },
};
