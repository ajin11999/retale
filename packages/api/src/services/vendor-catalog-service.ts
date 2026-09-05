// Vendor catalog service: CRUD over the vendor-pricelist reference rows plus
// the variant-linking that makes them useful (PO picker, RFQ compare,
// receiving scan via `vendor_variant_codes`). Import preview/confirm lives in
// catalog-import-service.ts; LLM extraction in catalog-extract-service.ts.
//
// All money is IDR literal (DECIMAL(19,2)); units are free-text `unitText`.
// Permission checks live in the GraphQL resolvers / HTTP routes, not here.

import { and, desc, eq, isNull, like, or, sql } from "drizzle-orm";
import { ulid } from "ulid";
import { productVariants } from "../db/schema/products.ts";
import {
  vendorCatalogImports,
  vendorCatalogItems,
  vendorCatalogPrices,
} from "../db/schema/vendor-catalog.ts";
import { vendorVariantCodes } from "../db/schema/vendor-variant-codes.ts";
import { vendors } from "../db/schema/vendors.ts";
import { db } from "../lib/db.ts";
import { isMoney, roundMoney } from "../lib/money.ts";

export type VendorCatalogErrorCode =
  | "CATALOG_ITEM_NOT_FOUND"
  | "VENDOR_NOT_FOUND"
  | "VARIANT_NOT_FOUND"
  | "IMPORT_NOT_FOUND"
  | "INVALID_INPUT";

export class VendorCatalogError extends Error {
  constructor(
    public code: VendorCatalogErrorCode,
    message?: string,
  ) {
    super(message ?? code);
    this.name = "VendorCatalogError";
  }
}

export type VendorCatalogItem = typeof vendorCatalogItems.$inferSelect;
export type VendorCatalogPrice = typeof vendorCatalogPrices.$inferSelect;
export type VendorCatalogImport = typeof vendorCatalogImports.$inferSelect;

/** Rows older than this without re-confirmation count as stale. */
export const CATALOG_STALE_DAYS = 90;

export function isCatalogRowStale(
  row: Pick<VendorCatalogItem, "validTo" | "lastSeenAt">,
  now = new Date(),
): boolean {
  if (row.validTo) {
    // validTo is a YYYY-MM-DD string; compare at day granularity.
    if (row.validTo < now.toISOString().slice(0, 10)) return true;
  }
  if (row.lastSeenAt) {
    const ageMs = now.getTime() - new Date(row.lastSeenAt).getTime();
    if (ageMs > CATALOG_STALE_DAYS * 24 * 60 * 60 * 1000) return true;
  }
  return false;
}

function assertMoney(n: unknown, field: string): number {
  if (typeof n !== "number" || !isMoney(n) || n < 0) {
    throw new VendorCatalogError("INVALID_INPUT", `${field} must be a non-negative amount with at most 2 decimals`);
  }
  return roundMoney(n);
}

function assertName(name: unknown): string {
  if (typeof name !== "string" || !name.trim()) {
    throw new VendorCatalogError("INVALID_INPUT", "name is required");
  }
  if (name.trim().length > 300) {
    throw new VendorCatalogError("INVALID_INPUT", "name is too long (max 300)");
  }
  return name.trim();
}

async function requireVendor(vendorId: string): Promise<void> {
  const row = await db.query.vendors.findFirst({
    where: eq(vendors.id, vendorId),
  });
  if (!row) throw new VendorCatalogError("VENDOR_NOT_FOUND");
}

async function requireVariant(variantId: string): Promise<void> {
  const row = await db.query.productVariants.findFirst({
    where: eq(productVariants.id, variantId),
  });
  if (!row) throw new VendorCatalogError("VARIANT_NOT_FOUND");
}

export async function getCatalogItem(id: string): Promise<VendorCatalogItem> {
  const row = await db.query.vendorCatalogItems.findFirst({
    where: eq(vendorCatalogItems.id, id),
  });
  if (!row) throw new VendorCatalogError("CATALOG_ITEM_NOT_FOUND");
  return row;
}

export function listCatalogItems(
  vendorId: string,
  opts?: { search?: string; includeArchived?: boolean },
): Promise<VendorCatalogItem[]> {
  const search = opts?.search?.trim().toLowerCase();
  return db
    .select()
    .from(vendorCatalogItems)
    .where(
      and(
        eq(vendorCatalogItems.vendorId, vendorId),
        opts?.includeArchived ? undefined : isNull(vendorCatalogItems.archivedAt),
        search ? like(vendorCatalogItems.searchText, `%${search}%`) : undefined,
      ),
    )
    .orderBy(vendorCatalogItems.name);
}

export interface CreateCatalogItemInput {
  vendorId: string;
  vendorCode?: string;
  name: string;
  unitText?: string;
  priceMinor: number;
  moq?: number;
  leadTimeDays?: number;
  validFrom?: string;
  validTo?: string;
  mappedVariantId?: string;
  note?: string;
}

export async function createCatalogItem(
  input: CreateCatalogItemInput,
  createdByUserId?: string,
): Promise<VendorCatalogItem> {
  await requireVendor(input.vendorId);
  const name = assertName(input.name);
  const priceMinor = assertMoney(input.priceMinor, "priceMinor");
  const vendorCode = (input.vendorCode ?? "").trim().slice(0, 100);
  if (input.mappedVariantId) await requireVariant(input.mappedVariantId);

  const id = ulid();
  await db.transaction(async (tx) => {
    await tx.insert(vendorCatalogItems).values({
      id,
      vendorId: input.vendorId,
      vendorCode,
      name,
      unitText: input.unitText?.trim().slice(0, 50) || null,
      priceMinor,
      moq: input.moq ?? null,
      leadTimeDays: input.leadTimeDays ?? null,
      validFrom: input.validFrom || null,
      validTo: input.validTo || null,
      mappedVariantId: input.mappedVariantId ?? null,
      note: input.note?.trim() || null,
      lastSeenAt: new Date(),
      createdByUserId: createdByUserId ?? null,
    });
    await tx.insert(vendorCatalogPrices).values({
      id: ulid(),
      itemId: id,
      priceMinor,
      validFrom: input.validFrom || null,
      createdByUserId: createdByUserId ?? null,
    });
  });
  return getCatalogItem(id);
}

export interface UpdateCatalogItemInput {
  vendorCode?: string;
  name?: string;
  unitText?: string | null;
  priceMinor?: number;
  moq?: number | null;
  leadTimeDays?: number | null;
  validFrom?: string | null;
  validTo?: string | null;
  isActive?: boolean;
  note?: string | null;
}

export async function updateCatalogItem(
  id: string,
  patch: UpdateCatalogItemInput,
  updatedByUserId?: string,
): Promise<VendorCatalogItem> {
  const existing = await getCatalogItem(id);
  const next: Partial<VendorCatalogItem> = {};
  if (patch.vendorCode !== undefined) next.vendorCode = patch.vendorCode.trim().slice(0, 100);
  if (patch.name !== undefined) next.name = assertName(patch.name);
  if (patch.unitText !== undefined) next.unitText = patch.unitText?.trim().slice(0, 50) || null;
  let priceChanged = false;
  if (patch.priceMinor !== undefined) {
    const price = assertMoney(patch.priceMinor, "priceMinor");
    if (price !== existing.priceMinor) priceChanged = true;
    next.priceMinor = price;
  }
  if (patch.moq !== undefined) next.moq = patch.moq;
  if (patch.leadTimeDays !== undefined) next.leadTimeDays = patch.leadTimeDays;
  if (patch.validFrom !== undefined) next.validFrom = patch.validFrom || null;
  if (patch.validTo !== undefined) next.validTo = patch.validTo || null;
  if (patch.isActive !== undefined) next.isActive = patch.isActive;
  if (patch.note !== undefined) next.note = patch.note?.trim() || null;
  next.lastSeenAt = new Date();

  await db.transaction(async (tx) => {
    await tx
      .update(vendorCatalogItems)
      .set(next)
      .where(eq(vendorCatalogItems.id, id));
    if (priceChanged) {
      await tx.insert(vendorCatalogPrices).values({
        id: ulid(),
        itemId: id,
        priceMinor: next.priceMinor!,
        validFrom: next.validFrom !== undefined ? next.validFrom : existing.validFrom,
        createdByUserId: updatedByUserId ?? null,
      });
    }
  });
  return getCatalogItem(id);
}

export async function setCatalogItemArchived(id: string, archived: boolean): Promise<VendorCatalogItem> {
  await getCatalogItem(id);
  await db
    .update(vendorCatalogItems)
    .set({ archivedAt: archived ? new Date() : null })
    .where(eq(vendorCatalogItems.id, id));
  return getCatalogItem(id);
}

export async function hardDeleteCatalogItem(id: string): Promise<void> {
  await getCatalogItem(id);
  // Price history cascades via FK; variant links are SET NULL-safe (we hold
  // the nullable side, and vendor_variant_codes rows are left intact so the
  // receiving scan keeps working).
  await db.delete(vendorCatalogItems).where(eq(vendorCatalogItems.id, id));
}

/**
 * Link a catalog row to one of our variants. Also upserts the
 * `vendor_variant_codes` row (keyed on vendor+variant) when the catalog row
 * carries a vendor code, so the receiving scan resolves boxes from this
 * vendor. Unlinking keeps the code row — the scan mapping outlives the
 * reference link by design.
 */
export async function linkCatalogItem(
  id: string,
  variantId: string,
): Promise<VendorCatalogItem> {
  const item = await getCatalogItem(id);
  await requireVariant(variantId);
  await db.transaction(async (tx) => {
    await tx
      .update(vendorCatalogItems)
      .set({ mappedVariantId: variantId, lastSeenAt: new Date() })
      .where(eq(vendorCatalogItems.id, id));
    if (item.vendorCode.trim()) {
      const existing = await tx
        .select({ id: vendorVariantCodes.id })
        .from(vendorVariantCodes)
        .where(
          and(
            eq(vendorVariantCodes.vendorId, item.vendorId),
            eq(vendorVariantCodes.variantId, variantId),
          ),
        );
      if (existing.length === 0) {
        await tx.insert(vendorVariantCodes).values({
          id: ulid(),
          vendorId: item.vendorId,
          variantId,
          code: item.vendorCode.trim(),
          isPreferred: false,
        });
      } else {
        await tx
          .update(vendorVariantCodes)
          .set({ code: item.vendorCode.trim() })
          .where(eq(vendorVariantCodes.id, existing[0]!.id));
      }
    }
  });
  return getCatalogItem(id);
}

export async function unlinkCatalogItem(id: string): Promise<VendorCatalogItem> {
  await getCatalogItem(id);
  await db
    .update(vendorCatalogItems)
    .set({ mappedVariantId: null })
    .where(eq(vendorCatalogItems.id, id));
  return getCatalogItem(id);
}

export function listCatalogPriceHistory(itemId: string): Promise<VendorCatalogPrice[]> {
  return db
    .select()
    .from(vendorCatalogPrices)
    .where(eq(vendorCatalogPrices.itemId, itemId))
    .orderBy(desc(vendorCatalogPrices.createdAt));
}

export interface CatalogPriceComparison {
  item: VendorCatalogItem;
  vendorName: string;
  stale: boolean;
}

/**
 * Every active, non-archived catalog row linked to a variant, cheapest first,
 * across all vendors — the RFQ / PO price-compare view.
 */
export async function compareCatalogPrices(variantId: string): Promise<CatalogPriceComparison[]> {
  const rows = await db
    .select({ item: vendorCatalogItems, vendorName: vendors.name })
    .from(vendorCatalogItems)
    .innerJoin(vendors, eq(vendors.id, vendorCatalogItems.vendorId))
    .where(
      and(
        eq(vendorCatalogItems.mappedVariantId, variantId),
        eq(vendorCatalogItems.isActive, true),
        isNull(vendorCatalogItems.archivedAt),
      ),
    )
    .orderBy(vendorCatalogItems.priceMinor);
  const now = new Date();
  return rows.map((r) => ({ item: r.item, vendorName: r.vendorName, stale: isCatalogRowStale(r.item, now) }));
}

/** Find an existing row for dedupe: exact (vendor, lower(code)) then name-exact. */
export async function findCatalogMatch(
  vendorId: string,
  vendorCode: string,
  name: string,
): Promise<VendorCatalogItem | null> {
  const code = vendorCode.trim();
  if (code) {
    const byCode = await db
      .select()
      .from(vendorCatalogItems)
      .where(
        and(
          eq(vendorCatalogItems.vendorId, vendorId),
          sql`lower(${vendorCatalogItems.vendorCode}) = lower(${code})`,
        ),
      );
    if (byCode.length > 0) return byCode[0]!;
  }
  const byName = await db
    .select()
    .from(vendorCatalogItems)
    .where(
      and(
        eq(vendorCatalogItems.vendorId, vendorId),
        sql`lower(${vendorCatalogItems.name}) = lower(${name.trim()})`,
        isNull(vendorCatalogItems.archivedAt),
      ),
    );
  return byName[0] ?? null;
}

export function listCatalogImports(vendorId: string): Promise<VendorCatalogImport[]> {
  return db
    .select()
    .from(vendorCatalogImports)
    .where(eq(vendorCatalogImports.vendorId, vendorId))
    .orderBy(desc(vendorCatalogImports.createdAt));
}

export async function getCatalogImport(id: string): Promise<VendorCatalogImport> {
  const row = await db.query.vendorCatalogImports.findFirst({
    where: eq(vendorCatalogImports.id, id),
  });
  if (!row) throw new VendorCatalogError("IMPORT_NOT_FOUND");
  return row;
}
