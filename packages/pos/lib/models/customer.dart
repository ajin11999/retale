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

  /// Outstanding account balance (what the customer owes), in rupiah.
  final num balanceMinor;

  /// Credit cap in rupiah; null means no limit is set.
  final num? creditLimitMinor;

  factory Customer.fromJson(Map<String, dynamic> json) => Customer(
        id: json['id'] as String,
        name: json['name'] as String,
        phone: json['phone'] as String?,
        balanceMinor: (json['balanceMinor'] as num?) ?? 0,
        creditLimitMinor: json['creditLimitMinor'] as num?,
      );

  bool get hasPhone => phone != null && phone!.trim().isNotEmpty;
}
