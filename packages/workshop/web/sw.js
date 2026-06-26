'use strict';

// Offline app-shell cache for the Retale Workshop PWA.
//
// Flutter 3.44's bundled flutter_service_worker.js is a deprecated no-op that
// unregisters itself on activate and caches nothing (flutter/flutter#156910),
// so `--pwa-strategy offline-first` no longer produces an offline build. This
// hand-written worker restores it: the app boots from cache when Wi‑Fi is gone,
// and the Dart layer takes over for the API.
//
// Bump CACHE_VERSION to discard everything cached by a previous worker.
const CACHE_VERSION = 'retale-workshop-v1';

// Best-effort precache so the very first offline launch after one online visit
// boots. The heavier/variable assets (canvaskit, fonts, lazy chunks) are filled
// in by the stale-while-revalidate handler as they're fetched that same session.
const CORE_SHELL = [
  './',
  'index.html',
  'flutter_bootstrap.js',
  'flutter.js',
  'main.dart.js',
  'manifest.json',
  'favicon.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_VERSION);
    // A single 404 must not abort the whole install, so cache each item alone.
    // `cache: 'reload'` bypasses the HTTP cache so we precache fresh bytes.
    await Promise.all(CORE_SHELL.map((url) =>
      cache.add(new Request(url, { cache: 'reload' })).catch(() => {})
    ));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => k !== CACHE_VERSION).map((k) => caches.delete(k)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  // Only same-origin static assets. The GraphQL API is cross-origin (a separate
  // port) and must always hit the network — the Dart layer owns its offline
  // queueing, so we never want to serve a stale API response from here.
  if (url.origin !== self.location.origin) return;

  // App-shell navigations: network-first so an online launch picks up a rebuild,
  // falling back to the cached index.html so the PWA still boots with no Wi‑Fi.
  if (req.mode === 'navigate') {
    event.respondWith((async () => {
      try {
        const fresh = await fetch(req);
        const cache = await caches.open(CACHE_VERSION);
        cache.put('index.html', fresh.clone());
        return fresh;
      } catch (_) {
        const cache = await caches.open(CACHE_VERSION);
        return (await cache.match('index.html')) || (await cache.match('./')) || Response.error();
      }
    })());
    return;
  }

  // Everything else (JS, wasm, fonts, images, manifests): stale-while-revalidate.
  // Serve the cached copy instantly, refresh it in the background so the next
  // launch gets a rebuild. Matches the LAN "no-cache, always revalidate" intent
  // while still working with the network unplugged.
  event.respondWith((async () => {
    const cache = await caches.open(CACHE_VERSION);
    const cached = await cache.match(req);
    const network = fetch(req).then((res) => {
      if (res && res.ok && res.type === 'basic') cache.put(req, res.clone());
      return res;
    }).catch(() => null);
    return cached || (await network) || Response.error();
  })());
});
