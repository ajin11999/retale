# Plan: Flutter POS — Closing Shift: Show Expected Cash

**Goal:** When the clerk opens the "Close shift" dialog, show how much cash should be in the drawer (opening float + net cash sales) so they can compare it to their physical count.

**Current behavior:** The close shift dialog only shows "Count the cash in the drawer to close the shift." and a text field for the counted amount. No expected amount is displayed.

---

## 1. What exists

| Layer | State |
|-------|-------|
| API | `closeSession(sessionId, closingCashMinor)` computes `expected = openingCashMinor + cashSalesMinor` server-side and records `variance = closing − expected` |
| API | No GraphQL field exposes the expected cash before close — it's computed inside the `closeSession` transaction |
| POS | `_closeShift()` in `register_screen.dart` shows a simple dialog with a text field |
| POS | `widget.session` has `openingCashMinor` |

---

## 2. Implementation approach: Add `expectedCashMinor` to the session

The cleanest approach is to add a computed field to `PosSession` in the GraphQL API so the Flutter app can display it before closing.

### Step A — API: Add `sessionTotals` query or `expectedCashMinor` field

**Option 1 (simpler):** Add an `expectedCashMinor` field to `PosSession` that computes `openingCashMinor + cashSalesForSession`.

**File:** `packages/api/src/schema/pos.ts`

```graphql
type PosSession {
    # ... existing fields ...
    "The cash that should be in the drawer right now: opening float + net cash sales."
    expectedCashMinor: Float!
}
```

**File:** `packages/api/src/services/pos-service.ts`

Add a function:
```typescript
export async function expectedCashMinor(sessionId: string): Promise<number> {
    const session = await db.query.posSessions.findFirst({
        where: eq(posSessions.id, sessionId),
    });
    if (!session) throw new PosError("SESSION_NOT_FOUND");
    const totals = await sessionTotals(db, sessionId);
    return session.openingCashMinor + totals.cashSalesMinor;
}
```

Wire it in the resolver:
```typescript
PosSession: {
    // ... existing resolvers ...
    expectedCashMinor: (s: { id: string }) => pos.expectedCashMinor(s.id),
},
```

### Step B — POS: Query expected cash before showing the dialog

**File:** `packages/pos/lib/graphql/operations.dart`

Add `expectedCashMinor` to the session query:

```graphql
query PosSessions($posId: ID!) {
    posSessions(posId: $posId, limit: 5) {
        id posId openingCashMinor expectedCashMinor openedAt closedAt
    }
}
```

Or add a dedicated query:

```graphql
query SessionExpectedCash($id: ID!) {
    posSession(id: $id) {
        id
        expectedCashMinor
    }
}
```

### Step C — POS: Display expected cash in the close dialog

**File:** `packages/pos/lib/screens/register_screen.dart`

In `_closeShift()`, fetch the expected cash and show it above the text field:

```dart
Future<void> _closeShift() async {
    // Fetch expected cash
    int expectedCash = widget.session.openingCashMinor; // fallback
    try {
        final data = await GraphQLService.instance.query(
            Ops.sessionExpectedCash,
            variables: {'id': widget.session.id},
        );
        expectedCash = (data['posSession']['expectedCashMinor'] as num).toInt();
    } catch (_) {
        // Fall back to opening cash only — the server computes it correctly on close anyway
    }

    final controller = TextEditingController(text: '0');
    final confirmed = await showDialog<bool>(
        context: context,
        builder: (ctx) => AlertDialog(
            title: const Text('Close shift'),
            content: Column(
                mainAxisSize: MainAxisSize.min,
                children: [
                    // NEW: show expected cash
                    Text(
                        'Cash that should be in the drawer: ${Money.format(expectedCash)}',
                        style: TextStyle(
                            fontWeight: FontWeight.bold,
                            fontSize: 16,
                        ),
                    ),
                    const SizedBox(height: 8),
                    const Text('Count the cash in the drawer and enter the amount below.'),
                    const SizedBox(height: 12),
                    TextField(
                        controller: controller,
                        keyboardType: TextInputType.number,
                        inputFormatters: [ThousandsSeparatorInputFormatter()],
                        decoration: const InputDecoration(
                            labelText: 'Closing cash count',
                            border: OutlineInputBorder(),
                        ),
                    ),
                ],
            ),
            // ... actions unchanged
        ),
    );
    // ... rest unchanged
}
```

---

## 3. Simpler alternative (no API change)

If you want to avoid API changes, compute the expected cash client-side from the session's orders:

```dart
// Sum cash payments from orders in this session
int cashSales = 0;
for (final order in _sessionOrders) {
    for (final payment in (order['payments'] as List<dynamic>)) {
        final p = payment as Map<String, dynamic>;
        if (p['method'] == 'cash') {
            cashSales += (p['amountMinor'] as num).toInt();
        }
        // Subtract refunds
        if (p['method'] == 'cash_refund') {
            cashSales -= (p['amountMinor'] as num).toInt();
        }
    }
}
final expectedCash = widget.session.openingCashMinor + cashSales;
```

This avoids API changes but requires fetching all session orders before showing the dialog. More network overhead, simpler code.

---

## 4. Verification checklist

- [ ] Opening the close shift dialog shows the expected cash amount
- [ ] Expected cash = opening float + cash payments − cash refunds
- [ ] If the order has no cash sales yet, expected cash = opening float
- [ ] If the expected cash fetch fails, the dialog still works (falls back gracefully)
- [ ] The variance (difference between counted and expected) is still computed correctly on the server
- [ ] Test with multiple orders: some cash, some tracking, some refunds

---

## 5. Notes

- `Money.format()` expects an integer in minor units (cents/rupiah). Ensure `expectedCash` is in minor units.
- The `sessionTotals` function in `pos-service.ts` uses `db.transaction` — it must be callable outside a transaction. The new `expectedCashMinor` function should use a plain `db` (not `tx`) since it's called from a resolver, not inside a transaction.
- The server already computes variance correctly on close — this change is purely for the UI to help the clerk count accurately.
