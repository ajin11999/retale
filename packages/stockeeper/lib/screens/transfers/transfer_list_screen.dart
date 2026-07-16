import 'package:flutter/material.dart';
import 'package:intl/intl.dart';

import '../../graphql/graphql_service.dart';
import '../../graphql/operations.dart';
import '../../models/models.dart';
import '../../widgets/common.dart';
import 'transfer_receive_screen.dart';

class TransferListScreen extends StatefulWidget {
  const TransferListScreen({super.key});

  @override
  State<TransferListScreen> createState() => _TransferListScreenState();
}

class _TransferListScreenState extends State<TransferListScreen> {
  late Future<List<TransferSummary>> _future;
  Map<String, LocationNode>? _locations;

  @override
  void initState() {
    super.initState();
    _future = _load();
  }

  Future<List<TransferSummary>> _load() async {
    final locData = await GraphQLService.instance.query(Ops.locations);
    final locs = (locData['locations'] as List<dynamic>)
        .map((l) => LocationNode.fromJson(l as Map<String, dynamic>))
        .toList();
    _locations = { for (var l in locs) l.id: l };

    final data = await GraphQLService.instance.query(Ops.openTransfers);
    return (data['stockTransfers'] as List<dynamic>)
        .map((t) => TransferSummary.fromJson(t as Map<String, dynamic>))
        .where((t) => t.status == 'in_transit')
        .toList();
  }

  void _refresh() => setState(() => _future = _load());

  void _open(TransferSummary transfer) async {
    await Navigator.of(context).push(MaterialPageRoute(
      builder: (_) => TransferReceiveScreen(
        transfer: transfer,
        sourceLocation: _locations?[transfer.sourceLocationId]?.name ?? 'Source',
        targetLocation: _locations?[transfer.targetLocationId]?.name ?? 'Target',
      ),
    ));
    _refresh();
  }

  String _fmtDate(String iso) {
    final parsed = DateTime.tryParse(iso);
    return parsed == null ? iso : DateFormat('yyyy-MM-dd').format(parsed);
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('Receiving — Transfers')),
      body: FutureBuilder<List<TransferSummary>>(
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
          final transfers = snapshot.data!;
          if (transfers.isEmpty) {
            return const Center(child: Text('No in-transit transfers.'));
          }
          return RefreshIndicator(
            onRefresh: () async => _refresh(),
            child: ListView.separated(
              physics: const AlwaysScrollableScrollPhysics(),
              itemCount: transfers.length,
              separatorBuilder: (_, __) => const Divider(height: 1),
              itemBuilder: (context, i) {
                final t = transfers[i];
                final source = _locations?[t.sourceLocationId]?.name ?? 'Unknown';
                final target = _locations?[t.targetLocationId]?.name ?? 'Unknown';
                return ListTile(
                  minTileHeight: 80,
                  leading: const Icon(Icons.local_shipping, size: 32),
                  title: Text('$source → $target',
                      style: const TextStyle(
                          fontSize: 16, fontWeight: FontWeight.w600)),
                  subtitle: Text('${_fmtDate(t.createdAt)}\n${t.items.length} items'),
                  isThreeLine: true,
                  trailing: const Icon(Icons.chevron_right),
                  onTap: () => _open(t),
                );
              },
            ),
          );
        },
      ),
    );
  }
}
