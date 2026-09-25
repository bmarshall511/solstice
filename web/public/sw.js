// Minimal offline shell: cache the app assets, always go to the network for /api.
// /api and /auth are never intercepted or cached: the browser fetches them itself, same-origin, so the HttpOnly owner
// cookie rides along from the installed PWA too, and a locked (cookie-less) client can never be served an owner response.
// v2: drops shells cached before the owner lock, whose client showed the old sign-in form on a 401.
const CACHE = 'solstice-v2';
self.addEventListener('install', e => { self.skipWaiting(); e.waitUntil(caches.open(CACHE).then(c => c.addAll(['/', '/manifest.webmanifest', '/icon.svg']))); });
self.addEventListener('activate', e => e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))));
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.pathname.startsWith('/api') || url.pathname.startsWith('/auth') || url.origin !== location.origin) return;
  e.respondWith(fetch(e.request).then(r => { const copy = r.clone(); caches.open(CACHE).then(c => c.put(e.request, copy)); return r; }).catch(() => caches.match(e.request).then(r => r ?? caches.match('/'))));
});
