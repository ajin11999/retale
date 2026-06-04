import 'package:intl/intl.dart';

import '../models/money.dart';

/// Business identity printed at the top of a receipt.
class StoreInfo {
  const StoreInfo({required this.name, this.phone});

  final String name;
  final String? phone;
}

/// One line on a receipt: a name, a quantity, the unit price and the total.
class ReceiptLine {
  const ReceiptLine({
    required this.name,
    required this.qty,
    required this.unitPriceMinor,
    required this.lineTotalMinor,
  });

  final String name;
  final int qty;
  final int unitPriceMinor;
  final int lineTotalMinor;
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
            ))
        .toList();
    final paid = (order['payments'] as List<dynamic>)
        .cast<Map<String, dynamic>>()
        .fold<int>(0, (sum, p) => sum + (p['amountMinor'] as num).toInt());
    final customer = order['customer'] as Map<String, dynamic>?;
    return Receipt(
      store: store,
      lines: lines,
      totalMinor: (order['totalMinor'] as num).toInt(),
      displayNumber: order['displayNumber'] as String?,
      createdAt: DateTime.tryParse(order['createdAt'] as String? ?? ''),
      paidMinor: paid > 0 ? paid : null,
      customerName: customer?['name'] as String? ??
          order['snapshotCustomerName'] as String?,
    );
  }

  /// Render the message a customer receives. Plain text — WhatsApp renders
  /// `*bold*` for the store name and header.
  String toMessage() {
    final b = StringBuffer()..writeln('*${store.name}*');
    if (store.phone != null && store.phone!.trim().isNotEmpty) {
      b.writeln(store.phone);
    }
    b.writeln();
    if (displayNumber != null) b.writeln('Receipt $displayNumber');
    if (createdAt != null) b.writeln(formatDate(createdAt!));
    if (customerName != null && customerName!.trim().isNotEmpty) {
      b.writeln('Customer: $customerName');
    }
    b.writeln('--------------------------------');
    for (final line in lines) {
      b.writeln('${line.qty} × ${line.name}');
      b.writeln(
          '   ${Money.format(line.unitPriceMinor)}   =   ${Money.format(line.lineTotalMinor)}');
    }
    b.writeln('--------------------------------');
    b.writeln('*Total: ${Money.format(totalMinor)}*');
    if (paidMinor != null) b.writeln('Paid: ${Money.format(paidMinor!)}');
    if (changeMinor != null && changeMinor! > 0) {
      b.writeln('Change: ${Money.format(changeMinor!)}');
    }
    b.writeln();
    b.write('Thank you!');
    return b.toString();
  }
}
