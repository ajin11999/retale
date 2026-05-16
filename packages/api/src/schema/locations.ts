// Locations GraphQL domain: a hierarchical forest of stock-holding places.
// Create / edit / reparent / archive are clerk-level; hard delete is root-only
// and guarded against orphaning stock or child locations.

import { GraphQLError } from "graphql";
import { requirePermission } from "../lib/authz.ts";
import type { GraphQLContext } from "../lib/context.ts";
import * as locations from "../services/location-service.ts";

export const typeDefs = /* GraphQL */ `
  type Location {
    id: ID!
    name: String!
    parentId: ID
    code: String
    notes: String
    sortOrder: Int!
    archivedAt: String
    createdAt: String!
    updatedAt: String!
  }

  extend type Query {
    locations(includeArchived: Boolean): [Location!]!
    location(id: ID!): Location
  }

  extend type Mutation {
    createLocation(
      name: String!
      parentId: ID
      code: String
      notes: String
      sortOrder: Int
    ): Location!
    updateLocation(
      id: ID!
      name: String
      parentId: ID
      code: String
      notes: String
      sortOrder: Int
    ): Location!
    setLocationArchived(id: ID!, archived: Boolean!): Location!
    "Hard delete — root-only. Refused if the location has children or holds stock."
    hardDeleteLocation(id: ID!): Boolean!
  }
`;

/** Map a LocationError to a GraphQLError; rethrow anything unexpected. */
function asGraphQLError(e: unknown): never {
  if (e instanceof locations.LocationError) {
    throw new GraphQLError(e.message, { extensions: { code: e.code } });
  }
  throw e;
}

const iso = (v: Date | string | null | undefined): string | null =>
  v ? new Date(v).toISOString() : null;

type WithDates = {
  createdAt: Date | string;
  updatedAt: Date | string;
  archivedAt: Date | string | null;
};

export const resolvers = {
  Location: {
    createdAt: (l: WithDates) => iso(l.createdAt),
    updatedAt: (l: WithDates) => iso(l.updatedAt),
    archivedAt: (l: WithDates) => iso(l.archivedAt),
  },

  Query: {
    locations: async (
      _: unknown,
      args: { includeArchived?: boolean },
      ctx: GraphQLContext,
    ) => {
      await requirePermission(ctx, "location.edit");
      return locations.listLocations(args.includeArchived ?? false);
    },
    location: async (_: unknown, args: { id: string }, ctx: GraphQLContext) => {
      await requirePermission(ctx, "location.edit");
      try {
        return await locations.getLocation(args.id);
      } catch (e) {
        if (e instanceof locations.LocationError && e.code === "LOCATION_NOT_FOUND") {
          return null;
        }
        asGraphQLError(e);
      }
    },
  },

  Mutation: {
    createLocation: async (
      _: unknown,
      args: Record<string, unknown>,
      ctx: GraphQLContext,
    ) => {
      const viewer = await requirePermission(ctx, "location.create");
      try {
        return await locations.createLocation({
          ...args,
          createdByUserId: viewer.userId,
        } as Parameters<typeof locations.createLocation>[0]);
      } catch (e) {
        asGraphQLError(e);
      }
    },
    updateLocation: async (
      _: unknown,
      args: { id: string } & Record<string, unknown>,
      ctx: GraphQLContext,
    ) => {
      await requirePermission(ctx, "location.edit");
      const { id, ...patch } = args;
      try {
        return await locations.updateLocation(id, patch as never);
      } catch (e) {
        asGraphQLError(e);
      }
    },
    setLocationArchived: async (
      _: unknown,
      args: { id: string; archived: boolean },
      ctx: GraphQLContext,
    ) => {
      await requirePermission(ctx, "location.archive");
      try {
        return await locations.setLocationArchived(args.id, args.archived);
      } catch (e) {
        asGraphQLError(e);
      }
    },
    hardDeleteLocation: async (
      _: unknown,
      args: { id: string },
      ctx: GraphQLContext,
    ): Promise<boolean> => {
      await requirePermission(ctx, "location.hard_delete");
      try {
        await locations.hardDeleteLocation(args.id);
        return true;
      } catch (e) {
        asGraphQLError(e);
      }
    },
  },
};
