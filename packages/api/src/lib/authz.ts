// Authorization middleware. Resolvers call `requirePermission` (and services
// re-check, for defense-in-depth). Root short-circuits every check. Non-root
// permissions are resolved per request from `role_permissions`, so revoking a
// permission from a role takes effect on the next request.

import { inArray } from "drizzle-orm";
import { GraphQLError } from "graphql";
import { rolePermissions } from "../db/schema/auth.ts";
import type { GraphQLContext } from "./context.ts";
import { db } from "./db.ts";
import type { AccessTokenClaims } from "./jwt.ts";
import { isKnownPermission, type PermissionKey } from "./permissions.ts";

// Per-request memo so multiple checks in one request hit the DB at most once.
const permissionCache = new WeakMap<GraphQLContext, Promise<ReadonlySet<string>>>();

async function computePermissions(viewer: AccessTokenClaims): Promise<ReadonlySet<string>> {
  if (viewer.roleIds.length === 0) return new Set();

  const rows = await db
    .select({ key: rolePermissions.permissionKey })
    .from(rolePermissions)
    .where(inArray(rolePermissions.roleId, [...viewer.roleIds]));

  const keys = new Set<string>();
  for (const { key } of rows) {
    if (isKnownPermission(key)) keys.add(key);
    else console.warn(`[authz] ignoring unknown permission key in DB: ${key}`);
  }
  return keys;
}

/** The permission set granted to the request's viewer (empty when anonymous). */
export function resolvePermissions(ctx: GraphQLContext): Promise<ReadonlySet<string>> {
  if (!ctx.viewer) return Promise.resolve(new Set());
  let cached = permissionCache.get(ctx);
  if (!cached) {
    cached = computePermissions(ctx.viewer);
    permissionCache.set(ctx, cached);
  }
  return cached;
}

/** Assert the request is authenticated; returns the viewer claims. */
export function requireAuth(ctx: GraphQLContext): AccessTokenClaims {
  if (!ctx.viewer) {
    throw new GraphQLError("Authentication required", {
      extensions: { code: "UNAUTHENTICATED" },
    });
  }
  return ctx.viewer;
}

/** True when the viewer holds `key` (or is root). Does not throw. */
export async function hasPermission(
  ctx: GraphQLContext,
  key: PermissionKey,
): Promise<boolean> {
  if (!ctx.viewer) return false;
  if (ctx.viewer.isRoot) return true;
  return (await resolvePermissions(ctx)).has(key);
}

/** Assert the viewer holds `key`. Throws UNAUTHENTICATED / FORBIDDEN otherwise. */
export async function requirePermission(
  ctx: GraphQLContext,
  key: PermissionKey,
): Promise<AccessTokenClaims> {
  const viewer = requireAuth(ctx);
  if (viewer.isRoot) return viewer;
  if (!(await resolvePermissions(ctx)).has(key)) {
    throw new GraphQLError(`Missing permission: ${key}`, {
      extensions: { code: "FORBIDDEN", requiredPermission: key },
    });
  }
  return viewer;
}
