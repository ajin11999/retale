import 'dart:async';

import 'package:flutter/material.dart';
import 'package:intl/intl.dart';
import 'package:retale_workshop/component/job_lines.dart';
import 'package:retale_workshop/component/payment_section.dart';
import 'package:retale_workshop/schema/project.dart';
import 'package:retale_workshop/services/project_repo.dart';
import 'package:retale_workshop/util/money.dart';
import 'package:retale_workshop/util/project_calc.dart';

/// The right-pane job sheet: header details, the line tree, and the payment
/// section. Watches the project in the local store so external changes reflect
/// live.
class JobSheet extends StatefulWidget {
  const JobSheet({
    super.key,
    required this.projectId,
    required this.posId,
    required this.onDeleted,
  });

  final int projectId;
  final String posId;
  final VoidCallback onDeleted;

  @override
  State<JobSheet> createState() => _JobSheetState();
}

class _JobSheetState extends State<JobSheet> {
  final _repo = ProjectRepo();
  StreamSubscription<Project?>? _sub;
  Project? _project;

  final _label = TextEditingController();
  final _vehicle = TextEditingController();
  final _memo = TextEditingController();
  DateTime _date = DateTime.now();
  bool _seeded = false;
  Timer? _headerDebounce;

  @override
  void initState() {
    super.initState();
    _watch();
  }

  @override
  void dispose() {
    _sub?.cancel();
    // Flush a pending header edit before tearing down, so a fast job switch
    // can't drop the last keystrokes (fire-and-forget; the store write is local).
    if (_headerDebounce?.isActive ?? false) {
      _headerDebounce!.cancel();
      if (_seeded) {
        _repo.saveHeader(
          widget.projectId,
          label: _label.text,
          vehicle: _vehicle.text,
          memo: _memo.text,
          date: _date,
        );
      }
    }
    _label.dispose();
    _vehicle.dispose();
    _memo.dispose();
    super.dispose();
  }

  void _watch() {
    // Fires immediately with the current record, then on every change. The
    // first emission seeds the header controllers (guarded by [_seeded]).
    _sub = _repo.watch(widget.projectId).listen((fresh) {
      if (!mounted) return;
      setState(() => _project = fresh);
      _seed(fresh);
    });
  }

  void _seed(Project? p) {
    if (p == null || _seeded) return;
    _label.text = p.label;
    _vehicle.text = p.vehicle;
    _memo.text = p.memo;
    _date = p.date;
    _seeded = true;
  }

  void _onHeaderChanged() {
    if (_headerDebounce?.isActive ?? false) _headerDebounce!.cancel();
    _headerDebounce = Timer(const Duration(milliseconds: 500), () {
      _repo.saveHeader(
        widget.projectId,
        label: _label.text,
        vehicle: _vehicle.text,
        memo: _memo.text,
        date: _date,
      );
    });
  }

  Future<void> _pickDate() async {
    final picked = await showDatePicker(
      context: context,
      initialDate: _date,
      firstDate: DateTime(2020),
      lastDate: DateTime(2100),
    );
    if (picked != null) {
      setState(() => _date = picked);
      _onHeaderChanged();
    }
  }

  Future<void> _confirmDelete() async {
    final ok = await showDialog<bool>(
      context: context,
      builder: (context) => AlertDialog(
        title: const Text('Delete job?'),
        content: const Text('This removes the local job sheet permanently.'),
        actions: [
          TextButton(
              onPressed: () => Navigator.of(context).pop(false),
              child: const Text('Cancel')),
          FilledButton(
              onPressed: () => Navigator.of(context).pop(true),
              child: const Text('Delete')),
        ],
      ),
    );
    if (ok == true) {
      await _repo.delete(widget.projectId);
      widget.onDeleted();
    }
  }

  @override
  Widget build(BuildContext context) {
    final p = _project;
    if (p == null) {
      return const Center(child: CircularProgressIndicator());
    }
    final uploaded = p.isUploaded;
    return SingleChildScrollView(
      padding: const EdgeInsets.all(20),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          if (uploaded) _uploadedBanner(p),
          _headerCard(uploaded),
          const SizedBox(height: 12),
          JobLines(
            lines: p.lines,
            readOnly: uploaded,
            onChanged: (lines) => _repo.saveLines(widget.projectId, lines),
          ),
          const SizedBox(height: 12),
          PaymentSection(project: p, posId: widget.posId, repo: _repo),
          const SizedBox(height: 40),
        ],
      ),
    );
  }

  Widget _uploadedBanner(Project p) {
    return Card(
      color: Theme.of(context).colorScheme.secondaryContainer,
      child: ListTile(
        leading: const Icon(Icons.cloud_done),
        title: const Text('Submitted to Retale'),
        subtitle: Text('Order ${p.uploadedOrderId ?? ''} · '
            '${p.uploadedAt != null ? DateFormat.yMMMd().add_jm().format(p.uploadedAt!) : ''}'),
      ),
    );
  }

  Widget _headerCard(bool readOnly) {
    return Card(
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          children: [
            Row(
              children: [
                Expanded(
                  child: TextField(
                    controller: _label,
                    enabled: !readOnly,
                    onChanged: (_) => _onHeaderChanged(),
                    decoration: const InputDecoration(
                        labelText: 'Job / customer', border: OutlineInputBorder()),
                  ),
                ),
                const SizedBox(width: 12),
                Expanded(
                  child: TextField(
                    controller: _vehicle,
                    enabled: !readOnly,
                    onChanged: (_) => _onHeaderChanged(),
                    decoration: const InputDecoration(
                        labelText: 'Vehicle', border: OutlineInputBorder()),
                  ),
                ),
                const SizedBox(width: 12),
                OutlinedButton.icon(
                  onPressed: readOnly ? null : _pickDate,
                  icon: const Icon(Icons.calendar_today, size: 16),
                  label: Text(DateFormat('yyyy-MM-dd').format(_date)),
                ),
                IconButton(
                  tooltip: 'Delete job',
                  onPressed: _confirmDelete,
                  icon: const Icon(Icons.delete_outline),
                ),
              ],
            ),
            const SizedBox(height: 12),
            TextField(
              controller: _memo,
              enabled: !readOnly,
              minLines: 1,
              maxLines: 3,
              onChanged: (_) => _onHeaderChanged(),
              decoration: const InputDecoration(
                  labelText: 'Notes', border: OutlineInputBorder()),
            ),
            const SizedBox(height: 12),
            Align(
              alignment: Alignment.centerRight,
              child: Text('Total ${formatMinor(linesTotalMinor(_project!.lines))}',
                  style: Theme.of(context).textTheme.titleLarge),
            ),
          ],
        ),
      ),
    );
  }
}
