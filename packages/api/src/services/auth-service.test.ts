// Integration tests for password brute-force lockout. Runs against the local
// Docker MariaDB (DATABASE_URL); WIPES the auth tables between tests.
//
//   bun test src/services/auth-service.test.ts

import "../lib/load-env.ts";
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { db } from "../lib/db.ts";
import { AuthError, login, registerUser } from "./auth-service.ts";

const PASSWORD = "correct horse";

async function wipe(): Promise<void> {
  await db.execute(sql`SET FOREIGN_KEY_CHECKS = 0`);
  for (const t of [
    "login_attempts", "sessions", "user_roles", "user_two_factor", "users",
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

/** Attempt a login, returning the AuthError code or "ok". */
async function attempt(username: string, password: string): Promise<string> {
  try {
    await login({ username, password });
    return "ok";
  } catch (e) {
    if (e instanceof AuthError) return e.code;
    throw e;
  }
}

describe("password brute-force lockout", () => {
  test("five consecutive failures lock the account", async () => {
    await registerUser({ username: "alice", password: PASSWORD, name: "Alice" });

    for (let i = 0; i < 5; i++) {
      expect(await attempt("alice", "wrong")).toBe("INVALID_CREDENTIALS");
    }
    // Even the correct password is refused once locked.
    expect(await attempt("alice", PASSWORD)).toBe("ACCOUNT_LOCKED");
  });

  test("four failures do not lock the account", async () => {
    await registerUser({ username: "alice", password: PASSWORD, name: "Alice" });
    for (let i = 0; i < 4; i++) {
      expect(await attempt("alice", "wrong")).toBe("INVALID_CREDENTIALS");
    }
    expect(await attempt("alice", PASSWORD)).toBe("ok");
  });

  test("a successful login resets the failure streak", async () => {
    await registerUser({ username: "alice", password: PASSWORD, name: "Alice" });

    for (let i = 0; i < 4; i++) await attempt("alice", "wrong");
    expect(await attempt("alice", PASSWORD)).toBe("ok"); // resets the streak
    for (let i = 0; i < 4; i++) await attempt("alice", "wrong");
    // Only 4 consecutive failures since the reset — still not locked.
    expect(await attempt("alice", PASSWORD)).toBe("ok");
  });

  test("lockout also applies to a nonexistent username", async () => {
    for (let i = 0; i < 5; i++) {
      expect(await attempt("ghost", "wrong")).toBe("INVALID_CREDENTIALS");
    }
    expect(await attempt("ghost", "wrong")).toBe("ACCOUNT_LOCKED");
  });
});
