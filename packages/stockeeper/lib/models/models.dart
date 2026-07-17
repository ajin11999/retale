/// Plain data models for the Stockeeper flows, decoded from GraphQL maps.
library;

/// One open purchase order in the receiving list.
class PurchaseSummary {
  PurchaseSummary({
    required this.id,
    required this.vendorName,
    required this.date,
    required this.items,
  });

  final String id;
  final String vendorName;
  final String date;
  final List<PurchaseItemSummary> items;

  num get totalOrdered =>
      items.fold<num>(0, (sum, i) => sum + i.qtyOrdered);
  num get totalDelivered =>
      items.fold<num>(0, (sum, i) => sum + i.qtyDelivered);

  factory PurchaseSummary.fromJson(Map<String, dynamic> j) => PurchaseSummary(
        id: j['id'] as String,
        vendorName: j['snapshotVendorName'] as String,
        date: j['date'] as String,
        items: (j['items'] as List<dynamic>)
            .map((i) => PurchaseItemSummary.fromJson(i as Map<String, dynamic>))
            .toList(),
      );
}

/// One line of a purchase order (list-view granularity).
class PurchaseItemSummary {
  PurchaseItemSummary({
    required this.id,
    required this.variantId,
    required this.description,
    required this.qtyOrdered,
    required this.qtyDelivered,
  });

  final String id;
  final String? variantId;
  final String? description;
  final num qtyOrdered;
  final num qtyDelivered;

  factory PurchaseItemSummary.fromJson(Map<String, dynamic> j) =>
      PurchaseItemSummary(
        id: j['id'] as String,
        variantId: j['variantId'] as String?,
        description: j['description'] as String?,
        qtyOrdered: j['qtyOrdered'] as num,
        qtyDelivered: j['qtyDelivered'] as num,
      );
}

/// The open draft receiving check (a draft PurchaseDelivery).
class ReceivingCheck {
  ReceivingCheck({required this.id, required this.targetLocationId});

  final String id;
  final String targetLocationId;

  factory ReceivingCheck.fromJson(Map<String, dynamic> j) => ReceivingCheck(
        id: j['id'] as String,
        targetLocationId: j['targetLocationId'] as String,
      );
}

/// A purchase line as the receiving screen sees it, draft check folded in.
class ReceivingLine {
  ReceivingLine({
    required this.purchaseItemId,
    required this.variantId,
    required this.description,
    required this.qtyOrdered,
    required this.qtyDelivered,
    required this.remaining,
    required this.qtyInCheck,
  });

  final String purchaseItemId;
  final String? variantId;
  final String? description;
  final num qtyOrdered;
  final num qtyDelivered;

  /// qtyOrdered − qtyDelivered: what is still owed before this check.
  final num remaining;

  /// Qty staged in the open draft check; mutable for optimistic updates.
  num qtyInCheck;

  factory ReceivingLine.fromJson(Map<String, dynamic> j) {
    final item = j['purchaseItem'] as Map<String, dynamic>;
    return ReceivingLine(
      purchaseItemId: item['id'] as String,
      variantId: item['variantId'] as String?,
      description: item['description'] as String?,
      qtyOrdered: j['qtyOrdered'] as num,
      qtyDelivered: j['qtyDelivered'] as num,
      remaining: j['remaining'] as num,
      qtyInCheck: j['qtyInCheck'] as num,
    );
  }
}

/// A variant's on-hand at the reconcile location.
class StockLevel {
  StockLevel({
    required this.variantId,
    required this.productId,
    required this.productName,
    required this.sku,
    required this.label,
    required this.barcode,
    required this.unit,
    required this.qtyDecimals,
    required this.onHand,
  });

  final String variantId;
  final String productId;
  final String productName;
  final String sku;
  final String? label;
  final String? barcode;
  final String unit;
  final int qtyDecimals;
  final num onHand;

  /// Display name: `Product · label` (label only when present).
  String get displayName =>
      [productName, if (label != null && label!.isNotEmpty) label!]
          .join(' · ');

  factory StockLevel.fromJson(Map<String, dynamic> j) => StockLevel(
        variantId: j['variantId'] as String,
        productId: j['productId'] as String,
        productName: j['productName'] as String,
        sku: j['sku'] as String,
        label: j['label'] as String?,
        barcode: j['barcode'] as String?,
        unit: j['unit'] as String,
        qtyDecimals: j['qtyDecimals'] as int,
        onHand: j['onHand'] as num,
      );
}

/// One node of the location tree for the picker.
class LocationNode {
  LocationNode({required this.id, required this.name, required this.parentId});

  final String id;
  final String name;
  final String? parentId;

  factory LocationNode.fromJson(Map<String, dynamic> j) => LocationNode(
        id: j['id'] as String,
        name: j['name'] as String,
        parentId: j['parentId'] as String?,
      );
}

class VariantInfo {
  final String productName;
  final String? sku;
  final String? label;

  VariantInfo(this.productName, this.sku, this.label);

  String get displayName => [
        productName,
        if (sku != null && sku!.isNotEmpty) sku,
        if (label != null && label!.isNotEmpty) label,
      ].join(' · ');
}

/// Builds `variantId -> VariantInfo` from the products query.
/// PurchaseItem carries no variant label, so receiving lines look up here
/// and fall back to the line's free-text description.
Map<String, VariantInfo> buildVariantLabelMap(List<dynamic> products) {
  final map = <String, VariantInfo>{};
  for (final p in products) {
    final product = p as Map<String, dynamic>;
    final name = product['name'] as String;
    for (final v in product['variants'] as List<dynamic>) {
      final variant = v as Map<String, dynamic>;
      final sku = variant['sku'] as String?;
      final label = variant['label'] as String?;
      map[variant['id'] as String] = VariantInfo(name, sku, label);
    }
  }
  return map;
}

class TransferSummary {
  TransferSummary({
    required this.id,
    required this.targetLocationId,
    required this.createdAt,
    this.notes,
    required this.status,
    required this.items,
  });

  final String id;
  final String targetLocationId;
  final String createdAt;
  final String? notes;
  final String status;
  final List<TransferItem> items;

  factory TransferSummary.fromJson(Map<String, dynamic> j) => TransferSummary(
        id: j['id'] as String,
        targetLocationId: j['targetLocationId'] as String,
        createdAt: j['createdAt'] as String,
        notes: j['notes'] as String?,
        status: j['status'] as String,
        items: (j['items'] as List<dynamic>)
            .map((i) => TransferItem.fromJson(i as Map<String, dynamic>))
            .toList(),
      );
}

class TransferItem {
  TransferItem({
    required this.id,
    required this.variantId,
    required this.sourceLocationId,
    required this.qty,
  });

  final String id;
  final String variantId;
  final String sourceLocationId;
  final num qty;

  factory TransferItem.fromJson(Map<String, dynamic> j) => TransferItem(
        id: j['id'] as String,
        variantId: j['variantId'] as String,
        sourceLocationId: j['sourceLocationId'] as String,
        qty: j['qty'] as num,
      );
}
