// Products service: category, product, and variant management. Money is in
// integer minor units; stock qty in the variant's smallest unit. WAC and
// stock movements belong to the stock/purchase domains — this service only
// sets initial cost/qty values. See docs/design-decisions.md.

import { and, eq, isNull, like } from "drizzle-orm";
import { ulid } from "ulid";
import {
  productCategories,
  productPriceTiers,
  productVariants,
  products,
} from "../db/schema/products.ts";
import { vendors } from "../db/schema/vendors.ts";
import { db } from "../lib/db.ts";

export type ProductErrorCode =
  | "CATEGORY_NOT_FOUND"
  | "CATEGORY_CYCLE"
  | "PRODUCT_NOT_FOUND"
  | "VARIANT_NOT_FOUND"
  | "NO_VARIANTS"
  | "LAST_VARIANT"
  | "SKU_TAKEN"
  | "INVALID_INPUT";

export class ProductError extends Error {
  constructor(public code: ProductErrorCode, message?: string) {
    super(message ?? code);
    this.name = "ProductError";
  }
}

type Category = typeof productCategories.$inferSelect;
type Product = typeof products.$inferSelect;
type Variant = typeof productVariants.$inferSelect;

export interface ProductWithVariants extends Product {
  variants: Variant[];
}

/** `SKU-` + a short random suffix. Unique by construction; DB enforces it. */
function generateSku(): string {
  return `SKU-${ulid().slice(-10)}`;
}

function assertNonNegative(label: string, value: number | undefined): void {
  if (value != null && value < 0) {
    throw new ProductError("INVALID_INPUT", `${label} must not be negative`);
  }
}

/** Ensure a vendor exists when a `primaryVendorId` is supplied. */
async function assertVendorExists(vendorId: string | null | undefined): Promise<void> {
  if (!vendorId) return;
  const row = await db.query.vendors.findFirst({ where: eq(vendors.id, vendorId) });
  if (!row) throw new ProductError("INVALID_INPUT", "primaryVendorId not found");
}

// --- Categories ---

export function listCategories(): Promise<Category[]> {
  return db.select().from(productCategories);
}

async function loadCategory(id: string): Promise<Category> {
  const row = await db.query.productCategories.findFirst({
    where: eq(productCategories.id, id),
  });
  if (!row) throw new ProductError("CATEGORY_NOT_FOUND");
  return row;
}

/** Walk the parent chain; throw if making `parentId` the parent of `id` loops. */
async function assertNoCategoryCycle(id: string, parentId: string): Promise<void> {
  let cursor: string | null = parentId;
  while (cursor) {
    if (cursor === id) throw new ProductError("CATEGORY_CYCLE");
    const parent: Category = await loadCategory(cursor);
    cursor = parent.parentId;
  }
}

export async function createCategory(input: {
  name: string;
  parentId?: string | null;
  minQty?: number | null;
  minMarginBps?: number | null;
}): Promise<Category> {
  if (input.parentId) await loadCategory(input.parentId);
  const id = ulid();
  await db.insert(productCategories).values({
    id,
    name: input.name,
    parentId: input.parentId ?? null,
    minQty: input.minQty ?? null,
    minMarginBps: input.minMarginBps ?? null,
  });
  return loadCategory(id);
}

export async function updateCategory(
  id: string,
  patch: {
    name?: string;
    parentId?: string | null;
    minQty?: number | null;
    minMarginBps?: number | null;
  },
): Promise<Category> {
  await loadCategory(id);
  if (patch.parentId) await assertNoCategoryCycle(id, patch.parentId);

  await db
    .update(productCategories)
    .set({
      ...(patch.name !== undefined && { name: patch.name }),
      ...(patch.parentId !== undefined && { parentId: patch.parentId }),
      ...(patch.minQty !== undefined && { minQty: patch.minQty }),
      ...(patch.minMarginBps !== undefined && { minMarginBps: patch.minMarginBps }),
    })
    .where(eq(productCategories.id, id));
  return loadCategory(id);
}

export async function setCategoryArchived(id: string, archived: boolean): Promise<Category> {
  await loadCategory(id);
  await db
    .update(productCategories)
    .set({ archivedAt: archived ? new Date() : null })
    .where(eq(productCategories.id, id));
  return loadCategory(id);
}

/** Delete a category. Products and child categories reparent to NULL (FK). */
export async function deleteCategory(id: string): Promise<void> {
  await loadCategory(id);
  await db.delete(productCategories).where(eq(productCategories.id, id));
}

// --- Products & variants ---

export interface VariantInput {
  sku?: string;
  barcode?: string | null;
  label?: string | null;
  unit?: "piece" | "g" | "ml" | "mm";
  qtyDecimals?: number;
  priceMinor: number;
  costMinor?: number;
  sortOrder?: number;
}

async function loadProductRow(id: string): Promise<Product> {
  const row = await db.query.products.findFirst({ where: eq(products.id, id) });
  if (!row) throw new ProductError("PRODUCT_NOT_FOUND");
  return row;
}

async function variantsOf(productId: string): Promise<Variant[]> {
  return db
    .select()
    .from(productVariants)
    .where(eq(productVariants.productId, productId));
}

export async function getProduct(id: string): Promise<ProductWithVariants> {
  const product = await loadProductRow(id);
  return { ...product, variants: await variantsOf(id) };
}

/**
 * List products, optionally filtered by a free-text query (whitespace-split,
 * AND-ed LIKEs against `search_text`) and/or excluding archived rows.
 */
export async function listProducts(opts: {
  search?: string | null;
  includeArchived?: boolean;
} = {}): Promise<Product[]> {
  const filters = [];
  if (!opts.includeArchived) filters.push(isNull(products.archivedAt));

  for (const token of (opts.search ?? "").trim().toLowerCase().split(/\s+/)) {
    if (token) filters.push(like(products.searchText, `%${token}%`));
  }
  return db
    .select()
    .from(products)
    .where(filters.length ? and(...filters) : undefined);
}

function buildVariantRow(productId: string, v: VariantInput) {
  assertNonNegative("priceMinor", v.priceMinor);
  assertNonNegative("costMinor", v.costMinor);
  return {
    id: ulid(),
    productId,
    sku: v.sku?.trim() || generateSku(),
    barcode: v.barcode ?? null,
    label: v.label ?? null,
    unit: v.unit ?? "piece",
    qtyDecimals: v.qtyDecimals ?? 0,
    priceMinor: v.priceMinor,
    costMinor: v.costMinor ?? 0,
    sortOrder: v.sortOrder ?? 0,
  };
}

export async function createProduct(input: {
  name: string;
  publicName?: string | null;
  description?: string | null;
  kind?: "physical" | "service";
  categoryId?: string | null;
  taxRateBps?: number;
  priceMode: "tax_inclusive" | "tax_exclusive";
  minQty?: number | null;
  minMarginBps?: number | null;
  primaryVendorId?: string | null;
  replenishMonitored?: boolean;
  variants: VariantInput[];
  createdByUserId: string;
}): Promise<ProductWithVariants> {
  if (!input.variants?.length) throw new ProductError("NO_VARIANTS");
  if (input.categoryId) await loadCategory(input.categoryId);
  await assertVendorExists(input.primaryVendorId);
  assertNonNegative("taxRateBps", input.taxRateBps);

  const productId = ulid();
  const variantRows = input.variants.map((v) => buildVariantRow(productId, v));

  try {
    await db.transaction(async (tx) => {
      await tx.insert(products).values({
        id: productId,
        name: input.name,
        publicName: input.publicName ?? null,
        description: input.description ?? null,
        kind: input.kind ?? "physical",
        categoryId: input.categoryId ?? null,
        taxRateBps: input.taxRateBps ?? 0,
        priceMode: input.priceMode,
        minQty: input.minQty ?? null,
        minMarginBps: input.minMarginBps ?? null,
        primaryVendorId: input.primaryVendorId ?? null,
        ...(input.replenishMonitored !== undefined && {
          replenishMonitored: input.replenishMonitored,
        }),
        createdByUserId: input.createdByUserId,
      });
      await tx.insert(productVariants).values(variantRows);
    });
  } catch (e) {
    throw translateDbError(e);
  }
  return getProduct(productId);
}

export async function updateProduct(
  id: string,
  patch: {
    name?: string;
    publicName?: string | null;
    description?: string | null;
    kind?: "physical" | "service";
    categoryId?: string | null;
    taxRateBps?: number;
    priceMode?: "tax_inclusive" | "tax_exclusive";
    minQty?: number | null;
    minMarginBps?: number | null;
    primaryVendorId?: string | null;
    replenishMonitored?: boolean;
  },
): Promise<ProductWithVariants> {
  await loadProductRow(id);
  if (patch.categoryId) await loadCategory(patch.categoryId);
  if (patch.primaryVendorId) await assertVendorExists(patch.primaryVendorId);
  assertNonNegative("taxRateBps", patch.taxRateBps);

  await db
    .update(products)
    .set({
      ...(patch.name !== undefined && { name: patch.name }),
      ...(patch.publicName !== undefined && { publicName: patch.publicName }),
      ...(patch.description !== undefined && { description: patch.description }),
      ...(patch.kind !== undefined && { kind: patch.kind }),
      ...(patch.categoryId !== undefined && { categoryId: patch.categoryId }),
      ...(patch.taxRateBps !== undefined && { taxRateBps: patch.taxRateBps }),
      ...(patch.priceMode !== undefined && { priceMode: patch.priceMode }),
      ...(patch.minQty !== undefined && { minQty: patch.minQty }),
      ...(patch.minMarginBps !== undefined && { minMarginBps: patch.minMarginBps }),
      ...(patch.primaryVendorId !== undefined && {
        primaryVendorId: patch.primaryVendorId,
      }),
      ...(patch.replenishMonitored !== undefined && {
        replenishMonitored: patch.replenishMonitored,
      }),
    })
    .where(eq(products.id, id));
  return getProduct(id);
}

export async function setProductArchived(
  id: string,
  archived: boolean,
): Promise<ProductWithVariants> {
  await loadProductRow(id);
  await db
    .update(products)
    .set({ archivedAt: archived ? new Date() : null })
    .where(eq(products.id, id));
  return getProduct(id);
}

/** Hard delete (root-only at the resolver). Variants cascade. */
export async function hardDeleteProduct(id: string): Promise<void> {
  await loadProductRow(id);
  await db.delete(products).where(eq(products.id, id));
}

export async function addVariant(
  productId: string,
  input: VariantInput,
): Promise<Variant> {
  await loadProductRow(productId);
  const row = buildVariantRow(productId, input);
  try {
    await db.insert(productVariants).values(row);
  } catch (e) {
    throw translateDbError(e);
  }
  return loadVariant(row.id);
}

async function loadVariant(id: string): Promise<Variant> {
  const row = await db.query.productVariants.findFirst({
    where: eq(productVariants.id, id),
  });
  if (!row) throw new ProductError("VARIANT_NOT_FOUND");
  return row;
}

export async function updateVariant(
  id: string,
  patch: {
    sku?: string;
    barcode?: string | null;
    label?: string | null;
    unit?: "piece" | "g" | "ml" | "mm";
    qtyDecimals?: number;
    priceMinor?: number;
    costMinor?: number;
    sortOrder?: number;
  },
): Promise<Variant> {
  await loadVariant(id);
  assertNonNegative("priceMinor", patch.priceMinor);
  assertNonNegative("costMinor", patch.costMinor);

  try {
    await db
      .update(productVariants)
      .set({
        ...(patch.sku !== undefined && { sku: patch.sku }),
        ...(patch.barcode !== undefined && { barcode: patch.barcode }),
        ...(patch.label !== undefined && { label: patch.label }),
        ...(patch.unit !== undefined && { unit: patch.unit }),
        ...(patch.qtyDecimals !== undefined && { qtyDecimals: patch.qtyDecimals }),
        ...(patch.priceMinor !== undefined && { priceMinor: patch.priceMinor }),
        ...(patch.costMinor !== undefined && { costMinor: patch.costMinor }),
        ...(patch.sortOrder !== undefined && { sortOrder: patch.sortOrder }),
      })
      .where(eq(productVariants.id, id));
  } catch (e) {
    throw translateDbError(e);
  }
  return loadVariant(id);
}

/** Delete a variant. A product must keep at least one variant. */
export async function deleteVariant(id: string): Promise<void> {
  const variant = await loadVariant(id);
  const siblings = await variantsOf(variant.productId);
  if (siblings.length <= 1) throw new ProductError("LAST_VARIANT");
  await db.delete(productVariants).where(eq(productVariants.id, id));
}

// --- Price tiers ---

type PriceTier = typeof productPriceTiers.$inferSelect;

export async function getPriceTiers(variantId: string): Promise<PriceTier[]> {
  await loadVariant(variantId);
  return db
    .select()
    .from(productPriceTiers)
    .where(eq(productPriceTiers.variantId, variantId));
}

/** Replace a variant's qty-break price tiers wholesale. */
export async function setPriceTiers(
  variantId: string,
  tiers: { minQty: number; priceMinor: number }[],
): Promise<PriceTier[]> {
  await loadVariant(variantId);
  for (const t of tiers) {
    if (t.minQty <= 0) throw new ProductError("INVALID_INPUT", "tier minQty must be positive");
    assertNonNegative("tier priceMinor", t.priceMinor);
  }

  await db.transaction(async (tx) => {
    await tx.delete(productPriceTiers).where(eq(productPriceTiers.variantId, variantId));
    if (tiers.length) {
      await tx
        .insert(productPriceTiers)
        .values(tiers.map((t) => ({ id: ulid(), variantId, ...t })));
    }
  });
  return getPriceTiers(variantId);
}

/** Map a MySQL duplicate-key error on `sku` to a ProductError. */
function translateDbError(e: unknown): Error {
  const msg = e instanceof Error ? e.message : String(e);
  if (/duplicate/i.test(msg) && /sku/i.test(msg)) {
    return new ProductError("SKU_TAKEN");
  }
  return e instanceof Error ? e : new Error(msg);
}
