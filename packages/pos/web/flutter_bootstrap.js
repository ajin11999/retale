// Custom Flutter web bootstrap. Flutter fills in {{flutter_js}} and
// {{flutter_build_config}} at build time.
//
// We deliberately call _flutter.loader.load() WITHOUT serviceWorkerSettings so
// Flutter does not register its bundled flutter_service_worker.js — in 3.44 that
// file is a deprecated no-op that unregisters itself and caches nothing
// (flutter/flutter#156910). Instead we register our own sw.js, which actually
// caches the app shell so the POS PWA launches with no Wi‑Fi after a shutdown.
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
