import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../auth/auth_service.dart';
import '../cache/cart_store.dart';
import '../cache/product_cache.dart';
import '../cache/session_store.dart';
import '../config/app_config.dart';
import '../graphql/graphql_service.dart';
import '../graphql/operations.dart';
import '../i18n/i18n_service.dart';
import '../models/cart.dart';
import '../models/customer.dart';
import '../models/money.dart';
import '../models/pos.dart';
import '../models/product.dart';
import '../receipt/receipt.dart';
import '../receipt/receipt_service.dart';
import '../receipt/send_receipt_dialog.dart';
import '../sync/connectivity.dart';
import '../sync/sync_service.dart';
import '../widgets/common.dart';
import '../widgets/language_selector_button.dart';
import 'order_history_screen.dart';
import 'router_screen.dart';

/// The register: product search on the left, the live cart on the right.
class RegisterScreen extends StatefulWidget {
  const RegisterScreen({super.key, required this.session});

  final PosSession session;

  @override
  State<RegisterScreen> createState() => _RegisterScreenState();
}

class _RegisterScreenState extends State<RegisterScreen> {
  Register _register = Register();
  final _searchController = TextEditingController();
  final _cache = ProductCache.instance;
  final _sync = SyncService.instance;
  final _connectivity = ConnectivityService.instance;

  Timer? _debounce;
  String _query = '';
  bool _catalogLoading = false;
  String? _catalogError;

  /// The most recent completed sale, kept so Ctrl+P can reprint it.
  _CompletedSale? _lastSale;

  @override
  void initState() {
    super.initState();
    _restoreCarts();
    _connectivity.addListener(_onConnectivityChanged);
    _refreshCatalog();
    _sync.flushQueue();
    // F9 charges the active cart. Handled at the keyboard level (rather than via
    // CallbackShortcuts) so it fires even while the catalog search field holds
    // focus — on web a focused text input otherwise swallows the key.
    HardwareKeyboard.instance.addHandler(_handleKey);
  }

  @override
  void dispose() {
    HardwareKeyboard.instance.removeHandler(_handleKey);
    _debounce?.cancel();
    _connectivity.removeListener(_onConnectivityChanged);
    _searchController.dispose();
    _register.removeListener(_persistCarts);
    _register.dispose();
    super.dispose();
  }

  /// Bring back the carts parked on this POS — they outlive a shift close and an
  /// app restart. Runs before the cashier can touch the placeholder register, so
  /// it only swaps in the saved carts when nothing has been rung yet.
  Future<void> _restoreCarts() async {
    final posId = AppConfig.instance.posId;
    final restored =
        posId == null ? null : await CartStore.instance.load(posId);
    if (!mounted) {
      restored?.dispose();
      return;
    }
    if (restored != null && _register.isPristine) {
      _register.dispose();
      _register = restored;
    } else {
      restored?.dispose();
    }
    _register.addListener(_persistCarts);
    setState(() {});
  }

  /// Save the register on every edit so a parked sale is never lost. Writes
  /// coalesce in [CartStore], so rapid edits don't hammer storage.
  void _persistCarts() {
    final posId = AppConfig.instance.posId;
    if (posId != null) CartStore.instance.save(posId, _register);
  }

  bool _isOpeningCheckout = false;
  DateTime? _lastF9PressTime;

  /// Global key handler for the register. Only acts while the register is the
  /// frontmost route, so F9 doesn't re-fire behind an open dialog or sheet.
  bool _handleKey(KeyEvent event) {
    if (event is! KeyDownEvent || event.logicalKey != LogicalKeyboardKey.f9) {
      return false;
    }
    if (ModalRoute.of(context)?.isCurrent != true) return false;
    final now = DateTime.now();
    if (_lastF9PressTime != null &&
        now.difference(_lastF9PressTime!) < const Duration(milliseconds: 500)) {
      return true; // absorb rapid duplicate F9 keypresses (keyboard bounce/ghosting)
    }
    _lastF9PressTime = now;
    if (_isOpeningCheckout) return true;
    if (!_register.active.isEmpty) _checkout();
    return true;
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
        // Scroll-controlled so a long variant list gets most of the screen
        // instead of overflowing the default half-height sheet.
        isScrollControlled: true,
        showDragHandle: true,
        builder:
            (_) => DraggableScrollableSheet(
              expand: false,
              initialChildSize: 0.7,
              minChildSize: 0.4,
              maxChildSize: 0.9,
              builder:
                  (_, controller) => _VariantPicker(
                    product: product,
                    scrollController: controller,
                  ),
            ),
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
        builder:
            (ctx) => AlertDialog(
              title: Text(
                tr('register.closeCartTitle', {
                  'name': _register.labelFor(index),
                }),
              ),
              content: Text(tr('register.closeCartBody', {'count': n})),
              actions: [
                TextButton(
                  onPressed: () => Navigator.pop(ctx, false),
                  child: Text(tr('register.keep')),
                ),
                FilledButton(
                  onPressed: () => Navigator.pop(ctx, true),
                  child: Text(tr('register.discard')),
                ),
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
      builder:
          (ctx) => AlertDialog(
            title: Text(tr('register.nameCartTitle')),
            content: TextField(
              controller: controller,
              autofocus: true,
              onSubmitted: (v) => Navigator.pop(ctx, v),
              decoration: InputDecoration(
                hintText: tr('register.cartNameHint'),
                border: const OutlineInputBorder(),
              ),
            ),
            actions: [
              TextButton(
                onPressed: () => Navigator.pop(ctx),
                child: Text(tr('common.cancel')),
              ),
              FilledButton(
                onPressed: () => Navigator.pop(ctx, controller.text),
                child: Text(tr('common.save')),
              ),
            ],
          ),
    );
    if (name != null) cart.rename(name);
  }

  Future<void> _closeShift() async {
    // Best effort: the dialog still works offline, just without the figure.
    num? expectedCash;
    try {
      final data = await GraphQLService.instance.query(
        Ops.sessionExpectedCash,
        variables: {'id': widget.session.id},
      );
      final session = data['posSession'] as Map<String, dynamic>?;
      expectedCash = session?['expectedCashMinor'] as num?;
    } on GraphQLAppException {
      expectedCash = null;
    }
    if (!mounted) return;
    final expected = expectedCash;
    final controller = TextEditingController(text: '0');
    final confirmed = await showDialog<bool>(
      context: context,
      builder:
          (ctx) => AlertDialog(
            title: Text(tr('register.closeShift')),
            content: Column(
              mainAxisSize: MainAxisSize.min,
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                if (expected != null) ...[
                  Text(
                    tr('session.drawerShouldHold', {
                      'amount': Money.format(expected),
                    }),
                    style: const TextStyle(
                      fontWeight: FontWeight.bold,
                      fontSize: 16,
                    ),
                  ),
                  const SizedBox(height: 8),
                ],
                Text(tr('session.countCashToClose')),
                const SizedBox(height: 12),
                TextField(
                  controller: controller,
                  keyboardType: TextInputType.number,
                  inputFormatters: [ThousandsSeparatorInputFormatter()],
                  decoration: InputDecoration(
                    labelText: tr('session.closingCashCount'),
                    border: const OutlineInputBorder(),
                  ),
                ),
              ],
            ),
            actions: [
              TextButton(
                onPressed: () => Navigator.pop(ctx, false),
                child: Text(tr('common.cancel')),
              ),
              FilledButton(
                onPressed: () => Navigator.pop(ctx, true),
                child: Text(tr('register.closeShift')),
              ),
            ],
          ),
    );
    if (confirmed != true) return;
    try {
      await GraphQLService.instance.mutate(
        Ops.closeSession,
        variables: {
          'id': widget.session.id,
          'closingCashMinor': Money.parse(controller.text),
        },
      );
      // The shift is closed server-side; drop the offline-resume cache so the
      // next launch can't reopen the register on a dead session.
      final posId = AppConfig.instance.posId;
      if (posId != null) await SessionStore.instance.clear(posId);
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
    ScaffoldMessenger.of(
      context,
    ).showSnackBar(SnackBar(content: Text(message)));
  }

  @override
  Widget build(BuildContext context) {
    return CallbackShortcuts(
      // Ctrl+P reprints the last completed sale. Works on the Windows/Linux
      // desktop register; on web the browser may claim the shortcut first.
      bindings: <ShortcutActivator, VoidCallback>{
        const SingleActivator(LogicalKeyboardKey.keyP, control: true):
            () => _printLastSale(),
      },
      child: Scaffold(
        appBar: AppBar(
          leading: Padding(
            padding: const EdgeInsets.all(10),
            child: Image.asset('assets/logo.png'),
          ),
          title: Text(
            '${tr('register.title')} · ${AppConfig.instance.posId ?? ''}',
          ),
          actions: [
            const LanguageSelectorButton(iconOnly: true),
            IconButton(
              tooltip: tr('register.refreshCatalog'),
              icon: const Icon(Icons.sync),
              onPressed: _catalogLoading ? null : _refreshCatalog,
            ),
            IconButton(
              tooltip: tr('register.shiftOrders'),
              icon: const Icon(Icons.receipt_long),
              onPressed:
                  () => Navigator.of(context).push(
                    MaterialPageRoute(
                      builder:
                          (_) => OrderHistoryScreen(
                            posSessionId: widget.session.id,
                          ),
                    ),
                  ),
            ),
            PopupMenuButton<String>(
              onSelected: (v) {
                if (v == 'language')
                  LanguageSelectorButton.showLanguageDialog(context);
                if (v == 'close') _closeShift();
                if (v == 'logout') _logout();
              },
              itemBuilder:
                  (_) => [
                    PopupMenuItem(
                      value: 'language',
                      child: Row(
                        children: [
                          const Icon(Icons.language, size: 18),
                          const SizedBox(width: 8),
                          Text(
                            '${tr('common.language')} (${I18nService.instance.currentLocaleName})',
                          ),
                        ],
                      ),
                    ),
                    PopupMenuItem(
                      value: 'close',
                      child: Text(tr('register.closeShift')),
                    ),
                    PopupMenuItem(
                      value: 'logout',
                      child: Text(tr('register.logout')),
                    ),
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
          builder:
              (context, _) => Row(
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
            decoration: InputDecoration(
              prefixIcon: const Icon(Icons.search),
              hintText: tr('register.searchHint'),
              border: const OutlineInputBorder(),
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
        children:
            items
                .map(
                  (p) => ActionChip(
                    avatar: const Icon(Icons.add, size: 18),
                    label: Text(p.publicDisplayName),
                    onPressed: () => _pickOpenPrice(p),
                  ),
                )
                .toList(),
      ),
    );
  }

  /// Prompt for a lump price and add an open-price line to the cart.
  Future<void> _pickOpenPrice(Product product) async {
    if (product.variants.isEmpty) return;
    final controller = TextEditingController();
    num submit() => Money.parse(controller.text);
    final priceMinor = await showDialog<num>(
      context: context,
      builder:
          (ctx) => AlertDialog(
            title: Text(product.publicDisplayName),
            content: TextField(
              controller: controller,
              autofocus: true,
              keyboardType: TextInputType.number,
              inputFormatters: [ThousandsSeparatorInputFormatter()],
              onSubmitted: (_) => Navigator.pop(ctx, submit()),
              decoration: InputDecoration(
                labelText: tr('register.price'),
                border: const OutlineInputBorder(),
              ),
            ),
            actions: [
              TextButton(
                onPressed: () => Navigator.pop(ctx),
                child: Text(tr('common.cancel')),
              ),
              FilledButton(
                onPressed: () => Navigator.pop(ctx, submit()),
                child: Text(tr('register.add')),
              ),
            ],
          ),
    );
    if (priceMinor != null && priceMinor > 0) {
      _register.active.addOpenPrice(
        product,
        product.variants.first,
        priceMinor,
      );
    }
  }

  Widget _buildResults() {
    if (_catalogError != null) {
      return ErrorRetry(message: _catalogError!, onRetry: _refreshCatalog);
    }
    final results = _cache.search(_query);
    if (results.isEmpty) {
      return Center(child: Text(tr('register.noMatchingProducts')));
    }
    return ListView.separated(
      itemCount: results.length,
      separatorBuilder: (_, __) => const Divider(height: 1),
      itemBuilder: (context, i) {
        final product = results[i];
        final first = product.variants.isEmpty ? null : product.variants.first;
        final priceLabel =
            product.variants.length == 1 && first != null
                ? Money.format(first.priceMinor)
                : tr('register.variantsCount', {
                  'count': product.variants.length,
                });
        return ListTile(
          title: Text(product.publicDisplayName),
          subtitle: Text(
            first?.sku ?? '',
            style: const TextStyle(
              fontSize: 12,
              color: Colors.grey,
              fontFamily: 'monospace',
            ),
          ),
          trailing: Text(
            priceLabel,
            style: const TextStyle(fontWeight: FontWeight.bold),
          ),
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
          child:
              cart.isEmpty
                  ? Center(child: Text(tr('register.cartEmpty')))
                  : ListView.builder(
                    itemCount: cart.lines.length,
                    itemBuilder:
                        (context, i) =>
                            _CartLineTile(cart: cart, line: cart.lines[i]),
                  ),
        ),
        const Divider(height: 1),
        Padding(
          padding: const EdgeInsets.fromLTRB(16, 8, 8, 8),
          child: Row(
            children: [
              Text(tr('register.total'), style: const TextStyle(fontSize: 18)),
              const Spacer(),
              Text(
                Money.format(cart.totalMinor),
                style: const TextStyle(
                  fontSize: 22,
                  fontWeight: FontWeight.bold,
                ),
              ),
              IconButton(
                tooltip: tr('register.marginBreakdown'),
                icon: const Icon(Icons.insights_outlined),
                onPressed: cart.isEmpty ? null : () => _showMargins(cart),
              ),
            ],
          ),
        ),
        Padding(
          padding: const EdgeInsets.fromLTRB(16, 0, 16, 8),
          child: SizedBox(
            width: double.infinity,
            child: FilledButton.icon(
              icon: const Icon(Icons.payments),
              label: Text(tr('register.charge')),
              onPressed: cart.isEmpty ? null : _checkout,
            ),
          ),
        ),
        Padding(
          padding: const EdgeInsets.fromLTRB(16, 0, 16, 16),
          child: SizedBox(
            width: double.infinity,
            child: OutlinedButton.icon(
              icon: const Icon(Icons.assignment_return),
              label: Text(tr('register.return')),
              onPressed: cart.isEmpty ? null : _startReturnFromCart,
            ),
          ),
        ),
      ],
    );
  }

  Future<void> _checkout() async {
    if (_isOpeningCheckout) return;
    _isOpeningCheckout = true;
    try {
      final cart = _register.active;
      if (cart.isEmpty) return;
      // Snapshot the lines and total now: a completed sale clears the cart right
      // after, but the receipt (offered below) still needs them.
      final lines =
          cart.lines
              .map(
                (l) => ReceiptLine(
                  name: l.displayName,
                  qty: l.qty,
                  unitPriceMinor: l.unitPriceMinor,
                  lineTotalMinor: l.lineTotalMinor,
                  unit: l.variant.unit,
                ),
              )
              .toList();
      final totalMinor = cart.totalMinor;
      final outcome = await showDialog<_CheckoutOutcome>(
        context: context,
        barrierDismissible: false,
        builder: (_) => _CheckoutDialog(cart: cart, session: widget.session),
      );
      if (outcome == null) return; // cancelled
      // A completed sale, not a discard: close the tab silently (no confirm).
      _register.closeCart(_register.activeIndex);
      _searchController.clear();
      setState(() => _query = '');
      if (outcome.result.status == SubmitStatus.confirmed) {
        final sale = _CompletedSale(
          displayNumber: outcome.result.displayNumber,
          lines: lines,
          totalMinor: totalMinor,
          paidMinor: outcome.paidMinor,
          onAccountMinor: outcome.onAccountMinor,
          customer: outcome.customer,
          createdAt: DateTime.now(),
        );
        setState(() => _lastSale = sale);
        _announceSale(sale);
      } else {
        // Offline: the sale is queued and will sync once reconnected, but the
        // receipt is assembled and rendered entirely on-device, so it can still
        // be printed now. The server-assigned number isn't known yet (null →
        // "recorded" on the receipt); it'll appear once the queue flushes.
        final sale = _CompletedSale(
          displayNumber: null,
          lines: lines,
          totalMinor: totalMinor,
          paidMinor: outcome.paidMinor,
          onAccountMinor: outcome.onAccountMinor,
          customer: outcome.customer,
          createdAt: DateTime.now(),
        );
        setState(() => _lastSale = sale);
        _announceSale(sale, queued: true);
      }
    } finally {
      _isOpeningCheckout = false;
    }
  }

  /// Return flow driven by the cart: find past orders that contain every item
  /// in the cart, let the cashier pick one, and ring the return against it
  /// (prefilled with the cart quantities). On success, clear the cart.
  Future<void> _startReturnFromCart() async {
    final cart = _register.active;
    if (cart.isEmpty) return;
    // Sum the cart's quantities per variant — the demand to return.
    final demand = <String, int>{};
    for (final l in cart.lines) {
      demand[l.variant.id] = (demand[l.variant.id] ?? 0) + l.qty;
    }
    List<Map<String, dynamic>> candidates;
    try {
      final data = await GraphQLService.instance.query(
        Ops.ordersForReturn,
        variables: {'variantIds': demand.keys.toList(), 'limit': 50},
      );
      candidates =
          (data['ordersForReturn'] as List<dynamic>)
              .cast<Map<String, dynamic>>();
    } on GraphQLAppException catch (e) {
      _toast(
        e.isNetworkError ? tr('register.returnNeedsConnection') : e.message,
      );
      return;
    }
    if (!mounted) return;
    if (candidates.isEmpty) {
      _toast(tr('register.noReturnOrder'));
      return;
    }
    final done = await Navigator.of(context).push<bool>(
      MaterialPageRoute(
        builder:
            (_) => ReturnOrderPicker(
              candidates: candidates,
              demand: demand,
              posSessionId: widget.session.id,
            ),
      ),
    );
    if (done == true && mounted) {
      _register.active.clear();
      _toast(tr('history.returnRecorded'));
    }
  }

  /// Confirm the sale with a snackbar whose action opens the receipt choices
  /// (print or WhatsApp). Ctrl+P is the faster path to the same print.
  ///
  /// The snackbar is temporary and dismisses automatically after 10 seconds.
  /// [queued] flags an offline sale — the receipt still
  /// prints locally, it just hasn't synced to the server yet.
  void _announceSale(_CompletedSale sale, {bool queued = false}) {
    if (!mounted) return;
    final label =
        queued
            ? tr('register.saleQueued')
            : tr('register.saleCompleted', {
              'number': sale.displayNumber ?? tr('register.recorded'),
            });
    ScaffoldMessenger.of(context)
      // Replace any prior sale's lingering alert rather than queueing behind it.
      ..hideCurrentSnackBar()
      ..showSnackBar(
        SnackBar(
          content: Text(label),
          duration: const Duration(seconds: 10),
          showCloseIcon: true,
          action: SnackBarAction(
            label: tr('receipt.receipt'),
            onPressed: () => _openReceiptActions(sale),
          ),
        ),
      );
  }

  /// Fetch the store header and assemble a [Receipt] for [sale].
  Future<Receipt> _receiptFor(_CompletedSale sale) async {
    final store = await ReceiptService.instance.storeInfo();
    final changeMinor =
        (sale.paidMinor != null && sale.paidMinor! > sale.totalMinor)
            ? sale.paidMinor! - sale.totalMinor
            : null;
    return Receipt(
      store: store,
      lines: sale.lines,
      totalMinor: sale.totalMinor,
      displayNumber: sale.displayNumber,
      createdAt: sale.createdAt,
      paidMinor: sale.paidMinor,
      changeMinor: changeMinor,
      onAccountMinor: sale.onAccountMinor,
      customerName: sale.customer?.name,
    );
  }

  /// Bottom sheet offering to print or WhatsApp the receipt for [sale].
  Future<void> _openReceiptActions(_CompletedSale sale) async {
    final receipt = await _receiptFor(sale);
    if (!mounted) return;
    await showModalBottomSheet<void>(
      context: context,
      showDragHandle: true,
      builder:
          (ctx) => SafeArea(
            child: Column(
              mainAxisSize: MainAxisSize.min,
              children: [
                ListTile(
                  leading: const Icon(Icons.print_outlined),
                  title: Text(tr('receipt.print')),
                  onTap: () {
                    Navigator.pop(ctx);
                    _print(receipt);
                  },
                ),
                ListTile(
                  leading: const Icon(Icons.chat_outlined),
                  title: Text(tr('receipt.sendWhatsApp')),
                  onTap: () {
                    Navigator.pop(ctx);
                    showSendReceiptDialog(
                      context,
                      receipt: receipt,
                      phone: sale.customer?.phone,
                    );
                  },
                ),
              ],
            ),
          ),
    );
  }

  /// Ctrl+P: print the last completed sale, if there is one.
  Future<void> _printLastSale() async {
    final sale = _lastSale;
    if (sale == null) {
      _toast(tr('register.noRecentSale'));
      return;
    }
    final receipt = await _receiptFor(sale);
    if (!mounted) return;
    await _print(receipt);
  }

  /// Print [receipt], surfacing whatever goes wrong instead of failing
  /// silently (the browser print path can no-op or throw on web).
  Future<void> _print(Receipt receipt) async {
    try {
      final printed = await ReceiptService.instance.printReceipt(receipt);
      if (!printed) _toast(tr('register.openedPdf'));
    } catch (e) {
      _toast(tr('register.printFailed', {'error': '$e'}));
    }
  }

  /// Show per-line and cart-wide margins for the active cart.
  void _showMargins(Cart cart) {
    showModalBottomSheet<void>(
      context: context,
      showDragHandle: true,
      builder: (_) => _CartDetailSheet(cart: cart),
    );
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
          online ? tr('register.onlineMode') : tr('register.offlineMode'),
          if (pending > 0) tr('register.pendingQueued', {'count': pending}),
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
      // The "+" rides as the last item just below the final cart, instead of
      // being pinned to the rail's bottom edge.
      child: ListView.builder(
        padding: EdgeInsets.zero,
        itemCount: register.count + 1,
        itemBuilder: (context, i) {
          if (i == register.count) {
            return IconButton(
              tooltip: tr('register.newCart'),
              icon: const Icon(Icons.add),
              onPressed: register.addCart,
            );
          }
          final cart = register.carts[i];
          final selected = i == register.activeIndex;
          final n = cart.lines.length;
          return InkWell(
            onTap: () => register.select(i),
            onLongPress: () => onRename(i), // touch shortcut to rename
            child: Container(
              color: selected ? scheme.primaryContainer : null,
              padding: const EdgeInsets.only(
                top: 8,
                bottom: 12,
                left: 4,
                right: 4,
              ),
              child: Column(
                children: [
                  // The ⋮ menu lives only on the active cart — left-click works
                  // everywhere (touch, mouse), unlike right-click/long-press.
                  SizedBox(
                    height: 24,
                    child:
                        selected
                            ? PopupMenuButton<String>(
                              padding: EdgeInsets.zero,
                              iconSize: 18,
                              tooltip: '',
                              icon: const Icon(Icons.more_vert),
                              onSelected: (choice) {
                                if (choice == 'rename') onRename(i);
                                if (choice == 'close') onClose(i);
                              },
                              itemBuilder:
                                  (_) => [
                                    PopupMenuItem(
                                      value: 'rename',
                                      child: Text(tr('register.rename')),
                                    ),
                                    PopupMenuItem(
                                      value: 'close',
                                      child: Text(tr('common.close')),
                                    ),
                                  ],
                            )
                            : null,
                  ),
                  Text(
                    register.labelFor(i),
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    textAlign: TextAlign.center,
                    style: TextStyle(
                      fontWeight:
                          selected ? FontWeight.bold : FontWeight.normal,
                    ),
                  ),
                  if (n > 0)
                    Text(
                      tr('register.itemCount', {'count': n}),
                      style: TextStyle(
                        fontSize: 10,
                        color: scheme.onSurfaceVariant,
                      ),
                    ),
                ],
              ),
            ),
          );
        },
      ),
    );
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
      subtitle: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        mainAxisSize: MainAxisSize.min,
        children: [
          Row(
            children: [
              if (overridden || line.hasCustomName) ...[
                Icon(Icons.edit, size: 12, color: Theme.of(context).hintColor),
                const SizedBox(width: 4),
              ],
              Text(
                '${Money.format(line.unitPriceMinor)} ${tr('register.each')}'
                '${line.discountMinor > 0 ? '  −${Money.format(line.discountMinor)}' : ''}',
              ),
            ],
          ),
          // A renamed line keeps its catalog name visible underneath, so the
          // cashier can still tell which product it actually is.
          if (line.hasCustomName)
            Text(
              line.defaultDisplayName,
              style: TextStyle(
                fontSize: 12,
                fontStyle: FontStyle.italic,
                color: Theme.of(context).hintColor,
              ),
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
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
            child: Text(
              Money.format(line.lineTotalMinor),
              textAlign: TextAlign.right,
              style: const TextStyle(fontWeight: FontWeight.bold),
            ),
          ),
        ],
      ),
    );
  }

  /// Edit dialog reached by tapping the line: rename the item for this order
  /// only (a remark/memo — never written back to the catalog), override the
  /// unit price (0 is valid — a bonus / free item) and set an exact quantity.
  /// "Reset price" drops the override, reverting to the base price; "Reset
  /// name" clears the remark back to the catalog name. Prefilled with plain
  /// (non-grouped) numbers so they parse back cleanly.
  Future<void> _edit(BuildContext context) async {
    final nameController = TextEditingController(
      text: line.hasCustomName ? line.customName : '',
    );
    final priceController = TextEditingController(
      text: Money.format(line.unitPriceMinor),
    );
    final qtyController = TextEditingController(text: '${line.qty}');
    final action = await showDialog<String>(
      context: context,
      builder:
          (ctx) => AlertDialog(
            title: Text(line.displayName),
            content: Column(
              mainAxisSize: MainAxisSize.min,
              children: [
                TextField(
                  controller: nameController,
                  textCapitalization: TextCapitalization.sentences,
                  onSubmitted: (_) => Navigator.pop(ctx, 'save'),
                  decoration: InputDecoration(
                    labelText: tr('register.lineName'),
                    hintText: line.defaultDisplayName,
                    border: const OutlineInputBorder(),
                  ),
                ),
                const SizedBox(height: 12),
                TextField(
                  controller: priceController,
                  autofocus: true,
                  keyboardType: TextInputType.number,
                  inputFormatters: [ThousandsSeparatorInputFormatter()],
                  onSubmitted: (_) => Navigator.pop(ctx, 'save'),
                  decoration: InputDecoration(
                    labelText: tr('register.unitPrice'),
                    border: const OutlineInputBorder(),
                  ),
                ),
                const SizedBox(height: 8),
                // Live cost/margin preview so the price can be tuned to a target
                // margin without leaving the dialog.
                ValueListenableBuilder<TextEditingValue>(
                  valueListenable: priceController,
                  builder: (ctx, value, _) {
                    final price = Money.parse(value.text);
                    final cost = line.unitCostForPrice(price);
                    final margin = price - cost;
                    final pct =
                        price == 0
                            ? '—'
                            : '${(margin / price * 100).toStringAsFixed(0)}%';
                    final scheme = Theme.of(ctx).colorScheme;
                    return Align(
                      alignment: Alignment.centerLeft,
                      child: Text(
                        '${tr('register.costValue', {'value': Money.format(cost)})}'
                        '   ·   '
                        '${tr('register.marginValue', {'value': Money.format(margin)})}'
                        ' ($pct)',
                        style: TextStyle(
                          fontSize: 12,
                          color:
                              margin < 0
                                  ? scheme.error
                                  : scheme.onSurfaceVariant,
                        ),
                      ),
                    );
                  },
                ),
                const SizedBox(height: 12),
                TextField(
                  controller: qtyController,
                  keyboardType: TextInputType.number,
                  onSubmitted: (_) => Navigator.pop(ctx, 'save'),
                  decoration: InputDecoration(
                    labelText: tr('register.quantity'),
                    border: const OutlineInputBorder(),
                  ),
                ),
              ],
            ),
            actions: [
              // Open-price lines have no base price to revert to, so no reset.
              if (line.overridePriceMinor != null &&
                  line.product.kind != 'open_price')
                TextButton(
                  onPressed: () => Navigator.pop(ctx, 'reset'),
                  child: Text(tr('register.resetPrice')),
                ),
              if (line.hasCustomName)
                TextButton(
                  onPressed: () => Navigator.pop(ctx, 'resetName'),
                  child: Text(tr('register.resetLineName')),
                ),
              TextButton(
                onPressed: () => Navigator.pop(ctx, null),
                child: Text(tr('common.cancel')),
              ),
              FilledButton(
                onPressed: () => Navigator.pop(ctx, 'save'),
                child: Text(tr('common.save')),
              ),
            ],
          ),
    );
    if (action == null) return;
    final qty = int.tryParse(qtyController.text.trim()) ?? line.qty;
    if (qty <= 0) {
      cart.setQty(line, qty); // 0 or less removes the line
      return;
    }
    if (action == 'resetName') {
      cart.setCustomName(line, null);
    } else {
      // A blank field keeps the catalog name — only a non-blank entry becomes
      // a per-line remark. Skip a no-op entry so it doesn't dirty the line.
      final nameText = nameController.text;
      if (nameText.trim() != (line.customName ?? '')) {
        cart.setCustomName(line, nameText);
      }
    }
    if (action == 'reset') {
      cart.setPrice(line, null);
    } else {
      // A blank field keeps the current price — only an explicit "0" makes
      // the line free. Skip a no-op entry so it doesn't become an override.
      final text = priceController.text.trim();
      final price = text.isEmpty ? line.unitPriceMinor : Money.parse(text);
      if (price != line.unitPriceMinor) cart.setPrice(line, price);
    }
    cart.setQty(line, qty);
  }
}

/// Bottom sheet for choosing which variant of a multi-variant product.
/// Searchable and scrollable, so products with dozens of variants don't
/// overflow the sheet: type to filter by label, SKU or barcode.
class _VariantPicker extends StatefulWidget {
  const _VariantPicker({required this.product, required this.scrollController});

  final Product product;
  final ScrollController scrollController;

  @override
  State<_VariantPicker> createState() => _VariantPickerState();
}

class _VariantPickerState extends State<_VariantPicker> {
  final _searchController = TextEditingController();
  String _query = '';

  @override
  void dispose() {
    _searchController.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final terms =
        _query.toLowerCase().split(RegExp(r'\s+'))
          ..removeWhere((t) => t.isEmpty);
    final variants =
        terms.isEmpty
            ? widget.product.variants
            : widget.product.variants.where((v) {
              final haystack =
                  '${v.label ?? ''} ${v.sku} ${v.barcode ?? ''}'
                      .toLowerCase();
              return terms.every(haystack.contains);
            }).toList();
    return SafeArea(
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          Padding(
            padding: const EdgeInsets.fromLTRB(16, 0, 16, 4),
            child: Text(
              widget.product.publicDisplayName,
              style: const TextStyle(fontSize: 18, fontWeight: FontWeight.bold),
            ),
          ),
          // Only worth searching when the list is long enough to overflow.
          if (widget.product.variants.length > 5)
            Padding(
              padding: const EdgeInsets.fromLTRB(16, 8, 16, 4),
              child: TextField(
                controller: _searchController,
                autofocus: false,
                onChanged: (text) => setState(() => _query = text),
                decoration: InputDecoration(
                  prefixIcon: const Icon(Icons.search),
                  hintText: tr('register.searchVariantsHint'),
                  border: const OutlineInputBorder(),
                  isDense: true,
                ),
              ),
            ),
          Flexible(
            child:
                variants.isEmpty
                    ? Center(
                      child: Padding(
                        padding: const EdgeInsets.all(24),
                        child: Text(tr('register.noMatchingVariants')),
                      ),
                    )
                    : ListView.separated(
                      controller: widget.scrollController,
                      shrinkWrap: true,
                      itemCount: variants.length,
                      separatorBuilder: (_, __) => const Divider(height: 1),
                      itemBuilder: (context, i) {
                        final v = variants[i];
                        return ListTile(
                          title: Text(v.label ?? v.sku),
                          subtitle: Text(
                            v.sku,
                            style: const TextStyle(
                              fontSize: 12,
                              color: Colors.grey,
                              fontFamily: 'monospace',
                            ),
                          ),
                          trailing: Text(Money.format(v.priceMinor)),
                          onTap: () => Navigator.pop(context, v),
                        );
                      },
                    ),
          ),
        ],
      ),
    );
  }
}

/// A read-only breakdown of the active cart: each line's revenue, cost and
/// margin, plus the cart-wide totals at the foot. Opened from the Total row.
class _CartDetailSheet extends StatelessWidget {
  const _CartDetailSheet({required this.cart});

  final Cart cart;

  static String _pct(double? fraction) =>
      fraction == null ? '—' : '${(fraction * 100).toStringAsFixed(0)}%';

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    return SafeArea(
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          Padding(
            padding: const EdgeInsets.fromLTRB(16, 0, 16, 8),
            child: Align(
              alignment: Alignment.centerLeft,
              child: Text(
                tr('register.cartDetail'),
                style: TextStyle(fontSize: 18, fontWeight: FontWeight.bold),
              ),
            ),
          ),
          Flexible(
            child: ListView.separated(
              shrinkWrap: true,
              itemCount: cart.lines.length,
              separatorBuilder: (_, __) => const Divider(height: 1),
              itemBuilder: (context, i) {
                final line = cart.lines[i];
                final negative = line.lineMarginMinor < 0;
                return ListTile(
                  dense: true,
                  title: Text('${line.displayName}  ×${line.qty}'),
                  subtitle: Text(
                    '${tr('register.revenueValue', {'value': Money.format(line.lineTotalMinor)})}'
                    '   ·   ${tr('register.costValue', {'value': Money.format(line.lineCostMinor)})}\n'
                    '${tr('register.eachMarginValue', {'value': Money.format(line.unitMarginMinor)})}'
                    '   (${_pct(line.unitMarginFraction)})',
                    style: TextStyle(color: scheme.onSurfaceVariant),
                  ),
                  isThreeLine: true,
                  trailing: Column(
                    mainAxisAlignment: MainAxisAlignment.center,
                    crossAxisAlignment: CrossAxisAlignment.end,
                    children: [
                      Text(
                        Money.format(line.lineMarginMinor),
                        style: TextStyle(
                          fontWeight: FontWeight.bold,
                          color: negative ? scheme.error : null,
                        ),
                      ),
                      Text(
                        _pct(line.marginFraction),
                        style: TextStyle(
                          fontSize: 12,
                          color:
                              negative ? scheme.error : scheme.onSurfaceVariant,
                        ),
                      ),
                    ],
                  ),
                );
              },
            ),
          ),
          const Divider(height: 1),
          Padding(
            padding: const EdgeInsets.all(16),
            child: Column(
              children: [
                _summaryRow(
                  context,
                  tr('register.revenue'),
                  Money.format(cart.totalMinor),
                ),
                const SizedBox(height: 4),
                _summaryRow(
                  context,
                  tr('register.cost'),
                  Money.format(cart.totalCostMinor),
                ),
                const SizedBox(height: 8),
                _summaryRow(
                  context,
                  tr('register.margin'),
                  '${Money.format(cart.totalMarginMinor)}'
                  '   (${_pct(cart.marginFraction)})',
                  emphasize: true,
                ),
              ],
            ),
          ),
        ],
      ),
    );
  }

  Widget _summaryRow(
    BuildContext context,
    String label,
    String value, {
    bool emphasize = false,
  }) {
    final style =
        emphasize
            ? const TextStyle(fontSize: 18, fontWeight: FontWeight.bold)
            : const TextStyle(fontSize: 15);
    return Row(
      children: [
        Text(label, style: style),
        const Spacer(),
        Text(value, style: style),
      ],
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
  late final String _clientOrderId =
      DateTime.now().microsecondsSinceEpoch.toString();
  Customer? _customer;
  bool _busy = false;
  String? _error;

  @override
  void dispose() {
    _tendered.dispose();
    super.dispose();
  }

  /// Signed cash balance: tendered − total. Positive is change owed back to the
  /// customer; negative is how much they still need to hand over.
  num get _balanceMinor => Money.parse(_tendered.text) - widget.cart.totalMinor;

  Future<void> _pickCustomer() async {
    final picked = await showModalBottomSheet<Customer>(
      context: context,
      isScrollControlled: true,
      showDragHandle: true,
      builder: (_) => const _CustomerPicker(),
    );
    // A sheet dismiss returns null (keep the current choice); the "Walk-in"
    // entry returns the sentinel below to actively clear it.
    if (picked == null) return;
    setState(() => _customer = identical(picked, _walkIn) ? null : picked);
  }

  Future<void> _submit({required bool onAccount}) async {
    if (_busy) return;
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      final tendered = Money.parse(_tendered.text);
      final total = widget.cart.totalMinor;
      // Change isn't a payment — record only the cash applied to the sale.
      final applied = tendered > total ? total : tendered;
      final result = await SyncService.instance.submitOrder(
        posSessionId: widget.session.id,
        customerId: _customer?.id,
        items: widget.cart.toOrderItemsInput(),
        payments: [
          if (applied > 0) {'method': 'cash', 'amountMinor': applied},
        ],
        totalMinor: total,
        // A queued on-account order the server later rejects (e.g. credit
        // limit) is silently dropped at flush — never queue a debt record.
        queueWhenOffline: !onAccount,
        clientOrderId: _clientOrderId,
      );
      if (mounted) {
        Navigator.pop(
          context,
          _CheckoutOutcome(
            result: result,
            customer: _customer,
            paidMinor: tendered > 0 ? tendered : null,
            onAccountMinor: onAccount ? total - applied : null,
          ),
        );
      }
    } on GraphQLAppException catch (e) {
      setState(() {
        if (onAccount && e.isNetworkError) {
          _error = tr('register.onAccountNeedsConnection');
        } else if (e.message.contains('CREDIT_LIMIT_EXCEEDED')) {
          _error = tr('register.creditLimitExceeded');
        } else {
          _error = e.message;
        }
      });
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    return AlertDialog(
      title: Text(tr('register.chargeTitle')),
      content: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          InkWell(
            onTap: _busy ? null : _pickCustomer,
            child: Padding(
              padding: const EdgeInsets.symmetric(vertical: 4),
              child: Row(
                children: [
                  const Icon(Icons.person_outline, size: 20),
                  const SizedBox(width: 8),
                  Expanded(
                    child: Text(
                      _customer?.name ?? tr('register.walkInCustomer'),
                      style: TextStyle(
                        color:
                            _customer == null
                                ? Theme.of(context).hintColor
                                : null,
                      ),
                    ),
                  ),
                  Text(
                    _customer == null
                        ? tr('register.add')
                        : tr('register.change'),
                    style: TextStyle(
                      color: Theme.of(context).colorScheme.primary,
                    ),
                  ),
                ],
              ),
            ),
          ),
          if (_customer != null)
            Padding(
              padding: const EdgeInsets.only(left: 28),
              child: Text(
                '${tr('register.balance', {'value': Money.format(_customer!.balanceMinor)})}'
                '${_customer!.creditLimitMinor != null ? '  ·  ${tr('register.creditLimit', {'value': Money.format(_customer!.creditLimitMinor!)})}' : ''}',
                style: TextStyle(
                  fontSize: 12,
                  color: Theme.of(context).hintColor,
                ),
              ),
            ),
          const Divider(),
          Row(
            children: [
              Text(tr('register.totalDue')),
              const Spacer(),
              Text(
                Money.format(widget.cart.totalMinor),
                style: const TextStyle(
                  fontSize: 20,
                  fontWeight: FontWeight.bold,
                ),
              ),
            ],
          ),
          const SizedBox(height: 12),
          TextField(
            controller: _tendered,
            autofocus: true,
            keyboardType: TextInputType.number,
            inputFormatters: [ThousandsSeparatorInputFormatter()],
            onChanged: (_) => setState(() {}),
            // Enter completes the sale, so the cashier never has to reach for
            // the mouse after counting cash. Same gate as the button: only
            // when the tendered cash covers the total.
            onSubmitted: (_) {
              if (!_busy && _balanceMinor >= 0) _submit(onAccount: false);
            },
            decoration: InputDecoration(
              labelText: tr('register.cashTendered'),
              border: const OutlineInputBorder(),
            ),
          ),
          const SizedBox(height: 8),
          Builder(
            builder: (context) {
              final balance = _balanceMinor;
              final settled = balance >= 0;
              final color =
                  settled
                      ? Theme.of(context).colorScheme.primary
                      : Theme.of(context).colorScheme.error;
              return Row(
                children: [
                  Text(
                    settled
                        ? tr('register.changeLabel')
                        : tr('register.stillDue'),
                  ),
                  const Spacer(),
                  Text(
                    Money.format(balance),
                    style: TextStyle(fontWeight: FontWeight.bold, color: color),
                  ),
                ],
              );
            },
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
          child: Text(tr('common.cancel')),
        ),
        // Under-tendered with a customer attached: the remainder can go on
        // their account (the server posts a sale_on_account ledger entry and
        // enforces the credit limit). Walk-ins must pay in full.
        if (_customer != null && _balanceMinor < 0)
          FilledButton.tonal(
            onPressed: _busy ? null : () => _submit(onAccount: true),
            child:
                _busy
                    ? const SizedBox(
                      height: 18,
                      width: 18,
                      child: CircularProgressIndicator(strokeWidth: 2),
                    )
                    : Text(
                      tr('register.putOnAccount', {
                        'amount': Money.format(-_balanceMinor),
                      }),
                    ),
          ),
        FilledButton(
          onPressed:
              _busy || _balanceMinor < 0
                  ? null
                  : () => _submit(onAccount: false),
          child:
              _busy && _balanceMinor >= 0
                  ? const SizedBox(
                    height: 18,
                    width: 18,
                    child: CircularProgressIndicator(strokeWidth: 2),
                  )
                  : Text(tr('register.completeSale')),
        ),
      ],
    );
  }
}

/// A confirmed sale's receipt data, retained so it can be printed (Ctrl+P) or
/// WhatsApp'd after the cart that produced it is cleared.
class _CompletedSale {
  _CompletedSale({
    required this.displayNumber,
    required this.lines,
    required this.totalMinor,
    required this.paidMinor,
    required this.onAccountMinor,
    required this.customer,
    required this.createdAt,
  });

  final String? displayNumber;
  final List<ReceiptLine> lines;
  final num totalMinor;
  final num? paidMinor;
  final num? onAccountMinor;
  final Customer? customer;
  final DateTime createdAt;
}

/// What a completed (or queued) checkout hands back: the submit result, the
/// attached customer (if any) and the cash tendered, so the register can offer
/// a receipt afterwards.
class _CheckoutOutcome {
  _CheckoutOutcome({
    required this.result,
    required this.customer,
    required this.paidMinor,
    required this.onAccountMinor,
  });

  final SubmitResult result;
  final Customer? customer;
  final num? paidMinor;

  /// The remainder charged to the customer's account; null when paid in full.
  final num? onAccountMinor;
}

/// The "Walk-in customer" sentinel the picker returns to clear an attached
/// customer (distinct from a null dismiss, which keeps the current choice).
final _walkIn = const Customer(id: '', name: 'Walk-in customer');

/// Searches active customers by name or phone so the cashier can attach one to
/// the sale. Returns the chosen [Customer], [_walkIn] to clear, or null on
/// dismiss. Online-only — needs the API, like the rest of checkout.
class _CustomerPicker extends StatefulWidget {
  const _CustomerPicker();

  @override
  State<_CustomerPicker> createState() => _CustomerPickerState();
}

class _CustomerPickerState extends State<_CustomerPicker> {
  final _controller = TextEditingController();
  Timer? _debounce;
  String _query = '';
  late Future<List<Customer>> _future = _search('');

  @override
  void dispose() {
    _debounce?.cancel();
    _controller.dispose();
    super.dispose();
  }

  Future<List<Customer>> _search(String term) async {
    final data = await GraphQLService.instance.query(
      Ops.posCustomerSearch,
      variables: {'search': term.isEmpty ? null : term, 'limit': 30},
    );
    return (data['posCustomerSearch'] as List<dynamic>)
        .map((c) => Customer.fromJson(c as Map<String, dynamic>))
        .toList();
  }

  void _onChanged(String text) {
    _debounce?.cancel();
    _debounce = Timer(const Duration(milliseconds: 250), () {
      setState(() {
        _query = text;
        _future = _search(text.trim());
      });
    });
  }

  @override
  Widget build(BuildContext context) {
    final bottomInset = MediaQuery.of(context).viewInsets.bottom;
    return Padding(
      padding: EdgeInsets.fromLTRB(16, 0, 16, 16 + bottomInset),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          TextField(
            controller: _controller,
            autofocus: true,
            onChanged: _onChanged,
            decoration: InputDecoration(
              prefixIcon: const Icon(Icons.search),
              hintText: tr('register.searchCustomerHint'),
              border: const OutlineInputBorder(),
            ),
          ),
          const SizedBox(height: 8),
          ListTile(
            leading: const Icon(Icons.person_off_outlined),
            title: Text(tr('register.walkInNoCustomer')),
            onTap: () => Navigator.pop(context, _walkIn),
          ),
          const Divider(height: 1),
          SizedBox(
            height: 280,
            child: FutureBuilder<List<Customer>>(
              future: _future,
              builder: (context, snapshot) {
                if (snapshot.connectionState != ConnectionState.done) {
                  return const Center(child: CircularProgressIndicator());
                }
                if (snapshot.hasError) {
                  return Center(child: Text(describeError(snapshot.error!)));
                }
                final results = snapshot.data!;
                if (results.isEmpty) {
                  return Center(
                    child: Text(
                      _query.isEmpty
                          ? tr('register.noCustomers')
                          : tr('register.noMatchingCustomers'),
                    ),
                  );
                }
                return ListView.separated(
                  itemCount: results.length,
                  separatorBuilder: (_, __) => const Divider(height: 1),
                  itemBuilder: (context, i) {
                    final c = results[i];
                    return ListTile(
                      title: Text(c.name),
                      subtitle: c.hasPhone ? Text(c.phone!) : null,
                      trailing:
                          c.hasPhone
                              ? const Icon(Icons.chat_outlined, size: 18)
                              : null,
                      onTap: () => Navigator.pop(context, c),
                    );
                  },
                );
              },
            ),
          ),
        ],
      ),
    );
  }
}
