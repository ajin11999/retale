# Distributing Retale as pre-built images

This stack runs on a target machine with **only Docker** — no repo clone, no
local build. Images are published to GitHub Container Registry (GHCR) and the
operator runs `docker-compose.dist.yml` against them.

There are two roles below: **maintainer** (you, publishing releases) and
**operator** (whoever installs it on the host).

---

## Maintainer — publish a release

Images and apps are built by the `Publish images & apps` GitHub Action
(`.github/workflows/publish-images.yml`) when you push a version tag:

```
git tag v2026.06.15
git push origin v2026.06.15
```

This builds three container images (tagged with the version and `latest`) and
pushes them to GHCR:

- `ghcr.io/fransiscowijaya1999/retale-api`
- `ghcr.io/fransiscowijaya1999/retale-console`
- `ghcr.io/fransiscowijaya1999/retale-caddy` (Caddyfile + POS and workshop web bundles baked in)

### Stockeeper APK

When files under `packages/stockeeper/` have changed since the previous tag, the
workflow also builds the **stockeeper** Android APKs (`--release --split-per-abi`)
and uploads them to the **GitHub Release** for that tag:

- `app-armeabi-v7a-release.apk` — older 32-bit ARM devices
- `app-arm64-v8a-release.apk` — most modern phones
- `app-x86_64-release.apk` — emulators and x86 tablets

If nothing in `packages/stockeeper/` changed, the APK build is **skipped
entirely**, saving ~15–30 min of runner time.

### Keystore setup (one-time)

The APKs are signed with a release keystore stored as GitHub secrets. You need
to configure four repository secrets:

| Secret | Value |
|---|---|
| `STOCKEEPER_KEYSTORE` | Base64-encoded `.jks` keystore file |
| `STOCKEEPER_STORE_PASSWORD` | Password for the keystore |
| `STOCKEEPER_KEY_PASSWORD` | Password for the key entry |
| `STOCKEEPER_KEY_ALIAS` | Alias of the key inside the keystore |

**Generating a new keystore** (if you don't have one yet):

```bash
keytool -genkeypair \
  -alias upload \
  -keyalg RSA -keysize 2048 \
  -validity 10000 \
  -keystore upload-keystore.jks \
  -storepass YOUR_STORE_PASSWORD \
  -keypass YOUR_KEY_PASSWORD \
  -dname "CN=Retale, O=Retale, L=Jakarta, C=ID"
```

**Encoding it for the secret:**

```bash
base64 -w 0 upload-keystore.jks    # Linux / Git Bash
# or
[Convert]::ToBase64String([IO.File]::ReadAllBytes("upload-keystore.jks"))   # PowerShell
```

Copy the output and paste it as the `STOCKEEPER_KEYSTORE` secret value in
**GitHub → repo → Settings → Secrets and variables → Actions → New repository
secret**.

> ⚠️ **Keep your keystore file safe.** If you lose it, you cannot push updates
> to any device that already has the app installed (Android verifies the signing
> key on updates). Store a backup somewhere secure outside of Git.

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

### Stockeeper app (Android)

The stockeeper APK is not part of the Docker stack — it runs on warehouse staff
phones. Download the right APK from the
[GitHub Releases](https://github.com/fransiscowijaya1999/retale/releases) page:

- Most phones → `app-arm64-v8a-release.apk`
- Older phones → `app-armeabi-v7a-release.apk`

Enable **"Install from unknown sources"** on the phone, then open the APK to
install. The app connects to the API at the same `HOST_IP` address.

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
