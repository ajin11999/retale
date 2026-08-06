import 'package:flutter_test/flutter_test.dart';
import 'package:retale_pos/cache/order_queue.dart';

import 'package:shared_preferences/shared_preferences.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  setUp(() {
    SharedPreferences.setMockInitialValues({});
  });

  group('OrderQueue deduplication', () {
    test('enqueue ignores duplicate orders with the same localId', () async {
      final queue = OrderQueue.instance;
      final order1 = QueuedOrder(
        localId: 'idempotent-local-id-123',
        posSessionId: 'sess_1',
        customerId: null,
        items: [
          {'variantId': 'var_1', 'qty': 2}
        ],
        payments: [
          {'method': 'cash', 'amountMinor': 2000}
        ],
        createdAt: DateTime.now().toIso8601String(),
        totalMinor: 2000,
      );

      final order2 = QueuedOrder(
        localId: 'idempotent-local-id-123',
        posSessionId: 'sess_1',
        customerId: null,
        items: [
          {'variantId': 'var_1', 'qty': 2}
        ],
        payments: [
          {'method': 'cash', 'amountMinor': 2000}
        ],
        createdAt: DateTime.now().toIso8601String(),
        totalMinor: 2000,
      );

      await queue.enqueue(order1);
      final countBefore = queue.all.where((o) => o.localId == 'idempotent-local-id-123').length;

      await queue.enqueue(order2);
      final countAfter = queue.all.where((o) => o.localId == 'idempotent-local-id-123').length;

      expect(countBefore, 1);
      expect(countAfter, 1);

      await queue.remove(order1);
    });
  });
}
