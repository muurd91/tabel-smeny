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
  const hm = (d) => `${d.getHours()}:${pad(d.getMinutes())}`; // в шапке без нуля впереди, как в приложении: 7:30
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
  const WD = ['Вс', 'Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб'];
  const MONTHS_GEN = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];
  const durText = (ms) => { const min = Math.max(1, Math.ceil(ms / 60000)); const h = Math.floor(min / 60); const m = min % 60; return [h ? `${h} ч` : '', m ? `${m} мин` : ''].filter(Boolean).join(' '); };

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
  let perBox = {}; // вид продукции → горшков в коробке (задаёт мастер)
  let machines = []; // { name, on, product } — отмечает владелец в приложении
  let schedule = null; // график бригады { anchor, cycle } — приложение владельца кладёт его рядом со списками
  let unsubs = [];
  let lastUnit = 'коробок'; // единица, выбранная в прошлый раз
  const creds = { name: '', pass: '' }; // логин и пароль переживают перерисовку (после ошибки не стираются)
  const unitOf = (e) => (e.unit === 'штук' ? 'штук' : 'коробок'); // записи без единицы — коробки
  // Горшков в коробке по видам продукции (задаёт мастер в «Настройках»): записи в коробках пересчитываются в горшки
  const potsOf = (e) => (unitOf(e) === 'коробок' && perBox[e.product] ? Math.round(e.qty * perBox[e.product] * 100) / 100 : 0);
  // Всего горшков: пересчитанные коробки + штуки; коробки вида без числа горшков считаем отдельно
  const potsLine = (list) => {
    if (!list.some(potsOf)) return '';
    const pots = list.reduce((s, e) => s + (unitOf(e) === 'штук' ? e.qty : potsOf(e)), 0);
    const rest = list.filter((e) => unitOf(e) === 'коробок' && !potsOf(e)).reduce((s, e) => s + e.qty, 0);
    return `${num(Math.round(pots * 100) / 100)} горшков${rest ? ` + ${num(rest)} коробок без пересчёта` : ''}`;
  };
  const totalText = (list) => ['коробок', 'штук'].map((u) => [u, list.filter((e) => unitOf(e) === u).reduce((s, e) => s + e.qty, 0)]).filter(([, q]) => q).map(([u, q]) => `${num(q)} ${u}`).join(', ') || '0';
  // Когда запись добавлена: createdAt = null — ещё не дошла до сервера (самая свежая); у старых записей поля нет — берём время отвоза
  const addedAt = (e) => (e.createdAt?.toMillis ? e.createdAt.toMillis() : 'createdAt' in e ? Infinity : Date.parse(e.at));
  // Запись списка тремя столбцами: станок над временем, вид продукции над цветом, количество по центру
  const rowText = (e) => `<div class="rec__col"><b>${e.machine ? esc(e.machine) : '—'}</b><span>${hhmm(new Date(e.at))}</span></div><div class="rec__col rec__col--p"><span>${esc(e.product || '—')}</span><span class="rec__sub">${esc([e.color, e.noHoles ? 'без отверстий' : ''].filter(Boolean).join(', ') || ' ')}</span></div><div class="rec__col rec__q"><b>${num(e.qty)} ${unitOf(e)}</b>${potsOf(e) ? `<span class="rec__sub">${num(potsOf(e))} горшков</span>` : ''}</div>`;
  let error = '';
  let loggingIn = false; // идёт вход
  let draft = null;      // открытое окно «Сдать продукцию»
  let pending = false;   // есть записи, ещё не ушедшие в облако (нет связи)
  // Своё устройство мастера (там открывали приложение с табелем): в шапке — путь назад в «Табель смены»
  const ownerDevice = !!(lsGet('ts.data') || lsGet('ts.owner'));

  function subscribe() {
    unsubs.forEach((u) => u());
    unsubs = [];
    if (!user) return;
    const { fs, db } = fb;
    unsubs.push(fs.onSnapshot(fs.query(fs.collection(db, 'shipments'), fs.where('shift', '==', shift.id)), (snap) => {
      entries = snap.docs.map((d) => ({ id: d.id, ...d.data() })).sort((a, b) => addedAt(b) - addedAt(a)); // сверху — последняя добавленная
      pending = !!snap.metadata?.hasPendingWrites;
      renderHeader();
      render();
    }, (e) => { error = explain(e); render(); }));
    unsubs.push(fs.onSnapshot(fs.doc(db, 'settings', 'production'), (snap) => {
      const d = snap.exists() ? snap.data() : {};
      products = Array.isArray(d.products) ? d.products.map(String).filter(Boolean) : [];
      colors = Array.isArray(d.colors) ? d.colors.map(String).filter(Boolean) : [];
      perBox = Object.fromEntries((Array.isArray(d.pots) ? d.pots : []).filter((p) => p && p.name && p.n > 0).map((p) => [String(p.name), Number(p.n)]));
      schedule = d.schedule?.anchor && d.schedule?.cycle ? { anchor: String(d.schedule.anchor), cycle: String(d.schedule.cycle) } : null;
      machines = Array.isArray(d.machines) ? d.machines.filter((m) => m && m.name).map((m) => ({ name: String(m.name), on: !!m.on, product: String(m.product || '') })) : [];
      renderHeader();
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

  // Поле «Какой цвет» под плашками (меняется на месте, окно не перерисовываем — иначе капле не по чему перетекать)
  const colorExtra = (d) => (d.color === '__other' ? `<label class="field"><span class="field__label">Какой цвет</span><input class="input" id="s-color-other" value="${esc(d.colorOther)}" autocomplete="off"></label>` : '');

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
         <div class="chips wchips"><span class="cthumb" aria-hidden="true"></span>${colors.map((c) => `<button class="chip${d.color === c ? ' is-on' : ''}" data-color="${esc(c)}" type="button"><span class="chip__t">${esc(c)}</span></button>`).join('')}<button class="chip${d.color === '__other' ? ' is-on' : ''}" data-color="__other" type="button"><span class="chip__t">Другой…</span></button></div>
         <div id="s-color-extra">${colorExtra(d)}</div>`
      : `<label class="field"><span class="field__label">Цвет</span><input class="input" id="s-color-other" value="${esc(d.colorOther)}" autocomplete="off" placeholder="если есть"></label>`;
    sheetBody().innerHTML = `<div class="sheet__grip" tabindex="-1"></div>
      <h3>${esc(d.machine || 'Продукция не со станка')}</h3>
      <p class="sheet__sub">${d.fixed ? esc(d.product) : 'укажите вид продукции'}</p>
      ${productBlock}
      <div class="field"><span class="field__label">Количество</span>
        <div class="row row--nowrap">
          <input class="input wqty" id="s-qty" type="text" inputmode="decimal" value="${esc(d.qty)}" autocomplete="off" placeholder="0">
          <div class="seg wunit" role="tablist" aria-label="Единица"><span class="wthumb" aria-hidden="true"></span>${['коробок', 'штук'].map((u) => `<button class="seg__btn${d.unit === u ? ' is-on' : ''}" data-unit="${u}" role="tab" aria-selected="${d.unit === u}" type="button">${u}</button>`).join('')}</div>
        </div>
        <p class="small muted wpots" id="s-pots"></p></div>
      ${colorBlock}
      <div class="row row--nowrap wtimerow">
        <label class="field field--flush"><span class="field__label">Время отвоза</span>
          <input class="input input--short" id="s-time" type="time" value="${esc(d.touched ? d.time : hhmm(new Date()))}"></label>
        <div class="field field--flush grow"><span class="field__label">Отверстия</span>
          <div class="seg wunit wholes" role="tablist" aria-label="Отверстия"><span class="wthumb" aria-hidden="true"></span>${[['yes', 'есть'], ['no', 'нет']].map(([k, label]) => `<button class="seg__btn${(d.noHoles ? 'no' : 'yes') === k ? ' is-on' : ''}" data-holes="${k}" role="tab" aria-selected="${(d.noHoles ? 'no' : 'yes') === k}" type="button">${label}</button>`).join('')}</div></div>
      </div>
      <p class="werr" id="s-err">${esc(d.err)}</p>
      <div class="sheet__actions"><button class="btn" value="cancel">Отмена</button><button class="btn btn--primary" id="s-save" type="button" ${d.busy ? 'disabled' : ''}>${d.busy ? 'Записываю…' : 'Сдать'}</button></div>`;
    placeThumb(false);
    updatePots();
  }

  // Подсказка под количеством: сколько это в горшках (пока человек вводит, окно не перерисовываем)
  function updatePots() {
    const el = $('#s-pots');
    if (!el || !draft) return;
    const d = draft;
    const product = (d.fixed ? d.product : (products.length && d.pick !== '__other' ? d.pick : d.other)).trim();
    const n = perBox[product];
    const qty = Number(String(d.qty).replace(',', '.'));
    el.textContent = d.unit !== 'коробок' || !n ? '' : qty > 0 ? `${num(qty)} × ${n} = ${num(Math.round(qty * n * 100) / 100)} горшков` : `В коробке ${n} горшков`;
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

  // ---------- Ползунок «коробок | штук»: капля перетекает на новое место ----------
  // Не перерисовываем окно (иначе анимировать нечего): двигаем один и тот же элемент. Капля растягивается
  // в сторону движения, перетекает и слегка пружинит. Если у человека включено «уменьшить анимацию» — просто переезжает.
  // Плашки цветов: одна капля переезжает на выбранную (плашки идут в несколько рядов — двигаем и по горизонтали, и по вертикали).
  // В пределах ряда растягивается, как в переключателях; между рядами — плавно «переплывает». Ничего не выбрано — гаснет.
  function placeChips(animate) {
    const box = document.querySelector('#sheet .wchips');
    const thumb = box?.querySelector('.cthumb');
    if (!thumb) return;
    const on = box.querySelector('.chip.is-on');
    if (!on || !on.offsetWidth) { thumb.style.opacity = '0'; thumb.dataset.on = ''; return; }
    const to = { left: on.offsetLeft, top: on.offsetTop, width: on.offsetWidth, height: on.offsetHeight };
    const had = thumb.dataset.on === '1';
    const from = had ? { left: parseFloat(thumb.style.left), top: parseFloat(thumb.style.top), width: parseFloat(thumb.style.width), height: parseFloat(thumb.style.height) } : null;
    for (const k of ['left', 'top', 'width', 'height']) thumb.style[k] = to[k] + 'px';
    thumb.style.opacity = '1';
    thumb.dataset.on = '1';
    if (!animate || matchMedia('(prefers-reduced-motion: reduce)').matches || !thumb.animate) return;
    const px = (r) => ({ left: r.left + 'px', top: r.top + 'px', width: r.width + 'px', height: r.height + 'px' });
    if (!from) { thumb.animate([{ opacity: 0, transform: 'scale(.6)' }, { opacity: 1, transform: 'scale(1)' }], { duration: 240, easing: 'cubic-bezier(.3, .7, .3, 1)' }); return; }
    if (from.left === to.left && from.top === to.top) return;
    // Как у переключателей: вытягивается в сторону движения, перетекает и слегка «плюхается» на место.
    // В пределах ряда растягивается через обе плашки; на другой ряд — растягивается по диагонали между ними (не закрывая соседей).
    const same = Math.abs(from.top - to.top) < 4;
    const mid = same
      ? { left: Math.min(from.left, to.left), top: from.top, width: Math.max(from.left + from.width, to.left + to.width) - Math.min(from.left, to.left), height: from.height }
      : { left: (from.left + to.left) / 2, top: (from.top + to.top) / 2, width: (from.width + to.width) / 2 * 1.25, height: (from.height + to.height) / 2 };
    thumb.animate([
      { ...px(from), transform: 'scale(1, 1)' },
      { ...px(mid), transform: 'scale(1, .86)', offset: 0.4 },
      { ...px({ ...to, width: to.width * 1.06 }), transform: 'scale(1.03, 1.06)', offset: 0.75 },
      { ...px(to), transform: 'scale(1, 1)' },
    ], { duration: 560, easing: 'cubic-bezier(.3, .7, .3, 1)' });
  }
  function placeThumb(animate, seg) {
    if (!seg) { document.querySelectorAll('#sheet .wunit').forEach((s) => placeThumb(animate, s)); placeChips(animate); return; }
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
  // Переключатель «коробок | штук» и «отверстия есть | нет»: не перерисовываем окно, двигаем каплю
  function setSeg(btn) {
    if (!draft) return;
    const key = btn.dataset.unit ? 'unit' : 'holes';
    const val = btn.dataset.unit || btn.dataset.holes;
    if (key === 'unit') { if (draft.unit === val) return; draft.unit = val; updatePots(); }
    else { if (draft.noHoles === (val === 'no')) return; draft.noHoles = val === 'no'; }
    const seg = btn.closest('.wunit');
    seg.querySelectorAll('.seg__btn').forEach((b) => {
      const on = b === btn;
      b.classList.toggle('is-on', on);
      b.setAttribute('aria-selected', on);
    });
    placeThumb(true, seg);
  }
  window.addEventListener('resize', () => placeThumb(false));

  // Итоги рядами в 2 строки: вид продукции над цветом, количество над горшками; внизу «Всего»
  const sumsHtml = (list) => {
    const groups = new Map();
    for (const e of list) {
      const sub = [e.color, e.noHoles ? 'без отверстий' : ''].filter(Boolean).join(', ');
      const k = `${e.product}|${sub}`;
      if (!groups.has(k)) groups.set(k, { product: e.product, sub, items: [] });
      groups.get(k).items.push(e);
    }
    const row = (top, sub, qty, pots, cls = '') => `<div class="sumrow${cls}"><div class="rec__col"><span class="sumrow__top">${top}</span><span class="rec__sub">${sub || '&nbsp;'}</span></div><div class="rec__col rec__q"><b>${qty}</b><span class="rec__sub">${pots || '&nbsp;'}</span></div></div>`;
    const potsText = (items) => (items.some(potsOf) ? `${num(Math.round(items.reduce((s, e) => s + (unitOf(e) === 'штук' ? e.qty : potsOf(e)), 0) * 100) / 100)} горшков` : '');
    return [...groups.values()].map((g) => row(esc(g.product || '—'), esc(g.sub), totalText(g.items), potsText(g.items))).join('')
      + row('Всего', '', totalText(list), potsLine(list), ' sumrow--total');
  };
  // ---------- Шапка (как в приложении «Табель смены») ----------
  // Тип смены бригады в этот день по графику: Д, Н, В; графика ещё нет — null
  function crewType(day) {
    if (!schedule) return null;
    const n = schedule.cycle.length;
    const dn = (d) => Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) / 864e5;
    const [y, m, dd] = schedule.anchor.split('-').map(Number);
    return schedule.cycle[(((dn(day) - Date.UTC(y, m - 1, dd) / 864e5) % n) + n) % n];
  }
  // Как в приложении: смотрим на смену НАШЕЙ бригады в текущий день смены (до 7:30 — ещё вчерашний) — до начала, идёт или закончилась
  function renderHeader() {
    const now = new Date();
    const cur = shiftOf(now); // день смены по времени суток
    const day = new Date(cur.start); day.setHours(0, 0, 0, 0);
    const t = crewType(day) || (cur.night ? 'Н' : 'Д'); // графика нет — как по времени суток
    // Дата и день недели — настоящие (ночная смена идёт и после полуночи: смена 30-го, а на календаре уже 31-е)
    const title = `${{ Д: 'Дневная', Н: 'Ночная' }[t] || 'Выходной'} · ${WD[now.getDay()]}, ${now.getDate()} ${MONTHS_GEN[now.getMonth()]}`;
    let main = 'Выходной по графику';
    let sub = '';
    let pct = null;
    if (t !== 'В') {
      const start = new Date(day); start.setHours(t === 'Н' ? 19 : 7, 30, 0, 0);
      const end = new Date(start.getTime() + 12 * 3600e3);
      const span = `${hm(start)}–${hm(end)}`;
      if (now < start) { main = start - now < 864e5 ? `До начала ${durText(start - now)}` : 'Смена впереди'; sub = span; pct = 0; }
      else if (now < end) {
        // Последняя смена перед выходными (следующий день по графику — «В»): считаем до начала выходных
        const next = new Date(day); next.setDate(next.getDate() + 1);
        const last = crewType(next) === 'В';
        main = last ? `До выходных осталось ${durText(end - now)}` : `Осталось ${durText(end - now)}`;
        sub = last ? '' : `до ${hm(end)}`; pct = (now - start) / (end - start) * 100;
      }
      else { main = 'Смена закончилась'; sub = span; pct = 100; }
    }
    $('#shiftbar').innerHTML = `
      <div class="shiftbar__date"><span class="shiftbar__title">${title}</span></div>
      <div class="shiftbar__status"><b>${main}</b>${sub ? `<span>${sub}</span>` : ''}</div>
      ${pct === null ? '' : `<div class="shiftbar__track" role="progressbar" aria-label="Ход смены" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${Math.round(pct)}"><div class="shiftbar__fill${pct >= 100 ? ' is-done' : ''}"></div></div>`}
      ${ownerDevice ? '<a class="shiftbar__back" href="../">← Табель смены</a>' : ''}`;
    const fill = $('.shiftbar__fill');
    if (fill) fill.style.width = `${pct}%`;
    const state = !user ? 'auth' : !navigator.onLine ? 'offline' : pending ? 'syncing' : 'saved';
    $('#sync').dataset.state = state;
    $('#sync-text').textContent = { auth: 'Вход', offline: 'Нет сети', syncing: 'Сохраняю…', saved: 'Онлайн' }[state];
  }
  window.addEventListener('online', renderHeader);
  window.addEventListener('offline', renderHeader);

  // ---------- Экран ----------
  function render() {
    const app = $('#app');
    closeMenu(false);
    if (!user) { renderLogin(app); return; }
    const working = machines.filter((m) => m.on);
    app.innerHTML = `
      <div class="card">
        <h2>Станки</h2>
        ${working.length
    ? working.map((m) => `<div class="wm"><b class="wm__name">${esc(m.name)}</b>${productPick(m)}
            <button class="btn btn--primary wm__btn" data-mach="${esc(m.name)}" type="button">Сдать продукцию</button></div>`).join('')
    : '<p class="muted">Работающих станков в списке нет — мастер их ещё не отметил.</p>'}
        <button class="wlink wm__other" id="m-add" type="button">Добавить или убрать станок</button>
        <button class="wlink wm__other" data-mach="" type="button">Сдать продукцию не со станка</button>
        <p class="werr" id="f-err">${esc(error)}</p>
      </div>
      <div class="card"><h2>Сдано за смену</h2><div id="list">${listHtml()}</div></div>
      <div class="wbar"><button class="wlink" id="f-out" type="button">Выйти</button></div>`;
  }

  // Вид продукции на станке: выпадающий список — работник выставляет, что сейчас делают на станке (пишется в общие настройки, видно и мастеру)
  function productPick(m) {
    if (!products.length) return `<span class="small muted">${esc(m.product || 'вид продукции не указан')}</span>`;
    return `<div class="wsel"><button class="wsel__btn${m.product ? '' : ' is-empty'}" data-msel="${esc(m.name)}" type="button" aria-haspopup="listbox" aria-expanded="false" aria-label="Вид продукции на станке ${esc(m.name)}"><span class="wsel__t">${esc(m.product || 'продукция')}</span><svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg></button></div>`;
  }

  // Выпадающий список видов продукции в стиле приложения (вместо системного белого): вытекает из кнопки, закрывается по касанию мимо
  let menu = null;
  let menuFor = '';
  const reducedMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
  function closeMenu(animate = true) {
    if (!menu) return;
    const el = menu;
    menu = null;
    menuFor = '';
    document.querySelectorAll('[data-msel][aria-expanded="true"]').forEach((x) => x.setAttribute('aria-expanded', 'false'));
    if (!animate || reducedMotion() || !el.animate) { el.remove(); return; }
    const an = el.animate([{ opacity: 1, transform: 'scale(1)' }, { opacity: 0, transform: 'scale(.94, .9)' }], { duration: 150, easing: 'ease-in' });
    an.onfinish = an.oncancel = () => el.remove();
  }
  function openMenu(btn) {
    const name = btn.dataset.msel;
    if (menu && menuFor === name) { closeMenu(); return; }
    closeMenu(false);
    const m = machines.find((x) => x.name === name);
    if (!m) return;
    const list = !m.product || products.includes(m.product) ? products : [m.product, ...products];
    const el = document.createElement('div');
    el.className = 'wmenu';
    el.setAttribute('role', 'listbox');
    el.innerHTML = `<button class="wmenu__item wmenu__item--none" data-mval="" data-for="${esc(name)}" type="button" role="option">— не указан —</button>${list.map((p) => `<button class="wmenu__item${p === m.product ? ' is-on' : ''}" data-mval="${esc(p)}" data-for="${esc(name)}" type="button" role="option" aria-selected="${p === m.product}">${esc(p)}</button>`).join('')}`;
    el.style.visibility = 'hidden';
    el.style.minWidth = `${Math.max(btn.offsetWidth, 200)}px`;
    document.body.appendChild(el);
    const r = btn.getBoundingClientRect();
    const below = innerHeight - r.bottom - 12;
    const above = r.top - 12;
    const down = below >= Math.min(el.scrollHeight, 240) || below >= above;
    el.style.maxHeight = `${Math.max(120, Math.min(340, down ? below : above))}px`;
    const w = el.offsetWidth;
    const left = Math.max(12, Math.min(r.left, innerWidth - w - 12));
    el.style.left = `${left}px`;
    el.style.top = `${down ? r.bottom + 6 : r.top - 6 - el.offsetHeight}px`;
    el.style.transformOrigin = `${Math.min(w, Math.max(0, r.left - left + r.width / 2))}px ${down ? '0' : '100%'}`;
    el.style.visibility = '';
    el.querySelector('.is-on')?.scrollIntoView({ block: 'nearest' });
    menu = el;
    menuFor = name;
    btn.setAttribute('aria-expanded', 'true');
    if (!reducedMotion() && el.animate) {
      el.animate([
        { opacity: 0, transform: 'scale(.92, .6)' },
        { opacity: 1, transform: 'scale(1, 1)' },
      ], { duration: 260, easing: 'cubic-bezier(.3, .7, .3, 1)' });
    }
  }
  document.addEventListener('pointerdown', (e) => { if (menu && !e.target.closest('.wmenu, [data-msel]')) closeMenu(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeMenu(); });
  window.addEventListener('scroll', () => closeMenu(false), { passive: true });
  window.addEventListener('resize', () => closeMenu(false));

  // Список станков — в общие настройки (правила пускают работников только к этому полю)
  async function saveMachines(next, failText) {
    machines = next; // сразу на экране, в облако — следом
    error = '';
    render();
    try {
      const { fs, db } = fb;
      await fs.setDoc(fs.doc(db, 'settings', 'production'), { machines: next.map(({ name: n, on, product: p }) => ({ name: n, on, product: p })) }, { merge: true });
    } catch (e) { error = `${failText} ${explain(e)}`; render(); }
  }
  const setMachineProduct = (name, product) => saveMachines(machines.map((m) => (m.name === name ? { ...m, product } : m)), 'Вид продукции не сменился.');

  // «Станки»: убрать станок из работы или добавить — выбрать из остановленных либо вписать название станка, которого нет в списке
  const DEFAULT_MACHINES = ['Ф1', 'Ф2', 'Ф3', 'Ф4', 'Ф5', 'Ф6', 'К1', 'К2', 'К3'];
  const MAX_MACHINES = 30; // столько пускают правила Firestore
  function openAddMachine() {
    const idle = machines.filter((m) => !m.on);
    const working = machines.filter((m) => m.on);
    sheetBody().innerHTML = `<div class="sheet__grip" tabindex="-1"></div>
      <h3>Станки</h3>
      ${working.length ? `<div class="field__label">В работе</div>
      <div class="wmrows">${working.map((m) => `<div class="wmrow"><b>${esc(m.name)}</b><button class="btn wmrow__del" data-mdel="${esc(m.name)}" type="button">Убрать</button></div>`).join('')}</div>` : ''}
      <div class="field__label mt-12">Добавить в работу</div>
      ${idle.length ? `<div class="chips">${idle.map((m) => `<button class="chip" data-madd="${esc(m.name)}" type="button">${esc(m.name)}</button>`).join('')}</div>` : '<p class="muted">Все станки из списка уже в работе.</p>'}
      <div class="field mt-12"><span class="field__label">Нет в списке? Впишите название станка</span>
        <div class="row row--nowrap"><input class="input" id="m-new" maxlength="12" autocomplete="off" autocapitalize="characters" placeholder="например, Э1"><button class="btn btn--primary" id="m-new-go" type="button">Добавить</button></div></div>
      <p class="werr" id="m-err"></p>
      <div class="sheet__actions"><button class="btn" value="cancel">Закрыть</button></div>`;
    if (!sheet().open) sheet().showModal();
  }
  // Убрать станок: стандартный (Ф1–Ф6, К1–К3) остаётся в списке остановленным — его можно вернуть; добавленный вручную удаляется совсем
  function removeMachine(name) {
    if (!confirm(`Убрать станок «${name}» из работы?`)) return;
    const next = DEFAULT_MACHINES.includes(name) ? machines.map((m) => (m.name === name ? { ...m, on: false } : m)) : machines.filter((m) => m.name !== name);
    saveMachines(next, 'Станок не убрался.');
    openAddMachine(); // окно остаётся открытым — обновить список
  }
  function addMachine(rawName, isNew) {
    const name = rawName.trim().replace(/s+/g, ' ');
    const fail = (m) => { const el = $('#m-err'); if (el) el.textContent = m; };
    if (!name) return fail('Впишите название станка.');
    const rows = machines.length ? machines : DEFAULT_MACHINES.map((n) => ({ name: n, on: false, product: '' })); // список ещё не заводили — стандартные станки не теряем
    const same = rows.find((m) => m.name.toLowerCase() === name.toLowerCase());
    if (same?.on) return fail(`Станок «${same.name}» уже в работе.`);
    if (!same && rows.length >= MAX_MACHINES) return fail(`Больше ${MAX_MACHINES} станков не поддерживается.`);
    sheet().close();
    saveMachines(same ? rows.map((m) => (m === same ? { ...m, on: true } : m)) : [...rows, { name, on: true, product: '' }], 'Станок не добавился.');
  }

  function listHtml() {
    if (!entries.length) return '<p class="muted">Пока ничего не записано.</p>';
    return `<ul class="wlist">${entries.map((e) => `<li class="rec">
        ${rowText(e)}
        <button class="btn btn--icon" data-del="${esc(e.id)}" type="button" aria-label="Удалить запись">✕</button></li>`).join('')}</ul>
      <div class="sums mt-12">${sumsHtml(entries)}</div>`;
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
    else if (id === 's-qty') { draft.qty = e.target.value; updatePots(); }
    else if (id === 's-other') { draft.other = e.target.value; updatePots(); }
    else if (id === 's-color-other') draft.colorOther = e.target.value;
    else if (id === 's-time') { draft.time = e.target.value; draft.touched = true; }
  });
  document.addEventListener('change', (e) => {
    if (draft && e.target.id === 's-pick') { draft.pick = e.target.value; renderSheet(); $('#s-qty')?.focus(); }
  });
  document.addEventListener('click', async (e) => {
    const t = e.target.closest('button');
    if (!t) return;
    if (t.id === 'm-add') openAddMachine();
    else if (t.dataset.madd !== undefined) addMachine(t.dataset.madd);
    else if (t.dataset.mdel !== undefined) removeMachine(t.dataset.mdel);
    else if (t.id === 'm-new-go') addMachine($('#m-new').value, true);
    else if (t.dataset.msel !== undefined) openMenu(t);
    else if (t.dataset.mval !== undefined) { const nm = t.dataset.for; const v = t.dataset.mval; closeMenu(); if (machines.find((x) => x.name === nm)?.product !== v) setMachineProduct(nm, v); }
    else if (t.id === 's-save') saveSheet();
    else if (t.dataset.unit || t.dataset.holes) setSeg(t);
    else if (t.dataset.color !== undefined) {
      if (draft) {
        draft.color = draft.color === t.dataset.color ? '' : t.dataset.color;
        if (draft.color !== '__other') draft.colorOther = '';
        // Окно не перерисовываем: меняем отметку, двигаем каплю и подменяем поле «Какой цвет»
        document.querySelectorAll('#sheet .wchips .chip').forEach((c) => c.classList.toggle('is-on', c.dataset.color === draft.color));
        placeChips(true);
        const extra = $('#s-color-extra');
        if (extra) extra.innerHTML = colorExtra(draft);
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
    if (!draft && $('#m-new')) { $('#m-new-go').click(); return; }
    saveSheet();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && e.target.matches('#l-name, #l-pass')) $('#l-go')?.click();
  });
  document.addEventListener('close', (e) => { if (e.target.id === 'sheet') draft = null; }, true);

  // ---------- Версия и «Доступно обновление» ----------
  // Номер запущенной версии — внизу страницы. Пока страница открыта, раз в минуту и при возврате в приложение
  // смотрим, не вышла ли на сайте версия новее; если да — окно с кнопкой «Обновить». Работает и без SW: просто сравнивает номера.
  const RUNNING = document.querySelector('meta[name="app-version"]')?.content || '';
  $('#ver').textContent = RUNNING ? `Версия ${RUNNING}` : '';
  let updateShown = false;
  let lastCheck = 0;
  async function checkUpdate() {
    if (!RUNNING || updateShown || Date.now() - lastCheck < 30e3) return;
    lastCheck = Date.now();
    try {
      const res = await fetch(`index.html?check=${Date.now()}`, { cache: 'no-store', headers: { Range: 'bytes=0-1023' } } /* номер версии — в самом начале страницы */);
      const v = ((await res.text()).match(/name="app-version" content="([^"]+)"/) || [])[1];
      if (!v || v === RUNNING) return;
      updateShown = true;
      $('#update-text').textContent = `Вышла новая версия приложения (${v}), у вас ${RUNNING}. Нажмите «Обновить», чтобы продолжить работу с новой версией.`;
      if (!$('#update').open) $('#update').showModal();
    } catch { /* нет сети — проверим позже */ }
  }
  $('#update-now').addEventListener('click', async () => {
    try { for (const r of await navigator.serviceWorker.getRegistrations()) await r.update(); } catch { /* обновим и так */ }
    location.reload();
  });
  const updateLater = () => { $('#update').close(); setTimeout(() => { updateShown = false; checkUpdate(); }, 15 * 60e3); };
  if (window.laterJoke) window.laterJoke($('#update-later'), updateLater); // шутка на кнопке «Позже» (js/sheet-drag.js)
  else $('#update-later').addEventListener('click', updateLater);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) checkUpdate(); });
  setInterval(checkUpdate, 60e3);
  setTimeout(checkUpdate, 5000);

  // ---------- Запуск ----------
  // Смена сменилась (7:30 или 19:30) — переключить список
  setInterval(() => {
    const s = shiftOf();
    if (s.id !== shift.id) { shift = s; entries = []; subscribe(); render(); }
    renderHeader(); // раз в полминуты — «сколько осталось»
  }, 30000);

  // Новое устройство мастера: приложение «Табель смены» чужим устройствам закрыто (index.html отправляет сюда).
  // Пять нажатий подряд на номер версии внизу — вход для мастера (адрес с ?owner).
  { let taps = 0; let t0 = 0; $('#ver').addEventListener('click', () => { const n = Date.now(); taps = n - t0 < 2000 ? taps + 1 : 1; t0 = n; if (taps >= 5) location.href = '../?owner'; }); }

  load().then(() => {
    fb.auth.onAuthStateChanged(fb.au, (u) => {
      user = u;
      error = '';
      shift = shiftOf();
      subscribe();
      renderHeader();
      render();
    });
  }).catch((e) => { error = explain(e); render(); });
  renderHeader();
  render();

  if ('serviceWorker' in navigator && location.protocol.startsWith('http')) navigator.serviceWorker.register('sw.js').catch(() => {});
})();
