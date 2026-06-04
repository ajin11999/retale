import 'dart:async';

import 'package:flutter/material.dart';

import '../auth/auth_service.dart';
import '../cache/product_cache.dart';
import '../config/app_config.dart';
import '../graphql/graphql_service.dart';
import '../graphql/operations.dart';
import '../models/cart.dart';
import '../models/money.dart';
import '../models/pos.dart';
import '../models/product.dart';
import '../sync/connectivity.dart';
import '../sync/sync_service.dart';
import '../widgets/common.dart';
import 'router_screen.dart';

/// The register: product search on the left, the live cart on the right.
class RegisterScreen extends StatefulWidget {
  const RegisterScreen({super.key, required this.session});

  final PosSession session;

  @override
  State<RegisterScreen> createState() => _RegisterScreenState();
}

class _RegisterScreenState extends State<RegisterScreen> {
  final _register = Register();
  final _searchController = TextEditingController();
  final _cache = ProductCache.instance;
  final _sync = SyncService.instance;
  final _connectivity = ConnectivityService.instance;

  Timer? _debounce;
  String _query = '';
  bool _catalogLoading = false;
  String? _catalogError;

  @override
  void initState() {
    super.initState();
    _connectivity.addListener(_onConnectivityChanged);
    _refreshCatalog();
    _sync.flushQueue();
  }

  @override
  void dispose() {
    _debounce?.cancel();
    _connectivity.removeListener(_onConnectivityChanged);
    _searchController.dispose();
    _register.dispose();
    super.dispose();
  }

  void _onConnectivityChanged() {
    // A link came back — try to drain any orders rung while offline.
    if (_connectivity.isOnline) _sync.flushQueue();
    if (mounted) setState(() {});
  }

  Future<void> _refreshCatalog() async {
    setState(() {
      _catalogLoading = true;
      _catalogError = null;
    });
    try {
      await _sync.refreshCatalog();
    } on GraphQLAppException catch (e) {
      // Offline is fine as long as the cache already holds the catalog.
      if (_cache.isEmpty) _catalogError = e.message;
    } finally {
      if (mounted) setState(() => _catalogLoading = false);
    }
  }

  void _onSearchChanged(String text) {
    _debounce?.cancel();
    _debounce = Timer(const Duration(milliseconds: 250), () {
      setState(() => _query = text);
    });
  }

  /// Add a product to the cart, asking which variant if there is more than one.
  Future<void> _pickProduct(Product product) async {
    if (product.variants.isEmpty) return;
    Variant? variant = product.variants.first;
    if (product.variants.length > 1) {
      variant = await showModalBottomSheet<Variant>(
        context: context,
        builder: (_) => _VariantPicker(product: product),
      );
    }
    if (variant != null) _register.active.add(product, variant);
  }

  /// Close a cart tab. Empty carts close instantly; carts with items prompt
  /// first so a half-rung sale is not discarded by accident.
  Future<void> _closeCart(int index) async {
    final cart = _register.carts[index];
    if (!cart.isEmpty) {
      final n = cart.lines.length;
      final discard = await showDialog<bool>(
        context: context,
        builder: (ctx) => AlertDialog(
          title: Text('Close ${_register.labelFor(index)}?'),
          content: Text(
              'This cart has $n item${n == 1 ? '' : 's'}. Closing discards them.'),
          actions: [
            TextButton(
                onPressed: () => Navigator.pop(ctx, false),
                child: const Text('Keep')),
            FilledButton(
                onPressed: () => Navigator.pop(ctx, true),
                child: const Text('Discard')),
          ],
        ),
      );
      if (discard != true) return;
    }
    _register.closeCart(index);
  }

  /// Rename a cart tab. A blank name reverts it to the auto "C{n}".
  Future<void> _renameCart(int index) async {
    final cart = _register.carts[index];
    final controller = TextEditingController(text: cart.label ?? '');
    final name = await showDialog<String>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Text('Name cart'),
        content: TextField(
          controller: controller,
          autofocus: true,
          onSubmitted: (v) => Navigator.pop(ctx, v),
          decoration: const InputDecoration(
            hintText: 'e.g. John, Table 4, Wholesale',
            border: OutlineInputBorder(),
          ),
        ),
        actions: [
          TextButton(
              onPressed: () => Navigator.pop(ctx),
              child: const Text('Cancel')),
          FilledButton(
              onPressed: () => Navigator.pop(ctx, controller.text),
              child: const Text('Save')),
        ],
      ),
    );
    if (name != null) cart.rename(name);
  }

  Future<void> _closeShift() async {
    final controller = TextEditingController(text: '0');
    final confirmed = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Text('Close shift'),
        content: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            const Text('Count the cash in the drawer to close the shift.'),
            const SizedBox(height: 12),
            TextField(
              controller: controller,
              keyboardType:
                  const TextInputType.numberWithOptions(decimal: true),
              decoration: const InputDecoration(
                labelText: 'Closing cash count',
                border: OutlineInputBorder(),
              ),
            ),
          ],
        ),
        actions: [
          TextButton(
              onPressed: () => Navigator.pop(ctx, false),
              child: const Text('Cancel')),
          FilledButton(
              onPressed: () => Navigator.pop(ctx, true),
              child: const Text('Close shift')),
        ],
      ),
    );
    if (confirmed != true) return;
    try {
      await GraphQLService.instance.mutate(Ops.closeSession, variables: {
        'id': widget.session.id,
        'closingCashMinor': Money.parse(controller.text),
      });
      if (mounted) RouterScreen.goHome(context);
    } on GraphQLAppException catch (e) {
      _toast(e.message);
    }
  }

  Future<void> _logout() async {
    await AuthService.instance.logout();
    if (mounted) RouterScreen.goHome(context);
  }

  void _toast(String message) {
    if (!mounted) return;
    ScaffoldMessenger.of(context)
        .showSnackBar(SnackBar(content: Text(message)));
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        title: Text('Register · ${AppConfig.instance.posId ?? ''}'),
        actions: [
          IconButton(
            tooltip: 'Refresh catalog',
            icon: const Icon(Icons.sync),
            onPressed: _catalogLoading ? null : _refreshCatalog,
          ),
          PopupMenuButton<String>(
            onSelected: (v) {
              if (v == 'close') _closeShift();
              if (v == 'logout') _logout();
            },
            itemBuilder: (_) => const [
              PopupMenuItem(value: 'close', child: Text('Close shift')),
              PopupMenuItem(value: 'logout', child: Text('Log out')),
            ],
          ),
        ],
        bottom: PreferredSize(
          preferredSize: const Size.fromHeight(28),
          child: _StatusBar(connectivity: _connectivity, sync: _sync),
        ),
      ),
      body: AnimatedBuilder(
        animation: _register,
        builder: (context, _) => Row(
          children: [
            _CartRail(
              register: _register,
              onRename: _renameCart,
              onClose: _closeCart,
            ),
            const VerticalDivider(width: 1),
            Expanded(flex: 3, child: _buildCatalog()),
            const VerticalDivider(width: 1),
            Expanded(flex: 2, child: _buildCart()),
          ],
        ),
      ),
    );
  }

  Widget _buildCatalog() {
    return Column(
      children: [
        Padding(
          padding: const EdgeInsets.all(12),
          child: TextField(
            controller: _searchController,
            autofocus: true,
            onChanged: _onSearchChanged,
            decoration: const InputDecoration(
              prefixIcon: Icon(Icons.search),
              hintText: 'Search name, SKU or scan a barcode',
              border: OutlineInputBorder(),
            ),
          ),
        ),
        if (_catalogLoading) const LinearProgressIndicator(),
        _buildQuickTiles(),
        Expanded(child: _buildResults()),
      ],
    );
  }

  /// Always-visible palette of open-price products (loose hardware sold by a
  /// guessed lump). Tapping one prompts for the price, then adds a cart line.
  Widget _buildQuickTiles() {
    final items = _cache.openPriceProducts;
    if (items.isEmpty) return const SizedBox.shrink();
    return Container(
      width: double.infinity,
      padding: const EdgeInsets.fromLTRB(12, 0, 12, 8),
      child: Wrap(
        spacing: 8,
        runSpacing: 8,
        children: items
            .map((p) => ActionChip(
                  avatar: const Icon(Icons.add, size: 18),
                  label: Text(p.publicDisplayName),
                  onPressed: () => _pickOpenPrice(p),
                ))
            .toList(),
      ),
    );
  }

  /// Prompt for a lump price and add an open-price line to the cart.
  Future<void> _pickOpenPrice(Product product) async {
    if (product.variants.isEmpty) return;
    final controller = TextEditingController();
    int submit() => Money.parse(controller.text);
    final priceMinor = await showDialog<int>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: Text(product.publicDisplayName),
        content: TextField(
          controller: controller,
          autofocus: true,
          keyboardType: const TextInputType.numberWithOptions(decimal: true),
          onSubmitted: (_) => Navigator.pop(ctx, submit()),
          decoration: const InputDecoration(
            labelText: 'Price',
            border: OutlineInputBorder(),
          ),
        ),
        actions: [
          TextButton(
              onPressed: () => Navigator.pop(ctx),
              child: const Text('Cancel')),
          FilledButton(
              onPressed: () => Navigator.pop(ctx, submit()),
              child: const Text('Add')),
        ],
      ),
    );
    if (priceMinor != null && priceMinor > 0) {
      _register.active.addOpenPrice(product, product.variants.first, priceMinor);
    }
  }

  Widget _buildResults() {
    if (_catalogError != null) {
      return ErrorRetry(message: _catalogError!, onRetry: _refreshCatalog);
    }
    final results = _cache.search(_query);
    if (results.isEmpty) {
      return const Center(child: Text('No matching products'));
    }
    return ListView.separated(
      itemCount: results.length,
      separatorBuilder: (_, __) => const Divider(height: 1),
      itemBuilder: (context, i) {
        final product = results[i];
        final first = product.variants.isEmpty ? null : product.variants.first;
        final priceLabel = product.variants.length == 1 && first != null
            ? Money.format(first.priceMinor)
            : '${product.variants.length} variants';
        return ListTile(
          title: Text(product.publicDisplayName),
          subtitle: Text(first?.sku ?? ''),
          trailing: Text(priceLabel,
              style: const TextStyle(fontWeight: FontWeight.bold)),
          onTap: () => _pickProduct(product),
        );
      },
    );
  }

  Widget _buildCart() {
    // The body's AnimatedBuilder on _register (which forwards every cart's
    // notifications) drives rebuilds, so no inner listener is needed here.
    final cart = _register.active;
    return Column(
      children: [
        Expanded(
          child: cart.isEmpty
              ? const Center(child: Text('Cart is empty'))
              : ListView.builder(
                  itemCount: cart.lines.length,
                  itemBuilder: (context, i) =>
                      _CartLineTile(cart: cart, line: cart.lines[i]),
                ),
        ),
        const Divider(height: 1),
        Padding(
          padding: const EdgeInsets.all(16),
          child: Row(
            children: [
              const Text('Total', style: TextStyle(fontSize: 18)),
              const Spacer(),
              Text(Money.format(cart.totalMinor),
                  style: const TextStyle(
                      fontSize: 22, fontWeight: FontWeight.bold)),
            ],
          ),
        ),
        Padding(
          padding: const EdgeInsets.fromLTRB(16, 0, 16, 16),
          child: SizedBox(
            width: double.infinity,
            child: FilledButton.icon(
              icon: const Icon(Icons.payments),
              label: const Text('Charge'),
              onPressed: cart.isEmpty ? null : _checkout,
            ),
          ),
        ),
      ],
    );
  }

  Future<void> _checkout() async {
    final result = await showDialog<SubmitResult>(
      context: context,
      barrierDismissible: false,
      builder: (_) =>
          _CheckoutDialog(cart: _register.active, session: widget.session),
    );
    if (result == null) return; // cancelled
    // A completed sale, not a discard: close the tab silently (no confirm).
    _register.closeCart(_register.activeIndex);
    _searchController.clear();
    setState(() => _query = '');
    if (result.status == SubmitStatus.confirmed) {
      _toast('Sale completed · ${result.displayNumber ?? 'recorded'}');
    } else {
      _toast('Offline — sale queued, will sync when reconnected');
    }
  }
}

/// The thin online/offline + pending-queue strip under the app bar.
class _StatusBar extends StatelessWidget {
  const _StatusBar({required this.connectivity, required this.sync});

  final ConnectivityService connectivity;
  final SyncService sync;

  @override
  Widget build(BuildContext context) {
    return AnimatedBuilder(
      animation: Listenable.merge([connectivity, sync]),
      builder: (context, _) {
        final online = connectivity.isOnline;
        final pending = sync.pendingCount;
        final color = online ? Colors.green.shade700 : Colors.orange.shade800;
        final parts = <String>[
          online ? 'Online' : 'Offline',
          if (pending > 0) '$pending queued',
        ];
        return Container(
          width: double.infinity,
          color: color,
          padding: const EdgeInsets.symmetric(vertical: 4),
          child: Text(
            parts.join('  ·  '),
            textAlign: TextAlign.center,
            style: const TextStyle(color: Colors.white, fontSize: 12),
          ),
        );
      },
    );
  }
}

/// The left rail of open carts. Tap a tab to switch; the bottom `+` opens a
/// new cart; long-press a tab for Rename / Close.
class _CartRail extends StatelessWidget {
  const _CartRail({
    required this.register,
    required this.onRename,
    required this.onClose,
  });

  final Register register;
  final void Function(int index) onRename;
  final void Function(int index) onClose;

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    return Container(
      width: 76,
      color: scheme.surfaceContainerHighest,
      child: Column(
        children: [
          Expanded(
            child: ListView.builder(
              padding: EdgeInsets.zero,
              itemCount: register.count,
              itemBuilder: (context, i) {
                final cart = register.carts[i];
                final selected = i == register.activeIndex;
                final n = cart.lines.length;
                return InkWell(
                  onTap: () => register.select(i),
                  onLongPress: () => _showMenu(context, i),
                  child: Container(
                    color: selected ? scheme.primaryContainer : null,
                    padding:
                        const EdgeInsets.symmetric(vertical: 12, horizontal: 4),
                    child: Column(
                      children: [
                        Text(
                          register.labelFor(i),
                          maxLines: 1,
                          overflow: TextOverflow.ellipsis,
                          textAlign: TextAlign.center,
                          style: TextStyle(
                              fontWeight: selected
                                  ? FontWeight.bold
                                  : FontWeight.normal),
                        ),
                        if (n > 0)
                          Text('$n item${n == 1 ? '' : 's'}',
                              style: TextStyle(
                                  fontSize: 10,
                                  color: scheme.onSurfaceVariant)),
                      ],
                    ),
                  ),
                );
              },
            ),
          ),
          IconButton(
            tooltip: 'New cart',
            icon: const Icon(Icons.add),
            onPressed: register.addCart,
          ),
        ],
      ),
    );
  }

  Future<void> _showMenu(BuildContext context, int index) async {
    final box = context.findRenderObject() as RenderBox;
    final origin = box.localToGlobal(Offset.zero);
    final overlay = Offset.zero & MediaQuery.of(context).size;
    final choice = await showMenu<String>(
      context: context,
      position: RelativeRect.fromRect(origin & box.size, overlay),
      items: const [
        PopupMenuItem(value: 'rename', child: Text('Rename')),
        PopupMenuItem(value: 'close', child: Text('Close')),
      ],
    );
    if (choice == 'rename') onRename(index);
    if (choice == 'close') onClose(index);
  }
}

/// A single editable cart line: name, qty stepper, line total.
class _CartLineTile extends StatelessWidget {
  const _CartLineTile({required this.cart, required this.line});

  final Cart cart;
  final CartLine line;

  @override
  Widget build(BuildContext context) {
    final overridden = line.overridePriceMinor != null;
    return ListTile(
      onTap: () => _edit(context),
      title: Text(line.displayName),
      subtitle: Row(
        children: [
          if (overridden) ...[
            Icon(Icons.edit, size: 12, color: Theme.of(context).hintColor),
            const SizedBox(width: 4),
          ],
          Text(
            '${Money.format(line.unitPriceMinor)} each'
            '${line.discountMinor > 0 ? '  −${Money.format(line.discountMinor)}' : ''}',
          ),
        ],
      ),
      trailing: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          IconButton(
            icon: const Icon(Icons.remove_circle_outline),
            onPressed: () => cart.setQty(line, line.qty - 1),
          ),
          Text('${line.qty}'),
          IconButton(
            icon: const Icon(Icons.add_circle_outline),
            onPressed: () => cart.setQty(line, line.qty + 1),
          ),
          SizedBox(
            width: 80,
            child: Text(Money.format(line.lineTotalMinor),
                textAlign: TextAlign.right,
                style: const TextStyle(fontWeight: FontWeight.bold)),
          ),
        ],
      ),
    );
  }

  /// Edit dialog reached by tapping the line: override the unit price and set
  /// an exact quantity. Prefilled with plain (non-grouped) numbers so they
  /// parse back cleanly.
  Future<void> _edit(BuildContext context) async {
    final priceController = TextEditingController(
        text: (line.unitPriceMinor / Money.minorPerMajor).toStringAsFixed(2));
    final qtyController = TextEditingController(text: '${line.qty}');
    final saved = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: Text(line.displayName),
        content: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            TextField(
              controller: priceController,
              autofocus: true,
              keyboardType:
                  const TextInputType.numberWithOptions(decimal: true),
              decoration: const InputDecoration(
                labelText: 'Unit price',
                border: OutlineInputBorder(),
              ),
            ),
            const SizedBox(height: 12),
            TextField(
              controller: qtyController,
              keyboardType: TextInputType.number,
              onSubmitted: (_) => Navigator.pop(ctx, true),
              decoration: const InputDecoration(
                labelText: 'Quantity',
                border: OutlineInputBorder(),
              ),
            ),
          ],
        ),
        actions: [
          TextButton(
              onPressed: () => Navigator.pop(ctx, false),
              child: const Text('Cancel')),
          FilledButton(
              onPressed: () => Navigator.pop(ctx, true),
              child: const Text('Save')),
        ],
      ),
    );
    if (saved != true) return;
    final qty = int.tryParse(qtyController.text.trim()) ?? line.qty;
    if (qty <= 0) {
      cart.setQty(line, qty); // 0 or less removes the line
      return;
    }
    cart.setPrice(line, Money.parse(priceController.text));
    cart.setQty(line, qty);
  }
}

/// Bottom sheet for choosing which variant of a multi-variant product.
class _VariantPicker extends StatelessWidget {
  const _VariantPicker({required this.product});

  final Product product;

  @override
  Widget build(BuildContext context) {
    return SafeArea(
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          Padding(
            padding: const EdgeInsets.all(16),
            child: Text(product.publicDisplayName,
                style: const TextStyle(
                    fontSize: 18, fontWeight: FontWeight.bold)),
          ),
          ...product.variants.map((v) => ListTile(
                title: Text(v.label ?? v.sku),
                subtitle: Text(v.sku),
                trailing: Text(Money.format(v.priceMinor)),
                onTap: () => Navigator.pop(context, v),
              )),
        ],
      ),
    );
  }
}

/// Confirms the sale total and submits it (online, or queued when offline).
class _CheckoutDialog extends StatefulWidget {
  const _CheckoutDialog({required this.cart, required this.session});

  final Cart cart;
  final PosSession session;

  @override
  State<_CheckoutDialog> createState() => _CheckoutDialogState();
}

class _CheckoutDialogState extends State<_CheckoutDialog> {
  final _tendered = TextEditingController();
  bool _busy = false;
  String? _error;

  @override
  void dispose() {
    _tendered.dispose();
    super.dispose();
  }

  int get _changeMinor {
    final tendered = Money.parse(_tendered.text);
    final change = tendered - widget.cart.totalMinor;
    return change > 0 ? change : 0;
  }

  Future<void> _submit() async {
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      final result = await SyncService.instance.submitOrder(
        posSessionId: widget.session.id,
        items: widget.cart.toOrderItemsInput(),
        payments: [
          {'method': 'cash', 'amountMinor': widget.cart.totalMinor},
        ],
        totalMinor: widget.cart.totalMinor,
      );
      if (mounted) Navigator.pop(context, result);
    } on GraphQLAppException catch (e) {
      setState(() => _error = e.message);
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    return AlertDialog(
      title: const Text('Charge'),
      content: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Row(
            children: [
              const Text('Total due'),
              const Spacer(),
              Text(Money.format(widget.cart.totalMinor),
                  style: const TextStyle(
                      fontSize: 20, fontWeight: FontWeight.bold)),
            ],
          ),
          const SizedBox(height: 12),
          TextField(
            controller: _tendered,
            autofocus: true,
            keyboardType:
                const TextInputType.numberWithOptions(decimal: true),
            onChanged: (_) => setState(() {}),
            decoration: const InputDecoration(
              labelText: 'Cash tendered',
              border: OutlineInputBorder(),
            ),
          ),
          const SizedBox(height: 8),
          Row(
            children: [
              const Text('Change'),
              const Spacer(),
              Text(Money.format(_changeMinor),
                  style: const TextStyle(fontWeight: FontWeight.bold)),
            ],
          ),
          if (_error != null) ...[
            const SizedBox(height: 12),
            Text(_error!, style: const TextStyle(color: Colors.red)),
          ],
        ],
      ),
      actions: [
        TextButton(
          onPressed: _busy ? null : () => Navigator.pop(context),
          child: const Text('Cancel'),
        ),
        FilledButton(
          onPressed: _busy ? null : _submit,
          child: _busy
              ? const SizedBox(
                  height: 18,
                  width: 18,
                  child: CircularProgressIndicator(strokeWidth: 2))
              : const Text('Complete sale'),
        ),
      ],
    );
  }
}
