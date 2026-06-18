/// One payment taken against a job. Deposits accumulate without triggering an
/// upload; the settling payment (the one that brings the job to paid-in-full)
/// is what pushes the sale to the API. Amount is integer minor units.
///
/// Plain model serialised to/from a JSON map for the sembast document store
/// (works the same on native and web).
class WorkPayment {
  WorkPayment();

  DateTime date = DateTime.now();
  int amountMinor = 0;

  /// A deposit never settles the job, even if it happens to cover the total.
  bool isDeposit = false;

  Map<String, Object?> toJson() => {
        'date': date.millisecondsSinceEpoch,
        'amountMinor': amountMinor,
        'isDeposit': isDeposit,
      };

  factory WorkPayment.fromJson(Map<String, Object?> json) => WorkPayment()
    ..date = DateTime.fromMillisecondsSinceEpoch((json['date'] as int?) ?? 0)
    ..amountMinor = (json['amountMinor'] as int?) ?? 0
    ..isDeposit = (json['isDeposit'] as bool?) ?? false;
}
