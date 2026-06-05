import 'package:pdf/pdf.dart';
import 'package:pdf/widgets.dart' as pw;
import 'package:printing/printing.dart';

import '../config/app_config.dart';
import '../graphql/graphql_service.dart';
import '../graphql/operations.dart';
import 'receipt.dart';
import 'receipt_pdf.dart';
import 'share_launcher.dart';
import 'wa_launcher.dart';

/// Fetches the receipt header once, normalises phone numbers, and opens
/// WhatsApp (a `wa.me` deep link) with the rendered receipt text.
class ReceiptService {
  ReceiptService._();
  static final ReceiptService instance = ReceiptService._();

  StoreInfo? _cached;
  pw.ImageProvider? _logo;
  bool _logoFetched = false;

  /// The business name/phone/logo for receipt headers, cached for the session.
  /// Falls back to a generic header when the API can't be reached.
  Future<StoreInfo> storeInfo() async {
    final cached = _cached;
    if (cached != null) return cached;
    try {
      final data = await GraphQLService.instance.query(Ops.businessReceiptInfo);
      final info = data['businessReceiptInfo'] as Map<String, dynamic>;
      final store = StoreInfo(
        name: info['name'] as String,
        logoUrl: _absoluteLogoUrl(info['logoUrl'] as String?),
      );
      _cached = store;
      return store;
    } on GraphQLAppException {
      return const StoreInfo(name: 'Receipt');
    }
  }

  /// Resolve the API-relative logo path (e.g. `/business-logo`) against the
  /// configured API base. Returns null when no logo is set or no API URL is
  /// configured; passes through values that are already absolute.
  static String? _absoluteLogoUrl(String? logoUrl) {
    if (logoUrl == null || logoUrl.isEmpty) return null;
    if (logoUrl.startsWith('http://') || logoUrl.startsWith('https://')) {
      return logoUrl;
    }
    final base = AppConfig.instance.apiUrl;
    if (base == null || base.isEmpty) return null;
    final trimmed = base.replaceAll(RegExp(r'/+$'), '');
    final path = logoUrl.startsWith('/') ? logoUrl : '/$logoUrl';
    return '$trimmed$path';
  }

  /// Download the business logo for embedding in a printed receipt, cached for
  /// the session. Best-effort: returns null (so the receipt falls back to the
  /// store name) when no logo is set or the fetch fails.
  Future<pw.ImageProvider?> _logoImage(StoreInfo store) async {
    if (_logoFetched) return _logo;
    _logoFetched = true;
    final url = store.logoUrl;
    if (url == null) return null;
    try {
      _logo = await networkImage(url);
    } catch (_) {
      _logo = null;
    }
    return _logo;
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
    return openExternal(uri);
  }

  /// Render [receipt] to a PDF and offer it through the platform share sheet,
  /// so the user can pick WhatsApp and the receipt rides along as an attachment
  /// (a `wa.me` link can only carry text). The recipient is chosen in the share
  /// sheet, so no phone number is needed here.
  ///
  /// On web this uses the Web Share API; it needs a secure context (https or
  /// localhost) and returns [ShareResult.unsupported] where files can't be
  /// shared, so the caller can fall back to printing.
  Future<ShareResult> shareReceiptPdf(Receipt receipt) async {
    final logo = await _logoImage(receipt.store);
    final bytes = await buildReceiptPdf(receipt, PdfPageFormat.roll80, logo: logo);
    final label = receipt.displayNumber == null
        ? 'Receipt'
        : 'Receipt ${receipt.displayNumber}';
    return shareReceiptFile(
      bytes: bytes,
      filename: '${label.replaceAll(' ', '-')}.pdf',
      mimeType: 'application/pdf',
      title: label,
      text: '$label — see the attached PDF.',
    );
  }

  /// Open the OS/browser print dialog with [receipt] rendered to PDF. The
  /// layout adapts to the paper the dialog picks (min 80mm — a thermal roll).
  ///
  /// Returns true when the print dialog was invoked. On web the in-place print
  /// (a hidden iframe) can silently no-op — e.g. in an installed PWA or when
  /// the browser blocks it — in which case we fall back to opening the rendered
  /// PDF so the cashier can still print it, and return false so the caller can
  /// tell the user what happened. Throws if the PDF itself can't be built.
  Future<bool> printReceipt(Receipt receipt) async {
    final name = receipt.displayNumber == null
        ? 'Receipt'
        : 'Receipt ${receipt.displayNumber}';
    final logo = await _logoImage(receipt.store);
    final printed = await Printing.layoutPdf(
      name: name,
      onLayout: (format) => buildReceiptPdf(receipt, format, logo: logo),
    );
    if (!printed) {
      final bytes =
          await buildReceiptPdf(receipt, PdfPageFormat.roll80, logo: logo);
      await Printing.sharePdf(bytes: bytes, filename: '$name.pdf');
    }
    return printed;
  }
}
