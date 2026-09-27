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

// Web push (mockup t-enhancements frame 2). The server (server/src/push.ts) sends {title, body, kind, id, url}. Each push is shown
// with Solstice's icon, and the time it arrived is kept so Settings › Alerts can say "last push Mon 7:02 AM" on this device.
const LAST_PUSH = '/__solstice/last-push';
/** Where a tap opens: storm preparation the Powerwall rules on Insights › Home, anything else the url the server gave (same origin
 *  only; the digest's is /?go=v-now, server/src/digest.ts DIGEST_URL). */
function target(d) {
  if (d.kind === 'storm') return '/?go=v-ins&p=home';
  try { const u = new URL(d.url || '/', location.origin); return u.origin === location.origin ? u.pathname + u.search : '/'; } catch { return '/'; }
}
self.addEventListener('push', e => {
  let d = {}; try { d = e.data ? e.data.json() : {}; } catch { d = { title: 'Solstice', body: e.data ? e.data.text() : '' }; }
  e.waitUntil(Promise.all([
    self.registration.showNotification(d.title || 'Solstice', { body: d.body || '', icon: '/icon.svg', badge: '/icon.svg', tag: d.id != null ? `alert-${d.id}` : undefined, data: { ...d, target: target(d) } }),
    caches.open(CACHE).then(c => c.put(LAST_PUSH, new Response(JSON.stringify({ at: Date.now() }), { headers: { 'Content-Type': 'application/json' } }))).catch(() => {}),
  ]));
});
self.addEventListener('notificationclick', e => {
  e.notification.close();
  const url = new URL(e.notification.data?.target || '/', location.origin).href;
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
    const c = list.find(w => new URL(w.url).origin === location.origin);
    return c ? c.navigate(url).then(w => (w ?? c).focus()).catch(() => c.focus()) : self.clients.openWindow(url);
  }));
});
