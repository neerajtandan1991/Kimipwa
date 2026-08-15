const CACHE_NAME = 'civil-pwa-v1';
const STATIC_ASSETS = [
  '/',
  '/index.html',
  '/styles.css',
  '/app.js'
];

// Install: cache static assets
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return cache.addAll(STATIC_ASSETS);
    }).then(() => self.skipWaiting())
  );
});

// Activate: clean old caches
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((cacheNames) => {
      return Promise.all(
        cacheNames
          .filter((name) => name !== CACHE_NAME)
          .map((name) => caches.delete(name))
      );
    }).then(() => self.clients.claim())
  );
});

// Fetch: cache-first for static, network-first for API (though we are fully client-side)
self.addEventListener('fetch', (event) => {
  const { request } = event;

  // Skip non-GET requests and chrome-extension
  if (request.method !== 'GET' || request.url.startsWith('chrome-extension')) {
    return;
  }

  event.respondWith(
    caches.match(request).then((cachedResponse) => {
      if (cachedResponse) {
        return cachedResponse;
      }
      return fetch(request).then((networkResponse) => {
        // Don't cache CDN resources that are already cached by browser
        if (!request.url.includes('cdn.') && !request.url.includes('unpkg.')) {
          const clone = networkResponse.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(request, clone));
        }
        return networkResponse;
      }).catch(() => {
        // Return offline fallback if available
        if (request.mode === 'navigate') {
          return caches.match('/index.html');
        }
      });
    })
  );
});
