// ================= Сданная продукция (вид владельца) =================
// Работники вносят отвоз на странице /work/ (work/work.js) — записи лежат в Firestore, коллекция shipments.
// Здесь владелец видит записи текущей смены с итогами и правит список видов продукции для выпадающего списка
// (документ settings/production). Работает только после входа владельца: правила пускают в shipments
// владельца и общий логин работников, больше никого.

const Production = (() => {
  const pad = (n) => String(n).padStart(2, '0');
  const isoDate = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const hhmm = (d) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  // Когда запись добавлена: createdAt = null — ещё не дошла до сервера (самая свежая); у старых записей поля нет — берём время отвоза
  const addedAt = (e) => (e.createdAt?.toMillis ? e.createdAt.toMillis() : 'createdAt' in e ? Infinity : Date.parse(e.at));
  // Строка списка: станок — время — вид продукции — количество — цвет
  const rowText = (e) => `<b>${e.machine ? esc(e.machine) : '—'}</b><span class="prod__sep">·</span>${hhmm(new Date(e.at))}<span class="prod__sep">·</span>${esc([e.product, e.noHoles ? 'без отверстий' : ''].filter(Boolean).join(', '))}<span class="prod__sep">·</span><b>${num(e.qty)} ${unitOf(e)}</b>${e.color ? `<span class="prod__sep">·</span>${esc(e.color)}` : ''}`;
  const num = (n) => String(n).replace('.', ',');

  // Смена по времени, как на странице работников: дневная 7:30–19:30, ночная 19:30–7:30 (до 7:30 — вчерашняя ночная)
  function shiftOf(now = new Date()) {
    const mins = now.getHours() * 60 + now.getMinutes();
    const night = mins >= 19 * 60 + 30 || mins < 7 * 60 + 30;
    const day = new Date(now); day.setHours(0, 0, 0, 0);
    if (mins < 7 * 60 + 30) day.setDate(day.getDate() - 1);
    return { id: `${isoDate(day)}${night ? 'Н' : 'Д'}`, night, day };
  }

  const unitOf = (e) => (e.unit === 'штук' ? 'штук' : 'коробок'); // записи без единицы — коробки
  const totalText = (list) => ['коробок', 'штук'].map((u) => [u, list.filter((e) => unitOf(e) === u).reduce((s, e) => s + e.qty, 0)]).filter(([, q]) => q).map(([u, q]) => `${num(q)} ${u}`).join(', ') || '0';
  let shiftId = '';
  let entries = [];
  let products = [];
  let colors = [];
  const DEFAULT_MACHINES = ['Ф1', 'Ф2', 'Ф3', 'Ф4', 'Ф5', 'Ф6', 'К1', 'К2', 'К3'];
  let machines = []; // { name, on, product } — владелец отмечает, какие станки работают и что на них выпускают
  let docSchedule = null; // график смен, как он записан в облаке (его читает страница работников)
  let unsubs = [];
  let active = false;

  function stop() {
    unsubs.forEach((u) => u());
    unsubs = [];
    active = false;
    entries = [];
  }

  // График бригады (дата отсчёта и цикл) — в общий документ настроек: страница работников по нему понимает, когда у нас смена,
  // и пишет в шапке «До начала» / «Осталось», а не по одному времени суток. Не секрет: сами люди и табель туда не попадают.
  function syncSchedule() {
    const api = Cloud.api();
    const { anchor, cycle } = DB.data.settings;
    if (!api || !anchor || !cycle || (docSchedule?.anchor === anchor && docSchedule?.cycle === cycle)) return;
    docSchedule = { anchor, cycle }; // не повторять запись, пока не придёт ответ
    api.fs.setDoc(api.fs.doc(api.db, 'settings', 'production'), { schedule: { anchor, cycle } }, { merge: true }).catch(() => { docSchedule = null; });
  }

  const refresh = () => { if (UI.view === 'shift' || UI.view === 'more') render(); };

  // Подписаться на записи текущей смены (при входе владельца и при смене смены)
  function ensure() {
    const c = Cloud.info();
    const api = c.connected && c.isOwner ? Cloud.api() : null;
    if (!api) { if (active) stop(); return false; }
    const id = shiftOf().id;
    if (active && id === shiftId) return true;
    stop();
    shiftId = id;
    active = true;
    const { fs, db } = api;
    unsubs.push(fs.onSnapshot(fs.query(fs.collection(db, 'shipments'), fs.where('shift', '==', id)), (snap) => {
      entries = snap.docs.map((d) => ({ id: d.id, ...d.data() })).sort((a, b) => addedAt(b) - addedAt(a)); // сверху — последняя добавленная
      refresh();
    }, () => {}));
    unsubs.push(fs.onSnapshot(fs.doc(db, 'settings', 'production'), (snap) => {
      const d = snap.exists() ? snap.data() : {};
      products = Array.isArray(d.products) ? d.products.map(String) : [];
      colors = Array.isArray(d.colors) ? d.colors.map(String) : [];
      docSchedule = d.schedule || null;
      syncSchedule();
      machines = Array.isArray(d.machines) ? d.machines.filter((m) => m && m.name).map((m) => ({ name: String(m.name), on: !!m.on, product: String(m.product || '') })) : [];
      refresh();
    }, () => {}));
    return true;
  }

  async function saveLists(list, colorList) {
    const api = Cloud.api();
    if (!api) throw new Error('Войдите в облако');
    // merge: в этом же документе лежит список станков — списки его не трогают
    await api.fs.setDoc(api.fs.doc(api.db, 'settings', 'production'), { products: list, colors: colorList }, { merge: true });
  }

  // ---------- Станки: работает / не работает и что выпускает ----------
  // Работники видят на своей странице только работающие станки, с кнопкой «Сдать продукцию»; вид продукции берётся от станка.
  const machineRows = () => (machines.length ? machines : DEFAULT_MACHINES.map((name) => ({ name, on: false, product: '' })));
  let machineTimer = null;
  function setMachine(name, patch) {
    const rows = machineRows().map((m) => (m.name === name ? { ...m, ...patch } : m));
    machines = rows; // сразу на экране; в облако — через полсекунды (несколько правок подряд — одной записью)
    clearTimeout(machineTimer);
    machineTimer = setTimeout(() => {
      const api = Cloud.api();
      if (api) api.fs.setDoc(api.fs.doc(api.db, 'settings', 'production'), { machines: rows }, { merge: true }).catch(() => toast('Станки не сохранились — проверьте связь'));
    }, 500);
  }

  function machinesHtml() {
    const opts = (cur) => {
      const list = products.includes(cur) || !cur ? products : [cur, ...products];
      return `<option value="">— вид продукции —</option>${list.map((p) => `<option value="${esc(p)}"${p === cur ? ' selected' : ''}>${esc(p)}</option>`).join('')}`;
    };
    return `<div class="card mach"><h2>Станки</h2>
      <p class="small muted">Отметьте, какие станки работают и что на них выпускают: работники увидят только их, с кнопкой «Сдать продукцию».</p>
      ${machineRows().map((m) => `<div class="mach__row${m.on ? ' is-on' : ''}">
        <b class="mach__name">${esc(m.name)}</b>
        <label class="mach__sw"><input type="checkbox" class="mach__on" data-m="${esc(m.name)}"${m.on ? ' checked' : ''}><span>${m.on ? 'работает' : 'стоит'}</span></label>
        <select class="input mach__prod" data-m="${esc(m.name)}" aria-label="Вид продукции на станке ${esc(m.name)}">${opts(m.product)}</select></div>`).join('')}
    </div>`;
  }

  document.addEventListener('change', (e) => {
    const m = e.target.dataset?.m;
    if (!m || !e.target.closest('#view-shift')) return;
    if (e.target.classList.contains('mach__on')) setMachine(m, { on: e.target.checked });
    else if (e.target.classList.contains('mach__prod')) setMachine(m, { product: e.target.value });
    refresh();
  });

  async function remove(id) {
    const api = Cloud.api();
    if (api) await api.fs.deleteDoc(api.fs.doc(api.db, 'shipments', id));
  }

  // Карточка на «Смене»: что сдали за текущую смену
  function cardHtml() {
    if (!ensure()) return '';
    const s = shiftOf();
    const sums = new Map();
    const nameOf = (e) => [e.product, e.color, e.noHoles ? 'без отверстий' : ''].filter(Boolean).join(', ');
    for (const e of entries) { const k = `${nameOf(e)}|${unitOf(e)}`; sums.set(k, (sums.get(k) || 0) + e.qty); }
    const head = `${s.night ? 'Ночная' : 'Дневная'} смена · ${pad(s.day.getDate())}.${pad(s.day.getMonth() + 1)}`;
    const body = !entries.length
      ? '<p class="small muted">Пока ничего не записано.</p>'
      : `<div class="prod__sums">${[...sums].map(([k, q]) => { const [p, u] = k.split('|'); return `<div class="prod__sum"><span>${esc(p)}</span><b>${num(q)} ${u}</b></div>`; }).join('')}
          <div class="prod__sum prod__sum--total"><span>Всего</span><b>${totalText(entries)}</b></div></div>
        <details class="prod__more"><summary>Записи (${entries.length})</summary>
          <ul class="prod__list">${entries.map((e) => `<li><span class="grow">${rowText(e)}</span><button class="btn btn--icon" data-prod-del="${esc(e.id)}" type="button" aria-label="Удалить запись">${ICON.x}</button></li>`).join('')}</ul></details>`;
    return `${machinesHtml()}<div class="card prod"><h2>Сдано за смену</h2><p class="small muted">${esc(head)} · вносят на странице для работников</p>${body}
      <a class="btn btn--block mt-12" href="work/">Страница продукции →</a></div>`;
  }

  // Карточка в «Настройках»: список видов продукции
  function settingsHtml() {
    if (!ensure()) return '<p class="small muted">Список видов продукции для работников правится после входа в облако под аккаунтом владельца.</p>';
    return `<p class="small muted">Работники выбирают из этих списков (есть и «Другое…» со свободным текстом). По одному названию в строке. Итоги считаются по точному названию.</p>
      <label class="field"><span class="field__label">Виды продукции</span><textarea class="input" id="prod-list" rows="6" placeholder="например:&#10;Грунт 5 л&#10;Торф 20 л">${esc(products.join('\n'))}</textarea></label>
      <label class="field"><span class="field__label">Цвета</span><textarea class="input" id="prod-colors" rows="4" placeholder="например:&#10;чёрный&#10;белый">${esc(colors.join('\n'))}</textarea></label>
      <button class="btn btn--primary btn--block" data-act="prod-save" type="button">Сохранить списки</button>`;
  }

  Cloud.onChange(() => { if (ensure()) syncSchedule(); });
  DB.onChange(() => { if (active) syncSchedule(); }); // поменяли график в «Настройках» — страница работников узнает
  document.addEventListener('visibilitychange', () => { if (!document.hidden && active) ensure(); });

  return { cardHtml, settingsHtml, saveLists, remove, shiftOf };
})();
