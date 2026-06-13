# Retale LAN production stack

One host on a static LAN IP runs the whole server stack with Docker Compose:
MariaDB + API + console + Caddy (TLS). The catalog stays on Vercel and is not
part of this stack.

| Address (from any LAN device)  | Service |
|--------------------------------|---------|
| `https://<HOST_IP>`            | Console (back-office admin) |
| `https://<HOST_IP>:8443`       | API — GraphQL at `/graphql` + HTTP routes |
| `https://<HOST_IP>:8081`       | POS web/PWA (static Flutter build) |

## First-time setup

1. Reserve a static IP for the host in the router (DHCP reservation).
2. `cp .env.prod.example .env.prod` and fill in `HOST_IP` + fresh secrets.
3. Build the POS web bundle on the host (Flutter is not containerized):

   ```
   bun run build:pos-web
   ```

4. Bring the stack up:

   ```
   docker compose -f docker-compose.prod.yml --env-file .env.prod up -d --build
   ```

   The api container applies DB migrations on every start (look for
   `✓ migrations applied` in `docker compose -p retale-prod logs api`).

5. Create the first (root) user. There is no sign-up screen and the GraphQL
   playground is disabled in production, so call the `bootstrap` mutation once
   directly — it only works while the users table is empty (`-k` because the
   CA is not trusted yet; see the next step):

   ```
   curl -k https://<HOST_IP>:8443/graphql \
     -H 'content-type: application/json' \
     -d '{"query":"mutation($u:String!,$p:String!,$n:String!){bootstrap(username:$u,password:$p,name:$n){user{id username isRoot}}}","variables":{"u":"admin","p":"<strong-password>","n":"Administrator"}}'
   ```

   Sign into the console with that username/password. Root users must enrol 2FA
   (mandatory by design): on first login the account is locked out of every
   action until you complete 2FA setup on the **Account** page. To add further
   day-to-day (non-root) logins afterwards, use the console's user management
   rather than this mutation.

6. Export Caddy's local-CA root certificate and install it on **every client**
   (console browsers and POS web devices). Without it, browsers show cert
   warnings and the POS PWA service worker will not register (no offline mode):

   ```
   docker compose -f docker-compose.prod.yml cp caddy:/data/caddy/pki/authorities/local/root.crt retale-root.crt
   ```

   Windows: install into "Trusted Root Certification Authorities".
   ChromeOS: Settings → Security and privacy → Manage certificates → Authorities → Import.
   The CA lives in the `caddy-data` volume, so it survives restarts — clients
   only trust it once.

7. POS / Workshop apps (native or web): enter `https://<HOST_IP>:8443` as the
   API address on first launch.

## Day-to-day

- **Update app code:** pull, then
  `docker compose -f docker-compose.prod.yml --env-file .env.prod up -d --build`
  (rebuilds api/console images; migrations apply automatically).
- **Update POS web:** `bun run build:pos-web`, then
  `docker compose -f docker-compose.prod.yml restart caddy` (it's a bind mount;
  the restart just clears any cached file handles).
- **Logs:** `docker compose -p retale-prod logs -f api` (or `console`, `caddy`).
- **Stop:** `docker compose -p retale-prod down` — data persists in named
  volumes (`dbdata`, `uploads`, `caddy-data`). Never `down -v` in production.
- **Backups:** see the next section — the database has no cloud copy, so
  schedule `bun run backup` on the host.

## Backup & restore

`bun run backup` snapshots everything stateful — a gzipped `mariadb-dump` of
the database plus the uploads volume — into a timestamped folder under
`backups/` (gitignored), with a `manifest.json`. It reads credentials from
`.env.prod`, so run it from the repo checkout on the host:

```
bun run backup --keep 30                 # prod stack; prune to the 30 newest
bun run backup --dev                     # dev docker-compose DB instead
bun run backup --out D:/retale-backups   # write to another drive (recommended)
```

Schedule it (backups on the same disk as the database don't survive a dead
disk — point `--out` at a second drive or a network share):

- Linux host: `crontab -e` →
  `0 2 * * * cd /path/to/retale && bun run backup --keep 30 --out /mnt/backups`
- Windows host: Task Scheduler → daily → program `bun`, arguments
  `run backup --keep 30 --out D:\retale-backups`, "Start in" = the repo dir.

`bun run restore <backup-dir>` puts a backup back. It stops `api` + `console`,
drops and reloads the database, replaces the uploads volume, then starts the
services again (the api re-applies migrations at startup, so restoring an
older backup onto newer code is fine):

```
bun run restore backups/retale-prod-20260612-020000          # prompts y/N
bun run restore backups/retale-prod-20260612-020000 --yes    # non-interactive
bun run restore backup.sql.gz --db-only                      # bare dump, DB only
bun run restore backups/retale-prod-20260612-020000 --dev    # load prod data into dev
```

Restore is destructive (the current database is dropped); it refuses to run
non-interactively without `--yes`. Test the restore path on the dev stack
(`--dev`) before you need it in anger.

## Notes

- The dev `docker-compose.yml` (MariaDB only, port 3306) is unrelated; the prod
  stack uses project name `retale-prod`, its own volumes, and publishes only
  443/8443/8081. Both can run on the same machine.
- Console browser traffic goes through the console's own same-origin `/graphql`
  proxy; only the POS web origin calls the API cross-origin, and Caddy answers
  CORS for it at `:8443`.
- `BLOB_READ_WRITE_TOKEN` (catalog snapshot publishing to Vercel Blob) needs
  outbound internet from the api container; leave it empty to disable.
