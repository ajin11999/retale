import 'package:flutter/material.dart';

import '../i18n/i18n_service.dart';
import 'receipt.dart';
import 'receipt_service.dart';
import 'share_launcher.dart' show ShareResult;

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
  bool _sharing = false;
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
        setState(() => _error = tr('receipt.invalidPhoneOrNoApp'));
        return;
      }
      if (mounted) Navigator.pop(context);
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  /// Share the receipt as a PDF via the platform share sheet — the user picks
  /// WhatsApp there and the PDF goes as an attachment. No phone number needed.
  Future<void> _sharePdf() async {
    setState(() {
      _sharing = true;
      _error = null;
    });
    try {
      final result =
          await ReceiptService.instance.shareReceiptPdf(widget.receipt);
      switch (result) {
        case ShareResult.shared:
          if (mounted) Navigator.pop(context);
        case ShareResult.dismissed:
          break; // user backed out — leave the sheet open, no error
        case ShareResult.unsupported:
          setState(() => _error = tr('receipt.unsupportedShare'));
        case ShareResult.failed:
          setState(() => _error = tr('receipt.shareFailed'));
      }
    } finally {
      if (mounted) setState(() => _sharing = false);
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
          Align(
            alignment: Alignment.centerLeft,
            child: Text(tr('receipt.sendReceipt'),
                style: const TextStyle(fontSize: 18, fontWeight: FontWeight.bold)),
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
            decoration: InputDecoration(
              labelText: tr('receipt.whatsAppNumber'),
              helperText: tr('receipt.phoneHelper'),
              border: const OutlineInputBorder(),
            ),
          ),
          if (_error != null) ...[
            const SizedBox(height: 12),
            Text(_error!, style: TextStyle(color: scheme.error)),
          ],
          const SizedBox(height: 12),
          FilledButton.icon(
            icon: const Icon(Icons.send),
            label: Text(tr('receipt.openWhatsApp')),
            onPressed: (_busy || _sharing) ? null : _send,
          ),
          const SizedBox(height: 8),
          OutlinedButton.icon(
            icon: _sharing
                ? const SizedBox(
                    width: 16,
                    height: 16,
                    child: CircularProgressIndicator(strokeWidth: 2),
                  )
                : const Icon(Icons.picture_as_pdf_outlined),
            label: Text(_sharing ? tr('receipt.preparingPdf') : tr('receipt.sendAsPdf')),
            onPressed: (_busy || _sharing) ? null : _sharePdf,
          ),
          const SizedBox(height: 4),
          Text(
            tr('receipt.sendAsPdfHelper'),
            style: TextStyle(fontSize: 11, color: scheme.outline),
          ),
        ],
      ),
    );
  }
}
