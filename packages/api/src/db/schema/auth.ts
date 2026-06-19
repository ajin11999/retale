// Auth + RBAC domain: users, roles, and their join tables.
// See docs/design-decisions.md → "Authentication" and "Permission catalog".

import { relations } from "drizzle-orm";
import {
  boolean,
  index,
  mysqlTable,
  primaryKey,
  text,
  timestamp,
  varchar,
  type AnyMySqlColumn,
} from "drizzle-orm/mysql-core";
import { timestamps, ulidPk, ulidRef } from "./_helpers.ts";

/**
 * A login identity. `isRoot` short-circuits every permission check; the first
 * user created at bootstrap is auto-promoted. Everyone else gets permissions
 * via `userRoles`. Users are archived, not deleted (history references them).
 */
export const users = mysqlTable(
  "users",
  {
    id: ulidPk(),
    username: varchar({ length: 100 }).notNull().unique(),
    passwordHash: varchar({ length: 255 }).notNull(),
    name: varchar({ length: 150 }).notNull(),
    isRoot: boolean().notNull().default(false),
    archivedAt: timestamp(),
    createdByUserId: ulidRef().references((): AnyMySqlColumn => users.id),
    ...timestamps,
  },
  (t) => [index("users_archived_at_idx").on(t.archivedAt)],
);

/**
 * A bag of permission keys. Template roles ship at install (`isTemplate`),
 * are immutable in the UI, and can be cloned into editable regular roles.
 */
export const roles = mysqlTable("roles", {
  id: ulidPk(),
  name: varchar({ length: 50 }).notNull().unique(),
  description: text(),
  isTemplate: boolean().notNull().default(false),
  archivedAt: timestamp(),
  ...timestamps,
});

/**
 * Permission keys granted by a role. `permissionKey` is validated against the
 * app-level catalog at boot; unknown keys are logged and ignored.
 */
export const rolePermissions = mysqlTable(
  "role_permissions",
  {
    roleId: ulidRef()
      .notNull()
      .references(() => roles.id, { onDelete: "cascade" }),
    permissionKey: varchar({ length: 100 }).notNull(),
  },
  (t) => [primaryKey({ columns: [t.roleId, t.permissionKey] })],
);

/** Assignment of a role to a user. Users hold any number of roles (additive). */
export const userRoles = mysqlTable(
  "user_roles",
  {
    userId: ulidRef()
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    roleId: ulidRef()
      .notNull()
      .references(() => roles.id, { onDelete: "cascade" }),
    grantedByUserId: ulidRef().references((): AnyMySqlColumn => users.id),
    grantedAt: timestamp()
      .notNull()
      .defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.roleId] })],
);

/**
 * A login session backing one rotating refresh token. The opaque refresh
 * token is `{id}.{secret}`; only the argon2 hash of the secret is stored.
 * Rotated on every use; `revokedAt` set on logout or reuse detection.
 *
 * `prevRefreshTokenHash` keeps the immediately-previous secret valid as a grace
 * for a lost rotation response (see `refresh()`); only a secret older than that
 * counts as reuse.
 */
export const sessions = mysqlTable(
  "sessions",
  {
    id: ulidPk(),
    userId: ulidRef()
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    refreshTokenHash: varchar({ length: 255 }).notNull(),
    prevRefreshTokenHash: varchar({ length: 255 }),
    userAgent: varchar({ length: 255 }),
    ip: varchar({ length: 45 }),
    createdAt: timestamp()
      .notNull()
      .defaultNow(),
    lastUsedAt: timestamp()
      .notNull()
      .defaultNow(),
    expiresAt: timestamp().notNull(),
    revokedAt: timestamp(),
  },
  (t) => [index("sessions_user_id_idx").on(t.userId)],
);

/**
 * Password login attempts, for brute-force lockout. Deliberately has no FK to
 * `users` — a failed attempt may target a username that does not exist, and
 * those still count toward the lockout.
 */
export const loginAttempts = mysqlTable(
  "login_attempts",
  {
    id: ulidPk(),
    username: varchar({ length: 100 }).notNull(),
    ip: varchar({ length: 45 }),
    succeeded: boolean().notNull(),
    attemptedAt: timestamp()
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (t) => [index("login_attempts_username_idx").on(t.username, t.attemptedAt)],
);

// --- Relations (for the relational query API) ---

export const usersRelations = relations(users, ({ many }) => ({
  userRoles: many(userRoles),
  sessions: many(sessions),
}));

export const sessionsRelations = relations(sessions, ({ one }) => ({
  user: one(users, { fields: [sessions.userId], references: [users.id] }),
}));

export const rolesRelations = relations(roles, ({ many }) => ({
  rolePermissions: many(rolePermissions),
  userRoles: many(userRoles),
}));

export const rolePermissionsRelations = relations(rolePermissions, ({ one }) => ({
  role: one(roles, { fields: [rolePermissions.roleId], references: [roles.id] }),
}));

export const userRolesRelations = relations(userRoles, ({ one }) => ({
  user: one(users, { fields: [userRoles.userId], references: [users.id] }),
  role: one(roles, { fields: [userRoles.roleId], references: [roles.id] }),
}));
