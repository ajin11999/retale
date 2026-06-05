/// Open an external URL (the `wa.me` WhatsApp deep link). The implementation
/// differs by platform: native desktop hands off to `url_launcher`, while web
/// clicks a synthesised `<a target="_blank">` — `window.open` (what
/// `url_launcher` uses) is silently no-op'd in a standalone-display PWA and
/// under popup blockers, which is why "Open WhatsApp" did nothing on web.
library;

export 'wa_launcher_native.dart'
    if (dart.library.js_interop) 'wa_launcher_web.dart';
