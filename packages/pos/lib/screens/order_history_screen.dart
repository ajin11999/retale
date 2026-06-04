import 'package:flutter/material.dart';

import '../graphql/graphql_service.dart';
import '../graphql/operations.dart';
import '../models/money.dart';
import '../receipt/receipt.dart';
import '../receipt/receipt_service.dart';
import '../receipt/send_receipt_dialog.dart';
import '../widgets/common.dart';

/// Which orders the history view lists.
enum _Scope { thisShift, all }

/// Read-only history of orders, newest first. Defaults to the current shift;
/// the "All orders" scope reaches every session/clerk so a clerk can find a
/// sale to return against. Tap an order for its lines, payments and a return
/// action. Needs the network — past orders are not part of the offline cache.
class OrderHistoryScreen extends StatefulWidget {
  const OrderHistoryScreen({super.key, required this.posSessionId});

  /// The clerk's currently-open session — returns are rung against it.
  final String posSessionId;

  @override
  State<OrderHistoryScreen> createState() => _OrderHistoryScreenState();
}

class _OrderHistoryScreenState extends State<OrderHistoryScreen> {
  _Scope _scope = _Scope.thisShift;
  late Future<List<Map<String, dynamic>>> _future;

  @override
  void initState() {
    super.initState();
    _future = _load();
  }

  Future<List<Map<String, dynamic>>> _load() async {
    final data = _scope == _Scope.thisShift
        ? await GraphQLService.instance.query(
            Ops.sessionOrders,
            variables: {'posSessionId': widget.posSessionId, 'limit': 100},
          )
        : await GraphQLService.instance
            .query(Ops.recentOrders, variables: {'limit': 100});
    return (data['orders'] as List<dynamic>).cast<Map<String, dynamic>>();
  }

  void _reload() => setState(() => _future = _load());

  void _setScope(_Scope scope) {
    if (scope == _scope) return;
    setState(() {
      _scope = scope;
      _future = _load();
    });
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('Orders')),
      body: Column(
        children: [
          Padding(
            padding: const EdgeInsets.all(12),
            child: SegmentedButton<_Scope>(
              segments: const [
                ButtonSegment(value: _Scope.thisShift, label: Text('This shift')),
                ButtonSegment(value: _Scope.all, label: Text('All orders')),
              ],
              selected: {_scope},
              onSelectionChanged: (s) => _setScope(s.first),
            ),
          ),
          Expanded(child: _buildList()),
        ],
      ),
    );
  }

  Widget _buildList() {
    return FutureBuilder<List<Map<String, dynamic>>>(
      future: _future,
      builder: (context, snapshot) {
        if (snapshot.connectionState != ConnectionState.done) {
          return const Center(child: CircularProgressIndicator());
        }
        if (snapshot.hasError) {
          return ErrorRetry(
              message: describeError(snapshot.error!), onRetry: _reload);
        }
        final orders = snapshot.data!;
        if (orders.isEmpty) {
          return Center(
            child: Text(_scope == _Scope.thisShift
                ? 'No orders on this shift yet'
                : 'No orders yet'),
          );
        }
        return RefreshIndicator(
          onRefresh: () async => _reload(),
          child: ListView.separated(
            itemCount: orders.length,
            separatorBuilder: (_, __) => const Divider(height: 1),
            itemBuilder: (context, i) => _orderTile(orders[i]),
          ),
        );
      },
    );
  }

  Widget _orderTile(Map<String, dynamic> o) {
    final status = o['status'] as String;
    return ListTile(
      title: Text(o['displayNumber'] as String? ?? o['id'] as String),
      subtitle: Text(_formatTime(o['createdAt'] as String?)),
      trailing: Column(
        mainAxisAlignment: MainAxisAlignment.center,
        crossAxisAlignment: CrossAxisAlignment.end,
        children: [
          Text(Money.format(o['totalMinor'] as num),
              style: const TextStyle(fontWeight: FontWeight.bold)),
          if (status != 'closed')
            Text(status,
                style: TextStyle(
                    fontSize: 11,
                    color: status == 'cancelled'
                        ? Colors.redAccent
                        : Theme.of(context).hintColor)),
        ],
      ),
      onTap: () async {
        await Navigator.of(context).push(MaterialPageRoute(
          builder: (_) => _OrderDetailScreen(
            orderId: o['id'] as String,
            posSessionId: widget.posSessionId,
          ),
        ));
        // A return rung from the detail screen changes totals/status.
        _reload();
      },
    );
  }
}

/// Lines + payments for one past order, with a return action.
class _OrderDetailScreen extends StatefulWidget {
  const _OrderDetailScreen({required this.orderId, required this.posSessionId});

  final String orderId;
  final String posSessionId;

  @override
  State<_OrderDetailScreen> createState() => _OrderDetailScreenState();
}

class _OrderDetailScreenState extends State<_OrderDetailScreen> {
  late Future<Map<String, dynamic>> _future;

  @override
  void initState() {
    super.initState();
    _future = _load();
  }

  Future<Map<String, dynamic>> _load() async {
    final data = await GraphQLService.instance
        .query(Ops.orderDetail, variables: {'id': widget.orderId});
    final order = data['order'];
    if (order == null) throw GraphQLAppException('Order not found');
    return order as Map<String, dynamic>;
  }

  void _reload() => setState(() => _future = _load());

  /// Only a closed, non-return order has units that can be sent back.
  bool _returnable(Map<String, dynamic> o) =>
      o['status'] == 'closed' && o['returnOfOrderId'] == null;

  Future<void> _startReturn(Map<String, dynamic> o) async {
    final items = (o['items'] as List<dynamic>)
        .cast<Map<String, dynamic>>()
        .where((it) => it['voidedAt'] == null && (it['qty'] as num) > 0)
        .toList();
    final done = await Navigator.of(context).push<bool>(MaterialPageRoute(
      builder: (_) => _ReturnScreen(
        originalOrderId: widget.orderId,
        posSessionId: widget.posSessionId,
        items: items,
      ),
    ));
    if (done == true && mounted) {
      ScaffoldMessenger.of(context)
          .showSnackBar(const SnackBar(content: Text('Return recorded')));
      _reload();
    }
  }

  /// Build a receipt from this order and offer to WhatsApp it. Prefills the
  /// attached customer's number when the order has one.
  Future<void> _sendReceipt(Map<String, dynamic> o) async {
    final store = await ReceiptService.instance.storeInfo();
    if (!mounted) return;
    final customer = o['customer'] as Map<String, dynamic>?;
    await showSendReceiptDialog(
      context,
      receipt: Receipt.fromOrderDetail(o, store),
      phone: customer?['phone'] as String?,
    );
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('Order')),
      body: FutureBuilder<Map<String, dynamic>>(
        future: _future,
        builder: (context, snapshot) {
          if (snapshot.connectionState != ConnectionState.done) {
            return const Center(child: CircularProgressIndicator());
          }
          if (snapshot.hasError) {
            return ErrorRetry(
                message: describeError(snapshot.error!), onRetry: _reload);
          }
          final o = snapshot.data!;
          final items =
              (o['items'] as List<dynamic>).cast<Map<String, dynamic>>();
          final payments =
              (o['payments'] as List<dynamic>).cast<Map<String, dynamic>>();
          return Column(
            children: [
              Expanded(
                child: ListView(
                  children: [
                    ListTile(
                      title: Text(
                          o['displayNumber'] as String? ?? o['id'] as String,
                          style: const TextStyle(fontWeight: FontWeight.bold)),
                      subtitle: Text(
                          '${o['status']}  ·  ${_formatTime(o['createdAt'] as String?)}'),
                      trailing: Text(Money.format(o['totalMinor'] as num),
                          style: const TextStyle(
                              fontSize: 18, fontWeight: FontWeight.bold)),
                    ),
                    const Divider(),
                    for (final it in items) _itemTile(it),
                    const Divider(),
                    for (final p in payments)
                      ListTile(
                        dense: true,
                        leading: const Icon(Icons.payments),
                        title: Text(p['method'] as String),
                        trailing: Text(Money.format(p['amountMinor'] as num)),
                      ),
                  ],
                ),
              ),
              Padding(
                padding: const EdgeInsets.fromLTRB(16, 8, 16, 16),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.stretch,
                  children: [
                    OutlinedButton.icon(
                      icon: const Icon(Icons.chat_outlined),
                      label: const Text('Send receipt'),
                      onPressed: () => _sendReceipt(o),
                    ),
                    if (_returnable(o)) ...[
                      const SizedBox(height: 8),
                      OutlinedButton.icon(
                        icon: const Icon(Icons.assignment_return),
                        label: const Text('Return items'),
                        onPressed: () => _startReturn(o),
                      ),
                    ],
                  ],
                ),
              ),
            ],
          );
        },
      ),
    );
  }

  Widget _itemTile(Map<String, dynamic> it) {
    final voided = it['voidedAt'] != null;
    final qty = (it['qty'] as num).toInt();
    return ListTile(
      dense: true,
      title: Text(
        it['displayName'] as String,
        style: voided
            ? const TextStyle(decoration: TextDecoration.lineThrough)
            : null,
      ),
      subtitle:
          Text('$qty × ${Money.format(it['snapshotPriceMinor'] as num)}'),
      trailing: Text(Money.format(it['lineTotalMinor'] as num)),
    );
  }
}

/// Pick lines and quantities to return, choose a refund method, and submit.
/// The server enforces over-return limits; this caps each line at its original
/// quantity and surfaces any rejection (e.g. units already returned).
class _ReturnScreen extends StatefulWidget {
  const _ReturnScreen({
    required this.originalOrderId,
    required this.posSessionId,
    required this.items,
  });

  final String originalOrderId;
  final String posSessionId;
  final List<Map<String, dynamic>> items;

  @override
  State<_ReturnScreen> createState() => _ReturnScreenState();
}

class _ReturnScreenState extends State<_ReturnScreen> {
  /// orderItemId -> units to return.
  final Map<String, int> _qty = {};
  String _refundMethod = 'cash';
  bool _busy = false;
  String? _error;

  int get _selectedCount => _qty.values.fold(0, (a, b) => a + b);

  void _setQty(String id, int max, int value) {
    setState(() {
      final clamped = value < 0 ? 0 : (value > max ? max : value);
      if (clamped == 0) {
        _qty.remove(id);
      } else {
        _qty[id] = clamped;
      }
    });
  }

  Future<void> _submit() async {
    final items = _qty.entries
        .map((e) => {'orderItemId': e.key, 'qty': e.value})
        .toList();
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      await GraphQLService.instance.mutate(Ops.createReturn, variables: {
        'originalOrderId': widget.originalOrderId,
        'posSessionId': widget.posSessionId,
        'items': items,
        'refundMethod': _refundMethod,
      });
      if (mounted) Navigator.pop(context, true);
    } on GraphQLAppException catch (e) {
      setState(() => _error = e.message);
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('Return items')),
      body: Column(
        children: [
          Expanded(
            child: ListView(
              children: [
                for (final it in widget.items) _returnLine(it),
              ],
            ),
          ),
          const Divider(height: 1),
          Padding(
            padding: const EdgeInsets.all(16),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                Row(
                  children: [
                    const Text('Refund as'),
                    const Spacer(),
                    SegmentedButton<String>(
                      segments: const [
                        ButtonSegment(value: 'cash', label: Text('Cash')),
                        ButtonSegment(
                            value: 'store_credit', label: Text('Store credit')),
                      ],
                      selected: {_refundMethod},
                      onSelectionChanged: (s) =>
                          setState(() => _refundMethod = s.first),
                    ),
                  ],
                ),
                if (_error != null) ...[
                  const SizedBox(height: 12),
                  Text(_error!, style: const TextStyle(color: Colors.red)),
                ],
                const SizedBox(height: 12),
                FilledButton.icon(
                  icon: const Icon(Icons.assignment_return),
                  label: Text(_selectedCount == 0
                      ? 'Select items to return'
                      : 'Return $_selectedCount item${_selectedCount == 1 ? '' : 's'}'),
                  onPressed:
                      (_busy || _selectedCount == 0) ? null : _submit,
                ),
              ],
            ),
          ),
        ],
      ),
    );
  }

  Widget _returnLine(Map<String, dynamic> it) {
    final id = it['id'] as String;
    final max = (it['qty'] as num).toInt();
    final selected = _qty[id] ?? 0;
    return ListTile(
      title: Text(it['displayName'] as String),
      subtitle: Text(
          'Sold $max × ${Money.format(it['snapshotPriceMinor'] as num)}'),
      trailing: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          IconButton(
            icon: const Icon(Icons.remove_circle_outline),
            onPressed: selected == 0 ? null : () => _setQty(id, max, selected - 1),
          ),
          Text('$selected'),
          IconButton(
            icon: const Icon(Icons.add_circle_outline),
            onPressed:
                selected >= max ? null : () => _setQty(id, max, selected + 1),
          ),
        ],
      ),
    );
  }
}

/// Local time as HH:mm from an ISO-8601 string.
String _formatTime(String? iso) {
  if (iso == null) return '';
  final dt = DateTime.tryParse(iso)?.toLocal();
  if (dt == null) return '';
  final hh = dt.hour.toString().padLeft(2, '0');
  final mm = dt.minute.toString().padLeft(2, '0');
  return '$hh:$mm';
}
