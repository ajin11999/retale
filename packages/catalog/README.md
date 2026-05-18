# @retale/catalog

The public-facing online catalog — a SvelteKit app deployed to Vercel. It is
**read-only** and never touches the local Retale database: it serves a static
JSON snapshot that the Retale API publishes to Vercel Blob.

```
Retale API  ──publishCatalog──▶  Vercel Blob (catalog/snapshot.json)
                                        │
                                        ▼
                              @retale/catalog (this app)
```

## How publishing works

1. In the admin app, toggle each product's `onlineVisible` and its price /
   stock display modes (`catalog.manage` permission).
2. Trigger a publish (`catalog.publish`) — or let the daily scheduled job run.
   The API builds a snapshot (visible products only, prices/stock already
   masked) and writes it to one fixed Blob key, overwriting the previous one.
3. This app fetches that snapshot on each request. Nothing else changes the
   live catalog — it is static between publishes.

## Deploying to Vercel

1. **Create a Vercel Blob store** in the Vercel dashboard. Copy its
   `BLOB_READ_WRITE_TOKEN`.
2. **On the Retale API**, set `BLOB_READ_WRITE_TOKEN` in its environment, then
   run a publish once. The snapshot now lives at a stable public URL:
   `https://<store-id>.public.blob.vercel-storage.com/catalog/snapshot.json`
3. **Deploy this package** to Vercel:
   - Import the repo; set the **Root Directory** to `packages/catalog`.
   - Add the env var `PUBLIC_CATALOG_SNAPSHOT_URL` = the snapshot URL above.
   - Build command and output are auto-detected (SvelteKit + adapter-vercel).

No inbound access to the local network is ever required — the API only pushes
outbound to Blob; this app only reads from Blob.

## Local development

```sh
cp .env.example .env   # set PUBLIC_CATALOG_SNAPSHOT_URL
bun install
bun run dev
```

`bun run check` type-checks the app.
