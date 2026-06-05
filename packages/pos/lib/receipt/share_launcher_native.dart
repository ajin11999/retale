import 'dart:typed_data';

import 'package:printing/printing.dart';

import 'share_result.dart';

/// Desktop (Windows/Linux): hand the file to the OS via the printing package,
/// which opens the platform share/save UI. There is no Web Share API here, so
/// this is the closest native equivalent.
Future<ShareResult> shareReceiptFile({
  required Uint8List bytes,
  required String filename,
  required String mimeType,
  String? title,
  String? text,
}) async {
  try {
    final ok = await Printing.sharePdf(bytes: bytes, filename: filename);
    return ok ? ShareResult.shared : ShareResult.failed;
  } catch (_) {
    return ShareResult.failed;
  }
}
