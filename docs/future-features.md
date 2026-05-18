# Future Features

Parked ideas raised during design that aren't in `design-decisions.md` yet. Pick up when their consumer (frontend, importer, etc.) actually needs them.

---

## Online catalog website

Public-facing website surfacing products from Retale — info, images, optional stock and price visibility.

### Product discoverability

Per-product show/hide governs whether a product appears on the catalog at all. This is the `online_visible` flag (schema below) — the **master switch** and the discoverability control in one:

- `online_visible = false` — the product does not exist as far as the catalog is concerned: not listed, not searchable, no detail page.
- `online_visible = true` — the product is discoverable: appears in listings, search, and category browsing on the catalog.
- Default is `false` — a product is invisible online until the business explicitly opts it in. Nothing leaks by accident.
- The admin UI gets a catalog-management view for toggling visibility in bulk (filter by category, multi-select, show/hide) — opting products in one at a time is too slow for a large catalog.

Visibility only takes effect on the next **publish** (see Publishing model) — toggling `online_visible` edits the local DB; the live catalog doesn't change until a snapshot is uploaded.

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

Defaults are conservative — nothing leaks until the business explicitly opts a product in.

### Publishing model — static catalog, separate online DB

The online catalog is **not** a live view of the local Retale database. It runs on its own **online database**, physically separate from the local main DB, and is **static between publishes** — it changes only when a fresh snapshot is uploaded.

Flow:

1. **Local DB is the source of truth.** Editing products, prices, visibility, images — all happens locally as normal. The live catalog is unaffected.
2. **Publish = build a snapshot + push it online.** The snapshot contains only `online_visible = true` products, each rendered per its `online_price_mode` / `online_stock_mode` (prices already masked, stock already fuzzed — raw cost/qty never leave the local network).
3. The online catalog site reads exclusively from the online DB. It never connects back to the local DB.

**Transport.** The Retale server is granted **outbound HTTPS** for this job (still no inbound — the local network stays unreachable from outside). The server pushes the snapshot directly to the online catalog endpoint.

**Triggers** — two ways to publish:

- **On demand** — an admin "Publish to catalog now" action. Used after a batch of edits the business wants live immediately.
- **Daily schedule** — a server-side scheduled job pushes a snapshot once a day (configurable time). Keeps the catalog reasonably fresh without anyone remembering to click.

Both run the same snapshot-build + push code path; the schedule is just an automated caller.

**Permissions.** Publishing pushes data to the public internet — one of the most sensitive actions in the system. Two new RBAC keys (see `design-decisions.md` permission catalog):

- `catalog.manage` — toggle `online_visible` and the per-product price/stock modes.
- `catalog.publish` — trigger an on-demand publish.

Both default to root (or a senior role); neither belongs in `cashier_lite` or `clerk`. The **daily scheduled job runs as the system**, not a user, so it bypasses RBAC by design — only the manual trigger is gated.

**Freshness disclaimer.** Because the catalog is static between publishes, a visitor can see a stale price or stock figure. The catalog UI should show "prices/stock as of `<last publish date>`, subject to confirmation" — sourced from the `catalog_publishes` log — so the business is never held to an outdated number.

**Notes for when this is built:**

- The publish job should record a `catalog_publishes` log row (timestamp, trigger = `manual` | `scheduled`, product count, success/error) so the admin can see when the catalog last went live and whether it worked.
- Snapshot push should be atomic on the online side — readers see either the old snapshot or the new one, never a half-applied one (publish to a staging table / version, then flip).
- Only masked/fuzzed values cross the boundary; the masking happens during snapshot build, on the local side.

**Why static + separate DB:** The catalog faces the public internet; the main DB must not. A separate online DB with a one-way push keeps the local network unreachable, lets the business control exactly what (and when) competitors see, and means catalog traffic never touches the POS database.

**Why:** Customer-facing window to check stock and read product details, without exposing pricing to competitors and without lying about stock for uncountable items.

---

## Delivery completeness UI + API — receiving check

The physical receiving workflow: inventory staff stand at a vendor's delivery box, verify its contents against the purchase, count what actually arrived, and move it into storage. The "completeness" framing is for staff — *which lines are still owed, which arrived short, which are done.*

### Client form factor

API is **client-agnostic GraphQL** — the same surface serves either:

- A **dedicated Android app** — best ergonomics for walking the warehouse with a camera barcode scanner.
- The **existing web/Flutter app** on a tablet — browser camera scanning works too, just clunkier.

This is a frontend choice; the API design below assumes nothing about it. Scanning is supported on both (see *Identifying a line*).

### The check is a persisted, resumable draft

A receiving check is not instant — a big delivery takes a while, staff get interrupted, shifts hand off. So the draft `purchase_delivery` **persists and saves progress as staff go**:

1. **Start a check** → creates a `purchase_delivery` (`status = draft`) for the purchase, with its single `target_location_id` chosen up front. (Design-decisions rule kept: one delivery → one target location. To split arriving stock across multiple storage spots, receive into one location then do a stock transfer — or run separate checks/deliveries.)
2. **Count lines as you go** → each counted line upserts a leaf `purchase_delivery_item` (`purchase_item_id`, `qty`). Staff can pause, close the app, hand the tablet to a colleague, resume later — the draft holds the running state.
3. **Commit when done** → draft → delivered, atomically. Stock movements + WAC recompute happen here (the existing `commitDelivery` machinery).

A purchase can have an open draft check; the purchase detail page surfaces "resume in-progress check" rather than starting a fresh one.

### Identifying a line — scan + manual fallback

- **Scan** — barcode / vendor code resolves to a variant (our variant barcode, or `vendor_variant_codes` for the vendor's part number), then to the matching `purchase_item` on this purchase. The check screen jumps to that line and focuses its qty input.
- **Manual** — browse the PO line list and pick. Always available; the only option for **non-stock lines** (`variant_id NULL` — consumables have no barcode).
- **Edge case:** if the same variant appears on more than one `purchase_item` of the purchase (e.g. two sections), a scan can't disambiguate — prompt staff to pick which line.

### UX shape

The check screen lists all `purchase_items` with `qty_ordered` / `qty_delivered` / `remaining` (`qty_ordered − qty_delivered`), each showing a **completeness status** (below). Per line: a qty input (default = `remaining`) for what's in *this* box. Scan to jump, or tap a line. A running "lines done / lines remaining" summary. Commit button enabled once at least one line has a qty.

### Per-item completeness status (derived)

Each line, from `qty_delivered` vs `qty_ordered`: `not_started` (0), `partial` (0 < delivered < ordered), `complete` (delivered == ordered). The receiving screen also shows a **provisional** status that folds in the qty being entered in the current check, so staff see "this will complete the line" before committing. Non-stock lines (`variant_id NULL`) follow the same rules — no stock movement on commit.

### API surface to build

```
startReceivingCheck(purchaseId: ULID, targetLocationId: ULID): PurchaseDelivery
  -- creates (or returns the existing open) draft delivery for the purchase

setReceivingCheckLine(deliveryId: ULID, purchaseItemId: ULID, qty: BigInt): PurchaseDelivery
  -- upsert a leaf; qty 0 removes the line. Save-as-you-go.

resolveReceivingScan(purchaseId: ULID, code: String): [PurchaseItem!]
  -- code → variant → matching purchase_item(s); multiple = needs disambiguation

commitReceivingCheck(deliveryId: ULID): PurchaseDelivery
  -- draft → delivered via existing commitDelivery; validates the
  --   partial-delivery constraint per line in the same transaction
```

Plus a read resolver for the purchase detail / check screen — most fields already live on `purchase_items` (`qty_ordered`, `qty_delivered`); compute `remaining` and completeness server-side. `markPurchaseItemsDelivered` (single-shot start + lines + commit) is optional sugar for trivially small deliveries, but the resumable flow above is primary.

**Permissions** reuse the existing delivery keys — no new ones: `startReceivingCheck` / `setReceivingCheckLine` / `resolveReceivingScan` require `delivery.draft`; `commitReceivingCheck` requires `delivery.commit`. Note that `delivery.commit` is *not* in the `clerk` template — only `inventory_manager`. So the "inventory staff" who run a full receiving check are operating at `inventory_manager` level; if a lighter receiving-only role is wanted, clone a role with just `delivery.draft` + `delivery.commit`.

**Why:** Partial deliveries from vendors are common, and a real receiving check is a physical task done over minutes with interruptions — not one atomic click. The natural staff flow is "scan a part, count it, repeat, commit when the box is empty," with progress that survives a paused shift.

---

## Automating the "send PO to vendor" workflow

The base feature is specified in `design-decisions.md` (Purchases & deliveries → *Sending a purchase order to the vendor*): server renders, client sends via `wa.me`/`mailto:` deep links. These ideas build on it.

### Reorder-point → suggested reorders *(biggest win)*

Stock depletes; the business should be told what to reorder before it runs out — without anyone watching levels by hand.

**Schema:**

- `product_variants.reorder_point BIGINT NULL` — minimum stock (smallest unit) before the variant wants reordering. `NULL` = not tracked, excluded from the scan.
- `product_variants.reorder_qty BIGINT NULL` — how much to suggest ordering when triggered. `NULL` falls back to "enough to reach reorder_point" or a sensible default.
- `vendor_variant_codes.is_preferred BOOLEAN NOT NULL DEFAULT false` — marks the go-to vendor for that variant. Partial unique index enforces at most one preferred vendor per variant.

**Daily scheduled scan.** Once a day a server job scans every variant with a `reorder_point` set. Batching a day's depletion into one run keeps it quiet — a busy variant doesn't churn suggestions all day.

The scan compares `reorder_point` against **available stock, not just on-hand**:

```
available = on_hand + on_order
on_hand   = Σ stock across locations for the variant
on_order  = Σ(qty_ordered − qty_delivered) over purchase_items of
            non-cancelled purchases for the variant
```

Netting out `on_order` is essential — without it, a low variant that *already* has an open PO gets re-suggested every day until the delivery lands, producing duplicate orders. A variant is suggested only when `available < reorder_point`.

**Vendor selection** per below-threshold variant:

1. The `is_preferred` vendor from `vendor_variant_codes`, if set.
2. Else the **last-used** vendor — most recent `purchase` containing the variant.
3. Else unassigned — the variant lands in an "unassigned" bucket for staff to route manually.

**Output is a review list, not draft rows.** The scan writes a `reorder_suggestions` set (variant, suggested qty, chosen vendor, current stock, reorder point), grouped by vendor. **Nothing is written to `purchases`.** Staff open the suggestions screen, adjust qty / vendor / drop lines, and confirm — only then are real draft `purchases` created (one per vendor), ready to edit and send. This keeps machine guesses out of the purchase list.

```
reorder_suggestions:
  id                ULID PK
  variant_id        ULID FK → product_variants  ON DELETE CASCADE
  vendor_id         ULID FK → vendors  NULL        -- NULL = unassigned bucket
  current_stock     BIGINT NOT NULL                -- snapshot at scan time
  reorder_point     BIGINT NOT NULL                -- snapshot at scan time
  suggested_qty     BIGINT NOT NULL
  status            ENUM('open','converted','dismissed') NOT NULL DEFAULT 'open'
  generated_at      TIMESTAMP NOT NULL
  INDEX (status), INDEX (vendor_id)
```

A new scan supersedes the previous `open` suggestions (re-scan from current stock); `converted` / `dismissed` rows are kept as a light audit of what was acted on.

### Other automation

- **Per-vendor default channel** — `preferred_send_channel ENUM('whatsapp','email')` column on `vendors`; the send screen pre-selects the channel instead of asking each time.
- **Clone / recurring PO** — "duplicate this purchase as a new draft." Businesses reorder the same basket repeatedly.
- **Unmapped-line pre-send warning** — if a PO line has no `vendor_variant_codes` entry for that vendor, warn before sending (the vendor won't recognize the part) and offer to add the mapping inline.
- **No-delivery reminder alert** — tie into the product `alerts` system: a PO sent N days ago with nothing received raises an acknowledgeable alert.
- **Send-confirmation capture** — when the vendor replies "confirmed," let the clerk flip `purchase_sends.status → sent` and optionally record an expected-delivery date that feeds the reminder above.
- **Configurable message template** — business-level greeting/footer for the WhatsApp/email body.

**Why:** Sending is the manual touchpoint between "we need parts" and "parts arrive." Removing the keystrokes around it — noticing what's low, knowing the vendor and channel, drafting the PO, chasing late deliveries — is where the time goes.
