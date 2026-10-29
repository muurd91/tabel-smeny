// Офлайн-оболочка страницы работников (/work/): страница — сначала сеть, остальное — из кэша с обновлением в фоне.
// Свой scope (work/) — основной service worker приложения эту страницу не трогает.
// Версия — та же, что у приложения: её поднимает tools/bump.sh вместе с ?v= в index.html и номером на странице.
const VERSION = '67';
const CACHE = `tw-shell-v${VERSION}`;
const SHELL = ['./', 'index.html', 'manifest.webmanifest', `work.js?v=${VERSION}`, `work.css?v=${VERSION}`, `../css/style.css?v=${VERSION}`, `../js/config.js?v=${VERSION}`, '../icons/icon-192.png'];

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
  if (url.searchParams.has('check')) return; // проверка новой версии (work.js): всегда из сети, в кэш не кладём
  if (req.mode === 'navigate') {
    // В кэш кладём только страницу своей версии: иначе новая страница со ссылками на ещё не скачанные скрипты офлайн не открылась бы
    e.respondWith(fetch(req.url, { cache: 'no-cache' }).then((res) => {
      if (res.ok) res.clone().text().then((html) => { if (html.includes(`name="app-version" content="${VERSION}"`)) caches.open(CACHE).then((c) => c.put('index.html', new Response(html, { headers: res.headers }))); });
      return res;
    }).catch(() => caches.match('index.html')));
    return;
  }
  e.respondWith(caches.match(req).then((hit) => {
    const fresh = fetch(req, { cache: 'no-cache' }).then((res) => { const copy = res.clone(); if (res.ok) caches.open(CACHE).then((c) => c.put(req, copy)); return res; }).catch(() => hit);
    return hit || fresh;
  }));
});
