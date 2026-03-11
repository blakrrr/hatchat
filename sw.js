// hatchat service worker
// HTML pages: network-first (always get fresh code on deploy)
// Static assets (CSS, images, fonts): cache-first (fast loads)
// API / socket.io: always network, never cached

const CACHE = 'hatchat-v6';

const HTML_PAGES = ['/', '/chat', '/clips', '/settings', '/download'];
const HTML_FILES = ['/chat.html', '/clips.html', '/index.html', '/settings.html', '/download.html'];

self.addEventListener('install', e => {
  // Pre-cache only non-HTML assets so HTML is always fresh
  e.waitUntil(
    caches.open(CACHE).then(c => c.addAll([
      '/style.css',
      '/manifest.json',
      '/public/icons/icon-192.png',
      '/public/icons/icon-512.png',
    ])).then(() => self.skipWaiting())
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
  const path = url.pathname;

  // Never intercept socket.io, API, or upload requests
  if (path.startsWith('/socket.io') ||
      path.startsWith('/api/') ||
      path.startsWith('/upload')) {
    return;
  }

  const isHTML = HTML_FILES.some(p => path === p) ||
                 HTML_PAGES.some(p => path === p) ||
                 path === '/';

  if (isHTML) {
    // Network-first: always try to get the latest HTML from the server.
    // Only fall back to cache if the network is completely down.
    e.respondWith(
      fetch(e.request).then(res => {
        if (res && res.status === 200) {
          const clone = res.clone();
          caches.open(CACHE).then(c => c.put(e.request, clone));
        }
        return res;
      }).catch(() => caches.match(e.request))
    );
    return;
  }

  // Cache-first for everything else (CSS, images, fonts, JS libs)
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
