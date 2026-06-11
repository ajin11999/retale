---
name: verify-ui
description: Launch the Retale API + console (or catalog) locally, sign in, and visually verify a page or screenshot a route. Use when asked to run the console/catalog, check a UI change in the real app, or screenshot a console route.
---

# Verifying a Retale web UI change

This skill captures the project-specific bits (ports, dev login, prerequisites). For
the actual browser driving / screenshotting, lean on the built-in `run` / `verify`
skills — this just tells them how Retale starts and authenticates.

## Prerequisites (API side)

The console/catalog are useless without the API + a seeded database:

1. **Database** — bring up MariaDB if it isn't running:
   ```
   docker compose up -d
   ```
2. **API** — from the workspace root:
   ```
   bun run dev          # @retale/api on http://localhost:3000  (GraphQL at /graphql)
   ```
3. **Dev login user** — root users require 2FA, so seed a full-permission non-root user:
   ```
   bun run dev:seed-user        # creates  manager / manager12345
   ```
   (Idempotent — safe to re-run. Custom: `bun run dev:seed-user <user> <pass>`.)

## Launch the web app

- **Console** (back-office admin):
  ```
  bun run dev:console          # vite dev → http://localhost:5173
  ```
- **Catalog**:
  ```
  bun run --filter @retale/catalog dev   # vite dev (next free port, e.g. 5174)
  ```

Both read `GRAPHQL_URL` from their `.env` (default
`http://localhost:3000/graphql`; the console proxies all browser GraphQL
through its own `/graphql` route) — make sure the API is up first.

## Sign in, then verify

1. Navigate to `http://localhost:5173/login`.
2. Sign in with `manager` / `manager12345`.
3. Navigate to the route under test and capture/inspect.

## Notes

- Console route groups live under `packages/console/src/routes/(app)/...` (e.g.
  `/purchases`, inventory). `/login` and `/logout` are outside the group.
- If a query returns nothing, you likely need dev data:
  `bun run dev:seed-products`, `bun run dev:seed-receiving`.
- If the console shows GraphQL/type errors after an API schema change, run the
  [[houdini-sync]] flow first.
