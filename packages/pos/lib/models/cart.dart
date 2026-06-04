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
  /// Cashier-set name shown on the rail; null falls back to an auto "C{n}".
  String? label;

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

  /// Set or clear the display label. A blank name reverts to the auto "C{n}".
  void rename(String? newLabel) {
    final trimmed = newLabel?.trim();
    label = (trimmed == null || trimmed.isEmpty) ? null : trimmed;
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

/// The open carts for one register screen, with the active one tracked.
/// Each cart is an independent in-progress sale — "park one, start another".
///
/// Subscribes to every owned [Cart] and re-broadcasts, so a single listener on
/// the [Register] repaints the rail (item counts, labels) and the active cart.
class Register extends ChangeNotifier {
  Register() {
    _add(Cart());
  }

  final List<Cart> _carts = [];
  int _activeIndex = 0;

  List<Cart> get carts => List.unmodifiable(_carts);
  int get activeIndex => _activeIndex;
  Cart get active => _carts[_activeIndex];
  int get count => _carts.length;

  /// Display name for a tab: the custom label, else the auto "C{n}".
  String labelFor(int index) => _carts[index].label ?? 'C${index + 1}';

  void _add(Cart cart) {
    cart.addListener(notifyListeners); // bubble line + label edits to the rail
    _carts.add(cart);
  }

  void select(int index) {
    if (index < 0 || index >= _carts.length || index == _activeIndex) return;
    _activeIndex = index;
    notifyListeners();
  }

  /// Open a fresh cart and switch to it.
  void addCart() {
    _add(Cart());
    _activeIndex = _carts.length - 1;
    notifyListeners();
  }

  /// Drop a cart. Confirmation (if the cart has items) is the caller's job;
  /// this just removes. Never drops the last one — clears and unnames it so
  /// exactly one sale is always open.
  void closeCart(int index) {
    if (index < 0 || index >= _carts.length) return;
    if (_carts.length == 1) {
      _carts.first
        ..clear()
        ..rename(null);
    } else {
      final removed = _carts.removeAt(index);
      removed.removeListener(notifyListeners);
      removed.dispose();
      if (_activeIndex >= _carts.length) _activeIndex = _carts.length - 1;
    }
    notifyListeners();
  }

  @override
  void dispose() {
    for (final c in _carts) {
      c.removeListener(notifyListeners);
      c.dispose();
    }
    super.dispose();
  }
}
