// ================= Файл данных =================
// Все данные — один JSON-документ: локальная копия в браузере + копия в Firebase (cloud.js).
// В табель попадают не все дни, а только отклонения от графика (marks): кто не вышел,
// вышел не на полную смену или сверх графика. Остальные клетки считаются по графику.

const DATA_FORMAT = 'tabel-smeny';
const DATA_VERSION = 1;

function emptyData() {
  return {
    format: DATA_FORMAT,
    version: DATA_VERSION,
    updatedAt: null,
    settings: { ...CONFIG.defaults },
    people: [],     // { id, name, position, archived } — порядок массива = порядок в табеле
    marks: [],      // { id: 'YYYY-MM-DD|personId', date, pid, v, reason } — v: число часов или код ('Б', 'ОТ', '-', '')
    notes: [],      // свободные примечания к месяцу: { id, month: 'YYYY-MM', text }
    stickers: [],   // кто на стикеровке: { id: 'YYYY-MM-DD|personId', date, pid, h? } — h часов на стикеровке (нет — вся смена); на табель не влияет
    reports: [],    // снимки 16-го и 1-го: { id: 'YYYY-MM-16' | 'YYYY-MM-final', savedAt, sentAt, dismissed }
  };
}

const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

function normalizeData(raw) {
  if (!raw || typeof raw !== 'object' || raw.format !== DATA_FORMAT) {
    throw new Error('Это не файл данных «Табеля смены».');
  }
  if (raw.version > DATA_VERSION) {
    throw new Error('Файл создан более новой версией приложения. Обновите страницу.');
  }
  const base = emptyData();
  const data = { ...base, ...raw, format: DATA_FORMAT, version: DATA_VERSION };
  for (const key of Object.keys(base)) {
    if (Array.isArray(base[key]) && !Array.isArray(data[key])) data[key] = [];
  }
  data.settings = { ...base.settings, ...(raw.settings || {}) };
  return data;
}

// ---------- Адаптер: локальная копия в браузере ----------
const LocalBackend = {
  KEY: 'ts.data',
  load() {
    try {
      const raw = localStorage.getItem(this.KEY);
      return raw ? JSON.parse(raw) : null;
    } catch { return null; }
  },
  save(data) {
    try { localStorage.setItem(this.KEY, JSON.stringify(data)); return true; } catch { return false; }
  },
};

// ---------- Хранилище ----------
const DB = (() => {
  const backend = LocalBackend;
  const listeners = [];
  let data;

  try { data = normalizeData(backend.load()); }
  catch { data = emptyData(); }

  const emit = () => listeners.forEach((fn) => fn(data));
  let saveFailed = false;
  let remote = null;

  function persist(replaceAll = false) {
    saveFailed = !backend.save(data);
    if (saveFailed) alert('Не удалось сохранить данные: память браузера переполнена или недоступна.');
    remote?.localChange({ replaceAll });
  }

  window.addEventListener('storage', (e) => {
    if (e.key !== backend.KEY) return;
    try { data = normalizeData(JSON.parse(e.newValue)); emit(); } catch {}
  });

  return {
    get data() { return data; },

    get saveState() {
      if (saveFailed) return { state: 'error', at: data.updatedAt, pending: 0 };
      const cloud = remote?.state();
      return { at: data.updatedAt, pending: 0, ...(cloud || { state: 'saved' }) };
    },

    attachSync(adapter) { remote = adapter; },

    applyRemote(doc) {
      data = normalizeData(doc);
      saveFailed = !backend.save(data);
      emit();
    },

    update(fn) {
      fn(data);
      data.updatedAt = new Date().toISOString();
      persist();
      emit();
    },

    replace(newData) {
      data = normalizeData(newData);
      persist(true);
      emit();
    },

    onChange(fn) { listeners.push(fn); },

    exportFile() {
      const d = new Date();
      const p = (n) => String(n).padStart(2, '0');
      const name = `tabel-smeny_${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}.json`;
      downloadBlob(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }), name);
    },

    async readFile(file) {
      let raw;
      try { raw = JSON.parse(await file.text()); }
      catch { throw new Error('Файл повреждён или это не JSON.'); }
      return normalizeData(raw);
    },
  };
})();

function downloadBlob(blob, name) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

// ================= Даты и график =================
// Даты — строки 'YYYY-MM-DD'; считаем в UTC, чтобы переход на летнее время не сдвигал дни.
const Dates = {
  MONTHS: ['Январь', 'Февраль', 'Март', 'Апрель', 'Май', 'Июнь', 'Июль', 'Август', 'Сентябрь', 'Октябрь', 'Ноябрь', 'Декабрь'],
  MONTHS_GEN: ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'],
  WD: ['Вс', 'Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб'],
  WD_FULL: ['воскресенье', 'понедельник', 'вторник', 'среда', 'четверг', 'пятница', 'суббота'],

  num(iso) { const [y, m, d] = iso.split('-').map(Number); return Date.UTC(y, m - 1, d) / 864e5; },
  iso(n) { return new Date(n * 864e5).toISOString().slice(0, 10); },
  add(iso, days) { return this.iso(this.num(iso) + days); },
  today(d = new Date()) {
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  },
  wd(iso) { return new Date(this.num(iso) * 864e5).getUTCDay(); },
  daysIn(y, m) { return new Date(Date.UTC(y, m, 0)).getUTCDate(); }, // m — 1..12
  ym(iso) { return iso.slice(0, 7); },
  dm(iso) { return `${iso.slice(8, 10)}.${iso.slice(5, 7)}`; },
  monthTitle(ym) { const [y, m] = ym.split('-').map(Number); return `${this.MONTHS[m - 1]} ${y}`; },
  addMonths(ym, k) {
    const [y, m] = ym.split('-').map(Number);
    const t = y * 12 + (m - 1) + k;
    return `${Math.floor(t / 12)}-${String((t % 12) + 1).padStart(2, '0')}`;
  },
  monthDays(ym) {
    const [y, m] = ym.split('-').map(Number);
    return Array.from({ length: this.daysIn(y, m) }, (_, i) => `${ym}-${String(i + 1).padStart(2, '0')}`);
  },
};

const Sched = {
  // 'Д' | 'Н' | 'В'
  type(iso, s = DB.data.settings) {
    const n = s.cycle.length;
    const k = (((Dates.num(iso) - Dates.num(s.anchor)) % n) + n) % n;
    return s.cycle[k];
  },
  hoursOf(type, s = DB.data.settings) {
    return type === 'Д' ? s.dayHours : type === 'Н' ? s.nightHours : 0;
  },
  hours(iso, s = DB.data.settings) { return this.hoursOf(this.type(iso, s), s); },

  // Время смены в минутах от полуночи из настроек: dayTime '7:30–19:30' → [450, 1170].
  // Ночная смена числа d идёт с 19:30 d до 7:30 следующего дня.
  times(type, s = DB.data.settings) {
    const [a, b] = [...String((type === 'Д' ? s.dayTime : s.nightTime) || '').matchAll(/(\d{1,2})[:.](\d{2})/g)].map((m) => +m[1] * 60 + +m[2]);
    return type === 'Д' ? [a ?? 450, b ?? 1170] : [a ?? 1170, b ?? 450];
  },
  nowMin(now = new Date()) { return now.getHours() * 60 + now.getMinutes(); },

  // Смена этого числа уже началась (прошлые дни — да, будущие — нет, сегодня — по времени начала).
  started(iso, now = new Date()) {
    const today = Dates.today(now);
    if (iso !== today) return iso < today;
    const t = this.type(iso);
    return t !== 'В' && this.nowMin(now) >= this.times(t)[0];
  },

  // Число текущей смены: ночью до 7:30 после ночной это ещё вчерашняя ночная смена.
  current(now = new Date()) {
    const today = Dates.today(now);
    const y = Dates.add(today, -1);
    return this.type(y) === 'Н' && this.nowMin(now) < this.times('Н')[1] ? y : today;
  },
};

// ================= Табель =================
const Tabel = {
  markId: (date, pid) => `${date}|${pid}`,

  marksMap() { return new Map(DB.data.marks.map((m) => [m.id, m])); },

  // Клетка без отметки: часы по графику, но только за начавшиеся смены (дневная — с 7:30, ночная — с 19:30);
  // будущие пустые (отметки на будущее, например больничный «по 20-е», показываются сразу).
  def(date) {
    return Sched.started(date) ? Sched.hours(date) || '' : '';
  },

  // Режим «по факту» (отправка табеля): только начавшиеся смены — запланированное на будущее (отпуск,
  // больничный «по 20-е», заявления) в картинку, Excel и примечания не попадает. Включается через asFact().
  factOnly: false,
  asFact(fn) {
    const prev = this.factOnly;
    this.factOnly = true;
    let r;
    try { r = fn(); } catch (e) { this.factOnly = prev; throw e; }
    if (r && typeof r.then === 'function') return r.finally(() => { this.factOnly = prev; });
    this.factOnly = prev;
    return r;
  },

  // Значение клетки: число часов, код или '' (пусто).
  cell(pid, date, map = this.marksMap()) {
    if (this.factOnly && !Sched.started(date)) return '';
    const m = map.get(this.markId(date, pid));
    return m ? m.v : this.def(date);
  },

  setMark(date, pid, v, reason = '') {
    const id = this.markId(date, pid);
    const list = DB.data.marks.filter((m) => m.id !== id);
    const def = this.def(date);
    // Совпадает с графиком и без причины — отметка не нужна.
    if (!(v === def && !reason)) list.push({ id, date, pid, v, ...(reason ? { reason } : {}) });
    DB.data.marks = list;
  },

  // Стикеровка — отдельная отметка «где работал»: на часы и отправляемый табель не влияет.
  stickerSet() { return new Set(DB.data.stickers.map((s) => s.id)); },
  isSticker(date, pid, set = this.stickerSet()) { return set.has(this.markId(date, pid)); },
  // h — сколько часов смены на стикеровке (без h — вся смена); остальные часы — на станках.
  setSticker(date, pid, on, h) {
    const id = this.markId(date, pid);
    DB.data.stickers = DB.data.stickers.filter((s) => s.id !== id);
    if (on) DB.data.stickers.push({ id, date, pid, ...(h > 0 ? { h } : {}) });
  },
  stickerMap() { return new Map(DB.data.stickers.map((s) => [s.id, s])); },
  // Часы смены по местам: { on, v, worked, st — на стикеровке, mach — на станках }. Часы — из табеля (отметки и график).
  split(pid, date, map = this.marksMap(), stickers = this.stickerMap()) {
    const v = this.cell(pid, date, map);
    const worked = typeof v === 'number' ? v : 0;
    const s = this.factOnly && !Sched.started(date) ? null : stickers.get(this.markId(date, pid));
    const st = s ? Math.min(s.h ?? worked, worked) : 0;
    return { on: !!s, v, worked, st, mach: worked - st };
  },
  // Итого за месяц: { st, mach }
  splitTotal(pid, ym, map = this.marksMap(), stickers = this.stickerMap()) {
    return Dates.monthDays(ym).reduce((t, d) => {
      const x = this.split(pid, d, map, stickers);
      return { st: t.st + x.st, mach: t.mach + x.mach };
    }, { st: 0, mach: 0 });
  },
  stickerCount(pid, ym, set = this.stickerSet()) {
    return Dates.monthDays(ym).filter((d) => set.has(this.markId(d, pid))).length;
  },

  // Люди месяца: действующие + архивные, у кого есть отметки в этом месяце.
  peopleOf(ym) {
    const withMarks = new Set(DB.data.marks.filter((m) => m.date.startsWith(ym)).map((m) => m.pid));
    return DB.data.people.filter((p) => !p.archived || withMarks.has(p.id));
  },

  total(pid, ym, map = this.marksMap()) {
    return Dates.monthDays(ym).reduce((s, d) => {
      const v = this.cell(pid, d, map);
      return s + (typeof v === 'number' ? v : 0);
    }, 0);
  },

  surname: (p) => (p?.name || '').trim().split(/\s+/)[0] || '',
  shortName(p) {
    const [f, i, o] = (p?.name || '').trim().split(/\s+/);
    return [f, i ? `${i[0]}.` : '', o ? `${o[0]}.` : ''].join(' ').replace(/\s+/g, ' ').trim();
  },
  label: (p) => (p.position ? `${p.name} (${p.position})` : p.name),

  // Примечания под табелем: «04.09 Иванова заявление за свой счёт»;
  // одинаковые причины за один день — в одну строку: «18.09 Петрова и Сидорова заявление».
  notesOf(ym) {
    const people = new Map(DB.data.people.map((p) => [p.id, p]));
    const groups = new Map();
    for (const m of DB.data.marks) {
      if (!m.reason || !m.date.startsWith(ym) || !people.has(m.pid)) continue;
      if (this.factOnly && !Sched.started(m.date)) continue; // будущее — не в отправку
      const k = `${m.date}|${m.reason}`;
      if (!groups.has(k)) groups.set(k, { date: m.date, reason: m.reason, pids: [] });
      groups.get(k).pids.push(m.pid);
    }
    const order = new Map(DB.data.people.map((p, i) => [p.id, i]));
    const auto = [...groups.values()]
      .sort((a, b) => a.date.localeCompare(b.date))
      .map((g) => {
        const names = g.pids.sort((a, b) => order.get(a) - order.get(b)).map((id) => this.surname(people.get(id)));
        const who = names.length > 1 ? `${names.slice(0, -1).join(', ')} и ${names.at(-1)}` : names[0];
        return { text: `${Dates.dm(g.date)} ${who} ${g.reason}`, auto: true };
      });
    const free = DB.data.notes.filter((n) => n.month === ym).map((n) => ({ text: n.text, id: n.id }));
    return [...auto, ...free];
  },
};
