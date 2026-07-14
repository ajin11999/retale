'use strict';

// Offline app-shell cache for the Retale POS PWA.
//
// Flutter 3.44's bundled flutter_service_worker.js is a deprecated no-op that
// unregisters itself on activate and caches nothing (flutter/flutter#156910),
// so the flutter web build no longer produces an offline build. This
// hand-written worker restores it: the register boots from cache when Wi‑Fi is
// gone, and the Dart layer (ProductCache + OrderQueue) takes over for the API.
//
// Bump CACHE_VERSION to discard everything cached by a previous worker.
const CACHE_VERSION = 'retale-pos-v3';

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

  // Network-first for the whole same-origin app shell — navigations *and* the
  // scripts (index.html, flutter_bootstrap.js, main.dart.js, flutter.js, wasm,
  // fonts, …). These must load as one matched set: index.html and the bootstrap
  // embed the build's main.dart.js, so serving any one of them stale while the
  // others are fresh leaves Flutter unable to initialise — a blank canvas until
  // the next reload. On a LAN the network is normally there and fast, so an
  // online launch always boots a fresh, self-consistent bundle; when the network
  // is gone we fall back to the last cached copy so the PWA still launches.
  event.respondWith((async () => {
    const cache = await caches.open(CACHE_VERSION);
    try {
      const fresh = await fetch(req);
      if (fresh && fresh.ok && fresh.type === 'basic') {
        // Navigations vary by path (deep links) but all serve the same shell —
        // cache under a stable key so the offline fallback can always find it.
        cache.put(req.mode === 'navigate' ? 'index.html' : req, fresh.clone());
      }
      return fresh;
    } catch (_) {
      if (req.mode === 'navigate') {
        return (await cache.match('index.html')) ||
            (await cache.match('./')) ||
            Response.error();
      }
      return (await cache.match(req)) || Response.error();
    }
  })());
});
