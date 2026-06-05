// Integration tests for the customer-receipt message renderer and send-draft
// builder. Runs against the local Docker MariaDB (DATABASE_URL) and WIPEs the
// business / order / customer tables between tests.
//
//   bun test src/services/order-message-service.test.ts

import "../lib/load-env.ts";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { eq, sql } from "drizzle-orm";
import { ulid } from "ulid";
import { users } from "../db/schema/auth.ts";
import { customers } from "../db/schema/customers.ts";
import { orderItems, orderPayments, orders } from "../db/schema/orders.ts";
import { db } from "../lib/db.ts";
import { updateBusinessSettings } from "./business-service.ts";
import {
  buildOrderSendDraft,
  renderOrderReceiptMessage,
} from "./order-message-service.ts";
import { OrderError } from "./order-service.ts";
import { renderOrderReceiptPdf } from "./order-receipt-pdf-service.ts";

let userId: string;

async function wipe(): Promise<void> {
  await db.execute(sql`SET FOREIGN_KEY_CHECKS = 0`);
  for (const t of [
    "business_settings",
    "order_payments",
    "order_items",
    "orders",
    "customers",
  ]) {
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
    name: "Order Message Test",
  });
});

afterAll(async () => {
  await wipe();
  await db.delete(users).where(eq(users.id, userId));
});

beforeEach(wipe);

async function seedCustomer(opts?: {
  name?: string;
  phone?: string;
  email?: string;
}): Promise<string> {
  const id = ulid();
  await db.insert(customers).values({
    id,
    name: opts?.name ?? "Pak Budi",
    phone: opts?.phone ?? null,
    email: opts?.email ?? null,
  });
  return id;
}

interface SeedLine {
  name: string;
  publicName?: string | null;
  qty: number;
  priceMinor: number;
  discountMinor?: number;
  voided?: boolean;
}

/** Insert an order plus its lines; returns the order id. */
async function seedOrder(opts: {
  customerId?: string | null;
  customerName?: string | null;
  displayNumber?: string | null;
  lines: SeedLine[];
  paidMinor?: number;
}): Promise<string> {
  const id = ulid();
  const total = opts.lines
    .filter((l) => !l.voided)
    .reduce((acc, l) => acc + l.qty * l.priceMinor - (l.discountMinor ?? 0), 0);
  await db.insert(orders).values({
    id,
    displayNumber: opts.displayNumber ?? null,
    customerId: opts.customerId ?? null,
    snapshotCustomerName: opts.customerName ?? null,
    totalMinor: total,
    closedAt: opts.displayNumber ? new Date() : null,
    createdByUserId: userId,
  });
  for (const l of opts.lines) {
    await db.insert(orderItems).values({
      id: ulid(),
      orderId: id,
      qty: l.qty,
      discountMinor: l.discountMinor ?? 0,
      snapshotProductName: l.name,
      snapshotPublicName: l.publicName ?? null,
      snapshotProductSku: `SKU-${ulid()}`,
      snapshotUnit: "piece",
      snapshotPriceMinor: l.priceMinor,
      snapshotCostMinor: 0,
      snapshotTaxRateBps: 0,
      snapshotPriceMode: "tax_inclusive",
      voidedAt: l.voided ? new Date() : null,
    });
  }
  if (opts.paidMinor) {
    await db.insert(orderPayments).values({
      id: ulid(),
      orderId: id,
      method: "cash",
      amountMinor: opts.paidMinor,
      createdByUserId: userId,
    });
  }
  return id;
}

describe("renderOrderReceiptMessage", () => {
  test("renders header, lines and total; wraps with greeting and footer", async () => {
    await updateBusinessSettings({
      name: "Frans Retail",
      receiptGreeting: "Terima kasih,",
      receiptFooter: "Barang yang sudah dibeli tidak dapat dikembalikan.",
    });
    const customerId = await seedCustomer({ name: "Pak Budi" });
    const orderId = await seedOrder({
      customerId,
      customerName: "Pak Budi",
      displayNumber: "TK1-2026-06-05-12",
      lines: [{ name: "M6 Bolt", qty: 50, priceMinor: 2000 }],
    });

    const { subject, body } = await renderOrderReceiptMessage(orderId);
    expect(subject).toBe("Receipt TK1-2026-06-05-12 from Frans Retail");
    expect(body.startsWith("Terima kasih,")).toBe(true);
    expect(body.endsWith("Barang yang sudah dibeli tidak dapat dikembalikan.")).toBe(
      true,
    );
    expect(body).toContain("From: Frans Retail");
    expect(body).toContain("No: TK1-2026-06-05-12");
    expect(body).toContain("To: Pak Budi");
    expect(body).toContain("M6 Bolt — 50 @ Rp 2.000 = Rp 100.000");
    expect(body).toContain("Total: Rp 100.000");
  });

  test("uses the public name when present; notes a discount", async () => {
    const orderId = await seedOrder({
      customerName: "Walk-in",
      lines: [
        { name: "Internal SKU A", publicName: "Premium Widget", qty: 2, priceMinor: 5000, discountMinor: 1000 },
      ],
    });
    const { body } = await renderOrderReceiptMessage(orderId);
    expect(body).toContain("Premium Widget — 2 @ Rp 5.000 (disc Rp 1.000) = Rp 9.000");
    expect(body).not.toContain("Internal SKU A");
  });

  test("excludes voided lines and reflects an outstanding balance", async () => {
    const orderId = await seedOrder({
      customerName: "Pak Budi",
      lines: [
        { name: "Kept", qty: 1, priceMinor: 10000 },
        { name: "Voided", qty: 1, priceMinor: 99000, voided: true },
      ],
      paidMinor: 4000,
    });
    const { body } = await renderOrderReceiptMessage(orderId);
    expect(body).toContain("Kept — 1 @ Rp 10.000 = Rp 10.000");
    expect(body).not.toContain("Voided");
    expect(body).toContain("Total: Rp 10.000");
    expect(body).toContain("Paid: Rp 4.000");
    expect(body).toContain("Balance due: Rp 6.000");
  });

  test("rejects an unknown order", async () => {
    const err = await renderOrderReceiptMessage(ulid()).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(OrderError);
    expect((err as OrderError).code).toBe("ORDER_NOT_FOUND");
  });
});

describe("buildOrderSendDraft", () => {
  test("whatsapp: builds a wa.me link from the customer's phone", async () => {
    const customerId = await seedCustomer({ phone: "081234567890" });
    const orderId = await seedOrder({
      customerId,
      customerName: "Pak Budi",
      lines: [{ name: "Item", qty: 1, priceMinor: 1000 }],
    });

    const draft = await buildOrderSendDraft(orderId, "whatsapp");
    expect(draft.recipientAvailable).toBe(true);
    expect(draft.deepLink).toContain("https://wa.me/6281234567890?text=");
    expect(draft.pdfUrl).toBe(`/orders/${orderId}/receipt.pdf`);
  });

  test("a recipient override takes precedence over the customer record", async () => {
    const customerId = await seedCustomer({ phone: "081234567890" });
    const orderId = await seedOrder({
      customerId,
      lines: [{ name: "Item", qty: 1, priceMinor: 1000 }],
    });

    const draft = await buildOrderSendDraft(orderId, "whatsapp", "089999999999");
    expect(draft.recipient).toBe("089999999999");
    expect(draft.deepLink).toContain("wa.me/6289999999999");
  });

  test("email: builds a mailto link, or none when the address is missing", async () => {
    const withEmail = await seedCustomer({ email: "budi@example.test" });
    let draft = await buildOrderSendDraft(
      await seedOrder({ customerId: withEmail, lines: [{ name: "X", qty: 1, priceMinor: 1 }] }),
      "email",
    );
    expect(draft.recipientAvailable).toBe(true);
    expect(draft.deepLink).toContain("mailto:budi@example.test?subject=");

    const noEmail = await seedCustomer({});
    draft = await buildOrderSendDraft(
      await seedOrder({ customerId: noEmail, lines: [{ name: "X", qty: 1, priceMinor: 1 }] }),
      "email",
    );
    expect(draft.recipientAvailable).toBe(false);
    expect(draft.deepLink).toBeNull();
  });

  test("a walk-in (no customer) has no recipient but still renders a body", async () => {
    const orderId = await seedOrder({
      customerName: "Walk-in",
      lines: [{ name: "Item", qty: 1, priceMinor: 1000 }],
    });
    const draft = await buildOrderSendDraft(orderId, "whatsapp");
    expect(draft.recipient).toBeNull();
    expect(draft.recipientAvailable).toBe(false);
    expect(draft.body.length).toBeGreaterThan(0);
  });

  test("manual: carries the body but no recipient or link", async () => {
    const orderId = await seedOrder({
      customerName: "Pak Budi",
      lines: [{ name: "Item", qty: 1, priceMinor: 1000 }],
    });
    const draft = await buildOrderSendDraft(orderId, "manual");
    expect(draft.recipient).toBeNull();
    expect(draft.deepLink).toBeNull();
    expect(draft.recipientAvailable).toBe(false);
    expect(draft.subject.length).toBeGreaterThan(0);
  });
});

describe("renderOrderReceiptPdf", () => {
  test("produces a non-empty PDF document", async () => {
    await updateBusinessSettings({ name: "Frans Retail", receiptFooter: "Thank you." });
    const orderId = await seedOrder({
      customerName: "Pak Budi",
      displayNumber: "TK1-2026-06-05-1",
      lines: [
        { name: "M6 Bolt", qty: 10, priceMinor: 2000 },
        { name: "Discounted", qty: 1, priceMinor: 5000, discountMinor: 500 },
      ],
      paidMinor: 4000,
    });

    const pdf = await renderOrderReceiptPdf(orderId);
    expect(new TextDecoder().decode(pdf.slice(0, 5))).toBe("%PDF-");
    expect(pdf.byteLength).toBeGreaterThan(500);
  });

  test("rejects an unknown order", async () => {
    const err = await renderOrderReceiptPdf(ulid()).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(OrderError);
    expect((err as OrderError).code).toBe("ORDER_NOT_FOUND");
  });
});
