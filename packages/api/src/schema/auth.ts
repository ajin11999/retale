// Auth GraphQL domain: login (with the 2FA challenge step), refresh, logout,
// bootstrap of the first root user, TOTP 2FA management, and the `me` query.
// Resolvers are thin — they delegate to the services and translate
// AuthError / TwoFactorError into GraphQLError.

import { eq } from "drizzle-orm";
import { GraphQLError } from "graphql";
import { users } from "../db/schema/auth.ts";
import { requireAuth } from "../lib/authz.ts";
import { type GraphQLContext, sessionContext } from "../lib/context.ts";
import { db } from "../lib/db.ts";
import * as auth from "../services/auth-service.ts";
import * as twoFactor from "../services/two-factor-service.ts";

export const typeDefs = /* GraphQL */ `
  type User {
    id: ID!
    username: String!
    name: String!
    isRoot: Boolean!
    twoFactorEnabled: Boolean!
    archivedAt: String
    createdAt: String!
  }

  "Tokens plus the authenticated user, returned by refresh / bootstrap / 2FA login."
  type AuthPayload {
    accessToken: String!
    refreshToken: String!
    "ISO-8601 expiry of the refresh token."
    refreshExpiresAt: String!
    user: User!
  }

  "Result of a password login: tokens directly, or a 2FA challenge to complete."
  type LoginResult {
    requiresTwoFactor: Boolean!
    "Set when requiresTwoFactor — pass to loginTwoFactor with a code."
    challengeToken: String
    "Set when 2FA is not enabled — the login is already complete."
    auth: AuthPayload
  }

  "Returned by setupTwoFactor — the recovery codes are shown only once."
  type TwoFactorSetup {
    otpauthUrl: String!
    secret: String!
    recoveryCodes: [String!]!
  }

  extend type Query {
    "The currently authenticated user, or null if the request is anonymous."
    me: User
  }

  extend type Mutation {
    "Create the first (root) user. Fails once any user exists."
    bootstrap(username: String!, password: String!, name: String!): AuthPayload!
    "Authenticate with username + password. May return a 2FA challenge."
    login(username: String!, password: String!): LoginResult!
    "Complete a 2FA login with a TOTP or recovery code."
    loginTwoFactor(challengeToken: String!, code: String!): AuthPayload!
    "Rotate a refresh token, returning a fresh token pair."
    refreshToken(refreshToken: String!): AuthPayload!
    "Revoke the session behind a refresh token. Idempotent."
    logout(refreshToken: String!): Boolean!

    "Begin TOTP enrolment for the current user — returns a secret + recovery codes."
    setupTwoFactor: TwoFactorSetup!
    "Confirm a pending TOTP setup by entering a current code; activates 2FA."
    confirmTwoFactor(code: String!): Boolean!
    "Disable 2FA for the current user."
    disableTwoFactor: Boolean!
    "Replace the current user's recovery codes; the old set is invalidated."
    regenerateRecoveryCodes: [String!]!
  }
`;

type UserRow = typeof users.$inferSelect;

/** Map a known service error to a GraphQLError; rethrow anything else. */
function asGraphQLError(e: unknown): never {
  if (e instanceof auth.AuthError || e instanceof twoFactor.TwoFactorError) {
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

async function loadUser(id: string): Promise<UserRow> {
  const user = await db.query.users.findFirst({ where: eq(users.id, id) });
  if (!user) throw new GraphQLError("User not found", { extensions: { code: "NOT_FOUND" } });
  return user;
}

export const resolvers = {
  User: {
    createdAt: (u: UserRow) => new Date(u.createdAt).toISOString(),
    archivedAt: (u: UserRow) => (u.archivedAt ? new Date(u.archivedAt).toISOString() : null),
    twoFactorEnabled: (u: UserRow) => twoFactor.isTwoFactorEnabled(u.id),
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
        // A freshly created user has no 2FA — the outcome is always tokens.
        const outcome = await auth.login({
          username: args.username,
          password: args.password,
          ctx: sessionContext(ctx),
        });
        if (outcome.kind !== "tokens") {
          throw new GraphQLError("unexpected challenge during bootstrap");
        }
        return authPayload(user, outcome.tokens);
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
        const outcome = await auth.login({ ...args, ctx: sessionContext(ctx) });
        if (outcome.kind === "challenge") {
          return { requiresTwoFactor: true, challengeToken: outcome.challengeToken, auth: null };
        }
        return {
          requiresTwoFactor: false,
          challengeToken: null,
          auth: authPayload(outcome.user, outcome.tokens),
        };
      } catch (e) {
        asGraphQLError(e);
      }
    },

    loginTwoFactor: async (
      _: unknown,
      args: { challengeToken: string; code: string },
      ctx: GraphQLContext,
    ) => {
      try {
        const { user, tokens } = await auth.loginTwoFactor({
          ...args,
          ctx: sessionContext(ctx),
        });
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

    setupTwoFactor: async (_: unknown, __: unknown, ctx: GraphQLContext) => {
      const viewer = requireAuth(ctx);
      try {
        const user = await loadUser(viewer.userId);
        return await twoFactor.setupTwoFactor({
          userId: user.id,
          accountLabel: user.username,
        });
      } catch (e) {
        asGraphQLError(e);
      }
    },

    confirmTwoFactor: async (
      _: unknown,
      args: { code: string },
      ctx: GraphQLContext,
    ): Promise<boolean> => {
      const viewer = requireAuth(ctx);
      try {
        await twoFactor.confirmTwoFactor({ userId: viewer.userId, code: args.code });
        return true;
      } catch (e) {
        asGraphQLError(e);
      }
    },

    disableTwoFactor: async (
      _: unknown,
      __: unknown,
      ctx: GraphQLContext,
    ): Promise<boolean> => {
      const viewer = requireAuth(ctx);
      await twoFactor.disableTwoFactor(viewer.userId);
      return true;
    },

    regenerateRecoveryCodes: async (
      _: unknown,
      __: unknown,
      ctx: GraphQLContext,
    ) => {
      const viewer = requireAuth(ctx);
      try {
        return await twoFactor.regenerateRecoveryCodes(viewer.userId);
      } catch (e) {
        asGraphQLError(e);
      }
    },
  },
};
