// Tracking accounts service: hierarchical CRUD with a cycle check, archive, a
// balance-guarded hard delete, and the manual ledger writers — payout,
// deposit, and a root-only adjustment. Every ledger insert recomputes
// `tracking_accounts.balanceMinor` in the same transaction so the cached total
// never drifts. Attribution rows are written by the order service.
// See docs/design-decisions.md → "Tracking accounts".

import { desc, eq, isNull, sql } from "drizzle-orm";
import { ulid } from "ulid";
import {
  trackingAccountLedger,
  trackingAccounts,
} from "../db/schema/tracking.ts";
import { db } from "../lib/db.ts";

export type TrackingErrorCode =
  | "ACCOUNT_NOT_FOUND"
  | "INVALID_INPUT"
  | "ACCOUNT_CYCLE"
  | "HAS_CHILDREN"
  | "HAS_BALANCE";

export class TrackingError extends Error {
  constructor(
    public code: TrackingErrorCode,
    message?: string,
  ) {
    super(message ?? code);
    this.name = "TrackingError";
  }
}

type Account = typeof trackingAccounts.$inferSelect;
type LedgerEntry = typeof trackingAccountLedger.$inferSelect;

/** A drizzle transaction handle; structurally a subset of `db`. */
type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

export function listTrackingAccounts(includeArchived = false): Promise<Account[]> {
  return db
    .select()
    .from(trackingAccounts)
    .where(includeArchived ? undefined : isNull(trackingAccounts.archivedAt));
}

async function loadAccount(id: string): Promise<Account> {
  const row = await db.query.trackingAccounts.findFirst({
    where: eq(trackingAccounts.id, id),
  });
  if (!row) throw new TrackingError("ACCOUNT_NOT_FOUND");
  return row;
}

export { loadAccount as getTrackingAccount };

/** Walk the parent chain upward; throw if `parentId` is `id` or a descendant. */
async function assertNoCycle(id: string, parentId: string): Promise<void> {
  let cursor: string | null = parentId;
  while (cursor) {
    if (cursor === id) throw new TrackingError("ACCOUNT_CYCLE");
    const parent: Account = await loadAccount(cursor);
    cursor = parent.parentId;
  }
}

export async function createTrackingAccount(input: {
  name: string;
  accountCategory: string;
  counterCategory: string;
  parentId?: string | null;
  code?: string | null;
  notes?: string | null;
  createdByUserId: string;
}): Promise<Account> {
  if (!input.name.trim()) throw new TrackingError("INVALID_INPUT", "name is required");
  if (!input.accountCategory.trim()) {
    throw new TrackingError("INVALID_INPUT", "accountCategory is required");
  }
  if (!input.counterCategory.trim()) {
    throw new TrackingError("INVALID_INPUT", "counterCategory is required");
  }
  if (input.parentId) await loadAccount(input.parentId);

  const id = ulid();
  await db.insert(trackingAccounts).values({
    id,
    name: input.name.trim(),
    accountCategory: input.accountCategory.trim(),
    counterCategory: input.counterCategory.trim(),
    parentId: input.parentId ?? null,
    code: input.code ?? null,
    notes: input.notes ?? null,
    createdByUserId: input.createdByUserId,
  });
  return loadAccount(id);
}

export async function updateTrackingAccount(
  id: string,
  patch: {
    name?: string;
    accountCategory?: string;
    counterCategory?: string;
    parentId?: string | null;
    code?: string | null;
    notes?: string | null;
  },
): Promise<Account> {
  await loadAccount(id);
  if (patch.name !== undefined && !patch.name.trim()) {
    throw new TrackingError("INVALID_INPUT", "name cannot be blank");
  }
  if (patch.parentId) {
    await loadAccount(patch.parentId);
    await assertNoCycle(id, patch.parentId);
  }

  await db
    .update(trackingAccounts)
    .set({
      ...(patch.name !== undefined && { name: patch.name.trim() }),
      ...(patch.accountCategory !== undefined && {
        accountCategory: patch.accountCategory.trim(),
      }),
      ...(patch.counterCategory !== undefined && {
        counterCategory: patch.counterCategory.trim(),
      }),
      ...(patch.parentId !== undefined && { parentId: patch.parentId }),
      ...(patch.code !== undefined && { code: patch.code }),
      ...(patch.notes !== undefined && { notes: patch.notes }),
    })
    .where(eq(trackingAccounts.id, id));
  return loadAccount(id);
}

export async function setTrackingAccountArchived(
  id: string,
  archived: boolean,
): Promise<Account> {
  await loadAccount(id);
  await db
    .update(trackingAccounts)
    .set({ archivedAt: archived ? new Date() : null })
    .where(eq(trackingAccounts.id, id));
  return loadAccount(id);
}

/**
 * Hard delete. Refused while the account has children or carries a non-zero
 * balance. `tracking_account_ledger` cascade-deletes; variant/order_item
 * references null out via `ON DELETE SET NULL`.
 */
export async function hardDeleteTrackingAccount(id: string): Promise<void> {
  const account = await loadAccount(id);
  if (account.balanceMinor !== 0) throw new TrackingError("HAS_BALANCE");
  const child = await db.query.trackingAccounts.findFirst({
    where: eq(trackingAccounts.parentId, id),
  });
  if (child) throw new TrackingError("HAS_CHILDREN");
  await db.delete(trackingAccounts).where(eq(trackingAccounts.id, id));
}

/** Per-account ledger SUM → write it back to the cached `balanceMinor`. */
async function syncBalance(tx: Tx, accountId: string): Promise<void> {
  const sums = await tx
    .select({
      total: sql<number>`COALESCE(SUM(${trackingAccountLedger.amountMinor}), 0)`,
    })
    .from(trackingAccountLedger)
    .where(eq(trackingAccountLedger.trackingAccountId, accountId));
  await tx
    .update(trackingAccounts)
    .set({ balanceMinor: Number(sums[0]?.total ?? 0) })
    .where(eq(trackingAccounts.id, accountId));
}

/** Shared writer for the manual ledger ops. */
async function postLedgerRow(input: {
  accountId: string;
  type: (typeof trackingAccountLedger.$inferInsert)["type"];
  amountMinor: number;
  posSessionId?: string | null;
  note?: string | null;
  counterCategoryOverride?: string | null;
  createdByUserId: string;
}): Promise<Account> {
  return db.transaction(async (tx) => {
    const account = await tx.query.trackingAccounts.findFirst({
      where: eq(trackingAccounts.id, input.accountId),
    });
    if (!account) throw new TrackingError("ACCOUNT_NOT_FOUND");

    await tx.insert(trackingAccountLedger).values({
      id: ulid(),
      trackingAccountId: input.accountId,
      type: input.type,
      amountMinor: input.amountMinor,
      refType: "manual",
      note: input.note ?? null,
      counterCategoryOverride: input.counterCategoryOverride ?? null,
      posSessionId: input.posSessionId ?? null,
      createdByUserId: input.createdByUserId,
    });
    await syncBalance(tx, input.accountId);

    const row = await tx.query.trackingAccounts.findFirst({
      where: eq(trackingAccounts.id, input.accountId),
    });
    return row as Account;
  });
}

/**
 * Pay an account out of the drawer (e.g. settle a mechanic's commission). The
 * positive `amountMinor` is stored as a negative ledger row — it reduces the
 * balance. `posSessionId` records the drawer the cash left.
 */
export function recordTrackingPayout(input: {
  accountId: string;
  amountMinor: number;
  posSessionId?: string | null;
  note?: string | null;
  createdByUserId: string;
}): Promise<Account> {
  if (!Number.isInteger(input.amountMinor) || input.amountMinor <= 0) {
    throw new TrackingError("INVALID_INPUT", "payout amount must be a positive integer");
  }
  return postLedgerRow({
    accountId: input.accountId,
    type: "payout",
    amountMinor: -input.amountMinor,
    posSessionId: input.posSessionId,
    note: input.note,
    createdByUserId: input.createdByUserId,
  });
}

/**
 * Preload / advance cash into an account. The positive `amountMinor` is stored
 * as a positive ledger row — it grows the balance.
 */
export function recordTrackingDeposit(input: {
  accountId: string;
  amountMinor: number;
  posSessionId?: string | null;
  note?: string | null;
  createdByUserId: string;
}): Promise<Account> {
  if (!Number.isInteger(input.amountMinor) || input.amountMinor <= 0) {
    throw new TrackingError("INVALID_INPUT", "deposit amount must be a positive integer");
  }
  return postLedgerRow({
    accountId: input.accountId,
    type: "deposit",
    amountMinor: input.amountMinor,
    posSessionId: input.posSessionId,
    note: input.note,
    createdByUserId: input.createdByUserId,
  });
}

/**
 * Root-only manual balance correction (write-off, opening balance). Signed
 * `amountMinor` and a `note` are both required. `counterCategoryOverride` may
 * name a different offsetting category than the account's default.
 */
export async function adjustTrackingBalance(input: {
  accountId: string;
  amountMinor: number;
  note: string;
  counterCategoryOverride?: string | null;
  createdByUserId: string;
}): Promise<Account> {
  if (!Number.isInteger(input.amountMinor) || input.amountMinor === 0) {
    throw new TrackingError("INVALID_INPUT", "adjustment amount must be a non-zero integer");
  }
  if (!input.note.trim()) {
    throw new TrackingError("INVALID_INPUT", "adjustment note is required");
  }
  return db.transaction(async (tx) => {
    const account = await tx.query.trackingAccounts.findFirst({
      where: eq(trackingAccounts.id, input.accountId),
    });
    if (!account) throw new TrackingError("ACCOUNT_NOT_FOUND");

    await tx.insert(trackingAccountLedger).values({
      id: ulid(),
      trackingAccountId: input.accountId,
      type: "adjustment",
      amountMinor: input.amountMinor,
      refType: "adjustment",
      note: input.note.trim(),
      counterCategoryOverride: input.counterCategoryOverride ?? null,
      createdByUserId: input.createdByUserId,
    });
    await syncBalance(tx, input.accountId);

    const row = await tx.query.trackingAccounts.findFirst({
      where: eq(trackingAccounts.id, input.accountId),
    });
    return row as Account;
  });
}

/** Recent ledger entries for an account, newest first. */
export async function listTrackingAccountLedger(
  accountId: string,
  limit = 100,
): Promise<LedgerEntry[]> {
  await loadAccount(accountId);
  return db
    .select()
    .from(trackingAccountLedger)
    .where(eq(trackingAccountLedger.trackingAccountId, accountId))
    .orderBy(desc(trackingAccountLedger.createdAt))
    .limit(Math.min(Math.max(limit, 1), 500));
}
