import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:retale_workshop/schema/project.dart';
import 'package:retale_workshop/services/product_service.dart';
import 'package:retale_workshop/util/money.dart';

/// Capture qty / price / note for a leaf line. Pass [variant] for a new line or
/// [existing] to edit one (its variant + kind are fixed). Returns the new/edited
/// [WorkLine], or null if cancelled.
Future<WorkLine?> showLeafEditor(
  BuildContext context, {
  CatalogVariant? variant,
  WorkLine? existing,
}) {
  assert(variant != null || existing != null);
  return showDialog<WorkLine>(
    context: context,
    builder: (_) => _LeafEditor(variant: variant, existing: existing),
  );
}

class _LeafEditor extends StatefulWidget {
  const _LeafEditor({this.variant, this.existing});
  final CatalogVariant? variant;
  final WorkLine? existing;

  @override
  State<_LeafEditor> createState() => _LeafEditorState();
}

class _LeafEditorState extends State<_LeafEditor> {
  late final TextEditingController _qty;
  late final TextEditingController _price;
  late final TextEditingController _note;

  late final String _variantId;
  late final String _kind;
  late final String _name;
  late final bool _priceEditable;

  @override
  void initState() {
    super.initState();
    final e = widget.existing;
    final v = widget.variant;
    _variantId = e?.variantId ?? v!.variantId;
    _kind = e?.variantKind ?? v!.kind;
    _name = e?.snapshotName ?? v!.name;
    _priceEditable = _kind == 'service' || _kind == 'open_price';

    final initialPrice = e?.unitPriceMinor ?? v!.priceMinor;
    _qty = TextEditingController(text: '${e?.qty ?? 1}');
    _price = TextEditingController(
        text: initialPrice == 0 ? '' : '$initialPrice');
    _note = TextEditingController(text: e?.note ?? '');
  }

  @override
  void dispose() {
    _qty.dispose();
    _price.dispose();
    _note.dispose();
    super.dispose();
  }

  void _save() {
    final qty = int.tryParse(_qty.text.trim()) ?? 0;
    if (qty <= 0) return;
    final price = _priceEditable
        ? (parseMinor(_price.text) ?? 0)
        : (widget.existing?.unitPriceMinor ?? widget.variant!.priceMinor);

    final line = widget.existing ?? WorkLine()
      ..variantId = _variantId
      ..variantKind = _kind
      ..snapshotName = _name;
    line
      ..qty = qty
      ..unitPriceMinor = price
      ..note = _note.text.trim();

    Navigator.of(context).pop(line);
  }

  @override
  Widget build(BuildContext context) {
    return AlertDialog(
      title: Text(_name, style: Theme.of(context).textTheme.titleMedium),
      content: SizedBox(
        width: 360,
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Row(
              children: [
                Expanded(
                  child: TextField(
                    controller: _qty,
                    keyboardType: TextInputType.number,
                    inputFormatters: [FilteringTextInputFormatter.digitsOnly],
                    decoration: const InputDecoration(
                        labelText: 'Qty', border: OutlineInputBorder()),
                  ),
                ),
                const SizedBox(width: 12),
                Expanded(
                  child: TextField(
                    controller: _price,
                    enabled: _priceEditable,
                    keyboardType: TextInputType.number,
                    inputFormatters: [FilteringTextInputFormatter.digitsOnly],
                    decoration: InputDecoration(
                      labelText: _priceEditable ? 'Price' : 'Catalog price',
                      prefixText: 'Rp ',
                      border: const OutlineInputBorder(),
                    ),
                  ),
                ),
              ],
            ),
            if (!_priceEditable)
              const Padding(
                padding: EdgeInsets.only(top: 8),
                child: Align(
                  alignment: Alignment.centerLeft,
                  child: Text(
                    'Stock items use the catalog price.',
                    style: TextStyle(fontSize: 12, color: Colors.grey),
                  ),
                ),
              ),
            const SizedBox(height: 12),
            TextField(
              controller: _note,
              decoration: const InputDecoration(
                labelText: 'Note (stays local)',
                border: OutlineInputBorder(),
              ),
            ),
          ],
        ),
      ),
      actions: [
        TextButton(
          onPressed: () => Navigator.of(context).pop(),
          child: const Text('Cancel'),
        ),
        FilledButton(onPressed: _save, child: const Text('Save')),
      ],
    );
  }
}

/// Capture a section (group) label. Returns the label, or null if cancelled.
Future<String?> showGroupEditor(BuildContext context, {String initial = ''}) {
  final controller = TextEditingController(text: initial);
  return showDialog<String>(
    context: context,
    builder: (context) => AlertDialog(
      title: const Text('Section'),
      content: TextField(
        controller: controller,
        autofocus: true,
        decoration: const InputDecoration(
            labelText: 'Section name', border: OutlineInputBorder()),
        onSubmitted: (v) => Navigator.of(context).pop(v.trim()),
      ),
      actions: [
        TextButton(
          onPressed: () => Navigator.of(context).pop(),
          child: const Text('Cancel'),
        ),
        FilledButton(
          onPressed: () => Navigator.of(context).pop(controller.text.trim()),
          child: const Text('Save'),
        ),
      ],
    ),
  );
}
