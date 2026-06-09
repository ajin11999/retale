# Plan: Console — Variant Sales Search (POS Sessions)

**Goal:** Add a search box to the POS session variant sales page so staff can quickly find a product/variant by name or SKU instead of scrolling through the full table.

**Scope:** Console UI only. No API changes needed — `sessionVariantSales` already returns all data.

---

## 1. What exists already

| Layer | State |
|-------|-------|
| API | `sessionVariantSales(sessionId)` returns `variantId, productName, variantLabel, sku, qtySold, revenueMinor, costMinor` |
| Console page | `sessions/[id]/variants/+page.svelte` — full table, no search |
| Data | `rows` is derived from `$SessionVariants.data?.sessionVariantSales` |
| Totals | Computed `totals` (qty, revenue, cost) aggregates all `rows` |

---

## 2. Implementation

**File:** `packages/console/src/routes/(app)/sessions/[id]/variants/+page.svelte`

### Step A — Add search state and filtered rows

Add after the existing `rows` derivation (around line 29):

```svelte
let search = $state("");

const filtered = $derived(
  search.trim()
    ? rows.filter((r) => {
        const q = search.toLowerCase();
        return (
          r.productName.toLowerCase().includes(q) ||
          (r.variantLabel?.toLowerCase().includes(q) ?? false) ||
          r.sku.toLowerCase().includes(q)
        );
      })
    : rows,
);
```

### Step B — Recompute totals from filtered rows

Update the `totals` derivation to use `filtered` instead of `rows`:

```typescript
const totals = $derived.by(() =>
  filtered.reduce(
    (t, r) => ({
      qty: t.qty + r.qtySold,
      revenue: t.revenue + r.revenueMinor,
      cost: t.cost + r.costMinor,
    }),
    { qty: 0, revenue: 0, cost: 0 },
  ),
);
```

### Step C — Add the search input in the template

Insert a search input between the page header and the table. Find the `<div class="overflow-hidden rounded-lg border bg-card">` table wrapper and add above it:

```svelte
<div class="flex items-center gap-2">
  <input
    type="search"
    placeholder="Search by name, variant, or SKU…"
    bind:value={search}
    class="w-full max-w-sm rounded-md border bg-background px-3 py-1.5 text-sm placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring"
  />
  {#if search}
    <span class="text-xs text-muted-foreground">
      {filtered.length} of {rows.length} results
    </span>
  {/if}
</div>
```

### Step D — Update the `{#each}` to iterate over `filtered`

Change `{#each rows as r ...}` to `{#each filtered as r ...}`.

### Step E — Update the "no results" empty state

Change the empty state message to distinguish between "no data at all" and "no search matches":

```svelte
{#if rows.length === 0}
  <tr>
    <td colspan="7" class="px-4 py-10 text-center text-muted-foreground">
      No variants sold in this session.
    </td>
  </tr>
{:else if filtered.length === 0}
  <tr>
    <td colspan="7" class="px-4 py-10 text-center text-muted-foreground">
      No variants match "{search}".
    </td>
  </tr>
{:else}
  <!-- the totals row stays -->
```

---

## 3. Full template layout after changes

```
[← Back to session]
[Header: Variant sales · session xxxxxxxx]
[Opened ... · closed ...]

[Search input ________________]  [N of M results]

[Table:
  Product | SKU | Qty sold | Revenue | Cost | Margin | Margin %
  ──────────────────────────────────────────────────────────
  (filtered rows)
  ──────────────────────────────────────────────────────────
  Total   |     | NN       | ...     | ...  | ...    | ...%
]
```

---

## 4. Verification checklist

- [ ] Typing in the search box filters the table in real time
- [ ] Search matches on `productName` (e.g. "Bolt" matches "Stainless Bolt M8")
- [ ] Search matches on `variantLabel` (e.g. "Blue" matches a variant labeled "Blue, Large")
- [ ] Search matches on `sku` (e.g. "BLT-M8-SS" finds the exact SKU)
- [ ] Search is case-insensitive
- [ ] Clearing the search box restores the full table
- [ ] The "N of M results" counter is accurate
- [ ] Totals row recalculates to match only the filtered rows
- [ ] When no results match, the empty state shows the search term
- [ ] When the session has no sales at all, the original "No variants sold" message still appears (not the search-empty message)
- [ ] Run `bun run dev:console` and verify visually

---

## 5. Notes

- **No Houdini sync needed** — the GraphQL query is unchanged.
- **Client-side filtering only** — the API always returns all rows; search just narrows what's visible. This is correct for the typical session size (dozens to low hundreds of variants).
- **Totals update with search** — this is intentional. When a manager searches "Bolts", the totals should reflect only bolt revenue/margin, not the whole session.
- **Style:** Use the same input styling as other search boxes in the console for consistency. Check `packages/console/src/lib/components/ui/input.svelte` — there's already a shared `Input` component you can use instead of a raw `<input>`:

```svelte
import Input from "$lib/components/ui/input.svelte";
<!-- then: -->
<Input type="search" placeholder="Search…" bind:value={search} class="max-w-sm" />
```
