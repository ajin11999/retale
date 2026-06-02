import 'package:flutter/foundation.dart';

import 'product.dart';

/// One line in the in-progress sale.
class CartLine {
  CartLine({
    required this.product,
    required this.variant,
    this.qty = 1,
    this.discountMinor = 0,
    this.overridePriceMinor,
  });

  final Product product;
  final Variant variant;
  int qty;
  int discountMinor;

  /// Cashier-entered price for open-price (and service) lines; null means use
  /// the variant's base price.
  final int? overridePriceMinor;

  /// The effective unit price: an entered override wins over the base price.
  int get unitPriceMinor => overridePriceMinor ?? variant.priceMinor;

  /// qty * price - discount, never below zero.
  int get lineTotalMinor {
    final gross = unitPriceMinor * qty - discountMinor;
    return gross < 0 ? 0 : gross;
  }

  String get displayName {
    final label = variant.label;
    return label == null || label.isEmpty
        ? product.publicDisplayName
        : '${product.publicDisplayName} — $label';
  }
}

/// The current sale. A [ChangeNotifier] so the register UI rebuilds on edits.
class Cart extends ChangeNotifier {
  final List<CartLine> _lines = [];

  List<CartLine> get lines => List.unmodifiable(_lines);
  bool get isEmpty => _lines.isEmpty;
  int get totalMinor =>
      _lines.fold(0, (sum, l) => sum + l.lineTotalMinor);

  /// Add a variant; if it is already in the cart, bump its quantity.
  void add(Product product, Variant variant) {
    final existing = _lines.where((l) => l.variant.id == variant.id);
    if (existing.isNotEmpty) {
      existing.first.qty += 1;
    } else {
      _lines.add(CartLine(product: product, variant: variant));
    }
    notifyListeners();
  }

  /// Add an open-price line at a cashier-entered lump price. Each entry is a
  /// distinct guess, so these never merge with an existing line.
  void addOpenPrice(Product product, Variant variant, int priceMinor) {
    _lines.add(CartLine(
      product: product,
      variant: variant,
      overridePriceMinor: priceMinor,
    ));
    notifyListeners();
  }

  void setQty(CartLine line, int qty) {
    if (qty <= 0) {
      _lines.remove(line);
    } else {
      line.qty = qty;
    }
    notifyListeners();
  }

  void setDiscount(CartLine line, int discountMinor) {
    line.discountMinor = discountMinor < 0 ? 0 : discountMinor;
    notifyListeners();
  }

  void remove(CartLine line) {
    _lines.remove(line);
    notifyListeners();
  }

  void clear() {
    _lines.clear();
    notifyListeners();
  }

  /// Serialise to `PosOrderItemInput[]` for the createPosOrder mutation.
  List<Map<String, dynamic>> toOrderItemsInput() => _lines
      .map((l) => {
            'variantId': l.variant.id,
            'qty': l.qty,
            if (l.discountMinor > 0) 'discountMinor': l.discountMinor,
            if (l.overridePriceMinor != null)
              'priceOverrideMinor': l.overridePriceMinor,
          })
      .toList();
}
