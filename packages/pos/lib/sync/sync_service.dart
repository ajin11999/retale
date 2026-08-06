import 'dart:async';

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

  /// Background retry loop. Connectivity events are link-level only and on web
  /// (PWA) are unreliable — and orders are queued on *any* network failure,
  /// including the API being unreachable while the link stays up. So a link
  /// "return" event may never fire. This timer is the real safety net: while
  /// orders are pending it keeps attempting a flush until the queue drains.
  Timer? _retryTimer;
  static const _retryInterval = Duration(seconds: 15);

  /// Kick the background retry loop for orders restored from disk at startup.
  /// Call once after [OrderQueue.load].
  void start() => _scheduleRetries();

  void _scheduleRetries() {
    if (_retryTimer != null || _queue.isEmpty) return;
    _retryTimer = Timer.periodic(_retryInterval, (_) => flushQueue());
  }

  void _stopRetries() {
    _retryTimer?.cancel();
    _retryTimer = null;
  }

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

  final _inFlightLocalIds = <String>{};

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
    String? clientOrderId,
  }) async {
    final orderId = (clientOrderId != null && clientOrderId.isNotEmpty)
        ? clientOrderId
        : DateTime.now().microsecondsSinceEpoch.toString();

    if (_inFlightLocalIds.contains(orderId)) {
      // Already submitting this exact client order ID over the network — skip duplicate call.
      return SubmitResult(SubmitStatus.queued);
    }

    _inFlightLocalIds.add(orderId);
    try {
      final data = await _gql.mutate(Ops.createPosOrder, variables: {
        'posSessionId': posSessionId,
        'customerId': customerId,
        'items': items,
        'payments': payments,
        'clientOrderId': orderId,
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
        localId: orderId,
        posSessionId: posSessionId,
        customerId: customerId,
        items: items,
        payments: payments,
        createdAt: DateTime.now().toIso8601String(),
        totalMinor: totalMinor,
      ));
      _scheduleRetries();
      notifyListeners();
      return SubmitResult(SubmitStatus.queued);
    } finally {
      _inFlightLocalIds.remove(orderId);
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
        if (_inFlightLocalIds.contains(order.localId)) continue;
        _inFlightLocalIds.add(order.localId);
        try {
          await _gql.mutate(Ops.createPosOrder, variables: {
            'posSessionId': order.posSessionId,
            'customerId': order.customerId,
            'items': order.items,
            'payments': order.payments,
            'clientOrderId': order.localId,
          });
          await _queue.remove(order);
          flushed++;
        } on GraphQLAppException catch (e) {
          if (e.isNetworkError) break; // still offline — try again later.
          // Server rejected it (e.g. session closed): drop it so the queue
          // is not stuck. A real app would surface this for manual review.
          await _queue.remove(order);
        } finally {
          _inFlightLocalIds.remove(order.localId);
        }
      }
    } finally {
      _setBusy(false);
      if (_queue.isEmpty) _stopRetries();
      notifyListeners();
    }
    return flushed;
  }

  void _setBusy(bool value) {
    _busy = value;
    notifyListeners();
  }
}
