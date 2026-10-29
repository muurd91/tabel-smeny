// ================= Service worker: офлайн-оболочка приложения =================
// Кэшируются файлы приложения и библиотеки Firebase (gstatic.com); данные — в localStorage и Firestore.
// При любом изменении файлов приложения — tools/bump.sh: он поднимает VERSION здесь и ?v= в index.html
// (иначе телефон будет держать старую копию, а новая страница может получить старые скрипты).
const VERSION = '55';
const CACHE = `ts-shell-v${VERSION}`;

// Скрипты и стили — с ?v=VERSION, ровно как их запрашивает index.html.
const VERSIONED = ['css/style.css', 'css/splash.css', 'js/splash.js', 'js/config.js', 'js/data.js', 'js/cloud.js', 'js/xlsx.js', 'js/telegram.js', 'js/report.js', 'js/production.js', 'js/app.js', 'js/update.js'];

const SHELL = [
  './',
  'index.html',
  'manifest.webmanifest',
  ...VERSIONED.map((f) => `${f}?v=${VERSION}`),
  'icons/icon.svg',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/icon-maskable-512.png',
  'icons/apple-touch-icon.png',
  // Заставка (только телефон) — чтобы офлайн она была с картинками
  'icons/splash/logo.png',
  ...['red-flowers', 'pink-roses', 'red-sprout', 'terracotta', 'black-herb', 'white-planter'].map((p) => `icons/splash/pot-${p}.webp`),
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE)
      .then((c) => c.addAll(SHELL.map((url) => new Request(url, { cache: 'reload' }))))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith('ts-shell-') && k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  // Библиотеки Firebase: адрес с номером версии не меняется — из кэша, а нет — загрузить и сохранить.
  if (url.hostname === 'www.gstatic.com' && url.pathname.startsWith('/firebasejs/')) {
    e.respondWith(
      caches.match(req).then((cached) => cached || fetch(req).then((res) => {
        const copy = res.clone();
        if (res.ok) caches.open(CACHE).then((c) => c.put(req, copy));
        return res;
      })),
    );
    return;
  }
  if (url.origin !== location.origin) return;
  if (url.searchParams.has('check')) return; // проверка новой версии (js/update.js): всегда из сети, в кэш не кладём

  // Страница — «сначала сеть»: обновления приходят сразу, без сети открывается сохранённая копия.
  // В кэш кладём только страницу своей версии: если сайт уже обновился, а этот service worker старый,
  // новая страница со ссылками на ещё не скачанные скрипты офлайн не открылась бы.
  if (req.mode === 'navigate') {
    e.respondWith(
      fetch(req.url, { cache: 'no-cache' })
        .then((res) => {
          if (res.ok) {
            res.clone().text().then((html) => {
              if (html.includes(`name="app-version" content="${VERSION}"`)) {
                caches.open(CACHE).then((c) => c.put('index.html', new Response(html, { headers: res.headers })));
              }
            });
          }
          return res;
        })
        .catch(() => caches.match('index.html')),
    );
    return;
  }

  // Остальное — из кэша сразу, в фоне подтягиваем свежую версию на следующий раз.
  e.respondWith(
    caches.match(req).then((cached) => {
      const fresh = fetch(req, { cache: 'no-cache' })
        .then((res) => {
          const copy = res.clone();
          if (res.ok) caches.open(CACHE).then((c) => c.put(req, copy));
          return res;
        })
        .catch(() => cached);
      return cached || fresh;
    }),
  );
});
