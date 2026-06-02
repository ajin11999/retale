---
name: houdini-sync
description: Regenerate the console's GraphQL schema + Houdini client types after the Retale API's GraphQL schema changes. Use whenever a resolver/type def under packages/api/src/schema changes, or when the console reports unknown fields / stale Houdini types.
---

# Syncing the console to the API's GraphQL schema (Retale)

The `console` package uses **Houdini**, which reads the SDL from a committed local
file (`packages/console/schema.graphql`) — not a live API. When the API's GraphQL
surface changes, that file and the generated `$houdini` types go stale until regenerated.

Run from the **workspace root** (`C:\Users\frans\retale`).

## Steps

1. **Dump the SDL** from the API into the console:
   ```
   bun run schema:dump
   ```
   This runs `packages/api/scripts/dump-schema.ts`, which imports the API's schema
   module directly and writes `packages/console/schema.graphql`. **No running API or
   database is needed** — it's pure codegen from source.

2. **Regenerate Houdini types + typecheck** the console:
   ```
   bun run --filter @retale/console check
   ```
   This runs `svelte-kit sync && houdini generate && svelte-check`, refreshing the
   `$houdini` runtime the routes import and surfacing any now-broken queries.

3. Commit the updated `packages/console/schema.graphql` alongside the API change —
   it's a checked-in artifact, so leaving it stale breaks teammates' codegen.

## Notes

- If `svelte-check` flags fields that no longer exist or type mismatches, that's the
  point — fix the console queries/components to match the new schema.
- The browser client and SSR both hit `GRAPHQL_URL` / `PUBLIC_GRAPHQL_URL` (see
  `packages/console/.env.example`, default `http://localhost:3000/graphql`) at
  runtime — but codegen does not, so step 1 works offline.
