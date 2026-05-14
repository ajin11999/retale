# Retale Design Decisions

Locked-in architectural decisions that drive the Drizzle schema and importer. Decided 2026-05-13. Schema files not yet written.

Retale is a **fresh-design** POS/inventory backend. ProDuck is **not** a schema constraint — only a one-time data source via an importer. Do not preserve ProDuck names, types, PKs, or quirks when implementing.

---

## Locked decisions

1. **IDs — ULID.** Sortable strings, client-generatable. Not bigint autoincrement.
2. **Money — integer minor units** (e.g. cents/rupiah), stored as `BIGINT`. Not `decimal`. Avoids decimal-as-string pain in JS.
3. **Stock model — append-only `stock_movements` ledger.** Columns: product, location, delta, reason, ref_type, ref_id, created_at. `stock_locations.qty` is a cached running total. Replaces ProDuck's qty-only model; gives full traceability and simplifies landed-cost delivery.
4. **Order payments — separate `order_payments` table.** Cash/card/transfer/split with amounts. Even though only cash is supported initially.
5. **Replenishment `min_qty` — on BOTH `products` and `product_categories`.** Product value overrides category when set.
6. **Importer scope — master tables only.** No historical orders, purchases, or landed_costs from ProDuck.
7. **Naming — snake_case plural tables and columns** (MariaDB convention). Drizzle TS identifiers stay camelCase via column-name mapping.
8. **Soft-delete — dropped entirely.** Replaced by the snapshot pattern on `order_items` (`snapshot_product_name`, `snapshot_product_code`, `snapshot_product_cost`, `snapshot_product_price`, `snapshot_category_name`, all NOT NULL since fresh design). `order_items.product_id` is nullable with `ON DELETE SET NULL`.
9. **Stock qty — `BIGINT` in the variant's smallest unit.** Each `product_variants.unit` defines the smallest unit (`piece`, `g`, `ml`, `mm`). Stock is always stored as an integer count of that smallest unit (1 kg = `1000` g). No floats anywhere. `product_variants.qty_decimals` controls display only. (Supersedes the earlier int-only rule.)
10. **Audit columns — `created_at`, `updated_at` on every master table.** `created_by_user_id` where meaningful. `deleted_at` only on tables where audit-trail soft-delete is genuinely needed (TBD per table; default: no soft-delete).
11. **Product variants are first-class.** `products` holds shared identity (name, category, tax, description, images). `product_variants` holds the actual SKU (sku, barcode, price, cost, stock, unit, qty_decimals). Every product has ≥1 variant; products with no real variation auto-get a single default variant the UI hides.
12. **Two-track product lifecycle: archive (default) + hard delete (escape hatch).** `products.archived_at TIMESTAMP NULL` hides from POS but keeps admin-visible and reversible. Hard delete is root-only, requires confirmation, removes the row; `order_items.product_id` and `order_items.variant_id` go NULL via `ON DELETE SET NULL`; snapshot fields preserve the sale record forever.

---

## Tables to import (masters)

In dependency order:

`claims` → `users` → `product_categories` → `products` → `locations` → `stock_locations` → `customers` → `customer_prices` → `vendors` → `point_of_sales` → POS/user assignments + claim/user assignments.

Filter out `IsDeleted = 1` / `Deleted = 1` rows during read from ProDuck.

---

## Importer behavior

- **Destructive / wipe-and-restore.** Not idempotent. First-time-only operation per fresh retale install.
- No `imported_from_produck_id` tracking column needed.
- Script lives at `packages/api/scripts/import-from-produck.ts`.
- Reads from ProDuck via `PRODUCK_DATABASE_URL` env var (separate from `DATABASE_URL`).
- Retale assigns fresh ULIDs. Old bigint → new ULID mapping kept in an in-memory `Map` during the run so FKs can be rewritten.
- Single transaction. Wipes retale tables before insert (`TRUNCATE` in FK-safe order, or drop+recreate via Drizzle).
- Argon2 password hashes carry over as-is (same algorithm).

---

---

## Product structure

### Tables

```
products:
  id                 ULID PK
  name               VARCHAR NOT NULL
  description        TEXT NULL
  category_id        ULID FK → product_categories NULL
  tax_rate_bps       INT NOT NULL DEFAULT 0       -- e.g. 1100 = 11%
  price_mode         ENUM('tax_inclusive','tax_exclusive') NOT NULL
  min_qty            INT NULL                     -- replenishment override (else category)
  min_margin_bps     INT NULL                     -- alert override (else category)
  archived_at        TIMESTAMP NULL               -- archive (reversible)
  created_at         TIMESTAMP
  updated_at         TIMESTAMP
  created_by_user_id ULID FK NULL
  -- search_text generated column (lowercase name) for LIKE lookup
  INDEX (archived_at), INDEX (category_id), INDEX (search_text)

product_variants:
  id                 ULID PK
  product_id         ULID FK → products  ON DELETE CASCADE
  sku                VARCHAR NOT NULL UNIQUE      -- internal, system-generatable
  barcode            VARCHAR NULL                 -- scannable, non-unique, indexed
  label              VARCHAR NULL                 -- "M6 × 20mm" (composed from options or freeform)
  unit               ENUM('piece','g','ml','mm') NOT NULL DEFAULT 'piece'
  qty_decimals       TINYINT NOT NULL DEFAULT 0   -- display only (e.g. 3 for kg shown to 0.001)
  price_minor        BIGINT NOT NULL              -- base price in minor units, in the product's price_mode
  cost_minor         BIGINT NOT NULL DEFAULT 0    -- current WAC
  total_qty          BIGINT NOT NULL DEFAULT 0    -- denormalized sum of stock_locations for this variant
  sort_order         INT NOT NULL DEFAULT 0
  created_at, updated_at
  INDEX (product_id), INDEX (barcode), INDEX (sku)

product_variant_options:
  variant_id         ULID FK → product_variants  ON DELETE CASCADE
  option_name        VARCHAR NOT NULL             -- "length", "color"
  option_value       VARCHAR NOT NULL             -- "20mm", "red"
  PRIMARY KEY (variant_id, option_name)

product_price_tiers:
  id                 ULID PK
  variant_id         ULID FK → product_variants  ON DELETE CASCADE
  min_qty            BIGINT NOT NULL              -- in variant's smallest unit
  price_minor        BIGINT NOT NULL
  UNIQUE (variant_id, min_qty)

product_images:
  id                 ULID PK
  product_id         ULID FK → products  ON DELETE CASCADE
  variant_id         ULID FK → product_variants  ON DELETE CASCADE  NULL
  filename           VARCHAR NOT NULL             -- relative to IMAGE_ROOT
  mime               VARCHAR NOT NULL
  width              INT NOT NULL
  height             INT NOT NULL
  size_bytes         INT NOT NULL
  sort_order         INT NOT NULL DEFAULT 0
  created_at         TIMESTAMP
  INDEX (product_id, variant_id, sort_order)
```

### Identity rules

- `sku` is internal and required, system-generated on create (e.g. `SKU-<short ulid>`). Editable by admin.
- `barcode` is the scannable EAN/UPC, optional, non-unique. Same physical barcode may legitimately appear on two SKUs from different suppliers; lookup returns a list, clerk picks.
- Scanner search: exact barcode match first; if multiple hits, return all. No prefix match by default (scans are full reads).

### Pricing layers (evaluated in priority order)

1. `customer_prices` (customer × variant override) — if set, wins.
2. `product_price_tiers` (qty break for the variant) — highest `min_qty` ≤ requested qty wins.
3. `product_variants.price_minor` — base.

`price_mode` (tax_inclusive/tax_exclusive) is per-product; the resolved price is interpreted accordingly. The tax surface itself is a flat `products.tax_rate_bps` (Indonesia's single VAT). No `tax_categories` table — a future country switch would add one.

### Snapshot fields on `order_items` (locked)

All NOT NULL except where noted:

```
snapshot_product_name        VARCHAR NOT NULL
snapshot_product_sku         VARCHAR NOT NULL
snapshot_product_barcode     VARCHAR NULL
snapshot_variant_label       VARCHAR NULL          -- composed at sale time
snapshot_unit                ENUM NOT NULL         -- 'piece','g','ml','mm'
snapshot_category_name       VARCHAR NULL
snapshot_price_minor         BIGINT NOT NULL       -- the price actually charged per smallest unit
snapshot_cost_minor          BIGINT NOT NULL       -- WAC at sale time, immutable
snapshot_tax_rate_bps        INT NOT NULL
snapshot_tax_mode            ENUM NOT NULL         -- 'tax_inclusive','tax_exclusive'
```

`order_items.variant_id` is the live reference (nullable, `ON DELETE SET NULL`). Snapshots are the source of truth for reports and reprints.

### Images

- Stored on filesystem under `IMAGE_ROOT/products/<product_id>/<image_id>.<ext>`. Path computed, not stored — only the filename.
- Two-level fallback: when resolving images for a variant, return variant-specific rows if any exist; otherwise return product-level (rows with `variant_id = NULL`).
- Upload UI defaults to product-level; per-variant override is an explicit toggle.
- Originals stored as-uploaded. Thumbnails generated on demand into a cache directory (not stored in DB).
- Orphan-file sweep is a periodic maintenance task; not a transactional concern.

### Search

- Generated column `products.search_text` = lowercase(name). Regular index, LIKE-prefix friendly.
- Variant lookup by `sku` (exact) and `barcode` (exact) goes through `product_variants` indexes.
- Free-text query: trim, lowercase, split on whitespace, drop empty tokens, AND the LIKEs against `search_text`. (Fixes the ProDuck empty-keyword-matches-everything bug.)
- No FULLTEXT for now; revisit if scale demands.

### Lifecycle: archive vs hard delete

| Action | Who | Reversible | What happens |
|---|---|---|---|
| Archive | root, clerk | yes (unarchive) | `archived_at = NOW()`. Hidden from POS search; visible in admin with filter. Old orders unaffected. |
| Unarchive | root, clerk | n/a | `archived_at = NULL`. |
| Hard delete | root only | no | Row deleted. `order_items.variant_id` and `order_items.product_id` → NULL via `ON DELETE SET NULL`. Snapshots preserve sale record. UI shows reference count + nudges "Archive instead?" before confirming. |

Archive is the default everyday action. Hard delete is for mistakes/duplicates.

### Customer prices

- `customer_prices` keys on `(customer_id, variant_id)`, not product. A customer override applies to a specific variant only.
- Resolves above qty-tier and base price (see Pricing layers).

### Unit input at sale time

- API contract: `order_items.qty` is always an integer in the variant's smallest unit (`unit`). No server-side conversion.
- POS UI reads `variant.unit` + `variant.qty_decimals` and presents the human form; converts to smallest unit before submitting (e.g. "1.5" against unit=g, qty_decimals=3 → `1500`).
- Barcode scan = +1 of smallest unit. Pre-packaged items always modeled as `unit='piece'` so this is correct by construction. A 1 kg bag of sugar is one variant with `unit='piece'`, not 1000 g.
- Loose goods (cables, fasteners by weight, liquids by volume) use real units (`mm`, `g`, `ml`); clerk types the measured qty, never scans.
- Validation: non-integer qty rejected at the API boundary (Zod). UI is responsible for rounding to `qty_decimals`.

### Landed cost × variants

- `landed_cost_items.variant_id` (not product_id). `purchase_orders` lines also key by `variant_id`.
- The hierarchical cost-distribution tree is unchanged — it's math over PO quantities, not product structure. Multiple variants of the same product on one PO produce separate leaves; each variant's WAC updates independently.
- WAC lives on `product_variants.cost_minor`; the update path is per-variant.

### Categories

- Single-parent hierarchy (`product_categories.parent_id`). One category per product.
- Inheritance: `min_qty`, `min_margin_bps`, and (future) `tax_rate_bps` resolve product → category. Product value wins when set.
- Many-to-many tagging deferred — add a separate `tags` table later if cross-cutting groupings are needed. Don't build now.
- Deleting a category: reparent products to NULL (not to the category's parent). Explicit choice over silent cascade.

---

## Cost accounting

**Approach: Moving Average (WAC).** Replaces ProDuck's "only-go-up" rule. Cost accuracy goal is "good enough for reports" — gist-level, not strict accounting. Pragmatic corrections preferred over rigorous reversal-only history.

**`products.cost` = current weighted average.** Recomputed inside the transaction that writes an inbound `purchase_receive` movement.

**Negative-qty-safe WAC formula:**

```
if current_qty <= 0:
    new_cost = received_cost
    # negative balance = sales already costed at old WAC; don't re-value them
else:
    new_cost = (current_qty * current_cost + received_qty * received_cost)
             / (current_qty + received_qty)
```

Selling into negative stock is allowed (clerk inconsistency is expected). `stock_locations.qty` may go negative; flag on dashboard for reconciliation. Sales into negative stock snapshot the current `products.cost` as best estimate.

**`order_items.snapshot_product_cost` is immutable** once written. Never retroactively edited even if WAC changes later. This is what makes profit reports stable.

### Stock movement types

| Type | Direction | Updates `products.cost`? | Use case |
|---|---|---|---|
| `purchase_receive` | inbound | yes (WAC formula above) | Landed cost delivery |
| `transfer_in` | inbound | no | From another location |
| `transfer_out` | outbound | no | To another location |
| `sale` | outbound | no | Order created |
| `sale_return` | inbound | no | Customer return; `unit_cost` = the order's snapshot cost |
| `adjustment_in` | inbound | no | Found stock / miscount up |
| `adjustment_out` | outbound | no | Shrinkage / miscount down / discovered unrecorded sale |
| `cost_override` | neither (qty_delta=0) | **yes — snaps to exact value** | Admin manual correction |
| `initial_import` | inbound | yes (WAC, but starts from empty so just sets) | One-time importer |

**Only `purchase_receive` and `cost_override` change `products.cost`.** Everything else leaves it alone.

### Cost editing (three layers)

1. **Pre-delivery edit.** Edit `landed_cost_items.cost` freely while not yet delivered. WAC only updates on delivery.
2. **Post-delivery correction.** Allow editing the `unit_cost` on a past `purchase_receive` movement. Do NOT replay WAC (too expensive, and "gist accuracy" goal makes it unnecessary). Just record the edit with an `edited_at` timestamp and let `cost_override` handle the present value if it matters.
3. **`cost_override` movement.** The escape hatch. Admin enters target cost + reason; system writes a movement with `qty_delta=0`, `unit_cost=X`, `previous_cost=<current>`, `reason=<text>`, then sets `products.cost = X` in the same transaction. Reversible by posting the opposite override.

### Required movement columns

`stock_movements`:
- `id` (ULID)
- `product_id` (ULID, FK)
- `location_id` (ULID, FK, nullable for "root" stock)
- `type` (enum string, see table above)
- `qty_delta` (int — positive inbound, negative outbound, zero for `cost_override`)
- `unit_cost` (BIGINT minor units — the cost of THIS movement; for outbound = current WAC at the time)
- `previous_cost` (BIGINT minor units, nullable — only for `cost_override`, audit field)
- `ref_type` (enum: `purchase`, `order`, `transfer`, `adjustment`, `override`, `import`)
- `ref_id` (ULID, nullable — points at the source document)
- `reason` (varchar, nullable — free text, especially for adjustments and overrides)
- `created_by_user_id` (ULID, FK)
- `created_at` (timestamp)

---

## Purchases & deliveries

Rename from ProDuck:
- `Purchase` → `purchases` (header)
- `PurchaseOrder` (line) → `purchase_items`
- New: `purchase_sections` — per-purchase grouping (flat, not hierarchical)
- `LandedCost` → `purchase_deliveries` (inbound-only; transfers are their own subsystem)
- `LandedCostItem` → `purchase_delivery_items` (hierarchical cost tree)

The `IsPurchase` flag and source/target locations on `LandedCost` are dropped — purchase deliveries always flow vendor → one target location.

### Tables

```
purchases:
  id                    ULID PK
  vendor_id             ULID FK → vendors  NULL    -- NULL = ad-hoc / one-off purchase (no AP)
  snapshot_vendor_name  VARCHAR NOT NULL           -- auto-copied from vendor; free-text when vendor_id IS NULL
  date                  DATE NOT NULL
  source_document       VARCHAR NULL               -- vendor invoice / PO ref
  memo                  TEXT NULL
  status                ENUM('open','complete','cancelled') NOT NULL DEFAULT 'open'
  cancelled_at          TIMESTAMP NULL
  cancelled_by_user_id  ULID FK NULL
  created_by_user_id    ULID FK
  created_at, updated_at

purchase_sections:
  id            ULID PK
  purchase_id   ULID FK → purchases  ON DELETE CASCADE
  name          VARCHAR NOT NULL                -- "Brake Pad", "Fastener", ...
  sort_order    INT NOT NULL DEFAULT 0
  -- sort_order kept consecutive via app-layer renumber on reorder
  -- Flat. If nesting needed later, add parent_id (non-breaking migration).

purchase_items:
  id              ULID PK
  purchase_id     ULID FK → purchases  ON DELETE CASCADE
  section_id      ULID FK → purchase_sections  ON DELETE SET NULL  NULL  -- NULL = "Uncategorized"
  variant_id      ULID FK → product_variants  NULL                  -- NULL = non-stock line (workshop consumable, tool, etc.)
  description     VARCHAR NULL                  -- vendor free text override; REQUIRED when variant_id IS NULL
  qty_ordered     BIGINT NOT NULL               -- variant's smallest unit (non-stock: arbitrary integer, treated as "1 unit each")
  qty_delivered   BIGINT NOT NULL DEFAULT 0     -- DENORM running total from delivered deliveries
  unit_cost_minor BIGINT NOT NULL               -- vendor invoice price per smallest unit (pre-landed-cost)
  sort_order      INT NOT NULL DEFAULT 0
  -- CHECK: variant_id IS NOT NULL OR description IS NOT NULL
  INDEX (variant_id)

purchase_deliveries:
  id                    ULID PK
  date                  DATE NOT NULL
  biller                VARCHAR NULL            -- shipper / customs broker / etc.
  target_location_id    ULID FK → locations     -- where stock lands
  status                ENUM('draft','delivered','cancelled') NOT NULL DEFAULT 'draft'
  delivered_at          TIMESTAMP NULL
  delivered_by_user_id  ULID FK NULL
  total_cost_minor      BIGINT NOT NULL DEFAULT 0  -- DENORM root of cost tree; for list views
  created_by_user_id    ULID FK
  created_at, updated_at

purchase_delivery_items:
  id                ULID PK
  delivery_id       ULID FK → purchase_deliveries  ON DELETE CASCADE
  parent_item_id    ULID FK → purchase_delivery_items  NULL  -- hierarchical cost tree
  purchase_item_id  ULID FK → purchase_items  NULL           -- only on leaves (product allocations)
  description       VARCHAR NOT NULL            -- "Freight", "Customs", line description, ...
  qty               BIGINT NULL                 -- only on leaves; in variant smallest unit
  cost_minor        BIGINT NOT NULL             -- this node's cost
  sort_order        INT NOT NULL DEFAULT 0
  INDEX (delivery_id), INDEX (purchase_item_id)
```

### Ad-hoc purchases (no vendor)

`purchases.vendor_id` is nullable. A NULL vendor means a one-off purchase — hardware store run, flea-market spare, reimbursing a parts pickup. Avoids bloating the vendor list with rows used once.

- `snapshot_vendor_name` is **always required**. Auto-copied from `vendors.name` when `vendor_id` is set; free-text when NULL ("Toko Sumber Jaya," "Cash pickup — Jl. Sudirman").
- **No AP on ad-hoc.** Ad-hoc purchases must be paid in full at delivery time — no vendor to owe, so `vendor_ledger` is never written. Enforced at the API layer: delivery commit on an ad-hoc purchase requires a same-transaction full payment record.
- **No vendor variant code mapping** applies — there's no vendor row to key against.
- Reporting "spend by vendor" buckets all `vendor_id IS NULL` purchases as "Ad-hoc / one-off."
- Setting a vendor on an ad-hoc purchase later (clerk realized it's actually a recurring source): allowed while `status = 'open'`; updates `vendor_id` and refreshes `snapshot_vendor_name` from the vendor row. Disallowed once any delivery is committed.

### Non-stock lines

Workshop consumables, tools, office supplies bought from the same vendor — appear on the purchase invoice but never enter the product catalog.

- `purchase_items.variant_id IS NULL` flags a non-stock line. `description` is required (it's the line label).
- **Counts toward** `totalInvoiceCost` so the vendor invoice reconciles.
- **Excluded from landed-cost allocation.** Freight/customs are capitalized into goods of resale, not expensed items. The cost tree allocates only over leaves whose `purchase_item.variant_id IS NOT NULL`.
- **Appears on deliveries.** Non-stock lines show up as receivable rows on `purchase_deliveries` — delivery is the "what arrived from vendor" doc, and consumables arrive too. The leaf `purchase_delivery_items` row is written, but the delivery commit writes **no** `stock_movement` for it and doesn't touch any WAC.
- No expense category / accounting category for v1 — `description` plus the vendor is enough searchable detail. Add if expense slicing surfaces a real need.

### Sections

- Per-purchase, free-text, **flat**. No nesting. (Escape hatch: add `parent_id` later if usage demands.)
- Reorder via `sort_order`; drag-drop renumbers affected rows in one transaction.
- Items move between sections by updating `section_id`. `NULL` = "Uncategorized" bucket — no row needed.
- Deleting a section reparents its items to `NULL`.

### Multiple deliveries per purchase (partial delivery)

- One delivery covers any subset of `purchase_items` via leaf `purchase_delivery_items.purchase_item_id`.
- Same `purchase_item` may appear across multiple deliveries — partial delivery flow.
- **Constraint** (checked on `draft → delivered`): `purchase_item.qty_delivered + sum(this delivery's leaves for this item) ≤ qty_ordered`. Denormalized `qty_delivered` keeps the check O(1).
- `qty_delivered` updated transactionally in the same step that writes `purchase_receive` stock movements and recomputes WAC.

### Purchase status

Stored on the row for indexing, but driven by item state:
- `open` while any item has `qty_delivered < qty_ordered`
- `complete` flipped automatically by the delivery transaction that finishes the last item
- `cancelled` manually; hard-fails if any non-cancelled delivery references its items

### Accumulated landed cost view (not denormalized on purchase)

Computed per-purchase via resolver:
- `totalInvoiceCost` = `SUM(qty_ordered * unit_cost_minor)` across items
- `totalLandedCost` = `SUM(purchase_delivery_items.cost_minor)` over leaves pointing at this purchase's items where delivery.status='delivered'
- `totalDeliveredQty` per item from `purchase_items.qty_delivered`
- `deliveries` list = join via leaf items

Joins are bounded (few items, few deliveries). Don't denormalize on `purchases` — would drift on draft delivery edits.

`purchase_deliveries.total_cost_minor` *is* denormalized (delivery list view sorts on it; the tree is small and entirely owned by one delivery — easy to keep correct).

### Mutation rules

| Action | Allowed when | Notes |
|---|---|---|
| Edit `qty_ordered` / `unit_cost_minor` on an item | No `delivered` delivery references it | Draft deliveries do NOT lock the item. |
| Delete an item | `qty_delivered == 0` | Cancel relevant delivery first if any. |
| Delete a section | always | Items reparent to `NULL`. |
| Reorder sections / items within section | always | App-layer renumber. |
| Cancel purchase | No non-cancelled delivery references its items | Row preserved for audit; hidden from default lists. |
| Cancel a delivered delivery | root only | Reverses `purchase_receive` movements, decrements `qty_delivered`, may reopen the purchase. WAC is **not** retroactively recalculated (per cost-accounting "gist accuracy" rule); use `cost_override` if present value matters. |
| Edit delivery cost tree | `status = draft` | After `delivered`, immutable. |

### Delivery commit (`draft → delivered`)

The only step that touches stock and WAC. In one transaction:
1. Validate partial-delivery constraint per item.
2. For each leaf with `purchase_item_id` set **and the referenced `purchase_item.variant_id IS NOT NULL`**: write a `purchase_receive` `stock_movement` at `target_location_id` for `variant_id`, with `unit_cost = leaf.cost_minor / leaf.qty` (allocated cost, includes proportional share of parent freight/customs). Non-stock leaves (variant_id NULL) are recorded for receiving audit only — no stock movement, no WAC impact.
3. Recompute `product_variants.cost_minor` via WAC formula per variant.
4. Increment `purchase_items.qty_delivered` per affected item.
5. Auto-set `purchases.status = 'complete'` if all items now fully delivered.
6. Set delivery `status = delivered`, `delivered_at`, `delivered_by_user_id`.

---

## Vendors

Mirror of the Customers entity, plus an AP ledger and per-vendor variant code mapping. Same patterns where they apply — denormalized contact on the row, archive + hard-delete, computed AP aging.

### Schema

```
vendors:
  id                   ULID PK
  name                 VARCHAR NOT NULL
  phone                VARCHAR NULL                 -- indexed; single number, extras in notes
  email                VARCHAR NULL
  address              TEXT NULL                    -- freeform single field
  tax_id               VARCHAR NULL                 -- NPWP (Indonesia)
  notes                TEXT NULL
  balance_minor        BIGINT NOT NULL DEFAULT 0    -- cached sum of vendor_ledger; positive = we owe them
  archived_at          TIMESTAMP NULL
  created_at, updated_at
  created_by_user_id   ULID FK NULL
  -- search_text generated column = lower(name || ' ' || coalesce(phone, ''))
  INDEX (archived_at), INDEX (phone), INDEX (search_text)

vendor_ledger:
  id                   ULID PK
  vendor_id            ULID FK → vendors
  type                 ENUM('purchase_on_account', 'payment', 'refund_credit',
                            'adjustment', 'opening_balance')
  amount_minor         BIGINT NOT NULL              -- positive = we owe more
  ref_type             ENUM('purchase', 'purchase_delivery', 'payment',
                            'adjustment', 'import') NULL
  ref_id               ULID NULL
  note                 TEXT NULL                    -- required for 'adjustment'
  pos_session_id       ULID FK NULL                 -- required for cash events out of POS drawer
  created_by_user_id   ULID FK → users
  created_at           TIMESTAMP

vendor_variant_codes:
  vendor_id            ULID FK → vendors
  variant_id           ULID FK → product_variants  ON DELETE CASCADE
  vendor_code          VARCHAR NOT NULL             -- vendor's part number / SKU
  vendor_description   VARCHAR NULL                 -- vendor's free-text label
  PRIMARY KEY (vendor_id, vendor_code)
  INDEX (variant_id)

```

(See `purchases.snapshot_vendor_name` in the Purchases & deliveries section — set on create, preserves vendor name on history, also used as the free-text label for ad-hoc purchases.)

Invariant: `vendors.balance_minor == SUM(vendor_ledger.amount_minor)` per vendor. Always updated in same transaction.

### Identity & lookup

Same as customers: `name` required, phone is the fast lookup, free-text search via generated `search_text` column. No uniqueness on phone.

### Payment terms / AP

Full AP ledger, mirror of `customer_ledger`.

- Purchases paid in full at delivery time: no ledger row needed — the cash event lives on `purchase_deliveries` / payment record.
- Purchases on terms: delivery commit writes `vendor_ledger.type = 'purchase_on_account'` for the unpaid balance.
- Vendor payments: `recordVendorPayment(vendorId, amount, posSessionId?, note?)` writes a `payment` row reducing balance. `pos_session_id` required when paid in cash from the drawer.
- AP aging: computed per-resolver, FIFO-allocate `payment` rows against `purchase_on_account` rows oldest-first. Same approach as customer AR.

No `credit_limit` field on vendors — vendors set our limit, not the other way around. If a vendor cuts us off it's a real-world conversation, not a system rule.

### Vendor variant codes

For mapping vendor part numbers / SKUs to our variants — vendor A calls the part `BP-5512`, vendor B calls it `5512BP`, our `SKU-01HX...` is internal.

- Composite PK `(vendor_id, vendor_code)` — same vendor can't have two entries for one code, but the same code may legitimately belong to different vendors.
- One variant can have multiple vendor codes (multiple vendors supply the same part); one vendor can have multiple codes pointing at the same variant (vendor renumbered, both still in circulation).
- Receiving flow: scan/type vendor code → exact match returns variant → auto-fill `purchase_items.variant_id`.
- `vendor_description` preserves the vendor's free-text label for printed POs and audit.
- **Last-paid cost is derived**, not denormalized. Resolver: `MAX(unit_cost_minor) OVER (vendor_id, variant_id) ORDER BY purchases.date DESC LIMIT 1`. Cheap query, no drift surface.

### Tax ID

Single optional `tax_id` VARCHAR for NPWP. Cheap to have, expensive to retrofit. No validation — vendors enter what they give us.

### Lifecycle: archive + hard delete

Same two-track pattern as products and customers.

| Action | Who | Reversible | Allowed when |
|---|---|---|---|
| Archive | clerk, root | yes (unarchive) | always |
| Unarchive | clerk, root | n/a | always |
| Hard delete | root | no | `balance_minor == 0` AND no non-cancelled purchases reference it, OR root override |

Hard delete sets `purchases.vendor_id = NULL` via `ON DELETE SET NULL`. `snapshot_vendor_name` and `purchase_items` (including their snapshot data) preserve the record. `vendor_ledger` cascade-deletes.

### Permissions

| Action | clerk | root |
|---|---|---|
| Create / edit vendor | ✓ | ✓ |
| Archive / unarchive | ✓ | ✓ |
| Record vendor payment | ✓ | ✓ |
| Adjustment (write-off, root only) | ✗ | ✓ |
| Hard delete (zero balance, no purchases) | ✗ | ✓ |
| Hard delete (root override) | ✗ | ✓ |
| Add / edit vendor variant code mapping | ✓ | ✓ |

---

## Locations

Hierarchical, forest (multiple roots allowed). Stock can sit at any node — leaf or branch. Used by `stock_locations`, `purchase_deliveries.target_location_id`, `stock_transfers` source/dest, and `points_of_sale.location_id`.

### Schema

```
locations:
  id           ULID PK
  parent_id    ULID FK → locations  NULL          -- NULL = root; multiple roots allowed
  name         VARCHAR NOT NULL
  code         VARCHAR NULL                       -- optional short label for transfer/picking docs
  notes        TEXT NULL
  archived_at  TIMESTAMP NULL                     -- hides from new-stock destinations; stock stays visible in reports
  sort_order   INT NOT NULL DEFAULT 0
  created_at, updated_at
  created_by_user_id ULID FK NULL
  INDEX (parent_id), INDEX (archived_at)
```

### Hierarchy rules

- Forest: any number of roots (`parent_id IS NULL`). Costs nothing to allow; one-root setups still work naturally.
- Stock allowed at any node, including non-leaves. Useful for "10 of these somewhere in the workshop, not pinned to a shelf yet." (`stock_locations.location_id` is also nullable for the unlocated-root entry — see Cost accounting / stock section.)
- **Reparenting** allowed freely while not archived — UPDATE `parent_id`. One cycle check on save: target must not be self or a descendant.

### Lifecycle: archive + hard delete

| Action | Who | Reversible | Allowed when |
|---|---|---|---|
| Archive | clerk, root | yes | always |
| Unarchive | clerk, root | n/a | always |
| Hard delete | root | no | zero stock at this location AND no child locations AND not referenced by any non-archived POS or open session |

Archive hides the location from new-stock destination pickers (purchase delivery, transfer dest) but preserves it in historical reports. Hard delete requires the operator to move stock out first — no auto-cascade. Children must be reparented or hard-deleted first.

### Permissions

| Action | clerk | root |
|---|---|---|
| Create / edit / reparent location | ✓ | ✓ |
| Archive / unarchive | ✓ | ✓ |
| Hard delete | ✗ | ✓ |

---

## Points of Sale

Physical register / checkout terminal. Bound to a location (where the drawer sits). `pos_sessions` reference these.

### Schema

```
points_of_sale:
  id           ULID PK
  location_id  ULID FK → locations              -- required; cash drawer is somewhere
  code         VARCHAR NOT NULL UNIQUE          -- short; used in orders.display_number ("P1-2026-05-14-0042")
  name         VARCHAR NOT NULL                 -- display label ("Counter Register", "Backroom")
  notes        TEXT NULL
  archived_at  TIMESTAMP NULL                   -- archived POS can't open new sessions
  created_at, updated_at
  created_by_user_id ULID FK NULL
  INDEX (location_id), INDEX (archived_at)
```

### Rules

- `code` is required, unique, short. Appears in `orders.display_number` — locked earlier. Keep it 1–4 chars in practice.
- Multiple POS may share a location (two registers at one counter). Many-POS-to-one-location.
- `points_of_sale.location_id` describes where the drawer lives. It does **not** constrain which stock locations the POS pulls from — that's a per-order decision (delivery target, transfer source).

### Lifecycle: archive + hard delete

| Action | Who | Reversible | Allowed when |
|---|---|---|---|
| Archive | root | yes | no open session on this POS |
| Unarchive | root | n/a | always |
| Hard delete | root | no | zero orders AND zero sessions reference it |

Archive is the normal "decommission" path — old register replaced, but its history must stay. Archived POS:
- Cannot open new sessions (the partial unique index on open sessions still allows historical rows).
- Still appears in reports filtered by date range.
- Historical `display_number`s remain unique forever (they include the POS code + date + seq).

### Permissions

| Action | clerk | root |
|---|---|---|
| Open session on a POS | ✓ | ✓ |
| Create / edit POS row | ✗ | ✓ |
| Archive / unarchive POS | ✗ | ✓ |
| Hard delete POS | ✗ | ✓ |

POS lifecycle is root-only — these are infrastructure rows, not daily-clerk concerns.

---

## Stock transfers

Parent document with status flag. No transit-location pattern (doubles ledger writes for no benefit at this scale).

### Tables

```
stock_transfers:
  id                      ULID PK
  source_location_id      ULID FK → locations
  dest_location_id        ULID FK → locations
  status                  ENUM('draft','in_transit','completed','cancelled') NOT NULL
  note                    TEXT NULL
  created_by_user_id      ULID FK
  created_at              TIMESTAMP
  dispatched_at           TIMESTAMP NULL
  dispatched_by_user_id   ULID FK NULL
  received_at             TIMESTAMP NULL
  received_by_user_id     ULID FK NULL
  cancelled_at            TIMESTAMP NULL
  cancelled_by_user_id    ULID FK NULL
  cancel_reason           VARCHAR NULL

stock_transfer_items:
  id              ULID PK
  transfer_id     ULID FK → stock_transfers  ON DELETE CASCADE
  variant_id      ULID FK → product_variants
  qty_dispatched  BIGINT NOT NULL              -- variant's smallest unit
  qty_received    BIGINT NULL                  -- NULL until receive; may differ from dispatched
  variance_reason VARCHAR NULL                 -- required if qty_received != qty_dispatched
  UNIQUE (transfer_id, variant_id)
```

### State transitions

| Transition | Ledger effect |
|---|---|
| `draft` → `in_transit` (dispatch) | `transfer_out` at source per line, qty = `qty_dispatched`. Set `dispatched_at` + `dispatched_by_user_id`. |
| `in_transit` → `completed` (receive) | `transfer_in` at dest per line, qty = `qty_received`. If variance, additionally write `adjustment_out` at source for the difference with `reason = variance_reason`. Set `received_at` + `received_by_user_id`. |
| `draft` → `cancelled` | No ledger writes. |
| `in_transit` → `cancelled` | `transfer_in` back at source reversing the dispatch. |
| `completed` → anything | Immutable. Corrections via new transfer or adjustment. |

### Rules

- `source_location_id != dest_location_id` enforced in service layer.
- Dispatch hard-fails if any variant's source stock < `qty_dispatched`. No negative stock on transfers (unlike sales).
- Receive is all-at-once (not line-by-line). All lines must have `qty_received` set.
- Variance writes (`adjustment_out`) hit the **source** location — stock lost in transit is charged to where it left. If the missing stock later surfaces at destination, an independent `adjustment_in` records it.
- Editing line items only allowed in `draft` status. After dispatch, only `qty_received` + `variance_reason` are writable on existing lines.
- Variance reason is required (NOT NULL at app layer) whenever `qty_received != qty_dispatched`.

### Movement linkage

- `stock_movements.ref_type = 'transfer'`, `ref_id = stock_transfer_items.id` (item-level — variance adjustment can also point at the same item).
- Both legs of a transfer are queryable via the parent doc, not by joining movements to each other.

---

## Product alerts (margin threshold + future dashboard signals)

**Unified `product_alerts` table** — replaces ProDuck's ad-hoc endpoints (`/Products/negativeprice`, `/Categories/replenishment`, etc.) with a single generalized concept.

### Schema

```
product_alerts:
  id                       ULID PK
  product_id               ULID FK → products
  type                     ENUM: 'low_margin' | 'low_stock' | 'negative_price'
                                | 'negative_margin' | 'data_anomaly' | ...
  triggered_at             TIMESTAMP NOT NULL
  trigger_context          JSON     (snapshot of relevant values at trigger time)
  acknowledged_at          TIMESTAMP NULL
  acknowledged_by_user_id  ULID FK NULL
  resolution_note          TEXT NULL
```

Unique constraint: `(product_id, type)` WHERE `acknowledged_at IS NULL` — prevents duplicate open alerts for the same product+type.

### Margin threshold specifically

- **Metric: margin** = `(price - cost) / price`. Not markup.
- **Stored as basis points** in `products.min_margin_bps INT NULL` and `product_categories.min_margin_bps INT NULL`. `2000 = 20.00%`.
- Product value overrides category. NULL on both = no threshold = never flag.
- **Triggered on:** `purchase_receive` (WAC up), `cost_override`, `products.price` change, `min_margin_bps` change (product or category — re-evaluate affected products).
- Centralized in `evaluateMarginAlert(productId)` called at end of each triggering transaction.

### Edge cases (skip or reclassify)

| Condition | Behavior |
|---|---|
| `price = 0` | Skip (intentional free item) |
| `cost = 0` | Skip (uninitialized; meaningless 100% margin) |
| `cost < 0` | Don't trigger `low_margin`; create `data_anomaly` alert |
| `price < cost` | Don't trigger `low_margin`; create `negative_margin` alert (separate type, more urgent) |

### Acknowledgment

- **Manual only.** Even when margin recovers above threshold, alert stays open until acknowledged. Dashboard shows current values alongside trigger-time values so admin sees what changed.
- "Dismiss without changes" is a valid acknowledgment action (sets `acknowledged_at` + `resolution_note`).
- No auto-close.

### Retention

- **Acknowledged alerts older than 1 year are hard-deleted** by a periodic job. Prevents table bloat.
- **Open (unacknowledged) alerts are never auto-deleted** — if it's been open a year, that's its own signal that someone is ignoring the dashboard.
- Implementation: a daily/weekly Bun cron task (or a manually-invoked maintenance script) running `DELETE FROM product_alerts WHERE acknowledged_at IS NOT NULL AND acknowledged_at < NOW() - INTERVAL 1 YEAR`.

---

## Authentication

**Model: password + TOTP 2FA, short access token + rotating refresh token.** Replaces ProDuck's 365-day stateless JWT. Local-network deployment, but built future-proof.

### Tokens

| Token | Format | Lifetime | Storage | Revocable |
|---|---|---|---|---|
| Access | JWT HS512, claims `{userId, roles}` | **60 min** | client only | no (wait it out) |
| Refresh | opaque 32 random bytes, base64url | **30 days** | client + server (argon2 hashed) | yes — delete session row |

- Access JWT signed with `JWT_SIGNING_KEY` env var.
- Refresh tokens rotated on every use; presenting an already-used refresh token kills the whole session chain (stolen-token detection).
- Roles included in access token at issue time. Role changes propagate on next refresh (≤60 min); full revocation via session delete.

### Login flow

1. `POST /auth/login` with `{ username, password }`.
2. If user has authenticator linked → respond `{ requires_2fa: true, challenge_token }` (single-purpose, ~5 min lifetime). Otherwise return tokens directly.
3. `POST /auth/2fa` with `{ challenge_token, totp_code }` → returns access + refresh tokens.

**No TOTP-only login** — password is always required when 2FA is enabled.

### 2FA (TOTP via authenticator app)

- **RFC 6238**, 30s window, 6 digits, SHA-1 (universal app compat). Allow ±1 window for clock drift.
- **Required for `root` role.** Opt-in for other roles.
- Setup flow: `POST /auth/2fa/setup` → server generates secret, returns `otpauth://` URL (for QR code) + 10 recovery codes shown once. User confirms by entering a code → 2FA activates. Unconfirmed secrets expire.
- TOTP secret stored AES-256-GCM encrypted with `TWO_FACTOR_ENC_KEY` env var.
- Replay prevention: `user_two_factor.last_used_at` tracks the time-step of the last successful code; same code can't be reused within its window.
- Recovery codes: single-use, argon2-hashed at rest, regenerable (invalidates old set).

### Brute force protection

- **5 failed password attempts per username in 15 min → username locked 15 min.** Tracked via `login_attempts` (no FK to users — failures may target nonexistent usernames).
- 5 failed TOTP codes against a challenge_token → invalidate challenge, force restart.
- 5 failed recovery code attempts → same.

### Roles & permissions

Two-layer model:

- **`users.is_root BOOLEAN`** — hard flag. Root short-circuits all permission checks. First user is auto-promoted at bootstrap. Cannot be revoked from the only remaining root.
- Everything below root is **permissions assembled into roles** (RBAC). Roles are bags of permission keys; users hold any number of roles (additive union).

See the next section (**Permission catalog & templates**) for the full design.

### Schema

```
sessions:
  id                  ULID PK
  user_id             ULID FK → users
  refresh_token_hash  VARCHAR(255)        -- argon2 of opaque token
  user_agent          VARCHAR(255) NULL
  ip                  VARCHAR(45) NULL
  created_at          TIMESTAMP
  last_used_at        TIMESTAMP
  expires_at          TIMESTAMP
  revoked_at          TIMESTAMP NULL

user_two_factor:
  user_id             ULID PK / FK → users
  secret_encrypted    VARBINARY(255)      -- AES-GCM
  enabled_at          TIMESTAMP
  last_used_at        TIMESTAMP NULL      -- replay prevention (time-step)

user_recovery_codes:
  id                  ULID PK
  user_id             ULID FK → users
  code_hash           VARCHAR(255)        -- argon2
  used_at             TIMESTAMP NULL

login_attempts:
  id                  ULID PK
  username            VARCHAR(100)
  ip                  VARCHAR(45) NULL
  succeeded           BOOLEAN
  attempted_at        TIMESTAMP

roles:
  id                  ULID PK
  name                VARCHAR(50) UNIQUE
  description         TEXT NULL
  is_template         BOOLEAN NOT NULL DEFAULT false   -- system-seeded; immutable
  archived_at         TIMESTAMP NULL
  created_at, updated_at

role_permissions:
  role_id             ULID FK → roles  ON DELETE CASCADE
  permission_key      VARCHAR(100) NOT NULL            -- e.g. "stock.adjust"
  PRIMARY KEY (role_id, permission_key)

user_roles:
  user_id             ULID FK → users  ON DELETE CASCADE
  role_id             ULID FK → roles  ON DELETE CASCADE
  granted_by_user_id  ULID FK → users
  granted_at          TIMESTAMP
  PRIMARY KEY (user_id, role_id)
```

(`users.is_root BOOLEAN NOT NULL DEFAULT false` lives on the still-to-be-formalized `users` schema.)

### Future-proofing notes

- **Passkeys (WebAuthn):** add an `authenticators` table later; login flow grows a passkey branch. Nothing here blocks it.
- **API tokens / service accounts:** reuse `sessions` with a `type` discriminator.
- **OAuth/SSO:** add `provider` column to sessions; everything else stays.

---

## Permission catalog & templates

RBAC layer below `is_root`. Per-section permissions tables (POS sessions, Order lifecycle, Customers, Vendors, Locations, Points of Sale, Payments & customer debt, etc.) document **which permission keys each action requires**. They are the source of truth for what the catalog must contain.

### Permission catalog (in code, not DB)

Permissions are part of the application contract — defined as a TypeScript const enum / readonly object, validated at app boot. The DB stores role-to-permission-key mappings. Unknown keys in DB get logged + ignored (forward-compat with downgrades).

Naming convention: `<domain>.<action>` (lowercase, dot-separated). Initial catalog:

```
# Orders
order.create_pos
order.create_customer_sale     -- console open order
order.edit_customer_sale       -- add/remove items on open console sale
order.close_customer_sale
order.cancel_customer_sale
order.void_item
order.discount
order.refund                   -- create return order
order.change_customer          -- change customer on open sale

# POS sessions
session.open
session.close_own
session.close_others
session.reopen                 -- within 24h
session.force_close

# Products
product.create
product.edit                   -- non-financial fields
product.edit_cost              -- cost_minor / cost overrides
product.edit_price             -- price_minor / price tiers
product.edit_tax               -- tax_rate_bps / price_mode
product.archive
product.hard_delete

# Stock
stock.adjust                   -- manual write-off / write-on, reason required
stock.transfer.create
stock.transfer.dispatch
stock.transfer.receive
stock.transfer.cancel

# Purchases
purchase.create
purchase.edit                  -- while open and no delivered delivery
purchase.cancel
delivery.draft                 -- create/edit draft purchase delivery
delivery.commit                -- draft → delivered
delivery.cancel                -- root-equivalent in practice

# Customers
customer.create
customer.edit
customer.archive
customer.set_credit_limit
customer.adjustment            -- ledger write-off
customer.hard_delete
debt.record_payment            -- record cash against customer debt

# Vendors
vendor.create
vendor.edit
vendor.archive
vendor.record_payment
vendor.adjustment
vendor.hard_delete
vendor.variant_code.manage     -- vendor SKU mapping

# Locations
location.create
location.edit                  -- includes reparent
location.archive
location.hard_delete

# Points of sale
pos.create
pos.edit
pos.archive
pos.hard_delete

# Reports
report.sales.view              -- volume, count, by-day
report.cost.view               -- includes COGS / per-item cost
report.margin.view             -- price vs cost breakdown
report.ar_aging.view           -- customer debt aging
report.ap_aging.view           -- vendor debt aging
report.session_variance.view   -- cash drawer variances

# Product alerts
alert.acknowledge

# Admin
admin.user.manage              -- create/edit users, assign roles
admin.role.manage              -- create/edit/delete roles
admin.import.run               -- one-shot ProDuck importer
```

### Seeded templates

Shipped at install, `is_template = true`. Immutable via UI. Root can **clone** a template into a regular role (a new row, `is_template = false`) and edit the clone freely.

| Template | Description | Permissions |
|---|---|---|
| `cashier_lite` | New hire / restricted POS only | `order.create_pos`, `order.void_item`, `session.open`, `session.close_own`, `debt.record_payment`, `report.sales.view` |
| `clerk` | Daily POS + light entity management | cashier_lite + `order.discount`, `order.refund`, `customer.*` (except `set_credit_limit`, `adjustment`, `hard_delete`), `vendor.create/edit/archive/record_payment/variant_code.manage`, `location.create/edit/archive`, `purchase.create/edit`, `delivery.draft`, `product.create/edit/archive`, `stock.transfer.create/dispatch/receive`, `alert.acknowledge` |
| `inventory_manager` | Everything clerk does + stock & cost authority | clerk + `product.edit_cost`, `stock.adjust`, `delivery.commit`, `purchase.cancel`, `stock.transfer.cancel`, `report.cost.view`, `report.margin.view` |

Templates evolve via migration when the permission catalog changes; user-cloned roles are not touched.

### Rules

- **Role management is `admin.role.manage`**; user-role assignment is `admin.user.manage`. In practice these are root-only — granting them is granting root-equivalent, so the seeded templates above do not include them.
- A user with **zero roles** has zero permissions. Can log in; can't do anything. No implicit defaults.
- Root short-circuits every check. Root never needs role assignments. Root creation is bootstrap-only (first user) or via `admin.user.manage` (which only root has).
- Required permissions per action are documented in each section's **Permissions** table (clerk/root columns reading as "default template assignments"). Implementations call `requirePermission(user, "<key>")` at the API resolver and again in the service layer for defense-in-depth.

### JWT carries roles, not permissions

Access tokens include `role_ids[]`, not the flattened permission set. Permissions are resolved server-side per request via `role_permissions`. Revoking a permission from a role takes effect on next request (no logout / token-refresh required for downgrade).

### Per-location scoping: deferred

Single workshop, one location effectively. If a future site needs "clerk at POS A only," add `user_roles.scope_location_id ULID NULL` — easy bolt-on.

### Migration from ProDuck

ProDuck's `claims = role names per user` collapses into:
- `roles` rows for each distinct claim name observed
- `user_roles` rows for each user-claim pair
- Permissions for migrated roles are empty by default — root must assign templates or clone-and-edit after import. Importer logs a warning if any non-root user has zero permissions post-import.

---

## POS sessions

Cashier shift model. Sessions exist to (a) reconcile the cash drawer at end of day and (b) group orders/payments for reporting. The workshop counts cash daily, so the variance dance is real, not theater.

### Lifecycle

| Event | Who | What |
|---|---|---|
| **Open** | clerk, root | Picks a POS, declares `opening_cash_minor`. Fails if another session is already open on that POS. |
| **Order / payment** | clerk, root | Each order must reference an open session via `orders.pos_session_id`. No auto-create — fails loudly if no session is open. |
| **Close** | session owner | Counts drawer, enters `closing_cash_minor`. System computes `variance_minor = closing_cash − (opening_cash + SUM(cash payments) − SUM(cash refunds))`. Stored, not blocked. Z-report JSON snapshotted. |
| **Reopen** | root only | Allowed within 24h of close to amend mistakes (recount, late payment). Sets `closed_at = NULL`, preserves `z_report_json` until re-close. After 24h, immutable. |
| **Force-close** | root only | For power-out / crashed sessions. `force_closed = true`, `closing_cash_minor = NULL`, `variance_minor = NULL`. Reports show "unreconciled" rather than a fake zero. |

Same cashier owns a session start to finish — shift change = close + reopen. Simpler audit trail; the friction is ~30 seconds.

### Schema

```
pos_sessions:
  id                   ULID PK
  pos_id               ULID FK → points_of_sale
  opened_by_user_id    ULID FK → users
  opened_at            TIMESTAMP NOT NULL
  opening_cash_minor   BIGINT NOT NULL
  closed_by_user_id    ULID FK → users  NULL
  closed_at            TIMESTAMP NULL
  closing_cash_minor   BIGINT NULL                  -- NULL when force-closed
  variance_minor       BIGINT NULL                  -- NULL when force-closed
  force_closed         BOOLEAN NOT NULL DEFAULT false
  z_report_json        JSON NULL                    -- denormalized snapshot at close time
  notes                TEXT NULL
  created_at, updated_at
  UNIQUE INDEX (pos_id) WHERE closed_at IS NULL     -- one open session per POS
```

### Variance and Z-report

- **Variance is cash-only.** Card / transfer / QRIS totals appear on the Z-report for cross-check against bank/terminal settlement, but no variance field — those channels reconcile elsewhere, not by the cashier.
- **Change is modeled net.** Hard invariant: `SUM(order_payments.amount_minor per order) == orders.total_minor`. Customer hands over 100k for a 73k order → the payment row is `73000`, not `100000 + (−27000) change`. The tendered detail is ephemeral and nobody reports on it.
- **Refund payments reduce expected drawer cash naturally** — a cash refund is a payment row with negative `amount_minor`, so the same SUM-based variance formula works without special cases. (Whether refunds live as negative rows on the original order or via the `createReturn` flow is decided in the Payments section below.)
- **`z_report_json`** is denormalized at close (totals by method, order count, void count, opening / closing / variance). Snapshotted so historical Z-reports don't shift when report logic changes — same spirit as `order_items` snapshots.

### Permissions

| Action | clerk | root |
|---|---|---|
| Open session | ✓ | ✓ |
| Close own session | ✓ | ✓ |
| Close someone else's session | ✗ | ✓ |
| Reopen (≤24h after close) | ✗ | ✓ |
| Force-close stranded session | ✗ | ✓ |

---

## Order lifecycle

Builds on the open/closed model already locked in `Payments & customer debt`. POS orders are atomic-on-create; Console customer sales are stateful and toggle `closed_at` at close time. This section pins the remaining axes.

### Status is derived, not stored

No `orders.status` enum. A stored status would drift (closed-then-returned, cancelled-vs-closed-empty, partial refunds). Instead:

- `closed_at IS NULL` → open
- `cancelled_at IS NOT NULL` → cancelled
- exists `orders` with `return_of_order_id = this.id` → has returns (partial or full)

Reports compute presentation status from these. Single source of truth.

### Returns are linked orders, not mutations

```
orders (additions):
  return_of_order_id   ULID FK → orders  NULL    -- set on return orders only
```

A return creates a **new `orders` row** with `return_of_order_id` pointing at the original. Negative `qty` on its `order_items`, negative `amount_minor` on its `order_payments`. The original sale stays immutable forever.

- Partial returns over multiple visits = multiple return orders linked to the same original. No accounting bookkeeping needed.
- Each return runs in its own `pos_session`, with its own cashier — clean audit per event.
- Stock movements / customer_ledger entries: same machinery as a sale, just with reversed signs.
- `createReturn(originalOrderId, items[])` writes the linked return order in one transaction.

### Parked orders: frontend-only for v1

POS cart lives in the frontend (locked in `Payments & customer debt`). "Park" is just a named slot in localStorage on the POS device — no backend involvement.

If device-loss in practice turns out to be a real problem, escalate to server-side draft orders later. Migration is additive (introduce `parked_at` on `orders` for POS rows with `closed_at IS NULL`). Don't pre-build.

### Discounts: per-item, fixed-amount

```
order_items (additions):
  discount_minor       BIGINT NOT NULL DEFAULT 0    -- in variant smallest-unit pricing
```

- Always fixed amount, never %. The line total math is `qty * price - discount`.
- Order-level discount in the UI is sugar — distributed across items proportionally by line subtotal at write time. Stored only as per-item.
- Single representation, no special-case math anywhere downstream (reports, returns, snapshots).
- Manager approval thresholds: deferred. Add a per-discount approval column when a real need surfaces.

### Order numbering: customer-facing display number

```
orders (additions):
  display_number       VARCHAR NOT NULL UNIQUE      -- e.g. "P1-2026-05-14-0042"
```

- Format: `<pos-code>-<YYYY-MM-DD>-<seq>`. `pos-code` is short human ID on `points_of_sale`. Daily sequence resets at midnight per POS.
- Generated at **close time** (POS: atomic create; Console: explicit close). Open Console sales have `display_number = NULL` and a UI placeholder.
- ULID PK remains the primary identifier everywhere internal. `display_number` is a label for humans — searchable, speakable, printable on receipts.
- Return orders get their own `display_number` with the same format. The link to the original is visible via `return_of_order_id`, not embedded in the number.

### Snapshot fields: tax travels with the sale

Add to the locked `order_items` snapshot set:

```
order_items (additions):
  snapshot_tax_rate_bps   INT NOT NULL
  snapshot_price_mode     ENUM('tax_inclusive','tax_exclusive') NOT NULL
```

Same rationale as the existing snapshots: the sale record must show what was charged, forever. If we switch tax rate (PPN 11% → 12%) or change a product's `price_mode` later, historical orders stay correct without filtering logic.

### Order cancellation (Console sales only)

POS orders are atomic-on-create — they never exist in a cancellable state. Console customer sales can be cancelled pre-close.

```
orders (additions):
  cancelled_at           TIMESTAMP NULL
  cancelled_by_user_id   ULID FK → users  NULL
  cancellation_reason    VARCHAR(255) NULL    -- required when cancelling
```

Cancellation in one transaction: void all non-voided items (reverses stock + customer_ledger entries), set `cancelled_at`. Distinct from "close empty" — intent matters for reports. `cancellation_reason` is required.

Cancelled orders are immutable. No reopening. Root can hard-delete via the standard hard-delete escape hatch if needed.

### Permissions

| Action | clerk | root |
|---|---|---|
| Create POS order (atomic) | ✓ | ✓ |
| Park / resume POS cart (frontend) | ✓ | ✓ |
| Create return order | ✓ | ✓ |
| Apply discount to line item | ✓ | ✓ |
| Cancel open Console sale | ✗ | ✓ |
| Reopen closed order | ✗ | ✗ (use return) |

---

## Customers

The AR/ledger side is locked in `Payments & customer debt`. This section pins the entity itself.

### Schema

```
customers:
  id                   ULID PK
  name                 VARCHAR NOT NULL
  phone                VARCHAR NULL                 -- indexed, single number; secondary numbers go in notes
  email                VARCHAR NULL
  address              TEXT NULL                    -- freeform single field, no structured city/postal
  notes                TEXT NULL                    -- visible at POS when customer attached
  balance_minor        BIGINT NOT NULL DEFAULT 0    -- cached sum of customer_ledger (see Payments section)
  credit_limit_minor   BIGINT NULL                  -- NULL = no limit
  archived_at          TIMESTAMP NULL               -- archive (reversible), hides from POS
  created_at, updated_at
  created_by_user_id   ULID FK NULL
  -- search_text generated column = lower(name || ' ' || coalesce(phone, ''))
  INDEX (archived_at), INDEX (phone), INDEX (search_text)

orders (additions):
  snapshot_customer_name   VARCHAR NULL    -- NULL for walk-in; set when customer_id is set
```

`orders.customer_id` is `ON DELETE SET NULL` so hard-deleting a customer never destroys sales. `snapshot_customer_name` preserves the name on historical orders.

### Identity & lookup

- `name` required, everything else optional. A workshop customer is "Pak Budi" first, a phone number maybe.
- Phone is the primary fast-lookup key — POS clerk types phone digits, exact match wins. No uniqueness constraint (one phone can legitimately belong to two customer rows — household, business + personal).
- Free-text search: same pattern as products — generated `search_text` column, lowercase, LIKE-prefix friendly, AND tokens on whitespace.
- **Customer attachment is optional at POS.** Walk-in (NULL `customer_id`) is the default. Search is for *finding a customer when needed*, not a required step in the payment flow. Walk-in orders must have payments = total (already locked in Payments section).

### Segmentation: none for v1

No B2B/retail flag, no customer type enum. Cases where it matters (~5%) go in `notes`. If reporting later needs slicing by segment, add a `tags` join table — same call we made for products.

### Multiple contacts / addresses / phones

Single contact denormalized on the row. Real complexity (separate billing person, multiple sites, secondary phone) lives in `notes` until a customer's reality forces a `customer_contacts` or `customer_phones` table. Don't pre-build.

### Opening balance on import

Importer writes one `customer_ledger` row per imported customer with `type = 'opening_balance'`, dated to import day, amount = ProDuck's AR balance. No `opening_balance` column on `customers` — the ledger formula stays the single source of truth.

### AR aging: computed, not stored

"Who owes >30 days" runs as a resolver over `customer_ledger`: FIFO-allocate `payment` rows against `sale_on_account` rows oldest-first, age = NOW − oldest unallocated entry per customer. Workshop scale is small; the SQL is cheap. Denormalize only if profiling later shows it's a bottleneck.

### Lifecycle: archive + hard delete

Same two-track pattern as products.

| Action | Who | Reversible | Allowed when |
|---|---|---|---|
| Archive | clerk, root | yes (unarchive) | always |
| Unarchive | clerk, root | n/a | always |
| Hard delete | root | no | `balance_minor == 0` AND no non-cancelled orders, OR root override |

Hard delete sets `orders.customer_id = NULL` via `ON DELETE SET NULL`. `snapshot_customer_name` and `order_items` snapshots preserve the sale record. `customer_ledger` rows cascade-delete (the ledger is meaningless without the customer; AR history was already settled by the zero-balance precondition, or root explicitly overrode).

### Permissions

| Action | clerk | root |
|---|---|---|
| Create / edit customer | ✓ | ✓ |
| Archive / unarchive | ✓ | ✓ |
| Set or change credit limit | ✗ | ✓ |
| Hard delete (zero balance, no orders) | ✗ | ✓ |
| Hard delete (root override, non-zero balance) | ✗ | ✓ |

---

## Payments & customer debt

**Cash-only for now**, `order_payments.method` enum extensible later. Customer debt tracked via an append-only ledger, same pattern as stock.

### Two surfaces with different lifecycles

| Surface | Order lifecycle | Edits after create |
|---|---|---|
| **POS frontend** (clerks) | Atomic. Cart state lives in the frontend. On "Pay" → single API call creates order, items, payments, ledger entries, all closed in one transaction. | None. Adjustments via return orders. |
| **Console frontend** (admin/root) | Stateful. Open orders ("customer sales") created without payment. Items and payments added incrementally. Closed manually. | Allowed while open; immutable once closed. |

Same `orders` table backs both. The difference is just `closed_at` and `pos_session_id`.

### Schema

```
orders (additions):
  closed_at          TIMESTAMP NULL    -- POS: set on create; Console: NULL while open
  closed_by_user_id  ULID FK NULL
  pos_session_id     ULID FK NULL      -- POS: required; Console: NULL

order_items (additions):
  voided_at          TIMESTAMP NULL
  voided_by_user_id  ULID FK NULL
  void_reason        VARCHAR(255) NULL

order_payments:
  id                 ULID PK
  order_id           ULID FK → orders
  method             ENUM('cash')      -- extensible: card, transfer, etc.
  amount_minor       BIGINT NOT NULL
  pos_session_id     ULID FK → pos_sessions  -- where the cash landed; required for cash
  created_by_user_id ULID FK → users
  created_at         TIMESTAMP

customer_ledger:
  id                 ULID PK
  customer_id        ULID FK → customers
  type               ENUM('sale_on_account', 'payment', 'refund_credit',
                          'adjustment', 'opening_balance')
  amount_minor       BIGINT NOT NULL    -- positive = customer owes more
  ref_type           ENUM('order', 'order_item', 'payment', 'refund',
                          'adjustment', 'import') NULL
  ref_id             ULID NULL
  note               TEXT NULL          -- required for 'adjustment'
  pos_session_id     ULID FK NULL       -- required for cash events
  created_by_user_id ULID FK → users
  created_at         TIMESTAMP

customers (additions):
  balance_minor      BIGINT NOT NULL DEFAULT 0   -- cached sum of ledger
  credit_limit_minor BIGINT NULL                  -- NULL = no limit
```

Invariant: `customers.balance_minor == SUM(customer_ledger.amount_minor)` per customer. Always updated in same transaction.

### API surface

**POS API:**
- `createPosOrder(items, payments, customerId?)` — atomic. Writes order (closed_at=now, pos_session_id), order_items (with snapshots), stock_movements, order_payments, customer_ledger entry for any unpaid remainder. Walk-in (no customer) must have payments = total.
- `recordDebtPayment(customerId, amount, posSessionId, note?)` — clerk takes cash against existing debt, no order involved.
- `createReturn(originalOrderId, items[])` — refund as cash or as store credit (clerk choice).

**Console API (customer sales):**
- `createCustomerSale(customerId)` — empty open order.
- `addCustomerSaleItem(orderId, productId, qty, priceOverride?)`
- `voidCustomerSaleItem(orderItemId, reason)`
- `addCustomerSalePayment(orderId, amount, posSessionId)`
- `closeCustomerSale(orderId)` — sets `closed_at`; immutable after.
- `changeCustomerSaleCustomer(orderId, newCustomerId)` — **root only**.

### Item-level operations (open console sales)

- **Voiding** marks the row `voided_at`/`voided_by_user_id`/`void_reason` (not hard delete). Reverses the stock movement and customer_ledger entry in the same transaction. Audit preserved.
- **Edits** = void + re-add. No direct row updates on `order_items`. Keeps snapshot rule intact.
- **Closed sales** are fully immutable — no item adds, no voids, no payment changes.

### Behavior rules

| Rule | Notes |
|---|---|
| Credit limit | If `credit_limit_minor` set, any operation pushing balance past it (sale_on_account, item add to open sale) is rejected. NULL = no limit. |
| Auto-apply store credit | **No.** Negative balance is never auto-deducted. Clerk explicitly records a payment from credit. |
| Adjustments (write-offs) | **Root only.** Note required. |
| Customer required for `on_account` (unpaid balance) | Walk-in orders must be fully paid. |
| POS shows customer balance at order time | Yes — clerk sees current debt and credit limit when customer is attached. |
| Multiple open customer sales per customer | **Allowed.** No unique constraint. |
| Auto-close customer sales | **Never.** Closed only by explicit admin action. |
| POS session close vs open customer sales | No interaction. Customer sales aren't tied to sessions. |

### Permissions

| Action | clerk | root |
|---|---|---|
| POS order with on_account / debt | ✓ | ✓ |
| Record debt payment | ✓ | ✓ |
| Refund as cash or store credit | ✓ | ✓ |
| Create/edit/close customer sale (console) | ✗ | ✓ |
| Adjustment (write-off) | ✗ | ✓ |
| Change credit limit | ✗ | ✓ |
| Change customer on open sale | ✗ | ✓ |
| Delete customer with non-zero balance | ✗ | ✓ |

---

## Status

Decisions captured. Schema files **not yet written**. Resume by:

1. Writing Drizzle schema files under `packages/api/src/db/schema/`, one per domain.
2. Generating the initial migration (`bunx drizzle-kit generate`).
3. Writing the import script.
