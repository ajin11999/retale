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

5. Export Caddy's local-CA root certificate and install it on **every client**
   (console browsers and POS web devices). Without it, browsers show cert
   warnings and the POS PWA service worker will not register (no offline mode):

   ```
   docker compose -f docker-compose.prod.yml cp caddy:/data/caddy/pki/authorities/local/root.crt retale-root.crt
   ```

   Windows: install into "Trusted Root Certification Authorities".
   ChromeOS: Settings → Security and privacy → Manage certificates → Authorities → Import.
   The CA lives in the `caddy-data` volume, so it survives restarts — clients
   only trust it once.

6. POS / Workshop apps (native or web): enter `https://<HOST_IP>:8443` as the
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
- **Backups:** the database has no cloud copy. Dump it on a schedule, e.g.:

  ```
  docker compose -p retale-prod exec mariadb mariadb-dump -uroot -p"$MARIADB_ROOT_PASSWORD" retale > backup.sql
  ```

## Notes

- The dev `docker-compose.yml` (MariaDB only, port 3306) is unrelated; the prod
  stack uses project name `retale-prod`, its own volumes, and publishes only
  443/8443/8081. Both can run on the same machine.
- Console browser traffic goes through the console's own same-origin `/graphql`
  proxy; only the POS web origin calls the API cross-origin, and Caddy answers
  CORS for it at `:8443`.
- `BLOB_READ_WRITE_TOKEN` (catalog snapshot publishing to Vercel Blob) needs
  outbound internet from the api container; leave it empty to disable.
