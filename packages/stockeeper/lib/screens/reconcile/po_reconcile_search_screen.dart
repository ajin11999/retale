import 'package:flutter/material.dart';
import 'package:intl/intl.dart';

import '../../graphql/graphql_service.dart';
import '../../graphql/operations.dart';
import '../../models/models.dart';
import '../../widgets/common.dart';
import 'po_reconcile_screen.dart';

/// PO search screen for Read-Only simulation reconciliation.
/// Displays POs (open, complete, all) and allows staff to search and select
/// a PO to perform in-memory count reconciliation.
class PoReconcileSearchScreen extends StatefulWidget {
  const PoReconcileSearchScreen({super.key});

  @override
  State<PoReconcileSearchScreen> createState() =>
      _PoReconcileSearchScreenState();
}

class _PoReconcileSearchScreenState extends State<PoReconcileSearchScreen> {
  late Future<List<PurchaseSummary>> _future;
  final TextEditingController _searchController = TextEditingController();
  String _searchQuery = '';
  String _statusFilter = 'all'; // 'all', 'open', 'complete'

  @override
  void initState() {
    super.initState();
    _future = _load();
  }

  @override
  void dispose() {
    _searchController.dispose();
    super.dispose();
  }

  Future<List<PurchaseSummary>> _load() async {
    final data = await GraphQLService.instance.query(Ops.allPurchases);
    return (data['purchases'] as List<dynamic>)
        .map((p) => PurchaseSummary.fromJson(p as Map<String, dynamic>))
        .toList();
  }

  void _refresh() => setState(() => _future = _load());

  String _fmtDate(String iso) {
    final parsed = DateTime.tryParse(iso);
    return parsed == null ? iso : DateFormat('yyyy-MM-dd').format(parsed);
  }

  Widget _buildStatusChip(String status) {
    Color bg;
    Color fg;
    String label = status.toUpperCase();

    switch (status.toLowerCase()) {
      case 'open':
        bg = Colors.green.shade100;
        fg = Colors.green.shade900;
        break;
      case 'complete':
        bg = Colors.blue.shade100;
        fg = Colors.blue.shade900;
        break;
      case 'cancelled':
        bg = Colors.grey.shade200;
        fg = Colors.grey.shade800;
        break;
      default:
        bg = Colors.grey.shade200;
        fg = Colors.grey.shade800;
    }

    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 2),
      decoration: BoxDecoration(
        color: bg,
        borderRadius: BorderRadius.circular(4),
      ),
      child: Text(
        label,
        style: TextStyle(
          fontSize: 11,
          fontWeight: FontWeight.bold,
          color: fg,
        ),
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Scaffold(
      appBar: AppBar(
        title: const Text('Reconcile PO (Simulation)'),
        bottom: PreferredSize(
          preferredSize: const Size.fromHeight(116),
          child: Column(
            children: [
              Padding(
                padding: const EdgeInsets.fromLTRB(16, 0, 16, 8),
                child: TextField(
                  controller: _searchController,
                  autocorrect: false,
                  decoration: InputDecoration(
                    prefixIcon: const Icon(Icons.search),
                    suffixIcon: _searchQuery.isNotEmpty
                        ? IconButton(
                            icon: const Icon(Icons.clear),
                            onPressed: () {
                              _searchController.clear();
                              setState(() => _searchQuery = '');
                            },
                          )
                        : null,
                    hintText: 'Search POs by vendor, ID, or date...',
                    border: const OutlineInputBorder(),
                    isDense: true,
                  ),
                  onChanged: (v) => setState(() => _searchQuery = v.trim().toLowerCase()),
                ),
              ),
              Padding(
                padding: const EdgeInsets.symmetric(horizontal: 16),
                child: Row(
                  children: [
                    FilterChip(
                      label: const Text('All'),
                      selected: _statusFilter == 'all',
                      onSelected: (_) => setState(() => _statusFilter = 'all'),
                    ),
                    const SizedBox(width: 8),
                    FilterChip(
                      label: const Text('Open'),
                      selected: _statusFilter == 'open',
                      onSelected: (_) => setState(() => _statusFilter = 'open'),
                    ),
                    const SizedBox(width: 8),
                    FilterChip(
                      label: const Text('Complete'),
                      selected: _statusFilter == 'complete',
                      onSelected: (_) => setState(() => _statusFilter = 'complete'),
                    ),
                  ],
                ),
              ),
              const SizedBox(height: 8),
            ],
          ),
        ),
      ),
      body: FutureBuilder<List<PurchaseSummary>>(
        future: _future,
        builder: (context, snapshot) {
          if (snapshot.connectionState != ConnectionState.done) {
            return const Center(child: CircularProgressIndicator());
          }
          if (snapshot.hasError) {
            return ErrorRetry(
              message: describeError(snapshot.error!),
              onRetry: _refresh,
            );
          }
          final purchases = snapshot.data!;
          if (purchases.isEmpty) {
            return const Center(child: Text('No purchase orders found.'));
          }

          final filtered = purchases.where((p) {
            if (_statusFilter != 'all' && p.status.toLowerCase() != _statusFilter) {
              return false;
            }
            if (_searchQuery.isEmpty) return true;

            final vendor = p.vendorName.toLowerCase();
            final id = p.id.toLowerCase();
            final date = p.date.toLowerCase();
            return vendor.contains(_searchQuery) ||
                id.contains(_searchQuery) ||
                date.contains(_searchQuery);
          }).toList();

          if (filtered.isEmpty) {
            return const Center(child: Text('No matching purchase orders.'));
          }

          return RefreshIndicator(
            onRefresh: () async => _refresh(),
            child: ListView.separated(
              physics: const AlwaysScrollableScrollPhysics(),
              itemCount: filtered.length,
              separatorBuilder: (_, __) => const Divider(height: 1),
              itemBuilder: (context, i) {
                final p = filtered[i];
                final ordered = p.totalOrdered;
                final delivered = p.totalDelivered;
                return ListTile(
                  minTileHeight: 84,
                  leading: const Icon(Icons.receipt_long, size: 32),
                  title: Row(
                    children: [
                      Expanded(
                        child: Text(
                          p.vendorName,
                          style: const TextStyle(
                            fontSize: 17,
                            fontWeight: FontWeight.w600,
                          ),
                          overflow: TextOverflow.ellipsis,
                        ),
                      ),
                      const SizedBox(width: 8),
                      _buildStatusChip(p.status),
                    ],
                  ),
                  subtitle: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      const SizedBox(height: 4),
                      Text(
                        '${_fmtDate(p.date)} · $delivered of $ordered delivered',
                        style: TextStyle(color: theme.colorScheme.onSurfaceVariant),
                      ),
                      const SizedBox(height: 6),
                      LinearProgressIndicator(
                        value: ordered <= 0
                            ? 0
                            : (delivered / ordered).clamp(0.0, 1.0),
                        minHeight: 6,
                        borderRadius: BorderRadius.circular(3),
                      ),
                    ],
                  ),
                  trailing: const Icon(Icons.chevron_right),
                  onTap: () {
                    Navigator.of(context).push(MaterialPageRoute(
                      builder: (_) => PoReconcileScreen(purchase: p),
                    ));
                  },
                );
              },
            ),
          );
        },
      ),
    );
  }
}
