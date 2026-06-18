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
///
/// Plain model serialised to/from a JSON map for the sembast document store.
/// `children` is self-referential — nested groups serialise recursively.
class WorkLine {
  WorkLine();

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

  /// Children of a group. Null/empty on a leaf.
  List<WorkLine>? children;

  Map<String, Object?> toJson() => {
        'isGroup': isGroup,
        'note': note,
        'variantId': variantId,
        'variantKind': variantKind,
        'snapshotName': snapshotName,
        'qty': qty,
        'unitPriceMinor': unitPriceMinor,
        'unitCostMinor': unitCostMinor,
        'costRatioBps': costRatioBps,
        'children': children?.map((c) => c.toJson()).toList(),
      };

  factory WorkLine.fromJson(Map<String, Object?> json) => WorkLine()
    ..isGroup = (json['isGroup'] as bool?) ?? false
    ..note = (json['note'] as String?) ?? ''
    ..variantId = json['variantId'] as String?
    ..variantKind = json['variantKind'] as String?
    ..snapshotName = (json['snapshotName'] as String?) ?? ''
    ..qty = (json['qty'] as int?) ?? 1
    ..unitPriceMinor = (json['unitPriceMinor'] as int?) ?? 0
    ..unitCostMinor = json['unitCostMinor'] as int?
    ..costRatioBps = json['costRatioBps'] as int?
    ..children = workLinesFromJson(json['children']);
}

/// Decode a (possibly null) JSON list into a growable [WorkLine] list. Shared
/// by [WorkLine.children] and [Project.lines]; returns null for absent input so
/// a leaf's `children` stays null.
List<WorkLine>? workLinesFromJson(Object? raw) {
  if (raw == null) return null;
  return [
    for (final e in raw as List)
      WorkLine.fromJson((e as Map).cast<String, Object?>()),
  ];
}
