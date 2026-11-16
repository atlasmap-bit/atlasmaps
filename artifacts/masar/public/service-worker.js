const SHELL_CACHE = 'masar-shell-v2';
const TILE_CACHE = 'masar-tiles-v1';
const SHELL_URLS = ['/', '/manifest.webmanifest'];
const MAX_TILES = 700;

self.addEventListener('install', event => {
  event.waitUntil(caches.open(SHELL_CACHE).then(cache => cache.addAll(SHELL_URLS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', event => {
  event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(key => ![SHELL_CACHE, TILE_CACHE].includes(key)).map(key => caches.delete(key)))).then(() => self.clients.claim()));
});

self.addEventListener('fetch', event => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.hostname.includes('tile.openstreetmap.org') || url.hostname.includes('opentopomap.org') || url.hostname.includes('arcgisonline.com')) {
    event.respondWith(caches.open(TILE_CACHE).then(async cache => {
      const cached = await cache.match(request);
      if (cached) {
        void fetch(request).then(response => {
          if (response.ok || response.type === 'opaque') return cache.put(request, response.clone());
          return undefined;
        }).catch(() => undefined);
        return cached;
      }
      try {
        const response = await fetch(request);
        if (response.ok || response.type === 'opaque') {
          await cache.put(request, response.clone());
          const keys = await cache.keys();
          await Promise.all(keys.slice(0, Math.max(0, keys.length - MAX_TILES)).map(key => cache.delete(key)));
        }
        return response;
      } catch {
        return new Response('', { status: 503, statusText: 'Offline tile not cached' });
      }
    }));
    return;
  }
  if (url.origin === self.location.origin && !url.pathname.startsWith('/api') && !url.pathname.startsWith('/socket.io')) {
    event.respondWith(fetch(request).then(response => {
      if (response.ok && !response.headers.get('content-type')?.includes('application/json')) {
        void caches.open(SHELL_CACHE).then(cache => cache.put(request, response.clone()));
      }
      return response;
    }).catch(() => caches.match(request).then(cached => cached || caches.match('/'))));
  }
});
