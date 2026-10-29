// ================= Страница работников смены: сданная продукция =================
// Отдельная от табеля страница (/work/): вход по логину и паролю (общий на смену), одна форма —
// «сколько коробок, какой продукции, во сколько отвезли» — и список записей текущей смены.
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
  let unsubs = [];
  const creds = { name: '', pass: '' }; // логин и пароль переживают перерисовку (после ошибки не стираются)
  const form = { qty: '', product: '', other: '', color: '', colorOther: '', time: '', timeTouched: false };
  let error = '';
  let busy = false;      // идёт запись
  let loggingIn = false; // идёт вход

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
      render();
    }, () => { /* списка нет — вводят текстом */ }));
  }

  // ---------- Действия ----------
  async function login(name, pass) {
    const email = name.includes('@') ? name.trim() : `${name.trim().toLowerCase()}@${DOMAIN}`;
    await load();
    await fb.auth.signInWithEmailAndPassword(fb.au, email, pass);
  }

  async function addEntry() {
    const qty = Number(String(form.qty).replace(',', '.'));
    const product = (products.length && form.product !== '__other' ? form.product : form.other).trim();
    if (!(qty > 0)) { error = 'Укажите, сколько коробок.'; return render(); }
    if (!product) { error = 'Укажите вид продукции.'; return render(); }
    const color = (colors.length && form.color !== '__other' ? form.color : form.colorOther).trim();
    const time = form.time || hhmm(new Date());
    const at = atOf(time, shift);
    if (at < shift.start - 30 * 60e3 || at > shift.end.getTime() + 60 * 60e3) { error = 'Время отвоза не входит в эту смену.'; return render(); }
    error = '';
    busy = true;
    render();
    try {
      const { fs, db } = fb;
      await fs.addDoc(fs.collection(db, 'shipments'), {
        shift: shift.id, qty, product, ...(color ? { color } : {}), at: at.toISOString(), by: (user.email || '').split('@')[0], createdAt: fs.serverTimestamp(),
      });
      Object.assign(form, { qty: '', colorOther: '', timeTouched: false, time: '' });
    } catch (e) { error = explain(e); }
    busy = false;
    render();
  }

  async function removeEntry(id) {
    if (!confirm('Удалить эту запись?')) return;
    try { await fb.fs.deleteDoc(fb.fs.doc(fb.db, 'shipments', id)); } catch (e) { error = explain(e); render(); }
  }

  // ---------- Экран ----------
  function render() {
    const app = $('#app');
    $('#shift').textContent = user ? shiftTitle(shift) : '';
    if (!user) { renderLogin(app); return; }
    // Не перерисовывать форму под пальцем: если поле в фокусе — обновить только список
    const focused = app.contains(document.activeElement) && document.activeElement.matches?.('input, select');
    if (focused && $('#list')) { $('#list').innerHTML = listHtml(); return; }

    const time = form.timeTouched ? form.time : hhmm(new Date());
    const sel = products.length
      ? `<label class="field"><span class="field__label">Вид продукции</span>
          <select class="input" id="f-product">
            <option value="">— выберите —</option>
            ${products.map((p) => `<option value="${esc(p)}"${form.product === p ? ' selected' : ''}>${esc(p)}</option>`).join('')}
            <option value="__other"${form.product === '__other' ? ' selected' : ''}>Другое…</option>
          </select></label>
         ${form.product === '__other' ? `<label class="field"><span class="field__label">Какая продукция</span><input class="input" id="f-other" value="${esc(form.other)}" autocomplete="off"></label>` : ''}`
      : `<label class="field"><span class="field__label">Вид продукции</span><input class="input" id="f-other" value="${esc(form.other)}" autocomplete="off" placeholder="например, грунт 5 л"></label>`;
    const colorField = colors.length
      ? `<label class="field"><span class="field__label">Цвет</span>
          <select class="input" id="f-color">
            <option value="">— без цвета —</option>
            ${colors.map((c) => `<option value="${esc(c)}"${form.color === c ? ' selected' : ''}>${esc(c)}</option>`).join('')}
            <option value="__other"${form.color === '__other' ? ' selected' : ''}>Другой…</option>
          </select></label>
         ${form.color === '__other' ? `<label class="field"><span class="field__label">Какой цвет</span><input class="input" id="f-color-other" value="${esc(form.colorOther)}" autocomplete="off"></label>` : ''}`
      : `<label class="field"><span class="field__label">Цвет</span><input class="input" id="f-color-other" value="${esc(form.colorOther)}" autocomplete="off" placeholder="если есть"></label>`;
    app.innerHTML = `
      <div class="card">
        <h2>Записать отвоз</h2>
        <label class="field"><span class="field__label">Количество, коробок</span>
          <input class="input" id="f-qty" type="text" inputmode="decimal" value="${esc(form.qty)}" autocomplete="off" placeholder="0"></label>
        ${sel}
        ${colorField}
        <label class="field"><span class="field__label">Время отвоза</span>
          <input class="input input--short" id="f-time" type="time" value="${esc(time)}"></label>
        <button class="btn btn--primary btn--block mt-12" id="f-add" type="button" ${busy ? 'disabled' : ''}>${busy ? 'Записываю…' : 'Записать'}</button>
        <p class="werr" id="f-err">${esc(error)}</p>
      </div>
      <div class="card"><h2>Сдано за смену</h2><div id="list">${listHtml()}</div></div>
      <div class="wbar"><button class="wlink" id="f-out" type="button">Выйти</button></div>`;
  }

  function listHtml() {
    if (!entries.length) return '<p class="muted">Пока ничего не записано.</p>';
    const sums = new Map();
    const nameOf = (e) => (e.color ? `${e.product}, ${e.color}` : e.product);
    for (const e of entries) sums.set(nameOf(e), (sums.get(nameOf(e)) || 0) + e.qty);
    const total = entries.reduce((s, e) => s + e.qty, 0);
    return `<ul class="wlist">${entries.map((e) => `<li>
        <span class="wlist__qty">${num(e.qty)}</span>
        <span class="wlist__main">${esc(nameOf(e))}<br><span class="small muted">отвезли в ${hhmm(new Date(e.at))}</span></span>
        <button class="btn btn--icon" data-del="${esc(e.id)}" type="button" aria-label="Удалить запись">✕</button></li>`).join('')}</ul>
      <div class="mt-12">${[...sums].map(([p, q]) => `<div class="wsum"><span>${esc(p)}</span><b>${num(q)}</b></div>`).join('')}
        <div class="wsum"><span><b>Всего</b></span><b>${num(total)}</b></div></div>`;
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
    else if (id === 'f-qty') form.qty = e.target.value;
    else if (id === 'f-other') form.other = e.target.value;
    else if (id === 'f-color-other') form.colorOther = e.target.value;
    else if (id === 'f-time') { form.time = e.target.value; form.timeTouched = true; }
  });
  document.addEventListener('change', (e) => {
    if (e.target.id === 'f-product') { form.product = e.target.value; render(); }
    else if (e.target.id === 'f-color') { form.color = e.target.value; render(); }
  });
  document.addEventListener('click', async (e) => {
    const t = e.target.closest('button');
    if (!t) return;
    if (t.id === 'f-add') addEntry();
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
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && e.target.matches('#l-name, #l-pass')) $('#l-go')?.click();
  });

  // ---------- Запуск ----------
  // Смена сменилась (7:30 или 19:30) — переключить список; время по умолчанию тоже обновляется
  setInterval(() => {
    const s = shiftOf();
    if (s.id !== shift.id) { shift = s; entries = []; subscribe(); render(); }
    else if (user && !form.timeTouched && !document.activeElement?.matches?.('input, select')) render();
  }, 30000);

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
