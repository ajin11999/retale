// Vendor variant code service: CRUD over the vendor-part-number ↔ variant
// mapping, plus the two lookups its consumers need — `resolveVendorCode` for
// the receiving scan and `preferredVendorByVariant` for the reorder scan.
// Setting a mapping `isPreferred` clears the flag on the variant's other
// vendors, so at most one preferred vendor exists per variant.

import { and, eq, inArray, ne } from "drizzle-orm";
import { ulid } from "ulid";
import { productVariants } from "../db/schema/products.ts";
import { vendorVariantCodes } from "../db/schema/vendor-variant-codes.ts";
import { vendors } from "../db/schema/vendors.ts";
import { db } from "../lib/db.ts";

export type VendorVariantCodeErrorCode =
  | "CODE_NOT_FOUND"
  | "VENDOR_NOT_FOUND"
  | "VARIANT_NOT_FOUND"
  | "INVALID_INPUT";

export class VendorVariantCodeError extends Error {
  constructor(
    public code: VendorVariantCodeErrorCode,
    message?: string,
  ) {
    super(message ?? code);
    this.name = "VendorVariantCodeError";
  }
}

type VendorVariantCode = typeof vendorVariantCodes.$inferSelect;

async function loadCode(id: string): Promise<VendorVariantCode> {
  const row = await db.query.vendorVariantCodes.findFirst({
    where: eq(vendorVariantCodes.id, id),
  });
  if (!row) throw new VendorVariantCodeError("CODE_NOT_FOUND");
  return row;
}

export { loadCode as getVendorVariantCode };

export function listCodesForVendor(vendorId: string): Promise<VendorVariantCode[]> {
  return db
    .select()
    .from(vendorVariantCodes)
    .where(eq(vendorVariantCodes.vendorId, vendorId));
}

export function listCodesForVariant(variantId: string): Promise<VendorVariantCode[]> {
  return db
    .select()
    .from(vendorVariantCodes)
    .where(eq(vendorVariantCodes.variantId, variantId));
}

/**
 * Upsert a vendor's code for a variant — keyed on `(vendorId, variantId)`, so
 * re-mapping the same pair edits the existing row. Marking the mapping
 * `isPreferred` demotes every other vendor of that variant in the same
 * transaction, keeping a single preferred vendor per variant.
 */
export async function setVendorVariantCode(input: {
  vendorId: string;
  variantId: string;
  code: string;
  isPreferred?: boolean;
}): Promise<VendorVariantCode> {
  const code = input.code.trim();
  if (!code) throw new VendorVariantCodeError("INVALID_INPUT", "code is required");

  const vendor = await db.query.vendors.findFirst({
    where: eq(vendors.id, input.vendorId),
  });
  if (!vendor) throw new VendorVariantCodeError("VENDOR_NOT_FOUND");
  const variant = await db.query.productVariants.findFirst({
    where: eq(productVariants.id, input.variantId),
  });
  if (!variant) throw new VendorVariantCodeError("VARIANT_NOT_FOUND");

  const existing = await db.query.vendorVariantCodes.findFirst({
    where: and(
      eq(vendorVariantCodes.vendorId, input.vendorId),
      eq(vendorVariantCodes.variantId, input.variantId),
    ),
  });
  const isPreferred = input.isPreferred ?? existing?.isPreferred ?? false;
  const id = existing?.id ?? ulid();

  await db.transaction(async (tx) => {
    if (existing) {
      await tx
        .update(vendorVariantCodes)
        .set({ code, isPreferred })
        .where(eq(vendorVariantCodes.id, id));
    } else {
      await tx.insert(vendorVariantCodes).values({
        id,
        vendorId: input.vendorId,
        variantId: input.variantId,
        code,
        isPreferred,
      });
    }
    // One preferred vendor per variant: demote the others.
    if (isPreferred) {
      await tx
        .update(vendorVariantCodes)
        .set({ isPreferred: false })
        .where(
          and(
            eq(vendorVariantCodes.variantId, input.variantId),
            ne(vendorVariantCodes.id, id),
          ),
        );
    }
  });
  return loadCode(id);
}

export async function deleteVendorVariantCode(id: string): Promise<void> {
  await loadCode(id);
  await db.delete(vendorVariantCodes).where(eq(vendorVariantCodes.id, id));
}

/**
 * Resolve a vendor's part number to the variant(s) it maps to. Used by the
 * receiving scan: a code on a delivery box from a known vendor. Normally one
 * variant, but the lookup returns all matches for the caller to handle.
 */
export async function resolveVendorCode(
  vendorId: string,
  code: string,
): Promise<string[]> {
  const trimmed = code.trim();
  if (!trimmed) return [];
  const rows = await db
    .select({ variantId: vendorVariantCodes.variantId })
    .from(vendorVariantCodes)
    .where(
      and(
        eq(vendorVariantCodes.vendorId, vendorId),
        eq(vendorVariantCodes.code, trimmed),
      ),
    );
  return rows.map((r) => r.variantId);
}

/**
 * The preferred vendor for each of the given variants, where one is set.
 * Used by the reorder scan to route a suggestion to its go-to vendor.
 */
export async function preferredVendorByVariant(
  variantIds: string[],
): Promise<Map<string, string>> {
  const result = new Map<string, string>();
  if (variantIds.length === 0) return result;
  const rows = await db
    .select({
      variantId: vendorVariantCodes.variantId,
      vendorId: vendorVariantCodes.vendorId,
    })
    .from(vendorVariantCodes)
    .where(
      and(
        eq(vendorVariantCodes.isPreferred, true),
        inArray(vendorVariantCodes.variantId, variantIds),
      ),
    );
  for (const r of rows) result.set(r.variantId, r.vendorId);
  return result;
}
