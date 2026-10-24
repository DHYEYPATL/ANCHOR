const CACHE_NAME = 'anchor-shell-v1';
const APP_SHELL = ['/', '/manifest.webmanifest', '/anchor-mark.svg'];
self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (event) => {
  event.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((key) => key.startsWith('anchor-shell-') && key !== CACHE_NAME).map((key) => caches.delete(key)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  // Never cache API responses, relay envelopes, or arbitrary cross-origin content.
  if (url.origin !== self.location.origin || url.pathname.startsWith('/v1/')) return;
  event.respondWith((async () => {
    try {
      const response = await fetch(request);
      if (response.ok && (request.mode === 'navigate' || url.pathname.startsWith('/assets/') || APP_SHELL.includes(url.pathname))) {
        const copy = response.clone();
        // Tie cache persistence to the fetch event lifecycle; fire-and-forget cache writes
        // may be terminated before they finish on mobile browsers.
        event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.put(request, copy)).catch(() => undefined));
      }
      return response;
    } catch {
      const cached = await caches.match(request);
      if (cached) return cached;
      return (await caches.match('/')) || new Response('Anchor is offline and the application shell is not cached yet.', {
        status: 503, headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' },
      });
    }
  })());
});
