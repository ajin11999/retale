# Retale — Project Context

## What This Is

Retale is a Bun + TypeScript rewrite of **ProDuck** (`C:\Users\frans\ProDuck\`), a POS and inventory management API originally written in ASP.NET Core 7. The goal is a cleaner, more maintainable backend that works efficiently with Claude Code and serves both a Flutter app (web + Android) and a potential web admin panel.

**Fresh-design rule:** ProDuck is NOT a schema constraint — it is only a one-time data source via importer. See `docs/design-decisions.md` for locked architectural decisions (ULID IDs, integer minor units, stock ledger, snapshot pattern, wipe-and-restore importer). Read that before writing schema or migrations.

---

## Monorepo Structure

```
retale/
├── package.json            ← Bun workspace root (scripts: dev, dev:console, test, db:*, …)
├── packages/
│   ├── api/                ← Main GraphQL API (Elysia + graphql-yoga)
│   │   └── src/
│   │       ├── schema/     ← GraphQL type defs + resolvers (by domain)
│   │       ├── services/   ← Business logic (StockService, LandedCostService, etc.)
│   │       ├── lib/        ← auth, jwt, argon2, db client, pagination helpers
│   │       └── index.ts    ← Elysia app entry point
│   ├── console/            ← Back-office admin web app (SvelteKit + Houdini GraphQL client)
│   ├── catalog/            ← Product catalog web app (SvelteKit)
│   ├── pos/                ← POS register app (Flutter — Windows/Linux native + web/PWA)
│   └── shared/             ← Shared TypeScript types (consumed by api + web packages)
│       └── src/
```

---

## Stack Decisions

| Concern         | Choice                    | Reason |
|-----------------|---------------------------|--------|
| Runtime         | **Bun**                   | Fast, built-in test runner, Claude Code efficient |
| HTTP server     | **Elysia**                | Bun-native, excellent TypeScript, fast |
| API protocol    | **GraphQL** (graphql-yoga)| Single endpoint; Flutter + web browsers both work natively; Apollo/Artemis clients on Flutter |
| ORM             | **Drizzle ORM**           | Lightweight, SQL-first, strong TS types, MariaDB support |
| Database        | **MariaDB** (same as ProDuck) | No migration needed |
| Auth            | **JWT HS512** via `jose`  | Same algorithm as ProDuck; existing tokens compatible |
| Password        | **Argon2id** via `@node-rs/argon2` | OWASP gold standard; same algorithm as ProDuck (compatible hashes) |
| Validation      | **Zod** (via Elysia's built-in TypeBox or standalone) | Schema-first validation |
| Web apps (console + catalog) | **SvelteKit** | Clean DX, less boilerplate, works well with Claude Code |

---

## Clients

- **POS app** (`packages/pos`, Flutter `retale_pos`) — Windows/Linux native + web/PWA. GraphQL register for the API.
- **Console** (`packages/console`) — SvelteKit back-office admin (purchases, inventory, etc.); Houdini GraphQL client.
- **Catalog** (`packages/catalog`) — SvelteKit product catalog web app.
- Network: **local network only** (no public internet). HTTP/1.1 or HTTP/2 both fine.

---

## Key Architectural Changes from ProDuck

### 1. No Soft Deletes → Snapshot Pattern

ProDuck used `IsDeleted`/`Deleted` flags. Retale removes these entirely.

**Instead:** `OrderItem` stores a snapshot of product details at time of sale:
```
orderItem {
  ...
  snapshotProductName   String
  snapshotProductCode   String?   // barcode
  snapshotProductCost   Decimal
  snapshotProductPrice  Decimal
  snapshotCategoryName  String?
}
```
This means:
- Products, customers, vendors can be **truly deleted** without cascading history loss
- Sales reports always show what was sold, with what name and price, forever
- No filtering logic needed everywhere

### 2. GraphQL instead of REST

ProDuck had two response shapes (`{ result }` and `{ payload, pagination }`). GraphQL handles this natively:
- Queries return typed data
- Errors go in `errors[]`
- Pagination via cursor or offset connections

### 3. Password Hashing

ProDuck used Argon2 (via `Isopoh.Cryptography.Argon2`). Retale uses `@node-rs/argon2` with Argon2id.
- Existing password hashes from ProDuck DB **may be compatible** — verify hash prefix format before migration.

### 4. Response Envelope

No custom envelope middleware needed. GraphQL spec provides:
```json
{ "data": { ... }, "errors": [...], "extensions": { ... } }
```

---

## Domain Model (from ProDuck, adapted)

### Entities to Keep (with modifications)
- **User** — remove `IsDeleted`, keep role/claim system
- **Claim** — unchanged (role names)
- **Product** — remove `Deleted` flag; truly deletable
- **ProductCategory** — unchanged (hierarchical, self-referential)
- **StockLocation** — unchanged (location-based inventory)
- **Location** — unchanged (hierarchical)
- **PointOfSale** — remove `IsDeleted`
- **POSSession** — unchanged
- **Order** — unchanged
- **OrderItem** — **add snapshot fields** (see above)
- **Customer** — remove `IsDeleted`
- **CustomerPrice** — unchanged
- **Vendor** — remove `IsDeleted`
- **Purchase** — unchanged
- **PurchaseOrder** — unchanged
- **LandedCost** — unchanged
- **LandedCostItem** — unchanged (hierarchical, parent-child)

### Entity Removed
- **DeliveryOrder** — was stubbed in ProDuck, never implemented. Skip entirely.

---

## Business Logic to Preserve

### StockService (critical)
- `modifyStock(productId, qty, preferredLocationId?)` — decrements stock from highest-qty location
- Lazily creates a "root" stock entry (null locationId) if no location stock exists
- Supports negative quantities (returns/adjustments)

### LandedCost Delivery (most complex)
- Hierarchical `LandedCostItem` tree — parent items have child cost allocations
- On deliver: distributes cost to products proportionally by PurchaseOrder quantity
- Updates `Product.cost` if the landed cost is higher than current cost
- Moves stock from `sourceLocation` to `targetLocation`
- Wrap in a transaction

### Order Creation
- Auto-creates a `POSSession` if none is open for the POS
- Calls StockService for each OrderItem
- Snapshots product details into OrderItem fields

### Category / Location Cascade
- Deleting a category: reparent its products to null (or parent category) — no silent cascade
- Deleting a location: merge child stock up, reparent child locations

---

## Auth Model

- Access tokens: JWT HS512, **60-minute** expiration (`packages/api/src/lib/jwt.ts`).
  Claims: `sub` (userId), `isRoot`, `roleIds`. Do NOT lengthen the TTL — clients
  renew via refresh tokens.
- Refresh tokens: opaque rotating tokens (`{sessionId}.{secret}`, argon2-hashed),
  30-day expiry, stored in the `sessions` table. Rotation reuse is treated as
  theft and revokes the session — clients must single-flight their refreshes.
- Clients refresh via the `refreshToken` GraphQL mutation: the POS in
  `auth_service.dart`, the console server-side in `$lib/server/session.ts`
  (hooks.server.ts refreshes near-expiry tokens on every SSR request).
- Bootstrap: create first user (auto-assigns root) when users table is empty
- Secret: env var `JWT_SIGNING_KEY`

---

## ProDuck API Surface (Reference)

Full endpoint list preserved in `docs/produck-api-reference.md` for parity checking during development.

---

## Environment Variables

```env
DATABASE_URL=mysql://produck:password@127.0.0.1:3306/retale
JWT_SIGNING_KEY=<long random string, HS512>
PORT=3000
```

---

## Development Notes

- `bun run dev` (API, port 3000) and `bun run dev:console` (admin, port 5173) at workspace root
- Drizzle migrations in `packages/api/drizzle/`
- Schema changes: `bun run db:generate` then `bun run db:migrate`. **Do not** run
  `drizzle-kit migrate` — its CLI hangs on this Windows + Bun + MariaDB setup; `db:migrate`
  applies via drizzle-orm's programmatic migrator (`scripts/migrate.ts`). See the
  `db-migrate` skill.
- After an API GraphQL schema change, resync the console: see the `houdini-sync` skill.
- GraphQL playground available at `/graphql` in development

## Commit conventions

- Use Conventional Commits: `feat:`, `fix:`, `chore:`, `test:`, `refactor:`, `docs:`,
  with a concise scope where useful (e.g. `feat: console — …`).
- **Never** commit with a throwaway message like the model name (`opus`) or a bare symbol.
  Every commit subject must describe the change.
