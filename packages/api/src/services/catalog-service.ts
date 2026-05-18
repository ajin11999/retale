// Online catalog service: the local side of the catalog feature. Three jobs —
// (1) edit a product's catalog settings (visibility + price/stock display
// modes), (2) build a snapshot: a self-contained JSON of the visible catalog
// with prices and stock already masked so raw values never leave the local
// network, and (3) publish: push that snapshot to the catalog's storage and
// log the attempt. The catalog app reads only the snapshot — see
// docs/future-features.md → "Online catalog website".

import { put } from "@vercel/blob";
import { and, desc, eq, inArray, isNull } from "drizzle-orm";
import { ulid } from "ulid";
import { catalogPublishes } from "../db/schema/catalog.ts";
import {
  type ONLINE_PRICE_MODES,
  type ONLINE_STOCK_MODES,
  productCategories,
  productImages,
  products,
  productVariants,
} from "../db/schema/products.ts";
import { db } from "../lib/db.ts";

export type CatalogErrorCode =
  | "PRODUCT_NOT_FOUND"
  | "INVALID_INPUT"
  | "NOT_CONFIGURED"
  | "UPLOAD_FAILED";

export class CatalogError extends Error {
  constructor(
    public code: CatalogErrorCode,
    message?: string,
  ) {
    super(message ?? code);
    this.name = "CatalogError";
  }
}

type PriceMode = (typeof ONLINE_PRICE_MODES)[number];
type StockMode = (typeof ONLINE_STOCK_MODES)[number];
type Product = typeof products.$inferSelect;
type CatalogPublish = typeof catalogPublishes.$inferSelect;

// --- Settings ---

async function loadProduct(id: string): Promise<Product> {
  const row = await db.query.products.findFirst({ where: eq(products.id, id) });
  if (!row) throw new CatalogError("PRODUCT_NOT_FOUND");
  return row;
}

/** Edit one product's catalog settings. Any subset of the three fields. */
export async function setProductCatalogSettings(
  id: string,
  patch: {
    onlineVisible?: boolean;
    onlinePriceMode?: PriceMode;
    onlineStockMode?: StockMode;
  },
): Promise<Product> {
  await loadProduct(id);
  await db
    .update(products)
    .set({
      ...(patch.onlineVisible !== undefined && { onlineVisible: patch.onlineVisible }),
      ...(patch.onlinePriceMode !== undefined && {
        onlinePriceMode: patch.onlinePriceMode,
      }),
      ...(patch.onlineStockMode !== undefined && {
        onlineStockMode: patch.onlineStockMode,
      }),
    })
    .where(eq(products.id, id));
  return loadProduct(id);
}

/**
 * Bulk show/hide — for the catalog-management view, where toggling products
 * one at a time is too slow. Returns the number of products updated.
 */
export async function setProductsOnlineVisible(
  ids: string[],
  visible: boolean,
): Promise<number> {
  if (ids.length === 0) return 0;
  await db
    .update(products)
    .set({ onlineVisible: visible })
    .where(inArray(products.id, ids));
  return ids.length;
}

// --- Masking ---

/** Insert "." every three characters from the right (thousands grouping). */
function groupThousands(s: string): string {
  return s.replace(/\B(?=(.{3})+(?!.))/g, ".");
}

/**
 * Mask a price to its order of magnitude: keep the leading digit, hide the
 * rest, keep thousands grouping — e.g. 250000 → "2xx.xxx". The catalog adds
 * the currency prefix.
 */
export function maskPricePeek(minor: number): string {
  const s = Math.max(0, Math.trunc(minor)).toString();
  const masked = s[0] + "x".repeat(s.length - 1);
  return groupThousands(masked);
}

/** Fuzz a stock count into a band — never the exact number. */
export function maskStockPeek(qty: number): string {
  if (qty <= 0) return "potentially sold out";
  if (qty < 10) return "< 10";
  if (qty < 50) return "< 50";
  return "50+";
}

// --- Snapshot ---

export interface CatalogVariant {
  id: string;
  label: string | null;
  unit: string;
  qtyDecimals: number;
  /** Real price, minor units — only when the product's priceMode is `show`. */
  priceMinor?: number;
  /** Masked price string — only when priceMode is `peek`. */
  pricePeek?: string;
  /** Real stock count — only when the product's stockMode is `show_real`. */
  stockQty?: number;
  /** Fuzzy stock band — only when stockMode is `peek`. */
  stockPeek?: string;
}

export interface CatalogImage {
  thumbnailUrl: string;
  detailUrl: string;
  width: number;
  height: number;
}

export interface CatalogProduct {
  id: string;
  name: string;
  description: string | null;
  categoryId: string | null;
  kind: string;
  priceMode: PriceMode;
  stockMode: StockMode;
  variants: CatalogVariant[];
  /** Gallery images, ordered; the first is the card thumbnail. */
  images: CatalogImage[];
}

export interface CatalogCategory {
  id: string;
  name: string;
  parentId: string | null;
}

export interface CatalogSnapshot {
  version: string;
  generatedAt: string;
  categories: CatalogCategory[];
  products: CatalogProduct[];
}

/** Render one variant under a product's price / stock display modes. */
function renderVariant(
  v: typeof productVariants.$inferSelect,
  priceMode: PriceMode,
  stockMode: StockMode,
): CatalogVariant {
  const out: CatalogVariant = {
    id: v.id,
    label: v.label,
    unit: v.unit,
    qtyDecimals: v.qtyDecimals,
  };
  if (priceMode === "show") out.priceMinor = v.priceMinor;
  else if (priceMode === "peek") out.pricePeek = maskPricePeek(v.priceMinor);
  if (stockMode === "show_real") out.stockQty = v.totalQty;
  else if (stockMode === "peek") out.stockPeek = maskStockPeek(v.totalQty);
  return out;
}

/**
 * Build the catalog snapshot: every `onlineVisible`, non-archived product
 * with its variants, prices and stock already masked per each product's
 * modes. Raw cost / exact qty for masked products never enter the result.
 */
export async function buildCatalogSnapshot(): Promise<CatalogSnapshot> {
  const visible = await db
    .select()
    .from(products)
    .where(and(eq(products.onlineVisible, true), isNull(products.archivedAt)));

  const productIds = visible.map((p) => p.id);
  const variants = productIds.length
    ? await db
        .select()
        .from(productVariants)
        .where(inArray(productVariants.productId, productIds))
        .orderBy(productVariants.sortOrder)
    : [];
  const variantsByProduct = new Map<string, (typeof variants)[number][]>();
  for (const v of variants) {
    const list = variantsByProduct.get(v.productId) ?? [];
    list.push(v);
    variantsByProduct.set(v.productId, list);
  }

  const imageRows = productIds.length
    ? await db
        .select()
        .from(productImages)
        .where(inArray(productImages.productId, productIds))
        .orderBy(productImages.sortOrder)
    : [];
  const imagesByProduct = new Map<string, CatalogImage[]>();
  for (const im of imageRows) {
    const list = imagesByProduct.get(im.productId) ?? [];
    list.push({
      thumbnailUrl: im.thumbnailUrl,
      detailUrl: im.detailUrl,
      width: im.width,
      height: im.height,
    });
    imagesByProduct.set(im.productId, list);
  }

  const categories = await db
    .select({
      id: productCategories.id,
      name: productCategories.name,
      parentId: productCategories.parentId,
    })
    .from(productCategories)
    .where(isNull(productCategories.archivedAt));

  const catalogProducts: CatalogProduct[] = visible.map((p) => ({
    id: p.id,
    name: p.publicName?.trim() || p.name,
    description: p.description,
    categoryId: p.categoryId,
    kind: p.kind,
    priceMode: p.onlinePriceMode,
    stockMode: p.onlineStockMode,
    variants: (variantsByProduct.get(p.id) ?? []).map((v) =>
      renderVariant(v, p.onlinePriceMode, p.onlineStockMode),
    ),
    images: imagesByProduct.get(p.id) ?? [],
  }));

  return {
    version: ulid(),
    generatedAt: new Date().toISOString(),
    categories,
    products: catalogProducts,
  };
}

// --- Publish ---

/** The fixed Vercel Blob key the snapshot is written to (overwritten each publish). */
const SNAPSHOT_BLOB_KEY = "catalog/snapshot.json";

/**
 * Push a built snapshot to Vercel Blob — the catalog app reads it from there.
 * Configured by `BLOB_READ_WRITE_TOKEN`. The snapshot is written to one fixed
 * public key, overwritten on every publish; each `put` is atomic, so a reader
 * gets either the whole new snapshot or the previous one, never a partial.
 * A short cache TTL keeps the live catalog fresh after a publish.
 */
async function pushSnapshot(snapshot: CatalogSnapshot): Promise<void> {
  const token = process.env.BLOB_READ_WRITE_TOKEN;
  if (!token) {
    throw new CatalogError(
      "NOT_CONFIGURED",
      "BLOB_READ_WRITE_TOKEN is not set — cannot publish",
    );
  }
  try {
    await put(SNAPSHOT_BLOB_KEY, JSON.stringify(snapshot), {
      access: "public",
      token,
      contentType: "application/json",
      addRandomSuffix: false,
      allowOverwrite: true,
      cacheControlMaxAge: 60,
    });
  } catch (e) {
    throw new CatalogError(
      "UPLOAD_FAILED",
      `snapshot push to blob failed: ${(e as Error).message}`,
    );
  }
}

/**
 * Publish the catalog: build a snapshot, push it, and log the attempt to
 * `catalog_publishes` either way. A failed push still records an `error`
 * row, then rethrows so the caller surfaces it. `userId` is null for the
 * scheduled job — it runs as the system.
 */
export async function publishCatalog(
  trigger: (typeof catalogPublishes.$inferSelect)["trigger"],
  userId: string | null,
): Promise<CatalogPublish> {
  const snapshot = await buildCatalogSnapshot();
  const id = ulid();

  try {
    await pushSnapshot(snapshot);
  } catch (e) {
    await db.insert(catalogPublishes).values({
      id,
      trigger,
      status: "error",
      productCount: snapshot.products.length,
      snapshotVersion: snapshot.version,
      errorMessage: e instanceof Error ? e.message : String(e),
      publishedByUserId: userId,
    });
    throw e;
  }

  await db.insert(catalogPublishes).values({
    id,
    trigger,
    status: "success",
    productCount: snapshot.products.length,
    snapshotVersion: snapshot.version,
    publishedByUserId: userId,
  });
  return loadPublish(id);
}

async function loadPublish(id: string): Promise<CatalogPublish> {
  const row = await db.query.catalogPublishes.findFirst({
    where: eq(catalogPublishes.id, id),
  });
  return row as CatalogPublish;
}

/** Publish history, newest first — for the admin "catalog last went live" view. */
export function listCatalogPublishes(limit = 50): Promise<CatalogPublish[]> {
  return db
    .select()
    .from(catalogPublishes)
    .orderBy(desc(catalogPublishes.createdAt))
    .limit(limit);
}
