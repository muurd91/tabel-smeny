// ================= Отправка табеля в группу по расписанию =================
// Запускает .github/workflows/send.yml 16-го и 1-го числа в 11:00 по Минску.
// Берёт табель из Firestore (users/<uid>/apps/tabel), рисует картинку и Excel теми же модулями, что и приложение
// (js/*.js выполняются здесь с заменой браузерных объектов), и отправляет ботом из настроек приложения.
// Потом отмечает в Firestore, что снимок ушёл, — приложение второй раз не отправит.
//
// MODE: auto — по расписанию (только 1-го и 16-го, если ещё не отправлено);
//       test — отправить текущий снимок сейчас с пометкой «тест», ничего не отмечая;
//       selftest — без Firestore и Telegram: вымышленные данные → картинка и Excel в out/ (проверка отрисовки).

import vm from 'node:vm';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createCanvas, GlobalFonts } from '@napi-rs/canvas';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { MODE = 'auto', FIREBASE_SA } = process.env;

// Шрифт с кириллицей под именем, которое первым стоит в списке шрифтов картинки (Snapshot: system-ui, …)
for (const [file, name] of [['DejaVuSans.ttf', 'system-ui'], ['DejaVuSans-Bold.ttf', 'system-ui']]) {
  const p = `/usr/share/fonts/truetype/dejavu/${file}`;
  if (fs.existsSync(p)) GlobalFonts.registerFromPath(p, name);
}

// ---------- Браузерное окружение для js/*.js ----------
const store = new Map();
const sandbox = {
  console, fetch, FormData, Blob, File, Response, TextEncoder, TextDecoder, URL, setTimeout, clearTimeout,
  localStorage: { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k) },
  alert: (m) => console.warn(m),
  navigator: { onLine: true },
  location: { protocol: 'node:' },
  window: { addEventListener() {} },
  document: {
    addEventListener() {},
    createElement: () => ({
      width: 300, height: 150, _c: null,
      getContext() { this._c = createCanvas(this.width, this.height); return this._c.getContext('2d'); },
      toBlob(cb, type) { cb(new Blob([this._c.toBuffer('image/png')], { type })); },
    }),
  },
};
const ctx = vm.createContext(sandbox);
for (const f of ['js/config.js', 'js/data.js', 'js/xlsx.js', 'js/telegram.js', 'js/report.js']) {
  vm.runInContext(fs.readFileSync(path.join(root, f), 'utf8'), ctx, { filename: f });
}
const run = (code) => vm.runInContext(code, ctx);
const load = (json) => { sandbox.__json = json; run('DB.replace(JSON.parse(__json))'); };

// ---------- Проверка отрисовки на вымышленных данных ----------
if (MODE === 'selftest') {
  const ym = run('Dates.ym(Dates.today())');
  const names = ['Иванов Иван Иванович', 'Петрова Анна Сергеевна', 'Сидоров Пётр Павлович', 'Кузнецова Мария Олеговна'];
  load(JSON.stringify({
    format: 'tabel-smeny', version: 1,
    people: names.map((name, i) => ({ id: `p${i}`, name, position: i ? 'укладчик-упаковщик' : 'мастер смены' })),
    marks: [
      { id: `${ym}-02|p1`, date: `${ym}-02`, pid: 'p1', v: 'Б' },
      { id: `${ym}-04|p2`, date: `${ym}-04`, pid: 'p2', v: '-', reason: 'заявление за свой счёт' },
      { id: `${ym}-03|p3`, date: `${ym}-03`, pid: 'p3', v: 9, reason: 'заявление' },
    ],
  }));
  const files = await run(`(async () => { const r = Reports.active(); return { r, files: await (async () => {
    const png = await Snapshot.png(r.ym, 'проверка'); return [png, Xlsx.build(r.ym)]; })() }; })()`);
  fs.mkdirSync(path.join(root, 'out'), { recursive: true });
  fs.writeFileSync(path.join(root, 'out', 'selftest.png'), Buffer.from(await files.files[0].arrayBuffer()));
  fs.writeFileSync(path.join(root, 'out', 'selftest.xlsx'), Buffer.from(await files.files[1].arrayBuffer()));
  console.log('selftest: out/selftest.png, out/selftest.xlsx;', run('Reports.summary(Reports.active().ym, "проверка")'));
  process.exit(0);
}

// ---------- Firestore ----------
if (!FIREBASE_SA) {
  console.log('::warning::Отправка по расписанию не настроена: добавьте секрет FIREBASE_SA (ключ сервисного аккаунта Firebase).');
  process.exit(0);
}
const { initializeApp, cert } = await import('firebase-admin/app');
const { getFirestore } = await import('firebase-admin/firestore');
initializeApp({ credential: cert(JSON.parse(FIREBASE_SA)) });
const db = getFirestore();

const docs = (await db.collectionGroup('apps').get()).docs.filter((d) => d.id === 'tabel');
if (!docs.length) { console.log('::warning::В Firestore нет табеля — войдите в приложении в облако.'); process.exit(0); }

const day = Number(run('Dates.today()').slice(8));
let failed = false;
for (const doc of docs) {
  load(doc.get('json'));
  const r = run('Reports.active()');
  const tg = run('Telegram.cfg()');
  const st = run(`DB.data.reports.find((x) => x.id === ${JSON.stringify(r.id)}) || {}`);
  const why = !run('Telegram.ready()') ? 'бот не подключён'
    : MODE === 'test' ? ''
      : ![1, 16].includes(day) ? 'сегодня не 1-е и не 16-е'
        : tg.auto === false ? 'автоотправка выключена в приложении'
          : run('Tabel.peopleOf(Reports.active().ym).length') === 0 ? 'в табеле нет людей'
            : r.start < (tg.since || '') ? 'бот подключён позже начала этого снимка'
              : st.sentAt || st.tgSentAt ? 'уже отправлено'
                : st.dismissed ? 'скрыто в приложении' : '';
  if (why) { console.log(`${r.id}: пропуск — ${why}`); continue; }

  const prefix = MODE === 'test' ? '🧪 Проверка отправки по расписанию. ' : '';
  try {
    sandbox.__args = [r.ym, r.name, r.caption, prefix];
    await run('Reports.sendTelegram(...__args)');
    console.log(`${r.id}: отправлено в «${tg.chatTitle || tg.chatId}»${run('Telegram.fullReady()') ? ` (только картинка) и «${tg.fullChatTitle || tg.fullChatId}» (полностью)` : ''}`);
  } catch (e) {
    failed = true;
    console.log(`::error::${r.id}: ${e.message}`);
    continue;
  }
  if (MODE === 'test') continue;

  // Отметить в табеле, что снимок ушёл (в транзакции — вдруг приложение в этот момент что-то сохраняет)
  await db.runTransaction(async (t) => {
    const fresh = await t.get(doc.ref);
    const data = JSON.parse(fresh.get('json'));
    const now = new Date().toISOString();
    data.reports = Array.isArray(data.reports) ? data.reports : [];
    const i = data.reports.findIndex((x) => x.id === r.id);
    const next = { ...(i >= 0 ? data.reports[i] : { id: r.id }), sentAt: now, tgSentAt: now, by: 'schedule' };
    if (i >= 0) data.reports[i] = next; else data.reports.push(next);
    data.updatedAt = now;
    t.set(doc.ref, { json: JSON.stringify(data), updatedAt: now, format: data.format });
  });
}
process.exit(failed ? 1 : 0);
