import 'dart:async';

import 'package:flutter/material.dart';
import 'package:retale_workshop/component/job_list.dart';
import 'package:retale_workshop/config.dart';
import 'package:retale_workshop/graphql/client.dart';
import 'package:retale_workshop/schema/project.dart';
import 'package:retale_workshop/screen/job_sheet.dart';
import 'package:retale_workshop/services/catalog_repo.dart';
import 'package:retale_workshop/services/project_repo.dart';

/// Two-pane workshop shell: active jobs on the left, the selected job sheet on
/// the right.
class WorkshopHome extends StatefulWidget {
  const WorkshopHome({super.key, required this.posId, required this.onSignOut});
  final String posId;
  final VoidCallback onSignOut;

  @override
  State<WorkshopHome> createState() => _WorkshopHomeState();
}

class _WorkshopHomeState extends State<WorkshopHome> {
  final _repo = ProjectRepo();
  final _catalog = CatalogRepo();
  StreamSubscription<List<Project>>? _sub;
  List<Project> _jobs = const [];
  int? _selectedId;
  bool _syncing = false;

  @override
  void initState() {
    super.initState();
    // Live active-jobs list: sembast fires immediately with the current set,
    // then on every change.
    _sub = _repo.watchActive().listen((jobs) {
      if (mounted) setState(() => _jobs = jobs);
    });
    // Refresh the offline product cache while we (presumably) have the network.
    // Best-effort: if offline, line entry keeps using the last cached catalog.
    _syncCatalog(manual: false);
  }

  /// Pull the latest catalog into the local cache so product search works
  /// offline. Silent on the startup pass; reports outcome on a manual refresh.
  Future<void> _syncCatalog({required bool manual}) async {
    if (_syncing) return;
    if (mounted) setState(() => _syncing = true);
    try {
      await _catalog.sync(AppGraphQL.notifier.value);
      if (manual && mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          const SnackBar(content: Text('Catalog updated.')),
        );
      }
    } catch (e) {
      // Offline / API error — keep the existing cache; search still works from
      // it. Only surface the failure when the user asked for a refresh.
      if (manual && mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(
            backgroundColor: Theme.of(context).colorScheme.errorContainer,
            content: Text('Catalog not refreshed (offline?): $e'),
          ),
        );
      }
    } finally {
      if (mounted) setState(() => _syncing = false);
    }
  }

  @override
  void dispose() {
    _sub?.cancel();
    super.dispose();
  }

  Future<void> _create() async {
    final p = await _repo.create();
    if (mounted) setState(() => _selectedId = p.id);
  }

  Future<void> _changePos() async {
    await AppConfig.clearPosId();
    widget.onSignOut(); // re-runs the gate → POS selection
  }

  Future<void> _signOut() async {
    await AppConfig.clearTokens();
    widget.onSignOut();
  }

  @override
  Widget build(BuildContext context) {
    final selectionExists = _jobs.any((j) => j.id == _selectedId);
    final selectedId = selectionExists ? _selectedId : null;

    return Scaffold(
      appBar: AppBar(
        leading: Padding(
          padding: const EdgeInsets.all(10),
          child: Image.asset('assets/logo.png'),
        ),
        title: const Text('Retale Workshop'),
        actions: [
          IconButton(
            tooltip: 'Refresh product catalog',
            onPressed: _syncing ? null : () => _syncCatalog(manual: true),
            icon: _syncing
                ? const SizedBox(
                    width: 20,
                    height: 20,
                    child: CircularProgressIndicator(strokeWidth: 2),
                  )
                : const Icon(Icons.sync),
          ),
          IconButton(
            tooltip: 'Change register',
            onPressed: _changePos,
            icon: const Icon(Icons.point_of_sale),
          ),
          IconButton(
            tooltip: 'Sign out',
            onPressed: _signOut,
            icon: const Icon(Icons.logout),
          ),
        ],
      ),
      body: Row(
        children: [
          SizedBox(
            width: 280,
            child: JobList(
              jobs: _jobs,
              selectedId: selectedId,
              onSelected: (id) => setState(() => _selectedId = id),
              onCreate: _create,
              onPin: (id) => _repo.togglePin(id),
            ),
          ),
          const VerticalDivider(width: 1),
          Expanded(
            child: Container(
              color: Theme.of(context).colorScheme.surfaceContainerLowest,
              child: selectedId == null
                  ? const Center(child: Text('Select or create a job.'))
                  : JobSheet(
                      key: ValueKey(selectedId),
                      projectId: selectedId,
                      posId: widget.posId,
                      onDeleted: () => setState(() => _selectedId = null),
                    ),
            ),
          ),
        ],
      ),
    );
  }
}
