# Distributing Retale as pre-built images

This stack runs on a target machine with **only Docker** — no repo clone, no
local build. Images are published to GitHub Container Registry (GHCR) and the
operator runs `docker-compose.dist.yml` against them.

There are two roles below: **maintainer** (you, publishing releases) and
**operator** (whoever installs it on the host).

---

## Maintainer — publish a release

Images are built and pushed by the `Publish images` GitHub Action
(`.github/workflows/publish-images.yml`) when you push a version tag:

```
git tag v2026.06.15
git push origin v2026.06.15
```

This builds three images for the tag and `latest`, and pushes them to GHCR:

- `ghcr.io/fransiscowijaya1999/retale-api`
- `ghcr.io/fransiscowijaya1999/retale-console`
- `ghcr.io/fransiscowijaya1999/retale-caddy` (Caddyfile + POS and workshop web bundles baked in)

You can also trigger it manually from the repo's **Actions** tab
(workflow_dispatch), optionally overriding the tag.

**One-time GHCR setup:** the packages are created private by default. To let an
operator pull without a token, open each package on GitHub → *Package settings*
→ change visibility to **Public**. Otherwise give the operator a personal access
token with `read:packages` and have them `docker login ghcr.io` (see below).

---

## Operator — install on the host

The host needs Docker (with the Compose plugin) and **two files**, copied
anywhere: `docker-compose.dist.yml` and a filled-in `.env.prod`.

1. **Reserve a static LAN IP** for the host (router DHCP reservation).

2. **Create `.env.prod`** from `.env.prod.example` and fill it in:
   - `HOST_IP` — the static IP from step 1.
   - `MARIADB_PASSWORD`, `MARIADB_ROOT_PASSWORD` — fresh random hex
     (`openssl rand -hex 32`).
   - `JWT_SIGNING_KEY`, `TWO_FACTOR_ENC_KEY` — fresh random
     (`openssl rand -base64 48`).
   - `RETALE_TAG` — the release to run (e.g. `v2026.06.15`), or `latest`.

3. **Log in to GHCR** — only if the images are private:

   ```
   docker login ghcr.io        # username = GitHub user, password = read:packages PAT
   ```

4. **Start the stack** (no `--build` — it pulls the images):

   ```
   docker compose -f docker-compose.dist.yml --env-file .env.prod up -d
   ```

   The api applies DB migrations at startup — watch for `✓ migrations applied`
   in `docker compose -p retale-prod logs api`.

5. **Bootstrap the first user** and **install the Caddy CA certificate on every
   client** exactly as in [`deploy/README.md`](./README.md) §5–§7. Those steps
   are identical here — the `docker compose ... cp caddy:/data/...` cert export
   works the same against the pre-built caddy image.

Addresses once up: console at `https://<HOST_IP>`, API at `https://<HOST_IP>:8443`,
POS web at `https://<HOST_IP>:8081`, workshop web at `https://<HOST_IP>:8082`.

---

## Offline / air-gapped install (no registry)

If the host has no internet, ship the images as a tarball instead of pulling:

```
# maintainer (a machine that has pulled or built the images):
docker pull ghcr.io/fransiscowijaya1999/retale-api:v2026.06.15
docker pull ghcr.io/fransiscowijaya1999/retale-console:v2026.06.15
docker pull ghcr.io/fransiscowijaya1999/retale-caddy:v2026.06.15
docker save \
  ghcr.io/fransiscowijaya1999/retale-api:v2026.06.15 \
  ghcr.io/fransiscowijaya1999/retale-console:v2026.06.15 \
  ghcr.io/fransiscowijaya1999/retale-caddy:v2026.06.15 \
  mariadb:11.4 | gzip > retale-v2026.06.15.tar.gz

# operator (USB / network share), then the normal up -d:
docker load < retale-v2026.06.15.tar.gz
docker compose -f docker-compose.dist.yml --env-file .env.prod up -d
```

---

## Day-to-day

- **Upgrade:** set the new `RETALE_TAG` in `.env.prod`, then
  `docker compose -f docker-compose.dist.yml --env-file .env.prod pull` and
  `... up -d`. Migrations apply automatically on api start.
- **Logs / stop:** `docker compose -p retale-prod logs -f api`;
  `docker compose -p retale-prod down` (data persists in named volumes — never
  `down -v` in production).
- **Backups:** the `bun run backup/restore` wrappers need the repo + Bun. On a
  repo-less host, dump the DB directly:
  `docker exec retale-prod-mariadb-1 sh -c 'mariadb-dump -uroot -p"$MARIADB_ROOT_PASSWORD" --single-transaction retale' | gzip > retale-db.sql.gz`
  (and archive the `uploads` volume separately).
