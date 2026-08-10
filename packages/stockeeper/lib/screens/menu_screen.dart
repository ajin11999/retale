import 'package:flutter/material.dart';

import '../auth/auth_service.dart';
import '../models/models.dart';
import 'location_picker_screen.dart';
import 'receiving/po_list_screen.dart';
import 'reconcile/po_reconcile_search_screen.dart';
import 'reconcile/reconcile_screen.dart';
import 'router_screen.dart';
import 'transfers/transfer_list_screen.dart';

/// Home: main operational buttons (Receiving goods/transfers & Reconcile location)
/// plus a secondary section with separator for read-only simulation (Reconcile PO).
class MenuScreen extends StatelessWidget {
  const MenuScreen({super.key});

  Future<void> _logout(BuildContext context) async {
    final confirmed = await showDialog<bool>(
      context: context,
      builder: (context) => AlertDialog(
        title: const Text('Log out?'),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(context, false),
            child: const Text('Cancel'),
          ),
          FilledButton(
            onPressed: () => Navigator.pop(context, true),
            child: const Text('Log out'),
          ),
        ],
      ),
    );
    if (confirmed != true) return;
    await AuthService.instance.logout();
    if (context.mounted) RouterScreen.goHome(context);
  }

  Future<void> _openReconcile(BuildContext context) async {
    final location = await Navigator.of(context).push<LocationNode>(
      MaterialPageRoute(
        builder: (_) => const LocationPickerScreen(
          title: 'Count which location?',
        ),
      ),
    );
    if (location == null || !context.mounted) return;
    Navigator.of(context).push(MaterialPageRoute(
      builder: (_) => ReconcileScreen(location: location),
    ));
  }

  @override
  Widget build(BuildContext context) {
    final user = AuthService.instance.currentUser;
    final theme = Theme.of(context);
    return Scaffold(
      appBar: AppBar(
        title: const Text('Retale Stockeeper'),
        actions: [
          IconButton(
            tooltip: 'Log out',
            icon: const Icon(Icons.logout),
            onPressed: () => _logout(context),
          ),
        ],
      ),
      body: SingleChildScrollView(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            if (user != null) ...[
              Text('Hi, ${user.name}',
                  style: theme.textTheme.titleMedium),
              const SizedBox(height: 16),
            ],
            _MenuButton(
              icon: Icons.move_to_inbox,
              title: 'Receive POs',
              subtitle: 'Count incoming goods against a purchase order',
              onTap: () => Navigator.of(context).push(MaterialPageRoute(
                builder: (_) => const PoListScreen(),
              )),
            ),
            const SizedBox(height: 14),
            _MenuButton(
              icon: Icons.local_shipping,
              title: 'Receive Transfers',
              subtitle: 'Scan and receive an incoming stock transfer',
              onTap: () => Navigator.of(context).push(MaterialPageRoute(
                builder: (_) => const TransferListScreen(),
              )),
            ),
            const SizedBox(height: 14),
            _MenuButton(
              icon: Icons.fact_check,
              title: 'Reconcile',
              subtitle: 'Count what is physically at a location',
              onTap: () => _openReconcile(context),
            ),
            const SizedBox(height: 20),

            // ── Separator & Read-Only Simulation Section ───────────────────
            Row(
              children: [
                const Expanded(child: Divider()),
                Padding(
                  padding: const EdgeInsets.symmetric(horizontal: 12),
                  child: Text(
                    'READ-ONLY SIMULATION',
                    style: TextStyle(
                      fontSize: 12,
                      fontWeight: FontWeight.bold,
                      letterSpacing: 1.0,
                      color: theme.colorScheme.outline,
                    ),
                  ),
                ),
                const Expanded(child: Divider()),
              ],
            ),
            const SizedBox(height: 12),

            // Secondary / Read-only simulation menu item
            Card(
              elevation: 0,
              color: theme.colorScheme.surfaceContainerLow,
              shape: RoundedRectangleBorder(
                borderRadius: BorderRadius.circular(16),
                side: BorderSide(color: theme.colorScheme.outlineVariant),
              ),
              child: ListTile(
                contentPadding:
                    const EdgeInsets.symmetric(horizontal: 16, vertical: 8),
                leading: Container(
                  padding: const EdgeInsets.all(10),
                  decoration: BoxDecoration(
                    color: theme.colorScheme.secondaryContainer,
                    borderRadius: BorderRadius.circular(12),
                  ),
                  child: Icon(
                    Icons.find_in_page_outlined,
                    color: theme.colorScheme.onSecondaryContainer,
                    size: 28,
                  ),
                ),
                title: const Text(
                  'Reconcile PO',
                  style: TextStyle(fontSize: 18, fontWeight: FontWeight.bold),
                ),
                subtitle: const Text(
                  'Search POs to reconcile in state memory (No edit effect)',
                  style: TextStyle(fontSize: 13),
                ),
                trailing: const Icon(Icons.chevron_right),
                onTap: () => Navigator.of(context).push(MaterialPageRoute(
                  builder: (_) => const PoReconcileSearchScreen(),
                )),
              ),
            ),
          ],
        ),
      ),
    );
  }
}

class _MenuButton extends StatelessWidget {
  const _MenuButton({
    required this.icon,
    required this.title,
    required this.subtitle,
    required this.onTap,
  });

  final IconData icon;
  final String title;
  final String subtitle;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    return Card(
      color: scheme.primaryContainer,
      clipBehavior: Clip.antiAlias,
      child: InkWell(
        onTap: onTap,
        child: Padding(
          padding: const EdgeInsets.symmetric(vertical: 20, horizontal: 20),
          child: Column(
            mainAxisAlignment: MainAxisAlignment.center,
            children: [
              Icon(icon, size: 52, color: scheme.onPrimaryContainer),
              const SizedBox(height: 12),
              Text(title,
                  style: TextStyle(
                    fontSize: 24,
                    fontWeight: FontWeight.bold,
                    color: scheme.onPrimaryContainer,
                  )),
              const SizedBox(height: 6),
              Text(subtitle,
                  textAlign: TextAlign.center,
                  style: TextStyle(
                    fontSize: 14,
                    color: scheme.onPrimaryContainer,
                  )),
            ],
          ),
        ),
      ),
    );
  }
}
