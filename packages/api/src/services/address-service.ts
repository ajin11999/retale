// Address-book service: CRUD over the business's ship-to addresses, plus
// `setDefaultAddress` (keeps at most one row flagged) and `resolveShipTo`
// (the address a given vendor's PO ships to — its explicit default, else the
// fallback row, else none). Deleting an address is allowed; the
// `vendors.defaultShipToAddressId` FK is SET NULL, so a vendor quietly reverts
// to the fallback. See docs/design-decisions.md.

import { and, asc, eq, isNull, ne } from "drizzle-orm";
import { ulid } from "ulid";
import { addresses } from "../db/schema/addresses.ts";
import { vendors } from "../db/schema/vendors.ts";
import { db } from "../lib/db.ts";

export type AddressErrorCode = "ADDRESS_NOT_FOUND" | "INVALID_INPUT";

export class AddressError extends Error {
  constructor(
    public code: AddressErrorCode,
    message?: string,
  ) {
    super(message ?? code);
    this.name = "AddressError";
  }
}

type Address = typeof addresses.$inferSelect;

export function listAddresses(includeArchived = false): Promise<Address[]> {
  return db
    .select()
    .from(addresses)
    .where(includeArchived ? undefined : isNull(addresses.archivedAt))
    .orderBy(asc(addresses.label));
}

async function loadAddress(id: string): Promise<Address> {
  const row = await db.query.addresses.findFirst({ where: eq(addresses.id, id) });
  if (!row) throw new AddressError("ADDRESS_NOT_FOUND");
  return row;
}

export { loadAddress as getAddress };

export async function createAddress(input: {
  label: string;
  recipientName?: string | null;
  phone?: string | null;
  line: string;
  notes?: string | null;
  isDefault?: boolean;
  createdByUserId: string;
}): Promise<Address> {
  if (!input.label.trim()) throw new AddressError("INVALID_INPUT", "label is required");
  if (!input.line.trim()) throw new AddressError("INVALID_INPUT", "line is required");

  const id = ulid();
  await db.transaction(async (tx) => {
    if (input.isDefault) {
      await tx.update(addresses).set({ isDefault: false });
    }
    await tx.insert(addresses).values({
      id,
      label: input.label.trim(),
      recipientName: input.recipientName ?? null,
      phone: input.phone ?? null,
      line: input.line.trim(),
      notes: input.notes ?? null,
      isDefault: input.isDefault ?? false,
      createdByUserId: input.createdByUserId,
    });
  });
  return loadAddress(id);
}

export async function updateAddress(
  id: string,
  patch: {
    label?: string;
    recipientName?: string | null;
    phone?: string | null;
    line?: string;
    notes?: string | null;
    isDefault?: boolean;
  },
): Promise<Address> {
  await loadAddress(id);
  if (patch.label !== undefined && !patch.label.trim()) {
    throw new AddressError("INVALID_INPUT", "label cannot be blank");
  }
  if (patch.line !== undefined && !patch.line.trim()) {
    throw new AddressError("INVALID_INPUT", "line cannot be blank");
  }

  await db.transaction(async (tx) => {
    // Promoting this row to default demotes every other row first.
    if (patch.isDefault === true) {
      await tx.update(addresses).set({ isDefault: false }).where(ne(addresses.id, id));
    }
    await tx
      .update(addresses)
      .set({
        ...(patch.label !== undefined && { label: patch.label.trim() }),
        ...(patch.recipientName !== undefined && { recipientName: patch.recipientName }),
        ...(patch.phone !== undefined && { phone: patch.phone }),
        ...(patch.line !== undefined && { line: patch.line.trim() }),
        ...(patch.notes !== undefined && { notes: patch.notes }),
        ...(patch.isDefault !== undefined && { isDefault: patch.isDefault }),
      })
      .where(eq(addresses.id, id));
  });
  return loadAddress(id);
}

/** Promote one address to the single default; demotes all others atomically. */
export async function setDefaultAddress(id: string): Promise<Address> {
  await loadAddress(id);
  await db.transaction(async (tx) => {
    await tx.update(addresses).set({ isDefault: false }).where(ne(addresses.id, id));
    await tx.update(addresses).set({ isDefault: true }).where(eq(addresses.id, id));
  });
  return loadAddress(id);
}

export async function setAddressArchived(id: string, archived: boolean): Promise<Address> {
  await loadAddress(id);
  await db
    .update(addresses)
    .set({
      archivedAt: archived ? new Date() : null,
      // An archived row can't be the live default.
      ...(archived && { isDefault: false }),
    })
    .where(eq(addresses.id, id));
  return loadAddress(id);
}

/** Hard delete. Vendors pointing here revert to the fallback (FK SET NULL). */
export async function deleteAddress(id: string): Promise<void> {
  await loadAddress(id);
  await db.delete(addresses).where(eq(addresses.id, id));
}

/**
 * The ship-to address for a vendor's purchase order: the vendor's explicit
 * `defaultShipToAddressId` if set and not archived, else the address-book row
 * flagged `isDefault`, else null (the PO header then shows the business name
 * only). Pure read.
 */
export async function resolveShipTo(vendorId: string | null): Promise<Address | null> {
  if (vendorId) {
    const vendor = await db.query.vendors.findFirst({ where: eq(vendors.id, vendorId) });
    if (vendor?.defaultShipToAddressId) {
      const row = await db.query.addresses.findFirst({
        where: and(
          eq(addresses.id, vendor.defaultShipToAddressId),
          isNull(addresses.archivedAt),
        ),
      });
      if (row) return row;
    }
  }
  return (
    (await db.query.addresses.findFirst({
      where: and(eq(addresses.isDefault, true), isNull(addresses.archivedAt)),
    })) ?? null
  );
}
