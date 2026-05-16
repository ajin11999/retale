// Auth GraphQL domain: login / refresh / logout mutations, bootstrap of the
// first root user, and the `me` query. Resolvers are thin — they delegate to
// auth-service and translate AuthError into GraphQLError.

import { eq } from "drizzle-orm";
import { GraphQLError } from "graphql";
import { users } from "../db/schema/auth.ts";
import { db } from "../lib/db.ts";
import { type GraphQLContext, sessionContext } from "../lib/context.ts";
import * as auth from "../services/auth-service.ts";

export const typeDefs = /* GraphQL */ `
  type User {
    id: ID!
    username: String!
    name: String!
    isRoot: Boolean!
    archivedAt: String
    createdAt: String!
  }

  "Tokens plus the authenticated user, returned by login / refresh / bootstrap."
  type AuthPayload {
    accessToken: String!
    refreshToken: String!
    "ISO-8601 expiry of the refresh token."
    refreshExpiresAt: String!
    user: User!
  }

  extend type Query {
    "The currently authenticated user, or null if the request is anonymous."
    me: User
  }

  extend type Mutation {
    "Create the first (root) user. Fails once any user exists."
    bootstrap(username: String!, password: String!, name: String!): AuthPayload!
    "Authenticate with username + password."
    login(username: String!, password: String!): AuthPayload!
    "Rotate a refresh token, returning a fresh token pair."
    refreshToken(refreshToken: String!): AuthPayload!
    "Revoke the session behind a refresh token. Idempotent."
    logout(refreshToken: String!): Boolean!
  }
`;

type UserRow = typeof users.$inferSelect;

/** Map an AuthError to a GraphQLError; rethrow anything else untouched. */
function asGraphQLError(e: unknown): never {
  if (e instanceof auth.AuthError) {
    throw new GraphQLError(e.message, { extensions: { code: e.code } });
  }
  throw e;
}

function authPayload(user: UserRow, tokens: auth.AuthTokens) {
  return {
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken,
    refreshExpiresAt: tokens.refreshExpiresAt.toISOString(),
    user,
  };
}

export const resolvers = {
  User: {
    createdAt: (u: UserRow) => new Date(u.createdAt).toISOString(),
    archivedAt: (u: UserRow) => (u.archivedAt ? new Date(u.archivedAt).toISOString() : null),
  },

  Query: {
    me: async (_: unknown, __: unknown, ctx: GraphQLContext): Promise<UserRow | null> => {
      if (!ctx.viewer) return null;
      const user = await db.query.users.findFirst({ where: eq(users.id, ctx.viewer.userId) });
      return user ?? null;
    },
  },

  Mutation: {
    bootstrap: async (
      _: unknown,
      args: { username: string; password: string; name: string },
      ctx: GraphQLContext,
    ) => {
      if (!(await auth.isBootstrapNeeded())) {
        throw new GraphQLError("System is already initialised", {
          extensions: { code: "ALREADY_BOOTSTRAPPED" },
        });
      }
      try {
        const user = await auth.registerUser(args);
        const { tokens } = await auth.login({
          username: args.username,
          password: args.password,
          ctx: sessionContext(ctx),
        });
        return authPayload(user, tokens);
      } catch (e) {
        asGraphQLError(e);
      }
    },

    login: async (
      _: unknown,
      args: { username: string; password: string },
      ctx: GraphQLContext,
    ) => {
      try {
        const { user, tokens } = await auth.login({ ...args, ctx: sessionContext(ctx) });
        return authPayload(user, tokens);
      } catch (e) {
        asGraphQLError(e);
      }
    },

    refreshToken: async (
      _: unknown,
      args: { refreshToken: string },
      ctx: GraphQLContext,
    ) => {
      try {
        const { user, tokens } = await auth.refresh({
          refreshToken: args.refreshToken,
          ctx: sessionContext(ctx),
        });
        return authPayload(user, tokens);
      } catch (e) {
        asGraphQLError(e);
      }
    },

    logout: async (_: unknown, args: { refreshToken: string }): Promise<boolean> => {
      await auth.logout(args.refreshToken);
      return true;
    },
  },
};
