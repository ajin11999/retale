// Vendors service: CRUD, archive, a balance-guarded hard delete, and the two
// AP ledger writers — `recordVendorPayment` and `adjustVendorBalance`. Every
// ledger insert recomputes `vendors.balanceMinor` in the same transaction so
// the cached total never drifts. See docs/design-decisions.md → "Vendors".

import { desc, eq, isNull, sql } from "drizzle-orm";
import { ulid } from "ulid";
import { vendorLedger, vendors } from "../db/schema/vendors.ts";
import { db } from "../lib/db.ts";

export type VendorErrorCode =
  | "VENDOR_NOT_FOUND"
  | "INVALID_INPUT"
  | "HAS_BALANCE";

export class VendorError extends Error {
  constructor(
    public code: VendorErrorCode,
    message?: string,
  ) {
    super(message ?? code);
    this.name = "VendorError";
  }
}

type Vendor = typeof vendors.$inferSelect;
type LedgerEntry = typeof vendorLedger.$inferSelect;

/** A drizzle transaction handle; structurally a subset of `db`. */
type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

export function listVendors(includeArchived = false): Promise<Vendor[]> {
  return db
    .select()
    .from(vendors)
    .where(includeArchived ? undefined : isNull(vendors.archivedAt));
}

async function loadVendor(id: string): Promise<Vendor> {
  const row = await db.query.vendors.findFirst({ where: eq(vendors.id, id) });
  if (!row) throw new VendorError("VENDOR_NOT_FOUND");
  return row;
}

export { loadVendor as getVendor };

export async function createVendor(input: {
  name: string;
  phone?: string | null;
  email?: string | null;
  address?: string | null;
  taxId?: string | null;
  notes?: string | null;
  createdByUserId: string;
}): Promise<Vendor> {
  if (!input.name.trim()) throw new VendorError("INVALID_INPUT", "name is required");

  const id = ulid();
  await db.insert(vendors).values({
    id,
    name: input.name.trim(),
    phone: input.phone ?? null,
    email: input.email ?? null,
    address: input.address ?? null,
    taxId: input.taxId ?? null,
    notes: input.notes ?? null,
    createdByUserId: input.createdByUserId,
  });
  return loadVendor(id);
}

export async function updateVendor(
  id: string,
  patch: {
    name?: string;
    phone?: string | null;
    email?: string | null;
    address?: string | null;
    taxId?: string | null;
    notes?: string | null;
  },
): Promise<Vendor> {
  await loadVendor(id);
  if (patch.name !== undefined && !patch.name.trim()) {
    throw new VendorError("INVALID_INPUT", "name cannot be blank");
  }

  await db
    .update(vendors)
    .set({
      ...(patch.name !== undefined && { name: patch.name.trim() }),
      ...(patch.phone !== undefined && { phone: patch.phone }),
      ...(patch.email !== undefined && { email: patch.email }),
      ...(patch.address !== undefined && { address: patch.address }),
      ...(patch.taxId !== undefined && { taxId: patch.taxId }),
      ...(patch.notes !== undefined && { notes: patch.notes }),
    })
    .where(eq(vendors.id, id));
  return loadVendor(id);
}

export async function setVendorArchived(id: string, archived: boolean): Promise<Vendor> {
  await loadVendor(id);
  await db
    .update(vendors)
    .set({ archivedAt: archived ? new Date() : null })
    .where(eq(vendors.id, id));
  return loadVendor(id);
}

/**
 * Hard delete. Refused while the vendor carries a non-zero AP balance. The
 * "no non-cancelled purchases" half of the rule (design-decisions.md) is
 * enforced once the purchases domain exists; `vendor_ledger` cascade-deletes.
 */
export async function hardDeleteVendor(id: string): Promise<void> {
  const vendor = await loadVendor(id);
  if (vendor.balanceMinor !== 0) throw new VendorError("HAS_BALANCE");
  await db.delete(vendors).where(eq(vendors.id, id));
}

/** Per-vendor ledger SUM → write it back to the cached `balanceMinor`. */
async function syncBalance(tx: Tx, vendorId: string): Promise<void> {
  const sums = await tx
    .select({ total: sql<number>`COALESCE(SUM(${vendorLedger.amountMinor}), 0)` })
    .from(vendorLedger)
    .where(eq(vendorLedger.vendorId, vendorId));
  await tx
    .update(vendors)
    .set({ balanceMinor: Number(sums[0]?.total ?? 0) })
    .where(eq(vendors.id, vendorId));
}

/**
 * Record a payment to a vendor. `amountMinor` is the positive sum paid; it is
 * stored as a negative ledger row (it reduces what we owe). `posSessionId` is
 * expected when the cash leaves a POS drawer — not yet enforced (no POS
 * sessions domain). Returns the refreshed vendor.
 */
export async function recordVendorPayment(input: {
  vendorId: string;
  amountMinor: number;
  posSessionId?: string | null;
  note?: string | null;
  createdByUserId: string;
}): Promise<Vendor> {
  if (!Number.isInteger(input.amountMinor) || input.amountMinor <= 0) {
    throw new VendorError("INVALID_INPUT", "payment amount must be a positive integer");
  }
  return db.transaction(async (tx) => {
    const vendor = await tx.query.vendors.findFirst({
      where: eq(vendors.id, input.vendorId),
    });
    if (!vendor) throw new VendorError("VENDOR_NOT_FOUND");

    await tx.insert(vendorLedger).values({
      id: ulid(),
      vendorId: input.vendorId,
      type: "payment",
      amountMinor: -input.amountMinor,
      refType: "payment",
      note: input.note ?? null,
      posSessionId: input.posSessionId ?? null,
      createdByUserId: input.createdByUserId,
    });
    await syncBalance(tx, input.vendorId);

    const row = await tx.query.vendors.findFirst({
      where: eq(vendors.id, input.vendorId),
    });
    return row as Vendor;
  });
}

/**
 * Root-only manual balance correction (write-off, dispute settlement). A
 * signed `amountMinor` — positive grows what we owe, negative shrinks it — and
 * a `note` are both required.
 */
export async function adjustVendorBalance(input: {
  vendorId: string;
  amountMinor: number;
  note: string;
  createdByUserId: string;
}): Promise<Vendor> {
  if (!Number.isInteger(input.amountMinor) || input.amountMinor === 0) {
    throw new VendorError("INVALID_INPUT", "adjustment amount must be a non-zero integer");
  }
  if (!input.note.trim()) {
    throw new VendorError("INVALID_INPUT", "adjustment note is required");
  }
  return db.transaction(async (tx) => {
    const vendor = await tx.query.vendors.findFirst({
      where: eq(vendors.id, input.vendorId),
    });
    if (!vendor) throw new VendorError("VENDOR_NOT_FOUND");

    await tx.insert(vendorLedger).values({
      id: ulid(),
      vendorId: input.vendorId,
      type: "adjustment",
      amountMinor: input.amountMinor,
      refType: "adjustment",
      note: input.note.trim(),
      createdByUserId: input.createdByUserId,
    });
    await syncBalance(tx, input.vendorId);

    const row = await tx.query.vendors.findFirst({
      where: eq(vendors.id, input.vendorId),
    });
    return row as Vendor;
  });
}

/** Recent ledger entries for a vendor, newest first. */
export async function listVendorLedger(
  vendorId: string,
  limit = 100,
): Promise<LedgerEntry[]> {
  await loadVendor(vendorId);
  return db
    .select()
    .from(vendorLedger)
    .where(eq(vendorLedger.vendorId, vendorId))
    .orderBy(desc(vendorLedger.createdAt))
    .limit(Math.min(Math.max(limit, 1), 500));
}
