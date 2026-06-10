# Plan: Retale Stockeeper — Android Flutter app (packages/stockeeper)

**Status:** implemented (commit `400434b`) — analyze/tests/API smoke/release APK all pass.
Remaining: on-phone verification (§8.3). **Zero API changes were needed**; everything
below already existed in `packages/api`.

## Context

A third Flutter app for warehouse staff, mirroring the real workflow with a two-button
home menu: **Receiving** (count goods against an open PO) and **Reconcile** (count what's
physically at a location). Locked decisions:

- Receiving counts stage into the existing **receiving-check draft delivery**
  (save-as-you-go). The app **never commits** the delivery — freight legs/costs are added
  and the commit happens in the web console. One resumable check per PO
  (`startReceivingCheck` / `openReceivingCheck` already implement this).
- Two tab-switchable counting styles in both flows: **Checklist** (big tappable tiles,
  checkbox = received in full, partial qty input on mismatch) and **By product** (tap a
  line → counting screen with +1/+5/+10 and a counted-vs-expected progress indicator).
- Scanning: **both** a scan text field (scanner guns / typed codes) and **camera**
  scanning via `mobile_scanner`.
- Reconcile applies via `bulkAdjustStock` sending **only touched lines** — untouched
  stock is left alone, so partial/spot counts are safe.

## API surface (verified — use as-is)

| Operation | Signature / notes | Permission |
|---|---|---|
| `purchases(status: open)` | `id snapshotVendorName date items { id variantId description qtyOrdered qtyDelivered unitCostMinor }` | purchase.edit |
| `startReceivingCheck(purchaseId, targetLocationId)` | creates/resumes the one draft check per PO; location fixed up front | delivery.draft |
| `openReceivingCheck(purchaseId)` | the open draft or null — resume path | delivery.draft |
| `receivingCheckLines(purchaseId)` | `purchaseItem { id variantId description }, qtyOrdered, qtyDelivered, remaining, qtyInCheck, status, provisionalStatus` | delivery.draft |
| `setReceivingCheckLine(deliveryId, purchaseItemId, qty)` | upsert; qty 0 deletes; rejects `OVER_DELIVERY` and **non-integer qty** | delivery.draft |
| `resolveReceivingScan(purchaseId, code)` | barcode/SKU/vendor-code → matching PO lines (0+, staff picks if >1) | delivery.draft |
| `locations(includeArchived: false)` | `id name parentId` for the picker | location.edit |
| `locationStockLevels(locationId)` | `variantId productId productName sku label barcode unit qtyDecimals onHand`; **includes zero-onHand rows** | stock.adjust |
| `bulkAdjustStock(locationId, reason, lines: [{variantId, countedQty}])` | absolute counted qty; returns # of lines that actually changed | stock.adjust |
| `login / loginTwoFactor / refreshToken / logout / me` | same as the POS app | — |

- **Never call `commitReceivingCheck`** — don't even include the document in the app.
- `PurchaseItem` carries no variant label: clone the console receive page's pattern — a
  separate `products(includeArchived: true) { id name variants { id sku label } }` query,
  label = `Product · sku · label`, fall back to the line's `description`.
- Seeded `inventory_manager` role (dev user `manager` / `manager12345`) has every needed
  permission; `clerk` has all but `stock.adjust`.

## 1. Scaffold (clone packages/pos — copy-paste convention, no shared package)

```
packages/stockeeper/
  pubspec.yaml          name: retale_stockeeper; deps: graphql_flutter ^5.2.0,
                        flutter_secure_storage ^9.2.2, shared_preferences ^2.5.2,
                        jwt_decoder ^2.0.1, intl ^0.20.2, cupertino_icons,
                        mobile_scanner (new); asset assets/logo.png (copy from pos)
  lib/
    main.dart app.dart                 boot like pos; MaterialApp seed Colors.green,
                                       NO textScaler shrink (big UI wanted)
    config/app_config.dart             clone from pos, drop posId
    auth/token_store.dart auth_service.dart   clone verbatim (keeps proactive JWT refresh)
    graphql/graphql_service.dart       clone verbatim; operations.dart NEW (docs above)
    models/user.dart (clone) models.dart (PurchaseSummary, ReceivingLine, StockLevel…)
    widgets/common.dart                clone (ErrorRetry, describeError)
    widgets/scan_sheet.dart            mobile_scanner bottom sheet (shared)
    screens/router_screen.dart         apiUrl → login → MenuScreen (no POS binding)
    screens/api_setup_screen.dart login_screen.dart two_factor_screen.dart  clone+rebrand
    screens/menu_screen.dart           two big Expanded rectangle buttons + logout
    screens/location_picker_screen.dart  shared; tree paths from parentId, search box
    screens/count_screen.dart          shared +1/+5/+10 counter
    screens/receiving/po_list_screen.dart receiving_screen.dart
    screens/reconcile/reconcile_screen.dart
```

## 2. Receiving flow

- **PoListScreen**: `purchases(status: open)` tiles (vendor, date, received/ordered
  progress). Tap → `openReceivingCheck(purchaseId)`: non-null → resume straight into
  ReceivingScreen (skip location pick); null → LocationPickerScreen →
  `startReceivingCheck` → `pushReplacement` ReceivingScreen.
- **ReceivingScreen**: `DefaultTabController(2)`. AppBar bottom = scan row (TextField
  `onSubmitted` for gun/typed codes + camera IconButton → ScanSheet) + TabBar
  [Checklist | By product]. State: lines from `receivingCheckLines`, label map from the
  `products` query, per-line TextEditingController + ~600ms debounce Timers, `_saving`
  set (spinner replaces the checkbox while a save is in flight), `_lastScanHitId`
  highlight.
  - **Checklist tile** (minTileHeight ~72, ~18sp text, whole tile toggles):
    checked ⟺ `qtyInCheck == remaining && remaining > 0`; tristate dash when partial;
    check → `setReceivingCheckLine(qty: remaining)`, uncheck → `qty: 0`; trailing small
    int-only qty field for partials; `remaining == 0` rows disabled "already received".
    Subtitle `"$qtyInCheck of $remaining to receive · ordered $qtyOrdered"`.
  - **By product**: same lines with a LinearProgressIndicator; tap → CountScreen.
  - Saves are immediate (optimistic local update, no per-tap refetch); on any error
    (`OVER_DELIVERY` etc.) snackbar `describeError` + refetch lines to resync.
    Client-side guard: `next > remaining` → snackbar without a round trip.
  - Scan handling `_handleCode(code)`: `resolveReceivingScan` → 0: snackbar; 1: +1 that
    line; >1: picker dialog; highlight + `Scrollable.ensureVisible` the hit.
  - Footer note: "Counts save automatically. Commit in the console after adding
    freight." Done = back out; the draft persists server-side.

## 3. Reconcile flow

Menu → LocationPickerScreen → **ReconcileScreen(location)**: rows from
`locationStockLevels`; **`Map<String, num> _counted` is the touched set** (presence =
touched; untouched lines are never sent); search filter; same tabs + scan row.

- Checklist: checked ⟺ `_counted[v] == onHand` ("confirmed at system qty"); uncheck
  removes from the map; partial field accepts decimals up to `qtyDecimals`; all local
  setState — no network until apply.
- By product: progress `counted / onHand`, overage allowed (amber past system qty);
  CountScreen writes into `_counted`.
- Scan: pure client-side exact match on `barcode`/`sku` over the rows →
  `_counted[v] = (_counted[v] ?? 0) + 1`; same 0/1/many handling.
- Persistent bottom bar "Review N counted lines" → bottom sheet: touched rows with
  `system → counted` colored deltas, required reason prefilled
  `"Stockeeper count yyyy-MM-dd"`, Apply → `bulkAdjustStock` → snackbar
  "Adjusted $n lines", clear the map, refetch. `PopScope` confirm dialog guards backing
  out with uncounted work.

## 4. Shared CountScreen

```dart
class CountTarget {
  final String title; final num expected; final num initial;
  final bool allowOverage;   // receiving false, reconcile true
  final int qtyDecimals;     // receiving 0 (server-enforced integers)
  final Future<void> Function(num qty) onSet;  // absolute; throws to reject
}
```

Huge `current / expected` headline + progress bar, big +1/+5/+10 FilledButtons, −1
outlined, "Set exact…" field, Done pops. Tap → clamp (receiving) → `await onSet(next)` →
setState; on throw keep the old value + snackbar. Receiving's `onSet` calls
`setReceivingCheckLine`; reconcile's writes `_counted`.

## 5. ScanSheet

`showScanSheet(context) → Future<String?>` modal with `MobileScanner` (single-shot pop
guard so duplicate detections don't double-fire, torch toggle, errorBuilder pointing at
the scan-field fallback when the camera/permission is unavailable, controller disposed).
Callers feed the returned code into the same `_handleCode` as the text field.

## 6. Android + packaging

- After pubspec is authored, in `packages/stockeeper`:
  `flutter create . --platforms=android --org com.retale --project-name retale_stockeeper`.
- `android/app/build.gradle(.kts)`: `minSdk = 23` (mobile_scanner requirement; flutter
  default is 21). Manifest label "Retale Stockeeper" (CAMERA permission arrives via
  mobile_scanner's manifest merge; it handles the runtime prompt itself).
- README mirroring pos's: scope (counting only; commit/freight/PO management stay in the
  console), required permissions, never-commits note, build instructions.
- Root package.json script (convention sibling of `build:pos-web`):
  `"build:stockeeper-apk": "cd packages/stockeeper && flutter build apk --release"`.

## 7. Implementation order

1. Scaffold package: pubspec, analysis_options, assets, clone+rebrand config/auth/
   graphql/common/main/app/auth screens/router (drop pos/session branches).
2. `operations.dart` + `models/models.dart`.
3. `menu_screen`, `location_picker_screen`.
4. Receiving: `po_list_screen` → `receiving_screen` (checklist tab first, then by-product).
5. `count_screen` + wire to receiving.
6. `scan_sheet` + scan-field handling in receiving.
7. Reconcile: `reconcile_screen` + review sheet, reusing CountScreen/ScanSheet/picker.
8. `flutter create` android, minSdk/label tweaks.
9. README + root script.

## 8. Verification

1. `flutter pub get && flutter analyze` → zero issues.
2. API smoke against `bun run dev` (manager/manager12345, raw GraphQL POSTs mimicking the
   app): open POs → start check → `openReceivingCheck` resumes the same draft →
   `setReceivingCheckLine` (normal / 0 / over → `OVER_DELIVERY`) → lines reflect
   `qtyInCheck` → `resolveReceivingScan` hit + miss → **delivery still `draft`** →
   `locationStockLevels` shows zero rows → `bulkAdjustStock` with one changed + one
   matching line returns 1. Clean up seeds.
3. Phone test with a built APK: kill-and-resume mid-count (must skip location pick and
   keep counts), gun + camera scans, console shows the draft with counts and commits
   there; reconcile moves only touched lines, movement carries the reason.
