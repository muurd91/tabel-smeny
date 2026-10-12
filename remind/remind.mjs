// ================= Напоминания мастеру в Telegram =================
// Запускается планировщиком GitHub (.github/workflows/remind.yml) дважды в день.
// Утром: если сегодня дневная смена — «отметь отсутствующих»; 16-го и 1-го — «уходит табель».
// Вечером: если сегодня ночная смена — «отметь отсутствующих».
// Табеля и имён здесь нет: только график, токен бота и личный чат мастера (секреты репозитория).

const {
  TG_TOKEN, TG_CHAT,
  ANCHOR = '2026-09-01', CYCLE = 'ДДННВВВВ', TZ_OFFSET = '3',
  APP_URL = '', SHIFT_NAME = 'Смена 1', MODE = 'auto',
} = process.env;

if (!TG_TOKEN || !TG_CHAT) {
  console.error('Не заданы секреты TG_TOKEN и TG_CHAT (Settings → Secrets and variables → Actions).');
  process.exit(1);
}

// Местное время мастера (по умолчанию UTC+3 — Беларусь, без перехода на летнее время)
const local = new Date(Date.now() + Number(TZ_OFFSET) * 3600e3);
const iso = local.toISOString().slice(0, 10);
const hour = local.getUTCHours();
const day = Number(iso.slice(8));

const dayNum = (s) => { const [y, m, d] = s.split('-').map(Number); return Date.UTC(y, m - 1, d) / 864e5; };
const n = CYCLE.length;
const type = CYCLE[(((dayNum(iso) - dayNum(ANCHOR)) % n) + n) % n]; // Д | Н | В

const MONTHS = ['январь', 'февраль', 'март', 'апрель', 'май', 'июнь', 'июль', 'август', 'сентябрь', 'октябрь', 'ноябрь', 'декабрь'];
const dm = `${iso.slice(8)}.${iso.slice(5, 7)}`;
const link = APP_URL ? `\n${APP_URL}` : '';

const messages = [];
if (MODE === 'test') {
  messages.push(`🔔 Проверка напоминаний: работают. Сегодня ${dm} у смены — ${type === 'Д' ? 'дневная' : type === 'Н' ? 'ночная' : 'выходной'}.${link}`);
} else if (hour < 14) {
  if (type === 'Д') messages.push(`☀️ ${SHIFT_NAME}: дневная смена ${dm}. Отметь, кого нет.${link}`);
  if (day === 16) messages.push(`📋 Сегодня 16-е — табель за ${MONTHS[local.getUTCMonth()]} уходит в группу. Открой приложение.${link}`);
  if (day === 1) messages.push(`📋 Сегодня 1-е — итоговый табель за ${MONTHS[(local.getUTCMonth() + 11) % 12]} уходит в группу. Проверь последние отметки и открой приложение.${link}`);
} else if (type === 'Н') {
  messages.push(`🌙 ${SHIFT_NAME}: ночная смена ${dm}. Отметь, кого нет.${link}`);
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
console.log(`${iso} ${String(hour).padStart(2, '0')}:xx, смена ${type}: отправлено ${messages.length}`);
