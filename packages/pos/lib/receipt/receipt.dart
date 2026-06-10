import 'package:intl/intl.dart';

import '../models/money.dart';

/// Business identity printed at the top of a receipt.
class StoreInfo {
  const StoreInfo({required this.name, this.logoUrl});

  final String name;

  /// Absolute URL of the business logo (PNG), or null when none is set. When
  /// present, a printed receipt shows the logo in place of the store name.
  final String? logoUrl;
}

/// One line on a receipt: a name, a quantity, the unit price and the total.
class ReceiptLine {
  const ReceiptLine({
    required this.name,
    required this.qty,
    required this.unitPriceMinor,
    required this.lineTotalMinor,
    this.unit,
  });

  final String name;
  final int qty;
  final int unitPriceMinor;
  final int lineTotalMinor;

  /// Unit of measure — "piece", "g", "ml", "mm"; null on receipts rebuilt
  /// from orders that predate the unit snapshot.
  final String? unit;
}

/// A sale receipt that renders to a plain-text WhatsApp message. Built either
/// from the just-completed cart or from a past order's detail.
class Receipt {
  Receipt({
    required this.store,
    required this.lines,
    required this.totalMinor,
    this.displayNumber,
    this.createdAt,
    this.paidMinor,
    this.changeMinor,
    this.customerName,
  });

  final StoreInfo store;
  final List<ReceiptLine> lines;
  final int totalMinor;
  final String? displayNumber;
  final DateTime? createdAt;
  final int? paidMinor;
  final int? changeMinor;
  final String? customerName;

  static final _dateFmt = DateFormat('yyyy-MM-dd HH:mm');

  /// Local time formatted for a receipt header.
  static String formatDate(DateTime dt) => _dateFmt.format(dt.toLocal());

  /// Build from a fetched `orderDetail` map (drops voided / zero-qty lines).
  factory Receipt.fromOrderDetail(
    Map<String, dynamic> order,
    StoreInfo store,
  ) {
    final lines = (order['items'] as List<dynamic>)
        .cast<Map<String, dynamic>>()
        .where((it) => it['voidedAt'] == null && (it['qty'] as num) > 0)
        .map((it) => ReceiptLine(
              name: it['displayName'] as String,
              qty: (it['qty'] as num).toInt(),
              unitPriceMinor: (it['snapshotPriceMinor'] as num).toInt(),
              lineTotalMinor: (it['lineTotalMinor'] as num).toInt(),
              unit: it['snapshotUnit'] as String?,
            ))
        .toList();
    final paid = (order['payments'] as List<dynamic>)
        .cast<Map<String, dynamic>>()
        .fold<int>(0, (sum, p) => sum + (p['amountMinor'] as num).toInt());
    final customer = order['customer'] as Map<String, dynamic>?;
    final total = (order['totalMinor'] as num).toInt();
    return Receipt(
      store: store,
      lines: lines,
      totalMinor: total,
      displayNumber: order['displayNumber'] as String?,
      createdAt: DateTime.tryParse(order['createdAt'] as String? ?? ''),
      paidMinor: paid > 0 ? paid : null,
      changeMinor: paid > total ? paid - total : null,
      customerName: customer?['name'] as String? ??
          order['snapshotCustomerName'] as String?,
    );
  }

  /// Render the message a customer receives. Plain text — WhatsApp renders
  /// `*bold*` for the store name and header.
  String toMessage() {
    final b = StringBuffer()..writeln('*${store.name}*');
    b.writeln();
    if (displayNumber != null) b.writeln('Receipt $displayNumber');
    if (createdAt != null) b.writeln(formatDate(createdAt!));
    if (customerName != null && customerName!.trim().isNotEmpty) {
      b.writeln('Customer: $customerName');
    }
    b.writeln('--------------------------------');
    for (final line in lines) {
      final qty =
          line.unit == null ? '${line.qty}' : '${line.qty} ${line.unit}';
      b.writeln('$qty × ${line.name}');
      b.writeln(
          '   ${Money.format(line.unitPriceMinor)}   =   ${Money.format(line.lineTotalMinor)}');
    }
    b.writeln('--------------------------------');
    b.writeln('*Total: ${Money.format(totalMinor)}*');
    if (paidMinor != null) b.writeln('Cash: ${Money.format(paidMinor!)}');
    if (changeMinor != null && changeMinor! > 0) {
      b.writeln('Change: ${Money.format(changeMinor!)}');
    }
    b.writeln();
    b.write('Thank you!');
    return b.toString();
  }
}
