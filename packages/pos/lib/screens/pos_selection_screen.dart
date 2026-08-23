import 'package:flutter/material.dart';

import '../config/app_config.dart';
import '../graphql/graphql_service.dart';
import '../graphql/operations.dart';
import '../i18n/i18n_service.dart';
import '../models/pos.dart';
import '../widgets/common.dart';
import 'router_screen.dart';

/// Binds this device to one point of sale. Runs once per device (until reset).
class PosSelectionScreen extends StatefulWidget {
  const PosSelectionScreen({super.key});

  @override
  State<PosSelectionScreen> createState() => _PosSelectionScreenState();
}

class _PosSelectionScreenState extends State<PosSelectionScreen> {
  late Future<List<PointOfSale>> _future;

  @override
  void initState() {
    super.initState();
    _future = _load();
  }

  Future<List<PointOfSale>> _load() async {
    final data = await GraphQLService.instance.query(Ops.pointsOfSale);
    return (data['pointsOfSale'] as List<dynamic>)
        .map((p) => PointOfSale.fromJson(p as Map<String, dynamic>))
        .toList();
  }

  Future<void> _select(PointOfSale pos) async {
    await AppConfig.instance.setPosId(pos.id);
    if (mounted) RouterScreen.goHome(context);
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: Text(tr('posSelect.title'))),
      body: FutureBuilder<List<PointOfSale>>(
        future: _future,
        builder: (context, snapshot) {
          if (snapshot.connectionState != ConnectionState.done) {
            return const Center(child: CircularProgressIndicator());
          }
          if (snapshot.hasError) {
            return ErrorRetry(
              message: describeError(snapshot.error!),
              onRetry: () => setState(() => _future = _load()),
            );
          }
          final list = snapshot.data!;
          if (list.isEmpty) {
            return Center(
                child: Text(tr('posSelect.noPosAvailable')));
          }
          return ListView.separated(
            itemCount: list.length,
            separatorBuilder: (_, __) => const Divider(height: 1),
            itemBuilder: (context, i) => ListTile(
              leading: const Icon(Icons.point_of_sale),
              title: Text(list[i].name),
              subtitle: Text(list[i].code),
              onTap: () => _select(list[i]),
            ),
          );
        },
      ),
    );
  }
}
