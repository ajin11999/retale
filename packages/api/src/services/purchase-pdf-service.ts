// Purchase PDF service: render a purchase order to a designed A4 document —
// a letterhead (business identity), a vendor "To" block, the PO title/date,
// and a bordered line-item table grouped by section with a total. The layout
// follows docs/template.svg (an Inkscape PO form): coordinates below are in
// millimetres, matching that template, and converted to PDF points on draw.
// Unlike the WhatsApp/email message body, this is a formal printable document,
// so it does NOT mirror that text 1:1. The Flutter client downloads this and
// shares it as an attachment (deep links cannot carry files). Pure read.

import { eq, inArray } from "drizzle-orm";
import { PDFDocument, type PDFFont, type PDFPage, rgb, StandardFonts } from "pdf-lib";
import { products, productVariants } from "../db/schema/products.ts";
import { db } from "../lib/db.ts";
import { resolveShipTo } from "./address-service.ts";
import { getBusinessSettings } from "./business-service.ts";
import {
  getPurchase,
  invoiceTotalMinor,
  listItems,
  listSections,
} from "./purchase-service.ts";
import { getVendor } from "./vendor-service.ts";
import { listCodesForVendor } from "./vendor-variant-code-service.ts";

// --- Geometry (millimetres → points; SVG origin is top-left, PDF bottom-left) ---

const MM = 72 / 25.4; // points per millimetre
const PAGE_W = 210 * MM;
const PAGE_H = 297 * MM;

/** A point on the page from template millimetre coordinates (top-left origin). */
function at(xMm: number, yMm: number): { x: number; y: number } {
  return { x: xMm * MM, y: PAGE_H - yMm * MM };
}

// Header chrome, straight from template.svg.
const LOGO_BOX = { x: 11.39, y: 11.77, w: 43.29, h: 20.89 }; // mm
const TABLE_BOX = { x: 11.82, y: 85.39, w: 187.44, h: 142.86 }; // mm
const RIGHT_EDGE = TABLE_BOX.x + TABLE_BOX.w; // 199.26mm — page content right edge

/**
 * Table column geometry (mm). With prices: No / Item / Qty / Unit Cost /
 * Amount. Without prices: No / Item / Qty only — Qty moves to the right edge
 * and Item fills the freed space. `unitRight` / `amountRight` are null when
 * prices are hidden. `itemWrapMm` is the width available for wrapping item text.
 */
interface Cols {
  showPrices: boolean;
  no: number;
  item: number;
  qtyRight: number;
  unitRight: number | null;
  amountRight: number | null;
  itemWrapMm: number;
}

function makeCols(showPrices: boolean): Cols {
  const no = TABLE_BOX.x;
  const item = TABLE_BOX.x + 12;
  if (showPrices) {
    const qtyRight = TABLE_BOX.x + 12 + 95 + 16;
    return {
      showPrices,
      no,
      item,
      qtyRight,
      unitRight: qtyRight + 30,
      amountRight: RIGHT_EDGE,
      itemWrapMm: 88,
    };
  }
  return {
    showPrices,
    no,
    item,
    qtyRight: RIGHT_EDGE,
    unitRight: null,
    amountRight: null,
    itemWrapMm: TABLE_BOX.w - 12 - 18 - 4,
  };
}

const ROW_H = 7; // mm per body row
const HEADER_ROW_H = 8; // mm for the column-header band
const PAD = 1.8; // mm cell padding

// Font sizes (points).
const SIZE_LABEL = 9;
const SIZE_VALUE = 9;
const SIZE_TITLE = 26;
const SIZE_TH = 9;
const SIZE_ROW = 9;
const SIZE_SECTION = 9.5;

const BLACK = rgb(0, 0, 0);
const GREY = rgb(0.45, 0.45, 0.45);
/** Zebra-stripe fill behind every other line row, for readability. */
const STRIPE = rgb(0.95, 0.95, 0.95);

/** Map characters the standard PDF fonts cannot encode to safe ASCII. */
function sanitize(text: string): string {
  return text.replace(/[—–]/g, "-").replace(/[·•]/g, "-").replace(/[^\x20-\x7E\xA0-\xFF]/g, "?");
}

/** Group an integer with "." thousands separators — Indonesian style. */
function groupThousands(n: number): string {
  return Math.trunc(n)
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/g, ".");
}
const rp = (minor: number): string => `Rp ${groupThousands(minor)}`;

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

// --- Structured PO data (the same fields the message renderer gathers) ---

interface PoLine {
  /** Primary identifier shown to the vendor — their code, else our name/desc. */
  primary: string;
  /** Our product name, shown beneath when a vendor code is the primary. */
  secondary: string | null;
  qtyOrdered: number;
  unit: string | null;
  unitCostMinor: number;
  totalMinor: number;
}
interface PoBlock {
  name: string;
  lines: PoLine[];
}

async function buildPoData(purchaseId: string): Promise<{
  business: Awaited<ReturnType<typeof getBusinessSettings>>;
  vendor: Awaited<ReturnType<typeof getVendor>> | null;
  shipTo: Awaited<ReturnType<typeof resolveShipTo>>;
  purchase: Awaited<ReturnType<typeof getPurchase>>;
  blocks: PoBlock[];
  totalMinor: number;
}> {
  const purchase = await getPurchase(purchaseId);
  const [items, sections, business, totalMinor, shipTo] = await Promise.all([
    listItems(purchaseId),
    listSections(purchaseId),
    getBusinessSettings(),
    invoiceTotalMinor(purchaseId),
    resolveShipTo(purchase.vendorId),
  ]);
  const vendor = purchase.vendorId ? await getVendor(purchase.vendorId) : null;

  // The vendor's own code per variant, where mapped.
  const vendorCode = new Map<string, string>();
  if (purchase.vendorId) {
    for (const c of await listCodesForVendor(purchase.vendorId)) {
      vendorCode.set(c.variantId, c.code);
    }
  }

  // Display name + unit per variant.
  const variantIds = [
    ...new Set(items.map((i) => i.variantId).filter((v): v is string => !!v)),
  ];
  const variantInfo = new Map<string, { name: string; unit: string }>();
  if (variantIds.length) {
    const rows = await db
      .select({
        id: productVariants.id,
        label: productVariants.label,
        unit: productVariants.unit,
        productName: products.name,
      })
      .from(productVariants)
      .innerJoin(products, eq(productVariants.productId, products.id))
      .where(inArray(productVariants.id, variantIds));
    for (const r of rows) {
      variantInfo.set(r.id, {
        name: r.label ? `${r.productName} (${r.label})` : r.productName,
        unit: r.unit,
      });
    }
  }

  const toLine = (item: (typeof items)[number]): PoLine => {
    const info = item.variantId ? variantInfo.get(item.variantId) : undefined;
    const code = item.variantId ? vendorCode.get(item.variantId) : undefined;
    const name = info?.name ?? item.description?.trim() ?? "Item";
    return {
      primary: code ?? name,
      secondary: code ? name : null,
      qtyOrdered: item.qtyOrdered,
      // "piece" is the default unit and adds nothing; show only real units.
      unit: info && info.unit !== "piece" ? info.unit : null,
      unitCostMinor: item.unitCostMinor,
      totalMinor: item.qtyOrdered * item.unitCostMinor,
    };
  };

  const blockDefs: { name: string; sectionId: string | null }[] = [
    ...sections.map((s) => ({ name: s.name, sectionId: s.id as string | null })),
    { name: "Uncategorized", sectionId: null },
  ];
  const blocks: PoBlock[] = [];
  for (const def of blockDefs) {
    const lines = items.filter((i) => i.sectionId === def.sectionId).map(toLine);
    if (lines.length) blocks.push({ name: def.name, lines });
  }

  return { business, vendor, shipTo, purchase, blocks, totalMinor };
}

// --- Drawing ---

/**
 * Render a purchase order as a designed A4 PDF. Throws PurchaseError
 * (PURCHASE_NOT_FOUND) via `getPurchase` for an unknown id. Prices (Unit Cost,
 * Amount, Total) are hidden unless `showPrices` is explicitly true — a clerk
 * opts in per download; the default print never reveals cost.
 */
export async function renderPurchaseOrderPdf(
  purchaseId: string,
  opts: { showPrices?: boolean } = {},
): Promise<Uint8Array> {
  const cols = makeCols(opts.showPrices === true);
  const { business, vendor, shipTo, purchase, blocks, totalMinor } =
    await buildPoData(purchaseId);

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

  // -- Letterhead: logo box + business identity --
  rect(LOGO_BOX);
  // Embed the uploaded logo (PNG), scaled to fit inside the box with a small
  // inset, preserving aspect ratio. Falls back to the business name centred in
  // the box when there is no logo or the fetch/decode fails.
  const logoEmbedded = await drawLogo(doc, page, business.logoUrl);
  if (!logoEmbedded) {
    const logoText = business.name.trim() || "Company Logo";
    const size = 11;
    const w = bold.widthOfTextAtSize(sanitize(logoText), size) / MM;
    const cx = LOGO_BOX.x + LOGO_BOX.w / 2 - w / 2;
    const cy = LOGO_BOX.y + LOGO_BOX.h / 2 + (size / MM) * 0.35;
    text(Math.max(LOGO_BOX.x + 1, cx), cy, logoText, size, bold);
  }

  // Sender particulars under the logo (label : value). The business name is
  // already in the logo box, so it is not repeated here.
  let hy = LOGO_BOX.y + LOGO_BOX.h + 5;
  const field = (label: string, value: string | null): void => {
    text(LOGO_BOX.x, hy, label, SIZE_LABEL, bold);
    if (value) text(LOGO_BOX.x + 13, hy, value, SIZE_VALUE, font);
    hy += 5;
  };
  field("Telp:", business.phone?.trim() || null);
  field("Email:", business.email?.trim() || null);
  field("Date:", purchase.date);
  if (purchase.sourceDocument?.trim()) field("Ref:", purchase.sourceDocument.trim());

  // -- Vendor block (mid-left "To:"): name + address + contact. Kept compact
  // so it never collides with the table that starts at TABLE_BOX.y. --
  hy += 2.5;
  text(LOGO_BOX.x, hy, "To:", SIZE_LABEL, bold);
  hy += 5;
  const vendorName = vendor?.name ?? purchase.snapshotVendorName;
  text(LOGO_BOX.x, hy, vendorName, SIZE_VALUE + 1, bold);
  hy += 4.5;
  if (vendor?.address?.trim()) {
    // At most two lines, so the block stays above the table.
    for (const ln of wrapLine(sanitize(vendor.address.trim()), font, SIZE_VALUE, 90).slice(0, 2)) {
      text(LOGO_BOX.x, hy, ln, SIZE_VALUE, font, GREY);
      hy += 4;
    }
  }
  const vContact = [vendor?.phone, vendor?.email].filter(Boolean).join("  ");
  if (vContact && hy < TABLE_BOX.y - 2) text(LOGO_BOX.x, hy, vContact, SIZE_VALUE, font, GREY);

  // -- Ship To block (top-right): our address from the address book --
  let sy = 16.83;
  textRight(RIGHT_EDGE, sy, "Ship To:", SIZE_LABEL, bold);
  sy += 6;
  if (shipTo) {
    const shipName = [shipTo.label, shipTo.recipientName].filter(Boolean).join(" - ");
    textRight(RIGHT_EDGE, sy, shipName || business.name, SIZE_VALUE + 1, bold);
    sy += 5;
    for (const raw of shipTo.line.split("\n")) {
      for (const ln of wrapLine(sanitize(raw.trim()), font, SIZE_VALUE, 80)) {
        textRight(RIGHT_EDGE, sy, ln, SIZE_VALUE, font, GREY);
        sy += 4.5;
      }
    }
    if (shipTo.phone?.trim()) {
      textRight(RIGHT_EDGE, sy, shipTo.phone.trim(), SIZE_VALUE, font, GREY);
      sy += 4.5;
    }
  } else {
    // No address book entry — fall back to the business name only.
    textRight(RIGHT_EDGE, sy, business.name.trim() || "-", SIZE_VALUE + 1, bold);
  }

  // -- Title --
  textRight(RIGHT_EDGE, 76.85, "Purchase Order", SIZE_TITLE, bold);

  // -- Items table --
  drawTableFrameAndHeader(page, cols, { font, bold, text, textRight, rect, hline });

  // Cursor for body rows; first row sits below the header band.
  let rowTop = TABLE_BOX.y + HEADER_ROW_H; // mm, top of current row
  const tableBottom = TABLE_BOX.y + TABLE_BOX.h;

  let lineNo = 0;
  for (const block of blocks) {
    // Section subheader row.
    if (rowTop + ROW_H > tableBottom) {
      ({ page, rowTop } = newTablePage(doc, cols, { font, bold }));
    }
    text(cols.no + PAD, rowTop + ROW_H / 2 + 1.4, block.name, SIZE_SECTION, bold);
    hline(TABLE_BOX.x, RIGHT_EDGE, rowTop + ROW_H, 0.4);
    rowTop += ROW_H;

    for (const line of block.lines) {
      lineNo += 1;
      const wrapped = wrapLine(line.primary, font, SIZE_ROW, cols.itemWrapMm);
      const hasSub = line.secondary && line.secondary !== line.primary;
      const rowH = ROW_H + (wrapped.length - 1) * 4 + (hasSub ? 4 : 0);

      if (rowTop + rowH > tableBottom) {
        // Redefine page/cursor and re-bind drawing closures to the new page.
        ({ page, rowTop } = newTablePage(doc, cols, { font, bold }));
      }

      // Zebra stripe behind every other line (drawn first, under the text).
      // Inset horizontally so the fill never covers the box's left / right
      // borders, and redraw the top separator on top of it (the previous row
      // drew that line at this boundary and the fill would otherwise hide it).
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
      page.drawText(String(lineNo), {
        ...at(cols.no + PAD, baseY),
        size: SIZE_ROW,
        font,
      });
      let ty = baseY;
      for (const w of wrapped) {
        page.drawText(sanitize(w), { ...at(cols.item + PAD, ty), size: SIZE_ROW, font });
        ty += 4;
      }
      if (hasSub && line.secondary) {
        page.drawText(sanitize(line.secondary), {
          ...at(cols.item + PAD, ty),
          size: SIZE_ROW - 1.5,
          font,
          color: GREY,
        });
      }
      // Numeric columns, right-aligned, on the first baseline. Unit cost and
      // amount are omitted when prices are hidden.
      const qty = line.unit ? `${line.qtyOrdered} ${line.unit}` : String(line.qtyOrdered);
      drawRight(page, font, cols.qtyRight - PAD, baseY, qty, SIZE_ROW);
      if (cols.showPrices && cols.unitRight != null && cols.amountRight != null) {
        drawRight(page, font, cols.unitRight - PAD, baseY, rp(line.unitCostMinor), SIZE_ROW);
        drawRight(page, font, cols.amountRight - PAD, baseY, rp(line.totalMinor), SIZE_ROW);
      }

      hline(TABLE_BOX.x, RIGHT_EDGE, rowTop + rowH, 0.25);
      rowTop += rowH;
    }
  }

  if (blocks.length === 0) {
    text(cols.item + PAD, rowTop + 5, "(no items)", SIZE_ROW, font, GREY);
  }

  // -- Total: a band just under the table box. Hidden with prices. --
  const totalY = tableBottom + 7;
  if (cols.showPrices && cols.unitRight != null && cols.amountRight != null) {
    drawRight(page, bold, cols.unitRight - PAD, totalY, "Total", SIZE_ROW + 1);
    drawRight(page, bold, cols.amountRight - PAD, totalY, rp(totalMinor), SIZE_ROW + 1);
  }

  // -- Footer (business poFooter), bottom of page 1's flow --
  if (business.poFooter?.trim()) {
    let fy = totalY + 10;
    for (const ln of wrapLine(sanitize(business.poFooter.trim()), font, 8, TABLE_BOX.w)) {
      text(TABLE_BOX.x, fy, ln, 8, font, GREY);
      fy += 4.5;
    }
  }

  return doc.save();
}

/** Draw the table outline and the column-header band on the current page. */
function drawTableFrameAndHeader(
  page: PDFPage,
  cols: Cols,
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
  text(cols.no + PAD, hy, "No", SIZE_TH, bold);
  text(cols.item + PAD, hy, "Item", SIZE_TH, bold);
  textRight(cols.qtyRight - PAD, hy, "Qty", SIZE_TH, bold);
  if (cols.showPrices && cols.unitRight != null && cols.amountRight != null) {
    textRight(cols.unitRight - PAD, hy, "Unit Cost", SIZE_TH, bold);
    textRight(cols.amountRight - PAD, hy, "Amount", SIZE_TH, bold);
  }
  hline(TABLE_BOX.x, RIGHT_EDGE, TABLE_BOX.y + HEADER_ROW_H, 0.75);
}

/**
 * Fetch and embed the logo PNG inside LOGO_BOX (aspect-fit, small inset).
 * Returns false — so the caller can fall back to a text placeholder — when
 * there is no URL or anything goes wrong (network, non-PNG, decode error).
 */
async function drawLogo(
  doc: PDFDocument,
  page: PDFPage,
  logoUrl: string | null,
): Promise<boolean> {
  if (!logoUrl) return false;
  try {
    const res = await fetch(logoUrl);
    if (!res.ok) return false;
    const bytes = new Uint8Array(await res.arrayBuffer());
    const img = await doc.embedPng(bytes);

    const inset = 2; // mm
    const boxW = (LOGO_BOX.w - inset * 2) * MM;
    const boxH = (LOGO_BOX.h - inset * 2) * MM;
    const scale = Math.min(boxW / img.width, boxH / img.height);
    const w = img.width * scale;
    const h = img.height * scale;
    // Centre within the box; PDF y is bottom-left.
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
 * page 1 only). Returns the new page and the body-row cursor. The caller's
 * drawing closures must be rebound — they are recreated against `page` in the
 * caller via the returned handle.
 */
function newTablePage(
  doc: PDFDocument,
  cols: Cols,
  fonts: { font: PDFFont; bold: PDFFont },
): { page: PDFPage; rowTop: number } {
  const page = doc.addPage([PAGE_W, PAGE_H]);
  const { font, bold } = fonts;
  // Local closures bound to this page.
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
  drawTableFrameAndHeader(page, cols, { font, bold, text, textRight, rect, hline });
  return { page, rowTop: TABLE_BOX.y + HEADER_ROW_H };
}
