/// A customer the cashier can attach to a sale. Only the fields the POS needs:
/// an id to send with the order, a name/phone for the receipt, and the account
/// balance/limit so the cashier can judge a charge-to-account.
class Customer {
  const Customer({
    required this.id,
    required this.name,
    this.phone,
    this.balanceMinor = 0,
    this.creditLimitMinor,
  });

  final String id;
  final String name;
  final String? phone;

  /// Outstanding account balance (what the customer owes), in minor units.
  final int balanceMinor;

  /// Credit cap in minor units; null means no limit is set.
  final int? creditLimitMinor;

  factory Customer.fromJson(Map<String, dynamic> json) => Customer(
        id: json['id'] as String,
        name: json['name'] as String,
        phone: json['phone'] as String?,
        balanceMinor: (json['balanceMinor'] as num?)?.toInt() ?? 0,
        creditLimitMinor: (json['creditLimitMinor'] as num?)?.toInt(),
      );

  bool get hasPhone => phone != null && phone!.trim().isNotEmpty;
}
