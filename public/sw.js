/*
 * Service worker for the Hashcat Reactor PWA.
 *
 * Strategy (deliberately conservative — this app is a live control surface):
 *   - /api/* and /socket.io/* are NEVER intercepted or cached. Dynamic backend
 *     traffic and websocket polling must always hit the network untouched.
 *   - Navigations: network-first, falling back to the cached shell so the app
 *     still opens offline.
 *   - Everything else (own hashed assets, esm.sh modules, Google Fonts):
 *     stale-while-revalidate, so the app loads offline after the first visit
 *     and silently updates in the background.
 *
 * Bump CACHE to invalidate old caches on deploy.
 */
const CACHE = 'reactor-v1';
const SHELL = [
  './',
  './index.html',
  './manifest.webmanifest',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE)
      .then((cache) => cache.addAll(SHELL))
      .then(() => self.skipWaiting())
      .catch(() => self.skipWaiting()) // a missing shell file must not block install
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  let url;
  try { url = new URL(req.url); } catch { return; }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return;

  // Never touch live backend traffic.
  if (url.origin === self.location.origin &&
      (url.pathname.startsWith('/api/') || url.pathname.startsWith('/socket.io/'))) {
    return;
  }

  // App navigations: prefer fresh, fall back to the cached shell offline.
  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req).catch(() => caches.match('./index.html').then((r) => r || caches.match('./')))
    );
    return;
  }

  // Assets / CDN deps / fonts: stale-while-revalidate.
  event.respondWith(
    caches.open(CACHE).then(async (cache) => {
      const cached = await cache.match(req);
      const network = fetch(req)
        .then((res) => {
          if (res && (res.ok || res.type === 'opaque')) {
            cache.put(req, res.clone()).catch(() => {});
          }
          return res;
        })
        .catch(() => cached);
      return cached || network;
    })
  );
});
