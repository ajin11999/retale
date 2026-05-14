# Future Features

Parked ideas raised during design that aren't in `design-decisions.md` yet. Pick up when their consumer (frontend, importer, etc.) actually needs them.

---

## Online catalog website

Public-facing website surfacing products from Retale — info, images, optional stock and price visibility.

### Per-product visibility toggles

**Price display mode** (3 options):
- `exclude` — no price shown
- `peek` — masked like "Rp2xx.xxx" (order of magnitude, last digits hidden)
- `show` — actual price visible

**Stock display mode** (3 options):
- `show_real` — actual qty visible
- `peek` — fuzzy ("< 10", "potentially sold out")
- `hide` — no stock info (fasteners, items with uncertain stock)

### Product info shown

- **Markdown description** — render `products.description` as markdown. Column already exists (`TEXT NULL`); no schema change needed. Document the markdown convention when implementing.
- **Product images** — already in schema (`product_images` table with filename, mime, dimensions, sort_order, variant-level override + product-level fallback). Catalog reuses the same resolution rules.

### Likely schema additions

Three columns on `products`:

```
online_visible       BOOLEAN NOT NULL DEFAULT false              -- master switch
online_price_mode    ENUM('exclude','peek','show') NOT NULL DEFAULT 'exclude'
online_stock_mode    ENUM('show_real','peek','hide') NOT NULL DEFAULT 'hide'
```

Defaults are conservative — nothing leaks until the workshop explicitly opts a product in.

**Why:** Customer-facing window to check stock and read product details, without exposing pricing to competitors and without lying about stock for uncountable items.

---

## Delivery completeness UI + API

Clerk-friendly flow for receiving partial deliveries: check items in the box, hit Send, done.

### UX shape

On a purchase's detail page:

1. Show all `purchase_items` with their current `qty_ordered` / `qty_delivered` / `remaining` (`qty_ordered − qty_delivered`).
2. Checkbox per line + qty input (default = `remaining`).
3. **"Send checked items to be marked as delivered"** button → builds a new `purchase_delivery` (status=`draft`), writes a leaf `purchase_delivery_item` per checked line with the chosen qty, then commits the delivery (draft → delivered) atomically. Stock movements + WAC recompute happen as part of the commit.

### API surface to build

Probably one resolver:

```
markPurchaseItemsDelivered(
  purchaseId: ULID,
  targetLocationId: ULID,
  lines: [{ purchaseItemId: ULID, qty: BigInt }]
): PurchaseDelivery
```

Internally: build the delivery doc + leaves, then run the existing `commitDelivery` machinery. One transaction.

Plus a read resolver for the page itself — most fields are already on `purchase_items` (`qty_ordered`, `qty_delivered`); compute `remaining` server-side for convenience.

### Per-item completeness status (derived)

Each line: `not_started` (qty_delivered=0), `partial` (0 < qty_delivered < qty_ordered), `complete` (qty_delivered == qty_ordered).

Also handles non-stock lines (variant_id NULL): same completeness rules but no stock movement on commit.

**Why:** Partial deliveries from vendors are common. The natural clerk flow is "check what's in this box, hit Send" — not "create a delivery doc, then add leaves manually."
