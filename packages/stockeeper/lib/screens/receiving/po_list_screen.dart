import 'package:flutter/material.dart';
import 'package:intl/intl.dart';

import '../../graphql/graphql_service.dart';
import '../../graphql/operations.dart';
import '../../models/models.dart';
import '../../widgets/common.dart';
import '../location_picker_screen.dart';
import 'receiving_screen.dart';

/// Open purchase orders to receive against. Tapping one resumes its open
/// draft check if there is one (skipping the location pick), otherwise asks
/// for the target location and starts a fresh check.
class PoListScreen extends StatefulWidget {
  const PoListScreen({super.key});

  @override
  State<PoListScreen> createState() => _PoListScreenState();
}

class _PoListScreenState extends State<PoListScreen> {
  late Future<List<PurchaseSummary>> _future;
  bool _opening = false;

  @override
  void initState() {
    super.initState();
    _future = _load();
  }

  Future<List<PurchaseSummary>> _load() async {
    final data = await GraphQLService.instance.query(Ops.openPurchases);
    return (data['purchases'] as List<dynamic>)
        .map((p) => PurchaseSummary.fromJson(p as Map<String, dynamic>))
        .toList();
  }

  void _refresh() => setState(() => _future = _load());

  Future<void> _open(PurchaseSummary purchase) async {
    if (_opening) return;
    setState(() => _opening = true);
    try {
      final data = await GraphQLService.instance
          .query(Ops.openReceivingCheck, variables: {'purchaseId': purchase.id});
      final open = data['openReceivingCheck'] as Map<String, dynamic>?;
      if (!mounted) return;

      ReceivingCheck? check =
          open == null ? null : ReceivingCheck.fromJson(open);
      if (check == null) {
        // No draft yet: pick where the goods go, then start the check.
        final location = await Navigator.of(context).push<LocationNode>(
          MaterialPageRoute(
            builder: (_) => const LocationPickerScreen(
              title: 'Receive into which location?',
            ),
          ),
        );
        if (location == null || !mounted) return;
        final started = await GraphQLService.instance.mutate(
          Ops.startReceivingCheck,
          variables: {
            'purchaseId': purchase.id,
            'targetLocationId': location.id,
          },
        );
        check = ReceivingCheck.fromJson(
            started['startReceivingCheck'] as Map<String, dynamic>);
      }
      if (!mounted) return;
      await Navigator.of(context).push(MaterialPageRoute(
        builder: (_) => ReceivingScreen(purchase: purchase, check: check!),
      ));
      if (mounted) _refresh();
    } catch (e) {
      if (mounted) {
        ScaffoldMessenger.of(context)
            .showSnackBar(SnackBar(content: Text(describeError(e))));
      }
    } finally {
      if (mounted) setState(() => _opening = false);
    }
  }

  String _fmtDate(String iso) {
    final parsed = DateTime.tryParse(iso);
    return parsed == null ? iso : DateFormat('yyyy-MM-dd').format(parsed);
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('Receiving — open POs')),
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
            return const Center(child: Text('No open purchase orders.'));
          }
          return RefreshIndicator(
            onRefresh: () async => _refresh(),
            child: ListView.separated(
              physics: const AlwaysScrollableScrollPhysics(),
              itemCount: purchases.length,
              separatorBuilder: (_, __) => const Divider(height: 1),
              itemBuilder: (context, i) {
                final p = purchases[i];
                final ordered = p.totalOrdered;
                final delivered = p.totalDelivered;
                return ListTile(
                  minTileHeight: 80,
                  leading: const Icon(Icons.receipt_long, size: 32),
                  title: Text(p.vendorName,
                      style: const TextStyle(
                          fontSize: 18, fontWeight: FontWeight.w600)),
                  subtitle: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text('${_fmtDate(p.date)} · '
                          '$delivered of $ordered received'),
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
                  onTap: () => _open(p),
                );
              },
            ),
          );
        },
      ),
    );
  }
}
