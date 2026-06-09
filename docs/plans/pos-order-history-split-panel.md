# Plan: Flutter POS — Order History Split Panel + Return Flow

**Goal:** Replace the current tap-to-navigate order history with a side-by-side split panel: left side shows the order list, right side shows the selected order's detail. Apply the same pattern to the return flow.

**Current behavior:** Tapping an order in `OrderHistoryScreen` pushes `_OrderDetailScreen` as a full-screen route. Returning means popping back, losing context of which order was selected.

**Desired behavior:** A two-panel layout — list stays visible on the left, detail appears on the right when an order is tapped. Same for the return screen.

---

## 1. Files involved

| File | Purpose |
|------|---------|
| `packages/pos/lib/screens/order_history_screen.dart` | Main screen to restructure (599 lines) |

---

## 2. Implementation

### Step A — Replace the tap-to-navigate with panel selection

**Current** (lines 133–143 in `_orderTile`):
```dart
onTap: () async {
    await Navigator.of(context).push(MaterialPageRoute(
        builder: (_) => _OrderDetailScreen(
            orderId: o['id'] as String,
            posSessionId: widget.posSessionId,
        ),
    ));
    _reload();
},
```

**Replace with:** A selected-order state variable and a split layout. The `onTap` sets the selected order instead of navigating.

### Step B — Add state for the selected order

In `_OrderHistoryScreenState`:

```dart
Map<String, dynamic>? _selectedOrder;
```

### Step C — Restructure `build` to use a `Row` with two panels

```dart
@override
Widget build(BuildContext context) {
    return Scaffold(
        appBar: AppBar(title: const Text('Orders')),
        body: Row(
            children: [
                // Left panel: order list
                SizedBox(
                    width: MediaQuery.of(context).size.width * 0.4,
                    child: Column(
                        children: [
                            // Scope toggle (SegmentedButton) — keep existing
                            Padding(
                                padding: const EdgeInsets.all(12),
                                child: SegmentedButton<_Scope>(...),
                            ),
                            Expanded(child: _buildList()),
                        ],
                    ),
                ),
                const VerticalDivider(width: 1),
                // Right panel: detail or placeholder
                Expanded(
                    child: _selectedOrder != null
                        ? _OrderDetailPanel(
                            orderId: _selectedOrder!['id'] as String,
                            posSessionId: widget.posSessionId,
                            onReturnComplete: _reload,
                          )
                        : const Center(
                            child: Text('Select an order to view details'),
                          ),
                ),
            ],
        ),
    );
}
```

### Step D — Extract the detail view into a non-navigating widget

The current `_OrderDetailScreen` is a `StatefulWidget` that calls `Navigator.pop`. Extract its `build` method into a new `_OrderDetailPanel` widget that takes an `onReturnComplete` callback instead of popping:

```dart
class _OrderDetailPanel extends StatefulWidget {
    const _OrderDetailPanel({
        required this.orderId,
        required this.posSessionId,
        required this.onReturnComplete,
    });
    final String orderId;
    final String posSessionId;
    final VoidCallback onReturnComplete;

    @override
    State<_OrderDetailPanel> createState() => _OrderDetailPanelState();
}
```

Replace any `Navigator.pop(context, true)` calls with `widget.onReturnComplete()`.

### Step E — Highlight the selected order in the list

In `_orderTile`, check if this order is the currently selected one:

```dart
final isSelected = _selectedOrder?['id'] == o['id'];
return ListTile(
    selected: isSelected,
    selectedTileColor: Theme.of(context).colorScheme.primaryContainer.withOpacity(0.3),
    // ... rest unchanged
);
```

### Step F — Return flow: same pattern

The current `_startReturn` method (line 181) navigates to `ReturnScreen`. Instead, show the `ReturnScreen` in the right panel:

```dart
Widget? _returnPanel; // state variable

// When starting a return:
void _startReturn(Map<String, dynamic> o) {
    final items = ...; // same as current
    setState(() {
        _returnPanel = ReturnScreen(
            originalOrderId: widget.orderId,
            posSessionId: widget.posSessionId,
            items: items,
        );
    });
}
```

In the right panel:
```dart
child: _returnPanel ?? (_selectedOrder != null
    ? _OrderDetailPanel(...)
    : const Center(child: Text('Select an order to view details'))),
```

When the return completes, clear `_returnPanel` and call `_reload()`.

---

## 3. Responsive fallback (optional)

On narrow screens (phones in portrait), the split panel is too cramped. Add a breakpoint:

```dart
final isWide = MediaQuery.of(context).size.width > 600;
if (!isWide) {
    // Fall back to current navigation behavior for narrow screens
    return _buildNarrowLayout();
}
return _buildSplitLayout();
```

---

## 4. Verification checklist

- [ ] On a wide screen (tablet/desktop), order list appears on the left
- [ ] Tapping an order shows its detail on the right without navigation
- [ ] The selected order is highlighted in the list
- [ ] Tapping a different order switches the detail panel
- [ ] Return flow works from the detail panel
- [ ] After a return, the list refreshes and the detail updates
- [ ] On narrow screens (phone), the old navigation behavior still works
- [ ] The return panel replaces the detail panel when active
- [ ] After completing a return, the detail panel returns

---

## 5. Notes

- This is a significant UX restructure of a 599-line file. Break it into small, testable commits.
- The `_OrderDetailScreen` currently pushes as a full route — extracting it to a panel widget means replacing `Navigator.pop` with callbacks. Search for all `Navigator.of(context).pop` calls in the detail screen and replace them.
- The `ReturnScreen` is a separate class in the same file — it may also use `Navigator.pop`. Same treatment.
- Test on both tablet (wide) and phone (narrow) form factors.
