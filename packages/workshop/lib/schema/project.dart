import 'package:isar/isar.dart';
import 'package:retale_workshop/schema/work_line.dart';
import 'package:retale_workshop/schema/work_payment.dart';

export 'package:retale_workshop/schema/work_line.dart';
export 'package:retale_workshop/schema/work_payment.dart';

part 'project.g.dart';

/// A workshop job sheet. Lives entirely on the local device until it is paid in
/// full, at which point it is submitted to the Retale API as one walk-in
/// `createPosOrder` and stamped [isUploaded] with the returned order id.
@collection
class Project {
  Id id = Isar.autoIncrement;

  String label = '';
  String vehicle = '';
  String memo = '';
  bool isPinned = false;

  /// Set once the settled sale has been accepted by the API.
  bool isUploaded = false;

  /// The Retale order id returned by `createPosOrder` (null until uploaded).
  String? uploadedOrderId;
  DateTime? uploadedAt;

  late DateTime date;

  List<WorkLine> lines = [];
  List<WorkPayment> payments = [];
}
