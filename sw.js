// Kitchen by Rough Design — service worker (network-first).
//
// Why: iOS home-screen PWAs cache the app shell (index.html + the
// per-minute-busted bundles) so aggressively that deploys often don't
// reach the workshop's phones until the icon is deleted and re-added —
// a recurring pain (2026-05-29). A network-first SW fixes it: every
// same-origin GET tries the network FIRST (so an online phone always
// gets the freshly deployed bundle), falling back to cache only when
// offline. After this SW is installed once, future deploys appear on
// the next launch with no manual cache clearing.
//
// Scope = the directory this file is served from (GH Pages project path
// /kitchen-drawings-rd2026/). Cross-origin requests (Firebase RTDB,
// gstatic/jsdelivr CDNs, GitHub raw PDFs/DXFs) are NOT intercepted —
// they fall straight through to the network untouched.

const CACHE = 'kd-shell-v1';

self.addEventListener('install', () => {
  // Take over as soon as installed — don't wait for old tabs to close.
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    // Drop any stale caches from older SW versions.
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  let url;
  try { url = new URL(req.url); } catch { return; }

  // Only manage our own same-origin GETs. Everything cross-origin
  // (Firebase, CDNs, GitHub raw) passes through to the network as-is.
  if (req.method !== 'GET' || url.origin !== self.location.origin) return;

  event.respondWith((async () => {
    try {
      // Network FIRST, bypassing the HTTP cache so we always get the
      // latest deploy when the phone has signal.
      const fresh = await fetch(req, { cache: 'no-store' });
      if (fresh && fresh.ok && fresh.type === 'basic') {
        const cache = await caches.open(CACHE);
        cache.put(req, fresh.clone()).catch(() => {});
      }
      return fresh;
    } catch (err) {
      // Offline (or network error) → serve the last good copy if we have one.
      const cached = await caches.match(req);
      if (cached) return cached;
      throw err;
    }
  })());
});
