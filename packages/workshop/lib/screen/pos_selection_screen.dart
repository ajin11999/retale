import 'package:flutter/material.dart';
import 'package:graphql_flutter/graphql_flutter.dart';
import 'package:retale_workshop/config.dart';
import 'package:retale_workshop/services/pos_service.dart';

/// Pick the register (POS) workshop sales land in. The chosen POS id is stored;
/// an open session is ensured lazily at submit time (Phase 5), so a register
/// without an open session is still selectable here.
class PosSelectionScreen extends StatefulWidget {
  const PosSelectionScreen({super.key, required this.onSelected});
  final VoidCallback onSelected;

  @override
  State<PosSelectionScreen> createState() => _PosSelectionScreenState();
}

class _PosSelectionScreenState extends State<PosSelectionScreen> {
  late Future<List<PosOption>> _future;

  PosService get _pos => PosService(GraphQLProvider.of(context).value);

  @override
  void initState() {
    super.initState();
    // GraphQLProvider isn't available in initState; defer one frame.
    _future = Future.value(const []);
    WidgetsBinding.instance.addPostFrameCallback((_) => _reload());
  }

  void _reload() => setState(() {
        _future = _pos.listPointsOfSale();
      });

  Future<void> _select(PosOption pos) async {
    await AppConfig.setPosId(pos.id);
    widget.onSelected();
  }

  Future<void> _signOut() async {
    await AppConfig.clearTokens();
    widget.onSelected(); // re-runs the gate → login
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        title: const Text('Select a register'),
        actions: [
          IconButton(
            tooltip: 'Sign out',
            onPressed: _signOut,
            icon: const Icon(Icons.logout),
          ),
        ],
      ),
      body: Center(
        child: SizedBox(
          width: 480,
          child: FutureBuilder<List<PosOption>>(
            future: _future,
            builder: (context, snapshot) {
              if (snapshot.connectionState == ConnectionState.waiting) {
                return const Center(child: CircularProgressIndicator());
              }
              if (snapshot.hasError) {
                return Column(
                  mainAxisAlignment: MainAxisAlignment.center,
                  children: [
                    Text('Error: ${snapshot.error}', textAlign: TextAlign.center),
                    const SizedBox(height: 12),
                    OutlinedButton(onPressed: _reload, child: const Text('Retry')),
                  ],
                );
              }
              final list = snapshot.data ?? const <PosOption>[];
              if (list.isEmpty) {
                return const Center(child: Text('No registers found.'));
              }
              return ListView.separated(
                shrinkWrap: true,
                itemCount: list.length,
                separatorBuilder: (_, __) => const Divider(height: 1),
                itemBuilder: (context, i) {
                  final pos = list[i];
                  return ListTile(
                    leading: const Icon(Icons.point_of_sale),
                    title: Text(pos.name),
                    subtitle: Text(pos.code),
                    trailing: const Icon(Icons.chevron_right),
                    onTap: () => _select(pos),
                  );
                },
              );
            },
          ),
        ),
      ),
    );
  }
}
