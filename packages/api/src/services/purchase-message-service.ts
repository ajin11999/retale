// Purchase message service: render a purchase order into a vendor-ready text
// message — the body a clerk sends over WhatsApp / email. The business's
// configurable greeting and footer wrap the rendered order; each line shows
// the vendor's own code where one is mapped, falling back to our product
// name. Pure read — no side effects, no deep links, no PDF.

import { eq, inArray } from "drizzle-orm";
import { products, productVariants } from "../db/schema/products.ts";
import { db } from "../lib/db.ts";
import { getBusinessSettings } from "./business-service.ts";
import {
  getPurchase,
  invoiceTotalMinor,
  listItems,
  listSections,
} from "./purchase-service.ts";
import { listCodesForVendor } from "./vendor-variant-code-service.ts";

export interface PurchaseMessage {
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

/**
 * Render a purchase order as a sendable message. Throws PurchaseError
 * (PURCHASE_NOT_FOUND) via `getPurchase` for an unknown id.
 */
export async function renderPurchaseOrderMessage(
  purchaseId: string,
): Promise<PurchaseMessage> {
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
  if (business.poFooter?.trim()) out.push("", business.poFooter.trim());

  const subject = business.name.trim()
    ? `Purchase Order from ${business.name.trim()}`
    : "Purchase Order";

  return { subject, body: out.join("\n") };
}
