import 'package:flutter/material.dart';

import '../graphql/graphql_service.dart';
import '../graphql/operations.dart';
import '../models/models.dart';
import '../widgets/common.dart';

/// Pick one stock location. Pops with the chosen [LocationNode].
///
/// Locations are hierarchical; each row shows its full path built from
/// parentId links (e.g. "Warehouse / Shelf A") so same-named children
/// stay distinguishable. A search box filters on the full path.
class LocationPickerScreen extends StatefulWidget {
  const LocationPickerScreen({super.key, required this.title});

  final String title;

  @override
  State<LocationPickerScreen> createState() => _LocationPickerScreenState();
}

class _LocationPickerScreenState extends State<LocationPickerScreen> {
  late Future<List<LocationNode>> _future;
  String _search = '';

  @override
  void initState() {
    super.initState();
    _future = _load();
  }

  Future<List<LocationNode>> _load() async {
    final data = await GraphQLService.instance.query(Ops.locations);
    return (data['locations'] as List<dynamic>)
        .map((l) => LocationNode.fromJson(l as Map<String, dynamic>))
        .toList();
  }

  /// Full path "Root / Child / Leaf" for each location id.
  Map<String, String> _buildPaths(List<LocationNode> nodes) {
    final byId = {for (final n in nodes) n.id: n};
    String pathOf(LocationNode n) {
      final segments = <String>[];
      LocationNode? cur = n;
      // Guard against a malformed parent cycle.
      var hops = 0;
      while (cur != null && hops < 32) {
        segments.insert(0, cur.name);
        cur = cur.parentId == null ? null : byId[cur.parentId];
        hops++;
      }
      return segments.join(' / ');
    }

    return {for (final n in nodes) n.id: pathOf(n)};
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: Text(widget.title)),
      body: FutureBuilder<List<LocationNode>>(
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
          final nodes = snapshot.data!;
          if (nodes.isEmpty) {
            return const Center(
                child: Text('No locations exist yet. '
                    'Create one in the console first.'));
          }
          final paths = _buildPaths(nodes);
          final sorted = [...nodes]
            ..sort((a, b) => paths[a.id]!.compareTo(paths[b.id]!));
          final query = _search.trim().toLowerCase();
          final terms = query.split(RegExp(r'\s+'));
          final visible = query.isEmpty
              ? sorted
              : sorted
                  .where((n) {
                    final path = paths[n.id]!.toLowerCase();
                    return terms.every((term) => path.contains(term));
                  })
                  .toList();
          return Column(
            children: [
              Padding(
                padding: const EdgeInsets.fromLTRB(16, 12, 16, 4),
                child: TextField(
                  autocorrect: false,
                  decoration: const InputDecoration(
                    prefixIcon: Icon(Icons.search),
                    hintText: 'Search locations',
                    border: OutlineInputBorder(),
                    isDense: true,
                  ),
                  onChanged: (v) => setState(() => _search = v),
                ),
              ),
              Expanded(
                child: visible.isEmpty
                    ? const Center(child: Text('No matching location'))
                    : ListView.separated(
                        itemCount: visible.length,
                        separatorBuilder: (_, __) => const Divider(height: 1),
                        itemBuilder: (context, i) {
                          final node = visible[i];
                          return ListTile(
                            minTileHeight: 64,
                            leading: const Icon(Icons.place_outlined),
                            title: Text(node.name,
                                style: const TextStyle(fontSize: 18)),
                            subtitle: paths[node.id] == node.name
                                ? null
                                : Text(paths[node.id]!),
                            onTap: () => Navigator.pop(context, node),
                          );
                        },
                      ),
              ),
            ],
          );
        },
      ),
    );
  }
}
