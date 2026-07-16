import 'package:flutter/material.dart';

import '../auth/auth_service.dart';
import '../models/models.dart';
import 'location_picker_screen.dart';
import 'receiving/po_list_screen.dart';
import 'reconcile/reconcile_screen.dart';
import 'router_screen.dart';
import 'transfers/transfer_list_screen.dart';

/// Home: two big buttons mirroring the warehouse workflow — Receiving
/// (count goods against an open PO) and Reconcile (count a location).
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
      body: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            if (user != null) ...[
              Text('Hi, ${user.name}',
                  style: Theme.of(context).textTheme.titleMedium),
              const SizedBox(height: 16),
            ],
            Expanded(
              child: _MenuButton(
                icon: Icons.move_to_inbox,
                title: 'Receive POs',
                subtitle: 'Count incoming goods against a purchase order',
                onTap: () => Navigator.of(context).push(MaterialPageRoute(
                  builder: (_) => const PoListScreen(),
                )),
              ),
            ),
            const SizedBox(height: 16),
            Expanded(
              child: _MenuButton(
                icon: Icons.local_shipping,
                title: 'Receive Transfers',
                subtitle: 'Scan and receive an incoming stock transfer',
                onTap: () => Navigator.of(context).push(MaterialPageRoute(
                  builder: (_) => const TransferListScreen(),
                )),
              ),
            ),
            const SizedBox(height: 16),
            Expanded(
              child: _MenuButton(
                icon: Icons.fact_check,
                title: 'Reconcile',
                subtitle: 'Count what is physically at a location',
                onTap: () => _openReconcile(context),
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
          padding: const EdgeInsets.all(24),
          child: Column(
            mainAxisAlignment: MainAxisAlignment.center,
            children: [
              Icon(icon, size: 64, color: scheme.onPrimaryContainer),
              const SizedBox(height: 16),
              Text(title,
                  style: TextStyle(
                    fontSize: 28,
                    fontWeight: FontWeight.bold,
                    color: scheme.onPrimaryContainer,
                  )),
              const SizedBox(height: 8),
              Text(subtitle,
                  textAlign: TextAlign.center,
                  style: TextStyle(
                    fontSize: 15,
                    color: scheme.onPrimaryContainer,
                  )),
            ],
          ),
        ),
      ),
    );
  }
}
