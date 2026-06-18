import 'package:flutter/material.dart';
import 'package:retale_workshop/component/inline_line_forms.dart';
import 'package:retale_workshop/component/line_dialogs.dart';
import 'package:retale_workshop/component/margin_pill.dart';
import 'package:retale_workshop/schema/project.dart';
import 'package:retale_workshop/util/money.dart';
import 'package:retale_workshop/util/project_calc.dart';

/// The job's line tree: stock/service/open-price leaves, optionally grouped into
/// sections. Edits mutate the tree in place and report the whole root list via
/// [onChanged]; the parent persists it to the local store (the source of truth).
///
/// Adding a line or section happens through an inline form rendered in place
/// (at the bottom of the card, or under the target section); editing an
/// existing line/section still uses dialogs.
///
/// When editable, each level is a [ReorderableListView] so lines can be
/// drag-reordered among their siblings (top-level items among themselves, a
/// section's children among themselves). Order is implicit in list position, so
/// a reorder is just a list mutation followed by [onChanged] — no schema change.
class JobLines extends StatefulWidget {
  const JobLines({
    super.key,
    required this.lines,
    required this.onChanged,
    this.readOnly = false,
  });

  final List<WorkLine> lines;
  final ValueChanged<List<WorkLine>> onChanged;
  final bool readOnly;

  @override
  State<JobLines> createState() => _JobLinesState();
}

class _JobLinesState extends State<JobLines> {
  /// Which inline add form is open. The leaf form targets either the top level
  /// (null index) or a top-level section by its index — sections only ever
  /// live at the top level, and an index survives the store reload that
  /// follows a save where an object reference would not.
  bool _leafFormOpen = false;
  int? _leafFormGroupIndex;
  bool _groupFormOpen = false;

  /// Collapsed sections, by top-level index (same identity scheme as the leaf
  /// form target — survives the store reload after a save). Remapped on
  /// top-level delete/reorder so the right section stays collapsed.
  final Set<int> _collapsed = {};

  List<WorkLine> get _lines => widget.lines;

  void _toggleCollapsed(int index) => setState(() {
        if (!_collapsed.remove(index)) _collapsed.add(index);
      });

  void _openLeafForm(int? groupIndex) => setState(() {
        _leafFormOpen = true;
        _leafFormGroupIndex = groupIndex;
        _groupFormOpen = false;
        // The form renders under the section's rows; surface it.
        if (groupIndex != null) _collapsed.remove(groupIndex);
      });

  void _openGroupForm() => setState(() {
        _groupFormOpen = true;
        _leafFormOpen = false;
        _leafFormGroupIndex = null;
      });

  void _closeForms() => setState(() {
        _leafFormOpen = false;
        _leafFormGroupIndex = null;
        _groupFormOpen = false;
      });

  void _submitLeaf(WorkLine line) {
    final i = _leafFormGroupIndex;
    var target = _lines;
    if (i != null && i < _lines.length && _lines[i].isGroup) {
      target = _lines[i].children ??= [];
    }
    target.add(line);
    _closeForms();
    widget.onChanged(_lines);
  }

  void _submitGroup(String label) {
    _lines.add(WorkLine()
      ..isGroup = true
      ..snapshotName = label
      ..children = <WorkLine>[]);
    _closeForms();
    widget.onChanged(_lines);
  }

  Future<void> _editLeaf(BuildContext context, WorkLine leaf) async {
    final edited = await showLeafEditor(context, existing: leaf);
    if (edited == null) return;
    widget.onChanged(_lines);
  }

  Future<void> _renameGroup(BuildContext context, WorkLine group) async {
    final label = await showGroupEditor(context, initial: group.snapshotName);
    if (label == null || label.isEmpty) return;
    group.snapshotName = label;
    widget.onChanged(_lines);
  }

  void _delete(List<WorkLine> parent, WorkLine line) {
    final index = parent.indexOf(line);
    parent.remove(line);
    if (identical(parent, _lines) && index >= 0) {
      _replaceCollapsed((i) => i == index ? null : (i > index ? i - 1 : i));
    }
    // Indices shift; drop any open form rather than retarget it.
    _closeForms();
    widget.onChanged(_lines);
  }

  void _reorder(List<WorkLine> list, int oldIndex, int newIndex) {
    if (newIndex > oldIndex) newIndex--;
    final moved = list.removeAt(oldIndex);
    list.insert(newIndex, moved);
    if (identical(list, _lines)) {
      _replaceCollapsed((i) {
        if (i == oldIndex) return newIndex;
        var x = i > oldIndex ? i - 1 : i;
        if (x >= newIndex) x++;
        return x;
      });
    }
    _closeForms();
    widget.onChanged(_lines);
  }

  /// Rewrite each collapsed index through [remap]; null drops the entry.
  void _replaceCollapsed(int? Function(int) remap) {
    final next = <int>{};
    for (final i in _collapsed) {
      final mapped = remap(i);
      if (mapped != null) next.add(mapped);
    }
    _collapsed
      ..clear()
      ..addAll(next);
  }

  @override
  Widget build(BuildContext context) {
    final Widget body;
    if (_lines.isEmpty) {
      body = const Padding(
        padding: EdgeInsets.symmetric(vertical: 16),
        child: Center(child: Text('No lines yet.')),
      );
    } else if (widget.readOnly) {
      body = Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: _plainList(context, _lines),
      );
    } else {
      body = _reorderableList(context, _lines, depth: 0);
    }

    return Card(
      child: Padding(
        padding: const EdgeInsets.all(8),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            // Line rows render at 95% text size for a slightly denser sheet;
            // the add forms below stay at full size.
            MediaQuery(
              data: MediaQuery.of(context)
                  .copyWith(textScaler: const TextScaler.linear(0.95)),
              child: body,
            ),
            if (!widget.readOnly) ...[
              if (_leafFormOpen && _leafFormGroupIndex == null)
                InlineLeafForm(onSubmit: _submitLeaf, onCancel: _closeForms),
              if (_groupFormOpen)
                InlineGroupForm(onSubmit: _submitGroup, onCancel: _closeForms),
              const Divider(),
              Row(
                children: [
                  TextButton.icon(
                    onPressed: () => _openLeafForm(null),
                    icon: const Icon(Icons.add),
                    label: const Text('Add line'),
                  ),
                  TextButton.icon(
                    onPressed: _openGroupForm,
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

  /// Read-only rendering: a flat list of rows, sections inlined, no handles.
  List<Widget> _plainList(BuildContext context, List<WorkLine> list,
      {int depth = 0}) {
    final widgets = <Widget>[];
    for (var i = 0; i < list.length; i++) {
      final line = list[i];
      if (line.isGroup) {
        widgets.add(_groupHeader(context, list, line, depth, i));
        if (depth != 0 || !_collapsed.contains(i)) {
          widgets
              .addAll(_plainList(context, line.children ?? [], depth: depth + 1));
        }
      } else {
        widgets.add(_leafRow(context, list, line, depth, i));
      }
    }
    return widgets;
  }

  /// Editable rendering: one reorderable level. Section children get their own
  /// nested reorderable level so they reorder among themselves.
  Widget _reorderableList(BuildContext context, List<WorkLine> list,
      {required int depth}) {
    return ReorderableListView(
      shrinkWrap: true,
      primary: false,
      physics: const NeverScrollableScrollPhysics(),
      buildDefaultDragHandles: false,
      onReorder: (oldIndex, newIndex) => _reorder(list, oldIndex, newIndex),
      children: [
        for (var i = 0; i < list.length; i++)
          _reorderableItem(context, list, list[i], depth, i),
      ],
    );
  }

  Widget _reorderableItem(BuildContext context, List<WorkLine> parent,
      WorkLine line, int depth, int index) {
    if (line.isGroup) {
      final children = line.children ?? [];
      final collapsed = depth == 0 && _collapsed.contains(index);
      return Column(
        // ObjectKey: identity is stable within a build/drag; a fresh tree from
        // the store after save just yields fresh keys, which is fine.
        key: ObjectKey(line),
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          _groupHeader(context, parent, line, depth, index),
          if (children.isNotEmpty && !collapsed)
            _reorderableList(context, children, depth: depth + 1),
          if (_leafFormOpen && depth == 0 && _leafFormGroupIndex == index)
            Padding(
              padding: const EdgeInsets.only(left: 16),
              child:
                  InlineLeafForm(onSubmit: _submitLeaf, onCancel: _closeForms),
            ),
        ],
      );
    }
    return _leafRow(context, parent, line, depth, index);
  }

  Widget _dragHandle(int index) {
    return ReorderableDragStartListener(
      index: index,
      child: const Padding(
        padding: EdgeInsets.only(right: 4),
        child: Icon(Icons.drag_indicator, size: 18, color: Colors.black38),
      ),
    );
  }

  Widget _groupHeader(BuildContext context, List<WorkLine> parent,
      WorkLine group, int depth, int index) {
    // Collapse is tracked per top-level index; sections only exist there.
    final collapsible = depth == 0;
    final collapsed = collapsible && _collapsed.contains(index);
    final childCount = group.children?.length ?? 0;
    return Padding(
      key: ObjectKey(group),
      padding: EdgeInsets.only(left: depth * 16.0, top: 8, bottom: 2),
      child: Row(
        children: [
          if (!widget.readOnly) _dragHandle(index),
          if (collapsible)
            InkWell(
              borderRadius: BorderRadius.circular(4),
              onTap: () => _toggleCollapsed(index),
              child: Padding(
                padding: const EdgeInsets.all(2),
                child: Icon(
                  collapsed ? Icons.chevron_right : Icons.expand_more,
                  size: 18,
                ),
              ),
            )
          else
            const Icon(Icons.folder_outlined, size: 18),
          const SizedBox(width: 6),
          Expanded(
            child: InkWell(
              onTap: collapsible ? () => _toggleCollapsed(index) : null,
              child: Text(
                collapsed
                    ? '${group.snapshotName} ($childCount)'
                    : group.snapshotName,
                style: const TextStyle(fontWeight: FontWeight.bold),
              ),
            ),
          ),
          Text(formatMinor(linesTotalMinor(group.children)),
              style: const TextStyle(fontWeight: FontWeight.bold)),
          if (!widget.readOnly) ...[
            IconButton(
              tooltip: 'Add line to section',
              icon: const Icon(Icons.add, size: 18),
              // Sections only exist at the top level, so [index] addresses
              // this group within the root list.
              onPressed: () => _openLeafForm(index),
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

  Widget _leafRow(BuildContext context, List<WorkLine> parent, WorkLine leaf,
      int depth, int index) {
    return Padding(
      key: ObjectKey(leaf),
      padding: EdgeInsets.only(left: depth * 16.0, top: 2, bottom: 2),
      child: Row(
        children: [
          if (!widget.readOnly) _dragHandle(index),
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
            // Wrap, not Row: pill left of the amount keeps the totals column
            // right-aligned, and on a tight cell the pill drops to its own
            // run instead of overflowing.
            child: Wrap(
              alignment: WrapAlignment.end,
              crossAxisAlignment: WrapCrossAlignment.center,
              spacing: 4,
              children: [
                // Conditional, not an empty pill: Wrap spacing would still
                // indent the amount 4px next to a zero-size child.
                if (leaf.marginFraction != null)
                  MarginPill(fraction: leaf.marginFraction),
                Text(formatMinor(leaf.qty * leaf.unitPriceMinor)),
              ],
            ),
          ),
          if (!widget.readOnly) ...[
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
