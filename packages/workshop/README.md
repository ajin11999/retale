# retale_workshop

Offline-first **workshop job sheet** for Retale. A clerk builds up a job
(parts + labour lines, grouped into sections) and takes deposits over days; when
a non-deposit payment settles the balance, the whole job is submitted to the
Retale API as **one walk-in `createPosOrder`** (no customer) and stamped as
uploaded. Nothing hits the main system until the job is paid in full.

This is the deliberate alternative to ad-hoc Console sales — the stateful
`createCustomerSale` requires a customer and an on-account ledger, which a
walk-in workshop sale doesn't have.

## Targets

The same code runs on:

- **Native desktop** — Windows / Linux (`flutter run -d windows` / `-d linux`).
- **Web / PWA** — for devices that can't run the native build (e.g. a
  Chromebook, which installs PWAs from the browser's "Install" prompt).

## Local store

Jobs live entirely on the device until uploaded, in a **sembast** document
store (`lib/db.dart`, `lib/services/project_repo.dart`):

- A pure-Dart JSON document store with **one API across native and web** — it
  uses a file under the app documents dir on desktop and **IndexedDB** in the
  browser. The platform is picked by a conditional import in
  `lib/platform/db_opener.dart`.
- Each job is one `Project` document (`lib/schema/`): a `Project` holds a tree
  of `WorkLine`s (groups + leaves) and a `WorkPayment` history. Models are plain
  Dart with `toJson`/`fromJson` — no code generation.
- The UI is reactive: `watchActive()` (job list) and `watch(id)` (open sheet)
  are live sembast streams that emit immediately and on every change.

> Migrated off Isar (Isar 3 can't compile to web — its generated schemas embed
> 64-bit hashes dart2js rejects), which is what unblocked the PWA target.

## Run / build

The Flutter SDK on this machine is at `C:\bin\flutter` (not on PATH).

```sh
# install deps
flutter pub get

# native desktop (Windows / Linux toolchain required)
flutter run -d windows

# web (dev server)
flutter run -d chrome

# build the installable PWA (output in build/web/) — offline-first with
# CanvasKit bundled locally so it boots on the LAN with no public internet.
# From the repo root this is exposed as `bun run build:workshop-web`.
flutter build web --no-web-resources-cdn
```

In the LAN deploy stack the build is served by Caddy at
**`https://<HOST_IP>:8082`** — bind-mounted in `docker-compose.prod.yml`, baked
into the `retale-caddy` image for the distributable stack — alongside POS web on
`:8081`. Chrome OS then offers "Install" from that origin and the app gets its
own window + launcher icon. The PWA reaches the API (at `:8443`) once per job to
submit the settled sale; the job sheet itself works fully offline.

## Config

- API base URL + selected POS are stored in `shared_preferences`; auth tokens in
  `flutter_secure_storage`. Set them on first launch via the API-settings and
  POS-selection screens.
