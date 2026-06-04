import 'dart:async';

import 'package:flutter/material.dart';
import 'package:retale_workshop/component/job_list.dart';
import 'package:retale_workshop/config.dart';
import 'package:retale_workshop/schema/project.dart';
import 'package:retale_workshop/screen/job_sheet.dart';
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
  StreamSubscription<List<Project>>? _sub;
  List<Project> _jobs = const [];
  int? _selectedId;

  @override
  void initState() {
    super.initState();
    final query = _repo.activeQuery();
    query.findAll().then((jobs) {
      if (mounted) setState(() => _jobs = jobs);
    });
    _sub = query.watch(fireImmediately: true).listen((jobs) {
      if (mounted) setState(() => _jobs = jobs);
    });
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
        title: const Text('Retale Workshop'),
        actions: [
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
