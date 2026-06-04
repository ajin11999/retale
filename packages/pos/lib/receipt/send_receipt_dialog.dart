import 'package:flutter/material.dart';

import 'receipt.dart';
import 'receipt_service.dart';

/// Show a sheet that previews [receipt] and lets the cashier confirm or edit
/// the WhatsApp number, then opens WhatsApp with the receipt text. [phone] is
/// the attached customer's number, if any, used to prefill the field.
Future<void> showSendReceiptDialog(
  BuildContext context, {
  required Receipt receipt,
  String? phone,
}) {
  return showModalBottomSheet<void>(
    context: context,
    isScrollControlled: true,
    showDragHandle: true,
    builder: (_) => _SendReceiptSheet(receipt: receipt, phone: phone),
  );
}

class _SendReceiptSheet extends StatefulWidget {
  const _SendReceiptSheet({required this.receipt, this.phone});

  final Receipt receipt;
  final String? phone;

  @override
  State<_SendReceiptSheet> createState() => _SendReceiptSheetState();
}

class _SendReceiptSheetState extends State<_SendReceiptSheet> {
  late final TextEditingController _phone =
      TextEditingController(text: widget.phone ?? '');
  bool _busy = false;
  String? _error;

  @override
  void dispose() {
    _phone.dispose();
    super.dispose();
  }

  Future<void> _send() async {
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      final ok = await ReceiptService.instance.sendWhatsApp(
        phone: _phone.text,
        message: widget.receipt.toMessage(),
      );
      if (!ok) {
        setState(() => _error =
            'Enter a valid phone number, or check that WhatsApp is installed.');
        return;
      }
      if (mounted) Navigator.pop(context);
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    final bottomInset = MediaQuery.of(context).viewInsets.bottom;
    return Padding(
      padding: EdgeInsets.fromLTRB(16, 0, 16, 16 + bottomInset),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          const Align(
            alignment: Alignment.centerLeft,
            child: Text('Send receipt',
                style: TextStyle(fontSize: 18, fontWeight: FontWeight.bold)),
          ),
          const SizedBox(height: 12),
          ConstrainedBox(
            constraints: const BoxConstraints(maxHeight: 220),
            child: SingleChildScrollView(
              child: Container(
                width: double.infinity,
                padding: const EdgeInsets.all(12),
                decoration: BoxDecoration(
                  color: scheme.surfaceContainerHighest,
                  borderRadius: BorderRadius.circular(8),
                ),
                child: SelectableText(
                  widget.receipt.toMessage(),
                  style: const TextStyle(fontFamily: 'monospace', fontSize: 12),
                ),
              ),
            ),
          ),
          const SizedBox(height: 12),
          TextField(
            controller: _phone,
            autofocus: true,
            keyboardType: TextInputType.phone,
            decoration: const InputDecoration(
              labelText: 'WhatsApp number',
              helperText: 'Include the country code, e.g. 628123456789',
              border: OutlineInputBorder(),
            ),
          ),
          if (_error != null) ...[
            const SizedBox(height: 12),
            Text(_error!, style: TextStyle(color: scheme.error)),
          ],
          const SizedBox(height: 12),
          FilledButton.icon(
            icon: const Icon(Icons.send),
            label: const Text('Open WhatsApp'),
            onPressed: _busy ? null : _send,
          ),
        ],
      ),
    );
  }
}
