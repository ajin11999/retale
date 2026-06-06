// Purchases service: purchase-order header / section / item CRUD plus the
// append-only send log. Content edits (items, sections) bump `purchases.revision`
// in the same transaction. No stock is touched here — that happens at delivery
// commit (Phase 3). See docs/design-decisions.md → "Purchases & deliveries".

import { and, asc, desc, eq, inArray, isNull, ne, sql } from "drizzle-orm";
import { ulid } from "ulid";
import { productVariants } from "../db/schema/products.ts";
import {
  type PURCHASE_SEND_CHANNELS,
  purchaseItems,
  purchaseSections,
  purchaseSends,
  purchases,
} from "../db/schema/purchases.ts";
import { vendorVariantCodes } from "../db/schema/vendor-variant-codes.ts";
import { vendors } from "../db/schema/vendors.ts";
import { db } from "../lib/db.ts";

export type PurchaseErrorCode =
  | "PURCHASE_NOT_FOUND"
  | "SECTION_NOT_FOUND"
  | "ITEM_NOT_FOUND"
  | "SEND_NOT_FOUND"
  | "SEND_ALREADY_SENT"
  | "VENDOR_NOT_FOUND"
  | "VARIANT_NOT_FOUND"
  | "INVALID_INPUT"
  | "NOT_OPEN"
  | "ITEM_LOCKED";

export class PurchaseError extends Error {
  constructor(
    public code: PurchaseErrorCode,
    message?: string,
  ) {
    super(message ?? code);
    this.name = "PurchaseError";
  }
}

type Purchase = typeof purchases.$inferSelect;
type Section = typeof purchaseSections.$inferSelect;
type Item = typeof purchaseItems.$inferSelect;
type Send = typeof purchaseSends.$inferSelect;
type SendChannel = (typeof PURCHASE_SEND_CHANNELS)[number];

/** A drizzle transaction handle; structurally a subset of `db`. */
type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

// --- Loads ---

async function loadPurchase(id: string): Promise<Purchase> {
  const row = await db.query.purchases.findFirst({ where: eq(purchases.id, id) });
  if (!row) throw new PurchaseError("PURCHASE_NOT_FOUND");
  return row;
}

export { loadPurchase as getPurchase };

/** A purchase that still accepts content edits — not cancelled. */
function assertEditable(p: Purchase): void {
  if (p.status === "cancelled") {
    throw new PurchaseError("NOT_OPEN", "purchase is cancelled");
  }
}

async function loadItem(id: string): Promise<Item> {
  const row = await db.query.purchaseItems.findFirst({
    where: eq(purchaseItems.id, id),
  });
  if (!row) throw new PurchaseError("ITEM_NOT_FOUND");
  return row;
}

async function loadSection(id: string): Promise<Section> {
  const row = await db.query.purchaseSections.findFirst({
    where: eq(purchaseSections.id, id),
  });
  if (!row) throw new PurchaseError("SECTION_NOT_FOUND");
  return row;
}

async function loadSend(id: string): Promise<Send> {
  const row = await db.query.purchaseSends.findFirst({
    where: eq(purchaseSends.id, id),
  });
  if (!row) throw new PurchaseError("SEND_NOT_FOUND");
  return row;
}

/** `revision` tracks PO content — bumped by every item / section mutation. */
async function bumpRevision(tx: Tx, purchaseId: string): Promise<void> {
  await tx
    .update(purchases)
    .set({ revision: sql`${purchases.revision} + 1` })
    .where(eq(purchases.id, purchaseId));
}

// --- Header ---

export function listPurchases(opts: {
  status?: (typeof purchases.$inferSelect)["status"];
  vendorId?: string | null;
  includeCancelled?: boolean;
}): Promise<Purchase[]> {
  const filters = [];
  if (opts.status) filters.push(eq(purchases.status, opts.status));
  else if (!opts.includeCancelled) filters.push(ne(purchases.status, "cancelled"));
  if (opts.vendorId !== undefined) {
    filters.push(
      opts.vendorId === null
        ? isNull(purchases.vendorId)
        : eq(purchases.vendorId, opts.vendorId),
    );
  }
  return db
    .select()
    .from(purchases)
    .where(filters.length ? and(...filters) : undefined)
    .orderBy(desc(purchases.date), desc(purchases.createdAt));
}

export async function createPurchase(input: {
  vendorId?: string | null;
  /** Free-text vendor name. Required (and used as-is) only for ad-hoc purchases. */
  snapshotVendorName?: string | null;
  date: string;
  sourceDocument?: string | null;
  memo?: string | null;
  /** Optional "send by" deadline; drives the send_due alert. */
  sendDueDate?: string | null;
  createdByUserId: string;
}): Promise<Purchase> {
  if (!input.date?.trim()) throw new PurchaseError("INVALID_INPUT", "date is required");

  let snapshotVendorName: string;
  if (input.vendorId) {
    const vendor = await db.query.vendors.findFirst({
      where: eq(vendors.id, input.vendorId),
    });
    if (!vendor) throw new PurchaseError("VENDOR_NOT_FOUND");
    snapshotVendorName = vendor.name;
  } else {
    if (!input.snapshotVendorName?.trim()) {
      throw new PurchaseError(
        "INVALID_INPUT",
        "snapshotVendorName is required for an ad-hoc purchase",
      );
    }
    snapshotVendorName = input.snapshotVendorName.trim();
  }

  const id = ulid();
  await db.insert(purchases).values({
    id,
    vendorId: input.vendorId ?? null,
    snapshotVendorName,
    date: input.date,
    sourceDocument: input.sourceDocument ?? null,
    memo: input.memo ?? null,
    sendDueDate: input.sendDueDate?.trim() || null,
    createdByUserId: input.createdByUserId,
  });
  return loadPurchase(id);
}

/**
 * Header edit. `vendorId` may only change while the purchase is `open`;
 * setting a vendor refreshes `snapshotVendorName` from the vendor row, and
 * clearing it back to ad-hoc requires an explicit `snapshotVendorName`.
 * Header fields are not PO content, so this does not bump `revision`.
 */
export async function updatePurchase(
  id: string,
  patch: {
    vendorId?: string | null;
    snapshotVendorName?: string | null;
    date?: string;
    sourceDocument?: string | null;
    memo?: string | null;
    sendDueDate?: string | null;
  },
): Promise<Purchase> {
  const purchase = await loadPurchase(id);
  const set: Partial<typeof purchases.$inferInsert> = {};

  if (patch.vendorId !== undefined) {
    if (purchase.status !== "open") {
      throw new PurchaseError("NOT_OPEN", "vendor can only change while the purchase is open");
    }
    if (patch.vendorId) {
      const vendor = await db.query.vendors.findFirst({
        where: eq(vendors.id, patch.vendorId),
      });
      if (!vendor) throw new PurchaseError("VENDOR_NOT_FOUND");
      set.vendorId = patch.vendorId;
      set.snapshotVendorName = vendor.name;
    } else {
      const name = patch.snapshotVendorName?.trim();
      if (!name) {
        throw new PurchaseError(
          "INVALID_INPUT",
          "clearing the vendor requires a snapshotVendorName",
        );
      }
      set.vendorId = null;
      set.snapshotVendorName = name;
    }
  } else if (patch.snapshotVendorName !== undefined) {
    // Rename the free-text label on an ad-hoc purchase.
    if (purchase.vendorId) {
      throw new PurchaseError(
        "INVALID_INPUT",
        "snapshotVendorName is owned by the vendor; cannot override it",
      );
    }
    const name = patch.snapshotVendorName?.trim();
    if (!name) throw new PurchaseError("INVALID_INPUT", "snapshotVendorName cannot be blank");
    set.snapshotVendorName = name;
  }

  if (patch.date !== undefined) {
    if (!patch.date.trim()) throw new PurchaseError("INVALID_INPUT", "date cannot be blank");
    set.date = patch.date;
  }
  if (patch.sourceDocument !== undefined) set.sourceDocument = patch.sourceDocument;
  if (patch.memo !== undefined) set.memo = patch.memo;
  if (patch.sendDueDate !== undefined) {
    set.sendDueDate = patch.sendDueDate?.trim() || null;
  }

  if (Object.keys(set).length > 0) {
    await db.update(purchases).set(set).where(eq(purchases.id, id));
  }
  return loadPurchase(id);
}

/**
 * Cancel a purchase. The "no non-cancelled delivery references its items"
 * guard is added once the deliveries domain exists; for now nothing can
 * deliver against a purchase, so cancel is always allowed.
 */
export async function cancelPurchase(id: string, userId: string): Promise<Purchase> {
  const purchase = await loadPurchase(id);
  if (purchase.status === "cancelled") return purchase;
  await db
    .update(purchases)
    .set({ status: "cancelled", cancelledAt: new Date(), cancelledByUserId: userId })
    .where(eq(purchases.id, id));
  return loadPurchase(id);
}

/**
 * Clone a purchase as a fresh open draft — for businesses that reorder the
 * same basket. Copies the vendor, memo, sections and lines (with
 * `qtyDelivered` reset to 0); the clone dates today, starts at `revision` 1,
 * and carries no send history. `sourceDocument` is intentionally dropped — it
 * points at the original vendor invoice, which the clone is not. The source
 * may be in any status; the clone is always a fresh open purchase.
 */
export async function clonePurchase(id: string, userId: string): Promise<Purchase> {
  const source = await loadPurchase(id);
  const sourceSections = await listSections(id);
  const sourceItems = await listItems(id);

  const newId = ulid();
  await db.transaction(async (tx) => {
    await tx.insert(purchases).values({
      id: newId,
      vendorId: source.vendorId,
      snapshotVendorName: source.snapshotVendorName,
      date: new Date().toISOString().slice(0, 10),
      memo: source.memo,
      createdByUserId: userId,
    });

    // Sections get fresh ids; remember the mapping to reparent items.
    const sectionIdMap = new Map<string, string>();
    for (const s of sourceSections) {
      const sid = ulid();
      sectionIdMap.set(s.id, sid);
      await tx.insert(purchaseSections).values({
        id: sid,
        purchaseId: newId,
        name: s.name,
        sortOrder: s.sortOrder,
      });
    }

    for (const it of sourceItems) {
      await tx.insert(purchaseItems).values({
        id: ulid(),
        purchaseId: newId,
        sectionId: it.sectionId ? (sectionIdMap.get(it.sectionId) ?? null) : null,
        variantId: it.variantId,
        description: it.description,
        qtyOrdered: it.qtyOrdered,
        qtyDelivered: 0,
        unitCostMinor: it.unitCostMinor,
        sortOrder: it.sortOrder,
      });
    }
  });
  return loadPurchase(newId);
}

// --- Sections ---

export async function createSection(input: {
  purchaseId: string;
  name: string;
  sortOrder?: number;
}): Promise<Section> {
  const purchase = await loadPurchase(input.purchaseId);
  assertEditable(purchase);
  if (!input.name.trim()) throw new PurchaseError("INVALID_INPUT", "section name is required");

  const id = ulid();
  await db.transaction(async (tx) => {
    await tx.insert(purchaseSections).values({
      id,
      purchaseId: input.purchaseId,
      name: input.name.trim(),
      sortOrder: input.sortOrder ?? 0,
    });
    await bumpRevision(tx, input.purchaseId);
  });
  return loadSection(id);
}

export async function updateSection(
  id: string,
  patch: { name?: string; sortOrder?: number },
): Promise<Section> {
  const section = await loadSection(id);
  const purchase = await loadPurchase(section.purchaseId);
  assertEditable(purchase);
  if (patch.name !== undefined && !patch.name.trim()) {
    throw new PurchaseError("INVALID_INPUT", "section name cannot be blank");
  }

  await db.transaction(async (tx) => {
    await tx
      .update(purchaseSections)
      .set({
        ...(patch.name !== undefined && { name: patch.name.trim() }),
        ...(patch.sortOrder !== undefined && { sortOrder: patch.sortOrder }),
      })
      .where(eq(purchaseSections.id, id));
    await bumpRevision(tx, section.purchaseId);
  });
  return loadSection(id);
}

/** Delete a section; its items reparent to the "Uncategorized" (NULL) bucket. */
export async function deleteSection(id: string): Promise<void> {
  const section = await loadSection(id);
  const purchase = await loadPurchase(section.purchaseId);
  assertEditable(purchase);

  await db.transaction(async (tx) => {
    await tx
      .update(purchaseItems)
      .set({ sectionId: null })
      .where(eq(purchaseItems.sectionId, id));
    await tx.delete(purchaseSections).where(eq(purchaseSections.id, id));
    await bumpRevision(tx, section.purchaseId);
  });
}

/** Renumber sections of a purchase to match the given id order (0-based). */
export async function reorderSections(
  purchaseId: string,
  orderedIds: string[],
): Promise<Section[]> {
  const purchase = await loadPurchase(purchaseId);
  assertEditable(purchase);

  const existing = await db
    .select()
    .from(purchaseSections)
    .where(eq(purchaseSections.purchaseId, purchaseId));
  const ids = new Set(existing.map((s) => s.id));
  if (orderedIds.length !== ids.size || !orderedIds.every((i) => ids.has(i))) {
    throw new PurchaseError("INVALID_INPUT", "orderedIds must list every section exactly once");
  }

  await db.transaction(async (tx) => {
    for (let i = 0; i < orderedIds.length; i++) {
      await tx
        .update(purchaseSections)
        .set({ sortOrder: i })
        .where(eq(purchaseSections.id, orderedIds[i] as string));
    }
    await bumpRevision(tx, purchaseId);
  });
  return db
    .select()
    .from(purchaseSections)
    .where(eq(purchaseSections.purchaseId, purchaseId))
    .orderBy(asc(purchaseSections.sortOrder));
}

// --- Items ---

/** Validate a (variantId, description) pair against the line-target CHECK. */
function assertLineTarget(variantId: string | null, description: string | null): void {
  if (!variantId && !description?.trim()) {
    throw new PurchaseError(
      "INVALID_INPUT",
      "a non-stock line (no variantId) requires a description",
    );
  }
}

async function assertVariantExists(variantId: string): Promise<void> {
  const v = await db.query.productVariants.findFirst({
    where: eq(productVariants.id, variantId),
  });
  if (!v) throw new PurchaseError("VARIANT_NOT_FOUND");
}

/** Confirm a section exists and belongs to the given purchase. */
async function assertSectionInPurchase(sectionId: string, purchaseId: string): Promise<void> {
  const section = await loadSection(sectionId);
  if (section.purchaseId !== purchaseId) {
    throw new PurchaseError("INVALID_INPUT", "section belongs to a different purchase");
  }
}

export async function createItem(input: {
  purchaseId: string;
  sectionId?: string | null;
  variantId?: string | null;
  description?: string | null;
  qtyOrdered: number;
  unitCostMinor: number;
  sortOrder?: number;
}): Promise<Item> {
  const purchase = await loadPurchase(input.purchaseId);
  assertEditable(purchase);

  const variantId = input.variantId ?? null;
  const description = input.description?.trim() || null;
  assertLineTarget(variantId, description);
  if (variantId) await assertVariantExists(variantId);
  if (input.sectionId) await assertSectionInPurchase(input.sectionId, input.purchaseId);
  if (!Number.isInteger(input.qtyOrdered) || input.qtyOrdered <= 0) {
    throw new PurchaseError("INVALID_INPUT", "qtyOrdered must be a positive integer");
  }
  if (!Number.isInteger(input.unitCostMinor) || input.unitCostMinor < 0) {
    throw new PurchaseError("INVALID_INPUT", "unitCostMinor must be a non-negative integer");
  }

  const id = ulid();
  await db.transaction(async (tx) => {
    await tx.insert(purchaseItems).values({
      id,
      purchaseId: input.purchaseId,
      sectionId: input.sectionId ?? null,
      variantId,
      description,
      qtyOrdered: input.qtyOrdered,
      unitCostMinor: input.unitCostMinor,
      sortOrder: input.sortOrder ?? 0,
    });
    await bumpRevision(tx, input.purchaseId);
  });
  return loadItem(id);
}

/**
 * Append several lines to a purchase in one transaction — the bulk-add picker
 * (reorder suggestions / by-stock) calls this so a multi-row add is a single
 * round-trip with one `revision` bump. Lines append after the current max
 * `sortOrder`, preserving the order they arrive in. All-or-nothing: any invalid
 * line rolls the whole batch back.
 */
export async function createItems(input: {
  purchaseId: string;
  lines: Array<{
    sectionId?: string | null;
    variantId?: string | null;
    description?: string | null;
    qtyOrdered: number;
    unitCostMinor: number;
  }>;
}): Promise<Item[]> {
  const purchase = await loadPurchase(input.purchaseId);
  assertEditable(purchase);
  if (input.lines.length === 0) {
    throw new PurchaseError("INVALID_INPUT", "no lines to add");
  }

  // Validate every line up front (outside the tx) so we fail before writing.
  const prepared: Array<{
    id: string;
    purchaseId: string;
    sectionId: string | null;
    variantId: string | null;
    description: string | null;
    qtyOrdered: number;
    unitCostMinor: number;
  }> = [];
  for (const line of input.lines) {
    const variantId = line.variantId ?? null;
    const description = line.description?.trim() || null;
    assertLineTarget(variantId, description);
    if (variantId) await assertVariantExists(variantId);
    if (line.sectionId) await assertSectionInPurchase(line.sectionId, input.purchaseId);
    if (!Number.isInteger(line.qtyOrdered) || line.qtyOrdered <= 0) {
      throw new PurchaseError("INVALID_INPUT", "qtyOrdered must be a positive integer");
    }
    if (!Number.isInteger(line.unitCostMinor) || line.unitCostMinor < 0) {
      throw new PurchaseError("INVALID_INPUT", "unitCostMinor must be a non-negative integer");
    }
    prepared.push({
      id: ulid(),
      purchaseId: input.purchaseId,
      sectionId: line.sectionId ?? null,
      variantId,
      description,
      qtyOrdered: line.qtyOrdered,
      unitCostMinor: line.unitCostMinor,
    });
  }

  const ids = await db.transaction(async (tx) => {
    const [{ maxSort } = { maxSort: null }] = await tx
      .select({ maxSort: sql<number | null>`max(${purchaseItems.sortOrder})` })
      .from(purchaseItems)
      .where(eq(purchaseItems.purchaseId, input.purchaseId));
    let next = (maxSort ?? -1) + 1;
    const rows = prepared.map((p) => ({ ...p, sortOrder: next++ }));
    await tx.insert(purchaseItems).values(rows);
    await bumpRevision(tx, input.purchaseId);
    return rows.map((r) => r.id);
  });

  return db.query.purchaseItems.findMany({
    where: inArray(purchaseItems.id, ids),
    orderBy: asc(purchaseItems.sortOrder),
  });
}

/**
 * Edit a line. `qtyOrdered` / `unitCostMinor` are locked once any quantity has
 * been delivered against the item (`qtyDelivered > 0`) — cancel the delivery
 * first. Section / description / sort changes are always allowed while open.
 */
export async function updateItem(
  id: string,
  patch: {
    sectionId?: string | null;
    variantId?: string | null;
    description?: string | null;
    qtyOrdered?: number;
    unitCostMinor?: number;
    sortOrder?: number;
  },
): Promise<Item> {
  const item = await loadItem(id);
  const purchase = await loadPurchase(item.purchaseId);
  assertEditable(purchase);

  const costEdit = patch.qtyOrdered !== undefined || patch.unitCostMinor !== undefined;
  if (costEdit && item.qtyDelivered > 0) {
    throw new PurchaseError(
      "ITEM_LOCKED",
      "qtyOrdered / unitCostMinor cannot change after a delivery",
    );
  }

  const nextVariantId = patch.variantId !== undefined ? patch.variantId : item.variantId;
  const nextDescription =
    patch.description !== undefined ? patch.description?.trim() || null : item.description;
  assertLineTarget(nextVariantId, nextDescription);
  if (patch.variantId) await assertVariantExists(patch.variantId);
  if (patch.sectionId) await assertSectionInPurchase(patch.sectionId, item.purchaseId);
  if (
    patch.qtyOrdered !== undefined &&
    (!Number.isInteger(patch.qtyOrdered) || patch.qtyOrdered <= 0)
  ) {
    throw new PurchaseError("INVALID_INPUT", "qtyOrdered must be a positive integer");
  }
  if (
    patch.unitCostMinor !== undefined &&
    (!Number.isInteger(patch.unitCostMinor) || patch.unitCostMinor < 0)
  ) {
    throw new PurchaseError("INVALID_INPUT", "unitCostMinor must be a non-negative integer");
  }

  await db.transaction(async (tx) => {
    await tx
      .update(purchaseItems)
      .set({
        ...(patch.sectionId !== undefined && { sectionId: patch.sectionId }),
        ...(patch.variantId !== undefined && { variantId: patch.variantId }),
        ...(patch.description !== undefined && { description: nextDescription }),
        ...(patch.qtyOrdered !== undefined && { qtyOrdered: patch.qtyOrdered }),
        ...(patch.unitCostMinor !== undefined && { unitCostMinor: patch.unitCostMinor }),
        ...(patch.sortOrder !== undefined && { sortOrder: patch.sortOrder }),
      })
      .where(eq(purchaseItems.id, id));
    await bumpRevision(tx, item.purchaseId);
  });
  return loadItem(id);
}

/** Delete a line. Refused once any quantity has been delivered against it. */
export async function deleteItem(id: string): Promise<void> {
  const item = await loadItem(id);
  const purchase = await loadPurchase(item.purchaseId);
  assertEditable(purchase);
  if (item.qtyDelivered > 0) {
    throw new PurchaseError("ITEM_LOCKED", "an item with deliveries cannot be deleted");
  }

  await db.transaction(async (tx) => {
    await tx.delete(purchaseItems).where(eq(purchaseItems.id, id));
    await bumpRevision(tx, item.purchaseId);
  });
}

/** Renumber items of a purchase to match the given id order (0-based). */
export async function reorderItems(
  purchaseId: string,
  orderedIds: string[],
): Promise<Item[]> {
  const purchase = await loadPurchase(purchaseId);
  assertEditable(purchase);

  const existing = await db
    .select()
    .from(purchaseItems)
    .where(eq(purchaseItems.purchaseId, purchaseId));
  const ids = new Set(existing.map((i) => i.id));
  if (orderedIds.length !== ids.size || !orderedIds.every((i) => ids.has(i))) {
    throw new PurchaseError("INVALID_INPUT", "orderedIds must list every item exactly once");
  }

  await db.transaction(async (tx) => {
    for (let i = 0; i < orderedIds.length; i++) {
      await tx
        .update(purchaseItems)
        .set({ sortOrder: i })
        .where(eq(purchaseItems.id, orderedIds[i] as string));
    }
    await bumpRevision(tx, purchaseId);
  });
  return db
    .select()
    .from(purchaseItems)
    .where(eq(purchaseItems.purchaseId, purchaseId))
    .orderBy(asc(purchaseItems.sortOrder));
}

// --- Reads for resolvers ---

export function listSections(purchaseId: string): Promise<Section[]> {
  return db
    .select()
    .from(purchaseSections)
    .where(eq(purchaseSections.purchaseId, purchaseId))
    .orderBy(asc(purchaseSections.sortOrder));
}

export function listItems(purchaseId: string): Promise<Item[]> {
  return db
    .select()
    .from(purchaseItems)
    .where(eq(purchaseItems.purchaseId, purchaseId))
    .orderBy(asc(purchaseItems.sortOrder));
}

export function listSectionItems(sectionId: string): Promise<Item[]> {
  return db
    .select()
    .from(purchaseItems)
    .where(eq(purchaseItems.sectionId, sectionId))
    .orderBy(asc(purchaseItems.sortOrder));
}

export function listSends(purchaseId: string): Promise<Send[]> {
  return db
    .select()
    .from(purchaseSends)
    .where(eq(purchaseSends.purchaseId, purchaseId))
    .orderBy(desc(purchaseSends.createdAt));
}

/** Σ(qtyOrdered × unitCostMinor) — the vendor invoice total, pre-landed-cost. */
export async function invoiceTotalMinor(purchaseId: string): Promise<number> {
  const rows = await db
    .select({
      total: sql<number>`COALESCE(SUM(${purchaseItems.qtyOrdered} * ${purchaseItems.unitCostMinor}), 0)`,
    })
    .from(purchaseItems)
    .where(eq(purchaseItems.purchaseId, purchaseId));
  return Number(rows[0]?.total ?? 0);
}

/**
 * Stock lines whose variant the purchase's vendor has no `vendor_variant_codes`
 * mapping for — the vendor will not recognize those parts. The send screen
 * surfaces these as a pre-send warning and offers to map them inline. An
 * ad-hoc purchase (no vendor) and non-stock lines (no variant) have no
 * mapping to miss, so both are excluded.
 */
export async function unmappedLines(purchaseId: string): Promise<Item[]> {
  const purchase = await loadPurchase(purchaseId);
  if (!purchase.vendorId) return [];

  const stockLines = (await listItems(purchaseId)).filter((i) => i.variantId);
  if (stockLines.length === 0) return [];

  const mapped = await db
    .select({ variantId: vendorVariantCodes.variantId })
    .from(vendorVariantCodes)
    .where(
      and(
        eq(vendorVariantCodes.vendorId, purchase.vendorId),
        inArray(
          vendorVariantCodes.variantId,
          stockLines.map((i) => i.variantId as string),
        ),
      ),
    );
  const mappedVariants = new Set(mapped.map((m) => m.variantId));
  return stockLines.filter((i) => !mappedVariants.has(i.variantId as string));
}

// --- Send log ---

/**
 * Open a send: log that a purchase-order deep link was generated. Append-only
 * — re-sending adds another row. Snapshots the current `revision` (sending is
 * not a content change, so `revision` is not bumped). A `whatsapp` / `email`
 * row starts `prepared` and is finished by `confirmPurchaseSend`; a `manual`
 * row is sent off-system with nothing to confirm, so it is `sent` at once and
 * stamps `purchases.lastSentAt` immediately.
 */
export async function recordPurchaseSend(input: {
  purchaseId: string;
  channel: SendChannel;
  recipient: string;
  note?: string | null;
  createdByUserId: string;
}): Promise<Send> {
  const purchase = await loadPurchase(input.purchaseId);
  if (!input.recipient.trim()) {
    throw new PurchaseError("INVALID_INPUT", "recipient is required");
  }

  const id = ulid();
  const now = new Date();
  const isManual = input.channel === "manual";
  await db.transaction(async (tx) => {
    await tx.insert(purchaseSends).values({
      id,
      purchaseId: input.purchaseId,
      channel: input.channel,
      recipient: input.recipient.trim(),
      revision: purchase.revision,
      status: isManual ? "sent" : "prepared",
      sentAt: isManual ? now : null,
      note: input.note ?? null,
      createdByUserId: input.createdByUserId,
    });
    if (isManual) {
      await tx
        .update(purchases)
        .set({ lastSentAt: now })
        .where(eq(purchases.id, input.purchaseId));
    }
  });
  return loadSend(id);
}

/**
 * Confirm a `prepared` send — the clerk has verified the vendor received the
 * PO. Flips the row to `sent`, stamps `sentAt` and `purchases.lastSentAt`, and
 * optionally records the vendor's expected-delivery date. A send can only be
 * confirmed once.
 */
export async function confirmPurchaseSend(input: {
  id: string;
  expectedDeliveryDate?: string | null;
}): Promise<Send> {
  const send = await loadSend(input.id);
  if (send.status === "sent") {
    throw new PurchaseError("SEND_ALREADY_SENT", "this send is already confirmed");
  }
  const expectedDeliveryDate = input.expectedDeliveryDate?.trim() || null;

  const now = new Date();
  await db.transaction(async (tx) => {
    await tx
      .update(purchaseSends)
      .set({ status: "sent", sentAt: now, expectedDeliveryDate })
      .where(eq(purchaseSends.id, input.id));
    await tx
      .update(purchases)
      .set({ lastSentAt: now })
      .where(eq(purchases.id, send.purchaseId));
  });
  return loadSend(input.id);
}
