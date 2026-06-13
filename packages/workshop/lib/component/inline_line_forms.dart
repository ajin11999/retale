import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:graphql_flutter/graphql_flutter.dart';
import 'package:retale_workshop/component/margin_pill.dart';
import 'package:retale_workshop/schema/project.dart';
import 'package:retale_workshop/services/product_service.dart';
import 'package:retale_workshop/util/money.dart';

/// Shared frame so both inline forms read as one editing surface in the card.
///
/// Esc anywhere inside cancels the form. This is wired as a [DismissIntent]
/// action (MaterialApp maps Esc to it) rather than a raw key handler so it
/// composes with RawAutocomplete: while the options overlay is showing, the
/// autocomplete consumes the intent to close it, and forwards it here only
/// when nothing is open — first Esc dismisses the dropdown, second cancels.
class _InlineFormFrame extends StatelessWidget {
  const _InlineFormFrame({required this.onDismiss, required this.child});
  final VoidCallback onDismiss;
  final Widget child;

  @override
  Widget build(BuildContext context) {
    return Actions(
      actions: <Type, Action<Intent>>{
        DismissIntent: CallbackAction<DismissIntent>(onInvoke: (_) {
          onDismiss();
          return null;
        }),
      },
      child: Container(
        margin: const EdgeInsets.symmetric(vertical: 4),
        padding: const EdgeInsets.all(8),
        decoration: BoxDecoration(
          border: Border.all(color: Theme.of(context).dividerColor),
          borderRadius: BorderRadius.circular(8),
        ),
        child: child,
      ),
    );
  }
}

/// Inline add-line form: one row — a product combobox (catalog search with a
/// floating result overlay), qty, price, note, submit — with a live cost/margin
/// readout under it once a variant is picked. The price is the clerk's to set on
/// any kind except bundles (the API rejects overrides there) and is sent as
/// `priceOverrideMinor` on submit.
class InlineLeafForm extends StatefulWidget {
  const InlineLeafForm({
    super.key,
    required this.onSubmit,
    required this.onCancel,
  });

  final ValueChanged<WorkLine> onSubmit;
  final VoidCallback onCancel;

  @override
  State<InlineLeafForm> createState() => _InlineLeafFormState();
}

class _InlineLeafFormState extends State<InlineLeafForm> {
  final _search = TextEditingController();
  final _searchFocus = FocusNode();
  final _qtyFocus = FocusNode();
  final _qty = TextEditingController(text: '1');
  final _price = TextEditingController();
  final _note = TextEditingController();
  Timer? _debounce;
  CatalogVariant? _variant;

  /// Width of the combobox field, captured at build time so the floating
  /// options overlay can match it.
  double _fieldWidth = 0;

  ProductService get _service =>
      ProductService(GraphQLProvider.of(context).value);

  static const _kindLabel = {
    'service': 'Service',
    'open_price': 'Open price',
    'physical': 'Stock',
    'bundle': 'Bundle',
  };

  @override
  void initState() {
    super.initState();
    // The margin pill in the price field previews live as the price is typed.
    _price.addListener(() => setState(() {}));
  }

  /// Live margin preview for the picked variant at the currently typed price,
  /// as a fraction of price. Null (no pill) until both exist.
  double? get _previewMarginFraction {
    final v = _variant;
    if (v == null) return null;
    final price = parseMinor(_price.text) ?? 0;
    if (price <= 0) return null;
    return (price - v.costForPrice(price)) / price;
  }

  @override
  void dispose() {
    _debounce?.cancel();
    _search.dispose();
    _searchFocus.dispose();
    _qtyFocus.dispose();
    _qty.dispose();
    _price.dispose();
    _note.dispose();
    super.dispose();
  }

  /// Debounced catalog search for the combobox. Each keystroke cancels the
  /// previous timer, so superseded futures simply never complete and only the
  /// latest query ever delivers options.
  Future<Iterable<CatalogVariant>> _debouncedSearch(String text) {
    _debounce?.cancel();
    final completer = Completer<Iterable<CatalogVariant>>();
    _debounce = Timer(const Duration(milliseconds: 300), () async {
      if (!mounted) {
        completer.complete(const <CatalogVariant>[]);
        return;
      }
      try {
        completer.complete(await _service.search(text));
      } catch (e) {
        completer.complete(const <CatalogVariant>[]);
        // Surface the failure — a silent empty dropdown reads as "no results"
        // and hides real problems (auth expiry, server down, bad query).
        if (mounted) {
          ScaffoldMessenger.of(context)
            ..hideCurrentSnackBar()
            ..showSnackBar(SnackBar(content: Text('Product search failed: $e')));
        }
      }
    });
    return completer.future;
  }

  void _select(CatalogVariant v) {
    setState(() {
      _variant = v;
      _price.text = v.priceMinor == 0 ? '' : groupMinor(v.priceMinor);
    });
    // Keyboard flow: pick → qty → price/note → Enter submits.
    _qtyFocus.requestFocus();
  }

  void _submit() {
    final v = _variant;
    if (v == null) return;
    final qty = int.tryParse(_qty.text.trim()) ?? 0;
    if (qty <= 0) return;
    final price = v.kind == 'bundle'
        ? v.priceMinor
        : (parseMinor(_price.text) ?? v.priceMinor);
    widget.onSubmit(WorkLine()
      ..variantId = v.variantId
      ..variantKind = v.kind
      ..snapshotName = v.name
      ..qty = qty
      ..unitPriceMinor = price
      ..unitCostMinor = v.costMinor
      ..costRatioBps = v.costRatioBps
      ..note = _note.text.trim());
  }

  @override
  Widget build(BuildContext context) {
    final isBundle = _variant?.kind == 'bundle';
    return _InlineFormFrame(
      onDismiss: widget.onCancel,
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        mainAxisSize: MainAxisSize.min,
        children: [
          Row(
            children: [
              Expanded(flex: 3, child: _productCombobox()),
              const SizedBox(width: 8),
              SizedBox(
                width: 70,
                child: TextField(
                  controller: _qty,
                  focusNode: _qtyFocus,
                  keyboardType: TextInputType.number,
                  inputFormatters: [FilteringTextInputFormatter.digitsOnly],
                  onSubmitted: (_) => _submit(),
                  decoration: const InputDecoration(
                      isDense: true,
                      labelText: 'Qty',
                      border: OutlineInputBorder()),
                ),
              ),
              const SizedBox(width: 8),
              Expanded(
                flex: 2,
                child: TextField(
                  controller: _price,
                  enabled: _variant != null && !isBundle,
                  keyboardType: TextInputType.number,
                  inputFormatters: const [ThousandsInputFormatter()],
                  onSubmitted: (_) => _submit(),
                  decoration: InputDecoration(
                    isDense: true,
                    labelText: isBundle ? 'Bundle price' : 'Price',
                    prefixText: 'Rp ',
                    // Live margin preview against the picked variant's cost.
                    suffixIcon: Center(
                      widthFactor: 1,
                      child: Padding(
                        padding: const EdgeInsets.only(right: 6),
                        child: MarginPill(fraction: _previewMarginFraction),
                      ),
                    ),
                    suffixIconConstraints:
                        const BoxConstraints(minWidth: 0, minHeight: 0),
                    border: const OutlineInputBorder(),
                  ),
                ),
              ),
              const SizedBox(width: 8),
              Expanded(
                flex: 2,
                child: TextField(
                  controller: _note,
                  onSubmitted: (_) => _submit(),
                  decoration: const InputDecoration(
                    isDense: true,
                    labelText: 'Note (stays local)',
                    border: OutlineInputBorder(),
                  ),
                ),
              ),
              const SizedBox(width: 8),
              TextButton(
                  onPressed: widget.onCancel, child: const Text('Cancel')),
              const SizedBox(width: 4),
              FilledButton(
                onPressed: _variant == null ? null : _submit,
                child: const Text('Add'),
              ),
            ],
          ),
          // Cost/margin readout under the row once a variant is picked, so the
          // price can be tuned to a target margin (the pill shows the percent).
          if (_variant != null) _costPreview(),
        ],
      ),
    );
  }

  Widget _costPreview() {
    final price = parseMinor(_price.text) ?? 0;
    return Padding(
      padding: const EdgeInsets.only(top: 6, left: 2),
      child: CostMarginLine(
        costMinor: _variant!.costForPrice(price),
        priceMinor: price,
      ),
    );
  }

  Widget _productCombobox() {
    return LayoutBuilder(builder: (context, constraints) {
      _fieldWidth = constraints.maxWidth;
      return RawAutocomplete<CatalogVariant>(
        textEditingController: _search,
        focusNode: _searchFocus,
        displayStringForOption: (v) => v.name,
        optionsBuilder: (tv) => _debouncedSearch(tv.text),
        onSelected: _select,
        fieldViewBuilder: (context, controller, focusNode, onFieldSubmitted) {
          return TextField(
            controller: controller,
            focusNode: focusNode,
            autofocus: true,
            // Programmatic text changes (option selected) don't fire onChanged,
            // so this only clears the pick when the clerk types again.
            onChanged: (_) {
              if (_variant != null) setState(() => _variant = null);
            },
            // Enter picks the highlighted option (↑/↓ move the highlight; it
            // starts on the first row, so a single result is picked outright).
            onSubmitted: (_) => onFieldSubmitted(),
            decoration: const InputDecoration(
              isDense: true,
              prefixIcon: Icon(Icons.search),
              hintText: 'Search products…',
              border: OutlineInputBorder(),
            ),
          );
        },
        optionsViewBuilder: (context, onSelected, options) {
          final list = options.toList();
          final highlighted = AutocompleteHighlightedOption.of(context);
          return Align(
            alignment: Alignment.topLeft,
            child: Material(
              elevation: 4,
              borderRadius: BorderRadius.circular(4),
              child: ConstrainedBox(
                constraints:
                    BoxConstraints(maxHeight: 280, maxWidth: _fieldWidth),
                child: ListView.separated(
                  padding: EdgeInsets.zero,
                  shrinkWrap: true,
                  itemCount: list.length,
                  separatorBuilder: (_, __) => const Divider(height: 1),
                  itemBuilder: (context, i) {
                    final v = list[i];
                    final isHighlighted = i == highlighted;
                    return Builder(builder: (context) {
                      if (isHighlighted) {
                        // Keep the keyboard highlight in view while arrowing.
                        WidgetsBinding.instance.addPostFrameCallback((_) {
                          if (context.mounted) {
                            Scrollable.ensureVisible(context, alignment: 0.5);
                          }
                        });
                      }
                      return ListTile(
                        dense: true,
                        selected: isHighlighted,
                        selectedTileColor: Theme.of(context)
                            .colorScheme
                            .primary
                            .withValues(alpha: 0.08),
                        title: Text(v.name),
                        subtitle:
                            Text('${v.sku} · ${_kindLabel[v.kind] ?? v.kind}'),
                        trailing: Text(
                          v.priceEditable && v.priceMinor == 0
                              ? '—'
                              : formatMinor(v.priceMinor),
                        ),
                        onTap: () => onSelected(v),
                      );
                    });
                  },
                ),
              ),
            ),
          );
        },
      );
    });
  }
}

/// Inline add-section form: just a name. Replaces the old section dialog.
class InlineGroupForm extends StatefulWidget {
  const InlineGroupForm({
    super.key,
    required this.onSubmit,
    required this.onCancel,
  });

  final ValueChanged<String> onSubmit;
  final VoidCallback onCancel;

  @override
  State<InlineGroupForm> createState() => _InlineGroupFormState();
}

class _InlineGroupFormState extends State<InlineGroupForm> {
  final _label = TextEditingController();

  @override
  void dispose() {
    _label.dispose();
    super.dispose();
  }

  void _submit() {
    final label = _label.text.trim();
    if (label.isEmpty) return;
    widget.onSubmit(label);
  }

  @override
  Widget build(BuildContext context) {
    return _InlineFormFrame(
      onDismiss: widget.onCancel,
      child: Row(
        children: [
          const Icon(Icons.folder_outlined, size: 18),
          const SizedBox(width: 8),
          Expanded(
            child: TextField(
              controller: _label,
              autofocus: true,
              onSubmitted: (_) => _submit(),
              decoration: const InputDecoration(
                isDense: true,
                labelText: 'Section name',
                border: OutlineInputBorder(),
              ),
            ),
          ),
          TextButton(onPressed: widget.onCancel, child: const Text('Cancel')),
          const SizedBox(width: 8),
          FilledButton(onPressed: _submit, child: const Text('Add')),
        ],
      ),
    );
  }
}
