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
/// sale to return against. On wide screens the list and the selected order's
/// detail sit side by side; on narrow screens tapping an order pushes the
/// detail as a route. Needs the network — past orders are not part of the
/// offline cache.
class OrderHistoryScreen extends StatefulWidget {
  const OrderHistoryScreen({super.key, required this.posSessionId});

  /// The clerk's currently-open session — returns are rung against it.
  final String posSessionId;

  @override
  State<OrderHistoryScreen> createState() => _OrderHistoryScreenState();
}

class _OrderHistoryScreenState extends State<OrderHistoryScreen> {
  /// The split layout kicks in above this width; below it the detail pushes
  /// as a full-screen route (phones in portrait).
  static const _wideBreakpoint = 600.0;

  _Scope _scope = _Scope.thisShift;
  late Future<List<Map<String, dynamic>>> _future;

  /// The order shown in the right panel (wide layout only).
  String? _selectedOrderId;

  /// Set per build by the LayoutBuilder; read by the order tiles' onTap.
  bool _wide = false;

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
      _selectedOrderId = null;
      _future = _load();
    });
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('Orders')),
      body: LayoutBuilder(
        builder: (context, constraints) {
          _wide = constraints.maxWidth > _wideBreakpoint;
          final listPane = Column(
            children: [
              Padding(
                padding: const EdgeInsets.all(12),
                child: SegmentedButton<_Scope>(
                  segments: const [
                    ButtonSegment(
                        value: _Scope.thisShift, label: Text('This shift')),
                    ButtonSegment(value: _Scope.all, label: Text('All orders')),
                  ],
                  selected: {_scope},
                  onSelectionChanged: (s) => _setScope(s.first),
                ),
              ),
              Expanded(child: _buildList()),
            ],
          );
          if (!_wide) return listPane;
          return Row(
            children: [
              SizedBox(width: constraints.maxWidth * 0.4, child: listPane),
              const VerticalDivider(width: 1),
              Expanded(
                child: _selectedOrderId == null
                    ? const Center(
                        child: Text('Select an order to view details'))
                    : _OrderDetailPanel(
                        // Recreate the panel (and its fetch) per order.
                        key: ValueKey(_selectedOrderId),
                        orderId: _selectedOrderId!,
                        posSessionId: widget.posSessionId,
                        embedded: true,
                        onOrderChanged: _reload,
                      ),
              ),
            ],
          );
        },
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
    final id = o['id'] as String;
    return ListTile(
      selected: _wide && _selectedOrderId == id,
      selectedTileColor: Theme.of(context)
          .colorScheme
          .primaryContainer
          .withValues(alpha: 0.3),
      title: Text(o['displayNumber'] as String? ?? id),
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
        if (_wide) {
          setState(() => _selectedOrderId = id);
          return;
        }
        await Navigator.of(context).push(MaterialPageRoute(
          builder: (_) => _OrderDetailScreen(
            orderId: id,
            posSessionId: widget.posSessionId,
          ),
        ));
        // A return rung from the detail screen changes totals/status.
        _reload();
      },
    );
  }
}

/// Route wrapper for narrow screens: the detail panel behind its own AppBar.
class _OrderDetailScreen extends StatelessWidget {
  const _OrderDetailScreen({required this.orderId, required this.posSessionId});

  final String orderId;
  final String posSessionId;

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('Order')),
      body: _OrderDetailPanel(
        orderId: orderId,
        posSessionId: posSessionId,
        embedded: false,
      ),
    );
  }
}

/// Lines + payments for one past order, with print / WhatsApp / return
/// actions. `embedded` (the wide split layout) keeps the return flow inside
/// this panel instead of pushing a route, and reports order-changing actions
/// through [onOrderChanged] so the surrounding list can refresh.
class _OrderDetailPanel extends StatefulWidget {
  const _OrderDetailPanel({
    super.key,
    required this.orderId,
    required this.posSessionId,
    required this.embedded,
    this.onOrderChanged,
  });

  final String orderId;
  final String posSessionId;
  final bool embedded;
  final VoidCallback? onOrderChanged;

  @override
  State<_OrderDetailPanel> createState() => _OrderDetailPanelState();
}

class _OrderDetailPanelState extends State<_OrderDetailPanel> {
  late Future<Map<String, dynamic>> _future;

  /// Non-null while the embedded return flow replaces the detail view.
  List<Map<String, dynamic>>? _returnItems;

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

  void _returnRecorded() {
    ScaffoldMessenger.of(context)
        .showSnackBar(const SnackBar(content: Text('Return recorded')));
    _reload();
    widget.onOrderChanged?.call();
  }

  Future<void> _startReturn(Map<String, dynamic> o) async {
    final items = (o['items'] as List<dynamic>)
        .cast<Map<String, dynamic>>()
        .where((it) => it['voidedAt'] == null && (it['qty'] as num) > 0)
        .toList();
    if (widget.embedded) {
      setState(() => _returnItems = items);
      return;
    }
    final done = await Navigator.of(context).push<bool>(MaterialPageRoute(
      builder: (_) => ReturnScreen(
        originalOrderId: widget.orderId,
        posSessionId: widget.posSessionId,
        items: items,
      ),
    ));
    if (done == true && mounted) _returnRecorded();
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

  /// Reprint this order via the OS/browser print dialog.
  Future<void> _printReceipt(Map<String, dynamic> o) async {
    final store = await ReceiptService.instance.storeInfo();
    if (!mounted) return;
    await ReceiptService.instance.printReceipt(Receipt.fromOrderDetail(o, store));
  }

  @override
  Widget build(BuildContext context) {
    final returnItems = _returnItems;
    if (returnItems != null) {
      return ReturnScreen(
        originalOrderId: widget.orderId,
        posSessionId: widget.posSessionId,
        items: returnItems,
        onClose: (done) {
          setState(() => _returnItems = null);
          if (done) _returnRecorded();
        },
      );
    }
    return FutureBuilder<Map<String, dynamic>>(
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
                    Row(
                      children: [
                        Expanded(
                          child: OutlinedButton.icon(
                            icon: const Icon(Icons.print_outlined),
                            label: const Text('Print'),
                            onPressed: () => _printReceipt(o),
                          ),
                        ),
                        const SizedBox(width: 8),
                        Expanded(
                          child: OutlinedButton.icon(
                            icon: const Icon(Icons.chat_outlined),
                            label: const Text('WhatsApp'),
                            onPressed: () => _sendReceipt(o),
                          ),
                        ),
                      ],
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
        });
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
///
/// [prefillByVariantId] seeds the per-line quantities from a cart of items to
/// return (the register's "Return" flow). Each line's `variantId` consumes from
/// the matching demand, so an order with several lines of one variant fills in
/// order until the demand runs out. Null (the order-history path) starts empty.
class ReturnScreen extends StatefulWidget {
  const ReturnScreen({
    super.key,
    required this.originalOrderId,
    required this.posSessionId,
    required this.items,
    this.prefillByVariantId,
    this.onClose,
  });

  final String originalOrderId;
  final String posSessionId;
  final List<Map<String, dynamic>> items;
  final Map<String, int>? prefillByVariantId;

  /// When set, the screen is embedded in a panel rather than pushed as a
  /// route: finishing or dismissing calls this (`true` = return recorded)
  /// instead of popping the navigator, and the app bar shows a close button
  /// in place of the implied back arrow.
  final void Function(bool done)? onClose;

  @override
  State<ReturnScreen> createState() => _ReturnScreenState();
}

class _ReturnScreenState extends State<ReturnScreen> {
  /// orderItemId -> units to return.
  final Map<String, int> _qty = {};
  String _refundMethod = 'cash';
  bool _busy = false;
  String? _error;

  @override
  void initState() {
    super.initState();
    final demand = widget.prefillByVariantId;
    if (demand == null) return;
    // Greedily allocate each variant's demand across the order's lines.
    final remaining = Map<String, int>.from(demand);
    for (final it in widget.items) {
      final variantId = it['variantId'] as String?;
      if (variantId == null) continue;
      final want = remaining[variantId] ?? 0;
      if (want <= 0) continue;
      final max = (it['qty'] as num).toInt();
      final take = want < max ? want : max;
      if (take <= 0) continue;
      _qty[it['id'] as String] = take;
      remaining[variantId] = want - take;
    }
  }

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
      if (mounted) {
        final onClose = widget.onClose;
        if (onClose != null) {
          onClose(true);
        } else {
          Navigator.pop(context, true);
        }
      }
    } on GraphQLAppException catch (e) {
      setState(() => _error = e.message);
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final onClose = widget.onClose;
    return Scaffold(
      appBar: AppBar(
        title: const Text('Return items'),
        automaticallyImplyLeading: onClose == null,
        leading: onClose == null
            ? null
            : IconButton(
                icon: const Icon(Icons.close),
                tooltip: 'Back to order',
                onPressed: () => onClose(false),
              ),
      ),
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

/// Picks which past order to return the current cart against. Lists the
/// candidate orders (server-filtered to those containing every cart variant),
/// flagging which can fully cover the cart's quantities. Tapping one opens the
/// [ReturnScreen] prefilled with the cart's quantities; a recorded return pops
/// back to the register with `true` so it can clear the cart.
class ReturnOrderPicker extends StatelessWidget {
  const ReturnOrderPicker({
    super.key,
    required this.candidates,
    required this.demand,
    required this.posSessionId,
  });

  /// Orders from `Ops.ordersForReturn`, newest first.
  final List<Map<String, dynamic>> candidates;

  /// variantId -> units the cart wants to return.
  final Map<String, int> demand;
  final String posSessionId;

  /// Non-voided, positive-qty lines of an order — the only returnable units.
  static List<Map<String, dynamic>> _returnableItems(Map<String, dynamic> o) =>
      (o['items'] as List<dynamic>)
          .cast<Map<String, dynamic>>()
          .where((it) => it['voidedAt'] == null && (it['qty'] as num) > 0)
          .toList();

  /// True when the order has enough of every demanded variant to cover the cart.
  bool _coversCart(Map<String, dynamic> o) {
    final sold = <String, int>{};
    for (final it in _returnableItems(o)) {
      final v = it['variantId'] as String?;
      if (v == null) continue;
      sold[v] = (sold[v] ?? 0) + (it['qty'] as num).toInt();
    }
    return demand.entries.every((e) => (sold[e.key] ?? 0) >= e.value);
  }

  Future<void> _pick(BuildContext context, Map<String, dynamic> o) async {
    final done = await Navigator.of(context).push<bool>(MaterialPageRoute(
      builder: (_) => ReturnScreen(
        originalOrderId: o['id'] as String,
        posSessionId: posSessionId,
        items: _returnableItems(o),
        prefillByVariantId: demand,
      ),
    ));
    if (done == true && context.mounted) Navigator.pop(context, true);
  }

  @override
  Widget build(BuildContext context) {
    // Orders that can fully cover the cart first; recency order is preserved
    // within each group (the server already sorted newest-first).
    final covering = candidates.where(_coversCart).toList();
    final partial = candidates.where((o) => !_coversCart(o)).toList();
    final ordered = [...covering, ...partial];
    return Scaffold(
      appBar: AppBar(title: const Text('Return against…')),
      body: ListView.separated(
        itemCount: ordered.length,
        separatorBuilder: (_, __) => const Divider(height: 1),
        itemBuilder: (context, i) {
          final o = ordered[i];
          final covers = _coversCart(o);
          final lineCount = _returnableItems(o).length;
          return ListTile(
            title: Text(o['displayNumber'] as String? ?? o['id'] as String),
            subtitle: Text(
                '${_formatTime(o['createdAt'] as String?)}  ·  $lineCount item${lineCount == 1 ? '' : 's'}'),
            trailing: Column(
              mainAxisAlignment: MainAxisAlignment.center,
              crossAxisAlignment: CrossAxisAlignment.end,
              children: [
                Text(Money.format(o['totalMinor'] as num),
                    style: const TextStyle(fontWeight: FontWeight.bold)),
                Text(covers ? 'covers cart' : 'partial',
                    style: TextStyle(
                        fontSize: 11,
                        color: covers
                            ? Colors.green
                            : Theme.of(context).hintColor)),
              ],
            ),
            onTap: () => _pick(context, o),
          );
        },
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
