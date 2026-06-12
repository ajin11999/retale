import 'package:flutter/material.dart';
import 'package:graphql_flutter/graphql_flutter.dart';
import 'package:intl/intl.dart';
import 'package:retale_workshop/schema/project.dart';
import 'package:retale_workshop/services/order_service.dart';
import 'package:retale_workshop/services/project_repo.dart';
import 'package:retale_workshop/util/money.dart';
import 'package:retale_workshop/util/project_calc.dart';

/// Payment summary + the take-payment action. When a non-deposit payment brings
/// the job to paid-in-full, it submits the sale to Retale; a manual "Submit"
/// button covers retries and deposit-covered jobs.
class PaymentSection extends StatefulWidget {
  const PaymentSection({
    super.key,
    required this.project,
    required this.posId,
    required this.repo,
  });

  final Project project;
  final String posId;
  final ProjectRepo repo;

  @override
  State<PaymentSection> createState() => _PaymentSectionState();
}

class _PaymentSectionState extends State<PaymentSection> {
  bool _busy = false;

  Project get _p => widget.project;
  int get _total => linesTotalMinor(_p.lines);
  int get _paid => paymentsTotalMinor(_p.payments);
  int get _remaining => _total - _paid;

  Future<void> _takePayment() async {
    final result = await _showPaymentDialog(remaining: _remaining);
    if (result == null) return;

    final payment = WorkPayment()
      ..date = DateTime.now()
      ..amountMinor = result.amountMinor
      ..isDeposit = result.isDeposit;
    await widget.repo.addPayment(_p.id, payment);

    // A settling (non-deposit) payment that clears the balance triggers upload.
    final paidAfter = _paid + result.amountMinor;
    if (!result.isDeposit && _total > 0 && paidAfter >= _total) {
      await _submit();
    }
  }

  Future<void> _submit() async {
    final client = GraphQLProvider.of(context).value;
    setState(() => _busy = true);
    try {
      // Reload the freshest project (payment was just written).
      final fresh = await widget.repo.get(_p.id);
      if (fresh == null) return;
      final orderId =
          await OrderService(client).submit(project: fresh, posId: widget.posId);
      await widget.repo.markUploaded(_p.id, orderId);
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(content: Text('Submitted to Retale — order $orderId')),
        );
      }
    } catch (e) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(
            backgroundColor: Theme.of(context).colorScheme.errorContainer,
            content: Text('Not submitted: $e'),
            duration: const Duration(seconds: 6),
          ),
        );
      }
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final uploaded = _p.isUploaded;
    final settled = _total > 0 && _remaining <= 0;

    return Card(
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            _row(context, 'Total', _total),
            _row(context, 'Paid', _paid),
            const Divider(),
            _row(context, 'Remaining', _remaining, emphasise: true),
            if (_p.payments.isNotEmpty) ...[
              const SizedBox(height: 12),
              const Align(
                alignment: Alignment.centerLeft,
                child: Text('Payments',
                    style: TextStyle(fontWeight: FontWeight.bold)),
              ),
              for (final pay in _p.payments)
                Padding(
                  padding: const EdgeInsets.symmetric(vertical: 2),
                  child: Row(
                    mainAxisAlignment: MainAxisAlignment.spaceBetween,
                    children: [
                      Text(
                        '${DateFormat('yyyy-MM-dd').format(pay.date)}'
                        '${pay.isDeposit ? '  (deposit)' : ''}',
                        style: const TextStyle(fontSize: 12),
                      ),
                      Text(formatMinor(pay.amountMinor),
                          style: const TextStyle(fontSize: 12)),
                    ],
                  ),
                ),
            ],
            if (!uploaded) ...[
              const SizedBox(height: 12),
              Row(
                children: [
                  Expanded(
                    child: OutlinedButton.icon(
                      onPressed: _busy ? null : _takePayment,
                      icon: const Icon(Icons.payments_outlined),
                      label: const Text('Take payment'),
                    ),
                  ),
                  if (settled) ...[
                    const SizedBox(width: 12),
                    Expanded(
                      child: FilledButton.icon(
                        onPressed: _busy ? null : _submit,
                        icon: _busy
                            ? const SizedBox(
                                height: 16,
                                width: 16,
                                child: CircularProgressIndicator(strokeWidth: 2))
                            : const Icon(Icons.cloud_upload_outlined),
                        label: const Text('Submit to Retale'),
                      ),
                    ),
                  ],
                ],
              ),
            ],
          ],
        ),
      ),
    );
  }

  Widget _row(BuildContext context, String label, int minor,
      {bool emphasise = false}) {
    final style = emphasise
        ? Theme.of(context).textTheme.titleMedium
        : Theme.of(context).textTheme.bodyMedium;
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 2),
      child: Row(
        mainAxisAlignment: MainAxisAlignment.spaceBetween,
        children: [Text(label, style: style), Text(formatMinor(minor), style: style)],
      ),
    );
  }

  Future<_PaymentResult?> _showPaymentDialog({required int remaining}) {
    return showDialog<_PaymentResult>(
      context: context,
      builder: (_) => _PaymentDialog(remaining: remaining),
    );
  }
}

class _PaymentResult {
  _PaymentResult(this.amountMinor, this.isDeposit);
  final int amountMinor;
  final bool isDeposit;
}

class _PaymentDialog extends StatefulWidget {
  const _PaymentDialog({required this.remaining});
  final int remaining;

  @override
  State<_PaymentDialog> createState() => _PaymentDialogState();
}

class _PaymentDialogState extends State<_PaymentDialog> {
  late final TextEditingController _amount;
  bool _isDeposit = false;

  @override
  void initState() {
    super.initState();
    final preset = widget.remaining > 0 ? widget.remaining : 0;
    _amount = TextEditingController(text: preset == 0 ? '' : groupMinor(preset));
  }

  @override
  void dispose() {
    _amount.dispose();
    super.dispose();
  }

  void _save() {
    final amount = parseMinor(_amount.text) ?? 0;
    if (amount <= 0) return;
    Navigator.of(context).pop(_PaymentResult(amount, _isDeposit));
  }

  @override
  Widget build(BuildContext context) {
    return AlertDialog(
      title: const Text('Take payment'),
      content: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          TextField(
            controller: _amount,
            autofocus: true,
            keyboardType: TextInputType.number,
            inputFormatters: const [ThousandsInputFormatter()],
            decoration: const InputDecoration(
              labelText: 'Amount',
              prefixText: 'Rp ',
              border: OutlineInputBorder(),
            ),
            onSubmitted: (_) => _save(),
          ),
          CheckboxListTile(
            contentPadding: EdgeInsets.zero,
            value: _isDeposit,
            onChanged: (v) => setState(() => _isDeposit = v ?? false),
            title: const Text('Deposit (does not settle the job)'),
          ),
        ],
      ),
      actions: [
        TextButton(
          onPressed: () => Navigator.of(context).pop(),
          child: const Text('Cancel'),
        ),
        FilledButton(onPressed: _save, child: const Text('Record')),
      ],
    );
  }
}
