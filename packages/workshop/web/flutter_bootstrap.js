// Custom Flutter web bootstrap. The two placeholder tokens below are replaced
// at build time with Flutter's loader (flutter.js) and the build config.
//
// IMPORTANT: never write the token text anywhere else in this file (not even in
// a comment) — Flutter does a blind text substitution and would inject the whole
// minified loader mid-line, breaking the script.
//
// We deliberately call _flutter.loader.load() WITHOUT serviceWorkerSettings so
// Flutter does not register its bundled flutter_service_worker.js — in 3.44 that
// file is a deprecated no-op that unregisters itself and caches nothing
// (flutter/flutter#156910). Instead we register our own sw.js, which actually
// caches the app shell so the Workshop PWA launches with no Wi-Fi after a shutdown.
{{flutter_js}}
{{flutter_build_config}}

_flutter.loader.load();

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').catch((e) => {
      console.warn('Offline service worker registration failed:', e);
    });
  });
}
