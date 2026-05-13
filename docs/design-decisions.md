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
9. **Stock qty — `int`** (no fractional units for now).
10. **Audit columns — `created_at`, `updated_at` on every master table.** `created_by_user_id` where meaningful. `deleted_at` only on tables where audit-trail soft-delete is genuinely needed (TBD per table; default: no soft-delete).

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
