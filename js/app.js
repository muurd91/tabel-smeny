// ================= Интерфейс =================
// Четыре экрана: «Смена» (отметить, кто не вышел, на выбранную дату), «Табель» (месяц целиком,
// выгрузка в Excel), «Люди» (состав смены), «Настройки» (облако, график, Telegram, копии данных).

const $ = (sel, root = document) => root.querySelector(sel);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch {} },
};

const UI = {
  view: store.get('ts.view') || 'shift',
  tabelMode: store.get('ts.tabelMode') === 'sticker' ? 'sticker' : 'hours', // «Табель»: часы или стикеровка
  date: Sched.current(), // ночью до 7:30 после ночной — ещё вчерашняя смена
  month: Dates.ym(Sched.current()),
};

const ICON = {
  left: '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="m15 18-6-6 6-6"/></svg>',
  right: '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="m9 18 6-6-6-6"/></svg>',
  up: '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="m18 15-6-6-6 6"/></svg>',
  down: '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="m6 9 6 6 6-6"/></svg>',
  plus: '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M12 5v14M5 12h14"/></svg>',
  file: '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M14 3H6a1 1 0 0 0-1 1v16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8Zm0 0v5h5M9 13l6 5m0-5-6 5"/></svg>',
  share: '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M12 15V3m0 0L8 7m4-4 4 4M5 12v7a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-7"/></svg>',
  x: '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M18 6 6 18M6 6l12 12"/></svg>',
  trash: '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M4 7h16M10 11v6M14 11v6M5 7l1 13h12l1-13M9 7V4h6v3"/></svg>',
};

// ---------- Значения клеток ----------
// Вид значения относительно графика: Д/Н — по графику, sick/vac/absent — коды,
// part — меньше нормы, extra — сверх графика или больше нормы, off — выходной, empty — пусто в рабочий день.
function kindOf(v, date) {
  const t = Sched.type(date);
  const def = Sched.hoursOf(t);
  if (v === 'Б') return 'sick';
  if (v === 'ОТ') return 'vac';
  if (v === '-') return 'absent';
  if (v === '' || v === undefined) return t === 'В' ? 'off' : 'empty';
  if (typeof v === 'number') {
    if (t === 'В') return 'extra';
    if (v === def) return t;
    return v < def ? 'part' : 'extra';
  }
  return 'absent';
}
const valText = (v) => (v === '-' ? '−' : v === '' || v === undefined ? '—' : String(v).replace('.', ','));
const valHtml = (v, date) => {
  const k = kindOf(v, date);
  const cls = k === 'off' || k === 'empty' ? 'empty' : k;
  return `<span class="val val--${cls}">${esc(valText(v))}</span>`;
};
const kindLabel = {
  sick: 'Больничный', vac: 'Отпуск', absent: 'Отсутствие', part: 'Неполная смена', extra: 'Сверх графика', empty: 'Пусто (без часов)',
};

function dateTitle(d, withYear) {
  const day = Number(d.slice(8));
  const y = d.slice(0, 4);
  return `${Dates.WD[Dates.wd(d)]}, ${day} ${Dates.MONTHS_GEN[Number(d.slice(5, 7)) - 1]}${withYear ? ` ${y}` : ''}`;
}
const typeLabel = (t) => {
  const s = DB.data.settings;
  // «Дневная 7:30–19:30 · 12 ч»
  const label = (name, time, hours) => [name, time, `· ${hours} ч`].filter(Boolean).join(' ');
  return t === 'Д' ? label('Дневная', s.dayTime, s.dayHours) : t === 'Н' ? label('Ночная', s.nightTime, s.nightHours) : 'Выходной у смены';
};

// ---------- Уведомление ----------
let toastTimer;
function toast(text) {
  const el = $('#toast');
  el.textContent = text;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 3200);
}

// ---------- Нижний лист ----------
const sheet = $('#sheet');
const sheetBody = $('#sheet-body');
sheet.addEventListener('click', (e) => { if (e.target === sheet) sheet.close(); });
// Enter в поле ввода — это «Сохранить», а не закрытие окна
sheetBody.addEventListener('submit', (e) => {
  if (e.submitter?.value === 'cancel') return;
  e.preventDefault();
  $('[data-save], [data-go]', sheetBody)?.click();
});
function openSheet(html, bind) {
  sheetBody.innerHTML = `<div class="sheet__grip" tabindex="-1" autofocus></div>${html}`;
  sheetBody.onclick = null;
  sheetBody.oninput = null;
  bind?.(sheetBody);
  if (!sheet.open) sheet.showModal();
}

// ================= Экран «Смена» =================
function renderShift() {
  const el = $('#view-shift');
  const d = UI.date;
  const t = Sched.type(d);
  const map = Tabel.marksMap();
  const people = DB.data.people.filter((p) => !p.archived);

  // Дата, тип смены и ход времени — в шапке (renderShiftbar)
  let html = Reports.banner() + Production.cardHtml();

  if (!people.length) {
    html += `<div class="card empty"><b>Пока никого нет</b>Загрузите прошлый табель — подтянутся люди и отметки.
      <div class="row row--center mt-14">
        <button class="btn btn--primary" data-act="import" type="button">${ICON.file} Загрузить табель Excel</button>
        <button class="btn" data-act="people" type="button">Добавить вручную</button>
      </div></div>`;
    el.innerHTML = html;
    return;
  }

  const row = (p) => {
    const v = Tabel.cell(p.id, d, map);
    const m = map.get(Tabel.markId(d, p.id));
    const k = kindOf(v, d);
    const sub = m?.reason ? `<span class="person__sub person__sub--reason">${esc(m.reason)}</span>`
      : kindLabel[k] ? `<span class="person__sub person__sub--reason">${esc(kindLabel[k])}</span>`
        : `<span class="person__sub">${esc(p.position || '')}</span>`;
    return `<button class="person" data-pid="${p.id}" type="button">
      <span class="person__info"><span class="person__name">${esc(Tabel.shortName(p))}</span><br>${sub}</span>
      ${valHtml(v, d)}</button>`;
  };

  // Всем по умолчанию стоят часы по графику; на экране — только отклонения за день.
  const vals = people.map((p) => Tabel.cell(p.id, d, map));
  // Отмечены — только те, у кого есть отметка, отличная от графика (будущие пустые дни — не отметки).
  const marked = people.filter((p, i) => map.has(Tabel.markId(d, p.id)) && (t === 'В' ? vals[i] !== '' : kindOf(vals[i], d) !== t));
  if (t !== 'В' && !Sched.started(d)) {
    // Сколько до начала — в шапке; здесь только подсказка
    html += `<p class="hint mt-0">Часы по графику появятся с началом смены. Заранее можно отметить больничный, отпуск или заявление.</p>`;
  } else if (t !== 'В') {
    const present = vals.filter((v) => typeof v === 'number' && v > 0).length;
    html += `<div class="summary"><span class="summary__main">На смене ${present} из ${people.length}</span>
      <span class="muted small">остальным стоит ${Sched.hoursOf(t)} ч по графику</span></div>`;
  }
  html += upcomingHtml();
  html += quickForm(d, t, people, map);

  if (marked.length) {
    html += `<div class="list-head">${t === 'В' ? 'Вышли сверх графика' : 'Отмечены'}</div>
      <div class="list">${marked.map((p) => `<div class="marked">${row(p)}<button class="btn btn--icon marked__x" data-clear="${p.id}" type="button" aria-label="Снять отметку">${ICON.x}</button></div>`).join('')}</div>`;
  } else if (t !== 'В' && Sched.started(d)) {
    html += `<p class="hint">Отсутствующих нет — все на смене.</p>`;
  }
  // Кто на стикеровке в эту смену (на табель не влияет); часы — нажатием на клетку в «Табеле» → «Стикеровка»
  const stickers = Tabel.stickerMap();
  const onSticker = people.filter((p) => stickers.has(Tabel.markId(d, p.id)));
  if (onSticker.length) {
    const hoursOf = (p) => { const h = stickers.get(Tabel.markId(d, p.id)).h; return h ? ` · ${String(h).replace('.', ',')} ч, остальное — станки` : ''; };
    html += `<div class="list-head">На стикеровке</div>
      <div class="list">${onSticker.map((p) => `<div class="marked"><div class="person"><span class="person__info"><span class="person__name">${esc(Tabel.shortName(p))}</span><br><span class="person__sub">${esc((p.position || '') + hoursOf(p))}</span></span><span class="val val--sticker">С</span></div><button class="btn btn--icon marked__x" data-unsticker="${p.id}" type="button" aria-label="Снять со стикеровки">${ICON.x}</button></div>`).join('')}</div>`;
  }
  html += `<details class="all"${UI.showAll ? ' open' : ''}><summary>Все работники (${people.length})</summary>
    <div class="list">${people.map(row).join('')}</div></details>`;
  el.innerHTML = html;
}

// ---------- Шапка вкладки «Смена»: дата, тип смены, сколько осталось, полоса хода смены ----------
// Начало и конец смены числа d как Date: ночная 13-го — с 19:30 13-го до 7:30 14-го.
function shiftSpan(d, t) {
  const [a, b] = Sched.times(t);
  const [y, m, day] = d.split('-').map(Number);
  const start = new Date(y, m - 1, day, Math.floor(a / 60), a % 60);
  const end = new Date(start.getTime() + (((b - a + 1440) % 1440) || 1440) * 60000);
  return { start, end };
}
const hhmm = (dt) => `${dt.getHours()}:${String(dt.getMinutes()).padStart(2, '0')}`;
function durText(ms) {
  const min = Math.max(1, Math.ceil(ms / 60000));
  const h = Math.floor(min / 60), m = min % 60;
  return [h ? `${h} ч` : '', m ? `${m} мин` : ''].filter(Boolean).join(' ');
}

// Шапка на «Смене», «Табеле» и «Людях» (на «Настройках» её нет). На «Смене» — выбранный день
// (нажать на дату — календарь), на остальных вкладках — текущая смена.
function renderShiftbar() {
  const el = $('#shiftbar');
  const onShift = UI.view === 'shift';
  const d = onShift ? UI.date : Sched.current();
  const t = Sched.type(d);
  const now = new Date();
  const name = { Д: 'Дневная', Н: 'Ночная' }[t] || 'Выходной';
  const thisYear = d.slice(0, 4) === Dates.today().slice(0, 4);

  let main, sub = '', pct = null;
  if (t === 'В') {
    main = 'Выходной по графику';
  } else {
    const { start, end } = shiftSpan(d, t);
    const span = `${hhmm(start)}–${hhmm(end)}`;
    if (now < start) {
      main = start - now < 864e5 ? `До начала ${durText(start - now)}` : 'Смена впереди';
      sub = span; pct = 0;
    } else if (now < end) {
      main = `Осталось ${durText(end - now)}`;
      sub = `до ${hhmm(end)}`; pct = (now - start) / (end - start) * 100;
    } else {
      main = 'Смена закончилась'; sub = span; pct = 100;
    }
  }

  const title = `${esc(name)} · ${esc(dateTitle(d, !thisYear))}`;
  el.innerHTML = `
    ${onShift ? `<label class="shiftbar__date"><span class="shiftbar__title">${title}</span>${ICON.down}
      <input class="datebar__input" type="date" id="shift-date" value="${d}" aria-label="Выбрать дату"></label>`
    : `<div class="shiftbar__date"><span class="shiftbar__title">${title}</span></div>`}
    <div class="shiftbar__status"><b>${esc(main)}</b>${sub ? `<span>${esc(sub)}</span>` : ''}</div>
    ${pct === null ? '' : `<div class="shiftbar__track" role="progressbar" aria-label="Ход смены" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${Math.round(pct)}"><div class="shiftbar__fill${pct >= 100 ? ' is-done' : ''}"></div></div>`}
    ${onShift && d !== Sched.current() ? '<button class="shiftbar__back" data-act="today" type="button">К текущей смене</button>' : ''}`;
  const fill = $('.shiftbar__fill', el);
  if (fill) fill.style.width = `${Math.min(100, Math.max(0, pct))}%`;
}

$('#shiftbar').addEventListener('click', (e) => {
  if (e.target.closest('[data-act="today"]')) { UI.date = Sched.current(); UI.qf.reason = ''; UI.qf.from = UI.qf.until = undefined; render(); return; }
  // Открыть календарь по нажатию на дату (там, где браузер это умеет)
  const input = e.target.closest('.shiftbar__date')?.querySelector('input');
  try { input?.showPicker?.(); } catch {}
});
$('#shiftbar').addEventListener('change', (e) => {
  if (e.target.id === 'shift-date' && e.target.value) { UI.date = e.target.value; UI.qf.reason = ''; UI.qf.from = UI.qf.until = undefined; render(); }
});

// Раз в полминуты — обновить «сколько осталось»; на стыке смен (7:30, 19:30) перерисовать экран целиком:
// у новой смены появляются часы по графику.
{
  let key = '';
  setInterval(() => {
    if (document.hidden || UI.view === 'more') return;
    const k = `${Sched.current()}|${Sched.started(UI.date)}`;
    if (key && k !== key) render(); else renderShiftbar();
    key = k;
  }, 30000);
}

// ---------- Быстрая отметка: работник + причина ----------
// Состояние формы живёт между перерисовками (данные могут обновиться из облака).
UI.qf = {};
UI.showAll = false;

// Стикеровка — не отсутствие, а где человек работал: часы не меняет, видна в «Табеле» → «Стикеровка».
const STICKER = { k: 'sticker', label: 'Стикеровка', v: 'sticker' };

function quickReasons(t) {
  const s = DB.data.settings;
  if (t === 'В') {
    return [
      { k: 'day', label: `В день · ${s.dayHours} ч`, v: s.dayHours },
      { k: 'night', label: `В ночь · ${s.nightHours} ч`, v: s.nightHours },
      { k: 'part', label: 'Другое число часов', v: 'part' },
      STICKER,
    ];
  }
  return [
    { k: 'sick', label: 'Больничный', v: 'Б' },
    { k: 'vac', label: 'Отпуск', v: 'ОТ' },
    { k: 'own', label: 'За свой счёт', v: '-', reason: 'заявление за свой счёт' },
    { k: 'truancy', label: 'Прогул', v: '-', reason: 'прогул' },
    { k: 'part', label: 'Неполная смена', v: 'part' },
    { k: 'other', label: 'Другое', v: '-' },
    STICKER,
  ];
}

const quickDefHours = (t) => (t === 'В' ? DB.data.settings.dayHours : Math.max(Sched.hoursOf(t) - 2, 1));

function quickForm(d, t, people, map) {
  const q = UI.qf;
  const reasons = quickReasons(t);
  const r = reasons.find((x) => x.k === q.reason);
  const stickers = Tabel.stickerSet();
  const status = (p) => {
    const st = Tabel.isSticker(d, p.id, stickers) ? ' — стикеровка' : '';
    if (!map.has(Tabel.markId(d, p.id))) return st;
    const v = Tabel.cell(p.id, d, map);
    const k = kindOf(v, d);
    return (k === t || k === 'off' ? '' : ` — сейчас: ${valText(v)}`) + st;
  };
  let extra = '';
  if (r?.v === 'part') {
    extra = `<div class="row mt-10 row--bottom">
        <label class="field field--flush"><span class="field__label">Отработал часов</span>
          <input class="input input--short" id="qf-hours" type="number" inputmode="decimal" min="0" max="24" step="0.5" value="${esc(q.hours ?? quickDefHours(t))}"></label>
        ${t !== 'В' ? `<label class="field grow field--flush"><span class="field__label">Причина (в примечание)</span>
          <input class="input" id="qf-text" value="${esc(q.text || '')}" placeholder="например, заявление" autocomplete="off"></label>` : ''}
      </div>`;
  }
  // Заявление, отпуск, больничный, стикеровка — можно сразу на будущие дни и на несколько смен.
  if (r && ['own', 'other', 'sick', 'vac', 'sticker'].includes(r.k)) {
    const from = q.from || d;
    extra += `${r.k === 'other' ? `<label class="field"><span class="field__label">Причина (в примечание)</span>
      <input class="input" id="qf-text" value="${esc(q.text || '')}" placeholder="что случилось" autocomplete="off"></label>` : ''}
      <div class="row row--nowrap">
        <label class="field grow field--tight"><span class="field__label">С</span><input class="input" id="qf-from" type="date" value="${esc(from)}"></label>
        <label class="field grow field--tight"><span class="field__label">По (включительно)</span><input class="input" id="qf-until" type="date" min="${esc(from)}" value="${esc(q.until && q.until > from ? q.until : from)}"></label>
      </div>
      ${r.k === 'sticker' ? `<label class="field field--tight"><span class="field__label">Часов на стикеровке (остальное — станки)</span>
        <input class="input input--short" id="qf-sthours" type="text" inputmode="decimal" autocomplete="off" value="${esc(q.stHours || '')}" placeholder="вся смена"></label>` : ''}
      <div class="small muted">${r.k === 'sticker' ? 'Табель не меняется. Отметка — в «Табеле» → «Стикеровка», на все смены по графику в этом промежутке.' : from > Dates.today() ? 'Будущая дата — бот напишет вам в личку, в «Скоро не будет» появится запись.' : 'Отметка встанет на все смены по графику в этом промежутке.'}</div>`;
  }
  const ready = q.pid && r;
  return `<div class="card qf">
    <h2>${t === 'В' ? 'Отметить выход сверх графика' : 'Отметить отсутствие'}</h2>
    <label class="field"><span class="field__label">Работник</span>
      <select class="input" id="qf-person">
        <option value="">— выберите —</option>
        ${people.map((p) => `<option value="${p.id}"${q.pid === p.id ? ' selected' : ''}>${esc(Tabel.shortName(p))}${esc(status(p))}</option>`).join('')}
      </select></label>
    <div class="field__label">${t === 'В' ? 'Когда выходил' : 'Причина'}</div>
    <div class="chips chips--grid">${reasons.map((x) => `<button class="chip${x.k === 'sticker' ? ' chip--wide' : ''}${q.reason === x.k ? ' is-on' : ''}" data-qr="${x.k}" type="button">${esc(x.label)}</button>`).join('')}</div>
    ${extra}
    <button class="btn btn--primary btn--block mt-12" data-act="qf-save" type="button" ${ready ? '' : 'disabled'}>Отметить</button>
  </div>`;
}

// Отметка на дату; Б и ОТ — сразу на все смены по графику до until включительно.
// Коды (Б, ОТ, «−») с until — на все смены по графику в промежутке. Возвращает отмеченные даты.
function applyMark(pid, date, v, reason = '', until = date) {
  const dates = [];
  DB.update(() => {
    if (typeof v === 'string' && v && until > date) {
      for (let d = date; d <= until; d = Dates.add(d, 1)) {
        if (d === date || Sched.type(d) !== 'В') { Tabel.setMark(d, pid, v, reason); dates.push(d); }
      }
    } else { Tabel.setMark(date, pid, v, reason); dates.push(date); }
  });
  return dates;
}

// Отсутствие на будущие дни (заявление, отпуск, больничный) — бот пишет мастеру в личку.
const PLANNED = ['-', 'ОТ', 'Б'];
async function notifyPlanned(p, dates, v, reason) {
  const today = Dates.today();
  const future = dates.filter((d) => d >= today && !Sched.started(d)); // и сегодняшняя смена, если ещё не началась
  if (!future.length || !PLANNED.includes(v)) return;
  if (!Telegram.meReady()) {
    if (Telegram.ready()) toast('Чтобы бот писал о таком вам лично: «Настройки» → «Уведомления мне»');
    return;
  }
  const kind = (d) => ({ Д: 'день', Н: 'ночь' }[Sched.type(d)] || 'выходной');
  const when = future.map((d) => `${Dates.dm(d)} (${Dates.WD[Dates.wd(d)]}, ${kind(d)})`).join(', ');
  const why = reason || CONFIG.codes[v]?.label.toLowerCase() || v;
  const text = `📝 ${Tabel.shortName(p)}${p.position ? ` (${p.position})` : ''} — не будет ${when}.\nПричина: ${why}.`;
  try { await Telegram.sendMe(text); }
  catch (err) { toast(`Уведомление в Telegram не ушло: ${err.message}`); }
}

// Запланированные отсутствия на ближайшие 14 дней — блок «Скоро не будет».
function upcomingHtml() {
  const today = Dates.today();
  const last = Dates.add(today, 14);
  const people = new Map(DB.data.people.map((p) => [p.id, p]));
  const list = DB.data.marks
    .filter((m) => m.date > today && m.date <= last && PLANNED.includes(m.v) && people.has(m.pid))
    .sort((a, b) => a.date.localeCompare(b.date));
  if (!list.length) return '';
  // Подряд идущие дни одного человека с одной причиной — одной строкой: «15.10–20.10»
  const rows = [];
  for (const m of list) {
    const key = `${m.pid}|${m.v}|${m.reason || ''}`;
    const prev = rows.find((r) => r.key === key && Dates.num(m.date) - Dates.num(r.to) <= 4);
    if (prev) prev.to = m.date; else rows.push({ key, from: m.date, to: m.date, m });
  }
  rows.sort((a, b) => a.from.localeCompare(b.from));
  const tomorrow = Dates.add(today, 1);
  return `<div class="card upcoming"><h2>Скоро не будет</h2>
    ${rows.map((r) => {
      const p = people.get(r.m.pid);
      const start = r.from === tomorrow ? 'завтра' : `${Dates.WD[Dates.wd(r.from)]} ${Dates.dm(r.from)}`;
      const dates = r.from === r.to ? start : `${r.from === tomorrow ? 'завтра' : Dates.dm(r.from)}–${Dates.dm(r.to)}`;
      const why = r.m.reason || CONFIG.codes[r.m.v]?.label.toLowerCase();
      return `<button class="upcoming__row" data-goto="${r.from}" type="button">
        <span class="upcoming__date${r.from === tomorrow ? ' is-soon' : ''}">${esc(dates)}</span>
        <span class="grow"><b>${esc(Tabel.shortName(p))}</b> · ${esc(why)}</span></button>`;
    }).join('')}</div>`;
}

function saveQuick() {
  const q = UI.qf;
  const d = UI.date;
  const t = Sched.type(d);
  const r = quickReasons(t).find((x) => x.k === q.reason);
  const p = DB.data.people.find((x) => x.id === q.pid);
  if (!r || !p) return;
  if (r.k === 'sticker') {
    // На все смены по графику в промежутке (первый день — всегда, даже выходной: вышел сверх графика),
    // кроме дней, когда человека нет: больничный, отпуск, «−».
    const from = q.from || d;
    const until = q.until > from ? q.until : from;
    const h = String(q.stHours || '').trim() ? parseHours(q.stHours) : undefined; // пусто — вся смена; можно 4,5 или 4:30
    if (h !== undefined && !(h > 0 && h <= 24)) { toast('Часы на стикеровке — например, 4,5 или 4:30; пусто — вся смена'); return; }
    const marks = Tabel.marksMap();
    let skipped = 0;
    UI.qf = {};
    DB.update(() => {
      for (let x = from; x <= until; x = Dates.add(x, 1)) {
        if (x !== from && Sched.type(x) === 'В') continue;
        if (PLANNED.includes(marks.get(Tabel.markId(x, p.id))?.v)) { skipped++; continue; }
        Tabel.setSticker(x, p.id, true, h);
      }
    });
    toast(`${Tabel.surname(p)}: стикеровка${h ? ` ${String(h).replace('.', ',')} ч` : ''}${until > from ? ` ${Dates.dm(from)}–${Dates.dm(until)}` : from !== d ? ` ${Dates.dm(from)}` : ''}${skipped ? ` (пропущено смен, где его нет: ${skipped})` : ''}`);
    return;
  }
  let v = r.v;
  let reason = r.reason || '';
  if (v === 'part') {
    v = parseFloat(String(q.hours ?? quickDefHours(t)).replace(',', '.'));
    if (!Number.isFinite(v) || v < 0 || v > 24) { toast('Укажите часы от 0 до 24'); return; }
  }
  if (r.k === 'part' || r.k === 'other') reason = (q.text || '').trim();
  const ranged = ['own', 'other', 'sick', 'vac'].includes(r.k);
  const from = ranged && q.from ? q.from : d;
  const until = ranged && q.until > from ? q.until : from;
  UI.qf = {};
  const dates = applyMark(p.id, from, v, reason, until);
  const when = until > from ? ` ${Dates.dm(from)}–${Dates.dm(until)}` : from !== d ? ` ${Dates.dm(from)}` : '';
  toast(`${Tabel.surname(p)}: ${r.label.toLowerCase()}${when}`);
  notifyPlanned(p, dates, v, reason);
}

$('#view-shift').addEventListener('click', (e) => {
  const act = e.target.closest('[data-act]')?.dataset.act;
  if (act === 'import') { $('#file-xlsx').click(); return; }
  if (act === 'people') { go('people'); addPerson(); return; }
  if (act === 'qf-save') { saveQuick(); return; }
  const go2 = e.target.closest('[data-goto]')?.dataset.goto;
  if (go2) { UI.date = go2; UI.qf.from = UI.qf.until = undefined; render(); window.scrollTo(0, 0); return; }
  const qr = e.target.closest('[data-qr]')?.dataset.qr;
  if (qr) { UI.qf.reason = qr; UI.qf.text = ''; UI.qf.hours = undefined; render(); return; }
  const prodDel = e.target.closest('[data-prod-del]')?.dataset.prodDel;
  if (prodDel) {
    if (confirm('Удалить эту запись о сданной продукции?')) Production.remove(prodDel).catch((err) => toast(err.message || 'Не удалилось'));
    return;
  }
  const unsticker = e.target.closest('[data-unsticker]')?.dataset.unsticker;
  if (unsticker) {
    const p = DB.data.people.find((x) => x.id === unsticker);
    DB.update(() => Tabel.setSticker(UI.date, unsticker, false));
    toast(`${Tabel.surname(p)}: снят со стикеровки`);
    return;
  }
  const clear = e.target.closest('[data-clear]')?.dataset.clear;
  if (clear) {
    const p = DB.data.people.find((x) => x.id === clear);
    DB.update(() => Tabel.setMark(UI.date, clear, Tabel.def(UI.date)));
    toast(`${Tabel.surname(p)}: ${Sched.type(UI.date) === 'В' ? 'выход снят' : 'на смене по графику'}`);
    return;
  }
  const pid = e.target.closest('[data-pid]')?.dataset.pid;
  if (pid) { openEditor(pid, UI.date); return; }
});
$('#view-shift').addEventListener('change', (e) => {
  if (e.target.id === 'qf-person') { UI.qf.pid = e.target.value; render(); }
  else if (e.target.id === 'qf-from' && e.target.value) { UI.qf.from = e.target.value; render(); } // обновить «по» и подсказку
});
$('#view-shift').addEventListener('input', (e) => {
  if (e.target.id === 'qf-hours') UI.qf.hours = e.target.value;
  else if (e.target.id === 'qf-sthours') UI.qf.stHours = e.target.value;
  else if (e.target.id === 'qf-text') UI.qf.text = e.target.value;
  else if (e.target.id === 'qf-until') UI.qf.until = e.target.value;
});
$('#view-shift').addEventListener('toggle', (e) => {
  if (e.target.classList?.contains('all')) UI.showAll = e.target.open;
}, true);

// ---------- Отметка человека на дату ----------
function openEditor(pid, date) {
  const p = DB.data.people.find((x) => x.id === pid);
  if (!p) return;
  const s = DB.data.settings;
  const t = Sched.type(date);
  const def = Sched.hoursOf(t);
  const map = Tabel.marksMap();
  const mark = map.get(Tabel.markId(date, pid));
  const cur = Tabel.cell(pid, date, map);

  const opts = t !== 'В'
    ? [
      { k: 'full', label: 'Отработал', v: def },
      { k: 'part', label: 'Неполная смена', v: 'part' },
      { k: 'Б', label: 'Больничный', v: 'Б' },
      { k: 'ОТ', label: 'Отпуск', v: 'ОТ' },
      { k: '-', label: 'Отсутствие', v: '-' },
      { k: 'empty', label: 'Пусто (без часов)', v: '' },
    ]
    : [
      { k: 'none', label: 'Не выходил', v: '' },
      { k: 'day', label: 'В день', v: s.dayHours },
      { k: 'night', label: 'В ночь', v: s.nightHours },
      { k: 'part', label: 'Другое число часов', v: 'part' },
    ];
  let sel = opts.find((o) => o.v === cur)?.k
    || (typeof cur === 'number' ? 'part' : '-');
  let hours = typeof cur === 'number' && sel === 'part' ? cur : t !== 'В' ? Math.max(def - 2, 1) : s.dayHours;
  let reason = mark?.reason || '';
  let until = date;

  const optVal = (o) => (o.v === 'part' ? '<span class="val val--part">ч</span>' : valHtml(o.v, date));
  const reasonBox = (list) => `
    <div class="chips">${list.map((r) => `<button class="chip${reason === r ? ' is-on' : ''}" data-reason="${esc(r)}" type="button">${esc(r)}</button>`).join('')}
      <button class="chip${!reason ? ' is-on' : ''}" data-reason="" type="button">без примечания</button></div>
    <label class="field"><span class="field__label">Причина в примечание</span>
      <input class="input" id="ed-reason" value="${esc(reason)}" placeholder="например, заявление за свой счёт" autocomplete="off"></label>`;

  const extra = () => {
    if (sel === 'part') {
      return `<div class="extra-box">
        <div class="field__label">Сколько часов отработал</div>
        <div class="stepper"><button class="btn btn--icon" data-step="-1" type="button">−</button>
          <input class="input input--short" id="ed-hours" type="number" inputmode="decimal" min="0" max="24" step="0.5" value="${hours}">
          <button class="btn btn--icon" data-step="1" type="button">+</button></div>
        ${t !== 'В' ? reasonBox(CONFIG.partialReasons) : ''}</div>`;
    }
    if (sel === 'Б' || sel === 'ОТ') {
      return `<div class="extra-box"><label class="field"><span class="field__label">По какое число (включительно)</span>
        <input class="input" id="ed-until" type="date" min="${date}" value="${until}"></label>
        <div class="small muted">«${sel}» встанет на все смены по графику в этом промежутке.</div></div>`;
    }
    if (sel === '-') return `<div class="extra-box">${reasonBox(CONFIG.absenceReasons)}</div>`;
    return '';
  };

  const draw = () => {
    openSheet(`<h3>${esc(p.name)}</h3>
      <p class="sheet__sub">${esc(dateTitle(date, true))} · ${esc(typeLabel(t))}</p>
      <div class="opts">${opts.map((o) => `<button class="opt${o.k === sel ? ' is-on' : ''}${o.wide ? ' opt--wide' : ''}" data-opt="${esc(o.k)}" type="button">${optVal(o)}<span>${esc(o.label)}</span></button>`).join('')}</div>
      ${extra()}
      ${mark ? `<button class="btn btn--block mt-12" data-reset type="button">Вернуть по графику${Tabel.def(date) ? ` (${Tabel.def(date)} ч)` : ' (пусто, день не наступил)'}</button>` : ''}
      <div class="sheet__actions"><button class="btn" value="cancel">Отмена</button><button class="btn btn--primary" data-save type="button">Сохранить</button></div>`, bind);
  };

  const bind = (b) => {
    b.oninput = (e) => {
      if (e.target.id === 'ed-reason') reason = e.target.value;
      if (e.target.id === 'ed-hours') hours = e.target.value;
      if (e.target.id === 'ed-until') until = e.target.value || date;
    };
    b.onclick = (e) => {
      const o = e.target.closest('[data-opt]');
      if (o) { sel = o.dataset.opt; if (sel !== 'part' && sel !== '-') reason = ''; draw(); return; }
      const r = e.target.closest('[data-reason]');
      if (r) { reason = r.dataset.reason; draw(); return; }
      const st = e.target.closest('[data-step]');
      if (st) {
        const n = Math.min(24, Math.max(0, (parseFloat(String(hours).replace(',', '.')) || 0) + Number(st.dataset.step)));
        hours = n;
        $('#ed-hours', b).value = n;
        return;
      }
      if (e.target.closest('[data-reset]')) {
        DB.update(() => Tabel.setMark(date, pid, Tabel.def(date)));
        sheet.close();
        toast(`${Tabel.surname(p)}: по графику`);
        return;
      }
      if (e.target.closest('[data-save]')) save();
    };
  };

  const save = () => {
    const o = opts.find((x) => x.k === sel);
    let v = o.v;
    if (v === 'part') {
      v = parseFloat(String(hours).replace(',', '.'));
      if (!Number.isFinite(v) || v < 0 || v > 24) { toast('Укажите часы от 0 до 24'); return; }
    }
    const why = (sel === 'part' || sel === '-') ? reason.trim() : '';
    const dates = applyMark(pid, date, v, why, (sel === 'Б' || sel === 'ОТ') ? until : date);
    notifyPlanned(p, dates, v, why);
    sheet.close();
    toast(`${Tabel.surname(p)}: ${o.label.toLowerCase()}${(sel === 'Б' || sel === 'ОТ') && until > date ? ` по ${Dates.dm(until)}` : ''}`);
  };

  draw();
}

// ================= Экран «Табель» =================
function renderTabel() {
  const el = $('#view-tabel');
  const ym = UI.month;
  const days = Dates.monthDays(ym);
  const people = Tabel.peopleOf(ym);
  const map = Tabel.marksMap();
  const today = Dates.today();
  const s = DB.data.settings;
  const types = days.map((d) => Sched.type(d));
  const canShare = !!(navigator.canShare && window.File);

  const mode = UI.tabelMode;
  let html = `${Reports.banner()}
    <div class="seg" role="tablist" aria-label="Что показать">
      ${[['hours', 'Часы'], ['sticker', 'Стикеровка']].map(([k, label]) => `<button class="seg__btn${mode === k ? ' is-on' : ''}" data-mode="${k}" role="tab" aria-selected="${mode === k}" type="button">${label}</button>`).join('')}
    </div>
    <div class="monthbar">
      <button class="btn btn--icon" data-act="prev" type="button" aria-label="Предыдущий месяц">${ICON.left}</button>
      <div class="monthbar__title">${esc(Dates.monthTitle(ym))}</div>
      <button class="btn btn--icon" data-act="next" type="button" aria-label="Следующий месяц">${ICON.right}</button>
    </div>`;
  if (mode === 'sticker') { el.innerHTML = html + stickerTabelHtml(ym, days, types, today); scrollToToday(el); return; }
  html += `
    <div class="row mb-12">
      <button class="btn btn--primary grow" data-act="xlsx" type="button" aria-label="Скачать Excel">${ICON.file} Excel</button>
      ${canShare ? `<button class="btn grow" data-act="share" type="button">${ICON.share} Отправить</button>` : ''}
      <button class="btn btn--icon" data-act="clear" type="button" aria-label="Очистить" title="Очистить часы и отметки">${ICON.trash}</button>
    </div>`;

  if (!people.length) {
    html += `<div class="card empty"><b>В этом месяце никого нет</b>Добавьте людей на вкладке «Люди» или загрузите табель Excel.</div>`;
    el.innerHTML = html;
    return;
  }

  const head1 = days.map((d, i) => `<th class="${types[i]}">${Dates.WD[Dates.wd(d)]}</th>`).join('');
  const head2 = days.map((d, i) => `<th class="${types[i]}${d === today ? ' is-today' : ''}">${i + 1}</th>`).join('');
  const head3 = days.map((d, i) => `<th class="${types[i]}">${types[i] === 'В' ? '' : types[i]}</th>`).join('');
  const body = people.map((p) => {
    const cells = days.map((d, i) => {
      const v = Tabel.cell(p.id, d, map);
      const k = kindOf(v, d);
      const extra = ['sick', 'vac', 'absent', 'part', 'extra'].includes(k) ? ` c--${k}` : '';
      return `<td class="c ${types[i]}${extra}" data-pid="${p.id}" data-date="${d}">${v === '' ? '' : esc(valText(v))}</td>`;
    }).join('');
    return `<tr><th class="name" title="${esc(p.name)}">${esc(Tabel.shortName(p))}</th>${cells}<td class="tot">${String(Tabel.total(p.id, ym, map)).replace('.', ',')}</td></tr>`;
  }).join('');

  html += `<div class="tabel-wrap"><table class="tabel">
      <thead><tr><th class="name"></th>${head1}<th class="tot"></th></tr>
      <tr><th class="name">${esc(DB.data.settings.shiftName)}</th>${head2}<th class="tot">Итого</th></tr>
      <tr><th class="name"></th>${head3}<th class="tot"></th></tr></thead>
      <tbody>${body}</tbody></table></div>
    <div class="card legend"><h2>Обозначения</h2>
      <div class="legend__grid">
        ${[
          ['Д', s.dayHours, `дневная смена (${s.dayTime})`],
          ['Н', s.nightHours, `ночная смена (${s.nightTime})`],
          ['c--sick', 'Б', 'больничный'],
          ['c--vac', 'ОТ', 'отпуск'],
          ['c--absent', '−', 'не вышел: за свой счёт, прогул'],
          ['c--part', String(s.dayHours - 3), 'неполная смена (сколько отработал)'],
          ['c--extra', s.dayHours, 'вышел сверх графика'],
          ['', '', 'выходной или смена ещё не началась'],
        ].map(([cls, v, text]) => `<div class="legend__row"><span class="legend__cell ${cls}">${esc(String(v))}</span><span>${esc(text)}</span></div>`).join('')}
      </div>
    </div>`;

  const notes = Tabel.notesOf(ym);
  html += `<div class="card"><h2>Примечания</h2>
    <p class="small muted">Строки под табелем. Причины из отметок попадают сюда сами.</p>
    <ul class="notes">${notes.map((n) => `<li><span class="grow">${esc(n.text)}</span>${n.id ? `<button class="btn btn--icon" data-del-note="${n.id}" type="button" aria-label="Удалить">${ICON.x}</button>` : '<span class="tag">по отметке</span>'}</li>`).join('') || '<li class="muted">Пока нет</li>'}</ul>
    <div class="row mt-10"><input class="input grow" id="note-text" placeholder="Своё примечание" autocomplete="off">
      <button class="btn" data-act="note" type="button">Добавить</button></div></div>`;

  el.innerHTML = html;
  scrollToToday(el);
}

// Прокрутить таблицу к сегодняшнему дню
function scrollToToday(el) {
  const wrap = $('.tabel-wrap', el);
  const th = $('.is-today', el);
  if (wrap && th) wrap.scrollLeft = Math.max(0, th.offsetLeft - 112 - wrap.clientWidth / 3);
}

// Очередь на стикеровку — по кругу в порядке табеля: укладчики-упаковщики списком, как в табеле;
// «следующий» — тот, кто идёт в списке сразу после последнего поставленного (после последнего — снова первый).
function stickerQueueHtml(today) {
  // Только укладчики-упаковщики (на стикеровку ставят их); должность — из «Людей», порядок — как в табеле
  const list = DB.data.people.filter((p) => !p.archived && /укладчи/i.test(p.position || ''));
  if (!list.length) return '';
  const ids = new Set(list.map((p) => p.id));
  const last = new Map(), next = new Map(), total = new Map();
  let latest = null; // последняя по дате отметка среди них (и запланированные): от неё считается очередь
  for (const s of DB.data.stickers) {
    if (!ids.has(s.pid)) continue;
    if (s.date <= today) {
      if (!(last.get(s.pid) >= s.date)) last.set(s.pid, s.date);
      total.set(s.pid, (total.get(s.pid) || 0) + 1);
    } else if (!(next.get(s.pid) <= s.date)) next.set(s.pid, s.date);
    const i = list.findIndex((p) => p.id === s.pid);
    if (!latest || s.date > latest.date || (s.date === latest.date && i > latest.i)) latest = { date: s.date, i };
  }
  const nextIdx = latest ? (latest.i + 1) % list.length : 0;
  const plural = (n) => (n % 10 === 1 && n % 100 !== 11 ? 'смена' : [2, 3, 4].includes(n % 10) && ![12, 13, 14].includes(n % 100) ? 'смены' : 'смен');
  return `<div class="card queue"><h2>Очередь на стикеровку</h2>
    <p class="small muted">Укладчики-упаковщики по порядку табеля. Отмечен тот, кто идёт следующим.</p>
    <ol class="queue__list">${list.map((p, i) => {
      const when = [
        next.has(p.id) ? `запланирован на ${Dates.dm(next.get(p.id))}` : '',
        last.has(p.id) ? `последний раз ${Dates.dm(last.get(p.id))} · всего ${total.get(p.id)} ${plural(total.get(p.id))}` : next.has(p.id) ? '' : 'ещё не был',
      ].filter(Boolean).join(' · ');
      return `<li class="queue__row${i === nextIdx ? ' is-next' : ''}${next.has(p.id) ? ' is-planned' : ''}"><b>${esc(Tabel.shortName(p))}${i === nextIdx ? ' <span class="queue__badge">следующий</span>' : ''}</b><span>${esc(when)}</span></li>`;
    }).join('')}</ol>
  </div>`;
}

// «Табель» → «Стикеровка»: та же сетка месяца, в клетке — часы смены: коричневая — на стикеровке
// (два числа — сверху стикеровка, снизу станки), обычная — на станках; справа — итого по местам.
// Нажатие на пустую клетку ставит стикеровку на всю смену, на отмеченную — часы или снять.
// Картинку можно отправить в Telegram вручную; в табель, Excel и на почту не попадает.
function stickerTabelHtml(ym, days, types, today) {
  const people = DB.data.people.filter((p) => !p.archived || DB.data.stickers.some((s) => s.pid === p.id && s.date.startsWith(ym)));
  if (!people.length) return '<div class="card empty"><b>В этом месяце никого нет</b>Добавьте людей на вкладке «Люди».</div>';
  const map = Tabel.marksMap();
  const stickers = Tabel.stickerMap();
  const num = (n) => String(n).replace('.', ',');
  const head1 = days.map((d, i) => `<th class="${types[i]}">${Dates.WD[Dates.wd(d)]}</th>`).join('');
  const head2 = days.map((d, i) => `<th class="${types[i]}${d === today ? ' is-today' : ''}">${i + 1}</th>`).join('');
  const head3 = days.map((d, i) => `<th class="${types[i]}">${types[i] === 'В' ? '' : types[i]}</th>`).join('');
  const body = people.map((p) => {
    const cells = days.map((d, i) => {
      const c = Tabel.split(p.id, d, map, stickers);
      const at = `data-sticker-pid="${p.id}" data-date="${d}"`;
      if (c.on && c.st && c.mach) return `<td class="c ${types[i]} c--sticker c--split" ${at}><b>${num(c.st)}</b><small>${num(c.mach)}</small></td>`;
      if (c.on) return `<td class="c ${types[i]} c--sticker" ${at}>${c.st ? num(c.st) : 'С'}</td>`;
      return `<td class="c ${types[i]} c--mach" ${at}>${c.v === '' ? '' : esc(valText(c.v))}</td>`;
    }).join('');
    const t = Tabel.splitTotal(p.id, ym, map, stickers);
    return `<tr><th class="name" title="${esc(p.name)}">${esc(Tabel.shortName(p))}</th>${cells}<td class="tot tot--sticker">${t.st ? num(t.st) : ''}</td><td class="tot">${num(t.mach)}</td></tr>`;
  }).join('');
  const tg = Telegram.ready();
  return `<div class="row mb-12">
      ${tg ? `<button class="btn btn--primary grow" data-act="sticker-tg" type="button">${ICON.share} В Telegram</button>` : ''}
      <button class="btn${tg ? ' btn--icon' : ' btn--primary grow'}" data-act="sticker-share" type="button" aria-label="Поделиться картинкой">${ICON.share}${tg ? '' : ' Отправить картинку'}</button>
    </div>
    <div class="tabel-wrap"><table class="tabel">
      <thead><tr><th class="name"></th>${head1}<th class="tot tot--sticker"></th><th class="tot"></th></tr>
      <tr><th class="name">${esc(DB.data.settings.shiftName)}</th>${head2}<th class="tot tot--sticker">Стик.</th><th class="tot">Станки</th></tr>
      <tr><th class="name"></th>${head3}<th class="tot tot--sticker">ч</th><th class="tot">ч</th></tr></thead>
      <tbody>${body}</tbody></table></div>
    ${stickerQueueHtml(today)}
    <div class="card legend"><h2>Стикеровка</h2>
      <div class="legend__grid">
        <div class="legend__row"><span class="legend__cell c--sticker">${num(DB.data.settings.dayHours)}</span><span>вся смена на стикеровке</span></div>
        <div class="legend__row"><span class="legend__cell c--sticker c--split"><b>4</b><small>${num(DB.data.settings.dayHours - 4)}</small></span><span>часть смены: сверху — стикеровка, снизу — станки</span></div>
        <div class="legend__row"><span class="legend__cell">${num(DB.data.settings.dayHours)}</span><span>на станках</span></div>
        <div class="legend__row"><span class="legend__cell c--sticker">С</span><span>стикеровка без часов: смена не началась или выходной без выхода</span></div>
      </div>
      <p class="small muted">Отметить: на «Смене» выбрать работника и «Стикеровка» (можно сразу на несколько смен) или нажать на клетку здесь. Нажатие на отмеченную клетку — сколько часов на стикеровке. Часы смены берутся из табеля; сам табель стикеровка не меняет. Картинка уходит в Telegram сама вместе с табелем 16-го и 1-го (если в периоде была стикеровка) — в группу${Telegram.fullReady() ? ', во второй чат' : ''}${Telegram.meReady() ? ' и вам в личку' : ''}; «В Telegram» — отправить сейчас. На почту не уходит.</p>
    </div>`;
}

// Часы стикеровки: «4,5», «4.5», «4:30», «4 ч 30 мин» → 4.5 (до сотых); не разобрать — NaN.
function parseHours(str) {
  const t = String(str ?? '').trim().toLowerCase().replace(',', '.');
  const m = t.match(/^(\d+(?:\.\d+)?)\s*(?:ч\.?|час\S*)?\s*(?:[:\s]\s*(\d{1,2})\s*(?:м\S*)?)?$/);
  if (!m) return NaN;
  return Math.round((Number(m[1]) + (m[2] ? Number(m[2]) / 60 : 0)) * 100) / 100;
}
const fmtHours = (n) => String(Math.round(n * 100) / 100).replace('.', ',');

// Сколько часов на стикеровке у отмеченной клетки (остальное — станки), или снять отметку.
function openStickerEditor(pid, date) {
  const p = DB.data.people.find((x) => x.id === pid);
  const s = Tabel.stickerMap().get(Tabel.markId(date, pid));
  if (!p || !s) return;
  const c = Tabel.split(pid, date);
  const shift = c.worked || Sched.hours(date) || DB.data.settings.dayHours; // смена ещё не началась — по графику
  let hours = s.h ?? shift;
  openSheet(`<h3>${esc(p.name)}</h3>
    <p class="sheet__sub">${esc(dateTitle(date, true))} · стикеровка</p>
    <div class="extra-box">
      <div class="field__label">Часов на стикеровке (смена — ${fmtHours(shift)} ч)</div>
      <div class="stepper"><button class="btn btn--icon" data-step="-0.5" type="button" aria-label="Меньше на полчаса">−</button>
        <input class="input input--short" id="st-hours" type="text" inputmode="decimal" autocomplete="off" value="${fmtHours(hours)}">
        <button class="btn btn--icon" data-step="0.5" type="button" aria-label="Больше на полчаса">+</button></div>
      <div class="small muted">Можно неполные: 4,5 или 4:30 (4 ч 30 мин), 2,25 — 2 ч 15 мин. Кнопки — по полчаса.</div>
      <div class="small" id="st-rest"></div>
    </div>
    <div class="row mt-12"><button class="btn grow" data-full type="button">Вся смена</button><button class="btn grow" data-off type="button">Снять со стикеровки</button></div>
    <div class="sheet__actions"><button class="btn" value="cancel">Отмена</button><button class="btn btn--primary" data-save type="button">Сохранить</button></div>`, (b) => {
    const rest = () => {
      const h = parseHours(hours);
      $('#st-rest', b).textContent = h > 0 && h < shift ? `На станках — ${fmtHours(shift - h)} ч` : h >= shift ? 'Вся смена на стикеровке' : hours === '' ? '' : 'Не понял часы — например, 4,5 или 4:30';
    };
    rest();
    b.oninput = (e) => { if (e.target.id === 'st-hours') { hours = e.target.value; rest(); } };
    const set = (h, msg) => {
      DB.update(() => Tabel.setSticker(date, pid, true, h));
      sheet.close();
      toast(`${Tabel.surname(p)} ${Dates.dm(date)}: ${msg}`);
    };
    b.onclick = (e) => {
      const st = e.target.closest('[data-step]');
      if (st) {
        hours = Math.min(shift, Math.max(0.5, (parseHours(hours) || 0) + Number(st.dataset.step)));
        $('#st-hours', b).value = fmtHours(hours);
        rest();
        return;
      }
      if (e.target.closest('[data-full]')) { set(undefined, 'вся смена на стикеровке'); return; }
      if (e.target.closest('[data-off]')) {
        DB.update(() => Tabel.setSticker(date, pid, false));
        sheet.close();
        toast(`${Tabel.surname(p)} ${Dates.dm(date)}: снят со стикеровки`);
        return;
      }
      if (e.target.closest('[data-save]')) {
        const h = parseHours(hours);
        if (!(h > 0)) { toast('Укажите часы больше нуля (например, 4,5 или 4:30) или «Снять со стикеровки»'); return; }
        if (h >= shift) set(undefined, 'вся смена на стикеровке');
        else set(h, `${fmtHours(h)} ч стикеровка, ${fmtHours(shift - h)} ч станки`);
      }
    };
  });
}

// Картинка стикеровки в Telegram: в группу и во второй чат (если выбран)
function sendStickerTelegram() {
  const ym = UI.month;
  const cfg = Telegram.cfg();
  openSheet(`<h3>Отправить стикеровку</h3><p class="sheet__sub">${esc(Dates.monthTitle(ym))} · только картинка</p>
    <p class="small muted">В «${esc(cfg.chatTitle || 'группа')}»${Telegram.fullReady() ? `, «${esc(cfg.fullChatTitle || 'второй чат')}»` : ''}${Telegram.meReady() ? ' и вам в личку' : ''}. На почту не уходит.</p>
    <div class="sheet__actions"><button class="btn" value="cancel">Отмена</button><button class="btn btn--primary" data-go type="button">Отправить</button></div>`, (b) => {
    b.onclick = async (ev) => {
      const btn = ev.target.closest('[data-go]');
      if (!btn) return;
      btn.disabled = true;
      btn.textContent = 'Отправляю…';
      try { await Reports.sendSticker(ym); sheet.close(); toast('Стикеровка отправлена в Telegram'); }
      catch (err) { sheet.close(); toast(err.message); }
    };
  });
}

function xlsxFile() {
  const blob = Xlsx.build(UI.month);
  return { blob, name: Xlsx.fileName(UI.month) };
}

$('#view-tabel').addEventListener('click', async (e) => {
  const act = e.target.closest('[data-act]')?.dataset.act;
  if (act === 'prev') { UI.month = Dates.addMonths(UI.month, -1); render(); }
  else if (act === 'next') { UI.month = Dates.addMonths(UI.month, 1); render(); }
  else if (act === 'xlsx') { const f = xlsxFile(); downloadBlob(f.blob, f.name); }
  else if (act === 'clear') clearTabel();
  else if (act === 'share') {
    // Картинка + Excel, как в снимках 16-го и 1-го
    const ym = UI.month;
    const name = Dates.monthTitle(ym);
    const viaShare = async () => {
      try { await Reports.share(ym, name, `Табель: ${name}`); }
      catch (err) { toast(err.message || 'Не удалось отправить'); }
    };
    if (!Telegram.ready()) { viaShare(); return; }
    openSheet(`<h3>Отправить табель</h3><p class="sheet__sub">${esc(name)} · картинка и Excel</p>
      <div class="row row--col">
        <button class="btn btn--primary" data-tg type="button">В Telegram: «${esc(Telegram.cfg().chatTitle || "группа")}»${Telegram.fullReady() ? ` + «${esc(Telegram.cfg().fullChatTitle)}»` : ""}</button>
        <button class="btn" data-share type="button">${ICON.share} Через «Поделиться»</button>
      </div>
      <div class="sheet__actions"><button class="btn" value="cancel">Отмена</button></div>`, (b) => {
      b.onclick = async (ev) => {
        if (ev.target.closest('[data-share]')) { sheet.close(); viaShare(); }
        else if (ev.target.closest('[data-tg]')) {
          ev.target.disabled = true;
          ev.target.textContent = 'Отправляю…';
          try {
            await Reports.sendTelegram(ym, name, `${DB.data.settings.shiftName} — табель за ${name.toLowerCase()}`);
            sheet.close();
            toast('Отправлено в Telegram');
          } catch (err) { sheet.close(); toast(err.message); }
        }
      };
    });
  } else if (act === 'note') {
    const text = $('#note-text').value.trim();
    if (text) DB.update((d) => d.notes.push({ id: uid(), month: UI.month, text }));
  }
  const del = e.target.closest('[data-del-note]')?.dataset.delNote;
  if (del) DB.update((d) => { d.notes = d.notes.filter((n) => n.id !== del); });
  const cell = e.target.closest('td[data-pid]');
  if (cell) openEditor(cell.dataset.pid, cell.dataset.date);
  const st = e.target.closest('td[data-sticker-pid]');
  if (st) {
    const { stickerPid: pid, date } = st.dataset;
    if (Tabel.isSticker(date, pid)) { openStickerEditor(pid, date); return; }
    const p = DB.data.people.find((x) => x.id === pid);
    DB.update(() => Tabel.setSticker(date, pid, true));
    toast(`${Tabel.surname(p)} ${Dates.dm(date)}: стикеровка на всю смену — нажмите ещё раз, чтобы указать часы`);
  }
  if (act === 'sticker-tg') sendStickerTelegram();
  else if (act === 'sticker-share') {
    try { await Reports.shareSticker(UI.month); } catch (err) { toast(err.message || 'Не удалось отправить'); }
  }
  const m = e.target.closest('[data-mode]')?.dataset.mode;
  if (m && m !== UI.tabelMode) { UI.tabelMode = m; store.set('ts.tabelMode', m); render(); }
});

// ---------- Очистка табеля за период ----------
// «Вернуть по графику» — удалить отметки (часы снова считаются по графику);
// «Пустые клетки» — убрать и часы по графику (например, дни, которые ещё не наступили).
function clearTabel() {
  const ym = UI.month;
  const days = Dates.monthDays(ym);
  const today = Dates.today();
  const isCurrent = Dates.ym(today) === ym;
  const w = {
    from: isCurrent && today < days.at(-1) ? Dates.add(today, 1) : days[0],
    to: days.at(-1),
    pid: '',
    mode: 'restore',
  };
  const people = Tabel.peopleOf(ym);

  const affected = () => {
    const map = Tabel.marksMap();
    const who = w.pid ? people.filter((p) => p.id === w.pid) : people;
    let n = 0;
    for (const p of who) {
      for (let d = w.from; d <= w.to; d = Dates.add(d, 1)) {
        if (w.mode === 'restore') { if (map.has(Tabel.markId(d, p.id))) n++; }
        else if (Tabel.cell(p.id, d, map) !== '') n++;
      }
    }
    return { n, who };
  };

  const draw = () => {
    const { n } = affected();
    openSheet(`<h3>Очистить табель</h3><p class="sheet__sub">${esc(Dates.monthTitle(ym))}</p>
      <div class="row">
        <label class="field grow field--tight"><span class="field__label">С</span><input class="input" id="cl-from" type="date" min="${days[0]}" max="${days.at(-1)}" value="${w.from}"></label>
        <label class="field grow field--tight"><span class="field__label">По</span><input class="input" id="cl-to" type="date" min="${days[0]}" max="${days.at(-1)}" value="${w.to}"></label>
      </div>
      <label class="field"><span class="field__label">Кого</span>
        <select class="input" id="cl-pid"><option value="">Всех</option>${people.map((p) => `<option value="${p.id}"${w.pid === p.id ? ' selected' : ''}>${esc(Tabel.shortName(p))}</option>`).join('')}</select></label>
      <div class="opts opts--one">
        <button class="opt${w.mode === 'restore' ? ' is-on' : ''}" data-mode="restore" type="button"><span>Вернуть по графику<br><span class="small muted fw-normal">убрать отметки, часы снова по графику</span></span></button>
        <button class="opt${w.mode === 'empty' ? ' is-on' : ''}" data-mode="empty" type="button"><span>Сделать клетки пустыми<br><span class="small muted fw-normal">без часов и отметок</span></span></button>
      </div>
      <p class="small ${n ? '' : 'muted'} mt-12">${n ? `Изменится клеток: <b>${n}</b>` : 'Нечего очищать в этом периоде'}</p>
      <div class="sheet__actions"><button class="btn" value="cancel">Отмена</button><button class="btn btn--primary" data-go type="button" ${n ? '' : 'disabled'}>Очистить</button></div>`, (b) => {
      b.onchange = (e) => {
        if (e.target.id === 'cl-from' && e.target.value) w.from = e.target.value;
        if (e.target.id === 'cl-to' && e.target.value) w.to = e.target.value;
        if (e.target.id === 'cl-pid') w.pid = e.target.value;
        if (w.from > w.to) [w.from, w.to] = [w.to, w.from];
        draw();
      };
      b.onclick = (e) => {
        const m = e.target.closest('[data-mode]')?.dataset.mode;
        if (m) { w.mode = m; draw(); return; }
        if (!e.target.closest('[data-go]')) return;
        const { n: count, who } = affected();
        const ids = new Set(who.map((p) => p.id));
        DB.update((d) => {
          if (w.mode === 'restore') {
            d.marks = d.marks.filter((mk) => !(ids.has(mk.pid) && mk.date >= w.from && mk.date <= w.to));
          } else {
            for (const p of who) for (let day = w.from; day <= w.to; day = Dates.add(day, 1)) Tabel.setMark(day, p.id, '');
          }
        });
        sheet.close();
        toast(`Очищено клеток: ${count}`);
      };
    });
  };
  draw();
}

// ================= Экран «Люди» =================
function renderPeople() {
  const el = $('#view-people');
  const all = DB.data.people;
  const active = all.filter((p) => !p.archived);
  const archived = all.filter((p) => p.archived);
  const row = (p, i, list) => `<div class="person">
      <button class="person__info link link--plain" data-edit="${p.id}" type="button">
        <span class="person__name">${esc(p.name)}</span><br><span class="person__sub">${esc(p.position || 'должность не указана')}</span></button>
      ${p.archived ? `<button class="btn" data-restore="${p.id}" type="button">Вернуть</button>`
        : `<span class="person__move"><button class="btn btn--icon" data-up="${p.id}" type="button" aria-label="Выше" ${i === 0 ? 'disabled' : ''}>${ICON.up}</button>
           <button class="btn btn--icon" data-down="${p.id}" type="button" aria-label="Ниже" ${i === list.length - 1 ? 'disabled' : ''}>${ICON.down}</button></span>`}
    </div>`;
  el.innerHTML = `
    <div class="summary"><span class="summary__main">${esc(DB.data.settings.shiftName)}: ${active.length} чел.</span></div>
    ${active.length ? `<div class="list">${active.map(row).join('')}</div>` : '<div class="card empty"><b>Список пуст</b>Добавьте людей или загрузите прошлый табель.</div>'}
    <div class="row mt-12">
      <button class="btn grow" data-act="add" type="button">${ICON.plus} Добавить</button>
      <button class="btn grow" data-act="import" type="button">${ICON.file} Из табеля Excel</button>
    </div>
    <p class="hint">Порядок здесь — порядок строк в табеле.</p>
    ${archived.length ? `<div class="list-head">Уволены / переведены</div><div class="list">${archived.map(row).join('')}</div>` : ''}`;
}

function movePerson(id, dir) {
  DB.update((d) => {
    const act = d.people.filter((p) => !p.archived);
    const i = act.findIndex((p) => p.id === id);
    const j = i + dir;
    if (i < 0 || j < 0 || j >= act.length) return;
    const a = d.people.indexOf(act[i]);
    const b = d.people.indexOf(act[j]);
    [d.people[a], d.people[b]] = [d.people[b], d.people[a]];
  });
}

function addPerson() { editPerson(null); }

function editPerson(id) {
  const p = id ? DB.data.people.find((x) => x.id === id) : null;
  const hasMarks = p && [...DB.data.marks, ...DB.data.stickers].some((m) => m.pid === p.id); // и стикеровка — история очереди
  openSheet(`<h3>${p ? 'Изменить' : 'Новый человек'}</h3>
    <label class="field"><span class="field__label">ФИО</span><input class="input" id="pp-name" value="${esc(p?.name || '')}" placeholder="Фамилия Имя Отчество" autocomplete="off"></label>
    <label class="field"><span class="field__label">Должность</span><input class="input" id="pp-pos" value="${esc(p?.position || '')}" placeholder="например, машинист экструдера" autocomplete="off" list="pp-positions"></label>
    <datalist id="pp-positions">${[...new Set(DB.data.people.map((x) => x.position).filter(Boolean))].map((x) => `<option value="${esc(x)}">`).join('')}</datalist>
    ${p && !p.archived ? `<button class="btn btn--danger btn--block" data-remove type="button">${hasMarks ? 'Убрать из смены (уволен, переведён)' : 'Удалить'}</button>
      ${hasMarks ? '<p class="small muted">Отметки прошлых месяцев сохранятся, в новых табелях строки не будет.</p>' : ''}` : ''}
    <div class="sheet__actions"><button class="btn" value="cancel">Отмена</button><button class="btn btn--primary" data-save type="button">Сохранить</button></div>`, (b) => {
    b.onclick = (e) => {
      if (e.target.closest('[data-save]')) {
        const name = $('#pp-name', b).value.trim().replace(/\s+/g, ' ');
        const position = $('#pp-pos', b).value.trim();
        if (!name) { toast('Введите ФИО'); return; }
        DB.update((d) => {
          if (p) { const x = d.people.find((y) => y.id === p.id); x.name = name; x.position = position; }
          else d.people.push({ id: uid(), name, position, archived: false });
        });
        sheet.close();
      } else if (e.target.closest('[data-remove]')) {
        if (!confirm(hasMarks ? `Убрать ${p.name} из смены?` : `Удалить ${p.name}?`)) return;
        DB.update((d) => {
          if (hasMarks) d.people.find((y) => y.id === p.id).archived = true;
          else d.people = d.people.filter((y) => y.id !== p.id);
        });
        sheet.close();
      }
    };
  });
  setTimeout(() => { if (!p) $('#pp-name')?.focus(); }, 50);
}

$('#view-people').addEventListener('click', (e) => {
  const t = e.target.closest('button');
  if (!t) return;
  if (t.dataset.act === 'add') addPerson();
  else if (t.dataset.act === 'import') $('#file-xlsx').click();
  else if (t.dataset.edit) editPerson(t.dataset.edit);
  else if (t.dataset.up) movePerson(t.dataset.up, -1);
  else if (t.dataset.down) movePerson(t.dataset.down, 1);
  else if (t.dataset.restore) DB.update((d) => { d.people.find((p) => p.id === t.dataset.restore).archived = false; });
});

// ================= Загрузка табеля Excel =================
$('#file-xlsx').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (file) importXlsx(file);
});

async function importXlsx(file, year) {
  let parsed;
  try { parsed = await Xlsx.parse(file, year); }
  catch (err) { toast(err.message || 'Не удалось прочитать файл'); return; }
  const s = DB.data.settings;
  const days = Dates.monthDays(parsed.ym);
  const differs = parsed.anchor && days.some((d) => Sched.type(d) !== Sched.type(d, { ...s, anchor: parsed.anchor }));
  const known = new Set(DB.data.people.map((p) => p.name.toLowerCase()));
  const fresh = parsed.people.filter((p) => !known.has(p.name.toLowerCase())).length;
  const existing = DB.data.marks.filter((m) => m.date.startsWith(parsed.ym)).length;
  const y = Number(parsed.ym.slice(0, 4));
  const sched = { ...s, anchor: differs ? parsed.anchor : s.anchor };
  const marks = parsed.people.reduce((n, p) => n + Object.entries(p.values).filter(([d, v]) => v !== (Sched.hours(d, sched) || '')).length, 0);

  openSheet(`<h3>Загрузка табеля</h3><p class="sheet__sub">${esc(file.name)}</p>
    <div class="row"><span class="grow"><b>${esc(Dates.MONTHS[Number(parsed.ym.slice(5)) - 1])}</b></span>
      <select class="input input--short" id="im-year">${[y - 1, y, y + 1].map((x) => `<option${x === y ? ' selected' : ''}>${x}</option>`).join('')}</select></div>
    <p class="small muted">Год в табеле не пишется — он взят из имени файла. Если неверно, выберите.</p>
    <ul>
      <li>Людей: ${parsed.people.length}${fresh ? ` (новых ${fresh})` : ''}</li>
      <li>Отметок (отличий от графика): ${marks}</li>
      <li>Примечаний: ${parsed.notes.length + parsed.free.length}</li>
    </ul>
    ${differs ? `<label class="check"><input type="checkbox" id="im-anchor" checked><span>График в табеле не совпадает с настройкой приложения — взять график из табеля (строка «Смена»).</span></label>` : ''}
    ${existing ? `<p class="small text-err">Отметки за этот месяц в приложении (${existing}) будут заменены данными из файла.</p>` : ''}
    <div class="sheet__actions"><button class="btn" value="cancel">Отмена</button><button class="btn btn--primary" data-go type="button">Загрузить</button></div>`, (b) => {
    $('#im-year', b).onchange = (ev) => importXlsx(file, Number(ev.target.value));
    b.onclick = (ev) => {
      if (!ev.target.closest('[data-go]')) return;
      Xlsx.apply(parsed, { updateAnchor: !!$('#im-anchor', b)?.checked });
      sheet.close();
      UI.month = parsed.ym;
      go('tabel');
      toast(`Загружено: ${Dates.monthTitle(parsed.ym)}`);
    };
  });
}

// ================= Экран «Настройки» =================
function renderMore() {
  const el = $('#view-more');
  const s = DB.data.settings;
  const od = Cloud.info();
  const st = DB.saveState;
  const fmt = (iso) => (iso ? new Date(iso).toLocaleString('ru-RU', { day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' }) : '—');

  let cloud;
  if (!od.available) {
    cloud = `<p class="small muted">Облако работает, когда приложение открыто с сайта (https). Сейчас данные хранятся только на этом устройстве.</p>`;
  } else if (od.connected) {
    const stText = { saved: 'всё сохранено в облаке', syncing: 'отправляю изменения…', offline: 'нет сети — изменения уйдут, когда она появится', cloudError: 'ошибка' }[st.state] || '';
    cloud = `<p>Вход: <b>${esc(od.account || 'выполнен')}</b></p>
      <p class="small muted">Сейчас: ${esc(stText)}${od.lastSync ? `<br>Последняя сверка: ${esc(fmt(od.lastSync))}` : ''}</p>
      ${od.error ? `<p class="small text-err">${esc(od.error)}</p>` : ''}
      ${od.isOwner ? '' : '<p class="small text-err">Это не аккаунт владельца табеля: автоотправка и напоминания по расписанию работают только с аккаунтом владельца.</p>'}
      <p class="small muted">ID аккаунта: <code>${esc(od.uid)}</code> <button class="link" data-act="copy-uid" type="button">копировать</button></p>
      <button class="btn btn--block" data-act="signout" type="button">Выйти</button>`;
  } else {
    cloud = `<p class="small muted">Табель хранится в облаке Firebase: не пропадёт при смене телефона, а табель 16-го и 1-го уйдёт в группу, даже если приложение не открывать. Войти нужно один раз.</p>
      ${od.error ? `<p class="small text-err">${esc(od.error)}</p>` : ''}
      <button class="btn btn--primary btn--block" data-act="signin" type="button">Войти через Google</button>
      <button class="link mt-8" data-act="signin-email" type="button">Войти по почте и паролю</button>`;
  }

  const next = Array.from({ length: 8 }, (_, i) => Dates.add(Dates.today(), i));
  el.innerHTML = `
    <div class="card"><h2>Облако</h2>${cloud}</div>

    <div class="card"><h2>Telegram</h2>${telegramCard()}</div>

    <div class="card"><h2>Почта</h2>${mailCard()}</div>

    <div class="card"><h2>Продукция смены</h2>${Production.settingsHtml()}</div>

    <div class="card"><h2>График смены</h2>
      <label class="field"><span class="field__label">Название</span><input class="input" id="st-name" value="${esc(s.shiftName)}"></label>
      <label class="field"><span class="field__label">Первый день цикла (первая дневная смена)</span><input class="input" id="st-anchor" type="date" value="${esc(s.anchor)}"></label>
      <label class="field"><span class="field__label">Цикл (Д — день, Н — ночь, В — выходной)</span><input class="input" id="st-cycle" value="${esc(s.cycle)}" autocomplete="off"></label>
      <div class="row">
        <label class="field grow"><span class="field__label">Часов днём</span><input class="input" id="st-day" type="number" inputmode="decimal" min="1" max="24" step="0.5" value="${s.dayHours}"></label>
        <label class="field grow"><span class="field__label">Часов ночью</span><input class="input" id="st-night" type="number" inputmode="decimal" min="1" max="24" step="0.5" value="${s.nightHours}"></label>
      </div>
      <div class="field__label">Ближайшие дни</div>
      <div class="row row--gap4">${next.map((d) => `<span class="badge badge--${Sched.type(d)} badge--cell">${Number(d.slice(8))}<br>${Sched.type(d)}</span>`).join('')}</div>
      <button class="btn btn--primary btn--block mt-14" data-act="settings" type="button">Сохранить график</button>
    </div>

    <div class="card"><h2>Данные</h2>
      <div class="row row--col">
        <button class="btn" data-act="import" type="button">${ICON.file} Загрузить табель Excel</button>
        <button class="btn" data-act="backup" type="button">Сохранить копию данных (.json)</button>
        <button class="btn" data-act="restore" type="button">Восстановить из копии</button>
      </div>
    </div>
    <p class="hint hint--center">Табель смены · версия ${APP_VERSION}</p>`;
}

// Запасной вход в облако — по почте и паролю (если вход через Google на телефоне не открывается).
function signInEmailSheet() {
  const w = { email: '', pass: '', create: false, busy: false, error: '' };
  const draw = () => openSheet(`<h3>Вход по почте</h3>
    <p class="sheet__sub">Любая ваша почта и пароль от 6 символов. В первый раз отметьте «Создать вход».</p>
    <label class="field"><span class="field__label">Почта</span><input class="input" id="em-email" type="email" autocomplete="username" value="${esc(w.email)}"></label>
    <label class="field"><span class="field__label">Пароль</span><input class="input" id="em-pass" type="password" autocomplete="${w.create ? 'new-password' : 'current-password'}" value="${esc(w.pass)}"></label>
    <label class="check"><input type="checkbox" id="em-create" ${w.create ? 'checked' : ''}><span>Создать вход (первый раз)</span></label>
    ${w.error ? `<p class="small text-err">${esc(w.error)}</p>` : ''}
    <div class="sheet__actions"><button class="btn" value="cancel">Отмена</button><button class="btn btn--primary" data-save type="button" ${w.busy ? 'disabled' : ''}>Войти</button></div>`, (b) => {
    b.oninput = (e) => {
      if (e.target.id === 'em-email') w.email = e.target.value.trim();
      if (e.target.id === 'em-pass') w.pass = e.target.value;
    };
    b.onchange = (e) => { if (e.target.id === 'em-create') { w.create = e.target.checked; draw(); } };
    b.onclick = async (e) => {
      if (!e.target.closest('[data-save]')) return;
      w.busy = true; w.error = ''; draw();
      try { await Cloud.signInEmail(w.email, w.pass, w.create); sheet.close(); toast('Вход выполнен'); return; }
      catch (err) { w.error = err.message; }
      w.busy = false; draw();
    };
  });
  draw();
}

// ---------- Почта ----------
// Письма отправляет только планировщик GitHub (remind/send.mjs): из браузера почту не отправить.
// Ящик-отправитель и его пароль приложения — в секретах GitHub (MAIL_USER, MAIL_PASS), здесь только получатели.
const mailList = (s) => String(s || '').split(/[\s,;]+/).filter(Boolean);
const mailOk = (a) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(a);

function mailCard() {
  const m = DB.data.settings.mail || {};
  return `<p class="small muted">16-го и 1-го в ${CONFIG.sendHour}:00 планировщик пришлёт на эти адреса письмо с табелем в Excel. Ящик, с которого уходят письма, настраивается в GitHub (секреты MAIL_USER и MAIL_PASS).</p>
    <label class="field"><span class="field__label">Кому (несколько адресов — через запятую)</span><input class="input" id="mail-to" type="email" multiple inputmode="email" autocomplete="off" placeholder="buh@example.com" value="${esc(mailList(m.to).join(', '))}"></label>
    <label class="field"><span class="field__label">Подпись в письме</span><input class="input" id="mail-sign" autocomplete="off" placeholder="И. И. Иванов, мастер смены" value="${esc(m.sign || '')}"></label>
    <label class="check"><input type="checkbox" id="mail-auto" ${m.auto !== false ? 'checked' : ''}><span>Отправлять автоматически 16-го и 1-го числа</span></label>
    <button class="btn btn--primary btn--block" data-act="mail-save" type="button">Сохранить</button>`;
}

// ---------- Telegram ----------
function telegramCard() {
  const tg = Telegram.cfg();
  if (!Telegram.ready()) {
    return `<p class="small muted">Бот сам отправит картинку и Excel в группу 16-го (табель на 16-е) и 1-го (итоговый за месяц) — при первом открытии приложения в эти дни.</p>
      <button class="btn btn--primary btn--block" data-act="tg-setup" type="button">Подключить Telegram</button>`;
  }
  const full = Telegram.fullReady();
  return `<p>${full ? 'Группа (только картинка табеля)' : 'Группа'}: <b>${esc(tg.chatTitle || tg.chatId)}</b>${tg.botName ? `<br><span class="small muted">Бот @${esc(tg.botName)}</span>` : ''}</p>
    <p>Полный табель (картинка, Excel, примечания): ${full ? `<b>${esc(tg.fullChatTitle || tg.fullChatId)}</b>` : '<span class="muted">не выбран — всё уходит в группу</span>'}</p>
    <button class="btn btn--block mb-8" data-act="tg-full" type="button">${full ? 'Сменить чат для полного табеля' : 'Выбрать чат для полного табеля'}</button>
    <label class="check"><input type="checkbox" id="tg-auto" ${tg.auto !== false ? 'checked' : ''}><span>Отправлять автоматически 16-го и 1-го числа</span></label>
    <button class="btn btn--block mb-8" data-act="tg-me" type="button">Уведомления мне${tg.meId ? " ✓" : ""}</button>
    <div class="row"><button class="btn grow" data-act="tg-test" type="button">Пробное сообщение</button>
      <button class="btn" data-act="tg-setup" type="button">Сменить</button>
      <button class="btn btn--danger" data-act="tg-off" type="button">Отключить</button></div>`;
}

// Второй чат — для полного табеля (картинка, Excel, примечания). Группе тогда уходит только картинка.
function telegramFull() {
  const tg = Telegram.cfg();
  const w = { chats: null, busy: false, error: '' };
  const draw = () => openSheet(`<h3>Чат для полного табеля</h3>
    <p class="sheet__sub">Сюда — картинка, Excel и примечания. В группу «${esc(tg.chatTitle || tg.chatId)}» — только картинка с подписью за какой месяц и период.</p>
    <ol class="small steps">
      <li>Если это другая группа — добавьте в неё бота${tg.botName ? ` <b>@${esc(tg.botName)}</b>` : ''}. Если ваш личный чат — напишите боту любое сообщение.</li>
      <li>Нажмите «Найти чаты» и выберите нужный.</li>
    </ol>
    <button class="btn btn--primary btn--block" data-find type="button" ${w.busy ? 'disabled' : ''}>Найти чаты</button>
    ${w.chats ? (w.chats.filter((c) => String(c.id) !== String(tg.chatId)).length
      ? `<div class="list mt-10">${w.chats.filter((c) => String(c.id) !== String(tg.chatId)).map((c) => `<button class="person" data-chat="${esc(c.id)}" type="button"><span class="person__info"><span class="person__name">${esc(c.title)}</span></span>${String(c.id) === String(tg.fullChatId) ? '<span class="small">выбран ✓</span>' : ''}</button>`).join('')}</div>`
      : '<p class="small text-err">Других чатов не нашёл. Напишите боту (или в группе с упоминанием бота) и нажмите ещё раз.</p>') : ''}
    ${w.error ? `<p class="small text-err">${esc(w.error)}</p>` : ''}
    ${tg.fullChatId ? '<button class="btn btn--danger btn--block mt-12" data-clear type="button">Не нужен — всё снова в группу</button>' : ''}
    <div class="sheet__actions"><button class="btn" value="cancel">Закрыть</button></div>`, (b) => {
    b.onclick = async (e) => {
      if (w.busy) return;
      if (e.target.closest('[data-clear]')) {
        DB.update((d) => { const t = { ...d.settings.telegram }; delete t.fullChatId; delete t.fullChatTitle; d.settings.telegram = t; });
        sheet.close();
        toast('Полный табель — снова в группу');
        return;
      }
      const id = e.target.closest('[data-chat]')?.dataset.chat;
      if (id) {
        const c = w.chats.find((x) => String(x.id) === id);
        DB.update((d) => { d.settings.telegram = { ...d.settings.telegram, fullChatId: c.id, fullChatTitle: c.title }; });
        w.busy = true;
        try {
          await Telegram.sendText('Сюда будет приходить полный табель: картинка, Excel и примечания.', 'fullChatId');
          sheet.close();
          toast(`Полный табель — в «${c.title}»`);
        } catch (err) { w.error = err.message; }
        w.busy = false;
        if (sheet.open) draw();
        return;
      }
      if (!e.target.closest('[data-find]')) return;
      w.busy = true; w.error = ''; draw();
      try { w.chats = await Telegram.findGroups(tg.token); } catch (err) { w.error = err.message; }
      w.busy = false; draw();
    };
  });
  draw();
}

// Мастер подключения: токен бота → проверка → поиск группы → выбор.
function telegramSetup() {
  const w = { token: Telegram.cfg().token || '', bot: null, groups: null, busy: false, error: '' };
  const draw = () => openSheet(`<h3>Подключить Telegram</h3>
    <p class="sheet__sub">Один раз, займёт пару минут.</p>
    <ol class="small steps">
      <li>В Telegram откройте <b>@BotFather</b>, отправьте <b>/newbot</b>, придумайте имя и адрес бота (на «bot» в конце).</li>
      <li>BotFather пришлёт токен — длинную строку вида <code>123456:ABC…</code>. Скопируйте её сюда.</li>
    </ol>
    <label class="field"><span class="field__label">Токен бота</span>
      <input class="input" id="tg-token" value="${esc(w.token)}" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="123456789:AA…"></label>
    ${w.bot ? `<p>Бот найден: <b>@${esc(w.bot.username)}</b></p>
      <ol class="small steps" start="3">
        <li>Добавьте бота в группу (в группе: участники → добавить → найдите @${esc(w.bot.username)}). Для пробы можно просто написать боту в личку — потом группу легко сменить.</li>
        <li>Нажмите «Найти группу».</li>
      </ol>
      <button class="btn btn--block" data-find type="button" ${w.busy ? 'disabled' : ''}>Найти группу или чат</button>` : `<button class="btn btn--primary btn--block" data-check type="button" ${w.busy ? 'disabled' : ''}>Проверить токен</button>`}
    ${w.groups ? (w.groups.length
      ? `<div class="list-head">Куда отправлять</div><div class="list">${w.groups.map((g) => `<button class="person" data-chat="${esc(g.id)}" type="button" ${w.busy ? 'disabled' : ''}><span class="person__info"><span class="person__name">${esc(g.title)}</span></span></button>`).join('')}</div>`
      : `<p class="small text-err">Чат не найден. Добавьте бота в группу или напишите ему в личку (если он уже в группе — напишите там сообщение с упоминанием @${esc(w.bot.username)}) и нажмите «Найти группу» ещё раз.</p>`) : ''}
    ${w.error ? `<p class="small text-err">${esc(w.error)}</p>` : ''}
    <div class="sheet__actions"><button class="btn" value="cancel">Закрыть</button></div>`, (b) => {
    b.oninput = (e) => { if (e.target.id === 'tg-token') { w.token = e.target.value.trim(); } };
    b.onclick = async (e) => {
      if (w.busy) return; // уже идёт запрос — повторное нажатие не отправляет второй раз
      const run = async (fn) => { w.busy = true; w.error = ''; draw(); try { await fn(); } catch (err) { w.error = err.message; } w.busy = false; draw(); };
      if (e.target.closest('[data-check]')) {
        run(async () => { w.bot = await Telegram.getMe(w.token); });
      } else if (e.target.closest('[data-find]')) {
        run(async () => { w.groups = await Telegram.findGroups(w.token); });
      } else {
        const id = e.target.closest('[data-chat]')?.dataset.chat;
        if (!id) return;
        const g = w.groups.find((x) => String(x.id) === id);
        w.busy = true;
        draw();
        DB.update((d) => {
          // Тот же бот (в т.ч. после «Отключить») — сохраняем личный чат и чат полного табеля;
          // новый бот: личный чат (id > 0) сразу годится и для личных уведомлений
          const old = d.settings.telegram || d.settings.telegramPrev || {};
          const same = old.token === w.token;
          const meId = same && old.meId ? old.meId : g.id > 0 ? g.id : undefined;
          const full = same && old.fullChatId ? { fullChatId: old.fullChatId, fullChatTitle: old.fullChatTitle } : {};
          d.settings.telegram = { token: w.token, botName: w.bot.username, chatId: g.id, chatTitle: g.title, auto: true, since: Dates.today(), ...(meId ? { meId } : {}), ...full };
          delete d.settings.telegramPrev;
        });
        try {
          await Telegram.sendText(`Бот подключён к табелю «${DB.data.settings.shiftName}». Сюда будут приходить табели 16-го и 1-го числа.`);
          sheet.close();
          toast(`Подключено: «${g.title}»`);
        } catch (err) { w.error = err.message; }
        w.busy = false;
        if (sheet.open) draw();
      }
    };
  });
  draw();
}

// Личный чат мастера с ботом: уведомления о заявлениях на будущие дни (приложение)
// и напоминания по расписанию (тот же номер — секрет TG_CHAT в GitHub).
function telegramMe() {
  const bot = Telegram.cfg().botName;
  const w = { chats: null, error: '', busy: false };
  const draw = () => {
    const me = Telegram.cfg().meId;
    openSheet(`<h3>Уведомления мне</h3>
    <p class="sheet__sub">Бот будет писать вам лично: кого не будет в будущие дни (заявления, отпуск, больничный), а также напоминания о сменах.</p>
    <ol class="small steps">
      <li>Откройте в Telegram чат с ботом${bot ? ` <b>@${esc(bot)}</b>` : ''} и нажмите <b>«Старт»</b> (или отправьте ему любое сообщение).</li>
      <li>Нажмите «Найти мой чат» и выберите его.</li>
    </ol>
    <button class="btn btn--primary btn--block" data-find type="button" ${w.busy ? 'disabled' : ''}>Найти мой чат</button>
    ${w.chats ? (w.chats.length ? w.chats.map((c) => `<div class="card mt-10">
        <div>${esc(c.title)}${String(me) === String(c.id) ? ' · <b>выбран ✓</b>' : ''}</div>
        <div class="small muted">Номер для GitHub (TG_CHAT): <b>${esc(c.id)}</b></div>
        <div class="row mt-8">
          ${String(me) === String(c.id) ? '' : `<button class="btn btn--primary grow" data-pick="${esc(c.id)}" type="button">Присылать сюда</button>`}
          <button class="btn grow" data-copy="${esc(c.id)}" type="button">Копировать номер</button></div></div>`).join('')
      : '<p class="small text-err">Не нашёл. Напишите боту любое сообщение и нажмите ещё раз.</p>') : ''}
    ${w.error ? `<p class="small text-err">${esc(w.error)}</p>` : ''}
    <div class="sheet__actions"><button class="btn" value="cancel">Закрыть</button></div>`, (b) => {
      b.onclick = async (e) => {
        if (w.busy) return;
        const copy = e.target.closest('[data-copy]')?.dataset.copy;
        if (copy) {
          try { await navigator.clipboard.writeText(copy); toast('Скопировано'); } catch { toast(copy); }
          return;
        }
        const pick = e.target.closest('[data-pick]')?.dataset.pick;
        if (pick) {
          DB.update((d) => { d.settings.telegram = { ...d.settings.telegram, meId: Number(pick) }; });
          w.busy = true;
          try {
            await Telegram.sendMe('Сюда буду присылать, кого не будет в ближайшие дни, и напоминания о сменах.');
            toast('Готово: уведомления — вам лично');
          } catch (err) { w.error = err.message; }
          w.busy = false;
          draw();
          return;
        }
        if (!e.target.closest('[data-find]')) return;
        w.busy = true; w.error = ''; draw();
        try { w.chats = await Telegram.findPrivate(); } catch (err) { w.error = err.message; }
        w.busy = false; draw();
      };
    });
  };
  draw();
}

$('#view-more').addEventListener('change', (e) => {
  if (e.target.id === 'tg-auto') DB.update((d) => { d.settings.telegram = { ...d.settings.telegram, auto: e.target.checked }; });
  if (e.target.id === 'mail-auto') DB.update((d) => { d.settings.mail = { ...d.settings.mail, auto: e.target.checked }; });
});

$('#view-more').addEventListener('click', async (e) => {
  const act = e.target.closest('[data-act]')?.dataset.act;
  if (act === 'tg-setup') telegramSetup();
  else if (act === 'tg-full') telegramFull();
  else if (act === 'tg-me') telegramMe();
  else if (act === 'tg-test') {
    const btn = e.target.closest('[data-act]');
    if (btn.disabled) return;
    btn.disabled = true; // не отправлять дважды при двойном нажатии
    try { await Telegram.sendText('Проверка связи: табель смены на месте.'); toast('Отправлено'); } catch (err) { toast(err.message); }
    btn.disabled = false;
  } else if (act === 'tg-off') {
    if (confirm('Отключить отправку в Telegram?')) DB.update((d) => { d.settings.telegramPrev = d.settings.telegram; delete d.settings.telegram; }); // прежние чаты вернутся при подключении того же бота
  }
  else if (act === 'mail-save') {
    const to = mailList($('#mail-to').value);
    const bad = to.filter((a) => !mailOk(a));
    if (bad.length) return toast(`Проверьте адрес: ${bad[0]}`);
    const sign = $('#mail-sign').value.trim();
    DB.update((d) => { d.settings.mail = { ...d.settings.mail, to: to.join(', '), sign }; });
    toast(to.length ? `Сохранено адресов: ${to.length}` : 'Адреса очищены — письма не отправляются');
  }
  if (act === 'prod-save') {
    const list = [...new Set($('#prod-list').value.split('\n').map((x) => x.trim()).filter(Boolean))];
    Production.saveProducts(list)
      .then(() => toast(list.length ? `Сохранено видов: ${list.length}` : 'Список очищен — работники вводят вид текстом'))
      .catch((e) => toast(e.message || 'Не сохранилось'));
  }
  if (act === 'signin') Cloud.signInGoogle();
  else if (act === 'signin-email') signInEmailSheet();
  else if (act === 'copy-uid') {
    const uid = Cloud.info().uid;
    try { await navigator.clipboard.writeText(uid); toast('ID скопирован'); } catch { toast(uid); }
  }
  else if (act === 'signout') { if (confirm('Выйти из облака? Данные останутся на телефоне, но перестанут сохраняться в облако.')) Cloud.signOut(); }
  else if (act === 'import') $('#file-xlsx').click();
  else if (act === 'backup') DB.exportFile();
  else if (act === 'restore') $('#file-json').click();
  else if (act === 'settings') {
    const name = $('#st-name').value.trim() || 'Смена';
    const anchor = $('#st-anchor').value;
    const cycle = $('#st-cycle').value.trim().toUpperCase().replace(/\s+/g, '');
    const day = parseFloat($('#st-day').value);
    const night = parseFloat($('#st-night').value);
    if (!anchor) { toast('Укажите первый день цикла'); return; }
    if (!/^[ДНВ]+$/.test(cycle)) { toast('Цикл — только буквы Д, Н, В'); return; }
    if (!(day > 0 && day <= 24 && night > 0 && night <= 24)) { toast('Часы — от 1 до 24'); return; }
    DB.update((d) => { d.settings = { ...d.settings, shiftName: name, anchor, cycle, dayHours: day, nightHours: night }; });
    toast('График сохранён');
  }
});

$('#file-json').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  try {
    const data = await DB.readFile(file);
    if (!confirm('Заменить все данные приложения содержимым копии?')) return;
    DB.replace(data);
    toast('Данные восстановлены');
  } catch (err) { toast(err.message); }
});

// ================= Навигация и индикатор =================
// Та же версия, что в index.html (meta app-version) и sw.js — её поднимает tools/bump.sh
const APP_VERSION = document.querySelector('meta[name="app-version"]')?.content || '?';

const VIEW_ORDER = ['shift', 'tabel', 'people', 'more'];

function go(view) {
  const dir = Math.sign(VIEW_ORDER.indexOf(view) - VIEW_ORDER.indexOf(UI.view));
  UI.view = view;
  store.set('ts.view', view);
  render();
  window.scrollTo(0, 0);
  if (dir) {
    const el = $(`#view-${view}`);
    el.classList.remove('is-enter-next', 'is-enter-prev');
    void el.offsetWidth;
    el.classList.add(dir > 0 ? 'is-enter-next' : 'is-enter-prev');
  }
}

function render() {
  for (const v of ['shift', 'tabel', 'people', 'more']) $(`#view-${v}`).hidden = v !== UI.view;
  document.querySelectorAll('.nav__btn').forEach((b) => {
    const on = b.dataset.view === UI.view;
    b.classList.toggle('is-active', on);
    if (on) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current');
  });
  // Шапка (смена + облако) — везде, кроме «Настроек»
  $('#top').hidden = UI.view === 'more';
  document.body.classList.toggle('no-top', UI.view === 'more');
  ({ shift: renderShift, tabel: renderTabel, people: renderPeople, more: renderMore })[UI.view]();
  renderShiftbar();
  renderSync();
}

function renderSync() {
  const st = DB.saveState;
  const text = {
    saved: st.cloud ? 'В облаке' : 'На телефоне', local: 'На телефоне', auth: 'Войти', syncing: 'Сохраняю…',
    offline: 'Нет сети', cloudError: 'Ошибка', error: 'Ошибка памяти',
  }[st.state] || '';
  $('#sync').dataset.state = st.state;
  $('#sync-text').textContent = text;
  $('#sync').setAttribute('aria-label', `Облако: ${text || 'состояние неизвестно'}. Открыть настройки`);
}

$('#nav').addEventListener('click', (e) => {
  const b = e.target.closest('[data-view]');
  if (b) go(b.dataset.view);
});
$('#sync').addEventListener('click', () => go('more'));

// Свайп влево/вправо по экрану — соседняя вкладка (порядок как в нижнем меню).
// Не срабатывает на таблице табеля (она листается вбок), в полях ввода, при открытом окне и при вертикальной прокрутке.
{
  let sw = null;
  const blocked = (t) => !!t.closest('.tabel-wrap, input, textarea, select, dialog, .toast, [data-noswipe]');
  document.addEventListener('touchstart', (e) => {
    sw = e.touches.length === 1 && !$('#sheet').open && !blocked(e.target)
      ? { x: e.touches[0].clientX, y: e.touches[0].clientY, t: Date.now() } : null;
  }, { passive: true });
  document.addEventListener('touchmove', (e) => { if (sw && e.touches.length > 1) sw = null; }, { passive: true });
  document.addEventListener('touchend', (e) => {
    const s = sw; sw = null;
    if (!s || $('#sheet').open) return;
    const dx = e.changedTouches[0].clientX - s.x, dy = e.changedTouches[0].clientY - s.y;
    if (Math.abs(dx) < 70 || Math.abs(dy) > Math.abs(dx) * 0.6 || Date.now() - s.t > 700) return;
    const i = VIEW_ORDER.indexOf(UI.view) + (dx < 0 ? 1 : -1);
    if (i >= 0 && i < VIEW_ORDER.length) go(VIEW_ORDER[i]);
  }, { passive: true });
}

DB.onChange(() => render());
Cloud.onChange(() => { renderSync(); if (UI.view === 'more') renderMore(); Reports.tick(); });

// Новая смена — переключиться на неё, если пользователь не листал даты.
// Перерисовать и просто так: в 7:30 и 19:30 у смены появляются часы по графику.
let lastShift = Sched.current();
document.addEventListener('visibilitychange', () => {
  if (document.hidden) return;
  const c = Sched.current();
  if (c !== lastShift) { if (UI.date === lastShift) UI.date = c; lastShift = c; }
  render();
});

// Ссылка на конкретный день: …/#d=2026-09-18
const hashDate = location.hash.match(/^#d=(\d{4}-\d{2}-\d{2})$/)?.[1];
if (hashDate) { UI.date = hashDate; UI.month = Dates.ym(hashDate); }

render();
Cloud.init();
Reports.tick();

if ('serviceWorker' in navigator && location.protocol === 'https:') {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}

// Запуск дошёл до конца — index.html не покажет «Приложение не загрузилось».
window.appStarted = true;
