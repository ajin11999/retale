// Integration tests for the tracking accounts service — hierarchical CRUD,
// the cycle check, the balance-guarded hard delete, and the manual ledger
// writers. These run against the local Docker MariaDB (DATABASE_URL) and WIPE
// the tracking tables between tests, so point them only at a dev database.
//
//   bun test src/services/tracking-service.test.ts

import "../lib/load-env.ts";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { eq, sql } from "drizzle-orm";
import { ulid } from "ulid";
import { users } from "../db/schema/auth.ts";
import { db } from "../lib/db.ts";
import {
  adjustTrackingBalance,
  createTrackingAccount,
  hardDeleteTrackingAccount,
  listTrackingAccountLedger,
  recordTrackingDeposit,
  recordTrackingPayout,
  setTrackingAccountArchived,
  TrackingError,
  type TrackingErrorCode,
  updateTrackingAccount,
} from "./tracking-service.ts";

let userId: string;

async function wipe(): Promise<void> {
  await db.execute(sql`SET FOREIGN_KEY_CHECKS = 0`);
  for (const t of ["tracking_account_ledger", "tracking_accounts"]) {
    await db.execute(sql.raw(`DELETE FROM \`${t}\``));
  }
  await db.execute(sql`SET FOREIGN_KEY_CHECKS = 1`);
}

beforeAll(async () => {
  userId = ulid();
  await db.insert(users).values({
    id: userId,
    username: `test_${userId}`,
    passwordHash: "x",
    name: "Tracking Test",
  });
});

afterAll(async () => {
  await wipe();
  await db.delete(users).where(eq(users.id, userId));
  // The shared pool is closed once globally — see src/test-setup.ts.
});

beforeEach(wipe);

/** Create a tracking account with sane defaults. */
function seedAccount(opts?: { name?: string; parentId?: string }) {
  return createTrackingAccount({
    name: opts?.name ?? "Abu Bakar",
    accountCategory: "liability.tracking.staff",
    counterCategory: "expense.commission",
    parentId: opts?.parentId ?? null,
    createdByUserId: userId,
  });
}

async function expectError(
  code: TrackingErrorCode,
  fn: () => Promise<unknown>,
): Promise<void> {
  try {
    await fn();
  } catch (e) {
    expect(e).toBeInstanceOf(TrackingError);
    expect((e as TrackingError).code).toBe(code);
    return;
  }
  throw new Error(`expected TrackingError ${code}, nothing thrown`);
}

describe("CRUD and hierarchy", () => {
  test("creates an account with a zero balance", async () => {
    const a = await seedAccount();
    expect(a.name).toBe("Abu Bakar");
    expect(a.balanceMinor).toBe(0);
  });

  test("rejects a blank name or category", async () => {
    await expectError("INVALID_INPUT", () =>
      createTrackingAccount({
        name: "  ",
        accountCategory: "x",
        counterCategory: "y",
        createdByUserId: userId,
      }),
    );
  });

  test("rejects reparenting onto a descendant (cycle)", async () => {
    const parent = await seedAccount({ name: "Mechanics" });
    const child = await seedAccount({ name: "Abu Bakar", parentId: parent.id });
    await expectError("ACCOUNT_CYCLE", () =>
      updateTrackingAccount(parent.id, { parentId: child.id }),
    );
  });
});

describe("ledger writers", () => {
  test("a deposit grows the balance, a payout shrinks it", async () => {
    const a = await seedAccount();
    expect((await recordTrackingDeposit({
      accountId: a.id,
      amountMinor: 50000,
      createdByUserId: userId,
    })).balanceMinor).toBe(50000);
    expect((await recordTrackingPayout({
      accountId: a.id,
      amountMinor: 20000,
      createdByUserId: userId,
    })).balanceMinor).toBe(30000);

    const ledger = await listTrackingAccountLedger(a.id);
    expect(ledger).toHaveLength(2);
  });

  test("payout balance may go negative", async () => {
    const a = await seedAccount();
    const after = await recordTrackingPayout({
      accountId: a.id,
      amountMinor: 10000,
      createdByUserId: userId,
    });
    expect(after.balanceMinor).toBe(-10000);
  });

  test("payout rejects a non-positive amount", async () => {
    const a = await seedAccount();
    await expectError("INVALID_INPUT", () =>
      recordTrackingPayout({ accountId: a.id, amountMinor: 0, createdByUserId: userId }),
    );
  });

  test("adjustment requires a note", async () => {
    const a = await seedAccount();
    await expectError("INVALID_INPUT", () =>
      adjustTrackingBalance({
        accountId: a.id,
        amountMinor: 1000,
        note: "  ",
        createdByUserId: userId,
      }),
    );
  });

  test("adjustment carries a counter-category override", async () => {
    const a = await seedAccount();
    await adjustTrackingBalance({
      accountId: a.id,
      amountMinor: -5000,
      note: "write-off",
      counterCategoryOverride: "expense.other",
      createdByUserId: userId,
    });
    const ledger = await listTrackingAccountLedger(a.id);
    expect(ledger[0]!.counterCategoryOverride).toBe("expense.other");
  });
});

describe("lifecycle guards", () => {
  test("archive then unarchive toggles archivedAt", async () => {
    const a = await seedAccount();
    expect((await setTrackingAccountArchived(a.id, true)).archivedAt).not.toBeNull();
    expect((await setTrackingAccountArchived(a.id, false)).archivedAt).toBeNull();
  });

  test("hard delete is refused while the account carries a balance", async () => {
    const a = await seedAccount();
    await recordTrackingDeposit({ accountId: a.id, amountMinor: 1000, createdByUserId: userId });
    await expectError("HAS_BALANCE", () => hardDeleteTrackingAccount(a.id));
  });

  test("hard delete is refused while the account has children", async () => {
    const parent = await seedAccount({ name: "Mechanics" });
    await seedAccount({ name: "Abu Bakar", parentId: parent.id });
    await expectError("HAS_CHILDREN", () => hardDeleteTrackingAccount(parent.id));
  });

  test("hard delete succeeds for a clean account", async () => {
    const a = await seedAccount();
    await hardDeleteTrackingAccount(a.id);
    await expectError("ACCOUNT_NOT_FOUND", () => listTrackingAccountLedger(a.id));
  });
});
