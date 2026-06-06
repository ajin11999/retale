import 'dart:convert';

import 'package:shared_preferences/shared_preferences.dart';

import '../models/product.dart';

/// Offline product catalog cache, so the register can look up and ring items
/// while the API is unreachable.
///
/// Stored as a JSON string in shared_preferences — this works uniformly on
/// Windows, Linux and web (localStorage). Only product *metadata* is cached;
/// image bytes are never stored here (images are remote URLs).
class ProductCache {
  ProductCache._();
  static final ProductCache instance = ProductCache._();

  static const _key = 'products_cache';

  List<Product> _products = [];
  DateTime? _refreshedAt;

  List<Product> get all => List.unmodifiable(_products);
  DateTime? get refreshedAt => _refreshedAt;
  bool get isEmpty => _products.isEmpty;

  /// Open-price products (loose hardware sold by a guessed lump). Surfaced as a
  /// quick-tile palette in the register rather than through normal search.
  List<Product> get openPriceProducts =>
      _products.where((p) => p.kind == 'open_price').toList();

  /// Load the cache into memory on startup.
  Future<void> load() async {
    try {
      final prefs = await SharedPreferences.getInstance();
      final raw = prefs.getString(_key);
      if (raw == null) return;
      final json = jsonDecode(raw) as Map<String, dynamic>;
      _refreshedAt = DateTime.tryParse(json['refreshedAt'] as String? ?? '');
      _products = (json['products'] as List<dynamic>)
          .map((p) => Product.fromJson(p as Map<String, dynamic>))
          .toList();
    } catch (_) {
      _products = [];
    }
  }

  /// Replace the cache with a freshly fetched catalog and persist it.
  Future<void> replaceAll(List<Product> products) async {
    _products = products;
    _refreshedAt = DateTime.now();
    final prefs = await SharedPreferences.getInstance();
    await prefs.setString(
      _key,
      jsonEncode({
        'refreshedAt': _refreshedAt!.toIso8601String(),
        'products': products.map((p) => p.toJson()).toList(),
      }),
    );
  }

  /// Case-insensitive search over product name, variant SKU and barcode.
  /// Open-price products are excluded — they live in the quick-tile palette.
  ///
  /// The query is split into whitespace-separated terms, each of which must
  /// match somewhere in the product's combined text (name, public name, and
  /// every variant's SKU/barcode). This makes search order-independent and
  /// cross-field, so "6201 nkn" finds "NKN 6201 2RS".
  List<Product> search(String query) {
    final sellable = _products.where((p) => p.kind != 'open_price');
    final terms = query.toLowerCase().split(RegExp(r'\s+'))
      ..removeWhere((t) => t.isEmpty);
    if (terms.isEmpty) return sellable.toList();
    return sellable.where((p) {
      final haystack = [
        p.name,
        p.publicDisplayName,
        for (final v in p.variants) ...[v.sku, v.barcode ?? ''],
      ].join(' ').toLowerCase();
      return terms.every(haystack.contains);
    }).toList();
  }

  /// Find the variant whose barcode exactly matches a scan, if any.
  ({Product product, Variant variant})? findByBarcode(String code) {
    for (final p in _products) {
      for (final v in p.variants) {
        if (v.barcode != null && v.barcode == code) {
          return (product: p, variant: v);
        }
      }
    }
    return null;
  }
}
