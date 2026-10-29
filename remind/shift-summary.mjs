// ================= Итог смены в Telegram: сколько и чего сдали =================
// Запускается в 7:25 (итог ночной смены) и в 19:25 (итог дневной) — точно в срок от cron-job.org (workflow shift-summary.yml),
// расписание GitHub там запасное. Берёт записи работников (Firestore, коллекция shipments, страница /work/) за смену,
// которая вот-вот закончится, и шлёт сводку ТОЛЬКО в личный чат мастера («Уведомления мне»).
// Бот и чат — из настроек приложения (users/<owner>/apps/tabel); повторный запуск той же смены промолчит (отметка в remind-log).
//
// MODE: auto — как по расписанию (пропуск, если опоздал более чем на 60 минут или пришёл рано);
//       test — прислать сводку текущей смены сейчас, ничего не отмечая.
// SLOT: morning | evening (или строка расписания GitHub).

import fs from 'node:fs';

const { FIREBASE_SA, MODE = 'auto', TZ_OFFSET = '3' } = process.env;
if (!FIREBASE_SA) { console.log('::warning::Нет секрета FIREBASE_SA — итог смены не отправлен.'); process.exit(0); }

const { initializeApp, cert } = await import('firebase-admin/app');
const { getFirestore } = await import('firebase-admin/firestore');
initializeApp({ credential: cert(JSON.parse(FIREBASE_SA)) });
const db = getFirestore();

// Владелец — из js/config.js (в приложение может войти кто угодно со своим Google)
const owner = (fs.readFileSync(new URL('../js/config.js', import.meta.url), 'utf8').match(/owner:\s*'([^']*)'/) || [])[1] || '';
const tabelDoc = (await db.collectionGroup('apps').get()).docs.find((d) => d.id === 'tabel' && (!owner || d.ref.parent.parent?.id === owner));
if (!tabelDoc) { console.log('::warning::В Firestore нет табеля владельца — итог смены не отправлен.'); process.exit(0); }
const settings = JSON.parse(tabelDoc.get('json')).settings || {};
const tg = settings.telegram || {};
const TOKEN = tg.token;
const CHAT = tg.meId; // только личный чат, никогда не группа
if (!TOKEN || !CHAT) { console.log('::warning::Не подключён Telegram или личный чат («Настройки» → Telegram → «Уведомления мне»).'); process.exit(0); }
const shiftName = settings.shiftName || 'Смена 1';

// Местное время (по умолчанию UTC+3 — Беларусь)
const local = new Date(Date.now() + Number(TZ_OFFSET) * 3600e3);
const pad = (n) => String(n).padStart(2, '0');
const isoOf = (d) => d.toISOString().slice(0, 10);
const minutes = local.getUTCHours() * 60 + local.getUTCMinutes();

const SLOTS = { '25 4 * * *': 'morning', '25 16 * * *': 'evening', morning: 'morning', evening: 'evening' };
const slot = SLOTS[process.env.SLOT] || (minutes < 12 * 60 ? 'morning' : 'evening');
const AT = { morning: 7 * 60 + 25, evening: 19 * 60 + 25 };
const lateBy = minutes - AT[slot];
if (MODE !== 'test' && (lateBy > 60 || lateBy < -30)) {
  console.log(`${isoOf(local)}: ${slot} — пропуск, запуск не вовремя (${lateBy > 0 ? `опоздание ${lateBy} мин` : 'слишком рано'})`);
  process.exit(0);
}

// Какая смена: утром — ночная, начавшаяся вчера; вечером — дневная сегодняшняя.
// В режиме проверки — та, что идёт сейчас (с 7:30 дневная, с 19:30 ночная, до 7:30 вчерашняя ночная).
let day = new Date(local);
day.setUTCHours(0, 0, 0, 0);
let night;
if (MODE === 'test') {
  night = minutes >= 19 * 60 + 30 || minutes < 7 * 60 + 30;
  if (minutes < 7 * 60 + 30) day = new Date(day.getTime() - 864e5);
} else if (slot === 'morning') {
  night = true;
  day = new Date(day.getTime() - 864e5);
} else night = false;
const shiftId = `${isoOf(day)}${night ? 'Н' : 'Д'}`;

// Уже отправляли итог этой смены (сработали и будильник, и запасное расписание GitHub)
const logRef = tabelDoc.ref.parent.doc('remind-log');
const logKey = `summary|${shiftId}`;
if (MODE !== 'test' && (await logRef.get()).data()?.[logKey]) { console.log(`${logKey}: пропуск — уже отправлено`); process.exit(0); }

// ---------- Сводка ----------
const entries = (await db.collection('shipments').where('shift', '==', shiftId).get()).docs
  .map((d) => d.data()).sort((a, b) => String(a.at).localeCompare(String(b.at)));
// Это смена нашей бригады по графику (Д/Н/В из настроек приложения)? Чужая смена без записей — итога нет:
// иначе в 19:25 в ночную очередь пришло бы пустое «Записей нет» про дневную смену другой бригады.
const cycle = settings.cycle || 'ДДННВВВВ';
const anchor = settings.anchor || '2026-09-01';
const dayNum = (s) => { const [y, m, d] = s.split('-').map(Number); return Date.UTC(y, m - 1, d) / 864e5; };
const mine = cycle[(((dayNum(isoOf(day)) - dayNum(anchor)) % cycle.length) + cycle.length) % cycle.length] === (night ? 'Н' : 'Д');
if (MODE !== 'test' && !mine && !entries.length) {
  console.log(`${shiftId}: пропуск — не наша смена по графику, записей нет`);
  process.exit(0);
}
const hhmm = (iso) => { const t = new Date(new Date(iso).getTime() + Number(TZ_OFFSET) * 3600e3); return `${pad(t.getUTCHours())}:${pad(t.getUTCMinutes())}`; };
const num = (n) => String(n).replace('.', ',');
const nameOf = (e) => (e.color ? `${e.product}, ${e.color}` : e.product);
const title = `${night ? 'ночную' : 'дневную'} смену ${pad(day.getUTCDate())}.${pad(day.getUTCMonth() + 1)} (${night ? '19:30–7:30' : '7:30–19:30'})`;

const lines = [`📦 ${shiftName} — сдано за ${title}`];
if (!entries.length) lines.push('', 'Записей нет — на странице для работников ничего не внесли.');
else {
  const sums = new Map();
  for (const e of entries) sums.set(nameOf(e), (sums.get(nameOf(e)) || 0) + e.qty);
  lines.push('');
  for (const [name, q] of sums) lines.push(`• ${name} — ${num(q)}`);
  lines.push('', `Всего коробок: ${num(entries.reduce((s, e) => s + e.qty, 0))}`, '', 'По времени отвоза:');
  for (const e of entries) lines.push(`${hhmm(e.at)} — ${nameOf(e)} — ${num(e.qty)}`);
}
let text = (MODE === 'test' ? '🧪 Проверка итога смены. ' : '') + lines.join('\n');
if (text.length > 4000) text = `${text.slice(0, 3990)}\n…`;

const res = await fetch(`https://api.telegram.org/bot${TOKEN}/sendMessage`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ chat_id: CHAT, text, disable_web_page_preview: true }),
});
const j = await res.json();
if (!j.ok) { console.error('Telegram:', j.description); process.exit(1); }
// В публичный журнал — только число записей, без названий и количеств
console.log(`${shiftId}: итог отправлен в личный чат (записей: ${entries.length})`);
if (MODE !== 'test') await logRef.set({ [logKey]: new Date().toISOString() }, { merge: true });
