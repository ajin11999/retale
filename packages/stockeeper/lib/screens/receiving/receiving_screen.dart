import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../../graphql/graphql_service.dart';
import '../../graphql/operations.dart';
import '../../models/models.dart';
import '../../widgets/common.dart';
import '../../widgets/scan_sheet.dart';
import '../count_screen.dart';

/// Count incoming goods against one purchase order. Every change saves
/// straight into the open draft receiving check — the app never commits;
/// freight / cost lines and the commit happen in the web console.
class ReceivingScreen extends StatefulWidget {
  const ReceivingScreen({super.key, required this.purchase, required this.check});

  final PurchaseSummary purchase;
  final ReceivingCheck check;

  @override
  State<ReceivingScreen> createState() => _ReceivingScreenState();
}

class _ReceivingScreenState extends State<ReceivingScreen> {
  List<ReceivingLine>? _lines;
  Map<String, VariantInfo> _labels = const {};
  Object? _loadError;

  final _scanField = TextEditingController();
  final _qtyControllers = <String, TextEditingController>{};
  final _debounce = <String, Timer>{};

  /// purchaseItemIds with a save in flight (spinner replaces the checkbox).
  final _saving = <String>{};

  /// Last scan hit, highlighted so staff see what was counted.
  String? _lastScanHitId;

  /// Per-line tile keys (one set per tab) for Scrollable.ensureVisible.
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
    for (final t in _debounce.values) {
      t.cancel();
    }
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

  /// Refetch only the lines — used to resync after a rejected save.
  Future<void> _refetchLines() async {
    try {
      final data = await GraphQLService.instance.query(Ops.receivingCheckLines,
          variables: {'purchaseId': widget.purchase.id});
      if (!mounted) return;
      final lines = (data['receivingCheckLines'] as List<dynamic>)
          .map((l) => ReceivingLine.fromJson(l as Map<String, dynamic>))
          .toList();
      setState(() {
        _lines = lines;
        for (final line in lines) {
          _syncController(line);
        }
      });
    } catch (_) {
      // The next save or a manual back-out/reopen recovers; don't stack errors.
    }
  }

  TextEditingController _controllerFor(ReceivingLine line) =>
      _qtyControllers.putIfAbsent(line.purchaseItemId, () {
        final c = TextEditingController(text: _fmt(line.qtyInCheck));
        c.addListener(() => _onQtyTyped(line.purchaseItemId, c.text));
        return c;
      });

  void _syncController(ReceivingLine line) {
    final c = _qtyControllers[line.purchaseItemId];
    if (c == null) return;
    final text = _fmt(line.qtyInCheck);
    if (c.text != text) {
      // Setting text fires the listener; the debounce no-ops on equal qty.
      c.text = text;
    }
  }

  void _onQtyTyped(String purchaseItemId, String text) {
    _debounce[purchaseItemId]?.cancel();
    _debounce[purchaseItemId] = Timer(const Duration(milliseconds: 600), () {
      if (!mounted) return;
      final lines = _lines;
      if (lines == null) return;
      final line =
          lines.where((l) => l.purchaseItemId == purchaseItemId).firstOrNull;
      if (line == null) return;
      final qty = num.tryParse(text.trim().isEmpty ? '0' : text.trim());
      if (qty == null || qty == line.qtyInCheck) return;
      _save(line, qty, fromField: true);
    });
  }

  /// Persist an absolute counted qty for a line. Optimistic: the UI updates
  /// immediately; a rejected save snackbars and refetches to resync.
  Future<void> _save(ReceivingLine line, num qty,
      {bool fromField = false}) async {
    if (qty < 0) qty = 0;
    if (qty > line.remaining) {
      ScaffoldMessenger.of(context).showSnackBar(SnackBar(
          content: Text('Only ${_fmt(line.remaining)} left to receive '
              'on ${_titleOf(line)}')));
      if (fromField) _syncController(line);
      return;
    }
    setState(() {
      line.qtyInCheck = qty;
      _saving.add(line.purchaseItemId);
      if (!fromField) _syncController(line);
    });
    try {
      await GraphQLService.instance.mutate(Ops.setReceivingCheckLine,
          variables: {
            'deliveryId': widget.check.id,
            'purchaseItemId': line.purchaseItemId,
            'qty': qty,
          });
    } catch (e) {
      if (!mounted) return;
      ScaffoldMessenger.of(context)
          .showSnackBar(SnackBar(content: Text(describeError(e))));
      await _refetchLines();
    } finally {
      if (mounted) setState(() => _saving.remove(line.purchaseItemId));
    }
  }

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
      await _save(line, line.qtyInCheck + 1);
      if (!mounted) return;
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
                    '${_fmt(line.qtyInCheck)} of ${_fmt(line.remaining)} counted',
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

  // ── UI ───────────────────────────────────────────────────────────────────

  @override
  Widget build(BuildContext context) {
    return DefaultTabController(
      length: 2,
      child: Scaffold(
        appBar: AppBar(
          title: Text(widget.purchase.vendorName),
          bottom: PreferredSize(
            preferredSize: const Size.fromHeight(108),
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
                const TabBar(tabs: [
                  Tab(text: 'Checklist'),
                  Tab(text: 'By product'),
                ]),
              ],
            ),
          ),
        ),
        body: _buildBody(),
        bottomNavigationBar: Material(
          color: Theme.of(context).colorScheme.surfaceContainerHighest,
          child: const SafeArea(
            child: Padding(
              padding: EdgeInsets.symmetric(horizontal: 16, vertical: 10),
              child: Text(
                'Counts save automatically. Review costs and commit in '
                'the console.',
                textAlign: TextAlign.center,
                style: TextStyle(fontSize: 13),
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
        final saving = _saving.contains(line.purchaseItemId);
        final done = line.remaining <= 0;
        final full = !done && line.qtyInCheck >= line.remaining;
        final partial = !done && line.qtyInCheck > 0 && !full;
        return ListTile(
          key: key,
          contentPadding: const EdgeInsets.symmetric(horizontal: 8),
          minLeadingWidth: 24,
          horizontalTitleGap: 8,
          minTileHeight: 72,
          enabled: !done,
          selected: _lastScanHitId == line.purchaseItemId,
          selectedTileColor:
              Theme.of(context).colorScheme.primaryContainer.withAlpha(120),
          leading: saving
              ? const SizedBox(
                  width: 24,
                  height: 24,
                  child: CircularProgressIndicator(strokeWidth: 2.5))
              : Checkbox(
                  visualDensity: VisualDensity.compact,
                  tristate: true,
                  value: done ? true : (partial ? null : full),
                  onChanged: done
                      ? null
                      : (_) => _save(line, full ? 0 : line.remaining),
                ),
          title: ProductTitleText.fromVariantInfo(_variantOf(line),
              fallbackDescription: line.description),
          subtitle: Text(done
              ? 'Already received (ordered ${_fmt(line.qtyOrdered)})'
              : '${_fmt(line.qtyInCheck)} of ${_fmt(line.remaining)} '
                  'to receive · ordered ${_fmt(line.qtyOrdered)}'),
          trailing: done
              ? const Icon(Icons.done_all)
              : Row(
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    IconButton(
                      icon: const Icon(Icons.remove),
                      visualDensity: VisualDensity.compact,
                      onPressed: () => _save(line, line.qtyInCheck - 1),
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
                        ),
                      ),
                    ),
                    IconButton(
                      icon: const Icon(Icons.add),
                      visualDensity: VisualDensity.compact,
                      onPressed: () => _save(line, line.qtyInCheck + 1),
                    ),
                  ],
                ),
          onTap: done ? null : () => _save(line, full ? 0 : line.remaining),
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
        final done = line.remaining <= 0;
        return ListTile(
          key: key,
          contentPadding: const EdgeInsets.symmetric(horizontal: 8),
          horizontalTitleGap: 8,
          minTileHeight: 72,
          enabled: !done,
          selected: _lastScanHitId == line.purchaseItemId,
          selectedTileColor:
              Theme.of(context).colorScheme.primaryContainer.withAlpha(120),
          title: ProductTitleText.fromVariantInfo(_variantOf(line),
              fallbackDescription: line.description),
          subtitle: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(done
                  ? 'Already received (ordered ${_fmt(line.qtyOrdered)})'
                  : '${_fmt(line.qtyInCheck)} of ${_fmt(line.remaining)} '
                      'counted'),
              const SizedBox(height: 6),
              LinearProgressIndicator(
                value: line.remaining <= 0
                    ? 1
                    : (line.qtyInCheck / line.remaining).clamp(0.0, 1.0),
                minHeight: 6,
                borderRadius: BorderRadius.circular(3),
              ),
            ],
          ),
          trailing: done ? const Icon(Icons.done_all) : const Icon(Icons.add),
          onTap: done ? null : () => _openCounter(line),
        );
      },
    );
  }

  Future<void> _openCounter(ReceivingLine line) async {
    final v = _variantOf(line);
    await Navigator.of(context).push(MaterialPageRoute(
      builder: (_) => CountScreen(
        target: CountTarget(
          title: _titleOf(line),
          titleWidget: ProductTitleText.fromVariantInfo(v,
              fallbackDescription: line.description, fontSize: 18, skuFontSize: 14),
          expected: line.remaining,
          initial: line.qtyInCheck,
          allowOverage: false,
          qtyDecimals: 0,
          onSet: (qty) async {
            await GraphQLService.instance.mutate(
              Ops.setReceivingCheckLine,
              variables: {
                'deliveryId': widget.check.id,
                'purchaseItemId': line.purchaseItemId,
                'qty': qty,
              },
            );
            line.qtyInCheck = qty;
          },
        ),
      ),
    ));
    // Reflect counts made on the count screen.
    if (mounted) setState(() => _syncController(line));
  }
}
