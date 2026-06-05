/// Share the receipt as a file attachment through the platform's share sheet,
/// so the user can pick WhatsApp (or any app) and the file rides along. A
/// `wa.me` deep link can only carry text — never a file — which is why this is
/// a separate path from [openExternal].
///
/// Web/PWA uses the Web Share API (the same approach the console uses for its
/// receipt PDF); desktop hands the bytes to the OS via the printing package.
library;

export 'share_result.dart';
export 'share_launcher_native.dart'
    if (dart.library.js_interop) 'share_launcher_web.dart';
