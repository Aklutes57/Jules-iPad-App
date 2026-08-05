/* sw.js — offline app shell for Jules for iPad.
 *
 * ============================================================================
 * ADDING A FILE? ADD IT TO PRECACHE BELOW *AND* BUMP CACHE_VERSION.
 * A file that is not listed will never be cached, and a version that is not
 * bumped means returning users keep the old bundle forever.
 * ============================================================================
 */

const CACHE_VERSION = 'jules-v1';

/* Every static file this app ships. Relative URLs only — the app must work from
 * a GitHub Pages sub-path such as https://user.github.io/Jules-iPad-App/. */
const PRECACHE = [
  './',
  './index.html',
  './manifest.webmanifest',
  './css/app.css',
  './js/app.js',
  './js/api.js',
  './js/activity.js',
  './js/config.js',
  './js/diff.js',
  './js/poller.js',
  './js/router.js',
  './js/storage.js',
  './js/ui.js',
  './js/views/dashboard.js',
  './js/views/newSession.js',
  './js/views/onboarding.js',
  './js/views/settings.js',
  './js/views/sessionDetail.js',
];

/* Icons are cached best-effort: they are generated separately, and one missing
 * PNG must not fail the whole install and leave the app with no offline mode.
 * Same rule applies — list new icons here and bump CACHE_VERSION. */
const PRECACHE_OPTIONAL = [
  './icons/icon-180.png',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-512-maskable.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE_VERSION);
      await cache.addAll(PRECACHE);
      await Promise.allSettled(PRECACHE_OPTIONAL.map((url) => cache.add(url)));
      // Deliberately no skipWaiting() here: the page offers the user a Reload
      // and posts SKIP_WAITING only when they accept.
    })()
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const names = await caches.keys();
      await Promise.all(names.filter((name) => name !== CACHE_VERSION).map((name) => caches.delete(name)));
      await self.clients.claim();
    })()
  );
});

self.addEventListener('message', (event) => {
  if (event && event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});

self.addEventListener('fetch', (event) => {
  const req = event.request;

  /* FIRST LINE, AND IT MATTERS: only same-origin GETs are ever touched.
   * Every call to jules.googleapis.com therefore goes straight to the network,
   * is never cached, and never has an API key stored in Cache Storage. */
  if (req.method !== 'GET' || new URL(req.url).origin !== self.location.origin) return;

  // Navigations: network-first, so a fresh deploy is picked up on the next load,
  // falling back to the cached shell when offline.
  if (req.mode === 'navigate') {
    event.respondWith(
      (async () => {
        try {
          const fresh = await fetch(req);
          const cache = await caches.open(CACHE_VERSION);
          cache.put('./index.html', fresh.clone()).catch(() => {});
          return fresh;
        } catch (_err) {
          const cache = await caches.open(CACHE_VERSION);
          const cached = (await cache.match('./index.html')) || (await cache.match('./'));
          if (cached) return cached;
          return new Response('Offline, and the app shell is not cached yet.', {
            status: 503,
            headers: { 'Content-Type': 'text/plain; charset=utf-8' },
          });
        }
      })()
    );
    return;
  }

  // Assets: cache-first. Everything here is versioned by CACHE_VERSION, so a
  // stale asset can only survive until the next deploy bumps it.
  event.respondWith(
    (async () => {
      const cache = await caches.open(CACHE_VERSION);
      const cached = await cache.match(req);
      if (cached) return cached;

      try {
        const fresh = await fetch(req);
        if (fresh && fresh.ok && fresh.type === 'basic') {
          cache.put(req, fresh.clone()).catch(() => {});
        }
        return fresh;
      } catch (err) {
        const fallback = await cache.match(req, { ignoreSearch: true });
        if (fallback) return fallback;
        throw err;
      }
    })()
  );
});
