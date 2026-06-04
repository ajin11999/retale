import 'package:isar/isar.dart';

part 'work_line.g.dart';

/// A line on a workshop job. Either a **group** (organisational only — flattened
/// away on submit) or a **leaf** that maps to a real Retale catalog variant.
///
/// Groups are a workshop-UI concept; they never reach the API. A leaf carries
/// the catalog `variantId` plus a snapshot of the variant's name (so the sheet
/// renders offline) and the chosen `unitPriceMinor`. For `service` / `open_price`
/// variants that price is sent as `priceOverrideMinor`; for `physical` variants
/// it is display-only (the API uses the variant's own price). `note` is extra
/// free text that stays local — it is not sent to the backend.
@embedded
class WorkLine {
  bool isGroup = false;

  /// Local-only free text (e.g. "Bosch wiper — bought at Toko X"). Never sent.
  String note = '';

  /// Null on a group; the catalog variant id on a leaf.
  String? variantId;

  /// physical | service | open_price | bundle — drives priceOverride mapping.
  String? variantKind;

  /// The variant's display name at pick time, for offline rendering.
  String snapshotName = '';

  int qty = 1;

  /// Chosen unit price, minor units. Override for service/open_price; display
  /// for physical.
  int unitPriceMinor = 0;

  /// Children of a group. Null/empty on a leaf. Self-referential embedding —
  /// Isar supports this (see the ProDuck Workshop reference).
  List<WorkLine>? children;
}
