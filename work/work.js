// ================= Страница работников смены: сданная продукция =================
// Отдельная от табеля страница (/work/): вход по логину и паролю (общий на смену), список РАБОТАЮЩИХ станков
// (владелец отмечает их в приложении: статус и вид продукции у каждого) с кнопкой «Сдать продукцию» —
// окно «сколько, в чём, какой цвет, во сколько»; вид продукции подставляется от станка.
// Данные — в Firestore проекта табеля, коллекция shipments; правила (firestore.rules) пускают сюда только
// почту работников и владельца, табель и настройки бота отсюда не видны. Итог смены в Telegram шлёт бот
// по расписанию (remind/shift-summary.mjs).

(() => {
  const cfg = CONFIG.firebase;
  const CDN = `https://www.gstatic.com/firebasejs/${cfg.sdk || '13.0.0'}`;
  const DOMAIN = 'tabel-smeny.app'; // логин «smena1» → почта smena1@tabel-smeny.app (настоящей почты нет, письма не ходят)

  const $ = (s) => document.querySelector(s);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const pad = (n) => String(n).padStart(2, '0');
  const isoDate = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const hhmm = (d) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  const num = (n) => String(n).replace('.', ',');
  const lsGet = (k) => { try { return localStorage.getItem(k) || ''; } catch { return ''; } };
  const lsSet = (k, v) => { try { localStorage.setItem(k, v); } catch { /* без localStorage — не запоминаем */ } };

  // ---------- Смена по времени: дневная 7:30–19:30, ночная 19:30–7:30 (до 7:30 — ещё вчерашняя ночная) ----------
  function shiftOf(now = new Date()) {
    const mins = now.getHours() * 60 + now.getMinutes();
    const day = new Date(now); day.setHours(0, 0, 0, 0);
    const night = mins >= 19 * 60 + 30 || mins < 7 * 60 + 30;
    const startDay = new Date(day);
    if (mins < 7 * 60 + 30) startDay.setDate(startDay.getDate() - 1);
    const start = new Date(startDay); start.setHours(night ? 19 : 7, 30, 0, 0);
    return { id: `${isoDate(startDay)}${night ? 'Н' : 'Д'}`, night, start, end: new Date(start.getTime() + 12 * 3600e3) };
  }
  const shiftTitle = (s) => `${s.night ? 'Ночная' : 'Дневная'} смена · ${pad(s.start.getDate())}.${pad(s.start.getMonth() + 1)} · ${s.night ? '19:30–7:30' : '7:30–19:30'}`;

  // Время отвоза «ЧЧ:ММ» → момент внутри смены (ночью после полуночи — уже следующая дата)
  function atOf(time, shift) {
    const [h, m] = time.split(':').map(Number);
    const d = new Date(shift.start); d.setHours(h, m, 0, 0);
    if (d < shift.start - 30 * 60e3) d.setDate(d.getDate() + 1);
    return d;
  }

  // ---------- Firebase ----------
  let fb = null;
  async function load() {
    if (fb) return fb;
    const [app, auth, fs] = await Promise.all([
      import(`${CDN}/firebase-app.js`), import(`${CDN}/firebase-auth.js`), import(`${CDN}/firebase-firestore.js`),
    ]);
    const a = app.initializeApp(cfg, 'work');
    let db;
    try { db = fs.initializeFirestore(a, { localCache: fs.persistentLocalCache({ tabManager: fs.persistentMultipleTabManager() }) }); }
    catch { db = fs.getFirestore(a); }
    fb = { auth, fs, au: auth.getAuth(a), db };
    return fb;
  }

  function explain(e) {
    const code = String(e?.code || '');
    const map = {
      'auth/invalid-credential': 'Неверный логин или пароль.',
      'auth/wrong-password': 'Неверный логин или пароль.',
      'auth/user-not-found': 'Неверный логин или пароль.',
      'auth/invalid-email': 'Неверный логин.',
      'auth/too-many-requests': 'Слишком много попыток — подождите несколько минут.',
      'auth/network-request-failed': 'Нет связи с интернетом.',
      'auth/operation-not-allowed': 'Вход по паролю не включён в Firebase (Authentication → Sign-in method → Email/Password).',
      'permission-denied': 'Нет доступа: этот логин не допущен к записи продукции.',
    };
    return map[code] || `Ошибка: ${e?.message || code || 'неизвестная'}`;
  }

  // ---------- Состояние ----------
  let user = null;
  let shift = shiftOf();
  let entries = [];
  let products = [];
  let colors = [];
  let machines = []; // { name, on, product } — отмечает владелец в приложении
  let unsubs = [];
  let lastUnit = 'коробок'; // единица, выбранная в прошлый раз
  const creds = { name: '', pass: '' }; // логин и пароль переживают перерисовку (после ошибки не стираются)
  const unitOf = (e) => (e.unit === 'штук' ? 'штук' : 'коробок'); // записи без единицы — коробки
  const totalText = (list) => ['коробок', 'штук'].map((u) => [u, list.filter((e) => unitOf(e) === u).reduce((s, e) => s + e.qty, 0)]).filter(([, q]) => q).map(([u, q]) => `${num(q)} ${u}`).join(', ') || '0';
  const nameOf = (e) => [e.product, e.color, e.noHoles ? 'без отверстий' : ''].filter(Boolean).join(', ');
  let error = '';
  let loggingIn = false; // идёт вход
  let draft = null;      // открытое окно «Сдать продукцию»

  function subscribe() {
    unsubs.forEach((u) => u());
    unsubs = [];
    if (!user) return;
    const { fs, db } = fb;
    unsubs.push(fs.onSnapshot(fs.query(fs.collection(db, 'shipments'), fs.where('shift', '==', shift.id)), (snap) => {
      entries = snap.docs.map((d) => ({ id: d.id, ...d.data() })).sort((a, b) => a.at.localeCompare(b.at));
      render();
    }, (e) => { error = explain(e); render(); }));
    unsubs.push(fs.onSnapshot(fs.doc(db, 'settings', 'production'), (snap) => {
      const d = snap.exists() ? snap.data() : {};
      products = Array.isArray(d.products) ? d.products.map(String).filter(Boolean) : [];
      colors = Array.isArray(d.colors) ? d.colors.map(String).filter(Boolean) : [];
      machines = Array.isArray(d.machines) ? d.machines.filter((m) => m && m.name).map((m) => ({ name: String(m.name), on: !!m.on, product: String(m.product || '') })) : [];
      render();
    }, () => { /* настроек нет — станков в списке не будет, сдать можно вручную */ }));
  }

  // ---------- Вход ----------
  async function login(name, pass) {
    const email = name.includes('@') ? name.trim() : `${name.trim().toLowerCase()}@${DOMAIN}`;
    await load();
    await fb.auth.signInWithEmailAndPassword(fb.au, email, pass);
  }

  // ---------- Окно «Сдать продукцию» ----------
  const sheet = () => $('#sheet');
  const sheetBody = () => $('#sheet-body');

  function openSheet(machineName) {
    const m = machines.find((x) => x.name === machineName);
    // Цвет — как в прошлый раз у этого станка (на этой смене, иначе последний на этом телефоне)
    const last = [...entries].reverse().find((e) => e.machine === machineName && e.color);
    const prev = last?.color || lsGet(`work.color.${machineName}`) || 'чёрный'; // по умолчанию чёрный
    const lastRun = [...entries].reverse().find((e) => e.machine === machineName);
    draft = { machine: machineName, fixed: !!m?.product, product: m?.product || '', pick: '', other: '', qty: '', unit: lastUnit, color: '', colorOther: '', time: '', touched: false, err: '', busy: false, noHoles: !!lastRun?.noHoles };
    if (prev) {
      // «чёрный» и «черный» — одно и то же
      const same = colors.find((c) => c.toLowerCase().replace(/ё/g, 'е') === prev.toLowerCase().replace(/ё/g, 'е'));
      if (same) draft.color = same;
      else if (colors.length) { if (prev !== 'чёрный') { draft.color = '__other'; draft.colorOther = prev; } } // чёрного нет в списке — без цвета, не навязываем
      else draft.colorOther = prev;
    }
    renderSheet();
    if (!sheet().open) sheet().showModal();
    placeThumb(false);
    setTimeout(() => $('#s-qty')?.focus(), 50);
  }

  function renderSheet() {
    const d = draft;
    if (!d) return;
    const productBlock = d.fixed ? '' : `
      <label class="field"><span class="field__label">Вид продукции</span>
        ${products.length
    ? `<select class="input" id="s-pick"><option value="">— выберите —</option>${products.map((p) => `<option value="${esc(p)}"${d.pick === p ? ' selected' : ''}>${esc(p)}</option>`).join('')}<option value="__other"${d.pick === '__other' ? ' selected' : ''}>Другое…</option></select>`
    : `<input class="input" id="s-other" value="${esc(d.other)}" autocomplete="off">`}</label>
      ${products.length && d.pick === '__other' ? `<label class="field"><span class="field__label">Какая продукция</span><input class="input" id="s-other" value="${esc(d.other)}" autocomplete="off"></label>` : ''}`;
    const colorBlock = colors.length
      ? `<div class="field__label">Цвет</div>
         <div class="chips">${colors.map((c) => `<button class="chip${d.color === c ? ' is-on' : ''}" data-color="${esc(c)}" type="button">${esc(c)}</button>`).join('')}<button class="chip${d.color === '__other' ? ' is-on' : ''}" data-color="__other" type="button">Другой…</button></div>
         ${d.color === '__other' ? `<label class="field"><span class="field__label">Какой цвет</span><input class="input" id="s-color-other" value="${esc(d.colorOther)}" autocomplete="off"></label>` : ''}`
      : `<label class="field"><span class="field__label">Цвет</span><input class="input" id="s-color-other" value="${esc(d.colorOther)}" autocomplete="off" placeholder="если есть"></label>`;
    sheetBody().innerHTML = `<div class="sheet__grip" tabindex="-1"></div>
      <h3>${esc(d.machine || 'Продукция не со станка')}</h3>
      <p class="sheet__sub">${d.fixed ? esc(d.product) : 'укажите вид продукции'}</p>
      ${productBlock}
      <div class="field"><span class="field__label">Количество</span>
        <div class="row row--nowrap">
          <input class="input wqty" id="s-qty" type="text" inputmode="decimal" value="${esc(d.qty)}" autocomplete="off" placeholder="0">
          <div class="seg wunit" role="tablist" aria-label="Единица"><span class="wthumb" aria-hidden="true"></span>${['коробок', 'штук'].map((u) => `<button class="seg__btn${d.unit === u ? ' is-on' : ''}" data-unit="${u}" role="tab" aria-selected="${d.unit === u}" type="button">${u}</button>`).join('')}</div>
        </div></div>
      ${colorBlock}
      <label class="check mt-12"><input type="checkbox" id="s-noholes"${d.noHoles ? ' checked' : ''}><span>Без отверстий</span></label>
      <label class="field"><span class="field__label">Время отвоза</span>
        <input class="input input--short" id="s-time" type="time" value="${esc(d.touched ? d.time : hhmm(new Date()))}"></label>
      <p class="werr" id="s-err">${esc(d.err)}</p>
      <div class="sheet__actions"><button class="btn" value="cancel">Отмена</button><button class="btn btn--primary" id="s-save" type="button" ${d.busy ? 'disabled' : ''}>${d.busy ? 'Записываю…' : 'Сдать'}</button></div>`;
    placeThumb(false);
  }

  async function saveSheet() {
    const d = draft;
    if (!d || d.busy) return;
    const qty = Number(String(d.qty).replace(',', '.'));
    const product = (d.fixed ? d.product : (products.length && d.pick !== '__other' ? d.pick : d.other)).trim();
    const color = (colors.length && d.color !== '__other' ? d.color : d.colorOther).trim();
    const fail = (m) => { d.err = m; renderSheet(); };
    if (!product) return fail('Укажите вид продукции.');
    if (!(qty > 0)) return fail('Укажите количество.');
    const at = atOf(d.touched ? d.time : hhmm(new Date()), shift);
    if (at < shift.start - 30 * 60e3 || at > shift.end.getTime() + 60 * 60e3) return fail('Время отвоза не входит в эту смену.');
    d.err = '';
    d.busy = true;
    renderSheet();
    try {
      const { fs, db } = fb;
      await fs.addDoc(fs.collection(db, 'shipments'), {
        shift: shift.id, qty, unit: d.unit, product, ...(color ? { color } : {}), ...(d.machine ? { machine: d.machine } : {}),
        ...(d.noHoles ? { noHoles: true } : {}), at: at.toISOString(), by: (user.email || '').split('@')[0], createdAt: fs.serverTimestamp(),
      });
      lastUnit = d.unit;
      if (d.machine) lsSet(`work.color.${d.machine}`, color);
      draft = null;
      sheet().close();
    } catch (e) { d.busy = false; fail(explain(e)); }
  }

  async function removeEntry(id) {
    if (!confirm('Удалить эту запись?')) return;
    try { await fb.fs.deleteDoc(fb.fs.doc(fb.db, 'shipments', id)); } catch (e) { error = explain(e); render(); }
  }

  // ---------- Ползунок «коробок | штук»: стеклянная капля перетекает на новое место ----------
  // Не перерисовываем окно (иначе анимировать нечего): двигаем один и тот же элемент. Капля растягивается
  // в сторону движения, перетекает и слегка пружинит. Если у человека включено «уменьшить анимацию» — просто переезжает.
  function placeThumb(animate) {
    const seg = $('#sheet .wunit');
    const thumb = seg?.querySelector('.wthumb');
    const on = seg?.querySelector('.is-on');
    if (!thumb || !on || !on.offsetWidth) return;
    const to = { left: on.offsetLeft, width: on.offsetWidth };
    const from = { left: parseFloat(thumb.style.left) || to.left, width: parseFloat(thumb.style.width) || to.width };
    thumb.style.left = to.left + 'px';
    thumb.style.width = to.width + 'px';
    if (!animate || from.left === to.left || matchMedia('(prefers-reduced-motion: reduce)').matches || !thumb.animate) return;
    const l = Math.min(from.left, to.left);
    const r = Math.max(from.left + from.width, to.left + to.width);
    thumb.animate([
      { left: from.left + 'px', width: from.width + 'px', transform: 'scale(1, 1)' },
      { left: l + 'px', width: (r - l) + 'px', transform: 'scale(1, .86)', offset: 0.4 }, // вытянулась через обе половины
      { left: to.left + 'px', width: to.width * 1.06 + 'px', transform: 'scale(1.03, 1.06)', offset: 0.75 }, // «плюхнулась» на место
      { left: to.left + 'px', width: to.width + 'px', transform: 'scale(1, 1)' },
    ], { duration: 560, easing: 'cubic-bezier(.3, .7, .3, 1)' });
  }
  function setUnit(u) {
    if (!draft || draft.unit === u) return;
    draft.unit = u;
    document.querySelectorAll('#sheet .wunit .seg__btn').forEach((b) => {
      const on = b.dataset.unit === u;
      b.classList.toggle('is-on', on);
      b.setAttribute('aria-selected', on);
    });
    placeThumb(true);
  }
  window.addEventListener('resize', () => placeThumb(false));

  // ---------- Экран ----------
  function render() {
    const app = $('#app');
    $('#shift').textContent = user ? shiftTitle(shift) : '';
    if (!user) { renderLogin(app); return; }
    const working = machines.filter((m) => m.on);
    app.innerHTML = `
      <div class="card">
        <h2>Станки</h2>
        ${working.length
    ? working.map((m) => `<div class="wm"><div class="wm__info"><b>${esc(m.name)}</b><span class="small muted">${esc(m.product || 'вид продукции не указан')}</span></div>
            <button class="btn btn--primary wm__btn" data-mach="${esc(m.name)}" type="button">Сдать продукцию</button></div>`).join('')
    : '<p class="muted">Работающих станков в списке нет — мастер их ещё не отметил.</p>'}
        <button class="wlink wm__other" data-mach="" type="button">Сдать продукцию не со станка</button>
        <p class="werr" id="f-err">${esc(error)}</p>
      </div>
      <div class="card"><h2>Сдано за смену</h2><div id="list">${listHtml()}</div></div>
      <div class="wbar"><button class="wlink" id="f-out" type="button">Выйти</button></div>`;
  }

  function listHtml() {
    if (!entries.length) return '<p class="muted">Пока ничего не записано.</p>';
    const sums = new Map();
    for (const e of entries) { const k = `${nameOf(e)}|${unitOf(e)}`; sums.set(k, (sums.get(k) || 0) + e.qty); }
    return `<ul class="wlist">${entries.map((e) => `<li>
        <span class="wlist__qty">${num(e.qty)} ${unitOf(e)}</span>
        <span class="wlist__main">${esc(nameOf(e))}<br><span class="small muted">${e.machine ? `${esc(e.machine)} · ` : ''}отвезли в ${hhmm(new Date(e.at))}</span></span>
        <button class="btn btn--icon" data-del="${esc(e.id)}" type="button" aria-label="Удалить запись">✕</button></li>`).join('')}</ul>
      <div class="mt-12">${[...sums].map(([k, q]) => { const [p, u] = k.split('|'); return `<div class="wsum"><span>${esc(p)}</span><b>${num(q)} ${u}</b></div>`; }).join('')}
        <div class="wsum"><span><b>Всего</b></span><b>${totalText(entries)}</b></div></div>`;
  }

  function renderLogin(app) {
    app.innerHTML = `<div class="card">
      <h2>Вход</h2>
      <label class="field"><span class="field__label">Логин</span><input class="input" id="l-name" value="${esc(creds.name)}" autocomplete="username" autocapitalize="none" autocorrect="off"></label>
      <label class="field"><span class="field__label">Пароль</span><input class="input" id="l-pass" type="password" value="${esc(creds.pass)}" autocomplete="current-password"></label>
      <button class="btn btn--primary btn--block mt-12" id="l-go" type="button" ${loggingIn ? 'disabled' : ''}>${loggingIn ? 'Вхожу…' : 'Войти'}</button>
      <p class="werr" id="l-err">${esc(error)}</p>
    </div>`;
  }

  // ---------- События ----------
  document.addEventListener('input', (e) => {
    const id = e.target.id;
    if (id === 'l-name') creds.name = e.target.value;
    else if (id === 'l-pass') creds.pass = e.target.value;
    else if (!draft) return;
    else if (id === 's-qty') draft.qty = e.target.value;
    else if (id === 's-other') draft.other = e.target.value;
    else if (id === 's-color-other') draft.colorOther = e.target.value;
    else if (id === 's-time') { draft.time = e.target.value; draft.touched = true; }
  });
  document.addEventListener('change', (e) => {
    if (draft && e.target.id === 's-noholes') draft.noHoles = e.target.checked;
    else if (draft && e.target.id === 's-pick') { draft.pick = e.target.value; renderSheet(); $('#s-qty')?.focus(); }
  });
  document.addEventListener('click', async (e) => {
    const t = e.target.closest('button');
    if (!t) return;
    if (t.id === 's-save') saveSheet();
    else if (t.dataset.unit) setUnit(t.dataset.unit);
    else if (t.dataset.color !== undefined) {
      if (draft) {
        draft.color = draft.color === t.dataset.color ? '' : t.dataset.color;
        if (draft.color !== '__other') draft.colorOther = '';
        renderSheet();
        if (draft.color === '__other') $('#s-color-other')?.focus(); // «Другой» — цвет пишут от руки
      }
    } else if (t.dataset.mach !== undefined) openSheet(t.dataset.mach);
    else if (t.id === 'f-out') { await fb.auth.signOut(fb.au); }
    else if (t.dataset.del) removeEntry(t.dataset.del);
    else if (t.id === 'l-go') {
      error = '';
      loggingIn = true;
      render();
      try { await login($('#l-name').value, $('#l-pass').value); creds.pass = ''; }
      catch (err) { error = explain(err); }
      loggingIn = false;
      if (!user) render();
    }
  });
  // Enter в окне — «Сдать» (а не закрытие окна)
  document.addEventListener('submit', (e) => {
    if (e.submitter?.value === 'cancel') return;
    e.preventDefault();
    saveSheet();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && e.target.matches('#l-name, #l-pass')) $('#l-go')?.click();
  });
  document.addEventListener('close', (e) => { if (e.target.id === 'sheet') draft = null; }, true);

  // ---------- Запуск ----------
  // Смена сменилась (7:30 или 19:30) — переключить список
  setInterval(() => {
    const s = shiftOf();
    if (s.id !== shift.id) { shift = s; entries = []; subscribe(); render(); }
  }, 30000);

  // На телефоне владельца ссылка на эту страницу открывается внутри приложения «Табель смены» — нужен путь назад.
  // Данные табеля есть в localStorage только там, где открывали само приложение (тот же адрес сайта); у работников кнопки нет.
  try { if (localStorage.getItem('ts.data')) $('#back').hidden = false; } catch { /* без localStorage — без кнопки */ }

  load().then(() => {
    fb.auth.onAuthStateChanged(fb.au, (u) => {
      user = u;
      error = '';
      shift = shiftOf();
      subscribe();
      render();
    });
  }).catch((e) => { error = explain(e); render(); });
  render();

  if ('serviceWorker' in navigator && location.protocol.startsWith('http')) navigator.serviceWorker.register('sw.js').catch(() => {});
})();
