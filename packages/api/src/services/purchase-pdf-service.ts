// Purchase PDF service: render a purchase order to a PDF document. It lays
// out the same text the send-message renderer produces — so the PDF and the
// WhatsApp/email body always say the same thing — paginating and wrapping as
// needed. The Flutter client downloads this and shares it as an attachment
// (deep links cannot carry files). Pure read.

import { PageSizes, PDFDocument, type PDFFont, StandardFonts } from "pdf-lib";
import { renderPurchaseOrderMessage } from "./purchase-message-service.ts";

const MARGIN = 50;
const TITLE_SIZE = 14;
const TEXT_SIZE = 10;
const LINE_HEIGHT = 14;

/** Map characters the standard PDF fonts cannot encode to safe ASCII. */
function sanitize(text: string): string {
  return text.replace(/[—–]/g, "-").replace(/[^\x20-\x7E\xA0-\xFF]/g, "?");
}

/** Break a line to fit `maxWidth`, splitting on spaces. */
function wrapLine(
  line: string,
  font: PDFFont,
  size: number,
  maxWidth: number,
): string[] {
  if (font.widthOfTextAtSize(line, size) <= maxWidth) return [line];
  const out: string[] = [];
  let current = "";
  for (const word of line.split(" ")) {
    const candidate = current ? `${current} ${word}` : word;
    if (current && font.widthOfTextAtSize(candidate, size) > maxWidth) {
      out.push(current);
      current = word;
    } else {
      current = candidate;
    }
  }
  if (current) out.push(current);
  return out;
}

/**
 * Render a purchase order as a PDF. Throws PurchaseError (PURCHASE_NOT_FOUND)
 * via `renderPurchaseOrderMessage` for an unknown id.
 */
export async function renderPurchaseOrderPdf(
  purchaseId: string,
): Promise<Uint8Array> {
  const { subject, body } = await renderPurchaseOrderMessage(purchaseId);

  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const [pageW, pageH] = PageSizes.A4;
  const maxWidth = pageW - MARGIN * 2;

  let page = doc.addPage(PageSizes.A4);
  let y = pageH - MARGIN;

  const newPage = (): void => {
    page = doc.addPage(PageSizes.A4);
    y = pageH - MARGIN;
  };

  // Title.
  page.drawText(sanitize(subject), {
    x: MARGIN,
    y: y - TITLE_SIZE,
    size: TITLE_SIZE,
    font: bold,
  });
  y -= TITLE_SIZE + LINE_HEIGHT;

  // Body — one source line at a time, wrapped and paginated.
  for (const raw of body.split("\n")) {
    if (raw.trim() === "") {
      y -= LINE_HEIGHT;
      if (y < MARGIN) newPage();
      continue;
    }
    for (const line of wrapLine(sanitize(raw), font, TEXT_SIZE, maxWidth)) {
      if (y - TEXT_SIZE < MARGIN) newPage();
      page.drawText(line, { x: MARGIN, y: y - TEXT_SIZE, size: TEXT_SIZE, font });
      y -= LINE_HEIGHT;
    }
  }

  return doc.save();
}
