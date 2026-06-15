// Purchase message service: render a purchase order into a vendor-ready
// message — the body a clerk sends over WhatsApp / email — and build the
// send draft (recipient + wa.me / mailto: deep link) for one channel. The
// business's configurable greeting and footer wrap the rendered order; each
// line shows the vendor's own code where one is mapped, falling back to our
// product name. Pure read — no side effects, no PDF.

import { eq, inArray } from "drizzle-orm";
import { products, productVariants } from "../db/schema/products.ts";
import { db } from "../lib/db.ts";
import { formatRp } from "../lib/money.ts";
import { getBusinessSettings } from "./business-service.ts";
import {
  getPurchase,
  invoiceTotalMinor,
  listItems,
  listSections,
} from "./purchase-service.ts";
import { getVendor } from "./vendor-service.ts";
import { listCodesForVendor } from "./vendor-variant-code-service.ts";

export interface PurchaseMessage {
  subject: string;
  body: string;
}

/** Money for display: "Rp 1,500,000.5" (international grouping, trimmed 2dp). */
const rp = (value: number): string => formatRp(value);

/**
 * Render a purchase order as a sendable message. Throws PurchaseError
 * (PURCHASE_NOT_FOUND) via `getPurchase` for an unknown id. `compact` drops
 * the greeting, the PURCHASE ORDER / From / Date / To header and the footer,
 * leaving only the item lines and total — for chat channels where the
 * conversation itself already carries the context.
 */
export async function renderPurchaseOrderMessage(
  purchaseId: string,
  opts: { compact?: boolean } = {},
): Promise<PurchaseMessage> {
  const compact = opts.compact === true;
  const purchase = await getPurchase(purchaseId);
  const [items, sections, business] = await Promise.all([
    listItems(purchaseId),
    listSections(purchaseId),
    getBusinessSettings(),
  ]);

  // The vendor's own code for each variant, where mapped.
  const vendorCode = new Map<string, string>();
  if (purchase.vendorId) {
    for (const c of await listCodesForVendor(purchase.vendorId)) {
      vendorCode.set(c.variantId, c.code);
    }
  }

  // Display name + unit per variant, for lines with no vendor code.
  const variantIds = [
    ...new Set(items.map((i) => i.variantId).filter((v): v is string => !!v)),
  ];
  const variantInfo = new Map<string, { name: string; unit: string }>();
  if (variantIds.length) {
    const rows = await db
      .select({
        id: productVariants.id,
        label: productVariants.label,
        unit: productVariants.unit,
        productName: products.name,
      })
      .from(productVariants)
      .innerJoin(products, eq(productVariants.productId, products.id))
      .where(inArray(productVariants.id, variantIds));
    for (const r of rows) {
      variantInfo.set(r.id, {
        name: r.label ? `${r.productName} (${r.label})` : r.productName,
        unit: r.unit,
      });
    }
  }

  const lineLabel = (item: (typeof items)[number]): string => {
    if (item.variantId) {
      return (
        vendorCode.get(item.variantId) ??
        variantInfo.get(item.variantId)?.name ??
        "Item"
      );
    }
    return item.description?.trim() || "Item";
  };

  const out: string[] = [];
  if (!compact) {
    if (business.poGreeting?.trim()) out.push(business.poGreeting.trim(), "");

    out.push("PURCHASE ORDER");
    if (business.name.trim()) out.push(`From: ${business.name.trim()}`);
    const contact = [business.phone, business.email].filter(Boolean).join(" · ");
    if (contact) out.push(contact);
    out.push(`Date: ${purchase.date}`);
    if (purchase.sourceDocument?.trim()) {
      out.push(`Ref: ${purchase.sourceDocument.trim()}`);
    }
    out.push("", `To: ${purchase.snapshotVendorName}`, "");
  }

  // One block per section, in order, then an "Uncategorized" block.
  const blocks: { name: string; sectionId: string | null }[] = [
    ...sections.map((s) => ({ name: s.name, sectionId: s.id as string | null })),
    { name: "Uncategorized", sectionId: null },
  ];
  for (const block of blocks) {
    const blockItems = items.filter((i) => i.sectionId === block.sectionId);
    if (blockItems.length === 0) continue;
    out.push(block.name);
    for (const item of blockItems) {
      const total = item.qtyOrdered * item.unitCostMinor;
      out.push(
        `  - ${lineLabel(item)} — ${item.qtyOrdered} @ ${rp(item.unitCostMinor)} = ${rp(total)}`,
      );
    }
    out.push("");
  }

  out.push(`Total: ${rp(await invoiceTotalMinor(purchaseId))}`);
  if (!compact && business.poFooter?.trim()) out.push("", business.poFooter.trim());

  const subject = business.name.trim()
    ? `Purchase Order from ${business.name.trim()}`
    : "Purchase Order";

  return { subject, body: out.join("\n") };
}

export type SendChannel = "whatsapp" | "email" | "manual";

export interface PurchaseSendDraft {
  channel: SendChannel;
  /** The recipient as held / overridden — raw, for display. */
  recipient: string | null;
  /** False when the recipient is missing or not usable for this channel. */
  recipientAvailable: boolean;
  subject: string;
  body: string;
  /** wa.me / mailto: URL; null when the recipient is unusable or channel is manual. */
  deepLink: string | null;
  /** API path to the PO PDF — for the share-sheet attachment path. Always set. */
  pdfUrl: string;
}

export const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Normalize an Indonesian phone number for `wa.me`: strip non-digits, turn a
 * leading `0` into `62`. Returns null when the field is unparseable — empty,
 * implausibly short/long, or holding more than one number (a `/` or `,`).
 */
export function normalizePhone(raw: string): string | null {
  if (raw.includes("/") || raw.includes(",")) return null;
  const digits = raw.replace(/\D/g, "");
  if (digits.length < 7 || digits.length > 15) return null;
  return digits.startsWith("0") ? `62${digits.slice(1)}` : digits;
}

/**
 * Build the send draft for one channel: the rendered message plus the
 * resolved recipient and a deep link the client opens with the device's own
 * connectivity. `recipientOverride` lets a clerk supply a contact the vendor
 * record lacks. `manual` carries no recipient or link — the body is for the
 * clerk to send off-system. Pure read.
 */
export async function buildPurchaseSendDraft(
  purchaseId: string,
  channel: SendChannel,
  recipientOverride?: string | null,
): Promise<PurchaseSendDraft> {
  // WhatsApp gets the compact body — only the item lines and total; the chat
  // with the vendor already says who it's from. Email and manual keep the
  // full document-style body.
  const { subject, body } = await renderPurchaseOrderMessage(purchaseId, {
    compact: channel === "whatsapp",
  });
  const purchase = await getPurchase(purchaseId);
  const vendor = purchase.vendorId ? await getVendor(purchase.vendorId) : null;

  const base = {
    channel,
    subject,
    body,
    pdfUrl: `/purchases/${purchaseId}/po.pdf`,
  };

  if (channel === "whatsapp") {
    const recipient = recipientOverride?.trim() || vendor?.phone || null;
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
    const recipient = recipientOverride?.trim() || vendor?.email || null;
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
