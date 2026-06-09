# Plan: Quick Fixes — Auth Token + PDF Whitespace + WhatsApp Text

Three small, independent fixes. Each takes 5–15 minutes.

---

## Fix 1: Auth — 30-day token lifetime

**Problem:** Access tokens expire after 60 minutes. Staff are logged out mid-shift.

**File:** `packages/api/src/lib/jwt.ts`

**Change:** Line 10: `const ACCESS_TOKEN_TTL = "60m";` → `const ACCESS_TOKEN_TTL = "30d";`

**Verification:** Sign in, note the token expiry. Should be 30 days from issue, not 60 minutes.

**Note:** The CLAUDE.md says "365-day expiration" — this 30d value is a reasonable middle ground. If the business wants 365d, change to `"365d"` instead.

---

## Fix 2: Purchase PDF — second page whitespace

**Problem:** When a purchase order spans two pages, the second page has a large blank area at the top — same height as the first page's header (business name, vendor block, PO title).

**Root cause:** The PDF renderer likely repeats the header area on every page, or the table's starting Y-position is computed once and reused on subsequent pages without accounting for the fact that continuation pages shouldn't reserve header space.

**File:** `packages/api/src/services/purchase-pdf-service.ts`

**Investigation steps:**

1. Find where the table starts. Look for `TABLE_BOX` (line 39: `{ x: 11.82, y: 85.39, w: 187.44, h: 142.86 }`). The `y: 85.39` is the table's top — it reserves ~85mm for the header on page 1.

2. Find the pagination logic. Search for where a new page is created (`addPage`, `newPage`, or similar). Look for where `TABLE_BOX.y` or the table's starting Y is referenced.

3. On the first page, the table starts at `y: 85.39mm` (below the header). On subsequent pages, the table should start much higher — near `y: 15mm` or similar top margin — because there's no header to repeat.

**Likely fix:** Track whether we're on page 1 vs a continuation page. Set `tableTopY` differently:

```typescript
const headerHeight = 85.39; // mm — reserved on page 1
const continuationTop = 15;  // mm — top margin on subsequent pages
let tableTopY = headerHeight;

// When starting a new page:
if (pageNumber > 1) {
    tableTopY = continuationTop;
}
```

**Verification:** Generate a PO PDF with enough line items to span 2+ pages. Page 2 should start its table near the top edge with only a small margin.

---

## Fix 3: WhatsApp — strip chat text from purchase/order sends

**Problem:** When sending a purchase order or sales receipt to WhatsApp, the message body includes business greeting, headers ("PURCHASE ORDER"), from/to blocks, and footer text. The user wants only the line items (the "receipt").

### 3a: Purchase order WhatsApp message

**File:** `packages/api/src/services/purchase-message-service.ts`

**Current behavior** (lines 92–130): The `renderPurchaseOrderMessage` function builds:
```
[greeting]

PURCHASE ORDER
From: Business Name
Phone · Email
Date: 2026-06-09
Ref: DOC-001

To: Vendor Name

[section name]
  - Item — qty @ price = total

Total: Rp xxx

[footer]
```

**Desired behavior:** Only the line items and total:
```
[section name]
  - Item — qty @ price = total

Total: Rp xxx
```

**Change:** In `renderPurchaseOrderMessage`, remove lines 93–103 (greeting, PURCHASE ORDER header, from/contact/date/ref, To block) and lines 124 (footer). Keep only the section blocks and total:

```typescript
// Remove: greeting, PURCHASE ORDER header, From/Date/Ref/To block, footer
// Keep: section blocks + total
for (const block of blocks) {
    // ... existing block code ...
}
out.push(`Total: ${rp(await invoiceTotalMinor(purchaseId))}`);
// Remove: footer
```

**Note:** The `subject` field is still used for email. WhatsApp doesn't use it. No change needed there.

### 3b: POS order receipt WhatsApp message

**Investigation needed:** Find where POS order receipts are rendered for WhatsApp. Search for `sendReceipt`, `orderReceipt`, or `wa.me` in the Flutter POS code and API.

**Likely location:** `packages/pos/lib/receipt/` or `packages/api/src/services/order-service.ts`. The receipt text is probably built as a formatted string and sent via the `wa.me` deep link.

**Change:** Similar to 3a — strip the greeting/header/footer, keep only the line items and total.

**Verification:** Send a purchase order to WhatsApp. The message should contain only the item lines and total. No "PURCHASE ORDER" banner, no business greeting, no footer.
