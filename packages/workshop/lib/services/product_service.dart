import 'package:graphql_flutter/graphql_flutter.dart';

/// A pickable catalog variant, flattened from product → variants, carrying the
/// parent product's `kind` (which decides price-override behaviour on submit).
class CatalogVariant {
  CatalogVariant({
    required this.variantId,
    required this.kind,
    required this.name,
    required this.sku,
    required this.priceMinor,
    required this.costMinor,
    required this.costRatioBps,
    required this.unit,
  });

  final String variantId;
  final String kind; // physical | service | open_price | bundle
  final String name;
  final String sku;
  final int priceMinor;

  /// Weighted-average unit cost from the catalog, minor units.
  final int costMinor;

  /// Product-level cost ratio (basis points) for open-price products, where
  /// cost is a fraction of whatever price the clerk enters. Null elsewhere.
  final int? costRatioBps;

  final String unit;

  bool get isService => kind == 'service';
  bool get isOpenPrice => kind == 'open_price';

  /// True when the clerk sets the price (sent as priceOverrideMinor).
  bool get priceEditable => isService || isOpenPrice;

  /// Per-unit cost at [priceMinor]: open-price products derive cost from the
  /// entered price via the product's ratio (the API's snapshot rule, same as
  /// the POS); everything else uses the variant's weighted-average cost.
  int costForPrice(int priceMinor) {
    final ratio = costRatioBps;
    if (isOpenPrice && ratio != null) {
      return (priceMinor * ratio / 10000).round();
    }
    return costMinor;
  }
}

class ProductException implements Exception {
  ProductException(this.message);
  final String message;
  @override
  String toString() => message;
}

const _productsQuery = r'''
  query WorkshopProducts($search: String) {
    products(search: $search) {
      name
      kind
      costRatioBps
      variants { id sku label priceMinor costMinor unit }
    }
  }
''';

class ProductService {
  ProductService(this.client);
  final GraphQLClient client;

  Future<List<CatalogVariant>> search(String keyword) async {
    final res = await client.query(QueryOptions(
      document: gql(_productsQuery),
      variables: {'search': keyword.trim().isEmpty ? null : keyword.trim()},
      fetchPolicy: FetchPolicy.networkOnly,
    ));
    if (res.hasException) {
      final e = res.exception!;
      final gql = e.graphqlErrors.isNotEmpty ? e.graphqlErrors.first.message : null;
      throw ProductException(gql ?? e.linkException?.toString() ?? 'Product search failed');
    }

    final products = (res.data!['products'] as List).cast<Map<String, dynamic>>();
    final out = <CatalogVariant>[];
    for (final p in products) {
      final kind = p['kind'] as String;
      final productName = p['name'] as String;
      final costRatioBps = (p['costRatioBps'] as num?)?.round();
      final variants = (p['variants'] as List).cast<Map<String, dynamic>>();
      for (final v in variants) {
        final label = v['label'] as String?;
        out.add(CatalogVariant(
          variantId: v['id'] as String,
          kind: kind,
          name: label == null || label.isEmpty ? productName : '$productName — $label',
          sku: v['sku'] as String,
          priceMinor: (v['priceMinor'] as num).round(),
          costMinor: (v['costMinor'] as num?)?.round() ?? 0,
          costRatioBps: costRatioBps,
          unit: v['unit'] as String,
        ));
      }
    }
    return out;
  }
}
