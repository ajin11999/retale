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
  id                  ULID PK
  vendor_id           ULID FK → vendors
  date                DATE NOT NULL
  source_document     VARCHAR NULL              -- vendor invoice / PO ref
  memo                TEXT NULL
  status              ENUM('open','complete','cancelled') NOT NULL DEFAULT 'open'
  cancelled_at        TIMESTAMP NULL
  cancelled_by_user_id ULID FK NULL
  created_by_user_id  ULID FK
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
  variant_id      ULID FK → product_variants
  description     VARCHAR NULL                  -- vendor free text override
  qty_ordered     BIGINT NOT NULL               -- variant's smallest unit
  qty_delivered   BIGINT NOT NULL DEFAULT 0     -- DENORM running total from delivered deliveries
  unit_cost_minor BIGINT NOT NULL               -- vendor invoice price per smallest unit (pre-landed-cost)
  sort_order      INT NOT NULL DEFAULT 0
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
2. For each leaf with `purchase_item_id` set: write a `purchase_receive` `stock_movement` at `target_location_id` for `variant_id`, with `unit_cost = leaf.cost_minor / leaf.qty` (allocated cost, includes proportional share of parent freight/customs).
3. Recompute `product_variants.cost_minor` via WAC formula per variant.
4. Increment `purchase_items.qty_delivered` per affected item.
5. Auto-set `purchases.status = 'complete'` if all items now fully delivered.
6. Set delivery `status = delivered`, `delivered_at`, `delivered_by_user_id`.

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

### Roles

- Many-to-many: `roles` table + `user_roles` join. Seeded with `root` and `clerk`. Extensible without schema change.

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
  created_at          TIMESTAMP

user_roles:
  user_id             ULID FK
  role_id             ULID FK
  PRIMARY KEY (user_id, role_id)
```

### Future-proofing notes

- **Passkeys (WebAuthn):** add an `authenticators` table later; login flow grows a passkey branch. Nothing here blocks it.
- **API tokens / service accounts:** reuse `sessions` with a `type` discriminator.
- **OAuth/SSO:** add `provider` column to sessions; everything else stays.

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
