import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../../graphql/graphql_service.dart';
import '../../graphql/operations.dart';
import '../../models/models.dart';
import '../../widgets/common.dart';
import '../../widgets/scan_sheet.dart';
import '../count_screen.dart';

/// Read-Only simulation screen for reconciling a Purchase Order.
/// Counts are kept strictly in local memory [_counted] during this screen's
/// lifecycle. Closing the screen or app resets the memory state without
/// committing any backend modifications.
class PoReconcileScreen extends StatefulWidget {
  const PoReconcileScreen({super.key, required this.purchase});

  final PurchaseSummary purchase;

  @override
  State<PoReconcileScreen> createState() => _PoReconcileScreenState();
}

class _PoReconcileScreenState extends State<PoReconcileScreen> {
  List<ReceivingLine>? _lines;
  Map<String, VariantInfo> _labels = const {};
  Object? _loadError;

  /// purchaseItemId -> simulated counted qty (held ONLY in memory).
  final _counted = <String, num>{};

  final _scanField = TextEditingController();
  final _qtyControllers = <String, TextEditingController>{};

  String? _lastScanHitId;

  final _checklistKeys = <String, GlobalKey>{};
  final _byProductKeys = <String, GlobalKey>{};

  @override
  void initState() {
    super.initState();
    _load();
  }

  @override
  void dispose() {
    _scanField.dispose();
    for (final c in _qtyControllers.values) {
      c.dispose();
    }
    super.dispose();
  }

  String _fmt(num v) =>
      v == v.truncate() ? v.toInt().toString() : v.toString();

  VariantInfo? _variantOf(ReceivingLine line) {
    return line.variantId == null ? null : _labels[line.variantId];
  }

  String _titleOf(ReceivingLine line) {
    final v = _variantOf(line);
    return v?.displayName ?? line.description ?? '(unnamed line)';
  }

  /// Target quantity to recount/reconcile against.
  /// For open POs, it's `remaining` (or `qtyOrdered`). For completed POs,
  /// it's `qtyOrdered`.
  num _targetExpected(ReceivingLine line) {
    return line.remaining > 0 ? line.remaining : line.qtyOrdered;
  }

  Future<void> _load() async {
    setState(() {
      _lines = null;
      _loadError = null;
    });
    try {
      final results = await Future.wait([
        GraphQLService.instance.query(Ops.receivingCheckLines,
            variables: {'purchaseId': widget.purchase.id}),
        GraphQLService.instance.query(Ops.productLabels),
      ]);
      if (!mounted) return;

      final lines = (results[0]['receivingCheckLines'] as List<dynamic>)
          .map((l) => ReceivingLine.fromJson(l as Map<String, dynamic>))
          .toList();

      setState(() {
        _lines = lines;
        _labels = buildVariantLabelMap(results[1]['products'] as List<dynamic>);
        for (final line in lines) {
          _syncController(line);
        }
      });
    } catch (e) {
      if (mounted) setState(() => _loadError = e);
    }
  }

  // ── State Management in memory ───────────────────────────────────────────

  void _setCount(ReceivingLine line, num qty) {
    if (qty < 0) qty = 0;
    setState(() {
      _counted[line.purchaseItemId] = qty;
      _syncController(line);
    });
  }

  void _clearCount(ReceivingLine line) {
    setState(() {
      _counted.remove(line.purchaseItemId);
      _syncController(line);
    });
  }

  void _syncController(ReceivingLine line) {
    final c = _qtyControllers[line.purchaseItemId];
    if (c == null) return;
    final counted = _counted[line.purchaseItemId];
    final text = counted == null ? '' : _fmt(counted);
    if (c.text != text) c.text = text;
  }

  TextEditingController _controllerFor(ReceivingLine line) =>
      _qtyControllers.putIfAbsent(line.purchaseItemId, () {
        final counted = _counted[line.purchaseItemId];
        final c = TextEditingController(text: counted == null ? '' : _fmt(counted));
        c.addListener(() {
          final text = c.text.trim();
          if (text.isEmpty) {
            if (_counted.containsKey(line.purchaseItemId)) {
              setState(() => _counted.remove(line.purchaseItemId));
            }
            return;
          }
          final qty = num.tryParse(text);
          if (qty != null && _counted[line.purchaseItemId] != qty) {
            _setCount(line, qty);
          }
        });
        return c;
      });

  // ── Scanning ─────────────────────────────────────────────────────────────

  Future<void> _handleCode(String code) async {
    final trimmed = code.trim();
    if (trimmed.isEmpty) return;
    _scanField.clear();
    try {
      final data = await GraphQLService.instance.query(Ops.resolveReceivingScan,
          variables: {'purchaseId': widget.purchase.id, 'code': trimmed});
      if (!mounted) return;
      final ids = (data['resolveReceivingScan'] as List<dynamic>)
          .map((i) => (i as Map<String, dynamic>)['id'] as String)
          .toSet();
      final matches = (_lines ?? [])
          .where((l) => ids.contains(l.purchaseItemId))
          .toList();
      if (matches.isEmpty) {
        ScaffoldMessenger.of(context).showSnackBar(
            SnackBar(content: Text('No PO line matches "$trimmed"')));
        return;
      }
      final line =
          matches.length == 1 ? matches.first : await _pickLine(matches);
      if (line == null || !mounted) return;
      final current = _counted[line.purchaseItemId] ?? 0;
      _setCount(line, current + 1);
      setState(() => _lastScanHitId = line.purchaseItemId);
    } catch (e) {
      if (mounted) {
        ScaffoldMessenger.of(context)
            .showSnackBar(SnackBar(content: Text(describeError(e))));
      }
    }
  }

  Future<ReceivingLine?> _pickLine(List<ReceivingLine> matches) {
    return showDialog<ReceivingLine>(
      context: context,
      builder: (context) => SimpleDialog(
        title: const Text('Several lines match — which one?'),
        children: [
          for (final line in matches)
            SimpleDialogOption(
              onPressed: () => Navigator.pop(context, line),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  ProductTitleText.fromVariantInfo(_variantOf(line),
                      fallbackDescription: line.description, fontSize: 16, skuFontSize: 13),
                  const SizedBox(height: 4),
                  Text(
                    'Simulated count: ${_fmt(_counted[line.purchaseItemId] ?? 0)} of ${_fmt(_targetExpected(line))}',
                    style: const TextStyle(fontSize: 14),
                  ),
                ],
              ),
            ),
        ],
      ),
    );
  }

  Future<void> _openCamera() async {
    final code = await showScanSheet(context);
    if (code != null && mounted) await _handleCode(code);
  }

  // ── Review Simulation ───────────────────────────────────────────────────

  Future<void> _openReview() async {
    final lines = _lines;
    if (lines == null || _counted.isEmpty) return;

    final touched =
        lines.where((l) => _counted.containsKey(l.purchaseItemId)).toList();

    await showModalBottomSheet<void>(
      context: context,
      isScrollControlled: true,
      builder: (sheetContext) => SafeArea(
        child: Padding(
          padding: const EdgeInsets.fromLTRB(16, 16, 16, 16),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              Row(
                children: [
                  const Icon(Icons.analytics_outlined, color: Colors.indigo),
                  const SizedBox(width: 8),
                  Text(
                    'Simulation Review (${touched.length} lines)',
                    style: const TextStyle(
                      fontSize: 18,
                      fontWeight: FontWeight.bold,
                    ),
                  ),
                ],
              ),
              const SizedBox(height: 8),
              const Text(
                'Read-Only mode: Counts exist in state memory only.',
                style: TextStyle(fontSize: 13, color: Colors.grey),
              ),
              const Divider(height: 24),
              Flexible(
                child: ListView.separated(
                  shrinkWrap: true,
                  itemCount: touched.length,
                  separatorBuilder: (_, __) => const Divider(height: 1),
                  itemBuilder: (context, i) {
                    final line = touched[i];
                    final simulated = _counted[line.purchaseItemId]!;
                    final expected = _targetExpected(line);
                    final delta = simulated - expected;
                    final color = delta == 0
                        ? Theme.of(context).colorScheme.onSurfaceVariant
                        : delta > 0
                            ? Colors.green.shade700
                            : Colors.red.shade700;

                    return ListTile(
                      dense: true,
                      title: ProductTitleText.fromVariantInfo(_variantOf(line),
                          fallbackDescription: line.description, fontSize: 14, skuFontSize: 11),
                      subtitle: Text(
                        'Ordered: ${_fmt(line.qtyOrdered)} · Delivered: ${_fmt(line.qtyDelivered)}',
                        style: const TextStyle(fontSize: 12),
                      ),
                      trailing: Text(
                        delta == 0
                            ? '${_fmt(simulated)} ✓'
                            : '${_fmt(expected)} → ${_fmt(simulated)} '
                                '(${delta > 0 ? '+' : ''}${_fmt(delta)})',
                        style: TextStyle(
                          fontSize: 14,
                          fontWeight: FontWeight.bold,
                          color: color,
                        ),
                      ),
                    );
                  },
                ),
              ),
              const SizedBox(height: 16),
              FilledButton.icon(
                icon: const Icon(Icons.check_circle_outline),
                label: const Text('Finish Simulation'),
                style: FilledButton.styleFrom(
                  padding: const EdgeInsets.symmetric(vertical: 14),
                  textStyle: const TextStyle(fontSize: 16),
                ),
                onPressed: () {
                  Navigator.pop(sheetContext);
                  ScaffoldMessenger.of(context).showSnackBar(
                    SnackBar(
                      content: Text(
                        'Simulation complete for ${widget.purchase.vendorName}. Memory resetted.',
                      ),
                    ),
                  );
                  Navigator.pop(context);
                },
              ),
            ],
          ),
        ),
      ),
    );
  }

  Future<void> _confirmLeave(bool didPop) async {
    if (didPop) return;
    final leave = await showDialog<bool>(
      context: context,
      builder: (context) => AlertDialog(
        title: const Text('Discard simulated count?'),
        content: Text(
            '${_counted.length} simulated line count${_counted.length == 1 ? '' : 's'} will be resetted.'),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(context, false),
            child: const Text('Keep simulating'),
          ),
          FilledButton(
            onPressed: () => Navigator.pop(context, true),
            child: const Text('Discard & Exit'),
          ),
        ],
      ),
    );
    if (leave == true && mounted) Navigator.of(context).pop();
  }

  // ── UI ───────────────────────────────────────────────────────────────────

  @override
  Widget build(BuildContext context) {
    return PopScope(
      canPop: _counted.isEmpty,
      onPopInvokedWithResult: (didPop, _) => _confirmLeave(didPop),
      child: DefaultTabController(
        length: 2,
        child: Scaffold(
          appBar: AppBar(
            title: Text('Reconcile PO: ${widget.purchase.vendorName}'),
            bottom: PreferredSize(
              preferredSize: const Size.fromHeight(132),
              child: Column(
                children: [
                  Container(
                    width: double.infinity,
                    color: Colors.amber.shade100,
                    padding: const EdgeInsets.symmetric(vertical: 4, horizontal: 12),
                    child: Row(
                      mainAxisAlignment: MainAxisAlignment.center,
                      children: [
                        Icon(Icons.lock_clock, size: 16, color: Colors.amber.shade900),
                        const SizedBox(width: 6),
                        Text(
                          'READ-ONLY SIMULATION — Memory state only',
                          style: TextStyle(
                            fontSize: 12,
                            fontWeight: FontWeight.bold,
                            color: Colors.amber.shade900,
                          ),
                        ),
                      ],
                    ),
                  ),
                  const SizedBox(height: 8),
                  Padding(
                    padding: const EdgeInsets.fromLTRB(16, 0, 16, 8),
                    child: Row(
                      children: [
                        Expanded(
                          child: TextField(
                            controller: _scanField,
                            autocorrect: false,
                            textInputAction: TextInputAction.done,
                            decoration: const InputDecoration(
                              prefixIcon: Icon(Icons.qr_code_scanner),
                              hintText: 'Scan or type a code',
                              border: OutlineInputBorder(),
                              isDense: true,
                            ),
                            onSubmitted: _handleCode,
                          ),
                        ),
                        const SizedBox(width: 8),
                        IconButton.filledTonal(
                          tooltip: 'Scan with camera',
                          icon: const Icon(Icons.photo_camera),
                          onPressed: _openCamera,
                        ),
                      ],
                    ),
                  ),
                  const TabBar(tabs: [
                    Tab(text: 'Checklist'),
                    Tab(text: 'By product'),
                  ]),
                ],
              ),
            ),
          ),
          body: _buildBody(),
          bottomNavigationBar: SafeArea(
            child: Padding(
              padding: const EdgeInsets.all(12),
              child: FilledButton(
                onPressed: _counted.isEmpty ? null : _openReview,
                style: FilledButton.styleFrom(
                  padding: const EdgeInsets.symmetric(vertical: 16),
                  textStyle: const TextStyle(fontSize: 17),
                ),
                child: Text(_counted.isEmpty
                    ? 'No items counted in simulation'
                    : 'Review ${_counted.length} simulated line count${_counted.length == 1 ? '' : 's'}'),
              ),
            ),
          ),
        ),
      ),
    );
  }

  Widget _buildBody() {
    if (_loadError != null) {
      return ErrorRetry(message: describeError(_loadError!), onRetry: _load);
    }
    final lines = _lines;
    if (lines == null) {
      return const Center(child: CircularProgressIndicator());
    }
    if (lines.isEmpty) {
      return const Center(child: Text('This purchase order has no lines.'));
    }
    return TabBarView(
      children: [
        _buildChecklist(lines),
        _buildByProduct(lines),
      ],
    );
  }

  Widget _buildChecklist(List<ReceivingLine> lines) {
    return ListView.separated(
      itemCount: lines.length,
      separatorBuilder: (_, __) => const Divider(height: 1),
      itemBuilder: (context, i) {
        final line = lines[i];
        final key =
            _checklistKeys.putIfAbsent(line.purchaseItemId, () => GlobalKey());

        final expected = _targetExpected(line);
        final counted = _counted[line.purchaseItemId];
        final full = counted != null && counted >= expected;
        final partial = counted != null && counted > 0 && !full;

        return ListTile(
          key: key,
          contentPadding: const EdgeInsets.symmetric(horizontal: 8),
          minLeadingWidth: 24,
          horizontalTitleGap: 8,
          minTileHeight: 72,
          selected: _lastScanHitId == line.purchaseItemId,
          selectedTileColor:
              Theme.of(context).colorScheme.primaryContainer.withAlpha(120),
          leading: Checkbox(
            visualDensity: VisualDensity.compact,
            tristate: true,
            value: full ? true : (partial ? null : false),
            onChanged: (_) {
              if (full) {
                _clearCount(line);
              } else {
                _setCount(line, expected);
              }
            },
          ),
          title: ProductTitleText.fromVariantInfo(_variantOf(line),
              fallbackDescription: line.description),
          subtitle: Text(
            counted == null
                ? 'Expected: ${_fmt(expected)} · Ordered: ${_fmt(line.qtyOrdered)}'
                : 'Simulated: ${_fmt(counted)} of ${_fmt(expected)} · Ordered: ${_fmt(line.qtyOrdered)}',
          ),
          trailing: Row(
            mainAxisSize: MainAxisSize.min,
            children: [
              IconButton(
                icon: const Icon(Icons.remove),
                visualDensity: VisualDensity.compact,
                onPressed: () => _setCount(line, ((counted ?? 0) - 1).clamp(0, double.infinity)),
              ),
              SizedBox(
                width: 48,
                child: TextField(
                  controller: _controllerFor(line),
                  textAlign: TextAlign.center,
                  keyboardType: TextInputType.number,
                  inputFormatters: [FilteringTextInputFormatter.digitsOnly],
                  decoration: const InputDecoration(
                    isDense: true,
                    contentPadding: EdgeInsets.symmetric(horizontal: 4, vertical: 8),
                    border: OutlineInputBorder(),
                    hintText: '—',
                  ),
                ),
              ),
              IconButton(
                icon: const Icon(Icons.add),
                visualDensity: VisualDensity.compact,
                onPressed: () => _setCount(line, (counted ?? 0) + 1),
              ),
            ],
          ),
          onTap: () {
            if (full) {
              _clearCount(line);
            } else {
              _setCount(line, expected);
            }
          },
        );
      },
    );
  }

  Widget _buildByProduct(List<ReceivingLine> lines) {
    return ListView.separated(
      itemCount: lines.length,
      separatorBuilder: (_, __) => const Divider(height: 1),
      itemBuilder: (context, i) {
        final line = lines[i];
        final key =
            _byProductKeys.putIfAbsent(line.purchaseItemId, () => GlobalKey());

        final expected = _targetExpected(line);
        final counted = _counted[line.purchaseItemId];
        final over = counted != null && counted > expected;

        return ListTile(
          key: key,
          contentPadding: const EdgeInsets.symmetric(horizontal: 8),
          horizontalTitleGap: 8,
          minTileHeight: 72,
          selected: _lastScanHitId == line.purchaseItemId,
          selectedTileColor:
              Theme.of(context).colorScheme.primaryContainer.withAlpha(120),
          title: ProductTitleText.fromVariantInfo(_variantOf(line),
              fallbackDescription: line.description),
          subtitle: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(
                counted == null
                    ? 'Expected: ${_fmt(expected)} · Not counted'
                    : 'Simulated: ${_fmt(counted)} of ${_fmt(expected)}',
              ),
              const SizedBox(height: 6),
              LinearProgressIndicator(
                value: expected <= 0
                    ? (counted == null || counted == 0 ? 0 : 1)
                    : ((counted ?? 0) / expected).clamp(0.0, 1.0),
                minHeight: 6,
                color: over ? Colors.amber.shade800 : null,
                borderRadius: BorderRadius.circular(3),
              ),
            ],
          ),
          trailing: const Icon(Icons.add),
          onTap: () => _openCounter(line),
        );
      },
    );
  }

  Future<void> _openCounter(ReceivingLine line) async {
    final expected = _targetExpected(line);
    final v = _variantOf(line);
    await Navigator.of(context).push(MaterialPageRoute(
      builder: (_) => CountScreen(
        target: CountTarget(
          title: '${_titleOf(line)} (Simulation)',
          titleWidget: Row(
            children: [
              Expanded(
                child: ProductTitleText.fromVariantInfo(v,
                    fallbackDescription: line.description, fontSize: 18, skuFontSize: 14),
              ),
              const SizedBox(width: 6),
              const Text('(Simulation)', style: TextStyle(fontSize: 14, color: Colors.grey)),
            ],
          ),
          expected: expected,
          initial: _counted[line.purchaseItemId] ?? 0,
          allowOverage: true,
          qtyDecimals: 0,
          onSet: (qty) async {
            _setCount(line, qty);
          },
        ),
      ),
    ));
    if (mounted) setState(() => _syncController(line));
  }
}
