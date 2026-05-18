// Integration tests for purchase-alert-service — the no-delivery reminder
// scan and acknowledgement. Runs against the local Docker MariaDB
// (DATABASE_URL) and WIPEs the purchase / alert tables between tests, so
// point it only at a dev database.
//
//   bun test src/services/purchase-alert-service.test.ts

import "../lib/load-env.ts";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { eq, sql } from "drizzle-orm";
import { ulid } from "ulid";
import { users } from "../db/schema/auth.ts";
import { purchaseAlerts } from "../db/schema/purchase-alerts.ts";
import { purchaseSends, purchases } from "../db/schema/purchases.ts";
import { db } from "../lib/db.ts";
import {
  acknowledgePurchaseAlert,
  listPurchaseAlerts,
  purgeAcknowledgedAlerts,
  PurchaseAlertError,
  type PurchaseAlertErrorCode,
  raiseDeliveryOverdueAlerts,
  raiseSendDueAlerts,
} from "./purchase-alert-service.ts";

let userId: string;

async function wipe(): Promise<void> {
  await db.execute(sql`SET FOREIGN_KEY_CHECKS = 0`);
  for (const t of ["purchase_alerts", "purchase_sends", "purchases"]) {
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
    name: "Alert Test",
  });
});

afterAll(async () => {
  await wipe();
  await db.delete(users).where(eq(users.id, userId));
});

beforeEach(wipe);

const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000);
const dateStr = (d: Date) => d.toISOString().slice(0, 10);

/** Insert a purchase. Returns its id. */
async function seedPurchase(
  status: "open" | "complete" | "cancelled" = "open",
  sendDueDate?: string,
): Promise<string> {
  const id = ulid();
  await db.insert(purchases).values({
    id,
    snapshotVendorName: "Acme",
    date: "2026-01-01",
    status,
    sendDueDate: sendDueDate ?? null,
    createdByUserId: userId,
  });
  return id;
}

/** Insert a send row directly — lets tests control sentAt / expected date. */
async function seedSend(input: {
  purchaseId: string;
  status?: "prepared" | "sent";
  sentAt?: Date | null;
  expectedDeliveryDate?: string | null;
}): Promise<void> {
  await db.insert(purchaseSends).values({
    id: ulid(),
    purchaseId: input.purchaseId,
    channel: "whatsapp",
    recipient: "+15550000",
    revision: 1,
    status: input.status ?? "sent",
    sentAt: input.sentAt ?? null,
    expectedDeliveryDate: input.expectedDeliveryDate ?? null,
    createdByUserId: userId,
  });
}

async function expectError(
  p: Promise<unknown>,
  code: PurchaseAlertErrorCode,
): Promise<void> {
  const err = await p.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(PurchaseAlertError);
  expect((err as PurchaseAlertError).code).toBe(code);
}

describe("raiseDeliveryOverdueAlerts", () => {
  test("raises an alert when the expected delivery date has passed", async () => {
    const purchaseId = await seedPurchase("open");
    await seedSend({
      purchaseId,
      sentAt: daysAgo(3),
      expectedDeliveryDate: dateStr(daysAgo(1)),
    });

    const raised = await raiseDeliveryOverdueAlerts();
    expect(raised).toHaveLength(1);
    expect(raised[0]?.purchaseId).toBe(purchaseId);
    expect(raised[0]?.type).toBe("delivery_overdue");
  });

  test("raises an alert when sent past the grace period with no expected date", async () => {
    const purchaseId = await seedPurchase("open");
    await seedSend({ purchaseId, sentAt: daysAgo(20) });
    expect(await raiseDeliveryOverdueAlerts(14)).toHaveLength(1);
  });

  test("does not raise when still within the grace period", async () => {
    const purchaseId = await seedPurchase("open");
    await seedSend({ purchaseId, sentAt: daysAgo(5) });
    expect(await raiseDeliveryOverdueAlerts(14)).toHaveLength(0);
  });

  test("does not raise when the expected date is still in the future", async () => {
    const purchaseId = await seedPurchase("open");
    await seedSend({
      purchaseId,
      sentAt: daysAgo(2),
      expectedDeliveryDate: dateStr(daysAgo(-5)),
    });
    expect(await raiseDeliveryOverdueAlerts()).toHaveLength(0);
  });

  test("ignores complete purchases and prepared (unconfirmed) sends", async () => {
    const complete = await seedPurchase("complete");
    await seedSend({ purchaseId: complete, sentAt: daysAgo(30) });

    const prepared = await seedPurchase("open");
    await seedSend({ purchaseId: prepared, status: "prepared", sentAt: null });

    expect(await raiseDeliveryOverdueAlerts()).toHaveLength(0);
  });

  test("is idempotent — a second scan raises no duplicate", async () => {
    const purchaseId = await seedPurchase("open");
    await seedSend({ purchaseId, sentAt: daysAgo(30) });

    expect(await raiseDeliveryOverdueAlerts()).toHaveLength(1);
    expect(await raiseDeliveryOverdueAlerts()).toHaveLength(0);
    expect(await listPurchaseAlerts({ acknowledged: false })).toHaveLength(1);
  });

  test("rejects an invalid grace period", async () => {
    await expectError(raiseDeliveryOverdueAlerts(-1), "INVALID_INPUT");
  });
});

describe("raiseSendDueAlerts", () => {
  test("raises an alert once the send-by date has arrived", async () => {
    const past = await seedPurchase("open", dateStr(daysAgo(1)));
    const today = await seedPurchase("open", dateStr(daysAgo(0)));

    const raised = await raiseSendDueAlerts();
    expect(raised.map((a) => a.purchaseId).sort()).toEqual([past, today].sort());
    expect(raised.every((a) => a.type === "send_due")).toBe(true);
  });

  test("does not raise before the date, or with no date set", async () => {
    await seedPurchase("open", dateStr(daysAgo(-5))); // future
    await seedPurchase("open"); // no send-by date
    expect(await raiseSendDueAlerts()).toHaveLength(0);
  });

  test("does not raise once the PO has a confirmed send", async () => {
    const purchaseId = await seedPurchase("open", dateStr(daysAgo(2)));
    await seedSend({ purchaseId, status: "sent", sentAt: daysAgo(1) });
    expect(await raiseSendDueAlerts()).toHaveLength(0);
  });

  test("still raises when only a prepared (unconfirmed) send exists", async () => {
    const purchaseId = await seedPurchase("open", dateStr(daysAgo(2)));
    await seedSend({ purchaseId, status: "prepared", sentAt: null });
    expect(await raiseSendDueAlerts()).toHaveLength(1);
  });

  test("ignores non-open purchases", async () => {
    await seedPurchase("complete", dateStr(daysAgo(2)));
    await seedPurchase("cancelled", dateStr(daysAgo(2)));
    expect(await raiseSendDueAlerts()).toHaveLength(0);
  });

  test("is idempotent — a second scan raises no duplicate", async () => {
    await seedPurchase("open", dateStr(daysAgo(1)));
    expect(await raiseSendDueAlerts()).toHaveLength(1);
    expect(await raiseSendDueAlerts()).toHaveLength(0);
  });
});

describe("acknowledgePurchaseAlert", () => {
  async function seedOverdueAlert(): Promise<string> {
    const purchaseId = await seedPurchase("open");
    await seedSend({ purchaseId, sentAt: daysAgo(30) });
    const [alert] = await raiseDeliveryOverdueAlerts();
    return alert!.id;
  }

  test("acknowledges an alert and records who and the note", async () => {
    const id = await seedOverdueAlert();
    const out = await acknowledgePurchaseAlert({
      id,
      userId,
      resolutionNote: "chased the vendor",
    });
    expect(out.acknowledgedAt).not.toBeNull();
    expect(out.acknowledgedByUserId).toBe(userId);
    expect(out.resolutionNote).toBe("chased the vendor");

    expect(await listPurchaseAlerts({ acknowledged: false })).toHaveLength(0);
    expect(await listPurchaseAlerts({ acknowledged: true })).toHaveLength(1);
  });

  test("an alert cannot be acknowledged twice", async () => {
    const id = await seedOverdueAlert();
    await acknowledgePurchaseAlert({ id, userId });
    await expectError(
      acknowledgePurchaseAlert({ id, userId }),
      "ALREADY_ACKNOWLEDGED",
    );
  });

  test("rejects an unknown alert id", async () => {
    await expectError(
      acknowledgePurchaseAlert({ id: ulid(), userId }),
      "ALERT_NOT_FOUND",
    );
  });

  test("a fresh alert can be raised after the prior one is acknowledged", async () => {
    const purchaseId = await seedPurchase("open");
    await seedSend({ purchaseId, sentAt: daysAgo(30) });

    const [first] = await raiseDeliveryOverdueAlerts();
    await acknowledgePurchaseAlert({ id: first!.id, userId });

    // The open-alert constraint is clear again — the scan may re-raise.
    const second = await raiseDeliveryOverdueAlerts();
    expect(second).toHaveLength(1);
    expect(second[0]?.id).not.toBe(first!.id);
  });
});

describe("purgeAcknowledgedAlerts", () => {
  /** Insert an alert row directly, with chosen timestamps. Returns its id. */
  async function seedAlert(opts: {
    acknowledgedAt?: Date | null;
    triggeredAt?: Date;
  }): Promise<string> {
    const purchaseId = await seedPurchase("open");
    const id = ulid();
    await db.insert(purchaseAlerts).values({
      id,
      purchaseId,
      type: "delivery_overdue",
      triggeredAt: opts.triggeredAt ?? new Date(),
      acknowledgedAt: opts.acknowledgedAt ?? null,
    });
    return id;
  }

  test("purges acknowledged alerts past the retention window, keeps the rest", async () => {
    await seedAlert({ acknowledgedAt: daysAgo(400) }); // old → purged
    const recent = await seedAlert({ acknowledgedAt: daysAgo(10) }); // kept

    expect(await purgeAcknowledgedAlerts()).toBe(1);
    const remaining = await listPurchaseAlerts();
    expect(remaining.map((a) => a.id)).toEqual([recent]);
  });

  test("never purges an open alert, however old", async () => {
    await seedAlert({ acknowledgedAt: null, triggeredAt: daysAgo(800) });
    expect(await purgeAcknowledgedAlerts()).toBe(0);
    expect(await listPurchaseAlerts({ acknowledged: false })).toHaveLength(1);
  });
});
