import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:intl/intl.dart';

import '../../graphql/graphql_service.dart';
import '../../graphql/operations.dart';
import '../../models/models.dart';
import '../../widgets/common.dart';
import '../../widgets/scan_sheet.dart';
import '../count_screen.dart';

/// Count what is physically at one location. Counts stay local in
/// [_counted] (presence = touched) until staff apply them in the review
/// sheet; only touched lines are sent, so partial / spot counts are safe —
/// untouched stock is never adjusted.
class ReconcileScreen extends StatefulWidget {
  const ReconcileScreen({super.key, required this.location});

  final LocationNode location;

  @override
  State<ReconcileScreen> createState() => _ReconcileScreenState();
}

class _ReconcileScreenState extends State<ReconcileScreen> {
  List<StockLevel>? _rows;
  List<StockLevel> _globalVariants = [];
  Object? _loadError;

  /// variantId -> counted qty. Presence means the line was touched.
  final _counted = <String, num>{};

  final _scanField = TextEditingController();
  final _searchField = TextEditingController();
  final _qtyControllers = <String, TextEditingController>{};
  String _search = '';
  String? _lastScanHitId;
  bool _applying = false;

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
    _searchField.dispose();
    for (final c in _qtyControllers.values) {
      c.dispose();
    }
    super.dispose();
  }

  String _fmt(num v) =>
      v == v.truncate() ? v.toInt().toString() : v.toString();

  Future<void> _load() async {
    setState(() {
      _rows = null;
      _loadError = null;
    });
    try {
      final results = await Future.wait([
        GraphQLService.instance.query(Ops.locationStockLevels,
            variables: {'locationId': widget.location.id}),
        GraphQLService.instance.query(Ops.productLabels),
      ]);
      if (!mounted) return;
      
      final localRows = (results[0]['locationStockLevels'] as List<dynamic>)
          .map((r) => StockLevel.fromJson(r as Map<String, dynamic>))
          .toList();
          
      final products = results[1]['products'] as List<dynamic>;
      final globalVariants = <StockLevel>[];
      for (final p in products) {
        final product = p as Map<String, dynamic>;
        for (final v in product['variants'] as List<dynamic>) {
          final variant = v as Map<String, dynamic>;
          globalVariants.add(StockLevel(
            variantId: variant['id'] as String,
            productId: product['id'] as String,
            productName: product['name'] as String,
            sku: variant['sku'] as String? ?? '',
            label: variant['label'] as String?,
            barcode: variant['barcode'] as String?,
            unit: variant['unit'] as String? ?? 'piece',
            qtyDecimals: variant['qtyDecimals'] as int? ?? 0,
            onHand: 0,
          ));
        }
      }
      
      setState(() {
        _rows = localRows;
        _globalVariants = globalVariants;
      });
    } catch (e) {
      if (mounted) setState(() => _loadError = e);
    }
  }

  // ── Local count bookkeeping ──────────────────────────────────────────────

  void _setCount(StockLevel row, num qty) {
    setState(() {
      _counted[row.variantId] = qty;
      if (_rows != null && !_rows!.any((r) => r.variantId == row.variantId)) {
        _rows!.add(row);
      }
      _syncController(row);
    });
  }

  void _clearCount(StockLevel row) {
    setState(() {
      _counted.remove(row.variantId);
      _syncController(row);
    });
  }

  void _syncController(StockLevel row) {
    final c = _qtyControllers[row.variantId];
    if (c == null) return;
    final counted = _counted[row.variantId];
    final text = counted == null ? '' : _fmt(counted);
    if (c.text != text) c.text = text;
  }

  TextEditingController _controllerFor(StockLevel row) =>
      _qtyControllers.putIfAbsent(row.variantId, () {
        final counted = _counted[row.variantId];
        final c =
            TextEditingController(text: counted == null ? '' : _fmt(counted));
        c.addListener(() {
          final text = c.text.trim();
          if (text.isEmpty) {
            if (_counted.containsKey(row.variantId)) {
              setState(() => _counted.remove(row.variantId));
            }
            return;
          }
          final qty = num.tryParse(text);
          if (qty != null && _counted[row.variantId] != qty) {
            _setCount(row, qty);
          }
        });
        return c;
      });

  List<TextInputFormatter> _qtyFormatters(StockLevel row) => [
        if (row.qtyDecimals == 0)
          FilteringTextInputFormatter.digitsOnly
        else
          FilteringTextInputFormatter.allow(
              RegExp('^\\d*\\.?\\d{0,${row.qtyDecimals}}\$')),
      ];

  // ── Scanning (pure client-side over the loaded rows) ─────────────────────

  Future<void> _handleCode(String code) async {
    final trimmed = code.trim();
    if (trimmed.isEmpty) return;
    _scanField.clear();
    final rows = _rows ?? [];
    final lower = trimmed.toLowerCase();
    final matches = rows
        .where((r) =>
            (r.barcode != null && r.barcode!.toLowerCase() == lower) ||
            r.sku.toLowerCase() == lower)
        .toList();
        
    if (matches.isEmpty) {
      final globalMatches = _globalVariants
          .where((r) =>
              (r.barcode != null && r.barcode!.toLowerCase() == lower) ||
              r.sku.toLowerCase() == lower)
          .toList();
          
      if (globalMatches.isNotEmpty) {
        final row = globalMatches.length == 1 ? globalMatches.first : await _pickRow(globalMatches);
        if (row == null || !mounted) return;
        _setCount(row, (_counted[row.variantId] ?? 0) + 1);
        setState(() => _lastScanHitId = row.variantId);
        return;
      }
      
      ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(content: Text('No product matches "$trimmed" anywhere')));
      return;
    }
    
    final row = matches.length == 1 ? matches.first : await _pickRow(matches);
    if (row == null || !mounted) return;
    _setCount(row, (_counted[row.variantId] ?? 0) + 1);
    setState(() => _lastScanHitId = row.variantId);
  }

  Future<StockLevel?> _pickRow(List<StockLevel> matches) {
    return showDialog<StockLevel>(
      context: context,
      builder: (context) => SimpleDialog(
        title: const Text('Several items match — which one?'),
        children: [
          for (final row in matches)
            SimpleDialogOption(
              onPressed: () => Navigator.pop(context, row),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  ProductTitleText.fromStockLevel(row, fontSize: 16, skuFontSize: 13),
                  const SizedBox(height: 4),
                  Text(
                    'system ${_fmt(row.onHand)}',
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

  // ── Review & apply ───────────────────────────────────────────────────────

  Future<void> _openReview() async {
    final rows = _rows;
    if (rows == null || _counted.isEmpty) return;
    final touched =
        rows.where((r) => _counted.containsKey(r.variantId)).toList();
    final reason = TextEditingController(
        text: 'Stockeeper count ${DateFormat('yyyy-MM-dd').format(DateTime.now())}');
    try {
      await showModalBottomSheet<void>(
        context: context,
        isScrollControlled: true,
        builder: (sheetContext) => Padding(
          padding: EdgeInsets.only(
              bottom: MediaQuery.of(sheetContext).viewInsets.bottom),
          child: _ReviewSheet(
            touched: touched,
            counted: _counted,
            reason: reason,
            fmt: _fmt,
            onApply: () => _apply(sheetContext, reason.text.trim()),
          ),
        ),
      );
    } finally {
      reason.dispose();
    }
  }

  Future<void> _apply(BuildContext sheetContext, String reason) async {
    if (reason.isEmpty) {
      ScaffoldMessenger.of(context).showSnackBar(
          const SnackBar(content: Text('A reason is required')));
      return;
    }
    if (_applying) return;
    setState(() => _applying = true);
    try {
      final lines = _counted.entries
          .map((e) => {'variantId': e.key, 'countedQty': e.value})
          .toList();
      final data =
          await GraphQLService.instance.mutate(Ops.bulkAdjustStock, variables: {
        'locationId': widget.location.id,
        'reason': reason,
        'lines': lines,
      });
      if (!mounted) return;
      final n = data['bulkAdjustStock'] as int;
      if (sheetContext.mounted) Navigator.pop(sheetContext);
      ScaffoldMessenger.of(context).showSnackBar(SnackBar(
          content: Text(n == 0
              ? 'All counted lines already matched — nothing adjusted'
              : 'Adjusted $n line${n == 1 ? '' : 's'}')));
      setState(() {
        _counted.clear();
        for (final c in _qtyControllers.values) {
          c.clear();
        }
      });
      await _load();
    } catch (e) {
      if (mounted) {
        ScaffoldMessenger.of(context)
            .showSnackBar(SnackBar(content: Text(describeError(e))));
      }
    } finally {
      if (mounted) setState(() => _applying = false);
    }
  }

  Future<void> _confirmLeave(bool didPop) async {
    if (didPop) return;
    final leave = await showDialog<bool>(
      context: context,
      builder: (context) => AlertDialog(
        title: const Text('Discard this count?'),
        content: Text('${_counted.length} counted '
            'line${_counted.length == 1 ? '' : 's'} have not been applied.'),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(context, false),
            child: const Text('Keep counting'),
          ),
          FilledButton(
            onPressed: () => Navigator.pop(context, true),
            child: const Text('Discard'),
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
            title: Text('Count: ${widget.location.name}'),
            bottom: PreferredSize(
              preferredSize: const Size.fromHeight(164),
              child: Column(
                children: [
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
                  Padding(
                    padding: const EdgeInsets.fromLTRB(16, 0, 16, 8),
                    child: TextField(
                      controller: _searchField,
                      autocorrect: false,
                      decoration: const InputDecoration(
                        prefixIcon: Icon(Icons.search),
                        hintText: 'Filter products',
                        border: OutlineInputBorder(),
                        isDense: true,
                      ),
                      onChanged: (v) => setState(() => _search = v),
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
                onPressed:
                    _counted.isEmpty || _applying ? null : _openReview,
                style: FilledButton.styleFrom(
                  padding: const EdgeInsets.symmetric(vertical: 16),
                  textStyle: const TextStyle(fontSize: 18),
                ),
                child: Text(_counted.isEmpty
                    ? 'Nothing counted yet'
                    : 'Review ${_counted.length} counted '
                        'line${_counted.length == 1 ? '' : 's'}'),
              ),
            ),
          ),
        ),
      ),
    );
  }

  List<StockLevel> _visibleRows() {
    final rows = _rows ?? [];
    final query = _search.trim().toLowerCase();
    if (query.isEmpty) return rows;
    final terms = query.split(RegExp(r'\s+'));
    bool matches(StockLevel r) {
      final name = r.displayName.toLowerCase();
      final barcode = (r.barcode ?? '').toLowerCase();
      return terms.every((term) => name.contains(term) || barcode.contains(term));
    }

    final matchedRows = rows.where(matches).toList();
        
    final existingIds = rows.map((r) => r.variantId).toSet();
    final extraMatches = _globalVariants
        .where((r) => !existingIds.contains(r.variantId) && matches(r))
        .toList();
        
    return [...matchedRows, ...extraMatches];
  }

  Widget _buildBody() {
    if (_loadError != null) {
      return ErrorRetry(message: describeError(_loadError!), onRetry: _load);
    }
    if (_rows == null) {
      return const Center(child: CircularProgressIndicator());
    }
    if (_rows!.isEmpty) {
      return const Center(
          child: Text('No stock has ever been at this location.'));
    }
    final visible = _visibleRows();
    if (visible.isEmpty) {
      return const Center(child: Text('No matching product'));
    }
    return TabBarView(
      children: [
        _buildChecklist(visible),
        _buildByProduct(visible),
      ],
    );
  }

  Widget _buildChecklist(List<StockLevel> rows) {
    return ListView.separated(
      itemCount: rows.length,
      separatorBuilder: (_, __) => const Divider(height: 1),
      itemBuilder: (context, i) {
        final row = rows[i];
        final key =
            _checklistKeys.putIfAbsent(row.variantId, () => GlobalKey());
        final counted = _counted[row.variantId];
        final confirmed = counted != null && counted == row.onHand;
        final partial = counted != null && !confirmed;
        return ListTile(
          key: key,
          contentPadding: const EdgeInsets.symmetric(horizontal: 8),
          minLeadingWidth: 24,
          horizontalTitleGap: 8,
          minTileHeight: 72,
          selected: _lastScanHitId == row.variantId,
          selectedTileColor:
              Theme.of(context).colorScheme.primaryContainer.withAlpha(120),
          leading: Checkbox(
            visualDensity: VisualDensity.compact,
            tristate: true,
            value: confirmed ? true : (partial ? null : false),
            onChanged: (_) =>
                confirmed ? _clearCount(row) : _setCount(row, row.onHand),
          ),
          title: ProductTitleText.fromStockLevel(row),
          subtitle: Text(counted == null
              ? 'system ${_fmt(row.onHand)} · not counted'
              : 'system ${_fmt(row.onHand)} · counted ${_fmt(counted)}'),
          trailing: Row(
            mainAxisSize: MainAxisSize.min,
            children: [
              IconButton(
                icon: const Icon(Icons.remove),
                visualDensity: VisualDensity.compact,
                onPressed: () => _setCount(row, ((counted ?? 0) - 1).clamp(0, double.infinity)),
              ),
              SizedBox(
                width: 48,
                child: TextField(
                  controller: _controllerFor(row),
                  textAlign: TextAlign.center,
                  keyboardType: TextInputType.numberWithOptions(
                      decimal: row.qtyDecimals > 0),
                  inputFormatters: _qtyFormatters(row),
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
                onPressed: () => _setCount(row, (counted ?? 0) + 1),
              ),
            ],
          ),
          onTap: () =>
              confirmed ? _clearCount(row) : _setCount(row, row.onHand),
        );
      },
    );
  }

  Widget _buildByProduct(List<StockLevel> rows) {
    return ListView.separated(
      itemCount: rows.length,
      separatorBuilder: (_, __) => const Divider(height: 1),
      itemBuilder: (context, i) {
        final row = rows[i];
        final key =
            _byProductKeys.putIfAbsent(row.variantId, () => GlobalKey());
        final counted = _counted[row.variantId];
        final over = counted != null && counted > row.onHand;
        return ListTile(
          key: key,
          contentPadding: const EdgeInsets.symmetric(horizontal: 8),
          horizontalTitleGap: 8,
          minTileHeight: 72,
          selected: _lastScanHitId == row.variantId,
          selectedTileColor:
              Theme.of(context).colorScheme.primaryContainer.withAlpha(120),
          title: ProductTitleText.fromStockLevel(row),
          subtitle: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(counted == null
                  ? 'system ${_fmt(row.onHand)} · not counted'
                  : 'counted ${_fmt(counted)} of ${_fmt(row.onHand)}'),
              const SizedBox(height: 6),
              LinearProgressIndicator(
                value: row.onHand <= 0
                    ? (counted == null || counted == 0 ? 0 : 1)
                    : ((counted ?? 0) / row.onHand).clamp(0.0, 1.0),
                minHeight: 6,
                color: over ? Colors.amber.shade800 : null,
                borderRadius: BorderRadius.circular(3),
              ),
            ],
          ),
          trailing: const Icon(Icons.add),
          onTap: () => _openCounter(row),
        );
      },
    );
  }

  Future<void> _openCounter(StockLevel row) async {
    await Navigator.of(context).push(MaterialPageRoute(
      builder: (_) => CountScreen(
        target: CountTarget(
          title: row.displayName,
          titleWidget: ProductTitleText.fromStockLevel(row, fontSize: 18, skuFontSize: 14),
          expected: row.onHand,
          initial: _counted[row.variantId] ?? 0,
          allowOverage: true,
          qtyDecimals: row.qtyDecimals,
          onSet: (qty) async => _setCount(row, qty),
        ),
      ),
    ));
    if (mounted) setState(() => _syncController(row));
  }
}

/// Touched rows with system → counted deltas, the required reason, and Apply.
class _ReviewSheet extends StatelessWidget {
  const _ReviewSheet({
    required this.touched,
    required this.counted,
    required this.reason,
    required this.fmt,
    required this.onApply,
  });

  final List<StockLevel> touched;
  final Map<String, num> counted;
  final TextEditingController reason;
  final String Function(num) fmt;
  final Future<void> Function() onApply;

  @override
  Widget build(BuildContext context) {
    return SafeArea(
      child: Padding(
        padding: const EdgeInsets.fromLTRB(16, 16, 16, 12),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Text('Apply ${touched.length} counted '
                'line${touched.length == 1 ? '' : 's'}',
                style: const TextStyle(
                    fontSize: 20, fontWeight: FontWeight.bold)),
            const SizedBox(height: 12),
            Flexible(
              child: ListView.separated(
                shrinkWrap: true,
                itemCount: touched.length,
                separatorBuilder: (_, __) => const Divider(height: 1),
                itemBuilder: (context, i) {
                  final row = touched[i];
                  final qty = counted[row.variantId]!;
                  final delta = qty - row.onHand;
                  final color = delta == 0
                      ? Theme.of(context).colorScheme.onSurfaceVariant
                      : delta > 0
                          ? Colors.green.shade700
                          : Colors.red.shade700;
                  return ListTile(
                    dense: true,
                    title: ProductTitleText.fromStockLevel(row, fontSize: 14, skuFontSize: 11),
                    subtitle: null,
                    trailing: Text(
                      delta == 0
                          ? '${fmt(qty)} ✓'
                          : '${fmt(row.onHand)} → ${fmt(qty)} '
                              '(${delta > 0 ? '+' : ''}${fmt(delta)})',
                      style: TextStyle(
                          fontSize: 15,
                          fontWeight: FontWeight.w600,
                          color: color),
                    ),
                  );
                },
              ),
            ),
            const SizedBox(height: 12),
            TextField(
              controller: reason,
              decoration: const InputDecoration(
                labelText: 'Reason (required)',
                border: OutlineInputBorder(),
              ),
            ),
            const SizedBox(height: 12),
            FilledButton(
              onPressed: onApply,
              style: FilledButton.styleFrom(
                padding: const EdgeInsets.symmetric(vertical: 16),
                textStyle: const TextStyle(fontSize: 18),
              ),
              child: const Text('Apply adjustments'),
            ),
          ],
        ),
      ),
    );
  }
}
