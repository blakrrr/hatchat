// hatchat service worker
// Caches the app shell so it loads instantly and works offline.
// Strategy: cache-first for static assets, network-first for API calls.

const CACHE = 'hatchat-v2';
const SHELL = [
  '/',
  '/chat.html',
  '/clips.html',
  '/index.html',
  '/settings.html',
  '/download.html',
  '/style.css',
  '/manifest.json',
  '/public/icons/icon-192.png',
  '/public/icons/icon-512.png',
];

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);

  // Always go to network for socket.io, API calls, and uploads
  if (url.pathname.startsWith('/socket.io') ||
      url.pathname.startsWith('/api/') ||
      url.pathname.startsWith('/upload')) {
    return; // let it fall through to network
  }

  // Cache-first for everything else (HTML, CSS, images)
  e.respondWith(
    caches.match(e.request).then(cached => {
      if (cached) return cached;
      return fetch(e.request).then(res => {
        if (res && res.status === 200 && e.request.method === 'GET') {
          const clone = res.clone();
          caches.open(CACHE).then(c => c.put(e.request, clone));
        }
        return res;
      });
    })
  );
});
