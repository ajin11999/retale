// Offline invoice recognition — NO cloud, NO AI. A vendor invoice (image or
// PDF) is read locally and turned into a preview list of purchase lines for the
// console's confirm-and-fix modal. Engine: open-source Tesseract via
// tesseract.js (WASM, bundled traineddata) for photos / scans, and pdfjs-dist
// for digital-PDF text. The pure line parsing + the id-ID money handling live in
// invoice-parse.ts; this module is the I/O + DB-matching shell around it.
//
// Nothing here is persisted: the route returns the preview, the clerk confirms /
// fixes it, and the existing createPurchaseItems mutation does the actual insert.

import { access } from "node:fs/promises";
import path from "node:path";
import { and, eq, isNull } from "drizzle-orm";
import sharp from "sharp";
import { createWorker, OEM, PSM, type Worker } from "tesseract.js";
import { products, productVariants } from "../db/schema/products.ts";
import { vendorVariantCodes } from "../db/schema/vendor-variant-codes.ts";
import { db } from "../lib/db.ts";
import { type OcrWord, type ParsedLine, parseInvoiceWords } from "./invoice-parse.ts";
import * as purchases from "./purchase-service.ts";

export type InvoiceErrorCode =
  | "PURCHASE_NOT_FOUND"
  | "INVALID_INPUT"
  | "UNSUPPORTED_TYPE"
  | "NOT_CONFIGURED"
  | "PROCESSING_FAILED";

export class InvoiceError extends Error {
  constructor(
    public code: InvoiceErrorCode,
    message?: string,
  ) {
    super(message ?? code);
    this.name = "InvoiceError";
  }
}

/** One preview line: the parsed fields plus any offline variant match. */
export interface RecognizedLine extends ParsedLine {
  /** Resolved product variant when matched (vendor code / SKU / name), else null. */
  variantId: string | null;
  /** Display label for the matched variant ("Product · SKU"), else null. */
  variantLabel: string | null;
}

// --- OCR engine (bundled, offline) -----------------------------------------

const TESSDATA_DIR = process.env.TESSDATA_PREFIX
  ? path.resolve(process.env.TESSDATA_PREFIX)
  : path.join(import.meta.dir, "..", "..", "assets", "tessdata");
const OCR_LANGS = process.env.OCR_LANGS ?? "eng";
const MAX_PDF_PAGES = 10;
// A page yielding fewer text-layer words than this is treated as image-only.
const MIN_TEXT_WORDS = 8;

async function exists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

// One reused worker — init is slow (~1s) and recognize is sequential anyway.
let workerPromise: Promise<Worker> | null = null;
function getWorker(): Promise<Worker> {
  if (!workerPromise) {
    workerPromise = (async () => {
      const firstLang = OCR_LANGS.split("+")[0] ?? "eng";
      const dataFile = path.join(TESSDATA_DIR, `${firstLang}.traineddata`);
      if (!(await exists(dataFile))) {
        throw new InvoiceError(
          "NOT_CONFIGURED",
          `OCR language data not found at ${dataFile}. Bundle ${firstLang}.traineddata under packages/api/assets/tessdata or set TESSDATA_PREFIX.`,
        );
      }
      // Local langPath + raw (non-gz) data + no cache writes ⇒ never hits a CDN.
      const worker = await createWorker(OCR_LANGS, OEM.LSTM_ONLY, {
        langPath: TESSDATA_DIR,
        gzip: false,
        cacheMethod: "none",
      });
      await worker.setParameters({ tessedit_pageseg_mode: PSM.AUTO });
      return worker;
    })().catch((e) => {
      workerPromise = null; // let a later request retry a failed init
      throw e;
    });
  }
  return workerPromise;
}

/** Flatten a tesseract.js recognize result into positioned words. */
async function ocrToWords(png: Buffer): Promise<OcrWord[]> {
  const worker = await getWorker();
  const { data } = await worker.recognize(png, {}, { blocks: true });
  const words: OcrWord[] = [];
  // The block→paragraph→line→word tree is loosely typed; walk it defensively.
  for (const block of (data.blocks ?? []) as any[])
    for (const para of block.paragraphs ?? [])
      for (const line of para.lines ?? [])
        for (const wd of line.words ?? []) {
          const b = wd.bbox ?? {};
          if (typeof wd.text !== "string") continue;
          words.push({
            text: wd.text,
            confidence: typeof wd.confidence === "number" ? wd.confidence : 0,
            bbox: { x0: b.x0 ?? 0, y0: b.y0 ?? 0, x1: b.x1 ?? 0, y1: b.y1 ?? 0 },
          });
        }
  return words;
}

/** Orient, grayscale, normalise, and upscale small images for better OCR. */
async function preprocessImage(data: Uint8Array): Promise<Buffer> {
  const meta = await sharp(data, { failOn: "none" }).metadata();
  let pipeline = sharp(data, { failOn: "none" }).rotate().grayscale().normalize();
  if ((meta.width ?? 0) < 1200) pipeline = pipeline.resize({ width: 1600 });
  return pipeline.png().toBuffer();
}

async function imageToLines(data: Uint8Array): Promise<ParsedLine[]> {
  let png: Buffer;
  try {
    png = await preprocessImage(data);
  } catch (e) {
    throw new InvoiceError("INVALID_INPUT", `not a readable image: ${(e as Error).message}`);
  }
  return parseInvoiceWords(await ocrToWords(png));
}

// --- PDF (digital text first, OCR fallback for scanned pages) ----------------

/** Convert one pdf.js page's text items into positioned words (top-left origin). */
async function pageTextWords(page: any): Promise<OcrWord[]> {
  const content = await page.getTextContent();
  const viewport = page.getViewport({ scale: 1 });
  const words: OcrWord[] = [];
  for (const item of content.items as any[]) {
    const str: string = (item.str ?? "").trim();
    if (!str) continue;
    const tx = item.transform ?? [1, 0, 0, 1, 0, 0];
    const x = tx[4] ?? 0;
    const yPdf = tx[5] ?? 0;
    const h = item.height ?? Math.abs(tx[3] ?? 10) ?? 10;
    const w = item.width ?? str.length * h * 0.5;
    const yTop = viewport.height - yPdf - h; // PDF origin is bottom-left
    // A text item can be a whole line; split into words, approximating each x.
    const parts = str.split(/\s+/).filter(Boolean);
    let cursor = 0;
    for (const part of parts) {
      const startFrac = str.length ? cursor / str.length : 0;
      const widthFrac = str.length ? part.length / str.length : 1;
      words.push({
        text: part,
        confidence: 100,
        bbox: { x0: x + w * startFrac, y0: yTop, x1: x + w * (startFrac + widthFrac), y1: yTop + h },
      });
      cursor += part.length + 1;
    }
  }
  return words;
}

/** Rasterise a page to PNG (for scanned/image-only pages). Best-effort. */
async function pageToPng(page: any): Promise<Buffer> {
  const { createCanvas } = await import("@napi-rs/canvas");
  const viewport = page.getViewport({ scale: 2 });
  const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
  const context = canvas.getContext("2d");
  await page.render({ canvasContext: context as any, viewport }).promise;
  return canvas.toBuffer("image/png");
}

async function pdfToLines(data: Uint8Array): Promise<ParsedLine[]> {
  let pdfjs: any;
  try {
    pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  } catch (e) {
    throw new InvoiceError("PROCESSING_FAILED", `pdf engine unavailable: ${(e as Error).message}`);
  }
  let doc: any;
  try {
    doc = await pdfjs.getDocument({
      data: new Uint8Array(data),
      isEvalSupported: false,
      useSystemFonts: true,
      disableFontFace: true,
    }).promise;
  } catch (e) {
    throw new InvoiceError("INVALID_INPUT", `not a readable PDF: ${(e as Error).message}`);
  }

  const lines: ParsedLine[] = [];
  const pageCount = Math.min(doc.numPages, MAX_PDF_PAGES);
  for (let n = 1; n <= pageCount; n++) {
    const page = await doc.getPage(n);
    const textWords = await pageTextWords(page);
    if (textWords.length >= MIN_TEXT_WORDS) {
      lines.push(...parseInvoiceWords(textWords)); // digital page: exact text layer
    } else {
      // Scanned / image-only page: rasterise then OCR. Degrade gracefully —
      // a page that won't render just contributes no lines.
      try {
        lines.push(...parseInvoiceWords(await ocrToWords(await pageToPng(page))));
      } catch (e) {
        console.warn(`[invoice] could not OCR PDF page ${n}: ${(e as Error).message}`);
      }
    }
  }
  return lines;
}

// --- Offline variant matching ----------------------------------------------

const norm = (s: string) => s.toUpperCase().replace(/[^A-Z0-9]/g, "");

interface VariantRef {
  variantId: string;
  label: string;
}

/**
 * Build a matcher closure over the catalog + (when the PO has a vendor) that
 * vendor's part-number codes. Tries vendor code, then SKU, then barcode, then a
 * conservative product-name substring — all exact/offline, no fuzzy AI.
 */
async function buildMatcher(vendorId: string | null): Promise<(line: ParsedLine) => VariantRef | null> {
  const rows = await db
    .select({
      variantId: productVariants.id,
      sku: productVariants.sku,
      barcode: productVariants.barcode,
      label: productVariants.label,
      productName: products.name,
    })
    .from(productVariants)
    .innerJoin(products, eq(productVariants.productId, products.id))
    .where(and(isNull(products.archivedAt)));

  const labelOf = (r: { productName: string; sku: string; label: string | null }) =>
    `${r.productName} · ${r.sku}${r.label ? ` · ${r.label}` : ""}`;

  const skuMap = new Map<string, VariantRef>();
  const barcodeMap = new Map<string, VariantRef>();
  const nameList: Array<{ nameNorm: string; ref: VariantRef }> = [];
  for (const r of rows) {
    const ref: VariantRef = { variantId: r.variantId, label: labelOf(r) };
    skuMap.set(norm(r.sku), ref);
    if (r.barcode) barcodeMap.set(norm(r.barcode), ref);
    const nameNorm = norm(r.productName);
    if (nameNorm.length >= 4) nameList.push({ nameNorm, ref });
  }

  const vendorCodeMap = new Map<string, VariantRef>();
  if (vendorId) {
    const codes = await db
      .select({ code: vendorVariantCodes.code, variantId: vendorVariantCodes.variantId })
      .from(vendorVariantCodes)
      .where(eq(vendorVariantCodes.vendorId, vendorId));
    const byVariant = new Map(rows.map((r) => [r.variantId, { variantId: r.variantId, label: labelOf(r) }]));
    for (const c of codes) {
      const ref = byVariant.get(c.variantId);
      if (ref) vendorCodeMap.set(norm(c.code), ref);
    }
  }

  return (line: ParsedLine): VariantRef | null => {
    if (!line.description) return null;
    const tokens = line.description.split(/\s+/).map(norm).filter((t) => t.length >= 3);
    for (const t of tokens) {
      const v = vendorCodeMap.get(t);
      if (v) return v;
    }
    for (const t of tokens) {
      const v = skuMap.get(t);
      if (v) return v;
    }
    for (const t of tokens) {
      const v = barcodeMap.get(t);
      if (v) return v;
    }
    const descNorm = norm(line.description);
    for (const { nameNorm, ref } of nameList) {
      if (descNorm.includes(nameNorm)) return ref;
    }
    return null;
  };
}

// --- Entry point ------------------------------------------------------------

function detectKind(mediaType: string, filename?: string): "pdf" | "image" | "unknown" {
  const mt = (mediaType ?? "").toLowerCase();
  if (mt.includes("pdf")) return "pdf";
  if (mt.startsWith("image/")) return "image";
  const name = (filename ?? "").toLowerCase();
  if (name.endsWith(".pdf")) return "pdf";
  if (/\.(png|jpe?g|webp|gif|bmp|tiff?)$/.test(name)) return "image";
  return "unknown";
}

/**
 * Read an uploaded invoice into a preview of purchase lines. Each line carries a
 * `recognized` flag (false → the console shows a blank "fill manually" row) and,
 * when matched, a `variantId` to prefill. Nothing is persisted.
 */
export async function recognizeInvoice(input: {
  purchaseId: string;
  data: Uint8Array;
  mediaType: string;
  filename?: string;
}): Promise<RecognizedLine[]> {
  if (!input.data || input.data.byteLength === 0) {
    throw new InvoiceError("INVALID_INPUT", "the uploaded file is empty");
  }

  let purchase: Awaited<ReturnType<typeof purchases.getPurchase>>;
  try {
    purchase = await purchases.getPurchase(input.purchaseId);
  } catch {
    throw new InvoiceError("PURCHASE_NOT_FOUND", "purchase not found");
  }

  const kind = detectKind(input.mediaType, input.filename);
  let lines: ParsedLine[];
  if (kind === "pdf") lines = await pdfToLines(input.data);
  else if (kind === "image") lines = await imageToLines(input.data);
  else throw new InvoiceError("UNSUPPORTED_TYPE", "upload an image or a PDF");

  const matcher = await buildMatcher(purchase.vendorId);
  return lines.map((line) => {
    const match = line.recognized ? matcher(line) : null;
    return { ...line, variantId: match?.variantId ?? null, variantLabel: match?.label ?? null };
  });
}
