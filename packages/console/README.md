# @retale/console

Internal admin console for Retale — SvelteKit + Tailwind v4 + shadcn-svelte
components, with [Houdini](https://houdinigraphql.com) as the GraphQL client.

## Setup

```sh
bun install                    # from the workspace root
cp packages/console/.env.example packages/console/.env
```

```sh
bun run dev                    # workspace root — starts @retale/api on :3000
bun run dev:console            # workspace root — starts the console on :5173
```

Houdini codegen reads the GraphQL SDL from the committed `schema.graphql`, so
it does **not** need the API running to build. When the API's schema changes,
regenerate it:

```sh
bun run schema:dump            # workspace root — refreshes packages/console/schema.graphql
```

The console still needs the API reachable **at runtime** — see `GRAPHQL_URL`.
All GraphQL (SSR and browser) flows through the console's own `/graphql`
proxy route, which attaches a freshly rotated access token server-side, so
browsers never talk to the API directly.

## What's here (first slice)

- **Auth** — `/login` posts the `login` mutation server-side, stores the JWT in
  an httpOnly cookie. `hooks.server.ts` refreshes it near expiry and feeds it
  to the `/graphql` proxy via `locals`.
- **App shell** — `(app)/+layout.svelte`: sidebar nav + topbar, guarded by
  `(app)/+layout.server.ts` (validates the token via the `me` query).
- **Products list** — `(app)/products`: a TanStack-backed data table with
  global search, column sorting, and pagination.

## Design system

shadcn-svelte-style primitives live in `src/lib/components/ui/`. They are hand
-authored copies you own outright — extend them with the `shadcn-svelte` CLI as
new screens need more components.
