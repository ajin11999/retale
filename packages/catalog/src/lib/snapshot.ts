// Catalog snapshot types — the shape of the JSON the Retale API publishes to
// Vercel Blob. Kept in sync with `catalog-service.ts` (CatalogSnapshot) in the
// API package; duplicated here so the catalog app deploys self-contained.

export type PriceMode = "exclude" | "peek" | "show";
export type StockMode = "show_real" | "peek" | "hide";

export interface CatalogVariant {
  id: string;
  label: string | null;
  unit: string;
  qtyDecimals: number;
  /** Real price, minor units — present only when priceMode is `show`. */
  priceMinor?: number;
  /** Masked price string — present only when priceMode is `peek`. */
  pricePeek?: string;
  /** Real stock count — present only when stockMode is `show_real`. */
  stockQty?: number;
  /** Fuzzy stock band — present only when stockMode is `peek`. */
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

/** Format a money value: international grouping (comma thousands, dot decimal),
 *  trailing zeros trimmed — matches formatMoney (console) / formatRp (API). */
function formatRp(n: number): string {
  return n.toLocaleString("en-US", { maximumFractionDigits: 2 });
}

/**
 * The price label for a variant, honouring its product's price mode:
 * the real price formatted, the pre-masked peek string, or null (excluded).
 */
export function priceLabel(v: CatalogVariant): string | null {
  if (v.priceMinor !== undefined) return `Rp ${formatRp(v.priceMinor)}`;
  if (v.pricePeek !== undefined) return `Rp ${v.pricePeek}`;
  return null;
}

/** The stock label for a variant, or null when stock is hidden. */
export function stockLabel(v: CatalogVariant): string | null {
  if (v.stockQty !== undefined) {
    return `${v.stockQty} ${v.unit} in stock`;
  }
  if (v.stockPeek !== undefined) return v.stockPeek;
  return null;
}

/** The cheapest known price label across a product's variants, for list cards. */
export function fromPriceLabel(p: CatalogProduct): string | null {
  const shown = p.variants
    .map((v) => v.priceMinor)
    .filter((m): m is number => m !== undefined);
  if (shown.length > 0) {
    return `from Rp ${formatRp(Math.min(...shown))}`;
  }
  // No exact prices — fall back to the first variant's peek label, if any.
  const peek = p.variants.find((v) => v.pricePeek !== undefined);
  return peek ? `Rp ${peek.pricePeek}` : null;
}
