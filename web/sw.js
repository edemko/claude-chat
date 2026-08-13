const CACHE = 'claude-chat-v10';
const SHELL = ['/', '/index.html', '/style.css', '/app.js', '/markdown.js', '/icon.svg', '/manifest.webmanifest'];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // Session data and the live stream must never be served from cache.
  if (url.pathname.startsWith('/api/') || url.pathname === '/ws') return;
  if (event.request.method !== 'GET') return;

  // Shell: serve from cache, refresh in the background.
  event.respondWith(
    caches.match(event.request).then((hit) => {
      const fetched = fetch(event.request)
        .then((res) => {
          if (res.ok) caches.open(CACHE).then((c) => c.put(event.request, res.clone()));
          return res;
        })
        .catch(() => hit);
      return hit ?? fetched;
    }),
  );
});
