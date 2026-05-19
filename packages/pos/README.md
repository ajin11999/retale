# Retale POS

The point-of-sale register frontend for Retale — a Flutter app talking to the
Retale GraphQL API.

One Flutter codebase, multiple build targets:

| Target            | Build                          | Use                          |
|-------------------|--------------------------------|------------------------------|
| Windows register  | `flutter build windows`        | Native `.exe` till           |
| Linux register    | `flutter build linux`          | Native binary till           |
| Chromebook / web  | `flutter build web`            | PWA — any browser, any OS    |

## Scope

This package covers the **core POS flow** and **auth + sync** only:

- Auth: password login, 2FA challenge, JWT refresh, logout
- Bind device to a point of sale, open/close cashier sessions
- Product search (name / SKU / barcode), cart, cash checkout
- Offline: product catalog cached on disk; orders rung while offline are
  queued durably and flushed automatically when the connection returns

Inventory management, reporting, customer screens, etc. are **out of scope** —
those live in `packages/console` (the web admin).

## Project layout

```
lib/
  config/        AppConfig — API URL + bound POS id (shared_preferences)
  auth/          TokenStore (secure storage) + AuthService (login/2FA/refresh)
  graphql/       GraphQLService (client + error handling) + operations
  models/        Product, Variant, PointOfSale, PosSession, Cart, Money
  cache/         ProductCache + OrderQueue (JSON in shared_preferences)
  sync/          ConnectivityService + SyncService (catalog refresh, queue)
  screens/       router -> api setup -> login -> 2FA -> POS pick -> session
                 -> register
  widgets/       shared UI
```

## First-time setup

Flutter is **not** on this machine's PATH. Install the Flutter SDK first
(https://docs.flutter.dev/get-started/install), then from this directory:

```sh
# 1. Generate the native platform folders (this dir has lib/ + pubspec only)
flutter create . --project-name retale_pos --platforms=windows,linux,web

# 2. Fetch dependencies
flutter pub get

# 3. Run it
flutter run -d windows      # or: -d linux, -d chrome
```

On first launch the app asks for the API base URL
(e.g. `http://192.168.1.10:3000`) — it appends `/graphql` itself.

## Notes

- GraphQL client: **graphql_flutter** with hand-written documents in
  `lib/graphql/operations.dart`. If the schema drifts, update them there.
- Money is integer minor units everywhere. `Money.minorPerMajor` (default 100)
  controls the display divisor — set it to 1 for a 0-decimal currency.
- A cashier session is always *opened while online*; offline order queueing
  only covers ringing sales after the link drops mid-shift.
