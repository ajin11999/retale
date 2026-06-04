import 'package:printing/printing.dart';
import 'package:url_launcher/url_launcher.dart';

import '../graphql/graphql_service.dart';
import '../graphql/operations.dart';
import 'receipt.dart';
import 'receipt_pdf.dart';

/// Fetches the receipt header once, normalises phone numbers, and opens
/// WhatsApp (a `wa.me` deep link) with the rendered receipt text.
class ReceiptService {
  ReceiptService._();
  static final ReceiptService instance = ReceiptService._();

  StoreInfo? _cached;

  /// The business name/phone for receipt headers, cached for the session. Falls
  /// back to a generic header when the API can't be reached.
  Future<StoreInfo> storeInfo() async {
    final cached = _cached;
    if (cached != null) return cached;
    try {
      final data = await GraphQLService.instance.query(Ops.businessReceiptInfo);
      final info = data['businessReceiptInfo'] as Map<String, dynamic>;
      final store = StoreInfo(
        name: info['name'] as String,
        phone: info['phone'] as String?,
      );
      _cached = store;
      return store;
    } on GraphQLAppException {
      return const StoreInfo(name: 'Receipt');
    }
  }

  /// Reduce a phone number to the digits `wa.me` expects (no `+`, spaces or
  /// punctuation). Returns null when nothing usable remains.
  static String? normalizePhone(String? phone) {
    if (phone == null) return null;
    final digits = phone.replaceAll(RegExp(r'[^0-9]'), '');
    return digits.isEmpty ? null : digits;
  }

  /// Open WhatsApp at [phone] with [message] pre-filled. Returns false when the
  /// number is unusable or no WhatsApp handler could be launched.
  Future<bool> sendWhatsApp({
    required String phone,
    required String message,
  }) async {
    final digits = normalizePhone(phone);
    if (digits == null) return false;
    final uri = Uri.parse(
        'https://wa.me/$digits?text=${Uri.encodeComponent(message)}');
    return launchUrl(uri, mode: LaunchMode.externalApplication);
  }

  /// Open the OS/browser print dialog with [receipt] rendered to PDF. The
  /// layout adapts to the paper the dialog picks (min 80mm — a thermal roll).
  Future<void> printReceipt(Receipt receipt) {
    return Printing.layoutPdf(onLayout: (format) => buildReceiptPdf(receipt, format));
  }
}
