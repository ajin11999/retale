import 'package:flutter/material.dart';
import 'package:retale_workshop/schema/project.dart';
import 'package:retale_workshop/util/money.dart';
import 'package:retale_workshop/util/project_calc.dart';

/// Left-pane list of active (not-yet-uploaded) jobs, with a create button and
/// per-row pin toggle.
class JobList extends StatelessWidget {
  const JobList({
    super.key,
    required this.jobs,
    required this.selectedId,
    required this.onSelected,
    required this.onCreate,
    required this.onPin,
  });

  final List<Project> jobs;
  final int? selectedId;
  final ValueChanged<int> onSelected;
  final VoidCallback onCreate;
  final ValueChanged<int> onPin;

  @override
  Widget build(BuildContext context) {
    return Column(
      children: [
        ListTile(
          leading: const Icon(Icons.add),
          title: const Text('New job'),
          onTap: onCreate,
        ),
        const Divider(height: 1),
        Expanded(
          child: ListView.separated(
            itemCount: jobs.length,
            separatorBuilder: (_, __) => const Divider(height: 1),
            itemBuilder: (context, i) {
              final job = jobs[i];
              return ListTile(
                selected: job.id == selectedId,
                selectedTileColor: Theme.of(context)
                    .colorScheme
                    .primary
                    .withValues(alpha: 0.08),
                title: Text(job.label.isEmpty ? 'Unlabelled' : job.label),
                subtitle: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    if (job.vehicle.isNotEmpty)
                      Text(job.vehicle,
                          style: const TextStyle(fontSize: 11, color: Colors.grey)),
                    Text(formatMinor(linesTotalMinor(job.lines)),
                        style: const TextStyle(
                            fontSize: 12, fontWeight: FontWeight.bold)),
                  ],
                ),
                trailing: IconButton(
                  icon: Icon(job.isPinned ? Icons.star : Icons.star_border,
                      size: 20),
                  onPressed: () => onPin(job.id),
                ),
                onTap: () => onSelected(job.id),
              );
            },
          ),
        ),
      ],
    );
  }
}
