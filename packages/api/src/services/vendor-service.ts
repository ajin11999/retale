// Vendors service: CRUD, archive, a balance-guarded hard delete, and the two
// AP ledger writers — `recordVendorPayment` and `adjustVendorBalance`. Every
// ledger insert recomputes `vendors.balanceMinor` in the same transaction so
// the cached total never drifts. See docs/design-decisions.md → "Vendors".

import { and, desc, eq, isNull, sql } from "drizzle-orm";
import { ulid } from "ulid";
import {
  type VENDOR_KINDS,
  type VENDOR_SEND_CHANNELS,
  vendorLedger,
  vendors,
} from "../db/schema/vendors.ts";
import { db } from "../lib/db.ts";
import { isMoney } from "../lib/money.ts";

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
type SendChannel = (typeof VENDOR_SEND_CHANNELS)[number];
type VendorKind = (typeof VENDOR_KINDS)[number];

/** A drizzle transaction handle; structurally a subset of `db`. */
type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

export function listVendors(opts?: {
  includeArchived?: boolean;
  kind?: VendorKind;
}): Promise<Vendor[]> {
  const filters = [
    opts?.includeArchived ? undefined : isNull(vendors.archivedAt),
    opts?.kind ? eq(vendors.kind, opts.kind) : undefined,
  ].filter((c) => c !== undefined);
  return db
    .select()
    .from(vendors)
    .where(filters.length ? and(...filters) : undefined);
}

async function loadVendor(id: string): Promise<Vendor> {
  const row = await db.query.vendors.findFirst({ where: eq(vendors.id, id) });
  if (!row) throw new VendorError("VENDOR_NOT_FOUND");
  return row;
}

export { loadVendor as getVendor };

export async function createVendor(input: {
  name: string;
  kind?: VendorKind | null;
  phone?: string | null;
  email?: string | null;
  address?: string | null;
  taxId?: string | null;
  notes?: string | null;
  leadTimeDays?: number | null;
  paymentTermsDays?: number | null;
  preferredSendChannel?: SendChannel | null;
  defaultShipToAddressId?: string | null;
  createdByUserId: string;
}): Promise<Vendor> {
  if (!input.name.trim()) throw new VendorError("INVALID_INPUT", "name is required");
  assertNonNegativeDays(input.leadTimeDays, "leadTimeDays");
  assertNonNegativeDays(input.paymentTermsDays, "paymentTermsDays");

  const id = ulid();
  await db.insert(vendors).values({
    id,
    name: input.name.trim(),
    kind: input.kind ?? "supplier",
    phone: input.phone ?? null,
    email: input.email ?? null,
    address: input.address ?? null,
    taxId: input.taxId ?? null,
    notes: input.notes ?? null,
    leadTimeDays: input.leadTimeDays ?? null,
    paymentTermsDays: input.paymentTermsDays ?? null,
    preferredSendChannel: input.preferredSendChannel ?? null,
    defaultShipToAddressId: input.defaultShipToAddressId ?? null,
    createdByUserId: input.createdByUserId,
  });
  return loadVendor(id);
}

/** Shared guard for the day-count fields (lead time, payment terms). */
function assertNonNegativeDays(value: number | null | undefined, field: string): void {
  if (value != null && (!Number.isInteger(value) || value < 0)) {
    throw new VendorError("INVALID_INPUT", `${field} must be a non-negative integer`);
  }
}

export async function updateVendor(
  id: string,
  patch: {
    name?: string;
    kind?: VendorKind;
    phone?: string | null;
    email?: string | null;
    address?: string | null;
    taxId?: string | null;
    notes?: string | null;
    leadTimeDays?: number | null;
    paymentTermsDays?: number | null;
    preferredSendChannel?: SendChannel | null;
    defaultShipToAddressId?: string | null;
  },
): Promise<Vendor> {
  await loadVendor(id);
  if (patch.name !== undefined && !patch.name.trim()) {
    throw new VendorError("INVALID_INPUT", "name cannot be blank");
  }
  assertNonNegativeDays(patch.leadTimeDays, "leadTimeDays");
  assertNonNegativeDays(patch.paymentTermsDays, "paymentTermsDays");

  await db
    .update(vendors)
    .set({
      ...(patch.name !== undefined && { name: patch.name.trim() }),
      ...(patch.kind !== undefined && { kind: patch.kind }),
      ...(patch.phone !== undefined && { phone: patch.phone }),
      ...(patch.email !== undefined && { email: patch.email }),
      ...(patch.address !== undefined && { address: patch.address }),
      ...(patch.taxId !== undefined && { taxId: patch.taxId }),
      ...(patch.notes !== undefined && { notes: patch.notes }),
      ...(patch.leadTimeDays !== undefined && { leadTimeDays: patch.leadTimeDays }),
      ...(patch.paymentTermsDays !== undefined && {
        paymentTermsDays: patch.paymentTermsDays,
      }),
      ...(patch.preferredSendChannel !== undefined && {
        preferredSendChannel: patch.preferredSendChannel,
      }),
      ...(patch.defaultShipToAddressId !== undefined && {
        defaultShipToAddressId: patch.defaultShipToAddressId,
      }),
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
 * Raise AP for goods/freight received on a delivery — a `purchase_on_account`
 * row (positive `amountMinor` = we owe more) written inside the delivery's own
 * commit transaction, with the vendor's balance resynced in the same tx. Used
 * by delivery-service for both the supplier (goods) and any expedition vendor
 * (freight). `dueDate` is the charge's due date for AP aging.
 */
export async function postPurchaseOnAccount(
  tx: Tx,
  input: {
    vendorId: string;
    amountMinor: number;
    deliveryId: string;
    dueDate?: string | null;
    note?: string | null;
    createdByUserId?: string | null;
  },
): Promise<void> {
  if (!isMoney(input.amountMinor) || input.amountMinor <= 0) return;
  await tx.insert(vendorLedger).values({
    id: ulid(),
    vendorId: input.vendorId,
    type: "purchase_on_account",
    amountMinor: input.amountMinor,
    refType: "purchase_delivery",
    refId: input.deliveryId,
    dueDate: input.dueDate ?? null,
    note: input.note ?? null,
    createdByUserId: input.createdByUserId ?? null,
  });
  await syncBalance(tx, input.vendorId);
}

/**
 * Reverse every `purchase_on_account` raised by a delivery — used when a
 * delivered delivery is cancelled. Each original charge gets an offsetting
 * `refund_credit` (negative) row tagged to the same delivery, and every
 * affected vendor's balance is resynced. Runs inside the cancel transaction.
 */
export async function reverseDeliveryCharges(
  tx: Tx,
  deliveryId: string,
  createdByUserId?: string | null,
): Promise<void> {
  const charges = await tx
    .select()
    .from(vendorLedger)
    .where(
      and(
        eq(vendorLedger.refType, "purchase_delivery"),
        eq(vendorLedger.refId, deliveryId),
        eq(vendorLedger.type, "purchase_on_account"),
      ),
    );
  if (charges.length === 0) return;

  const vendorIds = new Set<string>();
  for (const c of charges) {
    await tx.insert(vendorLedger).values({
      id: ulid(),
      vendorId: c.vendorId,
      type: "refund_credit",
      amountMinor: -c.amountMinor,
      refType: "purchase_delivery",
      refId: deliveryId,
      note: "delivery cancelled",
      createdByUserId: createdByUserId ?? null,
    });
    vendorIds.add(c.vendorId);
  }
  for (const vid of vendorIds) await syncBalance(tx, vid);
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
  if (!isMoney(input.amountMinor) || input.amountMinor <= 0) {
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
  if (!isMoney(input.amountMinor) || input.amountMinor === 0) {
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
