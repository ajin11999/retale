// End-to-end tests for the GraphQL layer: operations are executed against the
// fully-composed schema with a built request context, exercising resolver
// wiring, the auth context, and `requirePermission` gating — surface that the
// service-level integration tests never touch. Runs against the local Docker
// MariaDB (DATABASE_URL); WIPES the vendor / auth tables between tests.
//
//   bun test src/schema/graphql.test.ts

import "../lib/load-env.ts";
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { eq, sql } from "drizzle-orm";
import { type ExecutionResult, graphql } from "graphql";
import { ulid } from "ulid";
import { rolePermissions, roles, userRoles, users } from "../db/schema/auth.ts";
import { userTwoFactor } from "../db/schema/two-factor.ts";
import type { GraphQLContext } from "../lib/context.ts";
import type { AccessTokenClaims } from "../lib/jwt.ts";
import { db } from "../lib/db.ts";
import { schema } from "./index.ts";

/** Truncate the tables these tests write to. */
async function wipe(): Promise<void> {
  await db.execute(sql`SET FOREIGN_KEY_CHECKS = 0`);
  for (const t of [
    "vendor_ledger", "vendors", "user_roles", "role_permissions", "roles",
    "user_two_factor", "users",
  ]) {
    await db.execute(sql.raw(`DELETE FROM \`${t}\``));
  }
  await db.execute(sql`SET FOREIGN_KEY_CHECKS = 1`);
}

beforeEach(wipe);
afterAll(async () => {
  await wipe();
  // The shared pool is closed once globally — see src/test-setup.ts.
});

/** Execute an operation against the composed schema with the given viewer. */
function run(
  source: string,
  viewer: AccessTokenClaims | null,
  variableValues?: Record<string, unknown>,
): Promise<ExecutionResult> {
  const contextValue: GraphQLContext = {
    viewer,
    request: new Request("http://test/graphql"),
  };
  return graphql({ schema, source, contextValue, variableValues });
}

/** Insert a user row; returns its id. */
async function seedUser(): Promise<string> {
  const id = ulid();
  await db.insert(users).values({
    id,
    username: `test_${id}`,
    passwordHash: "x",
    name: "GraphQL Test",
  });
  return id;
}

/** Insert a user already enrolled in 2FA; returns its id. */
async function seedEnrolledUser(): Promise<string> {
  const id = await seedUser();
  await db.insert(userTwoFactor).values({
    userId: id,
    secretEncrypted: "x",
    confirmedAt: new Date(),
  });
  return id;
}

/** First error's `extensions.code`, if any. */
function errorCode(result: ExecutionResult): unknown {
  return result.errors?.[0]?.extensions?.code;
}

describe("schema composition", () => {
  test("the base health query resolves for an anonymous request", async () => {
    const result = await run("{ health }", null);
    expect(result.errors).toBeUndefined();
    expect(result.data).toEqual({ health: "ok" });
  });
});

describe("auth gating", () => {
  test("a permissioned query rejects an anonymous request", async () => {
    const result = await run("{ vendors { id } }", null);
    expect(errorCode(result)).toBe("UNAUTHENTICATED");
  });

  test("root short-circuits permission checks", async () => {
    const userId = await seedEnrolledUser();
    const root: AccessTokenClaims = { userId, isRoot: true, roleIds: [] };

    const created = await run(
      `mutation { createVendor(name: "Acme") { id name } }`,
      root,
    );
    expect(created.errors).toBeUndefined();
    expect((created.data as { createVendor: { name: string } }).createVendor.name).toBe("Acme");

    const list = await run("{ vendors { name } }", root);
    expect((list.data as { vendors: { name: string }[] }).vendors).toEqual([
      { name: "Acme" },
    ]);
  });

  test("a non-root viewer holding the permission is allowed", async () => {
    const userId = await seedUser();
    const roleId = ulid();
    await db.insert(roles).values({ id: roleId, name: `r_${roleId}` });
    await db
      .insert(rolePermissions)
      .values({ roleId, permissionKey: "vendor.create" });
    await db.insert(userRoles).values({ userId, roleId });

    const viewer: AccessTokenClaims = { userId, isRoot: false, roleIds: [roleId] };
    const result = await run(
      `mutation { createVendor(name: "Granted") { name } }`,
      viewer,
    );
    expect(result.errors).toBeUndefined();
    expect((result.data as { createVendor: { name: string } }).createVendor.name).toBe(
      "Granted",
    );
  });

  test("a root viewer without 2FA is gated until enrolment", async () => {
    const userId = await seedUser(); // no user_two_factor row
    const root: AccessTokenClaims = { userId, isRoot: true, roleIds: [] };
    const result = await run(
      `mutation { createVendor(name: "Blocked") { id } }`,
      root,
    );
    expect(errorCode(result)).toBe("TWO_FACTOR_SETUP_REQUIRED");
  });

  test("a non-root viewer lacking the permission is forbidden", async () => {
    const userId = await seedUser();
    const viewer: AccessTokenClaims = { userId, isRoot: false, roleIds: [] };
    const result = await run(
      `mutation { createVendor(name: "Denied") { name } }`,
      viewer,
    );
    expect(errorCode(result)).toBe("FORBIDDEN");
  });
});

describe("domain errors surface as GraphQL errors", () => {
  test("a service validation error carries its code", async () => {
    const userId = await seedEnrolledUser();
    const root: AccessTokenClaims = { userId, isRoot: true, roleIds: [] };
    // Blank name — vendor-service throws VendorError("INVALID_INPUT").
    const result = await run(
      `mutation { createVendor(name: "  ") { id } }`,
      root,
    );
    expect(errorCode(result)).toBe("INVALID_INPUT");
  });
});
