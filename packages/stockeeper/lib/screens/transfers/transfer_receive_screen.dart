import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../../graphql/graphql_service.dart';
import '../../graphql/operations.dart';
import '../../models/models.dart';
import '../../widgets/common.dart';
import '../../widgets/scan_sheet.dart';
import '../count_screen.dart';

class TransferReceiveScreen extends StatefulWidget {
  const TransferReceiveScreen({
    super.key,
    required this.transfer,
    required this.sourceLocation,
    required this.targetLocation,
  });

  final TransferSummary transfer;
  final String sourceLocation;
  final String targetLocation;

  @override
  State<TransferReceiveScreen> createState() => _TransferReceiveScreenState();
}

class _TransferReceiveScreenState extends State<TransferReceiveScreen> {
  final Map<String, num> _counts = {};
  Map<String, VariantInfo> _labels = const {};
  Map<String, String> _codeToVariantId = const {};
  Object? _loadError;
  bool _saving = false;

  final _scanField = TextEditingController();
  final _qtyControllers = <String, TextEditingController>{};
  
  String? _lastScanHitId;
  final _checklistKeys = <String, GlobalKey>{};
  final _byProductKeys = <String, GlobalKey>{};

  @override
  void initState() {
    super.initState();
    for (final item in widget.transfer.items) {
      _counts[item.variantId] = 0;
    }
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

  Future<void> _load() async {
    setState(() => _loadError = null);
    try {
      final results = await GraphQLService.instance.query(Ops.productLabels);
      if (!mounted) return;
      final products = results['products'] as List<dynamic>;
      final labels = buildVariantLabelMap(products);
      
      final codeToVariantId = <String, String>{};
      for (final p in products) {
        for (final v in p['variants'] as List<dynamic>) {
          final variantId = v['id'] as String;
          final sku = v['sku'] as String?;
          if (sku != null && sku.isNotEmpty) {
            codeToVariantId[sku.toLowerCase()] = variantId;
          }
        }
      }
      
      setState(() {
        _labels = labels;
        _codeToVariantId = codeToVariantId;
      });
    } catch (e) {
      if (mounted) setState(() => _loadError = e);
    }
  }

  void _setCount(TransferItem item, num qty) {
    if (qty < 0) qty = 0;
    if (qty > item.qty) {
      ScaffoldMessenger.of(context).showSnackBar(SnackBar(
          content: Text('Only ${_fmt(item.qty)} expected '
              'for ${_labels[item.variantId]?.displayName ?? item.variantId}')));
    }
    setState(() {
      _counts[item.variantId] = qty.clamp(0, item.qty);
      _syncController(item);
    });
  }

  void _syncController(TransferItem item) {
    final c = _qtyControllers[item.variantId];
    if (c == null) return;
    final counted = _counts[item.variantId] ?? 0;
    final text = counted == 0 ? '' : _fmt(counted);
    if (c.text != text) c.text = text;
  }

  TextEditingController _controllerFor(TransferItem item) =>
      _qtyControllers.putIfAbsent(item.variantId, () {
        final counted = _counts[item.variantId] ?? 0;
        final c = TextEditingController(text: counted == 0 ? '' : _fmt(counted));
        c.addListener(() {
          final text = c.text.trim();
          if (text.isEmpty) {
            if ((_counts[item.variantId] ?? 0) != 0) {
              setState(() => _counts[item.variantId] = 0);
            }
            return;
          }
          final qty = num.tryParse(text);
          if (qty != null && _counts[item.variantId] != qty) {
            _setCount(item, qty);
          }
        });
        return c;
      });

  Future<void> _handleCode(String code) async {
    final trimmed = code.trim().toLowerCase();
    if (trimmed.isEmpty) return;
    _scanField.clear();

    final variantId = _codeToVariantId[trimmed] ?? trimmed;
    
    final items = widget.transfer.items.where((i) => i.variantId == variantId).toList();
    if (items.isEmpty) {
      ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(content: Text('Item "$code" is not in this transfer')));
      return;
    }
    
    final item = items.first;
    if ((_counts[item.variantId] ?? 0) >= item.qty) {
      ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(content: Text('Already counted all required ${item.qty} for this item')));
      return;
    }
    
    _setCount(item, (_counts[item.variantId] ?? 0) + 1);
    setState(() => _lastScanHitId = item.variantId);
  }

  Future<void> _openCamera() async {
    final code = await showScanSheet(context);
    if (code != null && mounted) await _handleCode(code);
  }

  Future<void> _receive() async {
    if (_saving) return;
    setState(() => _saving = true);
    try {
      await GraphQLService.instance.mutate(Ops.receiveStockTransfer,
          variables: {'id': widget.transfer.id});
      if (!mounted) return;
      ScaffoldMessenger.of(context).showSnackBar(
          const SnackBar(content: Text('Transfer received successfully!')));
      Navigator.of(context).pop();
    } catch (e) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
            SnackBar(content: Text(describeError(e))));
      }
    } finally {
      if (mounted) setState(() => _saving = false);
    }
  }

  bool get _isComplete {
    for (final item in widget.transfer.items) {
      if ((_counts[item.variantId] ?? 0) < item.qty) return false;
    }
    return true;
  }

  @override
  Widget build(BuildContext context) {
    return DefaultTabController(
      length: 2,
      child: Scaffold(
        appBar: AppBar(
          title: const Text('Receive Transfer'),
          bottom: PreferredSize(
            preferredSize: const Size.fromHeight(132),
            child: Column(
              children: [
                Padding(
                  padding: const EdgeInsets.symmetric(horizontal: 16.0),
                  child: Text(
                    '${widget.sourceLocation} → ${widget.targetLocation}',
                    style: const TextStyle(fontSize: 15, fontWeight: FontWeight.w500),
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
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
              onPressed: (_isComplete && !_saving) ? _receive : null,
              style: FilledButton.styleFrom(
                padding: const EdgeInsets.symmetric(vertical: 16),
                textStyle: const TextStyle(fontSize: 18),
              ),
              child: _saving 
                ? const SizedBox(width: 20, height: 20, child: CircularProgressIndicator(strokeWidth: 2, color: Colors.white))
                : const Text('Receive Transfer'),
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
    if (widget.transfer.items.isEmpty) {
      return const Center(child: Text('This transfer has no items.'));
    }
    return TabBarView(
      children: [
        _buildChecklist(),
        _buildByProduct(),
      ],
    );
  }

  Widget _buildChecklist() {
    return ListView.separated(
      itemCount: widget.transfer.items.length,
      separatorBuilder: (_, __) => const Divider(height: 1),
      itemBuilder: (context, i) {
        final item = widget.transfer.items[i];
        final key = _checklistKeys.putIfAbsent(item.variantId, () => GlobalKey());
        final counted = _counts[item.variantId] ?? 0;
        final done = counted >= item.qty;
        final partial = !done && counted > 0;
        final vInfo = _labels[item.variantId];
        
        return ListTile(
          key: key,
          contentPadding: const EdgeInsets.symmetric(horizontal: 8),
          minLeadingWidth: 24,
          horizontalTitleGap: 8,
          minTileHeight: 72,
          enabled: !done,
          selected: _lastScanHitId == item.variantId,
          selectedTileColor:
              Theme.of(context).colorScheme.primaryContainer.withAlpha(120),
          leading: Checkbox(
            visualDensity: VisualDensity.compact,
            tristate: true,
            value: done ? true : (partial ? null : false),
            onChanged: done ? null : (_) => _setCount(item, done ? 0 : item.qty),
          ),
          title: Text(vInfo?.displayName ?? item.variantId, style: const TextStyle(fontSize: 15)),
          subtitle: Text(done
              ? 'Already received (${_fmt(item.qty)})'
              : '${_fmt(counted)} of ${_fmt(item.qty)} to receive'),
          trailing: done
              ? const Icon(Icons.done_all)
              : Row(
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    IconButton(
                      icon: const Icon(Icons.remove),
                      visualDensity: VisualDensity.compact,
                      onPressed: () => _setCount(item, (counted) - 1),
                    ),
                    SizedBox(
                      width: 48,
                      child: TextField(
                        controller: _controllerFor(item),
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
                      onPressed: () => _setCount(item, (counted) + 1),
                    ),
                  ],
                ),
          onTap: done ? null : () => _setCount(item, done ? 0 : item.qty),
        );
      },
    );
  }

  Widget _buildByProduct() {
    return ListView.separated(
      itemCount: widget.transfer.items.length,
      separatorBuilder: (_, __) => const Divider(height: 1),
      itemBuilder: (context, i) {
        final item = widget.transfer.items[i];
        final key = _byProductKeys.putIfAbsent(item.variantId, () => GlobalKey());
        final counted = _counts[item.variantId] ?? 0;
        final done = counted >= item.qty;
        final vInfo = _labels[item.variantId];
        
        return ListTile(
          key: key,
          contentPadding: const EdgeInsets.symmetric(horizontal: 8),
          horizontalTitleGap: 8,
          minTileHeight: 72,
          enabled: !done,
          selected: _lastScanHitId == item.variantId,
          selectedTileColor:
              Theme.of(context).colorScheme.primaryContainer.withAlpha(120),
          title: Text(vInfo?.displayName ?? item.variantId, style: const TextStyle(fontSize: 15)),
          subtitle: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(done
                  ? 'Already received (${_fmt(item.qty)})'
                  : '${_fmt(counted)} of ${_fmt(item.qty)} counted'),
              const SizedBox(height: 6),
              LinearProgressIndicator(
                value: item.qty <= 0
                    ? 1
                    : (counted / item.qty).clamp(0.0, 1.0),
                minHeight: 6,
                borderRadius: BorderRadius.circular(3),
              ),
            ],
          ),
          trailing: done ? const Icon(Icons.done_all) : const Icon(Icons.add),
          onTap: done ? null : () => _openCounter(item, vInfo),
        );
      },
    );
  }

  Future<void> _openCounter(TransferItem item, VariantInfo? vInfo) async {
    await Navigator.of(context).push(MaterialPageRoute(
      builder: (_) => CountScreen(
        target: CountTarget(
          title: vInfo?.displayName ?? item.variantId,
          expected: item.qty,
          initial: _counts[item.variantId] ?? 0,
          allowOverage: false,
          qtyDecimals: 0,
          onSet: (qty) async => _setCount(item, qty),
        ),
      ),
    ));
    if (mounted) setState(() => _syncController(item));
  }
}
