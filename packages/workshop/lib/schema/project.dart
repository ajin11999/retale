import 'package:retale_workshop/schema/work_line.dart';
import 'package:retale_workshop/schema/work_payment.dart';

export 'package:retale_workshop/schema/work_line.dart';
export 'package:retale_workshop/schema/work_payment.dart';

/// A workshop job sheet. Lives entirely on the local device until it is paid in
/// full, at which point it is submitted to the Retale API as one walk-in
/// `createPosOrder` and stamped [isUploaded] with the returned order id.
///
/// Stored as a JSON document in the sembast `projects` store; [id] mirrors the
/// record key (0 until the record is first written).
class Project {
  Project();

  /// The sembast record key. 0 means "not yet persisted".
  int id = 0;

  String label = '';
  String vehicle = '';
  String memo = '';
  bool isPinned = false;

  /// Set once the settled sale has been accepted by the API.
  bool isUploaded = false;

  /// The Retale order id returned by `createPosOrder` (null until uploaded).
  String? uploadedOrderId;
  DateTime? uploadedAt;

  DateTime date = DateTime.now();

  List<WorkLine> lines = [];
  List<WorkPayment> payments = [];

  Map<String, Object?> toJson() => {
        'label': label,
        'vehicle': vehicle,
        'memo': memo,
        'isPinned': isPinned,
        'isUploaded': isUploaded,
        'uploadedOrderId': uploadedOrderId,
        'uploadedAt': uploadedAt?.millisecondsSinceEpoch,
        'date': date.millisecondsSinceEpoch,
        'lines': lines.map((l) => l.toJson()).toList(),
        'payments': payments.map((p) => p.toJson()).toList(),
      };

  factory Project.fromJson(int id, Map<String, Object?> json) => Project()
    ..id = id
    ..label = (json['label'] as String?) ?? ''
    ..vehicle = (json['vehicle'] as String?) ?? ''
    ..memo = (json['memo'] as String?) ?? ''
    ..isPinned = (json['isPinned'] as bool?) ?? false
    ..isUploaded = (json['isUploaded'] as bool?) ?? false
    ..uploadedOrderId = json['uploadedOrderId'] as String?
    ..uploadedAt = _dateOrNull(json['uploadedAt'])
    ..date = _dateOrNull(json['date']) ?? DateTime.now()
    ..lines = workLinesFromJson(json['lines']) ?? []
    ..payments = _paymentsFromJson(json['payments']);
}

DateTime? _dateOrNull(Object? v) =>
    v == null ? null : DateTime.fromMillisecondsSinceEpoch(v as int);

List<WorkPayment> _paymentsFromJson(Object? raw) {
  if (raw == null) return [];
  return [
    for (final e in raw as List)
      WorkPayment.fromJson((e as Map).cast<String, Object?>()),
  ];
}
