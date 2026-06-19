// Integration tests for password brute-force lockout and refresh-token
// rotation. Runs against the local Docker MariaDB (DATABASE_URL); WIPES the
// auth tables between tests.
//
//   bun test src/services/auth-service.test.ts

import "../lib/load-env.ts";
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { eq, sql } from "drizzle-orm";
import { db } from "../lib/db.ts";
import { sessions } from "../db/schema/auth.ts";
import { AuthError, login, refresh, registerUser } from "./auth-service.ts";

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

/** Log in and return the issued tokens (no 2FA in these tests). */
async function loginTokens(username: string) {
  const outcome = await login({ username, password: PASSWORD });
  if (outcome.kind !== "tokens") throw new Error("expected a tokens outcome");
  return outcome.tokens;
}

describe("refresh token rotation", () => {
  test("a successful refresh slides the session expiry", async () => {
    await registerUser({ username: "alice", password: PASSWORD, name: "Alice" });
    const tokens = await loginTokens("alice");

    // Backdate the session so the slide is observable.
    const soon = new Date(Date.now() + 24 * 60 * 60 * 1000);
    const sessionId = tokens.refreshToken.split(".")[0]!;
    await db
      .update(sessions)
      .set({ expiresAt: soon })
      .where(eq(sessions.id, sessionId));

    const { tokens: rotated } = await refresh({ refreshToken: tokens.refreshToken });

    const in29Days = Date.now() + 29 * 24 * 60 * 60 * 1000;
    expect(rotated.refreshExpiresAt.getTime()).toBeGreaterThan(in29Days);
    const row = await db.query.sessions.findFirst({
      where: eq(sessions.id, sessionId),
    });
    expect(new Date(row!.expiresAt).getTime()).toBeGreaterThan(in29Days);
  });

  test("a lost-response retry with the previous token is tolerated", async () => {
    await registerUser({ username: "alice", password: PASSWORD, name: "Alice" });
    const t1 = await loginTokens("alice");

    const { tokens: t2 } = await refresh({ refreshToken: t1.refreshToken });

    // The rotation response was "lost", so the client retries with the token it
    // still holds (t1, now the previous secret). The grace accepts it and
    // rotates again — no theft, no revocation.
    const { tokens: t3 } = await refresh({ refreshToken: t1.refreshToken });
    expect(t3.refreshToken).not.toBe(t2.refreshToken);

    // The session is alive: the newest token keeps refreshing.
    const { tokens: t4 } = await refresh({ refreshToken: t3.refreshToken });
    expect(t4.refreshToken).toBeTruthy();
  });

  test("a twice-superseded token is reuse and revokes the session", async () => {
    await registerUser({ username: "alice", password: PASSWORD, name: "Alice" });
    const t1 = await loginTokens("alice");

    const { tokens: t2 } = await refresh({ refreshToken: t1.refreshToken });
    const { tokens: t3 } = await refresh({ refreshToken: t2.refreshToken });

    // t1 is now two generations stale — neither current nor previous — so it
    // reads as reuse…
    let code = "ok";
    try {
      await refresh({ refreshToken: t1.refreshToken });
    } catch (e) {
      if (!(e instanceof AuthError)) throw e;
      code = e.code;
    }
    expect(code).toBe("SESSION_INVALID");

    // …and kills the whole session: even the current token is now refused.
    code = "ok";
    try {
      await refresh({ refreshToken: t3.refreshToken });
    } catch (e) {
      if (!(e instanceof AuthError)) throw e;
      code = e.code;
    }
    expect(code).toBe("SESSION_INVALID");
  });
});
