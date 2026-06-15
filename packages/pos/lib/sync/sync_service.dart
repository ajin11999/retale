import 'package:flutter/foundation.dart';

import '../cache/order_queue.dart';
import '../cache/product_cache.dart';
import '../graphql/graphql_service.dart';
import '../graphql/operations.dart';
import '../models/product.dart';

/// Outcome of submitting a sale.
enum SubmitStatus { confirmed, queued }

class SubmitResult {
  SubmitResult(this.status, {this.displayNumber});
  final SubmitStatus status;

  /// Server-assigned order number — only set when [status] is confirmed.
  final String? displayNumber;
}

/// Coordinates the offline layer: warms the product cache, submits orders
/// (queueing them when the API is unreachable) and flushes the queue.
class SyncService extends ChangeNotifier {
  SyncService._();
  static final SyncService instance = SyncService._();

  final _gql = GraphQLService.instance;
  final _cache = ProductCache.instance;
  final _queue = OrderQueue.instance;

  bool _busy = false;
  bool get busy => _busy;
  int get pendingCount => _queue.length;

  /// Pull the whole active catalog into the offline cache.
  Future<void> refreshCatalog() async {
    _setBusy(true);
    try {
      final data = await _gql.query(Ops.products);
      final products = (data['products'] as List<dynamic>)
          .map((p) => Product.fromJson(p as Map<String, dynamic>))
          .toList();
      await _cache.replaceAll(products);
    } finally {
      _setBusy(false);
    }
  }

  /// Submit a sale. Tries the API first; on a network failure the order is
  /// queued durably and [SubmitStatus.queued] is returned.
  ///
  /// Pass [queueWhenOffline] false for on-account sales: a queued order the
  /// server later rejects (e.g. credit limit) is silently dropped at flush,
  /// which must never happen to a debt record — surface the failure instead.
  Future<SubmitResult> submitOrder({
    required String posSessionId,
    String? customerId,
    required List<Map<String, dynamic>> items,
    required List<Map<String, dynamic>> payments,
    required num totalMinor,
    bool queueWhenOffline = true,
  }) async {
    try {
      final data = await _gql.mutate(Ops.createPosOrder, variables: {
        'posSessionId': posSessionId,
        'customerId': customerId,
        'items': items,
        'payments': payments,
      });
      final order = data['createPosOrder'] as Map<String, dynamic>;
      return SubmitResult(
        SubmitStatus.confirmed,
        displayNumber: order['displayNumber'] as String?,
      );
    } on GraphQLAppException catch (e) {
      if (!e.isNetworkError) rethrow; // a real validation error must surface.
      if (!queueWhenOffline) rethrow;
      await _queue.enqueue(QueuedOrder(
        localId: DateTime.now().microsecondsSinceEpoch.toString(),
        posSessionId: posSessionId,
        customerId: customerId,
        items: items,
        payments: payments,
        createdAt: DateTime.now().toIso8601String(),
        totalMinor: totalMinor,
      ));
      notifyListeners();
      return SubmitResult(SubmitStatus.queued);
    }
  }

  /// Attempt to submit every queued order. Stops at the first network error.
  /// Returns the number successfully flushed.
  Future<int> flushQueue() async {
    if (_queue.isEmpty || _busy) return 0;
    _setBusy(true);
    var flushed = 0;
    try {
      for (final order in _queue.all) {
        try {
          await _gql.mutate(Ops.createPosOrder, variables: {
            'posSessionId': order.posSessionId,
            'customerId': order.customerId,
            'items': order.items,
            'payments': order.payments,
          });
          await _queue.remove(order);
          flushed++;
        } on GraphQLAppException catch (e) {
          if (e.isNetworkError) break; // still offline — try again later.
          // Server rejected it (e.g. session closed): drop it so the queue
          // is not stuck. A real app would surface this for manual review.
          await _queue.remove(order);
        }
      }
    } finally {
      _setBusy(false);
      notifyListeners();
    }
    return flushed;
  }

  void _setBusy(bool value) {
    _busy = value;
    notifyListeners();
  }
}
