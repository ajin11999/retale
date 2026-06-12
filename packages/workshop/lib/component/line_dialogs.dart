import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:retale_workshop/component/margin_pill.dart';
import 'package:retale_workshop/schema/project.dart';
import 'package:retale_workshop/util/money.dart';
import 'package:retale_workshop/util/project_calc.dart';

/// Edit qty / price / note of an [existing] leaf line (its variant + kind are
/// fixed). Returns the edited [WorkLine], or null if cancelled. Adding a new
/// line goes through the inline form instead (see inline_line_forms.dart).
Future<WorkLine?> showLeafEditor(
  BuildContext context, {
  required WorkLine existing,
}) {
  return showDialog<WorkLine>(
    context: context,
    builder: (_) => _LeafEditor(existing: existing),
  );
}

class _LeafEditor extends StatefulWidget {
  const _LeafEditor({required this.existing});
  final WorkLine existing;

  @override
  State<_LeafEditor> createState() => _LeafEditorState();
}

class _LeafEditorState extends State<_LeafEditor> {
  late final TextEditingController _qty;
  late final TextEditingController _price;
  late final TextEditingController _note;
  late final bool _priceEditable;

  @override
  void initState() {
    super.initState();
    final e = widget.existing;
    // The clerk may reprice any line; only bundles are locked (the API
    // rejects price overrides on bundles).
    _priceEditable = e.variantKind != 'bundle';
    _qty = TextEditingController(text: '${e.qty}');
    _price = TextEditingController(
        text: e.unitPriceMinor == 0 ? '' : groupMinor(e.unitPriceMinor));
    _note = TextEditingController(text: e.note);
    // The margin pill in the price field previews live as the price is typed.
    _price.addListener(() => setState(() {}));
  }

  /// Live margin preview at the currently typed price, from the line's cost
  /// snapshot. Null (no pill) when the cost is unknown or there is no price.
  double? get _previewMarginFraction {
    final price = parseMinor(_price.text) ?? 0;
    if (price <= 0) return null;
    final cost = widget.existing.unitCostAt(price);
    if (cost == null) return null;
    return (price - cost) / price;
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
        : widget.existing.unitPriceMinor;

    final line = widget.existing
      ..qty = qty
      ..unitPriceMinor = price
      ..note = _note.text.trim();

    Navigator.of(context).pop(line);
  }

  @override
  Widget build(BuildContext context) {
    return AlertDialog(
      title: Text(widget.existing.snapshotName,
          style: Theme.of(context).textTheme.titleMedium),
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
                    inputFormatters: const [ThousandsInputFormatter()],
                    decoration: InputDecoration(
                      labelText: _priceEditable ? 'Price' : 'Bundle price',
                      prefixText: 'Rp ',
                      // Live margin preview from the line's cost snapshot.
                      suffixIcon: Center(
                        widthFactor: 1,
                        child: Padding(
                          padding: const EdgeInsets.only(right: 6),
                          child:
                              MarginPill(fraction: _previewMarginFraction),
                        ),
                      ),
                      suffixIconConstraints:
                          const BoxConstraints(minWidth: 0, minHeight: 0),
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
                    'Bundles use the catalog price.',
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
