// RBAC GraphQL domain: role management and user/role administration.
// Every field is gated by `admin.role.manage` or `admin.user.manage`.

import { eq } from "drizzle-orm";
import { GraphQLError } from "graphql";
import { userRoles, users } from "../db/schema/auth.ts";
import { requirePermission } from "../lib/authz.ts";
import type { GraphQLContext } from "../lib/context.ts";
import { db } from "../lib/db.ts";
import { PERMISSIONS } from "../lib/permissions.ts";
import { AuthError } from "../services/auth-service.ts";
import * as rbac from "../services/rbac-service.ts";

export const typeDefs = /* GraphQL */ `
  type Role {
    id: ID!
    name: String!
    description: String
    isTemplate: Boolean!
    archivedAt: String
    permissionKeys: [String!]!
  }

  extend type User {
    "Ids of the roles assigned to this user."
    roleIds: [String!]!
  }

  extend type Query {
    "Every permission key the server recognises."
    permissionCatalog: [String!]!
    "All roles, with their permission keys."
    roles: [Role!]!
    "All users, with their assigned role ids."
    users: [User!]!
  }

  extend type Mutation {
    createRole(name: String!, description: String, permissionKeys: [String!]!): Role!
    "Clone a role (typically a template) into a new editable role."
    cloneRole(roleId: ID!, name: String!): Role!
    "Replace a role's permission set. Template roles are immutable."
    setRolePermissions(roleId: ID!, permissionKeys: [String!]!): Role!
    deleteRole(roleId: ID!): Boolean!

    createUser(
      username: String!
      password: String!
      name: String!
      isRoot: Boolean
      roleIds: [ID!]
    ): User!
    assignRole(userId: ID!, roleId: ID!): User!
    unassignRole(userId: ID!, roleId: ID!): User!
  }
`;

/** Map service errors to GraphQLError; rethrow anything unexpected. */
function asGraphQLError(e: unknown): never {
  if (e instanceof rbac.RbacError || e instanceof AuthError) {
    throw new GraphQLError(e.message, { extensions: { code: e.code } });
  }
  throw e;
}

async function fetchUser(userId: string) {
  const user = await db.query.users.findFirst({ where: eq(users.id, userId) });
  if (!user) throw new GraphQLError("User not found", { extensions: { code: "USER_NOT_FOUND" } });
  return user;
}

export const resolvers = {
  Role: {
    archivedAt: (r: rbac.RoleWithPermissions) =>
      r.archivedAt ? new Date(r.archivedAt).toISOString() : null,
  },

  User: {
    roleIds: async (u: { id: string; roleIds?: string[] }): Promise<string[]> => {
      if (Array.isArray(u.roleIds)) return u.roleIds;
      const rows = await db
        .select({ roleId: userRoles.roleId })
        .from(userRoles)
        .where(eq(userRoles.userId, u.id));
      return rows.map((r) => r.roleId);
    },
  },

  Query: {
    permissionCatalog: async (_: unknown, __: unknown, ctx: GraphQLContext) => {
      await requirePermission(ctx, "admin.role.manage");
      return [...PERMISSIONS];
    },
    roles: async (_: unknown, __: unknown, ctx: GraphQLContext) => {
      await requirePermission(ctx, "admin.role.manage");
      return rbac.listRoles();
    },
    users: async (_: unknown, __: unknown, ctx: GraphQLContext) => {
      await requirePermission(ctx, "admin.user.manage");
      return rbac.listUsers();
    },
  },

  Mutation: {
    createRole: async (
      _: unknown,
      args: { name: string; description?: string | null; permissionKeys: string[] },
      ctx: GraphQLContext,
    ) => {
      await requirePermission(ctx, "admin.role.manage");
      try {
        return await rbac.createRole(args);
      } catch (e) {
        asGraphQLError(e);
      }
    },

    cloneRole: async (
      _: unknown,
      args: { roleId: string; name: string },
      ctx: GraphQLContext,
    ) => {
      await requirePermission(ctx, "admin.role.manage");
      try {
        return await rbac.cloneRole(args.roleId, args.name);
      } catch (e) {
        asGraphQLError(e);
      }
    },

    setRolePermissions: async (
      _: unknown,
      args: { roleId: string; permissionKeys: string[] },
      ctx: GraphQLContext,
    ) => {
      await requirePermission(ctx, "admin.role.manage");
      try {
        return await rbac.setRolePermissions(args.roleId, args.permissionKeys);
      } catch (e) {
        asGraphQLError(e);
      }
    },

    deleteRole: async (
      _: unknown,
      args: { roleId: string },
      ctx: GraphQLContext,
    ): Promise<boolean> => {
      await requirePermission(ctx, "admin.role.manage");
      try {
        await rbac.deleteRole(args.roleId);
        return true;
      } catch (e) {
        asGraphQLError(e);
      }
    },

    createUser: async (
      _: unknown,
      args: {
        username: string;
        password: string;
        name: string;
        isRoot?: boolean;
        roleIds?: string[];
      },
      ctx: GraphQLContext,
    ) => {
      const viewer = await requirePermission(ctx, "admin.user.manage");
      try {
        return await rbac.createUser({ ...args, createdByUserId: viewer.userId });
      } catch (e) {
        asGraphQLError(e);
      }
    },

    assignRole: async (
      _: unknown,
      args: { userId: string; roleId: string },
      ctx: GraphQLContext,
    ) => {
      const viewer = await requirePermission(ctx, "admin.user.manage");
      try {
        await rbac.assignRole(args.userId, args.roleId, viewer.userId);
      } catch (e) {
        asGraphQLError(e);
      }
      return fetchUser(args.userId);
    },

    unassignRole: async (
      _: unknown,
      args: { userId: string; roleId: string },
      ctx: GraphQLContext,
    ) => {
      await requirePermission(ctx, "admin.user.manage");
      await rbac.unassignRole(args.userId, args.roleId);
      return fetchUser(args.userId);
    },
  },
};
