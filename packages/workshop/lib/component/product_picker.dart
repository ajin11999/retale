import 'dart:async';

import 'package:flutter/material.dart';
import 'package:graphql_flutter/graphql_flutter.dart';
import 'package:retale_workshop/services/product_service.dart';
import 'package:retale_workshop/util/money.dart';

/// Show a searchable catalog picker; resolves to the chosen [CatalogVariant],
/// or null if dismissed.
Future<CatalogVariant?> pickCatalogVariant(BuildContext context) {
  return showDialog<CatalogVariant>(
    context: context,
    builder: (_) => const _ProductPickerDialog(),
  );
}

class _ProductPickerDialog extends StatefulWidget {
  const _ProductPickerDialog();

  @override
  State<_ProductPickerDialog> createState() => _ProductPickerDialogState();
}

class _ProductPickerDialogState extends State<_ProductPickerDialog> {
  final _controller = TextEditingController();
  Timer? _debounce;
  Future<List<CatalogVariant>>? _future;

  ProductService get _service => ProductService(GraphQLProvider.of(context).value);

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback((_) => _run(''));
  }

  @override
  void dispose() {
    _debounce?.cancel();
    _controller.dispose();
    super.dispose();
  }

  void _run(String keyword) => setState(() => _future = _service.search(keyword));

  void _onChanged(String text) {
    if (_debounce?.isActive ?? false) _debounce!.cancel();
    _debounce = Timer(const Duration(milliseconds: 300), () => _run(text));
  }

  static const _kindLabel = {
    'service': 'Service',
    'open_price': 'Open price',
    'physical': 'Stock',
    'bundle': 'Bundle',
  };

  @override
  Widget build(BuildContext context) {
    return Dialog(
      child: SizedBox(
        width: 520,
        height: 560,
        child: Column(
          children: [
            Padding(
              padding: const EdgeInsets.all(12),
              child: TextField(
                controller: _controller,
                autofocus: true,
                onChanged: _onChanged,
                decoration: const InputDecoration(
                  prefixIcon: Icon(Icons.search),
                  hintText: 'Search products…',
                  border: OutlineInputBorder(),
                ),
              ),
            ),
            const Divider(height: 1),
            Expanded(
              child: FutureBuilder<List<CatalogVariant>>(
                future: _future,
                builder: (context, snapshot) {
                  if (snapshot.connectionState == ConnectionState.waiting) {
                    return const Center(child: CircularProgressIndicator());
                  }
                  if (snapshot.hasError) {
                    return Center(child: Text('Error: ${snapshot.error}'));
                  }
                  final list = snapshot.data ?? const <CatalogVariant>[];
                  if (list.isEmpty) {
                    return const Center(child: Text('No matches.'));
                  }
                  return ListView.separated(
                    itemCount: list.length,
                    separatorBuilder: (_, __) => const Divider(height: 1),
                    itemBuilder: (context, i) {
                      final v = list[i];
                      return ListTile(
                        dense: true,
                        title: Text(v.name),
                        subtitle: Text(
                            '${v.sku} · ${_kindLabel[v.kind] ?? v.kind}'),
                        trailing: Text(
                          v.priceEditable && v.priceMinor == 0
                              ? '—'
                              : formatMinor(v.priceMinor),
                        ),
                        onTap: () => Navigator.of(context).pop(v),
                      );
                    },
                  );
                },
              ),
            ),
            Align(
              alignment: Alignment.centerRight,
              child: Padding(
                padding: const EdgeInsets.all(8),
                child: TextButton(
                  onPressed: () => Navigator.of(context).pop(),
                  child: const Text('Cancel'),
                ),
              ),
            ),
          ],
        ),
      ),
    );
  }
}
