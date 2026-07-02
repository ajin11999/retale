import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:retale_pos/models/cart.dart';
import 'package:retale_pos/models/product.dart';

Product _product({
  String id = 'p1',
  String kind = 'physical',
  int? costRatioBps,
  num priceMinor = 1000,
  num costMinor = 600,
}) =>
    Product(
      id: id,
      name: 'Bearing $id',
      publicDisplayName: 'Bearing $id',
      kind: kind,
      costRatioBps: costRatioBps,
      variants: [
        Variant(
          id: '${id}v1',
          sku: 'SKU-$id',
          barcode: '123$id',
          label: 'std',
          unit: 'piece',
          priceMinor: priceMinor,
          costMinor: costMinor,
          totalQty: 5,
        ),
      ],
    );

void main() {
  group('Cart persistence', () {
    test('a register round-trips through JSON, preserving every edit', () {
      final register = Register();
      final cart = register.active;
      final p = _product();
      cart.add(p, p.variants.first); // qty 1
      cart.add(p, p.variants.first); // qty 2
      cart.setDiscount(cart.lines.first, 250);
      cart.setPrice(cart.lines.first, 1200); // price override
      cart.rename('Table 4');

      register.addCart(); // a second, parked cart
      final p2 = _product(id: 'p2', priceMinor: 5000);
      register.active.add(p2, p2.variants.first);
      register.select(0); // active cart is the first one

      final restored =
          Register.fromJson(jsonDecode(jsonEncode(register.toJson())));

      expect(restored.count, 2);
      expect(restored.activeIndex, 0);

      final line = restored.carts[0].lines.single;
      expect(restored.carts[0].label, 'Table 4');
      expect(line.qty, 2);
      expect(line.discountMinor, 250);
      expect(line.overridePriceMinor, 1200);
      expect(line.unitPriceMinor, 1200);
      expect(line.product.id, 'p1');
      expect(line.variant.id, 'p1v1');
      // qty 2 × 1200 override − 250 discount = 2150
      expect(line.lineTotalMinor, 2150);

      expect(restored.carts[1].lines.single.variant.id, 'p2v1');
    });

    test('open-price lines restore their cost ratio', () {
      final register = Register();
      final p = _product(id: 'op', kind: 'open_price', costRatioBps: 5000);
      register.active.addOpenPrice(p, p.variants.first, 2000);

      final restored =
          Register.fromJson(jsonDecode(jsonEncode(register.toJson())));
      final line = restored.carts.single.lines.single;

      expect(line.overridePriceMinor, 2000);
      // open_price cost = price × ratio ÷ 10000 = 2000 × 0.5 = 1000
      expect(line.unitCostMinor, 1000);
    });

    test('a zero price override (bonus item) sticks and reaches the wire', () {
      final cart = Register().active;
      final p = _product();
      cart.add(p, p.variants.first);
      final line = cart.lines.single;

      cart.setPrice(line, 0);
      expect(line.overridePriceMinor, 0);
      expect(line.unitPriceMinor, 0);
      expect(line.lineTotalMinor, 0);
      // The margin is the full cost given away, shown against no revenue.
      expect(line.unitMarginMinor, -600);
      expect(line.unitMarginFraction, isNull);

      // The zero override must be sent, not dropped as "no override".
      expect(cart.toOrderItemsInput().single['priceOverrideMinor'], 0);

      // And it survives the durable cart store.
      final restored = Cart.fromJson(
          jsonDecode(jsonEncode(cart.toJson())) as Map<String, dynamic>);
      expect(restored.lines.single.overridePriceMinor, 0);
    });

    test('null or negative setPrice clears the override', () {
      final cart = Register().active;
      final p = _product();
      cart.add(p, p.variants.first);
      final line = cart.lines.single;

      cart.setPrice(line, 0);
      cart.setPrice(line, null);
      expect(line.overridePriceMinor, isNull);
      expect(line.unitPriceMinor, 1000); // back to the base price

      cart.setPrice(line, -50);
      expect(line.overridePriceMinor, isNull);
      expect(cart.toOrderItemsInput().single.containsKey('priceOverrideMinor'),
          isFalse);
    });

    test('a fresh register is pristine; one with items is not', () {
      final register = Register();
      expect(register.isPristine, isTrue);

      final p = _product();
      register.active.add(p, p.variants.first);
      expect(register.isPristine, isFalse);
    });

    test('fromJson on empty/garbage falls back to a single open cart', () {
      final restored = Register.fromJson(const {});
      expect(restored.count, 1);
      expect(restored.active.isEmpty, isTrue);
      expect(restored.isPristine, isTrue);
    });
  });
}
