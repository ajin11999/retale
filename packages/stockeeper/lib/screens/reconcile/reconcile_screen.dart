import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:intl/intl.dart';

import '../../graphql/graphql_service.dart';
import '../../graphql/operations.dart';
import '../../models/models.dart';
import '../../voice/voice_input_service.dart';
import '../../voice/voice_quantity_parser.dart';
import '../../widgets/common.dart';
import '../../widgets/scan_sheet.dart';
import '../count_screen.dart';

/// Loaded catalog + location stock payload for [ReconcileScreen].
class ReconcileCatalogData {
  const ReconcileCatalogData({
    required this.localRows,
    required this.globalVariants,
    required this.categories,
    required this.products,
  });

  final List<StockLevel> localRows;
  final List<StockLevel> globalVariants;
  final List<CategoryNode> categories;
  final List<ProductFilterOption> products;
}

/// Count what is physically at one location. Counts stay local in
/// [_counted] (presence = touched) until staff apply them in the review
/// sheet; only touched lines are sent, so partial / spot counts are safe —
/// untouched stock is never adjusted.
class ReconcileScreen extends StatefulWidget {
  const ReconcileScreen({
    super.key,
    required this.location,
    this.voiceRecognizer,
    this.loadCatalog,
  });

  final LocationNode location;
  final VoiceRecognizer? voiceRecognizer;
  final Future<ReconcileCatalogData> Function(String locationId)? loadCatalog;

  @override
  State<ReconcileScreen> createState() => _ReconcileScreenState();
}

class _ReconcileScreenState extends State<ReconcileScreen> {
  List<StockLevel>? _rows;
  List<StockLevel> _globalVariants = [];
  List<CategoryNode> _categories = [];
  List<ProductFilterOption> _products = [];
  Object? _loadError;

  /// variantId -> counted qty. Presence means the line was touched.
  final _counted = <String, num>{};

  final _scanField = TextEditingController();
  final _searchField = TextEditingController();
  final _qtyControllers = <String, TextEditingController>{};
  String _search = '';
  String? _selectedCategoryId;
  String? _selectedProductId;
  String? _lastScanHitId;
  bool _applying = false;

  late final VoiceRecognizer _voice =
      widget.voiceRecognizer ?? SpeechToTextVoiceRecognizer();
  String? _listeningVariantId;
  String _listeningLabel = '';
  String _liveTranscript = '';

  final _checklistKeys = <String, GlobalKey>{};
  final _byProductKeys = <String, GlobalKey>{};

  @override
  void initState() {
    super.initState();
    _load();
  }

  @override
  void dispose() {
    _voice.dispose();
    _scanField.dispose();
    _searchField.dispose();
    for (final c in _qtyControllers.values) {
      c.dispose();
    }
    super.dispose();
  }

  String _fmt(num v) =>
      v == v.truncate() ? v.toInt().toString() : v.toString();

  bool get _hasActiveFilter =>
      _search.trim().isNotEmpty ||
      _selectedCategoryId != null ||
      _selectedProductId != null;

  Future<ReconcileCatalogData> _defaultLoadCatalog(String locationId) async {
    final results = await Future.wait([
      GraphQLService.instance.query(Ops.locationStockLevels,
          variables: {'locationId': locationId}),
      GraphQLService.instance.query(Ops.productLabels),
      GraphQLService.instance.query(Ops.categories),
    ]);

    final categories = (results[2]['categories'] as List<dynamic>)
        .map((c) => CategoryNode.fromJson(c as Map<String, dynamic>))
        .toList();

    final products = results[1]['products'] as List<dynamic>;
    final productCategoryById = <String, String?>{};
    final globalVariants = <StockLevel>[];
    final productOptions = <ProductFilterOption>[];

    for (final p in products) {
      final product = p as Map<String, dynamic>;
      final productId = product['id'] as String;
      final productName = product['name'] as String;
      final categoryId = product['categoryId'] as String?;
      final archivedAt = product['archivedAt'] as String?;
      final isArchived = archivedAt != null && archivedAt.isNotEmpty;
      final variants = product['variants'] as List<dynamic>;

      productCategoryById[productId] = categoryId;
      if (!isArchived && variants.isNotEmpty) {
        productOptions.add(ProductFilterOption(
          id: productId,
          name: productName,
          categoryId: categoryId,
          variantCount: variants.length,
          isArchived: isArchived,
        ));
      }

      for (final v in variants) {
        final variant = v as Map<String, dynamic>;
        globalVariants.add(StockLevel(
          variantId: variant['id'] as String,
          productId: productId,
          productName: productName,
          sku: variant['sku'] as String? ?? '',
          label: variant['label'] as String?,
          barcode: variant['barcode'] as String?,
          unit: variant['unit'] as String? ?? 'piece',
          qtyDecimals: variant['qtyDecimals'] as int? ?? 0,
          onHand: 0,
          categoryId: categoryId,
        ));
      }
    }

    productOptions
        .sort((a, b) => a.name.toLowerCase().compareTo(b.name.toLowerCase()));

    final localRows = (results[0]['locationStockLevels'] as List<dynamic>)
        .map((r) => StockLevel.fromJson(r as Map<String, dynamic>))
        .map((r) => r.withCategoryId(productCategoryById[r.productId]))
        .toList();

    return ReconcileCatalogData(
      localRows: localRows,
      globalVariants: globalVariants,
      categories: categories,
      products: productOptions,
    );
  }

  Future<void> _load() async {
    setState(() {
      _rows = null;
      _loadError = null;
    });
    try {
      final data =
          await (widget.loadCatalog ?? _defaultLoadCatalog)(widget.location.id);
      if (!mounted) return;
      setState(() {
        _rows = data.localRows;
        _globalVariants = data.globalVariants;
        _categories = data.categories;
        _products = data.products;
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

  // ── Voice recognition ────────────────────────────────────────────────────

  Future<void> _toggleVoiceFor(StockLevel row) async {
    if (_listeningVariantId == row.variantId) {
      await _cancelListening();
      return;
    }

    FocusScope.of(context).unfocus();
    setState(() {
      _listeningVariantId = row.variantId;
      _listeningLabel = row.displayName;
      _liveTranscript = '';
    });

    final started = await _voice.startListening(
      onPartial: (partial) {
        if (!mounted || _listeningVariantId != row.variantId) return;
        setState(() => _liveTranscript = partial);
      },
      onFinal: (finalWords) {
        if (!mounted || _listeningVariantId != row.variantId) return;
        _handleVoiceTranscript(row, finalWords);
      },
      onError: (message) {
        if (!mounted || _listeningVariantId != row.variantId) return;
        setState(() {
          _listeningVariantId = null;
          _liveTranscript = '';
        });
        HapticFeedback.vibrate();
        ScaffoldMessenger.of(context)
            .showSnackBar(SnackBar(content: Text(message)));
      },
      onStopped: () {
        if (!mounted || _listeningVariantId != row.variantId) return;
        setState(() {
          _listeningVariantId = null;
          _liveTranscript = '';
        });
      },
    );

    if (!started && mounted && _listeningVariantId == row.variantId) {
      setState(() {
        _listeningVariantId = null;
        _liveTranscript = '';
      });
    }
  }

  Future<void> _cancelListening() async {
    await _voice.cancel();
    if (!mounted) return;
    setState(() {
      _listeningVariantId = null;
      _liveTranscript = '';
    });
  }

  void _handleVoiceTranscript(StockLevel row, String transcript) {
    setState(() {
      _listeningVariantId = null;
      _liveTranscript = '';
    });

    final parsed =
        VoiceQuantityParser.parse(transcript, qtyDecimals: row.qtyDecimals);
    if (!parsed.isSuccess) {
      HapticFeedback.vibrate();
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(
          content: Text(parsed.error ?? 'Could not parse quantity'),
        ),
      );
      return;
    }

    final qty = parsed.value!;
    _setCount(row, qty);
    setState(() => _lastScanHitId = row.variantId);
    HapticFeedback.mediumImpact();
    ScaffoldMessenger.of(context).showSnackBar(
      SnackBar(content: Text('${row.displayName} → ${_fmt(qty)}')),
    );
  }

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
        final row = globalMatches.length == 1
            ? globalMatches.first
            : await _pickRow(globalMatches);
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
                  ProductTitleText.fromStockLevel(row,
                      fontSize: 16, skuFontSize: 13),
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

  // ── Category & Product filter pickers ────────────────────────────────────

  String? get _selectedCategoryName {
    if (_selectedCategoryId == null) return null;
    for (final c in _categories) {
      if (c.id == _selectedCategoryId) return c.name;
    }
    return null;
  }

  String? get _selectedProductName {
    if (_selectedProductId == null) return null;
    for (final p in _products) {
      if (p.id == _selectedProductId) return p.name;
    }
    return null;
  }

  Future<void> _pickCategory() async {
    final entries = buildCategoryTreeEntries(_categories);
    final result = await showModalBottomSheet<_PickerSelection<String>>(
      context: context,
      isScrollControlled: true,
      builder: (ctx) => _SearchablePickerSheet<CategoryTreeEntry>(
        title: 'Filter by category',
        allLabel: 'All categories',
        searchHint: 'Search categories…',
        items: entries,
        isSelected: (e) => e.category.id == _selectedCategoryId,
        matchesQuery: (e, q) =>
            e.category.name.toLowerCase().contains(q) ||
            e.pathLabel.toLowerCase().contains(q),
        itemBuilder: (e) => Padding(
          padding: EdgeInsets.only(left: e.depth * 14.0),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(e.category.name),
              if (e.depth > 0)
                Text(
                  e.pathLabel,
                  style: Theme.of(ctx).textTheme.bodySmall,
                ),
            ],
          ),
        ),
        valueOf: (e) => e.category.id,
      ),
    );
    if (result == null || !mounted) return;
    setState(() {
      _selectedCategoryId = result.value;
      if (_selectedProductId != null && _selectedCategoryId != null) {
        final allowed =
            collectCategoryAndDescendants(_selectedCategoryId!, _categories);
        ProductFilterOption? prod;
        for (final p in _products) {
          if (p.id == _selectedProductId) {
            prod = p;
            break;
          }
        }
        if (prod == null ||
            prod.categoryId == null ||
            !allowed.contains(prod.categoryId)) {
          _selectedProductId = null;
        }
      }
    });
  }

  Future<void> _pickProduct() async {
    final allowedCategories = _selectedCategoryId == null
        ? null
        : collectCategoryAndDescendants(_selectedCategoryId!, _categories);
    final availableProducts = allowedCategories == null
        ? _products
        : _products
            .where((p) =>
                p.categoryId != null && allowedCategories.contains(p.categoryId))
            .toList();

    final result = await showModalBottomSheet<_PickerSelection<String>>(
      context: context,
      isScrollControlled: true,
      builder: (ctx) => _SearchablePickerSheet<ProductFilterOption>(
        title: _selectedCategoryName == null
            ? 'Filter by product'
            : 'Product in $_selectedCategoryName',
        allLabel: 'All products',
        searchHint: 'Search products…',
        items: availableProducts,
        isSelected: (p) => p.id == _selectedProductId,
        matchesQuery: (p, q) => p.name.toLowerCase().contains(q),
        itemBuilder: (p) => Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(p.name),
            Text(
              '${p.variantCount} variant${p.variantCount == 1 ? '' : 's'}',
              style: Theme.of(ctx).textTheme.bodySmall,
            ),
          ],
        ),
        valueOf: (p) => p.id,
      ),
    );
    if (result == null || !mounted) return;
    setState(() => _selectedProductId = result.value);
  }

  void _clearFilters() {
    _searchField.clear();
    setState(() {
      _search = '';
      _selectedCategoryId = null;
      _selectedProductId = null;
    });
  }

  // ── Review & apply ───────────────────────────────────────────────────────

  Future<void> _openReview() async {
    final rows = _rows;
    if (rows == null || _counted.isEmpty) return;
    final touched =
        rows.where((r) => _counted.containsKey(r.variantId)).toList();
    final reason = TextEditingController(
        text:
            'Stockeeper count ${DateFormat('yyyy-MM-dd').format(DateTime.now())}');
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
    final categoryLabel = _selectedCategoryName;
    final productLabel = _selectedProductName;

    return PopScope(
      canPop: _counted.isEmpty,
      onPopInvokedWithResult: (didPop, _) => _confirmLeave(didPop),
      child: DefaultTabController(
        length: 2,
        child: Scaffold(
          appBar: AppBar(
            title: Text('Count: ${widget.location.name}'),
            bottom: PreferredSize(
              preferredSize: const Size.fromHeight(216),
              child: Column(
                mainAxisSize: MainAxisSize.min,
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
                      decoration: InputDecoration(
                        prefixIcon: const Icon(Icons.search),
                        hintText: 'Filter products or variants',
                        border: const OutlineInputBorder(),
                        isDense: true,
                        suffixIcon: _search.isEmpty
                            ? null
                            : IconButton(
                                tooltip: 'Clear search',
                                icon: const Icon(Icons.close),
                                onPressed: () {
                                  _searchField.clear();
                                  setState(() => _search = '');
                                },
                              ),
                      ),
                      onChanged: (v) => setState(() => _search = v),
                    ),
                  ),
                  SizedBox(
                    height: 50,
                    child: ListView(
                      scrollDirection: Axis.horizontal,
                      padding: const EdgeInsets.fromLTRB(16, 0, 16, 8),
                      children: [
                        InputChip(
                          avatar: const Icon(Icons.category_outlined, size: 18),
                          label: Text(categoryLabel == null
                              ? 'Category'
                              : 'Category: $categoryLabel'),
                          selected: categoryLabel != null,
                          onPressed: _categories.isEmpty ? null : _pickCategory,
                          onDeleted: categoryLabel == null
                              ? null
                              : () => setState(() => _selectedCategoryId = null),
                        ),
                        const SizedBox(width: 8),
                        InputChip(
                          avatar:
                              const Icon(Icons.inventory_2_outlined, size: 18),
                          label: Text(productLabel == null
                              ? 'Product'
                              : 'Product: $productLabel'),
                          selected: productLabel != null,
                          onPressed: _products.isEmpty ? null : _pickProduct,
                          onDeleted: productLabel == null
                              ? null
                              : () => setState(() => _selectedProductId = null),
                        ),
                        if (_hasActiveFilter) ...[
                          const SizedBox(width: 8),
                          ActionChip(
                            avatar: const Icon(Icons.filter_alt_off, size: 18),
                            label: const Text('Clear'),
                            onPressed: _clearFilters,
                          ),
                        ],
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
          body: Column(
            children: [
              if (_listeningVariantId != null) _buildListeningBanner(context),
              Expanded(child: _buildBody()),
            ],
          ),
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

  Widget _buildListeningBanner(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    return Material(
      color: scheme.primaryContainer,
      child: Padding(
        padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 10),
        child: Row(
          children: [
            Icon(Icons.mic, color: scheme.error),
            const SizedBox(width: 10),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    'Listening (English): $_listeningLabel',
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: TextStyle(
                      fontWeight: FontWeight.w600,
                      color: scheme.onPrimaryContainer,
                    ),
                  ),
                  Text(
                    _liveTranscript.isEmpty
                        ? 'Say the quantity…'
                        : '"$_liveTranscript"',
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: TextStyle(
                      fontSize: 13,
                      color: scheme.onPrimaryContainer,
                    ),
                  ),
                ],
              ),
            ),
            TextButton(
              onPressed: _cancelListening,
              child: const Text('Cancel'),
            ),
          ],
        ),
      ),
    );
  }

  List<StockLevel> _visibleRows() {
    final rows = _rows ?? [];
    final query = _search.trim().toLowerCase();
    final terms = query.isEmpty ? const <String>[] : query.split(RegExp(r'\s+'));
    final allowedCategoryIds = _selectedCategoryId == null
        ? null
        : collectCategoryAndDescendants(_selectedCategoryId!, _categories);

    bool matches(StockLevel r) {
      if (allowedCategoryIds != null &&
          (r.categoryId == null || !allowedCategoryIds.contains(r.categoryId))) {
        return false;
      }
      if (_selectedProductId != null && r.productId != _selectedProductId) {
        return false;
      }
      if (terms.isNotEmpty) {
        final name = r.displayName.toLowerCase();
        final sku = r.sku.toLowerCase();
        final barcode = (r.barcode ?? '').toLowerCase();
        final matchesTerms = terms.every((term) =>
            name.contains(term) ||
            sku.contains(term) ||
            barcode.contains(term));
        if (!matchesTerms) return false;
      }
      return true;
    }

    if (!_hasActiveFilter) return rows;

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
    if (_rows!.isEmpty && !_hasActiveFilter) {
      return const Center(
        child: Padding(
          padding: EdgeInsets.all(24),
          child: Text(
            'No stock has ever been at this location.\nUse search or Category / Product filters above to count items.',
            textAlign: TextAlign.center,
          ),
        ),
      );
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
        final isListening = _listeningVariantId == row.variantId;
        final theme = Theme.of(context);

        return Container(
          key: key,
          color: _lastScanHitId == row.variantId
              ? theme.colorScheme.primaryContainer.withAlpha(120)
              : null,
          padding: const EdgeInsets.fromLTRB(4, 6, 8, 8),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Row(
                crossAxisAlignment: CrossAxisAlignment.center,
                children: [
                  Checkbox(
                    visualDensity: VisualDensity.compact,
                    tristate: true,
                    value: confirmed ? true : (partial ? null : false),
                    onChanged: (_) => confirmed
                        ? _clearCount(row)
                        : _setCount(row, row.onHand),
                  ),
                  Expanded(
                    child: InkWell(
                      onTap: () => confirmed
                          ? _clearCount(row)
                          : _setCount(row, row.onHand),
                      child: Padding(
                        padding: const EdgeInsets.symmetric(vertical: 4),
                        child: ProductTitleText.fromStockLevel(row),
                      ),
                    ),
                  ),
                  const SizedBox(width: 4),
                  _VoiceRowButton(
                    buttonKey: Key('voice-btn-${row.variantId}'),
                    isListening: isListening,
                    onPressed: () => _toggleVoiceFor(row),
                  ),
                ],
              ),
              Padding(
                padding: const EdgeInsets.only(left: 40),
                child: Row(
                  children: [
                    Expanded(
                      child: Text(
                        counted == null
                            ? 'system ${_fmt(row.onHand)} · not counted'
                            : 'system ${_fmt(row.onHand)} · counted ${_fmt(counted)}',
                        style: theme.textTheme.bodySmall,
                      ),
                    ),
                    IconButton(
                      icon: const Icon(Icons.remove),
                      visualDensity: VisualDensity.compact,
                      onPressed: () => _setCount(
                          row, ((counted ?? 0) - 1).clamp(0, double.infinity)),
                    ),
                    SizedBox(
                      width: 52,
                      child: TextField(
                        controller: _controllerFor(row),
                        textAlign: TextAlign.center,
                        keyboardType: TextInputType.numberWithOptions(
                            decimal: row.qtyDecimals > 0),
                        inputFormatters: _qtyFormatters(row),
                        decoration: const InputDecoration(
                          isDense: true,
                          contentPadding:
                              EdgeInsets.symmetric(horizontal: 4, vertical: 8),
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
              ),
            ],
          ),
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
        final isListening = _listeningVariantId == row.variantId;
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
          trailing: Row(
            mainAxisSize: MainAxisSize.min,
            children: [
              _VoiceRowButton(
                buttonKey: Key('voice-byproduct-btn-${row.variantId}'),
                isListening: isListening,
                onPressed: () => _toggleVoiceFor(row),
              ),
              const SizedBox(width: 4),
              const Icon(Icons.add),
            ],
          ),
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
          titleWidget: ProductTitleText.fromStockLevel(row,
              fontSize: 18, skuFontSize: 14),
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

class _VoiceRowButton extends StatelessWidget {
  const _VoiceRowButton({
    this.buttonKey,
    required this.isListening,
    required this.onPressed,
  });

  final Key? buttonKey;
  final bool isListening;
  final VoidCallback onPressed;

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    if (isListening) {
      return IconButton.filled(
        key: buttonKey,
        tooltip: 'Stop voice input',
        style: IconButton.styleFrom(
          backgroundColor: scheme.error,
          foregroundColor: scheme.onError,
        ),
        icon: const Icon(Icons.stop),
        onPressed: onPressed,
      );
    }
    return IconButton.filledTonal(
      key: buttonKey,
      tooltip: 'Set quantity by voice',
      icon: const Icon(Icons.mic),
      onPressed: onPressed,
    );
  }
}

class _PickerSelection<T> {
  const _PickerSelection(this.value);
  final T? value;
}

class _SearchablePickerSheet<T> extends StatefulWidget {
  const _SearchablePickerSheet({
    required this.title,
    required this.allLabel,
    required this.searchHint,
    required this.items,
    required this.isSelected,
    required this.matchesQuery,
    required this.itemBuilder,
    required this.valueOf,
  });

  final String title;
  final String allLabel;
  final String searchHint;
  final List<T> items;
  final bool Function(T item) isSelected;
  final bool Function(T item, String query) matchesQuery;
  final Widget Function(T item) itemBuilder;
  final String Function(T item) valueOf;

  @override
  State<_SearchablePickerSheet<T>> createState() =>
      _SearchablePickerSheetState<T>();
}

class _SearchablePickerSheetState<T> extends State<_SearchablePickerSheet<T>> {
  String _query = '';

  @override
  Widget build(BuildContext context) {
    final q = _query.trim().toLowerCase();
    final filtered = q.isEmpty
        ? widget.items
        : widget.items.where((item) => widget.matchesQuery(item, q)).toList();

    return SafeArea(
      child: DraggableScrollableSheet(
        expand: false,
        initialChildSize: 0.7,
        minChildSize: 0.4,
        maxChildSize: 0.9,
        builder: (context, scrollController) => Padding(
          padding: EdgeInsets.only(
            bottom: MediaQuery.of(context).viewInsets.bottom,
          ),
          child: Column(
            children: [
              Padding(
                padding: const EdgeInsets.fromLTRB(16, 16, 8, 8),
                child: Row(
                  children: [
                    Expanded(
                      child: Text(
                        widget.title,
                        style: const TextStyle(
                          fontSize: 18,
                          fontWeight: FontWeight.bold,
                        ),
                      ),
                    ),
                    TextButton(
                      onPressed: () =>
                          Navigator.pop(context, const _PickerSelection<String>(null)),
                      child: Text(widget.allLabel),
                    ),
                  ],
                ),
              ),
              Padding(
                padding: const EdgeInsets.fromLTRB(16, 0, 16, 8),
                child: TextField(
                  autofocus: false,
                  decoration: InputDecoration(
                    prefixIcon: const Icon(Icons.search),
                    hintText: widget.searchHint,
                    border: const OutlineInputBorder(),
                    isDense: true,
                  ),
                  onChanged: (v) => setState(() => _query = v),
                ),
              ),
              const Divider(height: 1),
              Expanded(
                child: filtered.isEmpty
                    ? const Center(child: Text('No matches'))
                    : ListView.separated(
                        controller: scrollController,
                        itemCount: filtered.length,
                        separatorBuilder: (_, __) => const Divider(height: 1),
                        itemBuilder: (context, i) {
                          final item = filtered[i];
                          final selected = widget.isSelected(item);
                          return ListTile(
                            title: widget.itemBuilder(item),
                            trailing: selected ? const Icon(Icons.check) : null,
                            selected: selected,
                            onTap: () => Navigator.pop(
                              context,
                              _PickerSelection<String>(widget.valueOf(item)),
                            ),
                          );
                        },
                      ),
              ),
            ],
          ),
        ),
      ),
    );
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
            Text(
                'Apply ${touched.length} counted '
                'line${touched.length == 1 ? '' : 's'}',
                style:
                    const TextStyle(fontSize: 20, fontWeight: FontWeight.bold)),
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
                    title: ProductTitleText.fromStockLevel(row,
                        fontSize: 14, skuFontSize: 11),
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
