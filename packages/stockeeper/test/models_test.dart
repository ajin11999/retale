import 'package:flutter_test/flutter_test.dart';

import 'package:retale_stockeeper/models/models.dart';

void main() {
  group('buildVariantLabelMap', () {
    test('joins product · sku · label, skipping empty parts', () {
      final map = buildVariantLabelMap([
        {
          'name': 'Cable Ties',
          'variants': [
            {'id': 'v1', 'sku': 'CT-100', 'label': '100mm'},
            {'id': 'v2', 'sku': 'CT-200', 'label': null},
            {'id': 'v3', 'sku': '', 'label': ''},
          ],
        },
      ]);
      expect(map['v1'], 'Cable Ties · CT-100 · 100mm');
      expect(map['v2'], 'Cable Ties · CT-200');
      expect(map['v3'], 'Cable Ties');
    });
  });

  group('ReceivingLine', () {
    test('decodes the receivingCheckLines shape', () {
      final line = ReceivingLine.fromJson({
        'purchaseItem': {'id': 'pi1', 'variantId': 'v1', 'description': null},
        'qtyOrdered': 10,
        'qtyDelivered': 4,
        'remaining': 6,
        'qtyInCheck': 2,
      });
      expect(line.purchaseItemId, 'pi1');
      expect(line.remaining, 6);
      expect(line.qtyInCheck, 2);
    });
  });

  group('StockLevel', () {
    test('displayName folds in sku and optional label', () {
      final row = StockLevel.fromJson({
        'variantId': 'v1',
        'productId': 'p1',
        'productName': 'Paint',
        'sku': 'PNT-1',
        'label': '1L',
        'barcode': null,
        'unit': 'piece',
        'qtyDecimals': 0,
        'onHand': 3,
      });
      expect(row.displayName, 'Paint · PNT-1 · 1L');
    });
  });

  group('PurchaseSummary', () {
    test('totals span all items', () {
      final p = PurchaseSummary.fromJson({
        'id': 'pu1',
        'snapshotVendorName': 'Acme',
        'date': '2026-06-01',
        'items': [
          {
            'id': 'i1',
            'variantId': 'v1',
            'description': null,
            'qtyOrdered': 5,
            'qtyDelivered': 2,
          },
          {
            'id': 'i2',
            'variantId': null,
            'description': 'Freight',
            'qtyOrdered': 1,
            'qtyDelivered': 0,
          },
        ],
      });
      expect(p.totalOrdered, 6);
      expect(p.totalDelivered, 2);
    });
  });
}
