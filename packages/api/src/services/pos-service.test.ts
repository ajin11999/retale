// Integration tests for the POS service — register CRUD and the cashier-shift
// lifecycle (open / close / reopen / force-close). These run against the local
// Docker MariaDB (DATABASE_URL) and WIPE the POS / location tables between
// tests, so point them only at a dev database.
//
//   bun test src/services/pos-service.test.ts

import "../lib/load-env.ts";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { eq, sql } from "drizzle-orm";
import { ulid } from "ulid";
import { users } from "../db/schema/auth.ts";
import { locations } from "../db/schema/locations.ts";
import { posSessions } from "../db/schema/pos.ts";
import { db } from "../lib/db.ts";
import {
  closeSession,
  createPointOfSale,
  forceCloseSession,
  hardDeletePointOfSale,
  openSession,
  PosError,
  type PosErrorCode,
  reopenSession,
  setPointOfSaleArchived,
  updatePointOfSale,
} from "./pos-service.ts";

let userId: string;
let otherUserId: string;

/** Truncate every domain table touched by these tests. Users are kept. */
async function wipe(): Promise<void> {
  await db.execute(sql`SET FOREIGN_KEY_CHECKS = 0`);
  for (const t of ["pos_sessions", "points_of_sale", "locations"]) {
    await db.execute(sql.raw(`DELETE FROM \`${t}\``));
  }
  await db.execute(sql`SET FOREIGN_KEY_CHECKS = 1`);
}

beforeAll(async () => {
  userId = ulid();
  otherUserId = ulid();
  await db.insert(users).values([
    { id: userId, username: `test_${userId}`, passwordHash: "x", name: "POS Test" },
    {
      id: otherUserId,
      username: `test_${otherUserId}`,
      passwordHash: "x",
      name: "POS Test 2",
    },
  ]);
});

afterAll(async () => {
  await wipe();
  await db.delete(users).where(eq(users.id, userId));
  await db.delete(users).where(eq(users.id, otherUserId));
  // The shared pool is closed once globally — see src/test-setup.ts.
});

beforeEach(wipe);

/** Seed a location; returns its id. */
async function seedLocation(): Promise<string> {
  const id = ulid();
  await db.insert(locations).values({ id, name: "Front Counter" });
  return id;
}

/** Seed a POS at a fresh location; returns its id. */
async function seedPos(code = "P1"): Promise<string> {
  const locationId = await seedLocation();
  const p = await createPointOfSale({
    locationId,
    code,
    name: "Counter Register",
    createdByUserId: userId,
  });
  return p.id;
}

/** Assert a PosError with the expected code is thrown. */
async function expectError(
  code: PosErrorCode,
  fn: () => Promise<unknown>,
): Promise<void> {
  try {
    await fn();
  } catch (e) {
    expect(e).toBeInstanceOf(PosError);
    expect((e as PosError).code).toBe(code);
    return;
  }
  throw new Error(`expected PosError ${code}, nothing thrown`);
}

describe("points of sale", () => {
  test("createPointOfSale creates a register", async () => {
    const locationId = await seedLocation();
    const p = await createPointOfSale({
      locationId,
      code: "P1",
      name: "Counter Register",
      createdByUserId: userId,
    });
    expect(p.code).toBe("P1");
    expect(p.archivedAt).toBeNull();
  });

  test("rejects a duplicate code", async () => {
    await seedPos("P1");
    const locationId = await seedLocation();
    await expectError("CODE_TAKEN", () =>
      createPointOfSale({
        locationId,
        code: "P1",
        name: "Another",
        createdByUserId: userId,
      }),
    );
  });

  test("updatePointOfSale rejects taking another POS's code", async () => {
    await seedPos("P1");
    const p2 = await seedPos("P2");
    await expectError("CODE_TAKEN", () => updatePointOfSale(p2, { code: "P1" }));
  });
});

describe("session open / close", () => {
  test("opens a session and closes it with a computed variance", async () => {
    const posId = await seedPos();
    const opened = await openSession({
      posId,
      openingCashMinor: 100000,
      openedByUserId: userId,
    });
    expect(opened.closedAt).toBeNull();

    // Expected = opening float (order payments fold in once orders exist).
    // Counted 95000 → 5000 short.
    const closed = await closeSession({
      sessionId: opened.id,
      closingCashMinor: 95000,
      closedByUserId: userId,
    });
    expect(closed.closedAt).not.toBeNull();
    expect(closed.varianceMinor).toBe(-5000);
    expect(closed.zReportJson).not.toBeNull();
  });

  test("rejects a second open session on the same POS", async () => {
    const posId = await seedPos();
    await openSession({ posId, openingCashMinor: 0, openedByUserId: userId });
    await expectError("SESSION_ALREADY_OPEN", () =>
      openSession({ posId, openingCashMinor: 0, openedByUserId: otherUserId }),
    );
  });

  test("rejects opening on an archived POS", async () => {
    const posId = await seedPos();
    await setPointOfSaleArchived(posId, true);
    await expectError("POS_ARCHIVED", () =>
      openSession({ posId, openingCashMinor: 0, openedByUserId: userId }),
    );
  });

  test("rejects a negative opening float", async () => {
    const posId = await seedPos();
    await expectError("INVALID_INPUT", () =>
      openSession({ posId, openingCashMinor: -1, openedByUserId: userId }),
    );
  });

  test("rejects closing an already-closed session", async () => {
    const posId = await seedPos();
    const s = await openSession({ posId, openingCashMinor: 0, openedByUserId: userId });
    await closeSession({ sessionId: s.id, closingCashMinor: 0, closedByUserId: userId });
    await expectError("SESSION_CLOSED", () =>
      closeSession({ sessionId: s.id, closingCashMinor: 0, closedByUserId: userId }),
    );
  });

  test("a new session may open once the prior one is closed", async () => {
    const posId = await seedPos();
    const s1 = await openSession({ posId, openingCashMinor: 0, openedByUserId: userId });
    await closeSession({ sessionId: s1.id, closingCashMinor: 0, closedByUserId: userId });
    const s2 = await openSession({ posId, openingCashMinor: 0, openedByUserId: userId });
    expect(s2.id).not.toBe(s1.id);
    expect(s2.closedAt).toBeNull();
  });
});

describe("force-close", () => {
  test("leaves closing cash and variance null, flags forceClosed", async () => {
    const posId = await seedPos();
    const s = await openSession({ posId, openingCashMinor: 50000, openedByUserId: userId });
    const closed = await forceCloseSession({
      sessionId: s.id,
      closedByUserId: otherUserId,
    });
    expect(closed.forceClosed).toBe(true);
    expect(closed.closingCashMinor).toBeNull();
    expect(closed.varianceMinor).toBeNull();
    expect(closed.closedAt).not.toBeNull();
  });
});

describe("reopen", () => {
  test("reopens a session closed within the 24h window", async () => {
    const posId = await seedPos();
    const s = await openSession({ posId, openingCashMinor: 0, openedByUserId: userId });
    await closeSession({ sessionId: s.id, closingCashMinor: 0, closedByUserId: userId });
    const reopened = await reopenSession(s.id);
    expect(reopened.closedAt).toBeNull();
    expect(reopened.closedByUserId).toBeNull();
  });

  test("rejects reopening a session that is not closed", async () => {
    const posId = await seedPos();
    const s = await openSession({ posId, openingCashMinor: 0, openedByUserId: userId });
    await expectError("SESSION_NOT_CLOSED", () => reopenSession(s.id));
  });

  test("rejects reopening after the 24h window", async () => {
    const posId = await seedPos();
    const s = await openSession({ posId, openingCashMinor: 0, openedByUserId: userId });
    await closeSession({ sessionId: s.id, closingCashMinor: 0, closedByUserId: userId });
    // Backdate the close to 25h ago.
    const longAgo = new Date(Date.now() - 25 * 60 * 60 * 1000);
    await db
      .update(posSessions)
      .set({ closedAt: longAgo })
      .where(eq(posSessions.id, s.id));
    await expectError("REOPEN_WINDOW_EXPIRED", () => reopenSession(s.id));
  });

  test("rejects reopening when another session is open on the POS", async () => {
    const posId = await seedPos();
    const s1 = await openSession({ posId, openingCashMinor: 0, openedByUserId: userId });
    await closeSession({ sessionId: s1.id, closingCashMinor: 0, closedByUserId: userId });
    await openSession({ posId, openingCashMinor: 0, openedByUserId: userId });
    await expectError("SESSION_ALREADY_OPEN", () => reopenSession(s1.id));
  });
});

describe("lifecycle guards", () => {
  test("archive is refused while a session is open", async () => {
    const posId = await seedPos();
    await openSession({ posId, openingCashMinor: 0, openedByUserId: userId });
    await expectError("SESSION_ALREADY_OPEN", () =>
      setPointOfSaleArchived(posId, true),
    );
  });

  test("hard delete is refused while sessions reference the POS", async () => {
    const posId = await seedPos();
    const s = await openSession({ posId, openingCashMinor: 0, openedByUserId: userId });
    await closeSession({ sessionId: s.id, closingCashMinor: 0, closedByUserId: userId });
    await expectError("HAS_SESSIONS", () => hardDeletePointOfSale(posId));
  });

  test("hard delete succeeds for a POS with no sessions", async () => {
    const posId = await seedPos();
    await hardDeletePointOfSale(posId);
    await expectError("POS_NOT_FOUND", () =>
      setPointOfSaleArchived(posId, true),
    );
  });
});
