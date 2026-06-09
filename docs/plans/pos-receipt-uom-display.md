# Plan: Flutter POS — Receipt Print: Show Product UOM Instead of "units"

**Goal:** The printed receipt currently labels every line as "units" (e.g., "3 units"). Instead, show the variant's actual unit of measure: "piece", "g", "ml", "mm".

**Current behavior** (inferred): The receipt PDF or print layout renders quantity as "N units" or just "N" without the unit.

---

## 1. What exists

| Layer | State |
|-------|-------|
| API | `ProductVariant.unit` returns `VariantUnit!` — one of `piece`, `g`, `ml`, `mm` |
| POS cart | `CartLine` stores a `variant` with `unit` field |
| POS receipt model | `ReceiptLine` has `name`, `qty`, `unitPriceMinor`, `lineTotalMinor` — but **no unit field** |
| POS receipt PDF | `receipt_pdf.dart` — builds the printable PDF |
| POS receipt message | `receipt.dart` `toMessage()` — `'${line.qty} × ${line.name}'` — no unit shown |

---

## 2. Implementation

### Step A — Add `unit` to `ReceiptLine`

**File:** `packages/pos/lib/receipt/receipt.dart`

```dart
class ReceiptLine {
    const ReceiptLine({
        required this.name,
        required this.qty,
        required this.unitPriceMinor,
        required this.lineTotalMinor,
        this.unit, // NEW
    });

    final String name;
    final int qty;
    final int unitPriceMinor;
    final int lineTotalMinor;
    final String? unit; // NEW — "piece", "g", "ml", "mm"
}
```

### Step B — Pass unit when building receipt lines

**File:** `packages/pos/lib/receipt/receipt.dart`

In `Receipt.fromOrderDetail`, the factory constructor maps order items to `ReceiptLine`. Add `unit` from the item data:

```dart
.map((it) => ReceiptLine(
    name: it['displayName'] as String,
    qty: (it['qty'] as num).toInt(),
    unitPriceMinor: (it['snapshotPriceMinor'] as num).toInt(),
    lineTotalMinor: (it['lineTotalMinor'] as num).toInt(),
    unit: it['snapshotUnit'] as String?, // NEW — from the order item snapshot
))
```

**Important:** The order item snapshot must include `snapshotUnit`. Check if the API's `OrderItem` type already has `snapshotUnit`. If not, you'll need to add it to the GraphQL schema and the order creation service. Search for `snapshotUnit` in the API codebase.

### Step C — Also handle the cart checkout path

**File:** `packages/pos/lib/screens/register_screen.dart` (or wherever the receipt is built from the cart)

When building a `Receipt` from the current cart (not from order history), the `CartLine` already has access to the variant's unit. Pass it through to `ReceiptLine`:

```dart
ReceiptLine(
    name: line.displayName,
    qty: line.qty,
    unitPriceMinor: line.unitPriceMinor,
    lineTotalMinor: line.lineTotalMinor,
    unit: line.variant.unit, // from the cart's variant data
)
```

### Step D — Update the receipt PDF to show the unit

**File:** `packages/pos/lib/receipt/receipt_pdf.dart`

Find where the quantity is rendered (likely a row with qty + name + price). Change from:

```
3  Product Name  Rp 30.000
```

To:

```
3 piece  Product Name  Rp 30.000
```

The unit string should appear after the qty, before the product name, in a smaller or lighter font to distinguish it from the name.

### Step E — Update the WhatsApp message text (optional)

**File:** `packages/pos/lib/receipt/receipt.dart` — `toMessage()`

Current: `'${line.qty} × ${line.name}'`

Change to: `'${line.qty} ${line.unit ?? ''} × ${line.name}'`

---

## 3. Investigate first

Before coding, answer:

1. Does `OrderItem` already have `snapshotUnit` in the API? Search for `snapshotUnit` in `packages/api/src/db/schema/orders.ts`.
2. If not, add it as a migration column (VARCHAR, nullable, default null) and populate it during order creation in `order-service.ts`.
3. Does the `orderDetail` GraphQL query in `packages/pos/lib/graphql/operations.dart` already include the unit? If not, add it.

---

## 4. Verification checklist

- [ ] `ReceiptLine` has a `unit` field
- [ ] Printed receipt shows "3 piece" instead of "3" or "3 units"
- [ ] WhatsApp message shows "3 piece × Product Name"
- [ ] Different products show their correct unit (g, ml, mm, piece)
- [ ] Historical orders (pre-migration) fall back gracefully — show nothing or "piece" as default
- [ ] Cart-to-receipt flow passes unit through correctly

---

## 5. Notes

- If `snapshotUnit` doesn't exist in the API yet, this becomes a 3-layer change: DB migration + order-service + Flutter. Budget extra time.
- The user only asked about the **printed** receipt — the PDF. But the WhatsApp message text change is so similar it makes sense to do both at once.
