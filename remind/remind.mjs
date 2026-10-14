// ================= Напоминания мастеру в Telegram =================
// Запускается планировщиком GitHub (.github/workflows/remind.yml) по расписанию.
// В 8:00: если сегодня дневная смена (7:30–19:30) — «отметь отсутствующих». 16-го и 1-го в 9:30 — «в 11:00 уйдёт табель».
// В 20:00: если сегодня ночная смена (19:30–7:30) — «отметь отсутствующих».
// К напоминанию о смене — кто сегодня не выйдет и кого не будет на следующей смене (больничный, отпуск, заявления).
//
// Данные — из Firestore (секрет FIREBASE_SA): график, бот и личный чат мастера берутся из настроек приложения.
// Без FIREBASE_SA — по-старому: график из ANCHOR/CYCLE ниже, бот и чат из секретов TG_TOKEN и TG_CHAT, без списка отсутствующих.

let {
  TG_TOKEN, TG_CHAT, FIREBASE_SA,
  ANCHOR = '2026-09-01', CYCLE = 'ДДННВВВВ', TZ_OFFSET = '3',
  APP_URL = '', SHIFT_NAME = 'Смена 1', MODE = 'auto',
} = process.env;

// ---------- Табель из Firestore ----------
let data = null;
let TIMES = { Д: '7:30–19:30', Н: '19:30–7:30' }; // время смен — из настроек приложения, если есть
let db = null; // Firestore — чтобы отметить отправленное напоминание (второй запуск того же напоминания промолчит)
let logRef = null;
if (FIREBASE_SA) {
  const { initializeApp, cert } = await import('firebase-admin/app');
  const { getFirestore } = await import('firebase-admin/firestore');
  initializeApp({ credential: cert(JSON.parse(FIREBASE_SA)) });
  // Только табель владельца (uid из js/config.js): в приложение может войти кто угодно со своим Google
  const fs = await import('node:fs');
  const owner = (fs.readFileSync(new URL('../js/config.js', import.meta.url), 'utf8').match(/owner:\s*'([^']*)'/) || [])[1] || '';
  if (!owner) console.log('::warning::В js/config.js не задан firebase.owner — берётся первый табель в базе.');
  db = getFirestore();
  const doc = (await db.collectionGroup('apps').get()).docs
    .find((d) => d.id === 'tabel' && (!owner || d.ref.parent.parent?.id === owner));
  if (doc) {
    data = JSON.parse(doc.get('json'));
    logRef = doc.ref.parent.doc('remind-log'); // users/<uid>/apps/remind-log: { '2026-10-14|evening': время }
    const s = data.settings || {};
    const tg = s.telegram || {};
    ANCHOR = s.anchor || ANCHOR;
    CYCLE = s.cycle || CYCLE;
    SHIFT_NAME = s.shiftName || SHIFT_NAME;
    TIMES = { Д: s.dayTime || TIMES.Д, Н: s.nightTime || TIMES.Н };
    TG_TOKEN = tg.token || TG_TOKEN;
    TG_CHAT = tg.meId || ''; // только личный чат мастера («Уведомления мне»), никогда не группа
  }
}

if (!TG_TOKEN || !TG_CHAT) {
  // Пока бот не настроен — не ошибка (иначе GitHub дважды в день шлёт письма о сбое).
  console.log('::warning::Напоминания не настроены: в приложении подключите Telegram и нажмите «Уведомления мне» (или добавьте секреты TG_TOKEN и TG_CHAT).');
  process.exit(0);
}

// Местное время мастера (по умолчанию UTC+3 — Беларусь, без перехода на летнее время)
const local = new Date(Date.now() + Number(TZ_OFFSET) * 3600e3);
const iso = local.toISOString().slice(0, 10);
const hour = local.getUTCHours();
const day = Number(iso.slice(8));

const dayNum = (s) => { const [y, m, d] = s.split('-').map(Number); return Date.UTC(y, m - 1, d) / 864e5; };
const isoOf = (n) => new Date(n * 864e5).toISOString().slice(0, 10);
const n = CYCLE.length;
const typeOf = (d) => CYCLE[(((dayNum(d) - dayNum(ANCHOR)) % n) + n) % n]; // Д | Н | В
const type = typeOf(iso);

const MONTHS = ['январь', 'февраль', 'март', 'апрель', 'май', 'июнь', 'июль', 'август', 'сентябрь', 'октябрь', 'ноябрь', 'декабрь'];
const dmOf = (d) => `${d.slice(8)}.${d.slice(5, 7)}`;
const dm = dmOf(iso);
const link = APP_URL ? `\n${APP_URL}` : '';

// ---------- Кого не будет ----------
const CODES = { 'Б': 'больничный', 'ОТ': 'отпуск', '-': 'отсутствие' };
const people = new Map((data?.people || []).map((p) => [p.id, p]));
const shortName = (p) => {
  const [f, i, o] = (p?.name || '').trim().split(/\s+/);
  return [f, i ? `${i[0]}.` : '', o ? `${o[0]}.` : ''].filter(Boolean).join(' ');
};
function absent(date) {
  return (data?.marks || [])
    .filter((m) => m.date === date && CODES[m.v] && people.has(m.pid))
    .map((m) => `• ${shortName(people.get(m.pid))} — ${m.reason || CODES[m.v]}`);
}
// Следующая смена после сегодняшней — через выходные, если они между
function nextShift(from) {
  for (let k = 1; k <= n; k++) {
    const d = isoOf(dayNum(from) + k);
    if (typeOf(d) !== 'В') return d;
  }
  return null;
}
function shiftMessage(icon, kind) {
  const time = TIMES[type] ? ` (${TIMES[type]})` : '';
  const lines = [`${icon} ${SHIFT_NAME}: ${kind} смена ${dm}${time}. Отметь, кого нет.`];
  if (data) {
    const today = absent(iso);
    if (today.length) lines.push('', 'Сегодня не будет:', ...today);
    const next = nextShift(iso);
    const later = next ? absent(next) : [];
    if (later.length) {
      const when = dayNum(next) - dayNum(iso) === 1 ? 'Завтра' : 'На следующей смене';
      lines.push('', `${when} (${dmOf(next)}, ${typeOf(next) === 'Д' ? 'день' : 'ночь'}) не будет:`, ...later);
    }
  }
  return lines.join('\n') + link;
}

// Какой запуск. SLOT — имя напоминания (morning | tabel | evening) от внешнего будильника (cron-job.org запускает
// workflow командой точно в срок) или строка расписания GitHub (запасной вариант: GitHub опаздывает на часы).
// Если ни то ни другое — по часу. 8:00 — дневная смена, 9:30 16-го и 1-го — о табеле, 20:00 — ночная смена.
const SLOTS = { '0 5 * * *': 'morning', '30 6 1,16 * *': 'tabel', '0 17 * * *': 'evening', morning: 'morning', tabel: 'tabel', evening: 'evening' };
const slot = SLOTS[process.env.SLOT] || (hour < 9 ? 'morning' : hour < 14 ? 'tabel' : 'evening');
const SLOT_AT = { morning: 8 * 60, tabel: 9 * 60 + 30, evening: 20 * 60 }; // минуты от полуночи, местное время
const lateBy = hour * 60 + local.getUTCMinutes() - SLOT_AT[slot];
if (MODE !== 'test' && (lateBy > 60 || lateBy < -30)) {
  // Опоздавший запуск (GitHub) бесполезен: «отметь ночную смену» в 3 часа ночи только сбивает
  console.log(`${iso}: ${slot} — пропуск, запуск не вовремя (${lateBy > 0 ? `опоздание ${lateBy} мин` : 'слишком рано'})`);
  process.exit(0);
}

const messages = [];
if (MODE === 'test') {
  messages.push(`🔔 Проверка напоминаний: работают. Сегодня ${dm} у смены — ${type === 'Д' ? 'дневная' : type === 'Н' ? 'ночная' : 'выходной'}.`);
  if (type !== 'В') messages.push(shiftMessage(type === 'Д' ? '☀️' : '🌙', type === 'Д' ? 'дневная' : 'ночная'));
} else if (slot === 'tabel') {
  if (day === 16) messages.push(`📋 Сегодня 16-е — в 11:00 табель за ${MONTHS[local.getUTCMonth()]} сам уйдёт в группу. Проверь отметки до этого времени.${link}`);
  if (day === 1) messages.push(`📋 Сегодня 1-е — в 11:00 итоговый табель за ${MONTHS[(local.getUTCMonth() + 11) % 12]} сам уйдёт в группу. Проверь последние отметки до этого времени.${link}`);
} else if (slot === 'morning') {
  if (type === 'Д') messages.push(shiftMessage('☀️', 'дневная'));
} else if (type === 'Н') {
  messages.push(shiftMessage('🌙', 'ночная'));
}

// Это напоминание сегодня уже ушло (сработали и будильник, и запасное расписание GitHub) — второй раз не слать
const logKey = `${iso}|${slot}`;
if (MODE !== 'test' && messages.length && logRef && (await logRef.get()).data()?.[logKey]) {
  console.log(`${logKey}: пропуск — уже отправлено`);
  process.exit(0);
}

for (const text of messages) {
  const res = await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: TG_CHAT, text, disable_web_page_preview: true }),
  });
  const j = await res.json();
  if (!j.ok) { console.error('Telegram:', j.description); process.exit(1); }
}
console.log(`${iso} ${String(hour).padStart(2, '0')}:xx, смена ${type}${data ? ', данные из Firestore' : ''}: отправлено ${messages.length}`);
if (MODE !== 'test' && messages.length && logRef) await logRef.set({ [logKey]: new Date().toISOString() }, { merge: true });
