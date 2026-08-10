import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import { ulid } from "ulid";
import { db } from "../lib/db.ts";
import {
  requestForQuotations,
  rfqSections,
  rfqItems,
  type RFQ_STATUSES,
} from "../db/schema/rfqs.ts";
import {
  purchaseRequisitions,
  purchaseRequisitionItems,
} from "../db/schema/requisitions.ts";
import { purchases, purchaseItems, purchaseSections } from "../db/schema/purchases.ts";
import { vendors } from "../db/schema/vendors.ts";

export type RfqErrorCode =
  | "RFQ_NOT_FOUND"
  | "SECTION_NOT_FOUND"
  | "ITEM_NOT_FOUND"
  | "INVALID_INPUT"
  | "NOT_EDITABLE"
  | "ALREADY_AWARDED";

export class RfqError extends Error {
  constructor(public code: RfqErrorCode, message?: string) {
    super(message ?? code);
    this.name = "RfqError";
  }
}

type Rfq = typeof requestForQuotations.$inferSelect;
type Section = typeof rfqSections.$inferSelect;
type Item = typeof rfqItems.$inferSelect;

async function loadRfq(id: string): Promise<Rfq> {
  const row = await db.query.requestForQuotations.findFirst({
    where: eq(requestForQuotations.id, id),
  });
  if (!row) throw new RfqError("RFQ_NOT_FOUND");
  return row;
}

export { loadRfq as getRfq };

function assertEditable(rfq: Rfq): void {
  if (rfq.status === "awarded" || rfq.status === "cancelled") {
    throw new RfqError("NOT_EDITABLE", `RFQ is ${rfq.status}`);
  }
}

async function loadItem(id: string): Promise<Item> {
  const row = await db.query.rfqItems.findFirst({
    where: eq(rfqItems.id, id),
  });
  if (!row) throw new RfqError("ITEM_NOT_FOUND");
  return row;
}

async function loadSection(id: string): Promise<Section> {
  const row = await db.query.rfqSections.findFirst({
    where: eq(rfqSections.id, id),
  });
  if (!row) throw new RfqError("SECTION_NOT_FOUND");
  return row;
}

export function listRfqs(opts: {
  status?: typeof requestForQuotations.$inferSelect["status"];
}): Promise<Rfq[]> {
  const filters = [];
  if (opts.status) filters.push(eq(requestForQuotations.status, opts.status));
  return db
    .select()
    .from(requestForQuotations)
    .where(filters.length ? and(...filters) : undefined)
    .orderBy(desc(requestForQuotations.createdAt));
}

async function generateRfqNumber(): Promise<string> {
  const datePrefix = new Date().toISOString().slice(0, 7).replace("-", ""); // YYYYMM
  const prefix = `RFQ-${datePrefix}-`;
  const existing = await db
    .select({ count: sql<number>`COUNT(*)` })
    .from(requestForQuotations);
  const count = (existing[0]?.count ?? 0) + 1;
  return `${prefix}${count.toString().padStart(4, "0")}`;
}

export async function createRfq(input: {
  vendorId?: string | null;
  snapshotVendorName?: string | null;
  date: string;
  dueDate?: string | null;
  memo?: string | null;
  termsAndConditions?: string | null;
  createdByUserId: string;
}): Promise<Rfq> {
  let snapshotVendorName: string | null = null;
  if (input.vendorId) {
    const v = await db.query.vendors.findFirst({
      where: eq(vendors.id, input.vendorId),
    });
    if (v) snapshotVendorName = v.name;
  }
  if (!snapshotVendorName && input.snapshotVendorName?.trim()) {
    snapshotVendorName = input.snapshotVendorName.trim();
  }

  const id = ulid();
  const rfqNumber = await generateRfqNumber();

  await db.insert(requestForQuotations).values({
    id,
    rfqNumber,
    vendorId: input.vendorId ?? null,
    snapshotVendorName: snapshotVendorName ?? "Unspecified Vendor",
    date: input.date,
    dueDate: input.dueDate ?? null,
    status: "draft",
    memo: input.memo?.trim() || null,
    termsAndConditions: input.termsAndConditions?.trim() || null,
    createdByUserId: input.createdByUserId,
  });

  return loadRfq(id);
}

export async function createRfqFromRequisitions(input: {
  vendorId?: string | null;
  snapshotVendorName?: string | null;
  date: string;
  dueDate?: string | null;
  memo?: string | null;
  termsAndConditions?: string | null;
  createdByUserId: string;
  requisitionItemIds: string[];
}): Promise<Rfq> {
  if (!input.requisitionItemIds || input.requisitionItemIds.length === 0) {
    throw new RfqError("INVALID_INPUT", "requisitionItemIds cannot be empty");
  }

  const prItems = await db
    .select()
    .from(purchaseRequisitionItems)
    .where(inArray(purchaseRequisitionItems.id, input.requisitionItemIds));

  if (prItems.length === 0) {
    throw new RfqError("INVALID_INPUT", "No valid requisition items found");
  }

  const rfq = await createRfq(input);

  await db.transaction(async (tx) => {
    let sort = 0;
    for (const prItem of prItems) {
      const remainingQty = prItem.qtyRequested - prItem.qtyOrdered;
      if (remainingQty <= 0) continue;

      await tx.insert(rfqItems).values({
        id: ulid(),
        rfqId: rfq.id,
        sectionId: null,
        requisitionItemId: prItem.id,
        variantId: prItem.variantId,
        description: prItem.description,
        qtyRequested: remainingQty,
        targetUnitCostMinor: prItem.estimatedUnitCostMinor,
        quotedUnitCostMinor: prItem.estimatedUnitCostMinor,
        sortOrder: sort++,
      });
    }
  });

  return loadRfq(rfq.id);
}

export async function importRfqItemsFromRequisition(input: {
  rfqId: string;
  items: Array<{
    requisitionItemId: string;
    variantId?: string | null;
    description?: string | null;
    qtyRequested: number;
    targetUnitCostMinor: number;
  }>;
}): Promise<Rfq> {
  const rfq = await loadRfq(input.rfqId);
  assertEditable(rfq);

  if (!input.items || input.items.length === 0) {
    throw new RfqError("INVALID_INPUT", "items cannot be empty");
  }

  const existing = await db
    .select({ maxSort: sql<number>`MAX(${rfqItems.sortOrder})` })
    .from(rfqItems)
    .where(eq(rfqItems.rfqId, input.rfqId));
  let currentSort = (existing[0]?.maxSort ?? -1) + 1;

  await db.transaction(async (tx) => {
    for (const itemInput of input.items) {
      if (itemInput.qtyRequested <= 0) {
        throw new RfqError("INVALID_INPUT", "qtyRequested must be positive");
      }

      await tx.insert(rfqItems).values({
        id: ulid(),
        rfqId: input.rfqId,
        sectionId: null,
        requisitionItemId: itemInput.requisitionItemId,
        variantId: itemInput.variantId ?? null,
        description: itemInput.description?.trim() || null,
        qtyRequested: itemInput.qtyRequested,
        targetUnitCostMinor: itemInput.targetUnitCostMinor ?? 0,
        quotedUnitCostMinor: itemInput.targetUnitCostMinor ?? 0,
        sortOrder: currentSort++,
      });
    }
  });

  return loadRfq(input.rfqId);
}

export async function updateRfq(
  id: string,
  patch: {
    vendorId?: string | null;
    snapshotVendorName?: string | null;
    date?: string;
    dueDate?: string | null;
    status?: typeof requestForQuotations.$inferSelect["status"];
    memo?: string | null;
    termsAndConditions?: string | null;
  }
): Promise<Rfq> {
  const rfq = await loadRfq(id);
  assertEditable(rfq);

  const set: Partial<typeof requestForQuotations.$inferInsert> = {};
  if (patch.date) set.date = patch.date;
  if (patch.dueDate !== undefined) set.dueDate = patch.dueDate;
  if (patch.status !== undefined) set.status = patch.status;
  if (patch.memo !== undefined) set.memo = patch.memo?.trim() || null;
  if (patch.termsAndConditions !== undefined)
    set.termsAndConditions = patch.termsAndConditions?.trim() || null;

  if (patch.vendorId !== undefined || patch.snapshotVendorName !== undefined) {
    set.vendorId = patch.vendorId ?? null;
    let vendorName: string | null = null;
    if (patch.vendorId) {
      const v = await db.query.vendors.findFirst({
        where: eq(vendors.id, patch.vendorId),
      });
      if (v) vendorName = v.name;
    }
    if (!vendorName && patch.snapshotVendorName?.trim()) {
      vendorName = patch.snapshotVendorName.trim();
    }
    set.snapshotVendorName = vendorName ?? "Unspecified Vendor";
  }

  if (Object.keys(set).length > 0) {
    await db
      .update(requestForQuotations)
      .set(set)
      .where(eq(requestForQuotations.id, id));
  }

  return loadRfq(id);
}

export async function deleteRfq(id: string): Promise<void> {
  const rfq = await loadRfq(id);
  if (rfq.status === "awarded") {
    throw new RfqError("NOT_EDITABLE", "cannot delete an awarded RFQ");
  }
  await db
    .delete(requestForQuotations)
    .where(eq(requestForQuotations.id, id));
}

export async function createSection(
  rfqId: string,
  name: string
): Promise<Section> {
  const rfq = await loadRfq(rfqId);
  assertEditable(rfq);
  if (!name.trim()) throw new RfqError("INVALID_INPUT", "name is required");

  const id = ulid();
  const existing = await db
    .select({ max: sql<number>`MAX(${rfqSections.sortOrder})` })
    .from(rfqSections)
    .where(eq(rfqSections.rfqId, rfqId));
  const nextSort = existing[0]?.max != null ? existing[0].max + 1 : 0;

  await db.insert(rfqSections).values({
    id,
    rfqId,
    name: name.trim(),
    sortOrder: nextSort,
  });
  return loadSection(id);
}

export async function updateSection(
  id: string,
  name: string
): Promise<Section> {
  const section = await loadSection(id);
  const rfq = await loadRfq(section.rfqId);
  assertEditable(rfq);
  if (!name.trim()) throw new RfqError("INVALID_INPUT", "name is required");
  await db
    .update(rfqSections)
    .set({ name: name.trim() })
    .where(eq(rfqSections.id, id));
  return loadSection(id);
}

export async function deleteSection(id: string): Promise<void> {
  const section = await loadSection(id);
  const rfq = await loadRfq(section.rfqId);
  assertEditable(rfq);
  await db.delete(rfqSections).where(eq(rfqSections.id, id));
}

export async function reorderSections(
  rfqId: string,
  orderedIds: string[]
): Promise<Section[]> {
  const rfq = await loadRfq(rfqId);
  assertEditable(rfq);
  const existing = await db
    .select()
    .from(rfqSections)
    .where(eq(rfqSections.rfqId, rfqId));
  const ids = new Set(existing.map((s) => s.id));
  if (orderedIds.length !== ids.size || !orderedIds.every((i) => ids.has(i))) {
    throw new RfqError("INVALID_INPUT", "orderedIds must list every section");
  }
  await db.transaction(async (tx) => {
    for (let i = 0; i < orderedIds.length; i++) {
      await tx
        .update(rfqSections)
        .set({ sortOrder: i })
        .where(eq(rfqSections.id, orderedIds[i] as string));
    }
  });
  return listSections(rfqId);
}

export async function createItem(input: {
  rfqId: string;
  sectionId?: string | null;
  requisitionItemId?: string | null;
  variantId?: string | null;
  description?: string | null;
  qtyRequested: number;
  targetUnitCostMinor?: number;
  quotedUnitCostMinor?: number;
  sortOrder?: number;
}): Promise<Item> {
  const rfq = await loadRfq(input.rfqId);
  assertEditable(rfq);
  if (input.qtyRequested <= 0)
    throw new RfqError("INVALID_INPUT", "qtyRequested must be positive");
  const description = input.description?.trim() || null;
  if (!input.variantId && !description) {
    throw new RfqError("INVALID_INPUT", "non-stock lines must have a description");
  }

  const id = ulid();
  await db.insert(rfqItems).values({
    id,
    rfqId: input.rfqId,
    sectionId: input.sectionId ?? null,
    requisitionItemId: input.requisitionItemId ?? null,
    variantId: input.variantId ?? null,
    description,
    qtyRequested: input.qtyRequested,
    targetUnitCostMinor: input.targetUnitCostMinor ?? 0,
    quotedUnitCostMinor: input.quotedUnitCostMinor ?? 0,
    sortOrder: input.sortOrder ?? 0,
  });
  return loadItem(id);
}

export async function updateItem(
  id: string,
  patch: {
    sectionId?: string | null;
    variantId?: string | null;
    description?: string | null;
    qtyRequested?: number;
    targetUnitCostMinor?: number;
    quotedUnitCostMinor?: number;
    sortOrder?: number;
  }
): Promise<Item> {
  const item = await loadItem(id);
  const rfq = await loadRfq(item.rfqId);
  assertEditable(rfq);

  const nextDescription =
    patch.description !== undefined ? patch.description?.trim() || null : undefined;
  if (patch.qtyRequested !== undefined && patch.qtyRequested <= 0) {
    throw new RfqError("INVALID_INPUT", "qtyRequested must be positive");
  }

  await db
    .update(rfqItems)
    .set({
      ...(patch.sectionId !== undefined && { sectionId: patch.sectionId }),
      ...(patch.variantId !== undefined && { variantId: patch.variantId }),
      ...(patch.description !== undefined && { description: nextDescription }),
      ...(patch.qtyRequested !== undefined && { qtyRequested: patch.qtyRequested }),
      ...(patch.targetUnitCostMinor !== undefined && {
        targetUnitCostMinor: patch.targetUnitCostMinor,
      }),
      ...(patch.quotedUnitCostMinor !== undefined && {
        quotedUnitCostMinor: patch.quotedUnitCostMinor,
      }),
      ...(patch.sortOrder !== undefined && { sortOrder: patch.sortOrder }),
    })
    .where(eq(rfqItems.id, id));

  return loadItem(id);
}

export async function deleteItem(id: string): Promise<void> {
  const item = await loadItem(id);
  const rfq = await loadRfq(item.rfqId);
  assertEditable(rfq);
  await db.delete(rfqItems).where(eq(rfqItems.id, id));
}

export async function reorderItems(
  rfqId: string,
  orderedIds: string[]
): Promise<Item[]> {
  const rfq = await loadRfq(rfqId);
  assertEditable(rfq);
  const existing = await db
    .select()
    .from(rfqItems)
    .where(eq(rfqItems.rfqId, rfqId));
  const ids = new Set(existing.map((i) => i.id));
  if (orderedIds.length !== ids.size || !orderedIds.every((i) => ids.has(i))) {
    throw new RfqError("INVALID_INPUT", "orderedIds must list every item");
  }
  await db.transaction(async (tx) => {
    for (let i = 0; i < orderedIds.length; i++) {
      await tx
        .update(rfqItems)
        .set({ sortOrder: i })
        .where(eq(rfqItems.id, orderedIds[i] as string));
    }
  });
  return listItems(rfqId);
}

export function listSections(rfqId: string): Promise<Section[]> {
  return db
    .select()
    .from(rfqSections)
    .where(eq(rfqSections.rfqId, rfqId))
    .orderBy(asc(rfqSections.sortOrder));
}

export function listItems(rfqId: string): Promise<Item[]> {
  return db
    .select()
    .from(rfqItems)
    .where(eq(rfqItems.rfqId, rfqId))
    .orderBy(asc(rfqItems.sortOrder));
}

export function listSectionItems(sectionId: string): Promise<Item[]> {
  return db
    .select()
    .from(rfqItems)
    .where(eq(rfqItems.sectionId, sectionId))
    .orderBy(asc(rfqItems.sortOrder));
}

/**
 * Convert an awarded RFQ into an official Purchase Order (PO).
 * Updates source purchase_requisition_items.qtyOrdered transactionally.
 */
export async function convertRfqToPurchase(input: {
  rfqId: string;
  vendorId?: string | null;
  createdByUserId: string;
}): Promise<typeof purchases.$inferSelect> {
  const rfq = await loadRfq(input.rfqId);
  if (rfq.status === "awarded") {
    throw new RfqError("ALREADY_AWARDED", "This RFQ has already been converted to a PO");
  }

  const targetVendorId = input.vendorId ?? rfq.vendorId;
  let snapshotVendorName = rfq.snapshotVendorName ?? "Ad-hoc Vendor";

  if (input.vendorId && input.vendorId !== rfq.vendorId) {
    const v = await db.query.vendors.findFirst({
      where: eq(vendors.id, input.vendorId),
    });
    if (v) snapshotVendorName = v.name;
  }

  const items = await listItems(rfq.id);
  if (items.length === 0) {
    throw new RfqError("INVALID_INPUT", "Cannot convert an empty RFQ to a Purchase Order");
  }

  const purchaseId = ulid();

  await db.transaction(async (tx) => {
    // 1. Create Purchase (PO) Header
    await tx.insert(purchases).values({
      id: purchaseId,
      vendorId: targetVendorId ?? null,
      snapshotVendorName,
      date: new Date().toISOString().slice(0, 10),
      sourceDocument: `RFQ: ${rfq.rfqNumber}`,
      memo: rfq.memo,
      status: "open",
      revision: 1,
      createdByUserId: input.createdByUserId,
    });

    // 2. Create Purchase Sections if RFQ has sections
    const rfqSecList = await tx
      .select()
      .from(rfqSections)
      .where(eq(rfqSections.rfqId, rfq.id))
      .orderBy(asc(rfqSections.sortOrder));
    const sectionMap = new Map<string, string>();
    for (const sec of rfqSecList) {
      const poSecId = ulid();
      await tx.insert(purchaseSections).values({
        id: poSecId,
        purchaseId,
        name: sec.name,
        sortOrder: sec.sortOrder,
      });
      sectionMap.set(sec.id, poSecId);
    }

    // 3. Create Purchase Items & Update PR qtyOrdered
    let sort = 0;
    for (const item of items) {
      const unitCostMinor =
        item.quotedUnitCostMinor > 0
          ? item.quotedUnitCostMinor
          : item.targetUnitCostMinor;

      const targetSectionId = item.sectionId ? (sectionMap.get(item.sectionId) ?? null) : null;

      await tx.insert(purchaseItems).values({
        id: ulid(),
        purchaseId,
        sectionId: targetSectionId,
        requisitionItemId: item.requisitionItemId ?? null,
        variantId: item.variantId ?? null,
        description: item.description,
        qtyOrdered: item.qtyRequested,
        qtyDelivered: 0,
        unitCostMinor,
        baseCostMinor: unitCostMinor,
        sortOrder: sort++,
      });

      // 3. Update PR item's qtyOrdered if linked
      if (item.requisitionItemId) {
        const [prItem] = await tx
          .select()
          .from(purchaseRequisitionItems)
          .where(eq(purchaseRequisitionItems.id, item.requisitionItemId));

        if (prItem) {
          const nextQtyOrdered = prItem.qtyOrdered + item.qtyRequested;
          await tx
            .update(purchaseRequisitionItems)
            .set({ qtyOrdered: nextQtyOrdered })
            .where(eq(purchaseRequisitionItems.id, item.requisitionItemId));

          // Check if PR is fully or partially ordered
          const allPrItems = await tx
            .select()
            .from(purchaseRequisitionItems)
            .where(
              eq(
                purchaseRequisitionItems.requisitionId,
                prItem.requisitionId
              )
            );

          const isFullyOrdered = allPrItems.every((i) =>
            i.id === prItem.id
              ? nextQtyOrdered >= i.qtyRequested
              : i.qtyOrdered >= i.qtyRequested
          );
          const isPartiallyOrdered = allPrItems.some((i) =>
            i.id === prItem.id
              ? nextQtyOrdered > 0
              : i.qtyOrdered > 0
          );

          const nextStatus = isFullyOrdered
            ? "fully_ordered"
            : isPartiallyOrdered
            ? "partially_ordered"
            : "open";

          await tx
            .update(purchaseRequisitions)
            .set({ status: nextStatus })
            .where(eq(purchaseRequisitions.id, prItem.requisitionId));
        }
      }
    }

    // 4. Mark RFQ as awarded
    await tx
      .update(requestForQuotations)
      .set({
        status: "awarded",
        vendorId: targetVendorId ?? null,
        snapshotVendorName,
      })
      .where(eq(requestForQuotations.id, rfq.id));
  });

  const [po] = await db
    .select()
    .from(purchases)
    .where(eq(purchases.id, purchaseId));
  if (!po) throw new RfqError("INVALID_INPUT", "Failed to load created Purchase Order");
  return po;
}
