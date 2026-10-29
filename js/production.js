// ================= Сданная продукция (вид владельца) =================
// Работники вносят отвоз на странице /work/ (work/work.js) — записи лежат в Firestore, коллекция shipments.
// Здесь владелец видит записи текущей смены с итогами и правит список видов продукции для выпадающего списка
// (документ settings/production). Работает только после входа владельца: правила пускают в shipments
// владельца и общий логин работников, больше никого.

const Production = (() => {
  const pad = (n) => String(n).padStart(2, '0');
  const isoDate = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const hhmm = (d) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;
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
  let unsubs = [];
  let active = false;

  function stop() {
    unsubs.forEach((u) => u());
    unsubs = [];
    active = false;
    entries = [];
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
      entries = snap.docs.map((d) => ({ id: d.id, ...d.data() })).sort((a, b) => a.at.localeCompare(b.at));
      refresh();
    }, () => {}));
    unsubs.push(fs.onSnapshot(fs.doc(db, 'settings', 'production'), (snap) => {
      const d = snap.exists() ? snap.data() : {};
      products = Array.isArray(d.products) ? d.products.map(String) : [];
      colors = Array.isArray(d.colors) ? d.colors.map(String) : [];
      refresh();
    }, () => {}));
    return true;
  }

  async function saveLists(list, colorList) {
    const api = Cloud.api();
    if (!api) throw new Error('Войдите в облако');
    await api.fs.setDoc(api.fs.doc(api.db, 'settings', 'production'), { products: list, colors: colorList });
  }

  async function remove(id) {
    const api = Cloud.api();
    if (api) await api.fs.deleteDoc(api.fs.doc(api.db, 'shipments', id));
  }

  // Карточка на «Смене»: что сдали за текущую смену
  function cardHtml() {
    if (!ensure()) return '';
    const s = shiftOf();
    const sums = new Map();
    const nameOf = (e) => (e.color ? `${e.product}, ${e.color}` : e.product);
    for (const e of entries) { const k = `${nameOf(e)}|${unitOf(e)}`; sums.set(k, (sums.get(k) || 0) + e.qty); }
    const head = `${s.night ? 'Ночная' : 'Дневная'} смена · ${pad(s.day.getDate())}.${pad(s.day.getMonth() + 1)}`;
    const body = !entries.length
      ? '<p class="small muted">Пока ничего не записано.</p>'
      : `<div class="prod__sums">${[...sums].map(([k, q]) => { const [p, u] = k.split('|'); return `<div class="prod__sum"><span>${esc(p)}</span><b>${num(q)} ${u}</b></div>`; }).join('')}
          <div class="prod__sum prod__sum--total"><span>Всего</span><b>${totalText(entries)}</b></div></div>
        <details class="prod__more"><summary>Записи (${entries.length})</summary>
          <ul class="prod__list">${entries.map((e) => `<li><span class="prod__time">${hhmm(new Date(e.at))}</span><span class="grow">${esc(nameOf(e))}</span><b>${num(e.qty)} ${unitOf(e)}</b><button class="btn btn--icon" data-prod-del="${esc(e.id)}" type="button" aria-label="Удалить запись">${ICON.x}</button></li>`).join('')}</ul></details>`;
    return `<div class="card prod"><h2>Сдано за смену</h2><p class="small muted">${esc(head)} · вносят на странице для работников</p>${body}</div>`;
  }

  // Карточка в «Настройках»: список видов продукции
  function settingsHtml() {
    if (!ensure()) return '<p class="small muted">Список видов продукции для работников правится после входа в облако под аккаунтом владельца.</p>';
    return `<p class="small muted">Работники выбирают из этих списков (есть и «Другое…» со свободным текстом). По одному названию в строке. Итоги считаются по точному названию.</p>
      <label class="field"><span class="field__label">Виды продукции</span><textarea class="input" id="prod-list" rows="6" placeholder="например:&#10;Грунт 5 л&#10;Торф 20 л">${esc(products.join('\n'))}</textarea></label>
      <label class="field"><span class="field__label">Цвета</span><textarea class="input" id="prod-colors" rows="4" placeholder="например:&#10;чёрный&#10;белый">${esc(colors.join('\n'))}</textarea></label>
      <button class="btn btn--primary btn--block" data-act="prod-save" type="button">Сохранить списки</button>`;
  }

  Cloud.onChange(() => { ensure(); });
  document.addEventListener('visibilitychange', () => { if (!document.hidden && active) ensure(); });

  return { cardHtml, settingsHtml, saveLists, remove, shiftOf };
})();
