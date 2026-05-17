// POS service: register CRUD (root-only at the GraphQL layer) plus the
// cashier-shift lifecycle — open, close, reopen, force-close. Closing computes
// and stores a cash variance and snapshots a Z-report; it never blocks on a
// non-zero variance. See docs/design-decisions.md → "Points of Sale" and
// "POS sessions".

import { and, desc, eq, isNull } from "drizzle-orm";
import { ulid } from "ulid";
import { orderItems, orderPayments, orders } from "../db/schema/orders.ts";
import { pointsOfSale, posSessions } from "../db/schema/pos.ts";
import { db } from "../lib/db.ts";

export type PosErrorCode =
  | "POS_NOT_FOUND"
  | "SESSION_NOT_FOUND"
  | "INVALID_INPUT"
  | "POS_ARCHIVED"
  | "CODE_TAKEN"
  | "SESSION_ALREADY_OPEN"
  | "SESSION_CLOSED"
  | "SESSION_NOT_CLOSED"
  | "REOPEN_WINDOW_EXPIRED"
  | "HAS_SESSIONS";

export class PosError extends Error {
  constructor(
    public code: PosErrorCode,
    message?: string,
  ) {
    super(message ?? code);
    this.name = "PosError";
  }
}

type Pos = typeof pointsOfSale.$inferSelect;
type Session = typeof posSessions.$inferSelect;

/** A drizzle transaction handle; structurally a subset of `db`. */
type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/** Reopen is allowed only within this window after close. */
const REOPEN_WINDOW_MS = 24 * 60 * 60 * 1000;

// --- Points of sale ---

export function listPointsOfSale(includeArchived = false): Promise<Pos[]> {
  return db
    .select()
    .from(pointsOfSale)
    .where(includeArchived ? undefined : isNull(pointsOfSale.archivedAt));
}

async function loadPos(id: string): Promise<Pos> {
  const row = await db.query.pointsOfSale.findFirst({
    where: eq(pointsOfSale.id, id),
  });
  if (!row) throw new PosError("POS_NOT_FOUND");
  return row;
}

export { loadPos as getPointOfSale };

export async function createPointOfSale(input: {
  locationId: string;
  code: string;
  name: string;
  notes?: string | null;
  createdByUserId: string;
}): Promise<Pos> {
  const code = input.code.trim();
  if (!code) throw new PosError("INVALID_INPUT", "code is required");
  if (!input.name.trim()) throw new PosError("INVALID_INPUT", "name is required");

  const clash = await db.query.pointsOfSale.findFirst({
    where: eq(pointsOfSale.code, code),
  });
  if (clash) throw new PosError("CODE_TAKEN", `code "${code}" is already in use`);

  const id = ulid();
  await db.insert(pointsOfSale).values({
    id,
    locationId: input.locationId,
    code,
    name: input.name.trim(),
    notes: input.notes ?? null,
    createdByUserId: input.createdByUserId,
  });
  return loadPos(id);
}

export async function updatePointOfSale(
  id: string,
  patch: {
    locationId?: string;
    code?: string;
    name?: string;
    notes?: string | null;
  },
): Promise<Pos> {
  await loadPos(id);
  if (patch.name !== undefined && !patch.name.trim()) {
    throw new PosError("INVALID_INPUT", "name cannot be blank");
  }
  let code: string | undefined;
  if (patch.code !== undefined) {
    code = patch.code.trim();
    if (!code) throw new PosError("INVALID_INPUT", "code cannot be blank");
    const clash = await db.query.pointsOfSale.findFirst({
      where: eq(pointsOfSale.code, code),
    });
    if (clash && clash.id !== id) {
      throw new PosError("CODE_TAKEN", `code "${code}" is already in use`);
    }
  }

  await db
    .update(pointsOfSale)
    .set({
      ...(patch.locationId !== undefined && { locationId: patch.locationId }),
      ...(code !== undefined && { code }),
      ...(patch.name !== undefined && { name: patch.name.trim() }),
      ...(patch.notes !== undefined && { notes: patch.notes }),
    })
    .where(eq(pointsOfSale.id, id));
  return loadPos(id);
}

/** The currently-open session on a POS, or null. */
async function openSessionOnPos(posId: string): Promise<Session | null> {
  const row = await db.query.posSessions.findFirst({
    where: and(eq(posSessions.posId, posId), isNull(posSessions.closedAt)),
  });
  return row ?? null;
}

/** Archive (or unarchive) a POS. Archiving is refused while a session is open. */
export async function setPointOfSaleArchived(
  id: string,
  archived: boolean,
): Promise<Pos> {
  await loadPos(id);
  if (archived && (await openSessionOnPos(id))) {
    throw new PosError("SESSION_ALREADY_OPEN", "close the open session before archiving");
  }
  await db
    .update(pointsOfSale)
    .set({ archivedAt: archived ? new Date() : null })
    .where(eq(pointsOfSale.id, id));
  return loadPos(id);
}

/**
 * Hard delete. Refused while any session references the POS. The "zero
 * orders" half of the rule (design-decisions.md) is enforced once the orders
 * domain exists.
 */
export async function hardDeletePointOfSale(id: string): Promise<void> {
  await loadPos(id);
  const session = await db.query.posSessions.findFirst({
    where: eq(posSessions.posId, id),
  });
  if (session) throw new PosError("HAS_SESSIONS");
  await db.delete(pointsOfSale).where(eq(pointsOfSale.id, id));
}

// --- POS sessions ---

async function loadSession(id: string): Promise<Session> {
  const row = await db.query.posSessions.findFirst({
    where: eq(posSessions.id, id),
  });
  if (!row) throw new PosError("SESSION_NOT_FOUND");
  return row;
}

export { loadSession as getPosSession };

/** Sessions for a POS (or all), newest first. */
export function listPosSessions(posId?: string, limit = 100): Promise<Session[]> {
  return db
    .select()
    .from(posSessions)
    .where(posId ? eq(posSessions.posId, posId) : undefined)
    .orderBy(desc(posSessions.openedAt))
    .limit(Math.min(Math.max(limit, 1), 500));
}

/**
 * Open a cashier shift. Fails if the POS is archived or already has an open
 * session. The unique index on `open_pos_id` is the race-safe backstop; the
 * pre-check just yields a clean error message.
 */
export async function openSession(input: {
  posId: string;
  openingCashMinor: number;
  openedByUserId: string;
  notes?: string | null;
}): Promise<Session> {
  if (
    !Number.isInteger(input.openingCashMinor) ||
    input.openingCashMinor < 0
  ) {
    throw new PosError("INVALID_INPUT", "opening cash must be a non-negative integer");
  }
  const pos = await loadPos(input.posId);
  if (pos.archivedAt) {
    throw new PosError("POS_ARCHIVED", "an archived POS cannot open sessions");
  }
  if (await openSessionOnPos(input.posId)) {
    throw new PosError("SESSION_ALREADY_OPEN");
  }

  const id = ulid();
  await db.insert(posSessions).values({
    id,
    posId: input.posId,
    openedByUserId: input.openedByUserId,
    openingCashMinor: input.openingCashMinor,
    notes: input.notes ?? null,
  });
  return loadSession(id);
}

/** Totals snapshotted in a Z-report and used for the variance calc. */
interface SessionTotals {
  /** Net cash through orders this session: sales positive, refunds negative. */
  cashSalesMinor: number;
  /** Sale orders attributed to the session (excludes returns and cancelled). */
  orderCount: number;
  /** Return orders attributed to the session. */
  returnCount: number;
  /** Voided lines across the session's orders. */
  voidedItemCount: number;
}

/**
 * Tally the session's cash and order activity. `cashSalesMinor` is the SUM of
 * `order_payments.amount_minor` for the session — cash refunds are negative
 * rows, so the single SUM is already net of refunds. Standalone debt and
 * vendor cash payments are not folded in (design-decisions.md §"POS sessions"
 * states the variance formula over order cash only).
 */
async function sessionTotals(tx: Tx, sessionId: string): Promise<SessionTotals> {
  const payRows = await tx
    .select({ amt: orderPayments.amountMinor })
    .from(orderPayments)
    .where(eq(orderPayments.posSessionId, sessionId));
  const cashSalesMinor = payRows.reduce((sum, r) => sum + r.amt, 0);

  const orderRows = await tx
    .select({
      id: orders.id,
      returnOf: orders.returnOfOrderId,
      cancelledAt: orders.cancelledAt,
    })
    .from(orders)
    .where(eq(orders.posSessionId, sessionId));
  const orderCount = orderRows.filter(
    (o) => !o.returnOf && !o.cancelledAt,
  ).length;
  const returnCount = orderRows.filter((o) => o.returnOf).length;

  let voidedItemCount = 0;
  for (const o of orderRows) {
    const rows = await tx
      .select({ voidedAt: orderItems.voidedAt })
      .from(orderItems)
      .where(eq(orderItems.orderId, o.id));
    voidedItemCount += rows.filter((r) => r.voidedAt != null).length;
  }

  return { cashSalesMinor, orderCount, returnCount, voidedItemCount };
}

/** Denormalized close-time snapshot stored in `z_report_json`. */
function buildZReport(
  session: Session,
  totals: SessionTotals,
  expectedCashMinor: number,
  closingCashMinor: number | null,
  varianceMinor: number | null,
  closedAt: Date,
): Record<string, unknown> {
  return {
    openingCashMinor: session.openingCashMinor,
    cashSalesMinor: totals.cashSalesMinor,
    expectedCashMinor,
    closingCashMinor,
    varianceMinor,
    forceClosed: closingCashMinor === null,
    orderCount: totals.orderCount,
    returnCount: totals.returnCount,
    voidedItemCount: totals.voidedItemCount,
    closedAt: closedAt.toISOString(),
  };
}

/**
 * Close a session. Computes `variance = closing − (opening + net cash sales)`
 * and snapshots a Z-report. A non-zero variance is recorded, never blocked.
 * Ownership / permission (own vs others) is enforced by the caller.
 */
export async function closeSession(input: {
  sessionId: string;
  closingCashMinor: number;
  closedByUserId: string;
}): Promise<Session> {
  if (!Number.isInteger(input.closingCashMinor) || input.closingCashMinor < 0) {
    throw new PosError("INVALID_INPUT", "closing cash must be a non-negative integer");
  }
  return db.transaction(async (tx) => {
    const session = await tx.query.posSessions.findFirst({
      where: eq(posSessions.id, input.sessionId),
    });
    if (!session) throw new PosError("SESSION_NOT_FOUND");
    if (session.closedAt) throw new PosError("SESSION_CLOSED");

    const closedAt = new Date();
    const totals = await sessionTotals(tx, session.id);
    const expected = session.openingCashMinor + totals.cashSalesMinor;
    const variance = input.closingCashMinor - expected;

    await tx
      .update(posSessions)
      .set({
        closedByUserId: input.closedByUserId,
        closedAt,
        closingCashMinor: input.closingCashMinor,
        varianceMinor: variance,
        forceClosed: false,
        zReportJson: buildZReport(
          session,
          totals,
          expected,
          input.closingCashMinor,
          variance,
          closedAt,
        ),
      })
      .where(eq(posSessions.id, session.id));

    const row = await tx.query.posSessions.findFirst({
      where: eq(posSessions.id, session.id),
    });
    return row as Session;
  });
}

/**
 * Force-close a stranded session (power-out, crash). Leaves
 * `closingCashMinor`/`varianceMinor` null so reports flag it as
 * unreconciled, but still snapshots the session's activity totals.
 * Root-only — enforced by the caller.
 */
export async function forceCloseSession(input: {
  sessionId: string;
  closedByUserId: string;
}): Promise<Session> {
  return db.transaction(async (tx) => {
    const session = await tx.query.posSessions.findFirst({
      where: eq(posSessions.id, input.sessionId),
    });
    if (!session) throw new PosError("SESSION_NOT_FOUND");
    if (session.closedAt) throw new PosError("SESSION_CLOSED");

    const closedAt = new Date();
    const totals = await sessionTotals(tx, session.id);
    const expected = session.openingCashMinor + totals.cashSalesMinor;

    await tx
      .update(posSessions)
      .set({
        closedByUserId: input.closedByUserId,
        closedAt,
        closingCashMinor: null,
        varianceMinor: null,
        forceClosed: true,
        zReportJson: buildZReport(session, totals, expected, null, null, closedAt),
      })
      .where(eq(posSessions.id, session.id));

    const row = await tx.query.posSessions.findFirst({
      where: eq(posSessions.id, session.id),
    });
    return row as Session;
  });
}

/**
 * Reopen a recently-closed session to amend mistakes. Allowed only within 24h
 * of close, and only when the POS has no other session open. Root-only —
 * enforced by the caller. `z_report_json` is kept until the session re-closes.
 */
export async function reopenSession(sessionId: string): Promise<Session> {
  const session = await loadSession(sessionId);
  if (!session.closedAt) throw new PosError("SESSION_NOT_CLOSED");
  if (Date.now() - session.closedAt.getTime() > REOPEN_WINDOW_MS) {
    throw new PosError("REOPEN_WINDOW_EXPIRED");
  }
  const open = await openSessionOnPos(session.posId);
  if (open) {
    throw new PosError(
      "SESSION_ALREADY_OPEN",
      "another session is open on this POS",
    );
  }
  await db
    .update(posSessions)
    .set({ closedAt: null, closedByUserId: null })
    .where(eq(posSessions.id, sessionId));
  return loadSession(sessionId);
}
