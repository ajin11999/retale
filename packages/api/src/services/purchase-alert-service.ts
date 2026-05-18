// Purchase alert service: the no-delivery reminder. `raiseDeliveryOverdueAlerts`
// scans sent-but-undelivered purchase orders and raises one `delivery_overdue`
// alert per overdue PO; `acknowledgePurchaseAlert` closes one. The scan is
// idempotent — it never raises a second open alert for a PO that already has
// one, so a daily run does not pile up duplicates. Alerts are never
// auto-closed (the locked product-alert philosophy).

import { and, desc, eq, inArray, isNotNull, isNull } from "drizzle-orm";
import { ulid } from "ulid";
import { purchaseAlerts } from "../db/schema/purchase-alerts.ts";
import { purchaseSends, purchases } from "../db/schema/purchases.ts";
import { db } from "../lib/db.ts";

export type PurchaseAlertErrorCode =
  | "ALERT_NOT_FOUND"
  | "ALREADY_ACKNOWLEDGED"
  | "INVALID_INPUT";

export class PurchaseAlertError extends Error {
  constructor(
    public code: PurchaseAlertErrorCode,
    message?: string,
  ) {
    super(message ?? code);
    this.name = "PurchaseAlertError";
  }
}

type PurchaseAlert = typeof purchaseAlerts.$inferSelect;

/** Default grace period for a PO with no recorded expected-delivery date. */
export const DEFAULT_GRACE_DAYS = 14;

const MS_PER_DAY = 86_400_000;

async function loadAlert(id: string): Promise<PurchaseAlert> {
  const row = await db.query.purchaseAlerts.findFirst({
    where: eq(purchaseAlerts.id, id),
  });
  if (!row) throw new PurchaseAlertError("ALERT_NOT_FOUND");
  return row;
}

export { loadAlert as getPurchaseAlert };

/** Alerts, newest first; optionally filtered to open or acknowledged only. */
export function listPurchaseAlerts(opts?: {
  acknowledged?: boolean;
}): Promise<PurchaseAlert[]> {
  const filter =
    opts?.acknowledged === undefined
      ? undefined
      : opts.acknowledged
        ? isNotNull(purchaseAlerts.acknowledgedAt)
        : isNull(purchaseAlerts.acknowledgedAt);
  return db
    .select()
    .from(purchaseAlerts)
    .where(filter)
    .orderBy(desc(purchaseAlerts.triggeredAt));
}

/**
 * Scan for overdue purchase orders and raise a `delivery_overdue` alert for
 * each one that does not already have an open alert. A PO is overdue when it
 * is still `open` (stock outstanding), has been confirmed-sent, and either its
 * recorded expected-delivery date has passed, or — with no date recorded — it
 * was sent more than `graceDays` ago. Returns the alerts newly raised.
 */
export async function raiseDeliveryOverdueAlerts(
  graceDays: number = DEFAULT_GRACE_DAYS,
): Promise<PurchaseAlert[]> {
  if (!Number.isInteger(graceDays) || graceDays < 0) {
    throw new PurchaseAlertError(
      "INVALID_INPUT",
      "graceDays must be a non-negative integer",
    );
  }

  const openPurchases = await db
    .select({ id: purchases.id })
    .from(purchases)
    .where(eq(purchases.status, "open"));
  if (openPurchases.length === 0) return [];
  const openIds = openPurchases.map((p) => p.id);

  // Latest confirmed-sent send per purchase (rows arrive newest-first).
  const sentRows = await db
    .select({
      purchaseId: purchaseSends.purchaseId,
      sentAt: purchaseSends.sentAt,
      expectedDeliveryDate: purchaseSends.expectedDeliveryDate,
    })
    .from(purchaseSends)
    .where(
      and(
        inArray(purchaseSends.purchaseId, openIds),
        eq(purchaseSends.status, "sent"),
      ),
    )
    .orderBy(desc(purchaseSends.sentAt));
  const latestSend = new Map<string, (typeof sentRows)[number]>();
  for (const r of sentRows) {
    if (!latestSend.has(r.purchaseId)) latestSend.set(r.purchaseId, r);
  }

  // Purchases that already carry an open delivery_overdue alert — skip them.
  const openAlerts = await db
    .select({ purchaseId: purchaseAlerts.purchaseId })
    .from(purchaseAlerts)
    .where(
      and(
        eq(purchaseAlerts.type, "delivery_overdue"),
        isNull(purchaseAlerts.acknowledgedAt),
      ),
    );
  const alreadyAlerted = new Set(openAlerts.map((a) => a.purchaseId));

  const now = new Date();
  const today = now.toISOString().slice(0, 10);
  const rows: (typeof purchaseAlerts.$inferInsert)[] = [];

  for (const purchaseId of openIds) {
    if (alreadyAlerted.has(purchaseId)) continue;
    const send = latestSend.get(purchaseId);
    if (!send) continue; // never sent — nothing to chase

    let reason: string | null = null;
    if (send.expectedDeliveryDate) {
      if (send.expectedDeliveryDate < today) reason = "expected_date_passed";
    } else if (send.sentAt) {
      const daysSent = (now.getTime() - send.sentAt.getTime()) / MS_PER_DAY;
      if (daysSent >= graceDays) reason = "no_delivery_after_grace";
    }
    if (!reason) continue;

    rows.push({
      id: ulid(),
      purchaseId,
      type: "delivery_overdue",
      triggeredAt: now,
      triggerContext: {
        reason,
        sentAt: send.sentAt ? send.sentAt.toISOString() : null,
        expectedDeliveryDate: send.expectedDeliveryDate ?? null,
        graceDays,
      },
    });
  }

  if (rows.length === 0) return [];
  await db.insert(purchaseAlerts).values(rows);
  return db
    .select()
    .from(purchaseAlerts)
    .where(
      inArray(
        purchaseAlerts.id,
        rows.map((r) => r.id as string),
      ),
    );
}

/**
 * Acknowledge an alert — a person has seen it. Optionally records a
 * resolution note. An alert can only be acknowledged once; it is never
 * reopened or auto-closed.
 */
export async function acknowledgePurchaseAlert(input: {
  id: string;
  userId: string;
  resolutionNote?: string | null;
}): Promise<PurchaseAlert> {
  const alert = await loadAlert(input.id);
  if (alert.acknowledgedAt) {
    throw new PurchaseAlertError(
      "ALREADY_ACKNOWLEDGED",
      "this alert has already been acknowledged",
    );
  }
  await db
    .update(purchaseAlerts)
    .set({
      acknowledgedAt: new Date(),
      acknowledgedByUserId: input.userId,
      resolutionNote: input.resolutionNote?.trim() || null,
    })
    .where(eq(purchaseAlerts.id, input.id));
  return loadAlert(input.id);
}
