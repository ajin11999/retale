// RBAC service: role CRUD, role↔permission mapping, user creation and
// role assignment. Resolvers gate these behind `admin.role.manage` /
// `admin.user.manage`; services re-validate inputs for defense-in-depth.

import { and, eq } from "drizzle-orm";
import { roles, rolePermissions, userRoles, users } from "../db/schema/auth.ts";
import { db } from "../lib/db.ts";
import { isKnownPermission } from "../lib/permissions.ts";
import { registerUser } from "./auth-service.ts";

export type RbacErrorCode =
  | "ROLE_NOT_FOUND"
  | "ROLE_NAME_TAKEN"
  | "TEMPLATE_IMMUTABLE"
  | "UNKNOWN_PERMISSION"
  | "USER_NOT_FOUND";

export class RbacError extends Error {
  constructor(public code: RbacErrorCode, message?: string) {
    super(message ?? code);
    this.name = "RbacError";
  }
}

type Role = typeof roles.$inferSelect;
type User = typeof users.$inferSelect;

export interface RoleWithPermissions extends Role {
  permissionKeys: string[];
}

export interface UserWithRoles extends User {
  roleIds: string[];
}

/** Reject any key not in the catalog before it reaches the DB. */
function assertKnownPermissions(keys: string[]): void {
  for (const key of keys) {
    if (!isKnownPermission(key)) {
      throw new RbacError("UNKNOWN_PERMISSION", `Unknown permission key: ${key}`);
    }
  }
}

async function loadRole(roleId: string): Promise<Role> {
  const role = await db.query.roles.findFirst({ where: eq(roles.id, roleId) });
  if (!role) throw new RbacError("ROLE_NOT_FOUND");
  return role;
}

// --- Roles ---

export async function listRoles(): Promise<RoleWithPermissions[]> {
  // Two plain selects + JS grouping: MariaDB has no LATERAL join, so the
  // Drizzle relational `with:` query API cannot be used here.
  const [roleRows, permRows] = await Promise.all([
    db.select().from(roles),
    db.select().from(rolePermissions),
  ]);

  const byRole = new Map<string, string[]>();
  for (const p of permRows) {
    const list = byRole.get(p.roleId);
    if (list) list.push(p.permissionKey);
    else byRole.set(p.roleId, [p.permissionKey]);
  }
  return roleRows.map((r) => ({ ...r, permissionKeys: byRole.get(r.id) ?? [] }));
}

export async function getRolePermissions(roleId: string): Promise<string[]> {
  await loadRole(roleId);
  const rows = await db
    .select({ key: rolePermissions.permissionKey })
    .from(rolePermissions)
    .where(eq(rolePermissions.roleId, roleId));
  return rows.map((r) => r.key);
}

/** Create a regular (non-template) role with an initial permission set. */
export async function createRole(input: {
  name: string;
  description?: string | null;
  permissionKeys: string[];
}): Promise<RoleWithPermissions> {
  assertKnownPermissions(input.permissionKeys);

  const existing = await db.query.roles.findFirst({ where: eq(roles.name, input.name) });
  if (existing) throw new RbacError("ROLE_NAME_TAKEN");

  return db.transaction(async (tx) => {
    await tx.insert(roles).values({ name: input.name, description: input.description ?? null });
    const role = await tx.query.roles.findFirst({ where: eq(roles.name, input.name) });
    if (!role) throw new RbacError("ROLE_NOT_FOUND", "role insert failed");
    await insertPermissions(tx, role.id, input.permissionKeys);
    return { ...role, permissionKeys: [...new Set(input.permissionKeys)] };
  });
}

/** Clone any role (typically a template) into a new editable regular role. */
export async function cloneRole(roleId: string, newName: string): Promise<RoleWithPermissions> {
  const source = await loadRole(roleId);
  const keys = await getRolePermissions(roleId);
  return createRole({
    name: newName,
    description: `Cloned from ${source.name}.`,
    permissionKeys: keys,
  });
}

/** Replace a role's permission set. Template roles are immutable. */
export async function setRolePermissions(
  roleId: string,
  keys: string[],
): Promise<RoleWithPermissions> {
  const role = await loadRole(roleId);
  if (role.isTemplate) throw new RbacError("TEMPLATE_IMMUTABLE");
  assertKnownPermissions(keys);

  await db.transaction(async (tx) => {
    await tx.delete(rolePermissions).where(eq(rolePermissions.roleId, roleId));
    await insertPermissions(tx, roleId, keys);
  });
  return { ...role, permissionKeys: [...new Set(keys)] };
}

/** Delete a regular role. Cascades to role_permissions and user_roles. */
export async function deleteRole(roleId: string): Promise<void> {
  const role = await loadRole(roleId);
  if (role.isTemplate) throw new RbacError("TEMPLATE_IMMUTABLE");
  await db.delete(roles).where(eq(roles.id, roleId));
}

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

async function insertPermissions(tx: Tx, roleId: string, keys: string[]): Promise<void> {
  const unique = [...new Set(keys)];
  if (unique.length === 0) return;
  await tx
    .insert(rolePermissions)
    .values(unique.map((permissionKey) => ({ roleId, permissionKey })));
}

// --- Users & assignments ---

export async function listUsers(): Promise<UserWithRoles[]> {
  // See listRoles — no LATERAL join on MariaDB, so no relational `with:`.
  const [userRows, assignmentRows] = await Promise.all([
    db.select().from(users),
    db.select().from(userRoles),
  ]);

  const byUser = new Map<string, string[]>();
  for (const a of assignmentRows) {
    const list = byUser.get(a.userId);
    if (list) list.push(a.roleId);
    else byUser.set(a.userId, [a.roleId]);
  }
  return userRows.map((u) => ({ ...u, roleIds: byUser.get(u.id) ?? [] }));
}

/** Create a user (post-bootstrap) and optionally assign initial roles. */
export async function createUser(input: {
  username: string;
  password: string;
  name: string;
  isRoot?: boolean;
  roleIds?: string[];
  createdByUserId: string;
}): Promise<UserWithRoles> {
  const roleIds = [...new Set(input.roleIds ?? [])];
  // Validate role ids up front: registerUser is not part of the loop's
  // transaction, so a bad id must not leave a half-created user behind.
  for (const roleId of roleIds) {
    await loadRole(roleId);
  }

  const user = await registerUser({
    username: input.username,
    password: input.password,
    name: input.name,
    isRoot: input.isRoot,
    createdByUserId: input.createdByUserId,
  });

  for (const roleId of roleIds) {
    await assignRole(user.id, roleId, input.createdByUserId);
  }
  return { ...user, roleIds };
}

/** Grant a role to a user. Idempotent — re-granting an existing role no-ops. */
export async function assignRole(
  userId: string,
  roleId: string,
  grantedByUserId: string,
): Promise<void> {
  const user = await db.query.users.findFirst({ where: eq(users.id, userId) });
  if (!user) throw new RbacError("USER_NOT_FOUND");
  await loadRole(roleId);

  const existing = await db.query.userRoles.findFirst({
    where: and(eq(userRoles.userId, userId), eq(userRoles.roleId, roleId)),
  });
  if (existing) return;

  await db.insert(userRoles).values({ userId, roleId, grantedByUserId });
}

/** Revoke a role from a user. Idempotent. */
export async function unassignRole(userId: string, roleId: string): Promise<void> {
  await db
    .delete(userRoles)
    .where(and(eq(userRoles.userId, userId), eq(userRoles.roleId, roleId)));
}
