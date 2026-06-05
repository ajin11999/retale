// Order message service: render a customer sale into a customer-ready receipt
// message — the body a clerk sends over WhatsApp / email — and build the send
// draft (recipient + wa.me / mailto: deep link) for one channel. The business's
// configurable receipt greeting and footer wrap the rendered receipt. Each line
// shows the public-facing name snapshotted at sale time. Pure read — no side
// effects, no PDF (that lives in order-receipt-pdf-service.ts).

import { getCustomer } from "./customer-service.ts";
import { getBusinessSettings } from "./business-service.ts";
import { getOrder, listOrderItems, listOrderPayments } from "./order-service.ts";
import {
  EMAIL_RE,
  normalizePhone,
  type SendChannel,
} from "./purchase-message-service.ts";

export interface OrderMessage {
  subject: string;
  body: string;
}

/** Group an integer with "." thousands separators — Indonesian style. */
function groupThousands(n: number): string {
  return Math.trunc(n)
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/g, ".");
}

const rp = (minor: number): string => `Rp ${groupThousands(minor)}`;

/** A timestamp / date as a plain YYYY-MM-DD string. */
const dateOnly = (d: Date | string): string => new Date(d).toISOString().slice(0, 10);

/**
 * Render a customer sale as a sendable receipt message. Throws OrderError
 * (ORDER_NOT_FOUND) via `getOrder` for an unknown id.
 */
export async function renderOrderReceiptMessage(
  orderId: string,
): Promise<OrderMessage> {
  const order = await getOrder(orderId);
  const [items, payments, business] = await Promise.all([
    listOrderItems(orderId),
    listOrderPayments(orderId),
    getBusinessSettings(),
  ]);

  // Only live (non-voided) lines belong on a receipt.
  const liveItems = items.filter((i) => !i.voidedAt);

  const out: string[] = [];
  if (business.receiptGreeting?.trim()) out.push(business.receiptGreeting.trim(), "");

  out.push("RECEIPT");
  if (business.name.trim()) out.push(`From: ${business.name.trim()}`);
  const contact = [business.phone, business.email].filter(Boolean).join(" · ");
  if (contact) out.push(contact);
  out.push(`Date: ${dateOnly(order.closedAt ?? order.createdAt)}`);
  if (order.displayNumber) out.push(`No: ${order.displayNumber}`);
  out.push("", `To: ${order.snapshotCustomerName ?? "Walk-in"}`, "");

  for (const item of liveItems) {
    const name = item.snapshotPublicName ?? item.snapshotProductName;
    const lineTotal = item.qty * item.snapshotPriceMinor - item.discountMinor;
    const discNote = item.discountMinor ? ` (disc ${rp(item.discountMinor)})` : "";
    out.push(
      `  - ${name} — ${item.qty} @ ${rp(item.snapshotPriceMinor)}${discNote} = ${rp(lineTotal)}`,
    );
  }
  if (liveItems.length === 0) out.push("  (no items)");
  out.push("");

  // Cached order total is the source of truth (sum of live line totals).
  out.push(`Total: ${rp(order.totalMinor)}`);
  const paid = payments.reduce((acc, p) => acc + p.amountMinor, 0);
  // Surface payment standing only when there's something to say — a fully-paid
  // walk-in receipt needn't spell out a zero balance.
  if (paid > 0 || paid < order.totalMinor) {
    out.push(`Paid: ${rp(paid)}`);
    const balance = order.totalMinor - paid;
    if (balance > 0) out.push(`Balance due: ${rp(balance)}`);
  }

  if (business.receiptFooter?.trim()) out.push("", business.receiptFooter.trim());

  const label = order.displayNumber ? ` ${order.displayNumber}` : "";
  const subject = business.name.trim()
    ? `Receipt${label} from ${business.name.trim()}`
    : `Receipt${label}`;

  return { subject, body: out.join("\n") };
}

export interface OrderSendDraft {
  channel: SendChannel;
  /** The recipient as held / overridden — raw, for display. */
  recipient: string | null;
  /** False when the recipient is missing or not usable for this channel. */
  recipientAvailable: boolean;
  subject: string;
  body: string;
  /** wa.me / mailto: URL; null when the recipient is unusable or channel is manual. */
  deepLink: string | null;
  /** API path to the receipt PDF — for the share-sheet attachment path. Always set. */
  pdfUrl: string;
}

/**
 * Build the send draft for one channel: the rendered receipt plus the resolved
 * recipient and a deep link the client opens with the device's own
 * connectivity. `recipientOverride` lets a clerk supply a contact the customer
 * record lacks (or that a walk-in / deleted customer leaves missing). `manual`
 * carries no recipient or link — the body is for the clerk to send off-system.
 * Pure read.
 */
export async function buildOrderSendDraft(
  orderId: string,
  channel: SendChannel,
  recipientOverride?: string | null,
): Promise<OrderSendDraft> {
  const { subject, body } = await renderOrderReceiptMessage(orderId);
  const order = await getOrder(orderId);

  // The order keeps a snapshot name after a hard-delete; the live row carries
  // the contact details. Missing customer (walk-in or deleted) → no contact.
  let customer: Awaited<ReturnType<typeof getCustomer>> | null = null;
  if (order.customerId) {
    try {
      customer = await getCustomer(order.customerId);
    } catch {
      customer = null;
    }
  }

  const base = {
    channel,
    subject,
    body,
    pdfUrl: `/orders/${orderId}/receipt.pdf`,
  };

  if (channel === "whatsapp") {
    const recipient = recipientOverride?.trim() || customer?.phone || null;
    const normalized = recipient ? normalizePhone(recipient) : null;
    return {
      ...base,
      recipient,
      recipientAvailable: normalized !== null,
      deepLink: normalized
        ? `https://wa.me/${normalized}?text=${encodeURIComponent(body)}`
        : null,
    };
  }

  if (channel === "email") {
    const recipient = recipientOverride?.trim() || customer?.email || null;
    const available = recipient !== null && EMAIL_RE.test(recipient);
    return {
      ...base,
      recipient,
      recipientAvailable: available,
      deepLink: available
        ? `mailto:${recipient}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`
        : null,
    };
  }

  // manual — handled off-system; the body is all the clerk needs.
  return { ...base, recipient: null, recipientAvailable: false, deepLink: null };
}
