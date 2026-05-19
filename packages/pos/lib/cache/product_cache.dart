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
  List<Product> search(String query) {
    final q = query.trim().toLowerCase();
    if (q.isEmpty) return all;
    return _products.where((p) {
      if (p.name.toLowerCase().contains(q) ||
          p.publicDisplayName.toLowerCase().contains(q)) {
        return true;
      }
      return p.variants.any((v) =>
          v.sku.toLowerCase().contains(q) ||
          (v.barcode?.toLowerCase().contains(q) ?? false));
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
