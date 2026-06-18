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
  num discountMinor;

  /// Cashier-entered price for open-price (and service) lines, or an override
  /// edited on the cart; null means use the variant's base price.
  num? overridePriceMinor;

  /// The effective unit price: an entered override wins over the base price.
  num get unitPriceMinor => overridePriceMinor ?? variant.priceMinor;

  /// qty * price - discount, never below zero.
  num get lineTotalMinor {
    final gross = unitPriceMinor * qty - discountMinor;
    return gross < 0 ? 0 : gross;
  }

  /// Per-unit cost. Open-price products derive cost from the entered price via
  /// the product's ratio (matching the API's snapshot rule); everything else
  /// uses the variant's weighted-average cost.
  num get unitCostMinor => unitCostForPrice(unitPriceMinor);

  /// Per-unit cost at a hypothetical [priceMinor], for previewing a price edit
  /// before it is applied. Same rule as [unitCostMinor].
  num unitCostForPrice(num priceMinor) {
    final ratio = product.costRatioBps;
    if (product.kind == 'open_price' && ratio != null) {
      return (priceMinor * ratio / 10000 * 100).round() / 100; // snap to 2dp
    }
    return variant.costMinor;
  }

  /// qty * unit cost — the cost of goods for this line.
  num get lineCostMinor => unitCostMinor * qty;

  /// Line revenue minus line cost. Can be negative if sold below cost.
  num get lineMarginMinor => lineTotalMinor - lineCostMinor;

  /// Per-unit margin, ignoring any line-level discount: unit price minus unit
  /// cost. The "each" figure, as opposed to [lineMarginMinor] (× qty).
  num get unitMarginMinor => unitPriceMinor - unitCostMinor;

  /// Per-unit margin as a fraction of unit price, or null when price is zero.
  double? get unitMarginFraction =>
      unitPriceMinor == 0 ? null : unitMarginMinor / unitPriceMinor;

  /// Gross margin as a fraction of revenue (0.25 = 25%), or null when the line
  /// has no revenue to measure against.
  double? get marginFraction =>
      lineTotalMinor == 0 ? null : lineMarginMinor / lineTotalMinor;

  String get displayName {
    final label = variant.label;
    return label == null || label.isEmpty
        ? product.publicDisplayName
        : '${product.publicDisplayName} — $label';
  }

  /// Serialise for the durable cart store. The full product and variant are
  /// kept so a parked line restores exactly as rung — its name, price and cost
  /// — even if the catalog later changes or the variant is deleted.
  Map<String, dynamic> toJson() => {
        'product': product.toJson(),
        'variant': variant.toJson(),
        'qty': qty,
        if (discountMinor != 0) 'discountMinor': discountMinor,
        if (overridePriceMinor != null) 'overridePriceMinor': overridePriceMinor,
      };

  factory CartLine.fromJson(Map<String, dynamic> j) => CartLine(
        product: Product.fromJson(j['product'] as Map<String, dynamic>),
        variant: Variant.fromJson(j['variant'] as Map<String, dynamic>),
        qty: (j['qty'] as num?)?.toInt() ?? 1,
        discountMinor: (j['discountMinor'] as num?) ?? 0,
        overridePriceMinor: j['overridePriceMinor'] as num?,
      );
}

/// The current sale. A [ChangeNotifier] so the register UI rebuilds on edits.
class Cart extends ChangeNotifier {
  Cart();

  /// Cashier-set name shown on the rail; null falls back to an auto "C{n}".
  String? label;

  final List<CartLine> _lines = [];

  List<CartLine> get lines => List.unmodifiable(_lines);
  bool get isEmpty => _lines.isEmpty;
  num get totalMinor =>
      _lines.fold<num>(0, (sum, l) => sum + l.lineTotalMinor);

  /// Cost of goods across every line.
  num get totalCostMinor =>
      _lines.fold<num>(0, (sum, l) => sum + l.lineCostMinor);

  /// Total revenue minus total cost.
  num get totalMarginMinor => totalMinor - totalCostMinor;

  /// Cart-wide gross margin as a fraction of revenue, or null when empty.
  double? get marginFraction =>
      totalMinor == 0 ? null : totalMarginMinor / totalMinor;

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
  void addOpenPrice(Product product, Variant variant, num priceMinor) {
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

  void setDiscount(CartLine line, num discountMinor) {
    line.discountMinor = discountMinor < 0 ? 0 : discountMinor;
    notifyListeners();
  }

  /// Override a line's unit price. A non-positive value clears the override,
  /// reverting to the variant's base price.
  void setPrice(CartLine line, num? priceMinor) {
    line.overridePriceMinor =
        (priceMinor != null && priceMinor > 0) ? priceMinor : null;
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

  /// Serialise for the durable cart store.
  Map<String, dynamic> toJson() => {
        if (label != null) 'label': label,
        'lines': _lines.map((l) => l.toJson()).toList(),
      };

  factory Cart.fromJson(Map<String, dynamic> j) {
    final cart = Cart()..label = j['label'] as String?;
    cart._lines.addAll((j['lines'] as List<dynamic>? ?? [])
        .map((e) => CartLine.fromJson(e as Map<String, dynamic>)));
    return cart;
  }
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

  /// Builds a register with no carts — only for [Register.fromJson], which then
  /// adds the saved carts back. Every other path keeps at least one cart open.
  Register._empty();

  /// Restore a register persisted by the cart store. Falls back to a fresh
  /// register if nothing was saved, so there is always one cart to ring against.
  factory Register.fromJson(Map<String, dynamic> j) {
    final carts = (j['carts'] as List<dynamic>? ?? [])
        .map((e) => Cart.fromJson(e as Map<String, dynamic>))
        .toList();
    if (carts.isEmpty) return Register();
    final register = Register._empty();
    for (final c in carts) {
      register._add(c);
    }
    final saved = (j['activeIndex'] as num?)?.toInt() ?? 0;
    register._activeIndex = saved.clamp(0, carts.length - 1);
    return register;
  }

  final List<Cart> _carts = [];
  int _activeIndex = 0;

  List<Cart> get carts => List.unmodifiable(_carts);
  int get activeIndex => _activeIndex;
  Cart get active => _carts[_activeIndex];
  int get count => _carts.length;

  /// True for a brand-new register: a single empty, unnamed cart. Used to
  /// decide whether restoring saved carts would clobber work already in hand.
  bool get isPristine =>
      _carts.length == 1 && _carts.first.isEmpty && _carts.first.label == null;

  Map<String, dynamic> toJson() => {
        'activeIndex': _activeIndex,
        'carts': _carts.map((c) => c.toJson()).toList(),
      };

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
