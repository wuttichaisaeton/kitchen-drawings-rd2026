// Kitchen by Rough Design — SELF-DESTRUCTING service worker (2026-05-29).
//
// The earlier network-first SW did not update reliably on iOS PWAs — it
// pinned iPhones to an old build while iPad (which updated) worked. iOS
// service-worker support is too flaky to rely on, so this version exists
// only to UNINSTALL itself and wipe the caches it created.
//
// How the kill switch reaches a stuck device: browsers re-check the SW
// script on navigation (independent of the cached app shell), so a phone
// still running the old SW fetches THIS sw.js, installs it, and on activate
// it clears every cache, unregisters itself, and reloads its tabs onto the
// fresh, SW-free site. index.html no longer registers any SW.

self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    try {
      const keys = await caches.keys();
      await Promise.all(keys.map((k) => caches.delete(k)));
    } catch (e) {}
    try { await self.registration.unregister(); } catch (e) {}
    try {
      const clients = await self.clients.matchAll({ type: 'window' });
      clients.forEach((c) => { try { c.navigate(c.url); } catch (e) {} });
    } catch (e) {}
  })());
});

// While still alive, never serve from cache — always hit the network so a
// stuck device gets fresh content even before the unregister completes.
self.addEventListener('fetch', () => { /* passthrough — no respondWith */ });
