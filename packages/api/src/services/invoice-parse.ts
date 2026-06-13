// Pure invoice-line parser — no I/O, no DB, no OCR runtime, so it is fully
// unit-testable. Both the OCR path (tesseract.js words) and the digital-PDF path
// (pdfjs text items) normalise their output to `OcrWord[]` and feed it here.
//
// The job: turn a flat bag of positioned words into candidate purchase lines
// {description, qty, unitCostMinor}. Recognition is best-effort — a row we can't
// read confidently is returned with `recognized: false` and blank fields, which
// the console renders as "unrecognized, please fill manually" (the explicit
// product requirement). The confirm-and-fix modal is the safety net for the rest.
//
// Money is integer **minor units = whole rupiah** (see money-input.svelte /
// formatMoney in the console): "25.000" → 25000, no ×100. id-ID grouping is `.`
// for thousands and `,` for the decimal.

/** One positioned word. OCR gives confidence 0–100; PDF text items pass 100. */
export interface OcrWord {
  text: string;
  confidence: number;
  bbox: { x0: number; y0: number; x1: number; y1: number };
}

/** One candidate line for the confirm-and-fix modal. */
export interface ParsedLine {
  /** false → render a blank row with "unrecognized, please fill manually". */
  recognized: boolean;
  description: string;
  qty: number | null;
  unitCostMinor: number | null;
  /** Mean OCR confidence of the row (0–100); 100 for digital-PDF text. */
  confidence: number;
  /** Raw row text, always kept — a hint shown beside unrecognized rows. */
  raw: string;
}

/** Below this mean word confidence a row is treated as unrecognized. */
export const CONFIDENCE_THRESHOLD = 55;

const centerY = (w: OcrWord) => (w.bbox.y0 + w.bbox.y1) / 2;
const mean = (ns: number[]) => (ns.length ? ns.reduce((a, b) => a + b, 0) / ns.length : 0);

/**
 * Parse one numeric string to whole rupiah, or null if it isn't a number.
 * Accepts an optional currency prefix (Rp / IDR / $) and id-ID grouping. When a
 * value carries a sub-rupiah decimal it is rounded, since the minor unit is the
 * rupiah.
 */
export function parseMoneyId(input: string): number | null {
  let t = input.replace(/^\s*(rp\.?|idr|\$)\s*/i, "").replace(/\s*(rp|idr)\s*$/i, "").trim();
  t = t.replace(/[^\d.,-]/g, "");
  const neg = t.startsWith("-");
  t = t.replace(/-/g, "");
  if (!/\d/.test(t)) return null;

  const hasDot = t.includes(".");
  const hasComma = t.includes(",");
  let normalized: string;
  if (hasDot && hasComma) {
    // Whichever separator sits furthest right is the decimal one.
    const decSep = t.lastIndexOf(",") > t.lastIndexOf(".") ? "," : ".";
    const thouSep = decSep === "," ? "." : ",";
    normalized = t.split(thouSep).join("").replace(decSep, ".");
  } else if (hasComma) {
    normalized = normalizeSingleSeparator(t, ",");
  } else if (hasDot) {
    normalized = normalizeSingleSeparator(t, ".");
  } else {
    normalized = t;
  }

  const value = parseFloat(normalized);
  if (Number.isNaN(value)) return null;
  return Math.round(neg ? -value : value);
}

/**
 * One separator type present — decide thousands vs decimal. Groups of exactly
 * three trailing digits ("25.000", "1.234.567") read as thousands; otherwise the
 * last group is a decimal fraction ("25,5" → 25.5).
 */
function normalizeSingleSeparator(t: string, sep: string): string {
  const parts = t.split(sep);
  if (parts.length === 1) return t;
  const first = parts[0] ?? "";
  const groupsAfterFirst = parts.slice(1);
  const looksGrouped =
    groupsAfterFirst.every((p) => p.length === 3) && first.length >= 1 && first.length <= 3;
  if (looksGrouped) return parts.join("");
  if (parts.length === 2) return `${first}.${parts[1] ?? ""}`; // decimal
  return parts.join(""); // many separators, not clean groups → assume thousands
}

interface NumToken {
  /** Whole-rupiah value. */
  value: number;
  /** Had a thousands/decimal separator (a strong "this is money" signal). */
  grouped: boolean;
}

/** A token is numeric only if, sans currency, it is all digits/separators. */
function classifyNumeric(text: string): NumToken | null {
  const stripped = text.replace(/^\s*(rp\.?|idr|\$)\s*/i, "").replace(/\s*(rp|idr)\s*$/i, "").trim();
  if (!/^-?[\d.,]+$/.test(stripped) || !/\d/.test(stripped)) return null;
  const value = parseMoneyId(stripped);
  if (value == null) return null;
  return { value, grouped: /[.,]/.test(stripped) };
}

/** Group words into rows by vertical overlap, each row sorted left→right. */
export function groupRows(words: OcrWord[]): OcrWord[][] {
  const ws = words.filter((w) => w.text.trim().length > 0).sort((a, b) => centerY(a) - centerY(b));
  const rows: OcrWord[][] = [];
  for (const w of ws) {
    const row = rows[rows.length - 1];
    if (row && overlapsRow(row, w)) row.push(w);
    else rows.push([w]);
  }
  for (const r of rows) r.sort((a, b) => a.bbox.x0 - b.bbox.x0);
  return rows;
}

function overlapsRow(row: OcrWord[], w: OcrWord): boolean {
  const y0 = Math.min(...row.map((r) => r.bbox.y0));
  const y1 = Math.max(...row.map((r) => r.bbox.y1));
  const overlap = Math.min(y1, w.bbox.y1) - Math.max(y0, w.bbox.y0);
  const minHeight = Math.min(y1 - y0, w.bbox.y1 - w.bbox.y0);
  return overlap > 0 && overlap >= 0.4 * Math.max(1, minHeight);
}

const approx = (a: number, b: number) => Math.abs(a - b) <= Math.max(1, b * 0.05);

/**
 * Parse one row of words into a line, or null if the row carries no number (so
 * it isn't an item line — headers, addresses, "PURCHASE ORDER" are dropped).
 * Layout assumed left→right: `description … [qty] price [amount]`.
 */
function parseRow(words: OcrWord[]): ParsedLine | null {
  const sorted = [...words].sort((a, b) => a.bbox.x0 - b.bbox.x0);
  const raw = sorted
    .map((w) => w.text)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
  const confidence = Math.round(mean(words.map((w) => w.confidence)));

  const toks = sorted.map((w, i) => ({ i, text: w.text, num: classifyNumeric(w.text) }));
  const nums = toks.filter((t) => t.num) as Array<{ i: number; text: string; num: NumToken }>;
  if (nums.length === 0) return null; // not an item row

  const description = toks
    .filter((t) => !t.num)
    .map((t) => t.text)
    .join(" ")
    .replace(/\s+/g, " ")
    .replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "")
    .trim();

  let qty: number | null = null;
  let unitCostMinor: number | null = null;

  // Strong money = had a separator, or is ≥1000 (a plausible IDR price).
  const strong = nums.filter((n) => n.num.grouped || n.num.value >= 1000);
  const firstStrong = strong[0];
  if (firstStrong) {
    let priceTok = firstStrong; // Qty | Price | Amount → leftmost strong is the unit price
    const qtyTok = [...nums]
      .reverse()
      .find((n) => n.i < priceTok.i && !n.num.grouped && n.num.value < 10000);
    qty = qtyTok ? Math.round(qtyTok.num.value) : 1;
    // With ≥2 money columns and a qty, prefer the one where qty×price ≈ amount.
    if (strong.length >= 2 && qtyTok) {
      const m = strong.find((s) => strong.some((o) => o !== s && approx(qty! * s.num.value, o.num.value)));
      if (m) priceTok = m;
    }
    unitCostMinor = priceTok.num.value;
  } else {
    // Only plain small integers. One number: ≥100 reads as price, else qty.
    const vals = nums.map((n) => Math.round(n.num.value));
    const v0 = vals[0] ?? 0;
    if (vals.length === 1) {
      if (v0 >= 100) {
        unitCostMinor = v0;
        qty = 1;
      } else {
        qty = v0;
      }
    } else {
      qty = v0;
      unitCostMinor = vals[vals.length - 1] ?? null;
    }
  }

  const recognized = description.length > 0 && confidence >= CONFIDENCE_THRESHOLD;
  return {
    recognized,
    description: recognized ? description : "",
    qty: recognized ? qty : null,
    unitCostMinor: recognized ? unitCostMinor : null,
    confidence,
    raw,
  };
}

/** Group positioned words into rows and parse each candidate item line. */
export function parseInvoiceWords(words: OcrWord[]): ParsedLine[] {
  const out: ParsedLine[] = [];
  for (const row of groupRows(words)) {
    const line = parseRow(row);
    if (line) out.push(line);
  }
  return out;
}
