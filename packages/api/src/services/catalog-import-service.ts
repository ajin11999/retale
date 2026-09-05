// Vendor-catalog import service: deterministic CSV/XLSX parsing plus the
// preview → confirm cycle shared by every ingest path (CSV, spreadsheet, and
// the LLM extraction in catalog-extract-service).
//
// Nothing here writes catalog rows until `confirmCatalogImport` runs with the
// clerk's accepted rows. Re-import rule (product decision): rows matching an
// existing item on (vendor, lower(code)) — or name-exact — propose a PRICE
// UPDATE (old → new, history appended on confirm); unmatched rows are NEW and
// need explicit clerk Accept.

import { eq } from "drizzle-orm";
import { ulid } from "ulid";
import * as XLSX from "xlsx";
import {
  vendorCatalogImports,
  vendorCatalogItems,
  vendorCatalogPrices,
} from "../db/schema/vendor-catalog.ts";
import { db } from "../lib/db.ts";
import { isMoney, roundMoney } from "../lib/money.ts";
import {
  findCatalogMatch,
  VendorCatalogError,
  type VendorCatalogItem,
} from "./vendor-catalog-service.ts";

export type CatalogImportErrorCode = "INVALID_INPUT" | "UNSUPPORTED_TYPE" | "IMPORT_NOT_FOUND";

export class CatalogImportError extends Error {
  constructor(
    public code: CatalogImportErrorCode,
    message?: string,
  ) {
    super(message ?? code);
    this.name = "CatalogImportError";
  }
}

/** One normalized incoming row, before matching. */
export interface IncomingCatalogRow {
  vendorCode: string;
  name: string;
  unitText: string;
  priceMinor: number | null;
  moq: number | null;
  note: string;
}

/** One preview row: the incoming data plus any match against existing rows. */
export interface CatalogPreviewRow extends IncomingCatalogRow {
  key: string;
  matchedItemId: string | null;
  matchedName: string | null;
  oldPriceMinor: number | null;
  /** 'update' when matched, 'create' when new. */
  action: "update" | "create";
}

const MAX_ROWS = 2000;

/** Minimal CSV parser: handles quoted fields, commas, and CRLF. */
export function parseCatalogCsv(text: string): IncomingCatalogRow[] {
  const rows: string[][] = [];
  let field = "";
  let record: string[] = [];
  let quoted = false;
  const push = () => {
    record.push(field);
    field = "";
  };
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          quoted = false;
        }
      } else {
        field += c;
      }
    } else if (c === '"') {
      quoted = true;
    } else if (c === ",") {
      push();
    } else if (c === "\n") {
      push();
      rows.push(record);
      record = [];
    } else if (c === "\r") {
      // skip; \n handles the break
    } else {
      field += c;
    }
  }
  push();
  if (record.length > 1 || record[0]!.trim() !== "") rows.push(record);
  if (rows.length === 0) return [];

  const header = rows[0]!.map((h) => h.trim().toLowerCase());
  const idx = (names: string[]): number => {
    for (const n of names) {
      const i = header.indexOf(n);
      if (i >= 0) return i;
    }
    return -1;
  };
  // Headerless fallback: assume code,name,unit,price,moq,note column order.
  const hasHeader = header.some((h) =>
    ["code", "vendorcode", "vendor_code", "sku", "name", "price", "harga"].includes(h),
  );
  const data = hasHeader ? rows.slice(1) : rows;
  const ci = hasHeader ? idx(["code", "vendorcode", "vendor_code", "sku", "part"]) : 0;
  const ni = hasHeader ? idx(["name", "nama", "product", "item", "description"]) : 1;
  const ui = hasHeader ? idx(["unit", "unittext", "uom", "satuan"]) : 2;
  const pi = hasHeader ? idx(["price", "priceminor", "harga", "cost"]) : 3;
  const mi = hasHeader ? idx(["moq", "min", "minimum"]) : 4;
  const ti = hasHeader ? idx(["note", "notes", "remark", "keterangan"]) : 5;

  return data
    .map((cols) => normalizeIncoming({
      vendorCode: ci >= 0 ? (cols[ci] ?? "") : "",
      name: ni >= 0 ? (cols[ni] ?? "") : "",
      unitText: ui >= 0 ? (cols[ui] ?? "") : "",
      price: pi >= 0 ? (cols[pi] ?? "") : "",
      moq: mi >= 0 ? (cols[mi] ?? "") : "",
      note: ti >= 0 ? (cols[ti] ?? "") : "",
    }))
    .filter((r): r is IncomingCatalogRow => r !== null)
    .slice(0, MAX_ROWS);
}

/** First-sheet-to-CSV, then the same parser — one code path for spreadsheets. */
export function parseCatalogWorkbook(data: Uint8Array, filename: string): IncomingCatalogRow[] {
  let wb: XLSX.WorkBook;
  try {
    wb = XLSX.read(data, { type: "buffer" });
  } catch {
    throw new CatalogImportError("INVALID_INPUT", `Cannot read spreadsheet ${filename}.`);
  }
  const sheet = wb.SheetNames[0] ? wb.Sheets[wb.SheetNames[0]!] : undefined;
  if (!sheet) throw new CatalogImportError("INVALID_INPUT", "Spreadsheet has no sheets.");
  const csv = XLSX.utils.sheet_to_csv(sheet);
  return parseCatalogCsv(csv);
}

function parseIdrPrice(raw: string): number | null {
  // Accepts "12500", "12.500", "12,500", "Rp 12.500,00", "12500.50".
  let s = raw.trim().replace(/^[Rr][Pp]\s*/, "").replace(/\s+/g, "");
  if (!s) return null;
  const hasComma = s.includes(",");
  const hasDot = s.includes(".");
  if (hasComma && hasDot) {
    // Indonesian "12.500,75" → thousands dot, decimal comma.
    s = s.replace(/\./g, "").replace(",", ".");
  } else if (hasComma && !hasDot) {
    // Ambiguous "12,500": treat comma as thousands when exactly 3 trailing digits.
    s = /^(\d+),(\d{3})$/.test(s) ? s.replace(",", "") : s.replace(",", ".");
  } else if (hasDot && !hasComma) {
    // "12.500" (thousands) vs "12.50" (decimal): 3 trailing digits = thousands.
    s = /^(\d+)\.(\d{3})$/.test(s) ? s.replace(".", "") : s;
  }
  s = s.replace(/[^0-9.]/g, "");
  if (!s) return null;
  const n = Number(s);
  if (!Number.isFinite(n) || n < 0 || !isMoney(n)) return null;
  return roundMoney(n);
}

function normalizeIncoming(raw: {
  vendorCode: unknown;
  name: unknown;
  unitText: unknown;
  price: unknown;
  moq: unknown;
  note: unknown;
}): IncomingCatalogRow | null {
  const name = typeof raw.name === "string" ? raw.name.trim().slice(0, 300) : "";
  if (!name) return null;
  const priceRaw = typeof raw.price === "number" ? String(raw.price) : typeof raw.price === "string" ? raw.price : "";
  const priceMinor =
    typeof raw.price === "number" && isMoney(raw.price) && raw.price >= 0
      ? roundMoney(raw.price)
      : parseIdrPrice(priceRaw);
  const moqNum = typeof raw.moq === "number" ? raw.moq : Number(String(raw.moq ?? "").trim().replace(/[^0-9]/g, "") || NaN);
  return {
    vendorCode: typeof raw.vendorCode === "string" ? raw.vendorCode.trim().slice(0, 100) : String(raw.vendorCode ?? "").slice(0, 100),
    name,
    unitText: typeof raw.unitText === "string" ? raw.unitText.trim().slice(0, 50) : "",
    priceMinor,
    moq: Number.isInteger(moqNum) && moqNum > 0 ? moqNum : null,
    note: typeof raw.note === "string" ? raw.note.trim().slice(0, 1000) : "",
  };
}

/** Match incoming rows against existing catalog rows for the preview. */
export async function buildCatalogPreview(
  vendorId: string,
  incoming: IncomingCatalogRow[],
): Promise<CatalogPreviewRow[]> {
  const out: CatalogPreviewRow[] = [];
  for (let i = 0; i < incoming.length; i++) {
    const row = incoming[i]!;
    const match = await findCatalogMatch(vendorId, row.vendorCode, row.name);
    out.push({
      ...row,
      key: `row-${i}`,
      matchedItemId: match?.id ?? null,
      matchedName: match?.name ?? null,
      oldPriceMinor: match?.priceMinor ?? null,
      action: match ? "update" : "create",
    });
  }
  return out;
}

export interface AcceptedCatalogRow {
  vendorCode?: string | null;
  name?: string | null;
  unitText?: string | null;
  priceMinor?: number | null;
  moq?: number | null;
  note?: string | null;
  /** Present when the clerk accepted this as an update to an existing item. */
  matchedItemId?: string | null;
}

export interface ConfirmCatalogImportInput {
  importId: string;
  vendorId: string;
  rows: AcceptedCatalogRow[];
}

export interface ConfirmCatalogImportResult {
  created: number;
  updated: number;
  skipped: number;
}

/**
 * The sole writer for imports. Creates get a price-history row; updates touch
 * only accepted rows (price change appends history, always bumps lastSeenAt).
 * Rows without a price are skipped on create (a priceless reference is noise).
 */
export async function confirmCatalogImport(
  input: ConfirmCatalogImportInput,
  createdByUserId?: string,
): Promise<ConfirmCatalogImportResult> {
  const imp = await db.query.vendorCatalogImports.findFirst({
    where: eq(vendorCatalogImports.id, input.importId),
  });
  if (!imp) throw new VendorCatalogError("IMPORT_NOT_FOUND");
  if (imp.vendorId !== input.vendorId) {
    throw new VendorCatalogError("INVALID_INPUT", "import does not belong to this vendor");
  }

  let created = 0;
  let updated = 0;
  let skipped = 0;
  const now = new Date();

  await db.transaction(async (tx) => {
    for (const row of input.rows.slice(0, MAX_ROWS)) {
      const name = (row.name ?? "").trim().slice(0, 300);
      if (!name) {
        skipped++;
        continue;
      }
      const vendorCode = (row.vendorCode ?? "").trim().slice(0, 100);
      const unitText = (row.unitText ?? "").trim().slice(0, 50) || null;
      const note = (row.note ?? "").trim() || null;
      if (row.matchedItemId) {
        const existing = await tx
          .select()
          .from(vendorCatalogItems)
          .where(eq(vendorCatalogItems.id, row.matchedItemId));
        const prev: VendorCatalogItem | undefined = existing[0];
        if (!prev || prev.vendorId !== input.vendorId) {
          skipped++;
          continue;
        }
        const priceChanged =
          row.priceMinor !== null && row.priceMinor !== prev.priceMinor;
        await tx
          .update(vendorCatalogItems)
          .set({
            vendorCode: vendorCode || prev.vendorCode,
            name,
            unitText,
            priceMinor: row.priceMinor ?? prev.priceMinor,
            moq: row.moq ?? null,
            note,
            lastSeenAt: now,
          })
          .where(eq(vendorCatalogItems.id, prev.id));
        if (priceChanged) {
          await tx.insert(vendorCatalogPrices).values({
            id: ulid(),
            itemId: prev.id,
            priceMinor: row.priceMinor!,
            sourceImportId: input.importId,
            createdByUserId: createdByUserId ?? null,
          });
        }
        updated++;
      } else {
        if (row.priceMinor == null) {
          skipped++;
          continue;
        }
        const id = ulid();
        await tx.insert(vendorCatalogItems).values({
          id,
          vendorId: input.vendorId,
          vendorCode,
          name,
          unitText,
          priceMinor: row.priceMinor,
          moq: row.moq ?? null,
          note,
          sourceImportId: input.importId,
          lastSeenAt: now,
          createdByUserId: createdByUserId ?? null,
        });
        await tx.insert(vendorCatalogPrices).values({
          id: ulid(),
          itemId: id,
          priceMinor: row.priceMinor,
          sourceImportId: input.importId,
          createdByUserId: createdByUserId ?? null,
        });
        created++;
      }
    }
    await tx
      .update(vendorCatalogImports)
      .set({ status: "confirmed", rowCount: created + updated })
      .where(eq(vendorCatalogImports.id, input.importId));
  });
  return { created, updated, skipped };
}

export async function createCatalogImport(
  vendorId: string,
  fileName: string,
  createdByUserId?: string,
): Promise<string> {
  const id = ulid();
  await db.insert(vendorCatalogImports).values({
    id,
    vendorId,
    fileName: fileName.slice(0, 300),
    status: "pending",
    createdByUserId: createdByUserId ?? null,
  });
  return id;
}

export async function markCatalogImport(
  id: string,
  patch: {
    status: "ready" | "failed";
    rowCount?: number;
    modelUsed?: string;
    tokenUsage?: unknown;
    errorCode?: string;
    errorMessage?: string;
  },
): Promise<void> {
  await db
    .update(vendorCatalogImports)
    .set({
      status: patch.status,
      rowCount: patch.rowCount ?? 0,
      modelUsed: patch.modelUsed?.slice(0, 200) ?? null,
      tokenUsageJson: patch.tokenUsage === undefined ? null : (patch.tokenUsage as never),
      errorCode: patch.errorCode ?? null,
      errorMessage: patch.errorMessage ?? null,
    })
    .where(eq(vendorCatalogImports.id, id));
}
