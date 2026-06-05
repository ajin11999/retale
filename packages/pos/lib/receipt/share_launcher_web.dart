import 'dart:js_interop';
import 'dart:typed_data';

import 'package:web/web.dart' as web;

import 'share_result.dart';

/// Web/PWA: share the bytes as a file via the Web Share API, mirroring the
/// console's receipt-PDF share. The OS share sheet then lets the user pick
/// WhatsApp and the file goes as an attachment.
///
/// Requires a secure context (https or localhost) and a user gesture. Browsers
/// or contexts that can't share files — e.g. plain HTTP over the LAN — report
/// [ShareResult.unsupported] so the caller can suggest printing instead.
Future<ShareResult> shareReceiptFile({
  required Uint8List bytes,
  required String filename,
  required String mimeType,
  String? title,
  String? text,
}) async {
  final file = web.File(
    <JSAny>[bytes.toJS].toJS,
    filename,
    web.FilePropertyBag(type: mimeType),
  );
  final data = web.ShareData(
    files: <web.File>[file].toJS,
    title: title ?? filename,
    text: text ?? '',
  );

  final navigator = web.window.navigator;
  // canShare with a files payload tells us both that the API exists and that
  // this browser is willing to share this kind of file.
  if (!navigator.canShare(data)) return ShareResult.unsupported;

  try {
    await navigator.share(data).toDart;
    return ShareResult.shared;
  } catch (e) {
    // A dismissed share sheet rejects with an AbortError DOMException — benign.
    if (e case web.DOMException(name: 'AbortError')) {
      return ShareResult.dismissed;
    }
    return ShareResult.failed;
  }
}
