// POS GraphQL domain: register CRUD (root-only) and the cashier-shift
// lifecycle — open, close, reopen, force-close. Money is Float (integer minor
// units; Float is exact past 2^31). `zReportJson` is surfaced as a JSON string.

import { GraphQLError } from "graphql";
import { requirePermission } from "../lib/authz.ts";
import type { GraphQLContext } from "../lib/context.ts";
import * as pos from "../services/pos-service.ts";

export const typeDefs = /* GraphQL */ `
  type PointOfSale {
    id: ID!
    locationId: ID!
    code: String!
    name: String!
    notes: String
    archivedAt: String
    createdAt: String!
    updatedAt: String!
  }

  type PosSession {
    id: ID!
    posId: ID!
    openedByUserId: ID!
    openedAt: String!
    openingCashMinor: Float!
    closedByUserId: ID
    closedAt: String
    "Null when the session was force-closed."
    closingCashMinor: Float
    "closing − expected drawer cash. Null when force-closed."
    varianceMinor: Float
    "Cash that should be in the drawer right now: opening float + net cash sales."
    expectedCashMinor: Float!
    forceClosed: Boolean!
    "Denormalized close-time snapshot, as a JSON string. Null until closed."
    zReportJson: String
    notes: String
    createdAt: String!
    updatedAt: String!
  }

  extend type Query {
    pointsOfSale(includeArchived: Boolean): [PointOfSale!]!
    pointOfSale(id: ID!): PointOfSale
    posSessions(posId: ID, limit: Int): [PosSession!]!
    posSession(id: ID!): PosSession
  }

  extend type Mutation {
    createPointOfSale(
      locationId: ID!
      code: String!
      name: String!
      notes: String
    ): PointOfSale!
    updatePointOfSale(
      id: ID!
      locationId: ID
      code: String
      name: String
      notes: String
    ): PointOfSale!
    "Archive a POS. Refused while a session is open on it."
    setPointOfSaleArchived(id: ID!, archived: Boolean!): PointOfSale!
    "Hard delete — root-only. Refused while any session references the POS."
    hardDeletePointOfSale(id: ID!): Boolean!

    "Open a cashier shift. Fails if the POS is archived or already has an open session."
    openSession(posId: ID!, openingCashMinor: Float!, notes: String): PosSession!
    "Close a session. Records the cash variance; never blocks on it."
    closeSession(id: ID!, closingCashMinor: Float!): PosSession!
    "Force-close a stranded session — root-only. Leaves it unreconciled."
    forceCloseSession(id: ID!): PosSession!
    "Reopen a session to amend mistakes — root-only, within 24h of close."
    reopenSession(id: ID!): PosSession!
  }
`;

/** Map a PosError to a GraphQLError; rethrow anything unexpected. */
function asGraphQLError(e: unknown): never {
  if (e instanceof pos.PosError) {
    throw new GraphQLError(e.message, { extensions: { code: e.code } });
  }
  throw e;
}

const iso = (v: Date | string | null | undefined): string | null =>
  v ? new Date(v).toISOString() : null;

export const resolvers = {
  PointOfSale: {
    createdAt: (p: { createdAt: Date | string }) => iso(p.createdAt),
    updatedAt: (p: { updatedAt: Date | string }) => iso(p.updatedAt),
    archivedAt: (p: { archivedAt: Date | string | null }) => iso(p.archivedAt),
  },
  PosSession: {
    expectedCashMinor: (s: { id: string }) => pos.expectedCashMinor(s.id),
    openedAt: (s: { openedAt: Date | string }) => iso(s.openedAt),
    closedAt: (s: { closedAt: Date | string | null }) => iso(s.closedAt),
    createdAt: (s: { createdAt: Date | string }) => iso(s.createdAt),
    updatedAt: (s: { updatedAt: Date | string }) => iso(s.updatedAt),
    zReportJson: (s: { zReportJson: unknown }) => {
      // MariaDB returns JSON columns as text; pass a string straight through,
      // stringify an object.
      const v = s.zReportJson;
      if (v == null) return null;
      return typeof v === "string" ? v : JSON.stringify(v);
    },
  },

  Query: {
    pointsOfSale: async (
      _: unknown,
      args: { includeArchived?: boolean },
      ctx: GraphQLContext,
    ) => {
      await requirePermission(ctx, "session.open");
      return pos.listPointsOfSale(args.includeArchived ?? false);
    },
    pointOfSale: async (_: unknown, args: { id: string }, ctx: GraphQLContext) => {
      await requirePermission(ctx, "session.open");
      try {
        return await pos.getPointOfSale(args.id);
      } catch (e) {
        if (e instanceof pos.PosError && e.code === "POS_NOT_FOUND") return null;
        asGraphQLError(e);
      }
    },
    posSessions: async (
      _: unknown,
      args: { posId?: string; limit?: number },
      ctx: GraphQLContext,
    ) => {
      await requirePermission(ctx, "session.open");
      return pos.listPosSessions(args.posId, args.limit ?? 100);
    },
    posSession: async (_: unknown, args: { id: string }, ctx: GraphQLContext) => {
      await requirePermission(ctx, "session.open");
      try {
        return await pos.getPosSession(args.id);
      } catch (e) {
        if (e instanceof pos.PosError && e.code === "SESSION_NOT_FOUND") {
          return null;
        }
        asGraphQLError(e);
      }
    },
  },

  Mutation: {
    createPointOfSale: async (
      _: unknown,
      args: Record<string, unknown>,
      ctx: GraphQLContext,
    ) => {
      const viewer = await requirePermission(ctx, "pos.create");
      try {
        return await pos.createPointOfSale({
          ...args,
          createdByUserId: viewer.userId,
        } as Parameters<typeof pos.createPointOfSale>[0]);
      } catch (e) {
        asGraphQLError(e);
      }
    },
    updatePointOfSale: async (
      _: unknown,
      args: { id: string } & Record<string, unknown>,
      ctx: GraphQLContext,
    ) => {
      await requirePermission(ctx, "pos.edit");
      const { id, ...patch } = args;
      try {
        return await pos.updatePointOfSale(id, patch as never);
      } catch (e) {
        asGraphQLError(e);
      }
    },
    setPointOfSaleArchived: async (
      _: unknown,
      args: { id: string; archived: boolean },
      ctx: GraphQLContext,
    ) => {
      await requirePermission(ctx, "pos.archive");
      try {
        return await pos.setPointOfSaleArchived(args.id, args.archived);
      } catch (e) {
        asGraphQLError(e);
      }
    },
    hardDeletePointOfSale: async (
      _: unknown,
      args: { id: string },
      ctx: GraphQLContext,
    ): Promise<boolean> => {
      await requirePermission(ctx, "pos.hard_delete");
      try {
        await pos.hardDeletePointOfSale(args.id);
        return true;
      } catch (e) {
        asGraphQLError(e);
      }
    },
    openSession: async (
      _: unknown,
      args: { posId: string; openingCashMinor: number; notes?: string | null },
      ctx: GraphQLContext,
    ) => {
      const viewer = await requirePermission(ctx, "session.open");
      try {
        return await pos.openSession({
          posId: args.posId,
          openingCashMinor: args.openingCashMinor,
          openedByUserId: viewer.userId,
          notes: args.notes ?? null,
        });
      } catch (e) {
        asGraphQLError(e);
      }
    },
    closeSession: async (
      _: unknown,
      args: { id: string; closingCashMinor: number },
      ctx: GraphQLContext,
    ) => {
      const viewer = await requirePermission(ctx, "session.close_own");
      try {
        const session = await pos.getPosSession(args.id);
        // Closing another cashier's session needs the wider permission.
        if (session.openedByUserId !== viewer.userId) {
          await requirePermission(ctx, "session.close_others");
        }
        return await pos.closeSession({
          sessionId: args.id,
          closingCashMinor: args.closingCashMinor,
          closedByUserId: viewer.userId,
        });
      } catch (e) {
        asGraphQLError(e);
      }
    },
    forceCloseSession: async (
      _: unknown,
      args: { id: string },
      ctx: GraphQLContext,
    ) => {
      const viewer = await requirePermission(ctx, "session.force_close");
      try {
        return await pos.forceCloseSession({
          sessionId: args.id,
          closedByUserId: viewer.userId,
        });
      } catch (e) {
        asGraphQLError(e);
      }
    },
    reopenSession: async (
      _: unknown,
      args: { id: string },
      ctx: GraphQLContext,
    ) => {
      await requirePermission(ctx, "session.reopen");
      try {
        return await pos.reopenSession(args.id);
      } catch (e) {
        asGraphQLError(e);
      }
    },
  },
};
