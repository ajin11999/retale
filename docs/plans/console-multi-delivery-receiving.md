# Plan: Console — Multi-Delivery Support for Purchase Orders

**Problem:** The user says "deliveries exceeds ordered from PO. A PO may have one or more deliveries, because goods may arrive via different transits, and pricing varies between expeditions/couriers."

**Status:** The **receiving check API is already complete** (`receiving-service.ts`, `receiving.ts` schema) and supports:
- Multiple deliveries per PO (each committed check is a separate `purchase_delivery`)
- Save-as-you-go draft counting with resume
- `OVER_DELIVERY` guard: prevents counting past `qtyOrdered − qtyDelivered`
- Different landed costs per delivery (courier fees vary)

The likely gap is in the **console UI** — the purchase detail page may not expose the receiving check flow, or the deliveries page doesn't link back to purchases clearly.

---

## 1. Investigation (do this first)

1. **Check the console purchase detail page** (`packages/console/src/routes/(app)/purchases/[id]/+page.svelte`):
   - Is there a "Receive" or "Start receiving" button?
   - Does it link to the receiving check flow?
   - Does it show `qtyDelivered` vs `qtyOrdered` per line?

2. **Check the console deliveries page** (`packages/console/src/routes/(app)/deliveries/+page.svelte`):
   - Does it show the purchase each delivery is linked to?
   - Can you filter deliveries by purchase?

3. **Check the console delivery detail page** (`packages/console/src/routes/(app)/deliveries/[id]/+page.svelte`):
   - When `purchaseId` is set, does it show the "receiving check" context?
   - Can you resume a draft check?

---

## 2. Likely gaps to fix

### Gap A — Purchase detail page: no "Receive goods" button

**File:** `packages/console/src/routes/(app)/purchases/[id]/+page.svelte`

Add a "Receive goods" button that calls `startReceivingCheck` (or resumes the open one) and navigates to the receiving view. The button should only show when the purchase is `open`.

```svelte
{#if purchase.status === "open"}
    <Button onclick={startReceiving}>
        {openCheck ? "Resume receiving" : "Receive goods"}
    </Button>
{/if}
```

Query `openReceivingCheck(purchaseId)` to check if one is already in progress.

### Gap B — No receiving check screen in the console

The receiving check API (`startReceivingCheck`, `setReceivingCheckLine`, `resolveReceivingScan`, `commitReceivingCheck`) has no corresponding console UI. The API is fully built but the console has no screen to use it.

**Create:** A new route or inline panel at the purchase detail page that:
1. Shows `receivingCheckLines` (ordered / delivered / remaining / qtyInCheck)
2. Lets the clerk enter qty per line (or scan)
3. Auto-saves on each line change via `setReceivingCheckLine`
4. Has a "Commit" button that calls `commitReceivingCheck`

**Simplest approach:** Add an inline receiving panel to the purchase detail page, toggled by the "Receive goods" button. No new route needed.

### Gap C — Delivery detail doesn't show purchase context

When viewing a delivery that is a receiving check (`purchaseId` is set), show a link back to the purchase and display completeness status per line.

---

## 3. Recommended implementation (smallest viable)

**Focus on Gap A + a minimal Gap B** — the inline receiving panel on the purchase detail page.

### Step 1 — Query the open check on purchase detail

Add to the purchase detail GraphQL query:

```graphql
openReceivingCheck(purchaseId: $id) {
    id
    status
    targetLocation { id name }
}
receivingCheckLines(purchaseId: $id) {
    purchaseItem { id qtyOrdered qtyDelivered }
    remaining
    qtyInCheck
    status
    provisionalStatus
}
```

### Step 2 — Add "Receive goods" button

If purchase is `open` and user has `delivery.draft`:
- If `openReceivingCheck` exists → "Resume receiving"
- Else → "Receive goods"

### Step 3 — Inline receiving panel

When receiving mode is active, show a table of purchase lines with:
- Item description
- Qty ordered
- Qty already delivered (from prior deliveries)
- Qty in this check (editable number input)
- Status indicator (not_started / partial / complete)

Each qty change calls `setReceivingCheckLine` (debounced or on blur).

A "Commit receiving" button at the bottom calls `commitReceivingCheck`.

A "Cancel" button discards the draft (needs a `deleteDelivery` mutation or similar — check if one exists).

### Step 4 — After commit

Refresh the purchase detail to show updated `qtyDelivered` values.

---

## 4. Verification checklist

- [ ] Purchase detail page shows "Receive goods" button for open purchases
- [ ] Clicking it opens the receiving panel
- [ ] Receiving panel shows all purchase lines with ordered/delivered/remaining
- [ ] Entering a quantity saves via `setReceivingCheckLine`
- [ ] Reopening the page shows "Resume receiving" if a draft exists
- [ ] Commit button calls `commitReceivingCheck`
- [ ] After commit, the purchase status updates (completes if all lines delivered)
- [ ] Multiple deliveries per PO work: receive some, commit, receive more from a new check
- [ ] `OVER_DELIVERY` error appears if trying to count past what's owed

---

## 5. Notes

- The receiving check API already enforces `OVER_DELIVERY` — no schema changes needed.
- The `purchaseDeliveries` table has `purchaseId` as nullable — receiving checks set it. Manual deliveries don't. This distinction is already handled.
- Houdini sync is needed after adding new GraphQL queries.
- The receiving check draft is currently **not deletable** through the API — `deleteDelivery` exists but may require the delivery to be in draft status. Verify this before adding a "Cancel" button.
- If the full inline receiving panel is too large for one session, start with just the "Receive goods" button that links to the existing deliveries flow with `purchaseId` pre-set.
