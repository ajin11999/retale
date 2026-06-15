// Order receipt PDF service: render a customer sale to a designed A4 document —
// a letterhead (business identity), a customer "To" block, the Receipt
// title/date/number, and a bordered line-item table with a total (plus paid /
// balance due when relevant). The layout mirrors the purchase-order PDF
// (docs/template.svg); coordinates are in millimetres, converted to PDF points
// on draw. Unlike the WhatsApp/email message body, this is a formal printable
// document, so it does NOT mirror that text 1:1. The client downloads this and
// shares it as an attachment (deep links cannot carry files). Pure read.
//
// A receipt always prints prices — that is the document's purpose — so unlike
// the PO PDF there is no price-visibility toggle.

import { PDFDocument, type PDFFont, type PDFPage, rgb, StandardFonts } from "pdf-lib";
import { formatRp } from "../lib/money.ts";
import { BUSINESS_LOGO_PATH } from "../lib/uploads.ts";
import { getBusinessSettings } from "./business-service.ts";
import { getCustomer } from "./customer-service.ts";
import {
  getOrder,
  listOrderItems,
  listOrderPayments,
} from "./order-service.ts";

// --- Geometry (millimetres → points; SVG origin is top-left, PDF bottom-left) ---

const MM = 72 / 25.4; // points per millimetre
const PAGE_W = 210 * MM;
const PAGE_H = 297 * MM;

/** A point on the page from template millimetre coordinates (top-left origin). */
function at(xMm: number, yMm: number): { x: number; y: number } {
  return { x: xMm * MM, y: PAGE_H - yMm * MM };
}

const LOGO_BOX = { x: 11.39, y: 11.77, w: 43.29, h: 20.89 }; // mm
const TABLE_BOX = { x: 11.82, y: 85.39, w: 187.44, h: 142.86 }; // mm
const RIGHT_EDGE = TABLE_BOX.x + TABLE_BOX.w; // 199.26mm — page content right edge

/** Receipt table column geometry (mm): No / Item / Qty / Price / Amount. */
const COLS = {
  no: TABLE_BOX.x,
  item: TABLE_BOX.x + 12,
  qtyRight: TABLE_BOX.x + 12 + 95 + 16,
  priceRight: TABLE_BOX.x + 12 + 95 + 16 + 30,
  amountRight: RIGHT_EDGE,
  itemWrapMm: 88,
};

const ROW_H = 7; // mm per body row
const HEADER_ROW_H = 8; // mm for the column-header band
const PAD = 1.8; // mm cell padding

// Font sizes (points).
const SIZE_LABEL = 9;
const SIZE_VALUE = 9;
const SIZE_TITLE = 26;
const SIZE_TH = 9;
const SIZE_ROW = 9;

const BLACK = rgb(0, 0, 0);
const GREY = rgb(0.45, 0.45, 0.45);
/** Zebra-stripe fill behind every other line row, for readability. */
const STRIPE = rgb(0.95, 0.95, 0.95);

/** Map characters the standard PDF fonts cannot encode to safe ASCII. */
function sanitize(text: string): string {
  return text
    .replace(/[—–]/g, "-")
    .replace(/[·•]/g, "-")
    .replace(/[^\x20-\x7E\xA0-\xFF]/g, "?");
}

/** Money for display: "Rp 1,500,000.5" (international grouping, trimmed 2dp). */
const rp = (value: number): string => formatRp(value);
const dateOnly = (d: Date | string): string => new Date(d).toISOString().slice(0, 10);

/** Break a line to fit `maxWidthMm`, splitting on spaces. */
function wrapLine(line: string, font: PDFFont, size: number, maxWidthMm: number): string[] {
  const maxW = maxWidthMm * MM;
  if (font.widthOfTextAtSize(line, size) <= maxW) return [line];
  const out: string[] = [];
  let current = "";
  for (const word of line.split(" ")) {
    const candidate = current ? `${current} ${word}` : word;
    if (current && font.widthOfTextAtSize(candidate, size) > maxW) {
      out.push(current);
      current = word;
    } else {
      current = candidate;
    }
  }
  if (current) out.push(current);
  return out;
}

// --- Structured receipt data ---

interface ReceiptLine {
  name: string;
  qty: number;
  priceMinor: number;
  discountMinor: number;
  totalMinor: number;
}

async function buildReceiptData(orderId: string): Promise<{
  business: Awaited<ReturnType<typeof getBusinessSettings>>;
  order: Awaited<ReturnType<typeof getOrder>>;
  customerPhone: string | null;
  lines: ReceiptLine[];
  totalMinor: number;
  paidMinor: number;
}> {
  const order = await getOrder(orderId);
  const [items, payments, business] = await Promise.all([
    listOrderItems(orderId),
    listOrderPayments(orderId),
    getBusinessSettings(),
  ]);

  // The order keeps a snapshot name after a hard-delete; the live row carries
  // the phone. Missing customer (walk-in / deleted) → no phone on the receipt.
  let customerPhone: string | null = null;
  if (order.customerId) {
    try {
      customerPhone = (await getCustomer(order.customerId)).phone ?? null;
    } catch {
      customerPhone = null;
    }
  }

  const lines: ReceiptLine[] = items
    .filter((i) => !i.voidedAt)
    .map((i) => ({
      name: i.snapshotPublicName ?? i.snapshotProductName,
      qty: i.qty,
      priceMinor: i.snapshotPriceMinor,
      discountMinor: i.discountMinor,
      totalMinor: i.qty * i.snapshotPriceMinor - i.discountMinor,
    }));

  const paidMinor = payments.reduce((acc, p) => acc + p.amountMinor, 0);
  return { business, order, customerPhone, lines, totalMinor: order.totalMinor, paidMinor };
}

// --- Drawing ---

/**
 * Render a customer sale as a designed A4 receipt PDF. Throws OrderError
 * (ORDER_NOT_FOUND) via `getOrder` for an unknown id.
 */
export async function renderOrderReceiptPdf(orderId: string): Promise<Uint8Array> {
  const { business, order, customerPhone, lines, totalMinor, paidMinor } =
    await buildReceiptData(orderId);

  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);

  let page = doc.addPage([PAGE_W, PAGE_H]);

  /** Left-anchored text at a template mm coordinate (baseline). */
  const text = (
    xMm: number,
    yMm: number,
    s: string,
    size: number,
    f: PDFFont = font,
    color = BLACK,
  ): void => {
    const p = at(xMm, yMm);
    page.drawText(sanitize(s), { x: p.x, y: p.y, size, font: f, color });
  };
  /** Right-anchored text ending at a template mm x coordinate. */
  const textRight = (
    xRightMm: number,
    yMm: number,
    s: string,
    size: number,
    f: PDFFont = font,
    color = BLACK,
  ): void => {
    const clean = sanitize(s);
    const w = f.widthOfTextAtSize(clean, size) / MM;
    text(xRightMm - w, yMm, clean, size, f, color);
  };
  /** Rectangle outline from a template mm box. */
  const rect = (b: { x: number; y: number; w: number; h: number }, lw = 0.75): void => {
    const tl = at(b.x, b.y);
    page.drawRectangle({
      x: tl.x,
      y: tl.y - b.h * MM,
      width: b.w * MM,
      height: b.h * MM,
      borderColor: BLACK,
      borderWidth: lw,
    });
  };
  /** Horizontal rule across a template mm span. */
  const hline = (x1Mm: number, x2Mm: number, yMm: number, lw = 0.5): void => {
    const a = at(x1Mm, yMm);
    const b = at(x2Mm, yMm);
    page.drawLine({ start: a, end: b, thickness: lw, color: BLACK });
  };

  // -- Letterhead: logo + business identity --
  // A real logo stands on its own; the bordered box is only drawn to frame the
  // business-name text placeholder shown when no logo is set.
  const logoEmbedded = await drawLogo(doc, page, business.logoUrl);
  if (!logoEmbedded) {
    rect(LOGO_BOX);
    const logoText = business.name.trim() || "Company Logo";
    const size = 11;
    const w = bold.widthOfTextAtSize(sanitize(logoText), size) / MM;
    const cx = LOGO_BOX.x + LOGO_BOX.w / 2 - w / 2;
    const cy = LOGO_BOX.y + LOGO_BOX.h / 2 + (size / MM) * 0.35;
    text(Math.max(LOGO_BOX.x + 1, cx), cy, logoText, size, bold);
  }

  // Sender particulars under the logo (label : value).
  let hy = LOGO_BOX.y + LOGO_BOX.h + 5;
  const field = (label: string, value: string | null): void => {
    text(LOGO_BOX.x, hy, label, SIZE_LABEL, bold);
    if (value) text(LOGO_BOX.x + 13, hy, value, SIZE_VALUE, font);
    hy += 5;
  };
  field("Telp:", business.phone?.trim() || null);
  field("Email:", business.email?.trim() || null);
  field("Date:", dateOnly(order.closedAt ?? order.createdAt));
  if (order.displayNumber) field("No:", order.displayNumber);

  // -- Customer block (mid-left "To:"): name + phone --
  hy += 2.5;
  text(LOGO_BOX.x, hy, "To:", SIZE_LABEL, bold);
  hy += 5;
  text(LOGO_BOX.x, hy, order.snapshotCustomerName ?? "Walk-in", SIZE_VALUE + 1, bold);
  hy += 4.5;
  if (customerPhone?.trim() && hy < TABLE_BOX.y - 2) {
    text(LOGO_BOX.x, hy, customerPhone.trim(), SIZE_VALUE, font, GREY);
  }

  // -- Title --
  textRight(RIGHT_EDGE, 76.85, "Receipt", SIZE_TITLE, bold);

  // -- Items table --
  drawTableFrameAndHeader(page, { font, bold, text, textRight, rect, hline });

  let rowTop = TABLE_BOX.y + HEADER_ROW_H; // mm, top of current row
  const tableBottom = TABLE_BOX.y + TABLE_BOX.h;

  let lineNo = 0;
  for (const line of lines) {
    lineNo += 1;
    const wrapped = wrapLine(line.name, font, SIZE_ROW, COLS.itemWrapMm);
    // A discount shows as a small grey note under the item name.
    const hasSub = line.discountMinor > 0;
    const rowH = ROW_H + (wrapped.length - 1) * 4 + (hasSub ? 4 : 0);

    if (rowTop + rowH > tableBottom) {
      ({ page, rowTop } = newTablePage(doc, { font, bold }));
    }

    if (lineNo % 2 === 0) {
      const inset = 0.35; // mm — keeps the vertical borders visible
      const tl = at(TABLE_BOX.x + inset, rowTop);
      page.drawRectangle({
        x: tl.x,
        y: tl.y - rowH * MM,
        width: (TABLE_BOX.w - inset * 2) * MM,
        height: rowH * MM,
        color: STRIPE,
      });
      hline(TABLE_BOX.x, RIGHT_EDGE, rowTop, 0.25);
    }

    const baseY = rowTop + 4.6; // first text baseline within the row
    page.drawText(String(lineNo), { ...at(COLS.no + PAD, baseY), size: SIZE_ROW, font });
    let ty = baseY;
    for (const w of wrapped) {
      page.drawText(sanitize(w), { ...at(COLS.item + PAD, ty), size: SIZE_ROW, font });
      ty += 4;
    }
    if (hasSub) {
      page.drawText(sanitize(`disc ${rp(line.discountMinor)}`), {
        ...at(COLS.item + PAD, ty),
        size: SIZE_ROW - 1.5,
        font,
        color: GREY,
      });
    }
    drawRight(page, font, COLS.qtyRight - PAD, baseY, String(line.qty), SIZE_ROW);
    drawRight(page, font, COLS.priceRight - PAD, baseY, rp(line.priceMinor), SIZE_ROW);
    drawRight(page, font, COLS.amountRight - PAD, baseY, rp(line.totalMinor), SIZE_ROW);

    hline(TABLE_BOX.x, RIGHT_EDGE, rowTop + rowH, 0.25);
    rowTop += rowH;
  }

  if (lines.length === 0) {
    text(COLS.item + PAD, rowTop + 5, "(no items)", SIZE_ROW, font, GREY);
  }

  // -- Totals: a band just under the table box. --
  let totalY = tableBottom + 7;
  drawRight(page, bold, COLS.priceRight - PAD, totalY, "Total", SIZE_ROW + 1);
  drawRight(page, bold, COLS.amountRight - PAD, totalY, rp(totalMinor), SIZE_ROW + 1);
  // Paid / balance only when there's something to say.
  if (paidMinor > 0 || paidMinor < totalMinor) {
    totalY += 6;
    drawRight(page, font, COLS.priceRight - PAD, totalY, "Paid", SIZE_ROW);
    drawRight(page, font, COLS.amountRight - PAD, totalY, rp(paidMinor), SIZE_ROW);
    const balance = totalMinor - paidMinor;
    if (balance > 0) {
      totalY += 6;
      drawRight(page, bold, COLS.priceRight - PAD, totalY, "Balance due", SIZE_ROW);
      drawRight(page, bold, COLS.amountRight - PAD, totalY, rp(balance), SIZE_ROW);
    }
  }

  // -- Footer (business receiptFooter) --
  if (business.receiptFooter?.trim()) {
    let fy = totalY + 10;
    for (const ln of wrapLine(sanitize(business.receiptFooter.trim()), font, 8, TABLE_BOX.w)) {
      text(TABLE_BOX.x, fy, ln, 8, font, GREY);
      fy += 4.5;
    }
  }

  return doc.save();
}

/** Draw the table outline and the column-header band on the current page. */
function drawTableFrameAndHeader(
  page: PDFPage,
  helpers: {
    font: PDFFont;
    bold: PDFFont;
    text: (x: number, y: number, s: string, size: number, f?: PDFFont) => void;
    textRight: (x: number, y: number, s: string, size: number, f?: PDFFont) => void;
    rect: (b: { x: number; y: number; w: number; h: number }, lw?: number) => void;
    hline: (x1: number, x2: number, y: number, lw?: number) => void;
  },
): void {
  const { bold, text, textRight, rect, hline } = helpers;
  rect(TABLE_BOX, 0.75);
  const hy = TABLE_BOX.y + 5.4;
  text(COLS.no + PAD, hy, "No", SIZE_TH, bold);
  text(COLS.item + PAD, hy, "Item", SIZE_TH, bold);
  textRight(COLS.qtyRight - PAD, hy, "Qty", SIZE_TH, bold);
  textRight(COLS.priceRight - PAD, hy, "Price", SIZE_TH, bold);
  textRight(COLS.amountRight - PAD, hy, "Amount", SIZE_TH, bold);
  hline(TABLE_BOX.x, RIGHT_EDGE, TABLE_BOX.y + HEADER_ROW_H, 0.75);
}

/**
 * Read the on-disk logo PNG and embed it inside LOGO_BOX (aspect-fit, small
 * inset). Returns false — so the caller can fall back to a text placeholder —
 * when no logo is set or anything goes wrong (missing file, decode error).
 */
async function drawLogo(
  doc: PDFDocument,
  page: PDFPage,
  logoUrl: string | null,
): Promise<boolean> {
  if (!logoUrl) return false;
  try {
    const file = Bun.file(BUSINESS_LOGO_PATH);
    if (!(await file.exists())) return false;
    const bytes = new Uint8Array(await file.arrayBuffer());
    const img = await doc.embedPng(bytes);

    // No inset — the logo fills the box (there is no border to clear).
    const boxW = LOGO_BOX.w * MM;
    const boxH = LOGO_BOX.h * MM;
    const scale = Math.min(boxW / img.width, boxH / img.height);
    const w = img.width * scale;
    const h = img.height * scale;
    const boxTopY = PAGE_H - LOGO_BOX.y * MM;
    const x = LOGO_BOX.x * MM + (LOGO_BOX.w * MM - w) / 2;
    const y = boxTopY - LOGO_BOX.h * MM + (LOGO_BOX.h * MM - h) / 2;
    page.drawImage(img, { x, y, width: w, height: h });
    return true;
  } catch {
    return false;
  }
}

/** Right-anchored text directly on a page (no closure capture). */
function drawRight(
  page: PDFPage,
  f: PDFFont,
  xRightMm: number,
  yMm: number,
  s: string,
  size: number,
  color = BLACK,
): void {
  const clean = sanitize(s);
  const w = f.widthOfTextAtSize(clean, size);
  page.drawText(clean, { x: xRightMm * MM - w, y: PAGE_H - yMm * MM, size, font: f, color });
}

/**
 * Start a continuation page carrying just the table (the decorative header is
 * page 1 only). Returns the new page and the body-row cursor.
 */
function newTablePage(
  doc: PDFDocument,
  fonts: { font: PDFFont; bold: PDFFont },
): { page: PDFPage; rowTop: number } {
  const page = doc.addPage([PAGE_W, PAGE_H]);
  const { font, bold } = fonts;
  const text = (x: number, y: number, s: string, size: number, fnt: PDFFont = font): void => {
    page.drawText(sanitize(s), { x: x * MM, y: PAGE_H - y * MM, size, font: fnt });
  };
  const textRight = (
    xR: number,
    y: number,
    s: string,
    size: number,
    fnt: PDFFont = font,
  ): void => {
    const w = fnt.widthOfTextAtSize(sanitize(s), size) / MM;
    text(xR - w, y, s, size, fnt);
  };
  const rect = (b: { x: number; y: number; w: number; h: number }, lw = 0.75): void => {
    page.drawRectangle({
      x: b.x * MM,
      y: PAGE_H - (b.y + b.h) * MM,
      width: b.w * MM,
      height: b.h * MM,
      borderColor: BLACK,
      borderWidth: lw,
    });
  };
  const hline = (x1: number, x2: number, y: number, lw = 0.5): void => {
    page.drawLine({
      start: { x: x1 * MM, y: PAGE_H - y * MM },
      end: { x: x2 * MM, y: PAGE_H - y * MM },
      thickness: lw,
      color: BLACK,
    });
  };
  drawTableFrameAndHeader(page, { font, bold, text, textRight, rect, hline });
  return { page, rowTop: TABLE_BOX.y + HEADER_ROW_H };
}
