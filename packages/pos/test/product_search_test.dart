import 'package:flutter_test/flutter_test.dart';
import 'package:retale_pos/cache/product_cache.dart';
import 'package:retale_pos/models/product.dart';
import 'package:shared_preferences/shared_preferences.dart';

Product _product(
  String id,
  String name, {
  List<Variant> variants = const [],
}) =>
    Product(
      id: id,
      name: name,
      publicDisplayName: name,
      kind: 'physical',
      costRatioBps: null,
      variants: variants,
    );

Variant _variant(String id, {String? sku, String? barcode, String? label}) =>
    Variant(
      id: id,
      sku: sku ?? 'SKU-$id',
      barcode: barcode,
      label: label,
      unit: 'piece',
      priceMinor: 1000,
      costMinor: 600,
      totalQty: 1,
    );

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  group('ProductCache.search', () {
    setUp(() async {
      SharedPreferences.setMockInitialValues({});
      await ProductCache.instance.replaceAll([
        // A compacted product: the model lives only in the variant label,
        // the SKU is an opaque generated code.
        _product('npp-vg', r'Valve Guide \ NPP', variants: [
          _variant('a', sku: 'SKU-01KVNPP', label: 'Beat'),
          _variant('b', sku: 'SKU-02KVNPP', label: 'Grand'),
        ]),
        // A plain product: the model is in the name.
        _product('plain', r'Throttle Cable \ Beat \ HTS',
            variants: [_variant('c', sku: 'TC-001')]),
      ]);
    });

    test('finds a compacted product by its variant label', () {
      final results = ProductCache.instance.search('valve guide beat');
      expect(results.map((p) => p.id), contains('npp-vg'));
    });

    test('finds a compacted product by label alone', () {
      final results = ProductCache.instance.search('grand');
      expect(results.map((p) => p.id), contains('npp-vg'));
    });

    test('still matches product name and sku', () {
      expect(ProductCache.instance.search('throttle').map((p) => p.id),
          contains('plain'));
      expect(ProductCache.instance.search('SKU-01KVNPP').map((p) => p.id),
          contains('npp-vg'));
    });

    test('an empty query returns the whole sellable catalog', () {
      expect(ProductCache.instance.search(''), hasLength(2));
    });
  });
}
