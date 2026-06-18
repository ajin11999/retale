# Retale Stockeeper

The warehouse counting app for Retale — an Android Flutter app talking to the
Retale GraphQL API. Two flows, mirroring the real workflow:

- **Receiving** — count incoming goods against an open purchase order. Counts
  save as you go into the PO's draft **receiving check**, so a half-finished
  count survives app kills and phone swaps.
- **Reconcile** — count what is physically at one stock location and apply
  the differences.

## Scope

This app is for **counting only**:

- Auth: password login, 2FA challenge, JWT refresh, logout (same as the POS app)
- Receiving: pick an open PO, count by checklist or per-product counter,
  scanner-gun / typed / camera barcode entry
- Reconcile: pick a location, count, review the deltas, apply

It **never commits a receiving check** — freight / cost lines are added to the
delivery's cost tree and the delivery is committed in the web console
(`packages/console`). PO management, costing, and reporting also stay in the
console.

Reconcile sends **only touched lines** (`bulkAdjustStock`), so partial / spot
counts are safe: untouched stock is never adjusted.

## Permissions

The signed-in user needs: `purchase.edit`, `delivery.draft`, `location.edit`,
and `stock.adjust` (reconcile only). The seeded `inventory_manager` role has
all of them; `clerk` lacks `stock.adjust` (no reconcile).

## Project layout

```
lib/
  config/        AppConfig — API URL (shared_preferences)
  auth/          TokenStore (secure storage) + AuthService (login/2FA/refresh)
  graphql/       GraphQLService (client + error handling) + operations
  models/        PurchaseSummary, ReceivingLine, StockLevel, LocationNode
  widgets/       shared UI + camera ScanSheet (mobile_scanner)
  screens/       router -> api setup -> login -> 2FA -> menu
    receiving/   PO list -> receiving screen (checklist | by product)
    reconcile/   location count + review sheet
  screens/count_screen.dart   shared +1/+5/+10 counter
```

## Build

```sh
flutter pub get
flutter run -d <device>            # develop against a phone/emulator
flutter build apk --release        # or from the repo root: bun run build:stockeeper-apk
```

The APK lands in `build/app/outputs/flutter-apk/app-release.apk`; install it
directly on staff phones (local-network deployment, no store).

On first launch the app asks for the API base URL — it appends `/graphql`
itself. In production that is the Caddy HTTPS endpoint, e.g.
`https://192.168.1.10:8443` (dev against a local API can use plain
`http://192.168.1.10:3000`, but the prod stack only exposes HTTPS).

## Notes

- GraphQL client: **graphql_flutter** with hand-written documents in
  `lib/graphql/operations.dart`. If the schema drifts, update them there.
- Camera permission comes from mobile_scanner's manifest merge; it handles
  the runtime prompt itself. `minSdk = 23` (mobile_scanner requirement).
- Receiving quantities are integers (server-enforced); reconcile honours each
  variant's `qtyDecimals`.
- **TLS / CA:** the prod API is served by Caddy's self-signed local CA over
  HTTPS. The CA root is **bundled into the APK** as a Flutter asset
  (`assets/retale_ca.crt`) and trusted at the Dart TLS layer in
  `graphql_service.dart` (`loadTrustedCertificate`). This is required because
  graphql_flutter talks through Dart's `HttpClient`, which verifies TLS with
  BoringSSL against its own trust store — it ignores Android's
  `network_security_config.xml` and user-installed CAs, so a per-phone cert
  install would not help anyway. If the CA is rotated (the `caddy-data` volume
  is wiped — see `deploy/README.md` §6), re-export `root.crt` over
  `assets/retale_ca.crt` and rebuild the APK.
