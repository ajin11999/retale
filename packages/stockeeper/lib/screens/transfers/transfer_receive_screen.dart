import 'dart:async';

import 'package:flutter/material.dart';

import '../../graphql/graphql_service.dart';
import '../../graphql/operations.dart';
import '../../models/models.dart';
import '../../widgets/common.dart';
import '../../widgets/scan_sheet.dart';

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
    super.dispose();
  }

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

  void _handleCode(String code) {
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
    
    setState(() {
      _counts[item.variantId] = (_counts[item.variantId] ?? 0) + 1;
    });
  }

  Future<void> _openCamera() async {
    final code = await showScanSheet(context);
    if (code != null && mounted) _handleCode(code);
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
    if (_loadError != null) {
      return Scaffold(
        appBar: AppBar(title: const Text('Receive Transfer')),
        body: ErrorRetry(message: describeError(_loadError!), onRetry: _load),
      );
    }

    return Scaffold(
      appBar: AppBar(title: const Text('Receive Transfer')),
      body: Column(
        children: [
          Padding(
            padding: const EdgeInsets.all(16.0),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                Text(
                  '${widget.sourceLocation} → ${widget.targetLocation}',
                  style: const TextStyle(fontSize: 18, fontWeight: FontWeight.bold),
                ),
                const SizedBox(height: 16),
                Row(
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
                const SizedBox(height: 16),
                ElevatedButton(
                  onPressed: (_isComplete && !_saving) ? _receive : null,
                  style: ElevatedButton.styleFrom(
                    padding: const EdgeInsets.symmetric(vertical: 12),
                  ),
                  child: _saving 
                    ? const SizedBox(width: 20, height: 20, child: CircularProgressIndicator(strokeWidth: 2))
                    : const Text('Receive Transfer', style: TextStyle(fontSize: 16)),
                ),
              ],
            ),
          ),
          const Divider(height: 1),
          Expanded(
            child: ListView.separated(
              itemCount: widget.transfer.items.length,
              separatorBuilder: (_, __) => const Divider(height: 1),
              itemBuilder: (context, i) {
                final item = widget.transfer.items[i];
                final counted = _counts[item.variantId] ?? 0;
                final done = counted >= item.qty;
                return ListTile(
                  tileColor: done ? Colors.green.shade50 : null,
                  leading: IconButton(
                    icon: Icon(Icons.remove_circle_outline, color: counted > 0 ? Colors.red : Colors.grey),
                    onPressed: counted > 0 ? () => setState(() => _counts[item.variantId] = counted - 1) : null,
                  ),
                  title: Text(_labels[item.variantId]?.displayName ?? item.variantId, style: const TextStyle(fontSize: 15)),
                  subtitle: Text('$counted / ${item.qty} counted'),
                  trailing: IconButton(
                    icon: Icon(Icons.add_circle, color: done ? Colors.grey : Colors.green),
                    onPressed: done ? null : () => setState(() => _counts[item.variantId] = counted + 1),
                  ),
                );
              },
            ),
          ),
        ],
      ),
    );
  }
}
