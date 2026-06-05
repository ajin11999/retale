import 'package:web/web.dart' as web;

/// Web/PWA: open the link by synthesising an anchor and clicking it, rather
/// than `window.open`. In a standalone-display PWA `window.open(url, '_blank')`
/// silently does nothing (there is no browser chrome to host a new tab), so the
/// receipt never reached WhatsApp. An `<a target="_blank">` click is handed off
/// to the default browser even from a standalone PWA.
///
/// Must run synchronously inside the tap handler so the browser still counts it
/// as a user-activated navigation (no `await` before it on the call path).
Future<bool> openExternal(Uri uri) async {
  final a = web.HTMLAnchorElement()
    ..href = uri.toString()
    ..target = '_blank'
    ..rel = 'noopener noreferrer';
  web.document.body!.appendChild(a);
  a.click();
  a.remove();
  return true;
}
