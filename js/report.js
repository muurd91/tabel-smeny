// ================= Снимки табеля: 16-го и 1-го числа =================
// С 16-го числа — табель текущего месяца «на 16-е» (прошедшие дни; будущие пока пустые);
// с 1-го по 15-е — итоговый табель прошлого месяца.
// Отправка в группу Telegram: планировщик GitHub в CONFIG.sendHour 16-го и 1-го (remind/send.mjs), а если он не сработал —
// приложение при открытии. Кнопка «Отправить» на плашке — вручную, в Telegram или через «Поделиться».

const Snapshot = (() => {
  const C = {
    pad: 16, titleH: 46, hdrH: 22, rowH: 28, numW: 28, nameW: 440, dayW: 30, totW: 56, noteH: 22,
    day: '#EBFFEB', night: '#F2E1F1', line: '#555', text: '#000', muted: '#555',
    font: 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif',
  };
  const SCALE = 2;

  // Картинка табеля в том же виде, что и Excel. Возвращает Blob PNG.
  function png(ym, caption) {
    const days = Dates.monthDays(ym);
    const people = Tabel.peopleOf(ym);
    const map = Tabel.marksMap();
    const notes = Tabel.notesOf(ym);
    const types = days.map((d) => Sched.type(d));
    const n = days.length;

    const tableW = C.numW + C.nameW + n * C.dayW + C.totW;
    const W = C.pad * 2 + tableW;
    const bodyRows = Math.max(people.length, 1);
    const tableH = C.hdrH * 3 + bodyRows * C.rowH;
    const notesH = notes.length ? 12 + C.noteH * (notes.length + 1) : 0;
    const H = C.pad * 2 + C.titleH + tableH + notesH;

    const cv = document.createElement('canvas');
    cv.width = W * SCALE;
    cv.height = H * SCALE;
    const g = cv.getContext('2d');
    g.scale(SCALE, SCALE);
    g.fillStyle = '#fff';
    g.fillRect(0, 0, W, H);

    const rect = (x, y, w, h, fill) => {
      if (fill) { g.fillStyle = fill; g.fillRect(x, y, w, h); }
      g.strokeStyle = C.line; g.lineWidth = 0.75; g.strokeRect(x, y, w, h);
    };
    const text = (s, x, y, { align = 'center', size = 13, bold = false, color = C.text, maxW } = {}) => {
      g.font = `${bold ? 700 : 400} ${size}px ${C.font}`;
      g.fillStyle = color; g.textAlign = align; g.textBaseline = 'middle';
      let str = String(s);
      if (maxW && g.measureText(str).width > maxW) {
        while (str.length > 1 && g.measureText(str + '…').width > maxW) str = str.slice(0, -1);
        str += '…';
      }
      g.fillText(str, x, y);
    };
    const fillOf = (t) => (t === 'Д' ? C.day : t === 'Н' ? C.night : null);

    // Заголовок
    const x0 = C.pad;
    let y = C.pad;
    text(DB.data.settings.shiftName, x0, y + C.titleH / 2 - 4, { align: 'left', size: 22, bold: true });
    text(Dates.MONTHS[Number(ym.slice(5)) - 1], x0 + C.numW + C.nameW + (n * C.dayW) / 2, y + C.titleH / 2 - 4, { size: 22, bold: true });
    text(caption, x0 + tableW, y + C.titleH / 2 - 4, { align: 'right', size: 12, color: C.muted });
    y += C.titleH;

    // Шапка: дни недели, числа, Д/Н
    const dx = (i) => x0 + C.numW + C.nameW + i * C.dayW;
    rect(x0, y, C.numW + C.nameW, C.hdrH * 2);
    rect(x0, y + C.hdrH * 2, C.numW + C.nameW, C.hdrH);
    text('Смена', x0 + 8, y + C.hdrH * 2.5, { align: 'left', size: 12 });
    days.forEach((d, i) => {
      rect(dx(i), y, C.dayW, C.hdrH);
      text(Dates.WD[Dates.wd(d)], dx(i) + C.dayW / 2, y + C.hdrH / 2, { size: 11 });
      rect(dx(i), y + C.hdrH, C.dayW, C.hdrH);
      text(i + 1, dx(i) + C.dayW / 2, y + C.hdrH * 1.5, { size: 12, bold: true });
      rect(dx(i), y + C.hdrH * 2, C.dayW, C.hdrH, fillOf(types[i]));
      if (types[i] !== 'В') text(types[i], dx(i) + C.dayW / 2, y + C.hdrH * 2.5, { size: 12 });
    });
    const tx = dx(n);
    rect(tx, y, C.totW, C.hdrH * 2);
    text('Итого', tx + C.totW / 2, y + C.hdrH, { size: 12, bold: true });
    rect(tx, y + C.hdrH * 2, C.totW, C.hdrH);
    y += C.hdrH * 3;

    // Люди
    people.forEach((p, k) => {
      rect(x0, y, C.numW, C.rowH);
      text(k + 1, x0 + C.numW / 2, y + C.rowH / 2, { size: 12 });
      rect(x0 + C.numW, y, C.nameW, C.rowH);
      text(Tabel.label(p), x0 + C.numW + 6, y + C.rowH / 2, { align: 'left', size: 12, maxW: C.nameW - 12 });
      days.forEach((d, i) => {
        rect(dx(i), y, C.dayW, C.rowH, fillOf(types[i]));
        const v = Tabel.cell(p.id, d, map);
        if (v !== '') text(String(v).replace('.', ','), dx(i) + C.dayW / 2, y + C.rowH / 2, { size: 13 });
      });
      rect(tx, y, C.totW, C.rowH);
      text(String(Tabel.total(p.id, ym, map)).replace('.', ','), tx + C.totW / 2, y + C.rowH / 2, { size: 13, bold: true });
      y += C.rowH;
    });

    // Примечания
    if (notes.length) {
      y += 12;
      text('Примечания:', x0, y + C.noteH / 2, { align: 'left', size: 13, bold: true });
      notes.forEach((nt, k) => text(nt.text, x0, y + C.noteH * (k + 1.5), { align: 'left', size: 13, maxW: tableW }));
    }

    return new Promise((resolve) => cv.toBlob(resolve, 'image/png'));
  }

  return { png };
})();

const Reports = (() => {
  const nowDm = () => { const t = Dates.today(); return `${t.slice(8)}.${t.slice(5, 7)}.${t.slice(0, 4)}`; };

  // Снимок, который сейчас «в работе».
  function active(today = Dates.today()) {
    const ym = Dates.ym(today);
    const low = (m) => Dates.monthTitle(m).toLowerCase();
    const shift = DB.data.settings.shiftName;
    if (Number(today.slice(8)) >= 16) {
      const name = `${Dates.monthTitle(ym)} на 16.${ym.slice(5)}`;
      return {
        id: `${ym}-16`, ym, name, start: `${ym}-16`,
        title: `Табель за ${Dates.MONTHS[Number(ym.slice(5)) - 1].toLowerCase()} на 16-е`,
        caption: `${shift} — табель за ${low(ym)} на 16.${ym.slice(5)}`,
      };
    }
    const pm = Dates.addMonths(ym, -1);
    return {
      id: `${pm}-final`, ym: pm, name: Dates.monthTitle(pm), start: `${ym}-01`,
      title: `Табель за ${Dates.MONTHS[Number(pm.slice(5)) - 1].toLowerCase()} — итоговый`,
      caption: `${shift} — табель за ${low(pm)}, итоговый`,
    };
  }

  const state = (id) => DB.data.reports.find((r) => r.id === id) || {};
  const relevant = (r) => Tabel.peopleOf(r.ym).length > 0;

  function mark(id, patch) {
    DB.update((d) => {
      const i = d.reports.findIndex((x) => x.id === id);
      const next = { ...(i >= 0 ? d.reports[i] : { id }), ...patch };
      if (i >= 0) d.reports[i] = next; else d.reports.push(next);
    });
  }

  // Картинка + Excel. name — без расширения.
  async function files(ym, name) {
    const png = await Snapshot.png(ym, `по состоянию на ${nowDm()}`);
    const xlsx = Xlsx.build(ym);
    return [new File([png], `${name}.png`, { type: 'image/png' }), new File([xlsx], `${name}.xlsx`, { type: xlsx.type })];
  }

  // Отправка через меню «Поделиться» (на компьютере — скачивание). true — отправлено.
  async function share(ym, name, title) {
    const fs = await files(ym, name);
    if (navigator.canShare?.({ files: fs })) {
      try { await navigator.share({ files: fs, title, text: summary(ym, title) }); }
      catch (e) { if (e.name === 'AbortError') return false; throw e; }
    } else fs.forEach((f) => downloadBlob(f, f.name));
    return true;
  }

  // Отправка в Telegram. Если выбран чат для полного табеля — группе только картинка с подписью
  // «за какой месяц и период», а в тот чат картинка + Excel и следом примечания. Иначе всё — в группу.
  // (Подпись к файлам ограничена 1024 символами, поэтому примечания — отдельным сообщением.)
  // prefix — пометка в начале подписей (проверка из планировщика).
  async function sendTelegram(ym, name, caption, prefix = '') {
    const fs = await files(ym, name);
    if (Telegram.fullReady()) {
      await Telegram.sendDoc(fs[0], prefix + periodCaption(ym));
      await Telegram.sendFiles(fs, prefix + caption, 'fullChatId');
      await Telegram.sendText(summary(ym, prefix + caption), 'fullChatId');
    } else {
      await Telegram.sendFiles(fs, prefix + caption);
      await Telegram.sendText(summary(ym, prefix + caption));
    }
  }

  // «Смена 1 — табель за октябрь 2026, с 01 по 16.10» (месяц ещё идёт) или «… за сентябрь 2026» (весь месяц).
  function periodCaption(ym) {
    const today = Dates.today();
    const head = `${DB.data.settings.shiftName} — табель за ${Dates.monthTitle(ym).toLowerCase()}`;
    return Dates.ym(today) === ym && today < Dates.monthDays(ym).at(-1) ? `${head}, с 01 по ${Dates.dm(today)}` : head;
  }

  // ---------- Сообщение под табелем ----------
  // Те же примечания, что под таблицей в Excel: «04.09 Иванова заявление за свой счёт».
  function summary(ym, title) {
    const notes = Tabel.notesOf(ym).map((n) => n.text);
    const text = [`📋 ${title}`, '', ...(notes.length ? ['Примечания:', ...notes] : ['Примечаний нет.'])].join('\n');
    return text.length > 4000 ? `${text.slice(0, 3990)}\n…` : text;
  }

  let tgError = '';
  let tgBusy = false;
  async function sendActiveTelegram({ auto = false } = {}) {
    const r = active();
    if (tgBusy) return;
    tgBusy = true;
    try {
      await sendTelegram(r.ym, r.name, r.caption);
      tgError = '';
      mark(r.id, { sentAt: new Date().toISOString(), tgSentAt: new Date().toISOString() });
      toast(`${auto ? 'Отправлено автоматически' : 'Отправлено'} в группу «${Telegram.cfg().chatTitle || 'Telegram'}»`);
    } catch (e) {
      tgError = e.message;
      render();
    } finally { tgBusy = false; }
  }

  // Автоотправка в Telegram при первом открытии 16-го и 1-го. Только для снимков после подключения бота
  // (чтобы при настройке не улетел старый табель), не раньше часа отправки (CONFIG.sendHour — в это время его шлёт планировщик GitHub,
  // приложение лишь подстраховывает) и после сверки с облаком (чтобы не отправить повторно то, что уже ушло).
  function autoSend() {
    const r = active();
    const tg = Telegram.cfg();
    if (!Telegram.ready() || tg.auto === false || !relevant(r)) return;
    if (r.start < (tg.since || '')) return;
    const s = state(r.id);
    if (s.tgSentAt || s.sentAt || s.dismissed) return;
    if (new Date().getHours() < (CONFIG.sendHour ?? 0)) return;
    if (Cloud.info().connected && DB.saveState.state !== 'saved') return;
    sendActiveTelegram({ auto: true });
  }

  // Вызывается при запуске, после синхронизации, при появлении сети и возврате в приложение.
  function tick() {
    autoSend();
  }

  async function sendActive() {
    const r = active();
    if (await share(r.ym, r.name, r.title)) mark(r.id, { sentAt: new Date().toISOString() });
  }

  // Плашка «Отправить»: пока снимок не отправлен и не скрыт.
  function banner() {
    const r = active();
    const s = state(r.id);
    if (!relevant(r) || s.sentAt || s.dismissed) return '';
    const tg = Telegram.ready();
    const sub = tgError ? `<span class="small" style="color:var(--err)">${esc(tgError)}</span>`
      : `<span class="small muted">Картинка и Excel${Telegram.ready() && Telegram.cfg().auto !== false ? ` · уйдёт сам в ${CONFIG.sendHour}:00` : ''}</span>`;
    return `<div class="report">
      <div class="grow"><b>${esc(r.title)}</b><br>${sub}</div>
      ${tg ? `<button class="btn btn--primary" data-act="report-tg" type="button">${tgError ? 'Повторить' : 'В Telegram'}</button>
              <button class="btn btn--icon" data-act="report-send" type="button" aria-label="Поделиться">${ICON.share}</button>`
        : '<button class="btn btn--primary" data-act="report-send" type="button">Отправить</button>'}
      <button class="btn btn--icon" data-act="report-hide" type="button" aria-label="Скрыть">${ICON.x}</button>
    </div>`;
  }

  document.addEventListener('click', async (e) => {
    const act = e.target.closest('[data-act]')?.dataset.act;
    if (act === 'report-send') {
      try { await sendActive(); } catch (err) { toast(err.message || 'Не удалось отправить'); }
    } else if (act === 'report-tg') sendActiveTelegram();
    else if (act === 'report-hide') mark(active().id, { dismissed: true });
  });

  window.addEventListener('online', () => tick());
  document.addEventListener('visibilitychange', () => { if (!document.hidden) tick(); });

  return { active, tick, share, sendTelegram, banner, summary, files, periodCaption };
})();
