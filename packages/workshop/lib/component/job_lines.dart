import 'package:flutter/material.dart';
import 'package:retale_workshop/component/line_dialogs.dart';
import 'package:retale_workshop/component/product_picker.dart';
import 'package:retale_workshop/schema/project.dart';
import 'package:retale_workshop/util/money.dart';
import 'package:retale_workshop/util/project_calc.dart';

/// The job's line tree: stock/service/open-price leaves, optionally grouped into
/// sections. Edits mutate the tree in place and report the whole root list via
/// [onChanged]; the parent persists it to Isar (the source of truth).
class JobLines extends StatelessWidget {
  const JobLines({
    super.key,
    required this.lines,
    required this.onChanged,
    this.readOnly = false,
  });

  final List<WorkLine> lines;
  final ValueChanged<List<WorkLine>> onChanged;
  final bool readOnly;

  Future<void> _addLeaf(BuildContext context, List<WorkLine> target) async {
    final variant = await pickCatalogVariant(context);
    if (variant == null || !context.mounted) return;
    final line = await showLeafEditor(context, variant: variant);
    if (line == null) return;
    target.add(line);
    onChanged(lines);
  }

  Future<void> _addGroup(BuildContext context) async {
    final label = await showGroupEditor(context);
    if (label == null || label.isEmpty) return;
    lines.add(WorkLine()
      ..isGroup = true
      ..snapshotName = label
      ..children = <WorkLine>[]);
    onChanged(lines);
  }

  Future<void> _editLeaf(BuildContext context, WorkLine leaf) async {
    final edited = await showLeafEditor(context, existing: leaf);
    if (edited == null) return;
    onChanged(lines);
  }

  Future<void> _renameGroup(BuildContext context, WorkLine group) async {
    final label = await showGroupEditor(context, initial: group.snapshotName);
    if (label == null || label.isEmpty) return;
    group.snapshotName = label;
    onChanged(lines);
  }

  void _delete(List<WorkLine> parent, WorkLine line) {
    parent.remove(line);
    onChanged(lines);
  }

  @override
  Widget build(BuildContext context) {
    return Card(
      child: Padding(
        padding: const EdgeInsets.all(8),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            ..._buildList(context, lines),
            if (lines.isEmpty)
              const Padding(
                padding: EdgeInsets.symmetric(vertical: 16),
                child: Center(child: Text('No lines yet.')),
              ),
            if (!readOnly) ...[
              const Divider(),
              Row(
                children: [
                  TextButton.icon(
                    onPressed: () => _addLeaf(context, lines),
                    icon: const Icon(Icons.add),
                    label: const Text('Add line'),
                  ),
                  TextButton.icon(
                    onPressed: () => _addGroup(context),
                    icon: const Icon(Icons.create_new_folder_outlined),
                    label: const Text('Add section'),
                  ),
                ],
              ),
            ],
          ],
        ),
      ),
    );
  }

  List<Widget> _buildList(BuildContext context, List<WorkLine> list,
      {int depth = 0}) {
    final widgets = <Widget>[];
    for (final line in list) {
      if (line.isGroup) {
        widgets.add(_groupHeader(context, list, line, depth));
        widgets.addAll(_buildList(context, line.children ?? [], depth: depth + 1));
      } else {
        widgets.add(_leafRow(context, list, line, depth));
      }
    }
    return widgets;
  }

  Widget _groupHeader(
      BuildContext context, List<WorkLine> parent, WorkLine group, int depth) {
    return Padding(
      padding: EdgeInsets.only(left: depth * 16.0, top: 8, bottom: 2),
      child: Row(
        children: [
          const Icon(Icons.folder_outlined, size: 18),
          const SizedBox(width: 6),
          Expanded(
            child: Text(group.snapshotName,
                style: const TextStyle(fontWeight: FontWeight.bold)),
          ),
          Text(formatMinor(linesTotalMinor(group.children)),
              style: const TextStyle(fontWeight: FontWeight.bold)),
          if (!readOnly) ...[
            IconButton(
              tooltip: 'Add line to section',
              icon: const Icon(Icons.add, size: 18),
              onPressed: () => _addLeaf(context, group.children ??= []),
            ),
            IconButton(
              tooltip: 'Rename section',
              icon: const Icon(Icons.edit, size: 16),
              onPressed: () => _renameGroup(context, group),
            ),
            IconButton(
              tooltip: 'Delete section',
              icon: const Icon(Icons.delete_outline, size: 18),
              onPressed: () => _delete(parent, group),
            ),
          ],
        ],
      ),
    );
  }

  Widget _leafRow(
      BuildContext context, List<WorkLine> parent, WorkLine leaf, int depth) {
    return Padding(
      padding: EdgeInsets.only(left: depth * 16.0, top: 2, bottom: 2),
      child: Row(
        children: [
          Expanded(
            flex: 5,
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(leaf.snapshotName),
                if (leaf.note.isNotEmpty)
                  Text(leaf.note,
                      style: const TextStyle(fontSize: 11, color: Colors.grey)),
              ],
            ),
          ),
          Expanded(
            flex: 3,
            child: Text(
              '${leaf.qty} × ${formatMinor(leaf.unitPriceMinor)}',
              textAlign: TextAlign.right,
              style: const TextStyle(fontSize: 12, color: Colors.black54),
            ),
          ),
          Expanded(
            flex: 2,
            child: Text(formatMinor(leaf.qty * leaf.unitPriceMinor),
                textAlign: TextAlign.right),
          ),
          if (!readOnly) ...[
            IconButton(
              icon: const Icon(Icons.edit, size: 16),
              onPressed: () => _editLeaf(context, leaf),
            ),
            IconButton(
              icon: const Icon(Icons.delete_outline, size: 18),
              onPressed: () => _delete(parent, leaf),
            ),
          ],
        ],
      ),
    );
  }
}
