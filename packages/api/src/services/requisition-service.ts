import { and, asc, desc, eq, ne, sql } from "drizzle-orm";
import { ulid } from "ulid";
import { db } from "../lib/db.ts";
import {
  purchaseRequisitions,
  purchaseRequisitionSections,
  purchaseRequisitionItems,
  type PURCHASE_REQUISITION_STATUSES,
} from "../db/schema/requisitions.ts";

export type RequisitionErrorCode =
  | "REQUISITION_NOT_FOUND"
  | "SECTION_NOT_FOUND"
  | "ITEM_NOT_FOUND"
  | "INVALID_INPUT"
  | "NOT_OPEN";

export class RequisitionError extends Error {
  constructor(public code: RequisitionErrorCode, message?: string) {
    super(message ?? code);
    this.name = "RequisitionError";
  }
}

type Requisition = typeof purchaseRequisitions.$inferSelect;
type Section = typeof purchaseRequisitionSections.$inferSelect;
type Item = typeof purchaseRequisitionItems.$inferSelect;

async function loadRequisition(id: string): Promise<Requisition> {
  const row = await db.query.purchaseRequisitions.findFirst({ where: eq(purchaseRequisitions.id, id) });
  if (!row) throw new RequisitionError("REQUISITION_NOT_FOUND");
  return row;
}

export { loadRequisition as getRequisition };

function assertEditable(req: Requisition): void {
  if (req.status === "cancelled") {
    throw new RequisitionError("NOT_OPEN", "requisition is cancelled");
  }
}

async function loadItem(id: string): Promise<Item> {
  const row = await db.query.purchaseRequisitionItems.findFirst({ where: eq(purchaseRequisitionItems.id, id) });
  if (!row) throw new RequisitionError("ITEM_NOT_FOUND");
  return row;
}

async function loadSection(id: string): Promise<Section> {
  const row = await db.query.purchaseRequisitionSections.findFirst({ where: eq(purchaseRequisitionSections.id, id) });
  if (!row) throw new RequisitionError("SECTION_NOT_FOUND");
  return row;
}

export function listRequisitions(opts: {
  status?: typeof purchaseRequisitions.$inferSelect["status"];
  includeCancelled?: boolean;
}): Promise<Requisition[]> {
  const filters = [];
  if (opts.status) filters.push(eq(purchaseRequisitions.status, opts.status));
  else if (!opts.includeCancelled) filters.push(ne(purchaseRequisitions.status, "cancelled"));
  return db
    .select()
    .from(purchaseRequisitions)
    .where(filters.length ? and(...filters) : undefined)
    .orderBy(desc(purchaseRequisitions.createdAt));
}

export async function createRequisition(input: {
  name: string;
  createdByUserId: string;
}): Promise<Requisition> {
  if (!input.name?.trim()) throw new RequisitionError("INVALID_INPUT", "name is required");
  const id = ulid();
  await db.insert(purchaseRequisitions).values({
    id,
    name: input.name.trim(),
    createdByUserId: input.createdByUserId,
  });
  return loadRequisition(id);
}

export async function updateRequisition(
  id: string,
  patch: { name?: string; status?: typeof purchaseRequisitions.$inferSelect["status"] }
): Promise<Requisition> {
  const req = await loadRequisition(id);
  const set: Partial<typeof purchaseRequisitions.$inferInsert> = {};
  if (patch.name !== undefined) {
    if (!patch.name.trim()) throw new RequisitionError("INVALID_INPUT", "name cannot be empty");
    set.name = patch.name.trim();
  }
  if (patch.status !== undefined) set.status = patch.status;
  if (Object.keys(set).length === 0) return req;
  await db.update(purchaseRequisitions).set(set).where(eq(purchaseRequisitions.id, id));
  return loadRequisition(id);
}

export async function deleteRequisition(id: string): Promise<void> {
  const req = await loadRequisition(id);
  if (req.status !== "draft" && req.status !== "open") {
    throw new RequisitionError("NOT_OPEN", "cannot delete a requisition that is ordered or cancelled");
  }
  await db.delete(purchaseRequisitions).where(eq(purchaseRequisitions.id, id));
}

export async function createSection(requisitionId: string, name: string): Promise<Section> {
  const req = await loadRequisition(requisitionId);
  assertEditable(req);
  if (!name.trim()) throw new RequisitionError("INVALID_INPUT", "name is required");
  
  const id = ulid();
  const existing = await db
    .select({ max: sql<number>`MAX(${purchaseRequisitionSections.sortOrder})` })
    .from(purchaseRequisitionSections)
    .where(eq(purchaseRequisitionSections.requisitionId, requisitionId));
  const nextSort = existing[0]?.max != null ? existing[0].max + 1 : 0;

  await db.insert(purchaseRequisitionSections).values({
    id,
    requisitionId,
    name: name.trim(),
    sortOrder: nextSort,
  });
  return loadSection(id);
}

export async function updateSection(id: string, name: string): Promise<Section> {
  const section = await loadSection(id);
  const req = await loadRequisition(section.requisitionId);
  assertEditable(req);
  if (!name.trim()) throw new RequisitionError("INVALID_INPUT", "name is required");
  await db
    .update(purchaseRequisitionSections)
    .set({ name: name.trim() })
    .where(eq(purchaseRequisitionSections.id, id));
  return loadSection(id);
}

export async function deleteSection(id: string): Promise<void> {
  const section = await loadSection(id);
  const req = await loadRequisition(section.requisitionId);
  assertEditable(req);
  await db.delete(purchaseRequisitionSections).where(eq(purchaseRequisitionSections.id, id));
}

export async function reorderSections(requisitionId: string, orderedIds: string[]): Promise<Section[]> {
  const req = await loadRequisition(requisitionId);
  assertEditable(req);
  const existing = await db
    .select()
    .from(purchaseRequisitionSections)
    .where(eq(purchaseRequisitionSections.requisitionId, requisitionId));
  const ids = new Set(existing.map((s) => s.id));
  if (orderedIds.length !== ids.size || !orderedIds.every((i) => ids.has(i))) {
    throw new RequisitionError("INVALID_INPUT", "orderedIds must list every section exactly once");
  }
  await db.transaction(async (tx) => {
    for (let i = 0; i < orderedIds.length; i++) {
      await tx
        .update(purchaseRequisitionSections)
        .set({ sortOrder: i })
        .where(eq(purchaseRequisitionSections.id, orderedIds[i] as string));
    }
  });
  return db
    .select()
    .from(purchaseRequisitionSections)
    .where(eq(purchaseRequisitionSections.requisitionId, requisitionId))
    .orderBy(asc(purchaseRequisitionSections.sortOrder));
}

export async function createItem(input: {
  requisitionId: string;
  sectionId?: string | null;
  variantId?: string | null;
  description?: string | null;
  qtyRequested: number;
  sortOrder?: number;
}): Promise<Item> {
  const req = await loadRequisition(input.requisitionId);
  assertEditable(req);
  if (input.qtyRequested <= 0) throw new RequisitionError("INVALID_INPUT", "qtyRequested must be positive");
  const description = input.description?.trim() || null;
  if (!input.variantId && !description) {
    throw new RequisitionError("INVALID_INPUT", "non-stock lines must have a description");
  }
  const id = ulid();
  await db.insert(purchaseRequisitionItems).values({
    id,
    requisitionId: input.requisitionId,
    sectionId: input.sectionId ?? null,
    variantId: input.variantId ?? null,
    description,
    qtyRequested: input.qtyRequested,
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
    sortOrder?: number;
  }
): Promise<Item> {
  const item = await loadItem(id);
  const req = await loadRequisition(item.requisitionId);
  assertEditable(req);
  const nextDescription = patch.description !== undefined ? patch.description?.trim() || null : undefined;
  if (patch.qtyRequested !== undefined && patch.qtyRequested <= 0) {
    throw new RequisitionError("INVALID_INPUT", "qtyRequested must be positive");
  }
  if (patch.variantId === null && nextDescription === null) {
    throw new RequisitionError("INVALID_INPUT", "non-stock lines must have a description");
  }
  await db
    .update(purchaseRequisitionItems)
    .set({
      ...(patch.sectionId !== undefined && { sectionId: patch.sectionId }),
      ...(patch.variantId !== undefined && { variantId: patch.variantId }),
      ...(patch.description !== undefined && { description: nextDescription }),
      ...(patch.qtyRequested !== undefined && { qtyRequested: patch.qtyRequested }),
      ...(patch.sortOrder !== undefined && { sortOrder: patch.sortOrder }),
    })
    .where(eq(purchaseRequisitionItems.id, id));
  return loadItem(id);
}

export async function deleteItem(id: string): Promise<void> {
  const item = await loadItem(id);
  const req = await loadRequisition(item.requisitionId);
  assertEditable(req);
  if (item.qtyOrdered > 0) {
    throw new RequisitionError("NOT_OPEN", "cannot delete an item that has already been partially or fully ordered");
  }
  await db.delete(purchaseRequisitionItems).where(eq(purchaseRequisitionItems.id, id));
}

export async function reorderItems(
  requisitionId: string,
  orderedIds: string[]
): Promise<Item[]> {
  const req = await loadRequisition(requisitionId);
  assertEditable(req);
  const existing = await db
    .select()
    .from(purchaseRequisitionItems)
    .where(eq(purchaseRequisitionItems.requisitionId, requisitionId));
  const ids = new Set(existing.map((i) => i.id));
  if (orderedIds.length !== ids.size || !orderedIds.every((i) => ids.has(i))) {
    throw new RequisitionError("INVALID_INPUT", "orderedIds must list every item exactly once");
  }
  await db.transaction(async (tx) => {
    for (let i = 0; i < orderedIds.length; i++) {
      await tx
        .update(purchaseRequisitionItems)
        .set({ sortOrder: i })
        .where(eq(purchaseRequisitionItems.id, orderedIds[i] as string));
    }
  });
  return db
    .select()
    .from(purchaseRequisitionItems)
    .where(eq(purchaseRequisitionItems.requisitionId, requisitionId))
    .orderBy(asc(purchaseRequisitionItems.sortOrder));
}

export function listSections(requisitionId: string): Promise<Section[]> {
  return db
    .select()
    .from(purchaseRequisitionSections)
    .where(eq(purchaseRequisitionSections.requisitionId, requisitionId))
    .orderBy(asc(purchaseRequisitionSections.sortOrder));
}

export function listItems(requisitionId: string): Promise<Item[]> {
  return db
    .select()
    .from(purchaseRequisitionItems)
    .where(eq(purchaseRequisitionItems.requisitionId, requisitionId))
    .orderBy(asc(purchaseRequisitionItems.sortOrder));
}

export function listSectionItems(sectionId: string): Promise<Item[]> {
  return db
    .select()
    .from(purchaseRequisitionItems)
    .where(eq(purchaseRequisitionItems.sectionId, sectionId))
    .orderBy(asc(purchaseRequisitionItems.sortOrder));
}
