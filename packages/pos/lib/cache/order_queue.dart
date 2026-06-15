import 'dart:convert';

import 'package:shared_preferences/shared_preferences.dart';

/// A sale rung while the API was unreachable, awaiting submission.
///
/// It references a real server [posSessionId] — a session is always opened
/// while online, so queued orders attach to a valid session once flushed.
class QueuedOrder {
  QueuedOrder({
    required this.localId,
    required this.posSessionId,
    required this.customerId,
    required this.items,
    required this.payments,
    required this.createdAt,
    required this.totalMinor,
  });

  final String localId;
  final String posSessionId;
  final String? customerId;
  final List<Map<String, dynamic>> items;
  final List<Map<String, dynamic>> payments;
  final String createdAt;
  final num totalMinor;

  Map<String, dynamic> toJson() => {
        'localId': localId,
        'posSessionId': posSessionId,
        'customerId': customerId,
        'items': items,
        'payments': payments,
        'createdAt': createdAt,
        'totalMinor': totalMinor,
      };

  factory QueuedOrder.fromJson(Map<String, dynamic> j) => QueuedOrder(
        localId: j['localId'] as String,
        posSessionId: j['posSessionId'] as String,
        customerId: j['customerId'] as String?,
        items: (j['items'] as List<dynamic>)
            .map((e) => Map<String, dynamic>.from(e as Map))
            .toList(),
        payments: (j['payments'] as List<dynamic>)
            .map((e) => Map<String, dynamic>.from(e as Map))
            .toList(),
        createdAt: j['createdAt'] as String,
        totalMinor: j['totalMinor'] as num,
      );
}

/// Durable FIFO queue of unsent orders.
///
/// Stored as a JSON string in shared_preferences so it survives a restart and
/// works uniformly on Windows, Linux and web.
class OrderQueue {
  OrderQueue._();
  static final OrderQueue instance = OrderQueue._();

  static const _key = 'order_queue';

  List<QueuedOrder> _orders = [];
  List<QueuedOrder> get all => List.unmodifiable(_orders);
  int get length => _orders.length;
  bool get isEmpty => _orders.isEmpty;

  Future<void> load() async {
    try {
      final prefs = await SharedPreferences.getInstance();
      final raw = prefs.getString(_key);
      if (raw == null) return;
      final list = jsonDecode(raw) as List<dynamic>;
      _orders = list
          .map((e) => QueuedOrder.fromJson(e as Map<String, dynamic>))
          .toList();
    } catch (_) {
      _orders = [];
    }
  }

  Future<void> _persist() async {
    final prefs = await SharedPreferences.getInstance();
    await prefs.setString(
      _key,
      jsonEncode(_orders.map((o) => o.toJson()).toList()),
    );
  }

  Future<void> enqueue(QueuedOrder order) async {
    _orders.add(order);
    await _persist();
  }

  Future<void> remove(QueuedOrder order) async {
    _orders.removeWhere((o) => o.localId == order.localId);
    await _persist();
  }
}
