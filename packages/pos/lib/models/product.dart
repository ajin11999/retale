/// A product variant — the actual sellable unit in the POS.
class Variant {
  Variant({
    required this.id,
    required this.sku,
    required this.barcode,
    required this.label,
    required this.unit,
    required this.priceMinor,
    required this.costMinor,
    required this.totalQty,
  });

  final String id;
  final String sku;
  final String? barcode;
  final String? label;
  final String unit;
  final num priceMinor;
  final num costMinor;
  final double totalQty;

  factory Variant.fromJson(Map<String, dynamic> j) => Variant(
        id: j['id'] as String,
        sku: j['sku'] as String,
        barcode: j['barcode'] as String?,
        label: j['label'] as String?,
        unit: j['unit'] as String? ?? 'piece',
        priceMinor: j['priceMinor'] as num,
        costMinor: (j['costMinor'] as num?) ?? 0,
        totalQty: (j['totalQty'] as num?)?.toDouble() ?? 0,
      );

  Map<String, dynamic> toJson() => {
        'id': id,
        'sku': sku,
        'barcode': barcode,
        'label': label,
        'unit': unit,
        'priceMinor': priceMinor,
        'costMinor': costMinor,
        'totalQty': totalQty,
      };
}

/// A catalog product with one or more sellable [variants].
class Product {
  Product({
    required this.id,
    required this.name,
    required this.publicDisplayName,
    required this.kind,
    required this.costRatioBps,
    required this.variants,
  });

  final String id;
  final String name;
  final String publicDisplayName;
  final String kind;

  /// open_price only: snapshot cost = entered price × ratio ÷ 10000. Null on
  /// other products, where the variant's [Variant.costMinor] is the cost.
  final int? costRatioBps;
  final List<Variant> variants;

  factory Product.fromJson(Map<String, dynamic> j) => Product(
        id: j['id'] as String,
        name: j['name'] as String,
        publicDisplayName:
            j['publicDisplayName'] as String? ?? j['name'] as String,
        kind: j['kind'] as String? ?? 'physical',
        costRatioBps: (j['costRatioBps'] as num?)?.round(),
        variants: (j['variants'] as List<dynamic>? ?? [])
            .map((v) => Variant.fromJson(v as Map<String, dynamic>))
            .toList(),
      );

  Map<String, dynamic> toJson() => {
        'id': id,
        'name': name,
        'publicDisplayName': publicDisplayName,
        'kind': kind,
        'costRatioBps': costRatioBps,
        'variants': variants.map((v) => v.toJson()).toList(),
      };
}
