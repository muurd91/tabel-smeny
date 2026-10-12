// ================= Интерфейс =================
// Четыре экрана: «Смена» (отметить, кто не вышел, на выбранную дату), «Табель» (месяц целиком,
// выгрузка в Excel), «Люди» (состав смены), «Ещё» (OneDrive, график, копии данных).

const $ = (sel, root = document) => root.querySelector(sel);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch {} },
};

const UI = {
  view: store.get('ts.view') || 'shift',
  date: Dates.today(),
  month: Dates.ym(Dates.today()),
};

const ICON = {
  left: '<svg viewBox="0 0 24 24"><path d="m15 18-6-6 6-6"/></svg>',
  right: '<svg viewBox="0 0 24 24"><path d="m9 18 6-6-6-6"/></svg>',
  up: '<svg viewBox="0 0 24 24"><path d="m18 15-6-6-6 6"/></svg>',
  down: '<svg viewBox="0 0 24 24"><path d="m6 9 6 6 6-6"/></svg>',
  plus: '<svg viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg>',
  file: '<svg viewBox="0 0 24 24"><path d="M14 3H6a1 1 0 0 0-1 1v16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8Zm0 0v5h5M9 13l6 5m0-5-6 5"/></svg>',
  share: '<svg viewBox="0 0 24 24"><path d="M12 15V3m0 0L8 7m4-4 4 4M5 12v7a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-7"/></svg>',
  x: '<svg viewBox="0 0 24 24"><path d="M18 6 6 18M6 6l12 12"/></svg>',
  trash: '<svg viewBox="0 0 24 24"><path d="M4 7h16M10 11v6M14 11v6M5 7l1 13h12l1-13M9 7V4h6v3"/></svg>',
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
  return t === 'Д' ? `Дневная · ${s.dayHours} ч` : t === 'Н' ? `Ночная · ${s.nightHours} ч` : 'Выходной у смены';
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
  const thisYear = d.slice(0, 4) === Dates.today().slice(0, 4);

  let html = `
    <div class="datebar">
      <button class="btn btn--icon" data-act="prev" type="button" aria-label="Предыдущий день">${ICON.left}</button>
      <label class="datebar__mid">
        <span class="datebar__date">${esc(dateTitle(d, !thisYear))}</span>
        <span class="badge badge--${t}">${esc(typeLabel(t))}</span>
        <input class="datebar__input" type="date" id="shift-date" value="${d}" aria-label="Выбрать дату">
      </label>
      <button class="btn btn--icon" data-act="next" type="button" aria-label="Следующий день">${ICON.right}</button>
    </div>`;
  if (d !== Dates.today()) html += `<div class="row row--end" style="margin:-6px 2px 8px"><button class="link" data-act="today" type="button">Сегодня</button></div>`;
  html += Reports.banner();

  if (!people.length) {
    html += `<div class="card empty"><b>Пока никого нет</b>Загрузите прошлый табель — подтянутся люди и отметки.
      <div class="row" style="justify-content:center;margin-top:14px">
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
  if (t !== 'В' && d > Dates.today()) {
    html += `<div class="summary"><span class="summary__main">День ещё не наступил</span>
      <span class="muted small">часы по графику появятся в этот день; заранее можно отметить больничный или отпуск</span></div>`;
  } else if (t !== 'В') {
    const present = vals.filter((v) => typeof v === 'number' && v > 0).length;
    html += `<div class="summary"><span class="summary__main">На смене ${present} из ${people.length}</span>
      <span class="muted small">остальным стоит ${Sched.hoursOf(t)} ч по графику</span></div>`;
  }
  html += quickForm(d, t, people, map);

  if (marked.length) {
    html += `<div class="list-head">${t === 'В' ? 'Вышли сверх графика' : 'Отмечены'}</div>
      <div class="list">${marked.map((p) => `<div class="marked">${row(p)}<button class="btn btn--icon marked__x" data-clear="${p.id}" type="button" aria-label="Снять отметку">${ICON.x}</button></div>`).join('')}</div>`;
  } else if (t !== 'В' && d <= Dates.today()) {
    html += `<p class="hint">Отсутствующих нет — все на смене.</p>`;
  }
  html += `<details class="all"${UI.showAll ? ' open' : ''}><summary>Все работники (${people.length})</summary>
    <div class="list">${people.map(row).join('')}</div></details>`;
  el.innerHTML = html;
}

// ---------- Быстрая отметка: работник + причина ----------
// Состояние формы живёт между перерисовками (данные могут обновиться из OneDrive).
UI.qf = {};
UI.showAll = false;

function quickReasons(t) {
  const s = DB.data.settings;
  if (t === 'В') {
    return [
      { k: 'day', label: `В день · ${s.dayHours} ч`, v: s.dayHours },
      { k: 'night', label: `В ночь · ${s.nightHours} ч`, v: s.nightHours },
      { k: 'part', label: 'Другое число часов', v: 'part' },
    ];
  }
  return [
    { k: 'sick', label: 'Больничный', v: 'Б' },
    { k: 'vac', label: 'Отпуск', v: 'ОТ' },
    { k: 'own', label: 'За свой счёт', v: '-', reason: 'заявление за свой счёт' },
    { k: 'truancy', label: 'Прогул', v: '-', reason: 'прогул' },
    { k: 'part', label: 'Неполная смена', v: 'part' },
    { k: 'other', label: 'Другое', v: '-' },
  ];
}

const quickDefHours = (t) => (t === 'В' ? DB.data.settings.dayHours : Math.max(Sched.hoursOf(t) - 2, 1));

function quickForm(d, t, people, map) {
  const q = UI.qf;
  const reasons = quickReasons(t);
  const r = reasons.find((x) => x.k === q.reason);
  const status = (p) => {
    if (!map.has(Tabel.markId(d, p.id))) return '';
    const v = Tabel.cell(p.id, d, map);
    const k = kindOf(v, d);
    return k === t || k === 'off' ? '' : ` — сейчас: ${valText(v)}`;
  };
  let extra = '';
  if (r?.v === 'part') {
    extra = `<div class="row" style="margin-top:10px;align-items:flex-end">
        <label class="field" style="margin:0"><span class="field__label">Отработал часов</span>
          <input class="input input--short" id="qf-hours" type="number" inputmode="decimal" min="0" max="24" step="0.5" value="${esc(q.hours ?? quickDefHours(t))}"></label>
        ${t !== 'В' ? `<label class="field grow" style="margin:0"><span class="field__label">Причина (в примечание)</span>
          <input class="input" id="qf-text" value="${esc(q.text || '')}" placeholder="например, заявление" autocomplete="off"></label>` : ''}
      </div>`;
  } else if (r?.k === 'other') {
    extra = `<label class="field"><span class="field__label">Причина (в примечание)</span>
      <input class="input" id="qf-text" value="${esc(q.text || '')}" placeholder="что случилось" autocomplete="off"></label>`;
  } else if (r?.v === 'Б' || r?.v === 'ОТ') {
    extra = `<label class="field"><span class="field__label">По какое число (если известно)</span>
      <input class="input" id="qf-until" type="date" min="${d}" value="${esc(q.until || d)}"></label>`;
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
    <div class="chips chips--grid">${reasons.map((x) => `<button class="chip${q.reason === x.k ? ' is-on' : ''}" data-qr="${x.k}" type="button">${esc(x.label)}</button>`).join('')}</div>
    ${extra}
    <button class="btn btn--primary btn--block" style="margin-top:12px" data-act="qf-save" type="button" ${ready ? '' : 'disabled'}>Отметить</button>
  </div>`;
}

// Отметка на дату; Б и ОТ — сразу на все смены по графику до until включительно.
function applyMark(pid, date, v, reason = '', until = date) {
  DB.update(() => {
    if ((v === 'Б' || v === 'ОТ') && until > date) {
      for (let d = date; d <= until; d = Dates.add(d, 1)) {
        if (d === date || Sched.type(d) !== 'В') Tabel.setMark(d, pid, v);
      }
    } else Tabel.setMark(date, pid, v, reason);
  });
}

function saveQuick() {
  const q = UI.qf;
  const d = UI.date;
  const t = Sched.type(d);
  const r = quickReasons(t).find((x) => x.k === q.reason);
  const p = DB.data.people.find((x) => x.id === q.pid);
  if (!r || !p) return;
  let v = r.v;
  let reason = r.reason || '';
  if (v === 'part') {
    v = parseFloat(String(q.hours ?? quickDefHours(t)).replace(',', '.'));
    if (!Number.isFinite(v) || v < 0 || v > 24) { toast('Укажите часы от 0 до 24'); return; }
  }
  if (r.k === 'part' || r.k === 'other') reason = (q.text || '').trim();
  const until = (v === 'Б' || v === 'ОТ') && q.until > d ? q.until : d;
  UI.qf = {};
  applyMark(p.id, d, v, reason, until);
  toast(`${Tabel.surname(p)}: ${r.label.toLowerCase()}${until > d ? ` по ${Dates.dm(until)}` : ''}`);
}

$('#view-shift').addEventListener('click', (e) => {
  const act = e.target.closest('[data-act]')?.dataset.act;
  if (act === 'prev') { UI.date = Dates.add(UI.date, -1); UI.qf.reason = ''; render(); return; }
  if (act === 'next') { UI.date = Dates.add(UI.date, 1); UI.qf.reason = ''; render(); return; }
  if (act === 'today') { UI.date = Dates.today(); render(); return; }
  if (act === 'import') { $('#file-xlsx').click(); return; }
  if (act === 'people') { go('people'); addPerson(); return; }
  if (act === 'qf-save') { saveQuick(); return; }
  const qr = e.target.closest('[data-qr]')?.dataset.qr;
  if (qr) { UI.qf.reason = qr; UI.qf.text = ''; UI.qf.hours = undefined; render(); return; }
  const clear = e.target.closest('[data-clear]')?.dataset.clear;
  if (clear) {
    const p = DB.data.people.find((x) => x.id === clear);
    DB.update(() => Tabel.setMark(UI.date, clear, Tabel.def(UI.date)));
    toast(`${Tabel.surname(p)}: ${Sched.type(UI.date) === 'В' ? 'выход снят' : 'на смене по графику'}`);
    return;
  }
  const pid = e.target.closest('[data-pid]')?.dataset.pid;
  if (pid) { openEditor(pid, UI.date); return; }
  // Открыть календарь по нажатию на дату (там, где браузер это умеет)
  const input = e.target.closest('.datebar__mid')?.querySelector('input');
  try { input?.showPicker?.(); } catch {}
});
$('#view-shift').addEventListener('change', (e) => {
  if (e.target.id === 'shift-date' && e.target.value) { UI.date = e.target.value; UI.qf.reason = ''; render(); }
  else if (e.target.id === 'qf-person') { UI.qf.pid = e.target.value; render(); }
});
$('#view-shift').addEventListener('input', (e) => {
  if (e.target.id === 'qf-hours') UI.qf.hours = e.target.value;
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
      ${mark ? `<button class="btn btn--block" style="margin-top:12px" data-reset type="button">Вернуть по графику${Tabel.def(date) ? ` (${Tabel.def(date)} ч)` : ' (пусто, день не наступил)'}</button>` : ''}
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
    applyMark(pid, date, v, why, (sel === 'Б' || sel === 'ОТ') ? until : date);
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
  const types = days.map((d) => Sched.type(d));
  const canShare = !!(navigator.canShare && window.File);

  let html = `${Reports.banner()}
    <div class="monthbar">
      <button class="btn btn--icon" data-act="prev" type="button" aria-label="Предыдущий месяц">${ICON.left}</button>
      <div class="monthbar__title">${esc(Dates.monthTitle(ym))}</div>
      <button class="btn btn--icon" data-act="next" type="button" aria-label="Следующий месяц">${ICON.right}</button>
    </div>
    <div class="row" style="margin-bottom:12px">
      <button class="btn btn--primary grow" data-act="xlsx" type="button">${ICON.file} Скачать Excel</button>
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
    <div class="legend">
      <span><i style="background:var(--day)"></i>день</span><span><i style="background:var(--night)"></i>ночь</span>
      <span style="color:var(--sick)">Б — больничный</span><span style="color:var(--vac)">ОТ — отпуск</span>
      <span style="color:var(--absent)">− отсутствие</span><span><i style="background:var(--part-soft)"></i>неполная</span>
      <span><i style="background:var(--extra-soft)"></i>сверх графика</span>
    </div>`;

  const notes = Tabel.notesOf(ym);
  html += `<div class="card"><h2>Примечания</h2>
    <p class="small muted">Строки под табелем. Причины из отметок попадают сюда сами.</p>
    <ul class="notes">${notes.map((n) => `<li><span class="grow">${esc(n.text)}</span>${n.id ? `<button class="btn btn--icon" data-del-note="${n.id}" type="button" aria-label="Удалить">${ICON.x}</button>` : '<span class="tag">по отметке</span>'}</li>`).join('') || '<li class="muted">Пока нет</li>'}</ul>
    <div class="row" style="margin-top:10px"><input class="input grow" id="note-text" placeholder="Своё примечание" autocomplete="off" style="flex:1;width:auto">
      <button class="btn" data-act="note" type="button">Добавить</button></div></div>`;

  el.innerHTML = html;
  // Прокрутить к сегодняшнему дню
  const wrap = $('.tabel-wrap', el);
  const th = $('.is-today', el);
  if (th) wrap.scrollLeft = Math.max(0, th.offsetLeft - 112 - wrap.clientWidth / 3);
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
      <div class="row" style="flex-direction:column;align-items:stretch">
        <button class="btn btn--primary" data-tg type="button">В группу «${esc(Telegram.cfg().chatTitle || 'Telegram')}»</button>
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
        <label class="field grow" style="margin:4px 0"><span class="field__label">С</span><input class="input" id="cl-from" type="date" min="${days[0]}" max="${days.at(-1)}" value="${w.from}"></label>
        <label class="field grow" style="margin:4px 0"><span class="field__label">По</span><input class="input" id="cl-to" type="date" min="${days[0]}" max="${days.at(-1)}" value="${w.to}"></label>
      </div>
      <label class="field"><span class="field__label">Кого</span>
        <select class="input" id="cl-pid"><option value="">Всех</option>${people.map((p) => `<option value="${p.id}"${w.pid === p.id ? ' selected' : ''}>${esc(Tabel.shortName(p))}</option>`).join('')}</select></label>
      <div class="opts" style="grid-template-columns:1fr">
        <button class="opt${w.mode === 'restore' ? ' is-on' : ''}" data-mode="restore" type="button"><span>Вернуть по графику<br><span class="small muted" style="font-weight:400">убрать отметки, часы снова по графику</span></span></button>
        <button class="opt${w.mode === 'empty' ? ' is-on' : ''}" data-mode="empty" type="button"><span>Сделать клетки пустыми<br><span class="small muted" style="font-weight:400">без часов и отметок</span></span></button>
      </div>
      <p class="small ${n ? '' : 'muted'}" style="margin:12px 0 0">${n ? `Изменится клеток: <b>${n}</b>` : 'Нечего очищать в этом периоде'}</p>
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
      <button class="person__info link" style="text-decoration:none;text-align:left" data-edit="${p.id}" type="button">
        <span class="person__name">${esc(p.name)}</span><br><span class="person__sub">${esc(p.position || 'должность не указана')}</span></button>
      ${p.archived ? `<button class="btn" data-restore="${p.id}" type="button">Вернуть</button>`
        : `<span class="person__move"><button class="btn btn--icon" data-up="${p.id}" type="button" aria-label="Выше" ${i === 0 ? 'disabled' : ''}>${ICON.up}</button>
           <button class="btn btn--icon" data-down="${p.id}" type="button" aria-label="Ниже" ${i === list.length - 1 ? 'disabled' : ''}>${ICON.down}</button></span>`}
    </div>`;
  el.innerHTML = `
    <div class="summary"><span class="summary__main">${esc(DB.data.settings.shiftName)}: ${active.length} чел.</span></div>
    ${active.length ? `<div class="list">${active.map(row).join('')}</div>` : '<div class="card empty"><b>Список пуст</b>Добавьте людей или загрузите прошлый табель.</div>'}
    <div class="row" style="margin-top:12px">
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
  const hasMarks = p && DB.data.marks.some((m) => m.pid === p.id);
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
    ${existing ? `<p class="small" style="color:var(--absent)">Отметки за этот месяц в приложении (${existing}) будут заменены данными из файла.</p>` : ''}
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

// ================= Экран «Ещё» =================
function renderMore() {
  const el = $('#view-more');
  const s = DB.data.settings;
  const od = OneDrive.info();
  const fmt = (iso) => (iso ? new Date(iso).toLocaleString('ru-RU', { day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' }) : '—');

  let cloud;
  if (!od.available) {
    cloud = `<p class="small muted">Синхронизация работает, когда приложение открыто с сайта (https). Сейчас данные хранятся только на этом устройстве.</p>`;
  } else if (od.connected) {
    cloud = `<p>Вход: <b>${esc(od.account || 'выполнен')}</b></p>
      <p class="small muted">Файл: OneDrive / ${esc(od.path)}<br>Последняя синхронизация: ${esc(fmt(od.lastSync))}${od.pending ? `<br>Ждут отправки: ${od.pending}` : ''}</p>
      ${od.error ? `<p class="small" style="color:var(--err)">${esc(od.error)}</p>` : ''}
      <div class="row"><button class="btn grow" data-act="sync" type="button">Синхронизировать</button><button class="btn" data-act="signout" type="button">Отключить</button></div>`;
  } else {
    cloud = `<p class="small muted">${od.needAuth ? 'Вход истёк — войдите снова, изменения сохранены на телефоне и уйдут после входа.' : 'Табель хранится в вашем OneDrive: не пропадёт при смене телефона, его видно с компьютера.'}</p>
      ${od.error ? `<p class="small" style="color:var(--err)">${esc(od.error)}</p>` : ''}
      <button class="btn btn--primary btn--block" data-act="signin" type="button">Войти в OneDrive</button>`;
  }

  const next = Array.from({ length: 8 }, (_, i) => Dates.add(Dates.today(), i));
  el.innerHTML = `
    <div class="card"><h2>OneDrive</h2>${cloud}</div>

    <div class="card"><h2>Telegram</h2>${telegramCard()}</div>

    <div class="card"><h2>График смены</h2>
      <label class="field"><span class="field__label">Название</span><input class="input" id="st-name" value="${esc(s.shiftName)}"></label>
      <label class="field"><span class="field__label">Первый день цикла (первая дневная смена)</span><input class="input" id="st-anchor" type="date" value="${esc(s.anchor)}"></label>
      <label class="field"><span class="field__label">Цикл (Д — день, Н — ночь, В — выходной)</span><input class="input" id="st-cycle" value="${esc(s.cycle)}" autocomplete="off"></label>
      <div class="row">
        <label class="field grow"><span class="field__label">Часов днём</span><input class="input" id="st-day" type="number" inputmode="decimal" min="1" max="24" step="0.5" value="${s.dayHours}"></label>
        <label class="field grow"><span class="field__label">Часов ночью</span><input class="input" id="st-night" type="number" inputmode="decimal" min="1" max="24" step="0.5" value="${s.nightHours}"></label>
      </div>
      <div class="field__label">Ближайшие дни</div>
      <div class="row" style="gap:4px">${next.map((d) => `<span class="badge badge--${Sched.type(d)}" style="margin:0;min-width:34px;text-align:center">${Number(d.slice(8))}<br>${Sched.type(d)}</span>`).join('')}</div>
      <button class="btn btn--primary btn--block" style="margin-top:14px" data-act="settings" type="button">Сохранить график</button>
    </div>

    <div class="card"><h2>Данные</h2>
      <div class="row" style="flex-direction:column;align-items:stretch">
        <button class="btn" data-act="import" type="button">${ICON.file} Загрузить табель Excel</button>
        <button class="btn" data-act="backup" type="button">Сохранить копию данных (.json)</button>
        <button class="btn" data-act="restore" type="button">Восстановить из копии</button>
      </div>
    </div>
    <p class="hint" style="text-align:center">Табель смены · версия ${APP_VERSION}</p>`;
}

// ---------- Telegram ----------
function telegramCard() {
  const tg = Telegram.cfg();
  if (!Telegram.ready()) {
    return `<p class="small muted">Бот сам отправит картинку и Excel в группу 16-го (табель на 16-е) и 1-го (итоговый за месяц) — при первом открытии приложения в эти дни.</p>
      <button class="btn btn--primary btn--block" data-act="tg-setup" type="button">Подключить Telegram</button>`;
  }
  return `<p>Группа: <b>${esc(tg.chatTitle || tg.chatId)}</b>${tg.botName ? `<br><span class="small muted">Бот @${esc(tg.botName)}</span>` : ''}</p>
    <label class="check"><input type="checkbox" id="tg-auto" ${tg.auto !== false ? 'checked' : ''}><span>Отправлять автоматически 16-го и 1-го числа</span></label>
    <button class="btn btn--block" style="margin-bottom:8px" data-act="tg-me" type="button">Напоминания мне</button>
    <div class="row"><button class="btn grow" data-act="tg-test" type="button">Пробное сообщение</button>
      <button class="btn" data-act="tg-setup" type="button">Сменить</button>
      <button class="btn btn--danger" data-act="tg-off" type="button">Отключить</button></div>`;
}

// Мастер подключения: токен бота → проверка → поиск группы → выбор.
function telegramSetup() {
  const w = { token: Telegram.cfg().token || '', bot: null, groups: null, busy: false, error: '' };
  const draw = () => openSheet(`<h3>Подключить Telegram</h3>
    <p class="sheet__sub">Один раз, займёт пару минут.</p>
    <ol class="small" style="padding-left:20px;margin:0 0 8px">
      <li>В Telegram откройте <b>@BotFather</b>, отправьте <b>/newbot</b>, придумайте имя и адрес бота (на «bot» в конце).</li>
      <li>BotFather пришлёт токен — длинную строку вида <code>123456:ABC…</code>. Скопируйте её сюда.</li>
    </ol>
    <label class="field"><span class="field__label">Токен бота</span>
      <input class="input" id="tg-token" value="${esc(w.token)}" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="123456789:AA…"></label>
    ${w.bot ? `<p>Бот найден: <b>@${esc(w.bot.username)}</b></p>
      <ol class="small" start="3" style="padding-left:20px;margin:0 0 8px">
        <li>Добавьте бота в группу (в группе: участники → добавить → найдите @${esc(w.bot.username)}).</li>
        <li>Нажмите «Найти группу».</li>
      </ol>
      <button class="btn btn--block" data-find type="button" ${w.busy ? 'disabled' : ''}>Найти группу</button>` : `<button class="btn btn--primary btn--block" data-check type="button" ${w.busy ? 'disabled' : ''}>Проверить токен</button>`}
    ${w.groups ? (w.groups.length
      ? `<div class="list-head">Куда отправлять</div><div class="list">${w.groups.map((g) => `<button class="person" data-chat="${esc(g.id)}" type="button"><span class="person__info"><span class="person__name">${esc(g.title)}</span></span></button>`).join('')}</div>`
      : `<p class="small" style="color:var(--err)">Группа не найдена. Добавьте бота в группу (или, если он уже там, напишите в группе сообщение с упоминанием @${esc(w.bot.username)}) и нажмите «Найти группу» ещё раз.</p>`) : ''}
    ${w.error ? `<p class="small" style="color:var(--err)">${esc(w.error)}</p>` : ''}
    <div class="sheet__actions"><button class="btn" value="cancel">Закрыть</button></div>`, (b) => {
    b.oninput = (e) => { if (e.target.id === 'tg-token') { w.token = e.target.value.trim(); } };
    b.onclick = async (e) => {
      const run = async (fn) => { w.busy = true; w.error = ''; draw(); try { await fn(); } catch (err) { w.error = err.message; } w.busy = false; draw(); };
      if (e.target.closest('[data-check]')) {
        run(async () => { w.bot = await Telegram.getMe(w.token); });
      } else if (e.target.closest('[data-find]')) {
        run(async () => { w.groups = await Telegram.findGroups(w.token); });
      } else {
        const id = e.target.closest('[data-chat]')?.dataset.chat;
        if (!id) return;
        const g = w.groups.find((x) => String(x.id) === id);
        DB.update((d) => {
          d.settings.telegram = { token: w.token, botName: w.bot.username, chatId: g.id, chatTitle: g.title, auto: true, since: Dates.today() };
        });
        try {
          await Telegram.sendText(`Бот подключён к табелю «${DB.data.settings.shiftName}». Сюда будут приходить табели 16-го и 1-го числа.`);
          sheet.close();
          toast(`Подключено: «${g.title}»`);
        } catch (err) { w.error = err.message; draw(); }
      }
    };
  });
  draw();
}

// Номер личного чата с ботом — для напоминаний по расписанию (секрет TG_CHAT в GitHub).
function telegramMe() {
  const bot = Telegram.cfg().botName;
  const w = { chats: null, error: '', busy: false };
  const draw = () => openSheet(`<h3>Напоминания мне</h3>
    <p class="sheet__sub">Бот будет писать вам лично в начале смены, 16-го и 1-го числа.</p>
    <ol class="small" style="padding-left:20px;margin:0 0 10px">
      <li>Откройте в Telegram чат с ботом${bot ? ` <b>@${esc(bot)}</b>` : ''} и нажмите <b>«Старт»</b> (или отправьте ему любое сообщение).</li>
      <li>Нажмите «Найти мой чат» и скопируйте номер — его нужно один раз вписать в настройки GitHub (покажу, куда).</li>
    </ol>
    <button class="btn btn--primary btn--block" data-find type="button" ${w.busy ? 'disabled' : ''}>Найти мой чат</button>
    ${w.chats ? (w.chats.length ? w.chats.map((c) => `<div class="card" style="margin:10px 0 0"><div class="row"><span class="grow">${esc(c.title)}<br><b style="font-size:20px">${esc(c.id)}</b></span>
        <button class="btn" data-copy="${esc(c.id)}" type="button">Копировать</button></div></div>`).join('')
      : '<p class="small" style="color:var(--err)">Не нашёл. Напишите боту любое сообщение и нажмите ещё раз.</p>') : ''}
    ${w.error ? `<p class="small" style="color:var(--err)">${esc(w.error)}</p>` : ''}
    <div class="sheet__actions"><button class="btn" value="cancel">Закрыть</button></div>`, (b) => {
    b.onclick = async (e) => {
      const copy = e.target.closest('[data-copy]')?.dataset.copy;
      if (copy) {
        try { await navigator.clipboard.writeText(copy); toast('Скопировано'); } catch { toast(copy); }
        return;
      }
      if (!e.target.closest('[data-find]')) return;
      w.busy = true; w.error = ''; draw();
      try { w.chats = await Telegram.findPrivate(); } catch (err) { w.error = err.message; }
      w.busy = false; draw();
    };
  });
  draw();
}

$('#view-more').addEventListener('change', (e) => {
  if (e.target.id === 'tg-auto') DB.update((d) => { d.settings.telegram = { ...d.settings.telegram, auto: e.target.checked }; });
});

$('#view-more').addEventListener('click', async (e) => {
  const act = e.target.closest('[data-act]')?.dataset.act;
  if (act === 'tg-setup') telegramSetup();
  else if (act === 'tg-me') telegramMe();
  else if (act === 'tg-test') {
    try { await Telegram.sendText('Проверка связи: табель смены на месте.'); toast('Отправлено'); } catch (err) { toast(err.message); }
  } else if (act === 'tg-off') {
    if (confirm('Отключить отправку в Telegram?')) DB.update((d) => { delete d.settings.telegram; });
  }
  if (act === 'signin') OneDrive.signIn();
  else if (act === 'signout') { if (confirm('Отключить OneDrive? Данные останутся на телефоне.')) OneDrive.signOut(); }
  else if (act === 'sync') OneDrive.syncNow();
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
const APP_VERSION = '1';
const TITLES = { shift: () => DB.data.settings.shiftName, tabel: () => 'Табель', people: () => 'Люди', more: () => 'Ещё' };

function go(view) {
  UI.view = view;
  store.set('ts.view', view);
  render();
  window.scrollTo(0, 0);
}

function render() {
  for (const v of ['shift', 'tabel', 'people', 'more']) $(`#view-${v}`).hidden = v !== UI.view;
  document.querySelectorAll('.nav__btn').forEach((b) => b.classList.toggle('is-active', b.dataset.view === UI.view));
  $('#top-title').textContent = TITLES[UI.view]();
  ({ shift: renderShift, tabel: renderTabel, people: renderPeople, more: renderMore })[UI.view]();
  renderSync();
}

function renderSync() {
  const st = DB.saveState;
  const text = {
    saved: st.cloud ? 'OneDrive' : 'На телефоне', local: 'На телефоне', auth: 'Войти', syncing: 'Синхронизация…',
    offline: 'Нет сети', cloudError: 'Ошибка', error: 'Ошибка памяти',
  }[st.state] || '';
  $('#sync').dataset.state = st.state;
  $('#sync-text').textContent = text;
}

$('#nav').addEventListener('click', (e) => {
  const b = e.target.closest('[data-view]');
  if (b) go(b.dataset.view);
});
$('#sync').addEventListener('click', () => go('more'));

DB.onChange(() => render());
OneDrive.onChange(() => { renderSync(); if (UI.view === 'more') renderMore(); Reports.tick(); });

// Новый день — переключиться на сегодня, если пользователь не листал даты
let lastToday = Dates.today();
document.addEventListener('visibilitychange', () => {
  if (document.hidden) return;
  const t = Dates.today();
  if (t !== lastToday) { if (UI.date === lastToday) UI.date = t; lastToday = t; render(); }
});

// Ссылка на конкретный день: …/#d=2026-09-18
const hashDate = location.hash.match(/^#d=(\d{4}-\d{2}-\d{2})$/)?.[1];
if (hashDate) { UI.date = hashDate; UI.month = Dates.ym(hashDate); }

render();
OneDrive.init();
Reports.tick();

if ('serviceWorker' in navigator && location.protocol === 'https:') {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
