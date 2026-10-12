// ================= Telegram: отправка табеля в группу через бота =================
// Бот создаётся у @BotFather, его токен и группа хранятся в настройках (файл данных — личный, в OneDrive).
// Bot API отвечает с Access-Control-Allow-Origin: *, поэтому запросы идут прямо из приложения, без своего сервера.

const Telegram = (() => {
  const API = 'https://api.telegram.org';
  const cfg = () => DB.data.settings.telegram || {};
  const ready = () => !!(cfg().token && cfg().chatId);

  const fail = (message, extra = {}) => Object.assign(new Error(message), extra);

  function explain(j, status) {
    const d = String(j.description || '');
    if (status === 401 || /unauthorized/i.test(d)) return 'Telegram не принял токен бота — проверьте его.';
    if (/chat not found/i.test(d)) return 'Бот не видит группу — добавьте его в группу снова.';
    if (/kicked|not a member|bot was blocked/i.test(d)) return 'Бота удалили из группы — добавьте его снова.';
    if (/not enough rights|have no rights/i.test(d)) return 'Боту запрещено отправлять сообщения в группе — проверьте права.';
    if (status === 429) return 'Telegram просит подождать — отправка повторится позже.';
    return `Ошибка Telegram: ${d || status}`;
  }

  async function call(method, body, token = cfg().token) {
    let res;
    try { res = await fetch(`${API}/bot${token}/${method}`, { method: 'POST', body }); }
    catch { throw fail('Нет связи с Telegram.', { code: 'net' }); }
    const j = await res.json().catch(() => ({}));
    if (!j.ok) throw fail(explain(j, res.status), { migrate: j.parameters?.migrate_to_chat_id });
    return j.result;
  }

  const form = (obj) => {
    const fd = new FormData();
    for (const [k, v] of Object.entries(obj)) fd.append(k, v);
    return fd;
  };

  // Проверка токена → { username, first_name }
  const getMe = (token) => call('getMe', undefined, token);

  // Группы, где бот появился за последние сутки (Telegram хранит обновления 24 часа).
  async function findGroups(token) {
    const ups = await call('getUpdates', undefined, token);
    const chats = new Map();
    for (const u of ups) {
      const m = u.message || u.edited_message || u.my_chat_member || u.chat_member;
      const chat = m?.chat;
      if (!chat || !['group', 'supergroup'].includes(chat.type)) continue;
      if (u.my_chat_member && ['left', 'kicked'].includes(u.my_chat_member.new_chat_member?.status)) { chats.delete(chat.id); continue; }
      chats.set(chat.id, { id: chat.id, title: chat.title || 'Группа' });
      // Группа стала супергруппой — у неё новый id
      if (u.message?.migrate_to_chat_id) {
        chats.delete(chat.id);
        chats.set(u.message.migrate_to_chat_id, { id: u.message.migrate_to_chat_id, title: chat.title || 'Группа' });
      }
    }
    return [...chats.values()];
  }

  // Личные чаты с ботом (кто нажал «Старт») — для напоминаний мастеру.
  async function findPrivate(token = cfg().token) {
    const ups = await call('getUpdates', undefined, token);
    const chats = new Map();
    for (const u of ups) {
      const chat = (u.message || u.edited_message)?.chat;
      if (chat?.type === 'private') chats.set(chat.id, { id: chat.id, title: [chat.first_name, chat.last_name].filter(Boolean).join(' ') || chat.username || 'Вы' });
    }
    return [...chats.values()];
  }

  // Повтор с новым id, если группа превратилась в супергруппу.
  async function toChat(method, build) {
    try { return await call(method, build(cfg().chatId)); }
    catch (e) {
      if (!e.migrate) throw e;
      DB.update((d) => { d.settings.telegram = { ...d.settings.telegram, chatId: e.migrate }; });
      return call(method, build(e.migrate));
    }
  }

  const sendText = (text) => toChat('sendMessage', (chat_id) => form({ chat_id, text }));

  // Файлы одним сообщением-альбомом; документом, а не фото — иначе Telegram сожмёт картинку и цифры не прочитать.
  function sendFiles(files, caption) {
    return toChat('sendMediaGroup', (chat_id) => {
      const fd = form({ chat_id });
      const media = files.map((f, i) => ({ type: 'document', media: `attach://f${i}`, ...(i === files.length - 1 ? { caption } : {}) }));
      fd.append('media', JSON.stringify(media));
      files.forEach((f, i) => fd.append(`f${i}`, f, f.name));
      return fd;
    });
  }

  return { ready, cfg, getMe, findGroups, findPrivate, sendText, sendFiles };
})();
