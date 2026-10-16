import 'package:flutter_test/flutter_test.dart';
import 'package:retale_pos/receipt/receipt.dart';

void main() {
  group('Order history and receipt naming', () {
    test('receipt fromOrderDetail uses customer-facing displayName, not internal snapshotProductName', () {
      final order = {
        'id': 'ord-1',
        'displayNumber': 'ORD-1001',
        'createdAt': '2026-10-16T12:00:00Z',
        'totalMinor': 25000,
        'payments': [
          {'method': 'cash', 'amountMinor': 25000},
        ],
        'items': [
          {
            'id': 'item-1',
            'qty': 1,
            'snapshotProductName': 'INTERNAL-6201-2RS',
            'displayName': 'Bearing 6201',
            'snapshotVariantLabel': '2RS',
            'snapshotPriceMinor': 25000,
            'lineTotalMinor': 25000,
            'snapshotUnit': 'piece',
            'voidedAt': null,
          },
        ],
      };

      const store = StoreInfo(name: 'My Store');
      final receipt = Receipt.fromOrderDetail(order, store);

      // Receipt is customer-facing: uses displayName with variant label
      expect(receipt.lines.single.name, 'Bearing 6201 — 2RS');
      expect(receipt.toMessage(), contains('1 piece × Bearing 6201 — 2RS'));
      expect(receipt.toMessage(), isNot(contains('INTERNAL-6201-2RS')));
    });
  });
}
