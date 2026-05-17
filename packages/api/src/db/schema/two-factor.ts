// Two-factor auth domain: a user's TOTP authenticator, their single-use
// recovery codes, and the short-lived challenges that bridge the
// password → TOTP login steps. See docs/design-decisions.md → "Authentication".

import { relations } from "drizzle-orm";
import {
  bigint,
  index,
  int,
  mysqlTable,
  timestamp,
  varchar,
} from "drizzle-orm/mysql-core";
import { users } from "./auth.ts";
import { ulidPk, ulidRef } from "./_helpers.ts";

/**
 * One row per user with TOTP set up. `confirmedAt` null means the secret is
 * still pending first-code confirmation. `secretEncrypted` is the base32 TOTP
 * secret sealed with AES-256-GCM. `lastUsedStep` is the time-step of the last
 * accepted code — a code at or below it is a replay and rejected.
 */
export const userTwoFactor = mysqlTable("user_two_factor", {
  userId: ulidRef()
    .primaryKey()
    .references(() => users.id, { onDelete: "cascade" }),
  secretEncrypted: varchar({ length: 512 }).notNull(),
  confirmedAt: timestamp(),
  lastUsedStep: bigint({ mode: "number" }),
  createdAt: timestamp()
    .notNull()
    .$defaultFn(() => new Date()),
});

/** Single-use recovery codes — argon2-hashed at rest, regenerable as a set. */
export const userRecoveryCodes = mysqlTable(
  "user_recovery_codes",
  {
    id: ulidPk(),
    userId: ulidRef()
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    codeHash: varchar({ length: 255 }).notNull(),
    usedAt: timestamp(),
  },
  (t) => [index("user_recovery_codes_user_id_idx").on(t.userId)],
);

/**
 * A short-lived bridge between a successful password check and the TOTP step.
 * The challenge id is handed to the client as an opaque token; `failedAttempts`
 * caps brute force, `consumedAt` makes it single-use.
 */
export const twoFactorChallenges = mysqlTable(
  "two_factor_challenges",
  {
    id: ulidPk(),
    userId: ulidRef()
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    failedAttempts: int().notNull().default(0),
    consumedAt: timestamp(),
    expiresAt: timestamp().notNull(),
    createdAt: timestamp()
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (t) => [index("two_factor_challenges_user_id_idx").on(t.userId)],
);

export const userTwoFactorRelations = relations(userTwoFactor, ({ one }) => ({
  user: one(users, { fields: [userTwoFactor.userId], references: [users.id] }),
}));

export const userRecoveryCodesRelations = relations(userRecoveryCodes, ({ one }) => ({
  user: one(users, { fields: [userRecoveryCodes.userId], references: [users.id] }),
}));

export const twoFactorChallengesRelations = relations(
  twoFactorChallenges,
  ({ one }) => ({
    user: one(users, {
      fields: [twoFactorChallenges.userId],
      references: [users.id],
    }),
  }),
);
