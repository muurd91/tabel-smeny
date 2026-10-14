// ================= Отправка табеля в группу по расписанию =================
// Запускает .github/workflows/send.yml 16-го и 1-го числа в 11:00 по Минску.
// Берёт табель из Firestore (users/<uid>/apps/tabel), рисует картинку и Excel теми же модулями, что и приложение
// (js/*.js выполняются здесь с заменой браузерных объектов), и отправляет ботом из настроек приложения
// и письмом на адреса из приложения (если заданы секреты MAIL_USER и MAIL_PASS).
// Потом отмечает в Firestore, что ушло (tgSentAt, mailSentAt), — повторно не отправится.
//
// MODE: auto — по расписанию (только 1-го и 16-го, если ещё не отправлено);
//       test — отправить текущий снимок сейчас с пометкой «тест», ничего не отмечая;
//       selftest — без Firestore, Telegram и почты: вымышленные данные → картинка и Excel в out/ (проверка отрисовки).

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

// Только табель владельца (users/<owner>/apps/tabel): в приложение может войти кто угодно со своим Google,
// и его папка не должна попасть в рассылку.
const owner = run('CONFIG.firebase.owner || ""');
if (!owner) console.log('::warning::В js/config.js не задан firebase.owner — берутся все табели в базе.');
const docs = (await db.collectionGroup('apps').get()).docs
  .filter((d) => d.id === 'tabel' && (!owner || d.ref.parent.parent?.id === owner));
if (!docs.length) { console.log('::warning::В Firestore нет табеля владельца — войдите в приложении в облако.'); process.exit(0); }

// ---------- Почта (необязательно) ----------
// Ящик-отправитель — секреты MAIL_USER и MAIL_PASS (пароль приложения, не обычный пароль),
// MAIL_HOST — если не Gmail (например smtp.yandex.ru). Получатели — в приложении: «Настройки» → «Почта».
const { MAIL_USER, MAIL_PASS, MAIL_HOST = 'smtp.gmail.com' } = process.env;
let mailer = null;
async function sendMail(to, subject, text, files) {
  if (!mailer) {
    const { createTransport } = (await import('nodemailer')).default;
    mailer = createTransport({ host: MAIL_HOST, port: 465, secure: true, auth: { user: MAIL_USER, pass: MAIL_PASS } });
  }
  const attachments = await Promise.all(files.map(async (f) => ({ filename: f.name, content: Buffer.from(await f.arrayBuffer()), contentType: f.type })));
  await mailer.sendMail({ from: { name: run('DB.data.settings.shiftName'), address: MAIL_USER }, to, subject, text, attachments });
}

const day = Number(run('Dates.today()').slice(8));
let failed = false;
for (const doc of docs) {
  load(doc.get('json'));
  const r = run('Reports.active()');
  const tg = run('Telegram.cfg()');
  const mail = run('DB.data.settings.mail || {}');
  const mailTo = String(mail.to || '').split(/[\s,;]+/).filter(Boolean);
  const st = run(`DB.data.reports.find((x) => x.id === ${JSON.stringify(r.id)}) || {}`);
  const test = MODE === 'test';

  // Общие причины не отправлять ничего
  const why = test ? ''
    : ![1, 16].includes(day) ? 'сегодня не 1-е и не 16-е'
      : run('Tabel.peopleOf(Reports.active().ym).length') === 0 ? 'в табеле нет людей'
        : st.dismissed ? 'скрыто в приложении' : '';
  if (why) { console.log(`${r.id}: пропуск — ${why}`); continue; }

  // Telegram
  const tgWhy = !run('Telegram.ready()') ? 'бот не подключён'
    : test ? ''
      : tg.auto === false ? 'автоотправка выключена в приложении'
        : r.start < (tg.since || '') ? 'бот подключён позже начала этого снимка'
          : st.sentAt || st.tgSentAt ? 'уже отправлено' : '';
  // Почта
  const mailWhy = !mailTo.length ? 'адреса не заданы в приложении'
    : !MAIL_USER || !MAIL_PASS ? 'не заданы секреты MAIL_USER и MAIL_PASS'
      : test ? ''
        : mail.auto === false ? 'автоотправка выключена в приложении'
          : st.mailSentAt ? 'уже отправлено' : '';
  if (mailTo.length && (!MAIL_USER || !MAIL_PASS)) console.log('::warning::Адреса для почты заданы, но нет секретов MAIL_USER и MAIL_PASS — письмо не отправлено.');

  const prefix = test ? '🧪 Проверка отправки по расписанию. ' : '';
  const done = {};
  const now = () => new Date().toISOString();

  if (tgWhy) console.log(`${r.id}: Telegram — пропуск (${tgWhy})`);
  else {
    try {
      sandbox.__args = [r.ym, r.name, r.caption, prefix];
      await run('Reports.sendTelegram(...__args)');
      done.tgSentAt = now();
      // Журнал запусков публичный (репозиторий открытый) — без названий чатов, адресов и имён
      console.log(`${r.id}: Telegram — отправлено ${run('Telegram.fullReady()') ? 'в группу (картинка) и во второй чат (полностью)' : 'в группу'}`);
    } catch (e) {
      failed = true;
      console.log(`::error::${r.id}: Telegram — ${e.message}`);
    }
  }

  if (mailWhy) console.log(`${r.id}: почта — пропуск (${mailWhy})`);
  else {
    try {
      // На почту — только Excel (без картинки и примечаний)
      sandbox.__args = [r.ym, r.name];
      const files = [run('(() => { const x = Xlsx.build(__args[0]); return new File([x], `${__args[1]}.xlsx`, { type: x.type }); })()')];
      const subject = prefix + run(`Reports.periodCaption(${JSON.stringify(r.ym)})`);
      // «Смена 1 — табель за октябрь 2026, с 01 по 16.10» → «Во вложении табель за октябрь 2026, с 01 по 16.10 (Смена 1).»
      const shift = run('DB.data.settings.shiftName');
      const period = subject.slice(prefix.length).replace(`${shift} — табель `, '');
      const text = [
        prefix ? prefix.trim() : '',
        'Здравствуйте!',
        '',
        `Во вложении табель ${period} (${shift}).`,
        'Письмо отправлено автоматически.',
        ...(mail.sign ? ['', 'С уважением,', mail.sign] : []),
      ].filter((s, i) => i || s).join('\n');
      await sendMail(mailTo, subject, text, files);
      done.mailSentAt = now();
      console.log(`${r.id}: почта — отправлено (получателей: ${mailTo.length})`);
    } catch (e) {
      failed = true;
      // Текст ошибки SMTP может содержать адрес — в публичный журнал только код
      console.log(`::error::${r.id}: почта — не отправлено (${e.code || e.responseCode || 'ошибка'})${e.code === 'EAUTH' ? ': неверный MAIL_USER или пароль приложения MAIL_PASS' : ''}`);
    }
  }

  if (test || !Object.keys(done).length) continue;

  // Отметить в табеле, что снимок ушёл (в транзакции — вдруг приложение в этот момент что-то сохраняет)
  await db.runTransaction(async (t) => {
    const fresh = await t.get(doc.ref);
    const data = JSON.parse(fresh.get('json'));
    const at = now();
    data.reports = Array.isArray(data.reports) ? data.reports : [];
    const i = data.reports.findIndex((x) => x.id === r.id);
    const prev = i >= 0 ? data.reports[i] : { id: r.id };
    const next = { ...prev, ...done, ...(done.tgSentAt ? { sentAt: prev.sentAt || at } : {}), by: 'schedule' };
    if (i >= 0) data.reports[i] = next; else data.reports.push(next);
    data.updatedAt = at;
    t.set(doc.ref, { json: JSON.stringify(data), updatedAt: at, format: data.format });
  });
}
process.exit(failed ? 1 : 0);
