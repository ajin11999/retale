import 'package:graphql_flutter/graphql_flutter.dart';
import 'package:sembast/sembast.dart';
import 'package:retale_workshop/db.dart';
import 'package:retale_workshop/services/product_service.dart';

/// Local cache of the product catalog so line entry works offline. Reads always
/// come from here, so searching products never needs the network; the cache is
/// refreshed from the API by [sync] whenever the app is online.
class CatalogRepo {
  final Database _db = DatabaseService.db;
  final StoreRef<String, Map<String, Object?>> _store =
      DatabaseService.catalog;

  /// Refresh the cache from the API: fetch the whole catalog and replace the
  /// stored set. Throws on a network/API failure — callers run this best-effort
  /// and keep the existing cache when it fails.
  Future<void> sync(GraphQLClient client) async {
    await replaceAll(await ProductService(client).fetchAll());
  }

  /// Replace the whole cached catalog with [variants] in one transaction.
  Future<void> replaceAll(List<CatalogVariant> variants) async {
    await _db.transaction((txn) async {
      await _store.delete(txn);
      for (final v in variants) {
        await _store.record(v.variantId).put(txn, v.toJson());
      }
    });
  }

  /// Cached variants matching [keyword] (name or sku, case-insensitive),
  /// ordered by name. A blank keyword returns the whole catalog. The catalog of
  /// a single workshop is small, so this loads and filters in memory.
  Future<List<CatalogVariant>> search(String keyword) async {
    final records = await _store.find(_db);
    final all = [for (final r in records) CatalogVariant.fromJson(r.value)];
    final q = keyword.trim().toLowerCase();
    final hits = q.isEmpty
        ? all
        : all
            .where((v) =>
                v.name.toLowerCase().contains(q) ||
                v.sku.toLowerCase().contains(q))
            .toList();
    hits.sort((a, b) => a.name.toLowerCase().compareTo(b.name.toLowerCase()));
    return hits;
  }
}
