// Офлайн-оболочка страницы работников (/work/): страница — сначала сеть, остальное — из кэша с обновлением в фоне.
// Свой scope (work/) — основной service worker приложения эту страницу не трогает.
const CACHE = 'tw-shell-v1';
const SHELL = ['./', 'index.html', 'work.js', 'work.css', 'manifest.webmanifest', '../css/style.css', '../js/config.js', '../icons/icon-192.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL.map((u) => new Request(u, { cache: 'reload' })))).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k.startsWith('tw-shell-') && k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.hostname === 'www.gstatic.com' && url.pathname.startsWith('/firebasejs/')) {
    e.respondWith(caches.match(req).then((hit) => hit || fetch(req).then((res) => { const copy = res.clone(); if (res.ok) caches.open(CACHE).then((c) => c.put(req, copy)); return res; })));
    return;
  }
  if (url.origin !== location.origin) return;
  if (req.mode === 'navigate') {
    e.respondWith(fetch(req.url, { cache: 'no-cache' }).then((res) => { const copy = res.clone(); if (res.ok) caches.open(CACHE).then((c) => c.put('index.html', copy)); return res; }).catch(() => caches.match('index.html')));
    return;
  }
  e.respondWith(caches.match(req).then((hit) => {
    const fresh = fetch(req, { cache: 'no-cache' }).then((res) => { const copy = res.clone(); if (res.ok) caches.open(CACHE).then((c) => c.put(req, copy)); return res; }).catch(() => hit);
    return hit || fresh;
  }));
});
