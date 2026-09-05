// Multipart upload route for vendor-catalog ingest — a binary endpoint
// outside GraphQL, same shape as invoice-recognition-route. A
// `multipart/form-data` POST (fields: `vendorId`, `file`) returns a PREVIEW of
// catalog rows plus an `importId`; nothing is persisted until the clerk
// confirms via the `confirmCatalogImport` GraphQL mutation.
//
// Dispatch by file type:
// - CSV / TXT → deterministic local parse (no LLM).
// - XLSX / XLS → first sheet → CSV → same parser (no LLM).
// - PDF → digital text layer → LLM; scanned pages → rasterise → LLM vision.
// - JPG/PNG/WebP → LLM vision (WhatsApp pricelist photos).
// Auth reuses the GraphQL stack (vendor.catalog.import).

import { Elysia } from "elysia";
import { GraphQLError } from "graphql";
import sharp from "sharp";
import { requirePermission } from "../lib/authz.ts";
import { buildContext } from "../lib/context.ts";
import {
  CatalogExtractError,
  extractCatalogFromImages,
  extractCatalogFromText,
} from "../services/catalog-extract-service.ts";
import {
  buildCatalogPreview,
  CatalogImportError,
  createCatalogImport,
  markCatalogImport,
  parseCatalogCsv,
  parseCatalogWorkbook,
  type IncomingCatalogRow,
} from "../services/catalog-import-service.ts";
import { getVendor, VendorError } from "../services/vendor-service.ts";

/** Largest catalog upload we accept. */
const MAX_BYTES = 15 * 1024 * 1024;
const MAX_PDF_PAGES = 10;
const MIN_TEXT_CHARS = 200;

function statusForCatalog(code: string): number {
  switch (code) {
    case "VENDOR_NOT_FOUND":
      return 404;
    case "INVALID_INPUT":
      return 400;
    case "UNSUPPORTED_TYPE":
      return 415;
    case "NOT_CONFIGURED":
      return 501;
    case "LLM_UNREACHABLE":
      return 503;
    case "LLM_REJECTED":
      return 502;
    case "PROCESSING_FAILED":
      return 422;
    default:
      return 500;
  }
}

function extOf(filename: string): string {
  const i = filename.toLowerCase().lastIndexOf(".");
  return i >= 0 ? filename.toLowerCase().slice(i) : "";
}

async function pdfToLlmInput(
  data: Uint8Array,
): Promise<{ text: string } | { images: { dataBase64: string; mediaType: string }[] }> {
  let pdfjs: any;
  try {
    pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  } catch (e) {
    throw new CatalogExtractError("PROCESSING_FAILED", `pdf engine unavailable: ${(e as Error).message}`);
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
    throw new CatalogImportError("INVALID_INPUT", `not a readable PDF: ${(e as Error).message}`);
  }
  const pageCount = Math.min(doc.numPages, MAX_PDF_PAGES);
  let text = "";
  const images: { dataBase64: string; mediaType: string }[] = [];
  const { createCanvas } = await import("@napi-rs/canvas");
  for (let n = 1; n <= pageCount; n++) {
    const page = await doc.getPage(n);
    const tc = await page.getTextContent();
    const pageText = (tc.items as { str?: string }[]).map((it) => it.str ?? "").join(" ");
    if (pageText.trim().length >= 40) {
      text += `\n--- page ${n} ---\n${pageText}`;
    } else {
      try {
        const viewport = page.getViewport({ scale: 2 });
        const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
        const context = canvas.getContext("2d");
        await page.render({ canvasContext: context as any, viewport }).promise;
        const png: Buffer = canvas.toBuffer("image/png");
        const small = await sharp(png).resize({ width: 1600, withoutEnlargement: true }).jpeg({ quality: 80 }).toBuffer();
        images.push({ dataBase64: small.toString("base64"), mediaType: "image/jpeg" });
      } catch (e) {
        console.warn(`[catalog-import] could not rasterise PDF page ${n}: ${(e as Error).message}`);
      }
    }
  }
  if (text.trim().length >= MIN_TEXT_CHARS) return { text };
  if (images.length > 0) return { images };
  throw new CatalogExtractError("PROCESSING_FAILED", "PDF yielded no readable text or pages.");
}

async function imageToLlmInput(
  data: Uint8Array,
  mediaType: string,
): Promise<{ dataBase64: string; mediaType: string }> {
  try {
    const small = await sharp(data)
      .resize({ width: 2000, withoutEnlargement: true })
      .jpeg({ quality: 82 })
      .toBuffer();
    return { dataBase64: small.toString("base64"), mediaType: "image/jpeg" };
  } catch {
    // Not actually an image sharp understands — send raw and let it fail cleanly.
    return { dataBase64: Buffer.from(data).toString("base64"), mediaType: mediaType || "image/jpeg" };
  }
}

export const catalogImportRoute = new Elysia().post(
  "/catalog-imports",
  async ({ body, request, set }) => {
    const ctx = await buildContext({ request });
    try {
      await requirePermission(ctx, "vendor.catalog.import");
    } catch (e) {
      const code = e instanceof GraphQLError ? e.extensions?.code : undefined;
      set.status = code === "UNAUTHENTICATED" ? 401 : 403;
      return { error: e instanceof Error ? e.message : "forbidden" };
    }

    const { vendorId, file } = (body ?? {}) as { vendorId?: unknown; file?: unknown };
    if (typeof vendorId !== "string" || !vendorId.trim()) {
      set.status = 400;
      return { error: "vendorId is required" };
    }
    if (!(file instanceof File)) {
      set.status = 400;
      return { error: "a multipart 'file' is required" };
    }
    if (file.size > MAX_BYTES) {
      set.status = 413;
      return { error: "file too large (max 15MB)" };
    }

    try {
      await getVendor(vendorId);
    } catch (e) {
      const code = e instanceof VendorError ? e.code : "VENDOR_NOT_FOUND";
      set.status = statusForCatalog(code);
      return { error: e instanceof Error ? e.message : code, code };
    }

    const data = new Uint8Array(await file.arrayBuffer());
    const filename = file.name || "upload";
    const ext = extOf(filename);
    const importId = await createCatalogImport(
      vendorId,
      filename,
      ctx.viewer?.userId,
    );

    try {
      let incoming: IncomingCatalogRow[];
      let modelUsed = "csv";
      let tokenUsage: unknown = null;

      if (ext === ".csv" || ext === ".txt" || file.type === "text/csv") {
        incoming = parseCatalogCsv(Buffer.from(data).toString("utf-8"));
      } else if (ext === ".xlsx" || ext === ".xls") {
        incoming = parseCatalogWorkbook(data, filename);
        modelUsed = "xlsx";
      } else if (
        ext === ".pdf" ||
        file.type === "application/pdf" ||
        ext === ".jpg" ||
        ext === ".jpeg" ||
        ext === ".png" ||
        ext === ".webp" ||
        file.type.startsWith("image/")
      ) {
        let extracted: { rows: IncomingCatalogRow[]; modelUsed: string; tokenUsage: unknown };
        if (ext === ".pdf" || file.type === "application/pdf") {
          const input = await pdfToLlmInput(data);
          extracted = "text" in input
            ? await extractCatalogFromText(input.text)
            : await extractCatalogFromImages(input.images);
        } else {
          extracted = await extractCatalogFromImages([
            await imageToLlmInput(data, file.type),
          ]);
        }
        incoming = extracted.rows;
        modelUsed = extracted.modelUsed;
        tokenUsage = extracted.tokenUsage;
      } else {
        throw new CatalogImportError(
          "UNSUPPORTED_TYPE",
          `unsupported file type "${ext || file.type}". Upload CSV, XLSX, PDF, or an image (JPG/PNG/WebP).`,
        );
      }

      const rows = await buildCatalogPreview(vendorId, incoming);
      await markCatalogImport(importId, { status: "ready", rowCount: rows.length, modelUsed, tokenUsage });
      return { importId, source: modelUsed, rows };
    } catch (e) {
      const code =
        e instanceof CatalogExtractError || e instanceof CatalogImportError ? e.code : "PROCESSING_FAILED";
      await markCatalogImport(importId, {
        status: "failed",
        errorCode: code,
        errorMessage: e instanceof Error ? e.message.slice(0, 1000) : String(e),
      });
      set.status = statusForCatalog(code);
      return { error: e instanceof Error ? e.message : code, code, importId };
    }
  },
);
