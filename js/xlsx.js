// ================= Excel: выгрузка табеля и загрузка из старого табеля =================
// .xlsx — это zip с XML внутри. Пишем без сжатия (так проще и файл всё равно маленький),
// читаем через встроенный DecompressionStream — сторонние библиотеки не нужны, работает офлайн.
// Оформление повторяет табель «Сентябрь 2026.xlsx»: стили ячеек взяты из него как есть (STYLES_XML).

const Zip = (() => {
  const table = new Uint32Array(256).map((_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc32 = (bytes) => {
    let c = 0xFFFFFFFF;
    for (let i = 0; i < bytes.length; i++) c = table[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);
    return (c ^ 0xFFFFFFFF) >>> 0;
  };

  // files: [{ name, text }]
  function build(files) {
    const enc = new TextEncoder();
    const parts = [];
    const central = [];
    let offset = 0;
    const d = new Date();
    const time = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
    const date = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
    for (const f of files) {
      const name = enc.encode(f.name);
      const data = enc.encode(f.text);
      const crc = crc32(data);
      const h = new DataView(new ArrayBuffer(30));
      h.setUint32(0, 0x04034b50, true); h.setUint16(4, 20, true); h.setUint16(6, 0x0800, true);
      h.setUint16(8, 0, true); h.setUint16(10, time, true); h.setUint16(12, date, true);
      h.setUint32(14, crc, true); h.setUint32(18, data.length, true); h.setUint32(22, data.length, true);
      h.setUint16(26, name.length, true); h.setUint16(28, 0, true);
      parts.push(h.buffer, name, data);
      const c = new DataView(new ArrayBuffer(46));
      c.setUint32(0, 0x02014b50, true); c.setUint16(4, 20, true); c.setUint16(6, 20, true);
      c.setUint16(8, 0x0800, true); c.setUint16(10, 0, true); c.setUint16(12, time, true); c.setUint16(14, date, true);
      c.setUint32(16, crc, true); c.setUint32(20, data.length, true); c.setUint32(24, data.length, true);
      c.setUint16(28, name.length, true); c.setUint32(42, offset, true);
      central.push(c.buffer, name);
      offset += 30 + name.length + data.length;
    }
    const cdSize = central.reduce((s, b) => s + b.byteLength, 0);
    const e = new DataView(new ArrayBuffer(22));
    e.setUint32(0, 0x06054b50, true); e.setUint16(8, files.length, true); e.setUint16(10, files.length, true);
    e.setUint32(12, cdSize, true); e.setUint32(16, offset, true);
    return new Blob([...parts, ...central, e.buffer], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
  }

  async function inflate(bytes) {
    const ds = new DecompressionStream('deflate-raw');
    const out = new Blob([bytes]).stream().pipeThrough(ds);
    return new Uint8Array(await new Response(out).arrayBuffer());
  }

  // → Map(имя → текст)
  async function read(buffer) {
    const v = new DataView(buffer);
    const u8 = new Uint8Array(buffer);
    let eocd = -1;
    for (let i = buffer.byteLength - 22; i >= Math.max(0, buffer.byteLength - 65557); i--) {
      if (v.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
    }
    if (eocd < 0) throw new Error('Это не файл Excel (.xlsx).');
    const count = v.getUint16(eocd + 10, true);
    let p = v.getUint32(eocd + 16, true);
    const dec = new TextDecoder();
    const out = new Map();
    for (let i = 0; i < count; i++) {
      if (v.getUint32(p, true) !== 0x02014b50) throw new Error('Файл Excel повреждён.');
      const method = v.getUint16(p + 10, true);
      const csize = v.getUint32(p + 20, true);
      const nlen = v.getUint16(p + 28, true), xlen = v.getUint16(p + 30, true), clen = v.getUint16(p + 32, true);
      const local = v.getUint32(p + 42, true);
      const name = dec.decode(u8.subarray(p + 46, p + 46 + nlen));
      p += 46 + nlen + xlen + clen;
      if (!/\.(xml|rels)$/.test(name)) continue;
      const start = local + 30 + v.getUint16(local + 26, true) + v.getUint16(local + 28, true);
      const raw = u8.subarray(start, start + csize);
      out.set(name, dec.decode(method === 8 ? await inflate(raw) : raw));
    }
    return out;
  }

  return { build, read };
})();

const Xlsx = (() => {
  const col = (i) => { let s = ''; i++; while (i > 0) { const m = (i - 1) % 26; s = String.fromCharCode(65 + m) + s; i = Math.floor((i - 1) / 26); } return s; };
  const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

  // Стили из табеля-образца. Номера — индексы в cellXfs ниже.
  const S = {
    title: 26, titleRest: 27, wd: 1, total: 2, dnum: 3,
    shiftLbl: 28, shiftD: 5, shiftN: 4, shiftOff: 23, shiftTotal: 8,
    num: 9, name: 18, cellD: 12, cellN: 10, cellOff: 11, sum: 9,
    noteA: 22, note: 29,
  };
  const FIRST_DAY_COL = 2; // C
  const TOTAL_COL = 33;    // AH (31 день: C..AG)
  const MIN_PEOPLE_ROWS = 20;
  const MIN_NOTE_ROWS = 9;

  function sheetXml(ym) {
    const s = DB.data.settings;
    const days = Dates.monthDays(ym);
    const people = Tabel.peopleOf(ym);
    const map = Tabel.marksMap();
    const notes = Tabel.notesOf(ym);
    const month = Dates.MONTHS[Number(ym.slice(5)) - 1];
    const types = days.map((d) => Sched.type(d));

    const rows = [];
    const merges = ['A1:B5', 'C1:AH3', 'A6:B6'];
    const c = (ci, r, style, v) => {
      const ref = `${col(ci)}${r}`;
      if (v === undefined || v === null || v === '') return `<c r="${ref}" s="${style}"/>`;
      if (typeof v === 'number') return `<c r="${ref}" s="${style}"><v>${v}</v></c>`;
      return `<c r="${ref}" s="${style}" t="inlineStr"><is><t>${esc(v)}</t></is></c>`;
    };
    const row = (r, ht, cells) => rows.push(`<row r="${r}" spans="1:34"${ht ? ` ht="${ht}" customHeight="1"` : ''}>${cells.join('')}</row>`);
    const dayCols = (fn) => Array.from({ length: 31 }, (_, i) => fn(FIRST_DAY_COL + i, i));

    // Заголовок: «Смена 1» и месяц
    for (let r = 1; r <= 3; r++) {
      row(r, 15, [
        c(0, r, S.title, r === 1 ? s.shiftName : ''), c(1, r, S.title),
        ...Array.from({ length: 32 }, (_, i) => c(2 + i, r, i === 0 ? S.title : S.titleRest, r === 1 && i === 0 ? month : '')),
      ]);
    }
    row(4, 15.75, [c(0, 4, S.title), c(1, 4, S.title),
      ...dayCols((ci, i) => c(ci, 4, S.wd, days[i] ? Dates.WD[Dates.wd(days[i])] : '')), c(TOTAL_COL, 4, S.total, 'Итого')]);
    row(5, 15.75, [c(0, 5, S.title), c(1, 5, S.title),
      ...dayCols((ci, i) => c(ci, 5, S.dnum, days[i] ? i + 1 : '')), c(TOTAL_COL, 5, S.total)]);
    row(6, 15, [c(0, 6, S.shiftLbl, 'Смена'), c(1, 6, S.shiftLbl),
      ...dayCols((ci, i) => {
        const t = types[i];
        if (t === 'Д') return c(ci, 6, S.shiftD, 'Д');
        if (t === 'Н') return c(ci, 6, S.shiftN, 'Н');
        return c(ci, 6, S.shiftOff);
      }), c(TOTAL_COL, 6, S.shiftTotal)]);

    const styleOf = (i) => (types[i] === 'Д' ? S.cellD : types[i] === 'Н' ? S.cellN : S.cellOff);
    const nPeople = Math.max(people.length, MIN_PEOPLE_ROWS);
    for (let k = 0; k < nPeople; k++) {
      const r = 7 + k;
      const p = people[k];
      const cells = [c(0, r, S.num, k + 1), c(1, r, S.name, p ? Tabel.label(p) : '')];
      cells.push(...dayCols((ci, i) => c(ci, r, styleOf(i), p && days[i] ? Tabel.cell(p.id, days[i], map) : '')));
      if (p) {
        const total = Tabel.total(p.id, ym, map);
        cells.push(`<c r="${col(TOTAL_COL)}${r}" s="${S.sum}"><f>SUM(C${r}:AG${r})</f><v>${total}</v></c>`);
      } else cells.push(c(TOTAL_COL, r, S.sum));
      row(r, 23.25, cells);
    }

    const first = 7 + nPeople;
    const nNotes = Math.max(notes.length, MIN_NOTE_ROWS);
    for (let k = 0; k < nNotes; k++) {
      const r = first + k;
      row(r, 0, [c(0, r, S.noteA), c(1, r, S.note, notes[k]?.text || ''), ...Array.from({ length: 32 }, (_, i) => c(2 + i, r, S.note))]);
      merges.push(`B${r}:AH${r}`);
    }
    const last = first + nNotes - 1;

    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">`
      + `<sheetPr><pageSetUpPr fitToPage="1"/></sheetPr><dimension ref="A1:AH${last}"/>`
      + `<sheetViews><sheetView tabSelected="1" workbookViewId="0"/></sheetViews><sheetFormatPr defaultColWidth="8" defaultRowHeight="15"/>`
      + `<cols><col min="1" max="1" width="3.7109375" customWidth="1"/><col min="2" max="2" width="58" customWidth="1"/><col min="3" max="33" width="3.7109375" customWidth="1"/><col min="34" max="34" width="8" customWidth="1"/></cols>`
      + `<sheetData>${rows.join('')}</sheetData>`
      + `<mergeCells count="${merges.length}">${merges.map((m) => `<mergeCell ref="${m}"/>`).join('')}</mergeCells>`
      + `<pageMargins left="0.4" right="0.4" top="0.5" bottom="0.5" header="0.3" footer="0.3"/>`
      + `<pageSetup paperSize="9" orientation="landscape" fitToWidth="1" fitToHeight="0"/></worksheet>`;
  }

  function build(ym) {
    const files = [
      { name: '[Content_Types].xml', text: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>` },
      { name: '_rels/.rels', text: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>` },
      { name: 'xl/workbook.xml', text: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><bookViews><workbookView/></bookViews><sheets><sheet name="Лист1" sheetId="1" r:id="rId1"/></sheets><calcPr calcId="191028" fullCalcOnLoad="1"/></workbook>` },
      { name: 'xl/_rels/workbook.xml.rels', text: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>` },
      { name: 'xl/styles.xml', text: STYLES_XML },
      { name: 'xl/worksheets/sheet1.xml', text: sheetXml(ym) },
    ];
    return Zip.build(files);
  }

  const fileName = (ym) => `${Dates.monthTitle(ym)}.xlsx`;

  // ---------- Загрузка табеля ----------
  // Возвращает разбор без изменения данных: { ym, people: [{ name, position, values: { 'YYYY-MM-DD': v } }],
  // notes: [{ date, text }], free: [строки], anchor }.
  async function parse(file, yearOverride) {
    const zip = await Zip.read(await file.arrayBuffer());
    const xml = (name) => {
      const t = zip.get(name);
      return t ? new DOMParser().parseFromString(t, 'application/xml') : null;
    };
    const tags = (doc, tag) => [...doc.getElementsByTagNameNS('*', tag)];

    const sst = [];
    const ss = xml('xl/sharedStrings.xml');
    if (ss) for (const si of tags(ss, 'si')) sst.push(tags(si, 't').map((t) => t.textContent).join(''));

    // Первый лист книги
    let sheetPath = 'xl/worksheets/sheet1.xml';
    const wb = xml('xl/workbook.xml');
    const rels = xml('xl/_rels/workbook.xml.rels');
    if (wb && rels) {
      const first = tags(wb, 'sheet')[0];
      const rid = first?.getAttributeNS('http://schemas.openxmlformats.org/officeDocument/2006/relationships', 'id');
      const rel = tags(rels, 'Relationship').find((r) => r.getAttribute('Id') === rid);
      if (rel) sheetPath = 'xl/' + rel.getAttribute('Target').replace(/^\/?xl\//, '').replace(/^\//, '');
    }
    const sheet = xml(sheetPath);
    if (!sheet) throw new Error('В файле не найден лист с табелем.');

    // Клетки: grid[строка][колонка] = число | строка
    const grid = new Map();
    const colIdx = (ref) => [...ref.replace(/\d+/g, '')].reduce((s, ch) => s * 26 + ch.charCodeAt(0) - 64, 0) - 1;
    for (const cel of tags(sheet, 'c')) {
      const ref = cel.getAttribute('r');
      const r = Number(ref.replace(/\D+/g, ''));
      const ci = colIdx(ref);
      const t = cel.getAttribute('t');
      const v = tags(cel, 'v')[0]?.textContent;
      let val;
      if (t === 's') val = sst[Number(v)];
      else if (t === 'inlineStr') val = tags(cel, 't').map((x) => x.textContent).join('');
      else if (t === 'str' || t === 'b' || t === 'e') val = v;
      else if (v !== undefined && v !== '') val = Number(v);
      if (val === undefined || val === '') continue;
      if (typeof val === 'string') { val = val.trim(); if (!val) continue; }
      if (!grid.has(r)) grid.set(r, new Map());
      grid.get(r).set(ci, val);
    }
    const at = (r, ci) => grid.get(r)?.get(ci);
    const rowsSorted = [...grid.keys()].sort((a, b) => a - b);

    // Месяц: название в шапке, год — из имени файла (в самом табеле его нет)
    let month = -1;
    for (const r of rowsSorted.slice(0, 6)) {
      for (const v of grid.get(r).values()) {
        const i = Dates.MONTHS.findIndex((m) => typeof v === 'string' && v.toLowerCase().startsWith(m.toLowerCase()));
        if (i >= 0) { month = i + 1; break; }
      }
      if (month > 0) break;
    }
    const yMatch = file.name.match(/(20\d\d)/);
    const year = yearOverride || (yMatch ? Number(yMatch[1]) : new Date().getFullYear());
    if (month < 0) month = new Date().getMonth() + 1;

    // Строка с числами месяца (1, 2, 3, …) → колонка каждого дня
    let dayRow = -1;
    const dayCol = new Map();
    for (const r of rowsSorted) {
      const g = grid.get(r);
      const ones = [...g.entries()].filter(([, v]) => v === 1);
      for (const [ci] of ones) {
        if (g.get(ci + 1) === 2 && g.get(ci + 2) === 3) {
          dayRow = r;
          for (let d = 1; d <= 31; d++) if (g.get(ci + d - 1) === d) dayCol.set(d, ci + d - 1);
          break;
        }
      }
      if (dayRow > 0) break;
    }
    if (dayRow < 0) throw new Error('Не нашёл строку с числами месяца (1, 2, 3 …).');

    const ym = `${year}-${String(month).padStart(2, '0')}`;
    const days = Dates.monthDays(ym);
    const nameCol = 1; // B

    // Строка «Смена» с буквами Д/Н — по ней определяем, с какого дня начинается цикл графика
    const shiftRow = rowsSorted.find((r) => r > dayRow && [...dayCol.values()].some((ci) => at(r, ci) === 'Д' || at(r, ci) === 'Н'));
    let anchor = null;
    if (shiftRow) {
      const s = DB.data.settings;
      let best = { score: -1 };
      for (let k = 0; k < s.cycle.length; k++) {
        const cand = Dates.add(days[0], -k);
        let score = 0;
        days.forEach((d, i) => {
          const letter = at(shiftRow, dayCol.get(i + 1)) || 'В';
          if (letter === Sched.type(d, { ...s, anchor: cand })) score++;
        });
        if (score > best.score) best = { score, cand };
      }
      if (best.score >= days.length - 3) anchor = best.cand;
    }

    const people = [];
    const notes = [];
    const free = [];
    const noteRe = /^(\d{1,2})\.(\d{1,2})\.?\s+(.+)$/;
    for (const r of rowsSorted) {
      if (r <= (shiftRow || dayRow)) continue;
      const text = at(r, nameCol);
      if (typeof text !== 'string') continue;
      const m = text.match(noteRe);
      const hasDays = [...dayCol.values()].some((ci) => at(r, ci) !== undefined);
      if (m && !hasDays) {
        const date = `${year}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
        if (date.startsWith(ym)) notes.push({ date, text: m[3].trim(), raw: text });
        else free.push(text);
        continue;
      }
      if (!hasDays && people.length) { free.push(text); continue; }
      const pm = text.match(/^(.*?)\s*\(([^()]*)\)\s*$/);
      const values = {};
      days.forEach((d, i) => {
        let v = at(r, dayCol.get(i + 1));
        if (typeof v === 'string') {
          const u = v.toUpperCase();
          v = /^[-–—]$/.test(v) ? '-' : u === 'Б' || u === 'ОТ' ? u : v;
        }
        values[d] = v === undefined ? '' : v;
      });
      people.push({ name: (pm ? pm[1] : text).trim(), position: pm ? pm[2].trim() : '', values });
    }
    return { ym, people, notes, free, anchor };
  }

  // Применяет разбор: люди (по ФИО — существующие, иначе новые), отметки месяца заменяются, примечания
  // раскладываются по отметкам как причины («заявление за свой счёт»), нераспознанные — в свободные примечания.
  function apply(parsed, { updateAnchor }) {
    DB.update((data) => {
      if (updateAnchor && parsed.anchor) data.settings.anchor = parsed.anchor;
      const byName = new Map(data.people.map((p) => [p.name.toLowerCase(), p]));
      const ids = [];
      for (const ip of parsed.people) {
        let p = byName.get(ip.name.toLowerCase());
        if (!p) {
          p = { id: uid(), name: ip.name, position: ip.position, archived: false };
          data.people.push(p);
          byName.set(p.name.toLowerCase(), p);
        } else if (!p.position && ip.position) p.position = ip.position;
        ids.push(p.id);
      }
      data.marks = data.marks.filter((m) => !m.date.startsWith(parsed.ym));
      parsed.people.forEach((ip, k) => {
        for (const [d, v] of Object.entries(ip.values)) Tabel.setMark(d, ids[k], v);
      });

      data.notes = data.notes.filter((n) => n.month !== parsed.ym);
      const leftover = [...parsed.free];
      for (const n of parsed.notes) {
        const hit = parsed.people.map((ip, k) => ({ ip, id: ids[k], sur: ip.name.split(/\s+/)[0] }))
          .filter((x) => x.sur && n.text.toLowerCase().includes(x.sur.toLowerCase()));
        let reason = n.text;
        for (const x of hit) reason = reason.replace(new RegExp(x.sur, 'i'), '');
        // «Петрова и Сидорова заявление» → без фамилий остаётся «и заявление» → «заявление»
        const toks = reason.split(/\s+/).filter(Boolean);
        while (toks.length && /^(и|,)$/i.test(toks[0])) toks.shift();
        reason = toks.join(' ');
        // Причину ставим только тем, у кого в этот день есть отметка.
        const marked = hit.filter((x) => data.marks.some((m) => m.id === Tabel.markId(n.date, x.id)));
        if (!reason || !marked.length) { leftover.push(n.raw); continue; }
        for (const x of marked) {
          const m = data.marks.find((mm) => mm.id === Tabel.markId(n.date, x.id));
          m.reason = reason;
        }
      }
      for (const text of leftover) data.notes.push({ id: uid(), month: parsed.ym, text });
    });
  }

  return { build, fileName, parse, apply };
})();

// Стили ячеек табеля-образца (xl/styles.xml из «Сентябрь 2026.xlsx»).
const STYLES_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="10"><font><sz val="11"/><name val="Aptos Narrow"/><family val="1"/></font><font><sz val="11"/><name val="Aptos Narrow"/><family val="1"/></font><font><sz val="10"/><color rgb="FF000000"/><name val="Arial"/><family val="2"/></font><font><sz val="10"/><name val="Arial"/><family val="2"/></font><font><sz val="10"/><name val="Franklin Gothic Book"/><family val="1"/></font><font><sz val="11"/><name val="Franklin Gothic Book"/><family val="1"/></font><font><sz val="10"/><color rgb="FF000000"/><name val="Franklin Gothic Book"/><family val="1"/></font><font><sz val="11"/><color rgb="FF000000"/><name val="Franklin Gothic Book"/><family val="1"/></font><font><sz val="28"/><color rgb="FF000000"/><name val="Franklin Gothic Book"/><family val="1"/></font><font><sz val="28"/><name val="Franklin Gothic Book"/><family val="1"/></font></fonts><fills count="6"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FFEBFFEB"/><bgColor indexed="64"/></patternFill></fill><fill><patternFill patternType="solid"><fgColor rgb="FFF2E1F1"/><bgColor indexed="64"/></patternFill></fill><fill><patternFill patternType="solid"><fgColor rgb="FFFFFFFF"/><bgColor indexed="64"/></patternFill></fill><fill><patternFill patternType="solid"><fgColor rgb="FFFFFFFF"/><bgColor indexed="64"/></patternFill></fill></fills><borders count="9"><border><left/><right/><top/><bottom/><diagonal/></border><border><left style="thin"><color rgb="FF000000"/></left><right style="thin"><color rgb="FF000000"/></right><top style="thin"><color rgb="FF000000"/></top><bottom style="thin"><color rgb="FF000000"/></bottom><diagonal/></border><border><left style="thin"><color rgb="FF000000"/></left><right style="thin"><color rgb="FF000000"/></right><top/><bottom style="thin"><color rgb="FF000000"/></bottom><diagonal/></border><border><left/><right style="thin"><color rgb="FF000000"/></right><top style="thin"><color rgb="FF000000"/></top><bottom style="thin"><color rgb="FF000000"/></bottom><diagonal/></border><border><left/><right/><top style="thin"><color rgb="FF000000"/></top><bottom style="thin"><color rgb="FF000000"/></bottom><diagonal/></border><border><left style="thin"><color rgb="FF000000"/></left><right/><top style="thin"><color rgb="FF000000"/></top><bottom style="thin"><color rgb="FF000000"/></bottom><diagonal/></border><border><left/><right/><top style="thin"><color rgb="FF000000"/></top><bottom/><diagonal/></border><border><left/><right style="thin"><color rgb="FF000000"/></right><top style="thin"><color rgb="FF000000"/></top><bottom/><diagonal/></border><border><left style="thin"><color rgb="FF000000"/></left><right/><top style="thin"><color rgb="FF000000"/></top><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="37"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0" applyAlignment="1"/><xf numFmtId="0" fontId="4" fillId="0" borderId="1" xfId="0" applyFont="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center" wrapText="1"/></xf><xf numFmtId="0" fontId="5" fillId="0" borderId="1" xfId="0" applyFont="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf><xf numFmtId="0" fontId="4" fillId="0" borderId="1" xfId="0" applyFont="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf><xf numFmtId="0" fontId="4" fillId="3" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf><xf numFmtId="0" fontId="4" fillId="2" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf><xf numFmtId="0" fontId="4" fillId="4" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf><xf numFmtId="0" fontId="1" fillId="4" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"/><xf numFmtId="0" fontId="5" fillId="0" borderId="1" xfId="0" applyFont="1" applyBorder="1" applyAlignment="1"/><xf numFmtId="0" fontId="6" fillId="0" borderId="1" xfId="0" applyFont="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf><xf numFmtId="0" fontId="7" fillId="3" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf><xf numFmtId="0" fontId="7" fillId="4" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf><xf numFmtId="0" fontId="7" fillId="2" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf><xf numFmtId="0" fontId="2" fillId="0" borderId="1" xfId="0" applyFont="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf><xf numFmtId="0" fontId="0" fillId="0" borderId="5" xfId="0" applyBorder="1" applyAlignment="1"/><xf numFmtId="0" fontId="3" fillId="0" borderId="1" xfId="0" applyFont="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf><xf numFmtId="0" fontId="4" fillId="5" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf><xf numFmtId="0" fontId="7" fillId="5" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf><xf numFmtId="0" fontId="6" fillId="0" borderId="1" xfId="0" applyFont="1" applyBorder="1" applyAlignment="1"><alignment horizontal="left" vertical="center" wrapText="1"/></xf><xf numFmtId="0" fontId="6" fillId="0" borderId="1" xfId="0" applyFont="1" applyBorder="1" applyAlignment="1"><alignment vertical="center"/></xf><xf numFmtId="0" fontId="4" fillId="0" borderId="1" xfId="0" applyFont="1" applyBorder="1" applyAlignment="1"><alignment horizontal="left" vertical="center" wrapText="1"/></xf><xf numFmtId="0" fontId="2" fillId="0" borderId="1" xfId="0" applyFont="1" applyBorder="1" applyAlignment="1"><alignment horizontal="left" vertical="center" wrapText="1"/></xf><xf numFmtId="0" fontId="0" fillId="0" borderId="2" xfId="0" applyBorder="1" applyAlignment="1"/><xf numFmtId="0" fontId="0" fillId="0" borderId="1" xfId="0" applyBorder="1" applyAlignment="1"/><xf numFmtId="0" fontId="0" fillId="0" borderId="2" xfId="0" applyBorder="1" applyAlignment="1"><alignment vertical="center"/></xf><xf numFmtId="0" fontId="0" fillId="0" borderId="1" xfId="0" applyBorder="1" applyAlignment="1"/><xf numFmtId="0" fontId="8" fillId="0" borderId="1" xfId="0" applyFont="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf><xf numFmtId="0" fontId="9" fillId="0" borderId="1" xfId="0" applyFont="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf><xf numFmtId="0" fontId="6" fillId="0" borderId="1" xfId="0" applyFont="1" applyBorder="1" applyAlignment="1"><alignment horizontal="left" vertical="center" indent="3"/></xf><xf numFmtId="0" fontId="0" fillId="0" borderId="1" xfId="0" applyBorder="1" applyAlignment="1"><alignment vertical="center"/></xf><xf numFmtId="0" fontId="0" fillId="0" borderId="2" xfId="0" applyBorder="1" applyAlignment="1"><alignment horizontal="center"/></xf><xf numFmtId="0" fontId="0" fillId="0" borderId="5" xfId="0" applyBorder="1" applyAlignment="1"><alignment vertical="center"/></xf><xf numFmtId="0" fontId="0" fillId="0" borderId="4" xfId="0" applyBorder="1" applyAlignment="1"><alignment vertical="center"/></xf><xf numFmtId="0" fontId="0" fillId="0" borderId="3" xfId="0" applyBorder="1" applyAlignment="1"><alignment vertical="center"/></xf><xf numFmtId="0" fontId="0" fillId="0" borderId="8" xfId="0" applyBorder="1" applyAlignment="1"><alignment vertical="center"/></xf><xf numFmtId="0" fontId="0" fillId="0" borderId="6" xfId="0" applyBorder="1" applyAlignment="1"><alignment vertical="center"/></xf><xf numFmtId="0" fontId="0" fillId="0" borderId="7" xfId="0" applyBorder="1" applyAlignment="1"><alignment vertical="center"/></xf></cellXfs><cellStyles count="1"><cellStyle name="Обычный" xfId="0" builtinId="0"/></cellStyles><dxfs count="0"/><tableStyles count="0"/></styleSheet>`;
