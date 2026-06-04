import 'package:isar/isar.dart';

part 'work_payment.g.dart';

/// One payment taken against a job. Deposits accumulate without triggering an
/// upload; the settling payment (the one that brings the job to paid-in-full)
/// is what pushes the sale to the API. Amount is integer minor units.
@embedded
class WorkPayment {
  late DateTime date;
  int amountMinor = 0;

  /// A deposit never settles the job, even if it happens to cover the total.
  bool isDeposit = false;
}
