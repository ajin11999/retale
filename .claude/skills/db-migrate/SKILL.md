---
name: db-migrate
description: Generate and apply a Drizzle/MariaDB schema migration in the Retale api package. Use whenever the Drizzle schema under packages/api/src changes, or when the user asks to create, generate, or apply a database migration.
---

# Applying a schema change (Retale)

The Drizzle schema lives in `packages/api/src/` and migrations in `packages/api/drizzle/`.
Run all commands from the **workspace root** (`C:\Users\frans\retale`).

## Steps

1. **Generate** the SQL migration from the current schema:
   ```
   bun run db:generate
   ```
   This calls `drizzle-kit generate` and writes a new file under `packages/api/drizzle/`.
   Read the generated SQL before applying — confirm it matches the intent and has no
   accidental drops.

2. **Apply** the migration:
   ```
   bun run db:migrate
   ```
   ⚠️ This runs `scripts/migrate.ts` (drizzle-orm's programmatic `migrate()`), **not**
   `drizzle-kit migrate`. The drizzle-kit CLI exits non-zero without applying on this
   Windows + Bun + MariaDB setup — do **not** call it. See memory `drizzle-kit-migrate-hangs`.

3. If the change affects the **GraphQL** API surface that the console consumes, also refresh
   the SDL + Houdini types (separate flow): `bun run schema:dump`, then regenerate in
   `packages/console`.

## MariaDB / Drizzle gotchas (from memory)

- No `LATERAL` joins — never use `with:` in `db.query.*`. See `drizzle-mariadb-no-lateral`.
- Generated columns: no `NOT NULL`, no table-qualified refs in the expression.
  See `mariadb-generated-columns`.
- `json()` columns read back as **unparsed strings** — normalize before use.
  See `drizzle-mariadb-json-as-text`.

## Verify

After applying, optionally run the api tests against the isolated test DB:
```
bun run --filter @retale/api test
```
