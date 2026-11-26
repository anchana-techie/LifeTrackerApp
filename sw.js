/* Service worker: makes Life Tracker installable and quick to open.
 *
 * - The app's own files (HTML, CSS, JS, icons): network first, so a new push shows up straight away.
 *   If the network is slow (over 4 s) or down, the saved copy is used instead.
 * - Libraries from CDNs (fonts, icons, Chart.js, Astronomy Engine, Firebase SDK): saved once, served from the
 *   phone after that. Their URLs carry a version, so a saved copy never goes stale.
 * - Everything else (Apps Script, Firestore, sign-in, Groq, city search) is never touched: always live.
 * - Phone notifications: Firebase Cloud Messaging delivers a push; it is shown here even when the app is closed.
 *
 * Bump VERSION with each release; the page then offers "New version available, Reload".
 */
const VERSION = '20261126f';
const SHELL = 'shell-' + VERSION;
const LIBS = 'libs-v1';
const LIB_HOSTS = ['cdn.jsdelivr.net', 'fonts.googleapis.com', 'fonts.gstatic.com', 'www.gstatic.com'];
const NETWORK_TIMEOUT = 4000;

// Save the page and every file it links to, so the app opens offline after the first visit.
self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const cache = await caches.open(SHELL);
    const page = await fetch('./', { cache: 'no-cache' });
    const html = await page.clone().text();
    await cache.put('./', page);
    const local = [...html.matchAll(/(?:src|href)="([^"#:]+)"/g)].map(m => m[1]).filter(u => !u.startsWith('//') && !u.startsWith('data'));
    await Promise.allSettled([...new Set(local), 'manifest.webmanifest', 'icons/icon-192.png', 'icons/icon-512.png', 'icons/apple-touch-icon.png']
      .map(u => cache.add(new Request(u, { cache: 'no-cache' }))));
  })());
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    for (const key of await caches.keys()) if (key.startsWith('shell-') && key !== SHELL) await caches.delete(key);
    await self.clients.claim();
  })());
});

// The page asks the waiting worker to take over when the person taps Reload.
self.addEventListener('message', event => { if (event.data === 'SKIP_WAITING') self.skipWaiting(); });

self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin === self.location.origin) {
    if (url.pathname.endsWith('/sw.js')) return;
    event.respondWith(networkFirst(req));
  } else if (LIB_HOSTS.includes(url.hostname) && !url.pathname.includes('/__/')) {
    event.respondWith(cacheFirst(req));
  }
  // anything else: not handled, the browser fetches it normally
});

async function networkFirst(req) {
  const cache = await caches.open(SHELL);
  const isPage = req.mode === 'navigate';
  const key = isPage ? './' : req;   // every page load (also ?tab= shortcuts) shares the saved page
  const net = fetch(req).then(res => {
    if (res.ok) cache.put(key, res.clone());
    return res;
  });
  net.catch(() => {});   // handled below; stops an "unhandled rejection" when the saved copy already answered
  const timeout = new Promise(resolve => setTimeout(resolve, NETWORK_TIMEOUT));
  try {
    const res = await Promise.race([net, timeout]);
    if (res) return res;
    const saved = await cache.match(key, { ignoreSearch: isPage });
    return saved || await net;   // slow network and nothing saved: keep waiting
  } catch (err) {
    const saved = await cache.match(key, { ignoreSearch: isPage }) || (!isPage && await cache.match(req, { ignoreSearch: true }));
    if (saved) return saved;
    throw err;
  }
}

async function cacheFirst(req) {
  const cache = await caches.open(LIBS);
  const saved = await cache.match(req);
  if (saved) return saved;
  const res = await fetch(req);
  if (res.ok || res.type === 'opaque') cache.put(req, res.clone());
  return res;
}

/* ---------- phone notifications ---------- */
// The Apps Script sends data-only FCM messages: { data: { title, body, tag, url } }.
self.addEventListener('push', event => {
  let j = {};
  try { j = event.data ? event.data.json() : {}; } catch { j = { data: { body: event.data && event.data.text() } }; }
  const d = j.data || j.notification || j;
  event.waitUntil(self.registration.showNotification(d.title || 'Life Tracker', {
    body: d.body || '', tag: d.tag || undefined, renotify: !!d.tag,
    icon: 'icons/icon-192.png', badge: 'icons/badge-96.png', data: { url: d.url || './' }
  }));
});

// Tapping the notification brings the app to the front (or opens it); the message pop-up shows there.
self.addEventListener('notificationclick', event => {
  event.notification.close();
  const url = new URL(event.notification.data?.url || './', self.registration.scope).href;
  event.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const win = wins.find(w => w.url.startsWith(self.registration.scope));
    if (win) return win.focus();
    return self.clients.openWindow(url);
  })());
});
