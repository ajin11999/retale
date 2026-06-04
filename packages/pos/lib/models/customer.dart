/// A customer the cashier can attach to a sale. Only the fields the POS needs:
/// an id to send with the order and a name/phone for the receipt.
class Customer {
  const Customer({required this.id, required this.name, this.phone});

  final String id;
  final String name;
  final String? phone;

  factory Customer.fromJson(Map<String, dynamic> json) => Customer(
        id: json['id'] as String,
        name: json['name'] as String,
        phone: json['phone'] as String?,
      );

  bool get hasPhone => phone != null && phone!.trim().isNotEmpty;
}
