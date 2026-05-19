/// A product variant — the actual sellable unit in the POS.
class Variant {
  Variant({
    required this.id,
    required this.sku,
    required this.barcode,
    required this.label,
    required this.unit,
    required this.priceMinor,
    required this.totalQty,
  });

  final String id;
  final String sku;
  final String? barcode;
  final String? label;
  final String unit;
  final int priceMinor;
  final double totalQty;

  factory Variant.fromJson(Map<String, dynamic> j) => Variant(
        id: j['id'] as String,
        sku: j['sku'] as String,
        barcode: j['barcode'] as String?,
        label: j['label'] as String?,
        unit: j['unit'] as String? ?? 'piece',
        priceMinor: (j['priceMinor'] as num).round(),
        totalQty: (j['totalQty'] as num?)?.toDouble() ?? 0,
      );

  Map<String, dynamic> toJson() => {
        'id': id,
        'sku': sku,
        'barcode': barcode,
        'label': label,
        'unit': unit,
        'priceMinor': priceMinor,
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
    required this.variants,
  });

  final String id;
  final String name;
  final String publicDisplayName;
  final String kind;
  final List<Variant> variants;

  factory Product.fromJson(Map<String, dynamic> j) => Product(
        id: j['id'] as String,
        name: j['name'] as String,
        publicDisplayName:
            j['publicDisplayName'] as String? ?? j['name'] as String,
        kind: j['kind'] as String? ?? 'physical',
        variants: (j['variants'] as List<dynamic>? ?? [])
            .map((v) => Variant.fromJson(v as Map<String, dynamic>))
            .toList(),
      );

  Map<String, dynamic> toJson() => {
        'id': id,
        'name': name,
        'publicDisplayName': publicDisplayName,
        'kind': kind,
        'variants': variants.map((v) => v.toJson()).toList(),
      };
}
