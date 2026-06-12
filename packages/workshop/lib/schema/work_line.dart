import 'package:isar/isar.dart';

part 'work_line.g.dart';

/// A line on a workshop job. Either a **group** (organisational only — flattened
/// away on submit) or a **leaf** that maps to a real Retale catalog variant.
///
/// Groups are a workshop-UI concept; they never reach the API. A leaf carries
/// the catalog `variantId` plus a snapshot of the variant's name (so the sheet
/// renders offline) and the chosen `unitPriceMinor`. The sheet price is
/// authoritative: it is sent as `priceOverrideMinor` on submit for every kind
/// except `bundle` (the API rejects overrides there and prices bundles from
/// the catalog). `note` is extra free text that stays local — it is not sent
/// to the backend.
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

  /// Chosen unit price, minor units. Sent as the price override on submit
  /// (except bundles, which always use the catalog price).
  int unitPriceMinor = 0;

  /// The variant's weighted-average unit cost at pick time, minor units —
  /// local-only, feeds the margin pill. Null on groups and on lines saved
  /// before cost snapshots existed (those simply show no margin).
  int? unitCostMinor;

  /// Cost ratio (basis points) snapshot for open-price variants, where cost is
  /// a fraction of the entered price — kept so the margin pill stays correct
  /// when the line is repriced later. Null elsewhere. Local-only.
  int? costRatioBps;

  /// Children of a group. Null/empty on a leaf. Self-referential embedding —
  /// Isar supports this (see the ProDuck Workshop reference).
  List<WorkLine>? children;
}
