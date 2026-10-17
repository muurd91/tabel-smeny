// ================= Облако: Firebase (Firestore + вход через Google) =================
// Адаптер к DB (data.js). Локальная копия остаётся главной: без сети приложение пишет в неё,
// а Firestore хранит копию документа в users/<uid>/apps/tabel и досылает изменения сам, когда появится связь.
// В облаке документ лежит строкой JSON (поле json) — его же читает планировщик GitHub (remind/send.mjs).
//
// Библиотеки Firebase грузятся с gstatic.com по требованию (service worker кэширует их для офлайна).
// Конфиг Firebase — не секрет: доступ к данным закрыт правилами Firestore (только свой uid).

const Cloud = (() => {
  const cfg = CONFIG.firebase || {};
  const CDN = `https://www.gstatic.com/firebasejs/${cfg.sdk || '13.0.0'}`;
  const KEY_BASE = 'ts.fb.base'; // документ на момент последней сверки с облаком — для слияния

  const available = /^https?:$/.test(location.protocol) && !!cfg.apiKey;

  let fb = null;          // { app, auth, fs, au, db }
  let user = null;
  let unsub = null;
  let status = 'idle';    // 'idle' | 'syncing' | 'offline' | 'cloudError'
  let lastError = '';
  let lastSync = null;
  let pushTimer = null;
  let firstSnap = true;
  const listeners = [];
  const emit = () => listeners.forEach((fn) => fn());

  const loadBase = () => { try { return JSON.parse(localStorage.getItem(KEY_BASE) || 'null'); } catch { return null; } };
  let base = loadBase();
  const setBase = (doc) => {
    base = JSON.parse(JSON.stringify(doc));
    try { localStorage.setItem(KEY_BASE, JSON.stringify(base)); } catch {}
  };

  // ---------- Слияние ----------
  // Каноничная строка: одинаковые по смыслу документы совпадают независимо от порядка ключей.
  const canon = (x) => JSON.stringify(x, (k, v) => (v && typeof v === 'object' && !Array.isArray(v)
    ? Object.fromEntries(Object.keys(v).sort().map((key) => [key, v[key]]))
    : v));

  // Трёхстороннее слияние. base — документ на момент последней успешной синхронизации (может быть null:
  // тогда записи только объединяются, удалений не видно).
  //  · запись есть в базе и пропала у одной из сторон — её удалили, удаление выигрывает
  //    (если вторая сторона успела её изменить — выигрывает правка);
  //  · запись изменена только на одной стороне — берём изменённую; на обеих — побеждает более новый документ;
  //  · запись новая (нет в базе) — добавляется.
  // Скалярные поля и вложенные объекты (смена, настройки) сливаются так же по целому значению.
  const same = (x, y) => canon(x) === canon(y);
  const keyOf = (item) => (item && item.id !== undefined ? `id:${item.id}` : `json:${canon(item)}`);

  function mergeList(L, R, B, localIsNewer) {
    const index = (list) => new Map(list.map((x) => [keyOf(x), x]));
    const lm = index(L), rm = index(R), bm = B ? index(B) : null;
    const order = localIsNewer ? [...L, ...R] : [...R, ...L]; // порядок — по главному документу
    const seen = new Set();
    const out = [];
    for (const item of order) {
      const k = keyOf(item);
      if (seen.has(k)) continue;
      seen.add(k);
      const l = lm.get(k), r = rm.get(k), bs = bm && bm.get(k);
      if (l && r) {
        if (bs && same(l, bs)) out.push(r);          // у нас не менялось — берём облачную
        else if (bs && same(r, bs)) out.push(l);     // в облаке не менялось — берём свою
        else out.push(localIsNewer ? l : r);
      } else if (l) {
        if (bs && same(l, bs)) continue;             // была в базе и не менялась, а в облаке исчезла — удалена там
        out.push(l);                                 // новая у нас (или правка против удаления)
      } else if (bs && same(r, bs)) continue;        // была в базе и не менялась, а у нас исчезла — удалена нами
      else out.push(r);                              // новая в облаке (или правка против удаления)
    }
    return out;
  }

  function mergeDocs(local, remote, baseDoc) {
    const localIsNewer = (local.updatedAt || '') > (remote.updatedAt || '');
    const newer = localIsNewer ? local : remote;
    const older = localIsNewer ? remote : local;
    const out = { ...newer, updatedAt: newer.updatedAt || older.updatedAt };
    const skip = new Set(['format', 'version', 'updatedAt']);
    for (const key of new Set([...Object.keys(local), ...Object.keys(remote)])) {
      if (skip.has(key)) continue;
      const L = local[key], R = remote[key], B = baseDoc ? baseDoc[key] : undefined;
      if (Array.isArray(L) && Array.isArray(R)) {
        out[key] = mergeList(L, R, Array.isArray(B) ? B : null, localIsNewer);
      } else if (baseDoc && B !== undefined && same(L, B)) {
        out[key] = R;                                // у нас не менялось — берём облачное
      } else if (baseDoc && B !== undefined && same(R, B)) {
        out[key] = L;                                // в облаке не менялось — берём своё
      } else {
        out[key] = newer[key];
      }
    }
    return out;
  }


  // ---------- Библиотеки ----------
  let loading = null;
  function load() {
    if (fb) return Promise.resolve(fb);
    loading ||= (async () => {
      const [app, auth, fs] = await Promise.all([
        import(`${CDN}/firebase-app.js`),
        import(`${CDN}/firebase-auth.js`),
        import(`${CDN}/firebase-firestore.js`),
      ]);
      // Своё имя подключения: «Журнал производства» на том же адресе (muurd91.github.io) и в том же проекте Firebase,
      // а вход браузер хранит по адресу + ключу + имени подключения. С именем по умолчанию вход был общий —
      // «Выйти» в журнале выкидывало и из табеля.
      const a = app.initializeApp(cfg, 'tabel');
      let db;
      try { db = fs.initializeFirestore(a, { localCache: fs.persistentLocalCache({ tabManager: fs.persistentMultipleTabManager() }) }); }
      catch { db = fs.getFirestore(a); }
      fb = { auth, fs, au: auth.getAuth(a), db };
      return fb;
    })().catch((e) => { loading = null; throw e; });
    return loading;
  }

  // ---------- Понятные ошибки ----------
  function explain(e) {
    const code = String(e?.code || '');
    const map = {
      'auth/unauthorized-domain': 'Этот адрес не разрешён для входа: в консоли Firebase → Authentication → Settings → Authorized domains добавьте muurd91.github.io.',
      'auth/operation-not-allowed': 'Этот способ входа не включён: в консоли Firebase → Authentication → Sign-in method.',
      'auth/network-request-failed': 'Нет связи с интернетом.',
      'auth/invalid-credential': 'Неверная почта или пароль.',
      'auth/wrong-password': 'Неверная почта или пароль.',
      'auth/user-not-found': 'Такого пользователя нет — отметьте «Создать вход».',
      'auth/invalid-email': 'Неверный адрес почты.',
      'auth/email-already-in-use': 'Вход с этой почтой уже есть — уберите «Создать вход».',
      'auth/weak-password': 'Пароль слишком короткий — нужно не меньше 6 символов.',
      'auth/too-many-requests': 'Слишком много попыток. Подождите несколько минут.',
      'permission-denied': 'Нет доступа к базе: проверьте правила Firestore (Rules).',
      'failed-precondition': 'База Firestore не создана или недоступна.',
      'unavailable': 'Нет связи с облаком.',
    };
    return map[code] || e?.message || String(e);
  }

  // ---------- Вход ----------
  async function signInGoogle() {
    lastError = '';
    try {
      const f = await load();
      const provider = new f.auth.GoogleAuthProvider();
      provider.setCustomParameters({ prompt: 'select_account' });
      try { await f.auth.signInWithPopup(f.au, provider); }
      catch (e) {
        // Окно входа заблокировано — переходим на страницу Google и обратно
        if (['auth/popup-blocked', 'auth/operation-not-supported-in-this-environment'].includes(e.code)) {
          await f.auth.signInWithRedirect(f.au, provider);
        } else throw e;
      }
    } catch (e) {
      if (!['auth/popup-closed-by-user', 'auth/cancelled-popup-request'].includes(e.code)) { lastError = explain(e); emit(); }
    }
  }

  // Запасной вход по почте и паролю; create — создать новый вход.
  async function signInEmail(email, password, create) {
    const f = await load();
    try {
      if (create) await f.auth.createUserWithEmailAndPassword(f.au, email, password);
      else await f.auth.signInWithEmailAndPassword(f.au, email, password);
      lastError = '';
    } catch (e) { throw new Error(explain(e)); }
  }

  async function signOut() {
    stop();
    if (fb) await fb.auth.signOut(fb.au).catch(() => {});
    user = null;
    base = null;
    try { localStorage.removeItem(KEY_BASE); } catch {}
    status = 'idle';
    emit();
  }

  // ---------- Синхронизация ----------
  const ref = () => fb.fs.doc(fb.db, 'users', user.uid, 'apps', 'tabel');

  function push() {
    clearTimeout(pushTimer);
    pushTimer = null;
    if (!user || !fb) return;
    const snap = JSON.parse(JSON.stringify(DB.data));
    status = 'syncing';
    emit();
    fb.fs.setDoc(ref(), { json: JSON.stringify(snap), updatedAt: snap.updatedAt || new Date().toISOString(), format: DATA_FORMAT })
      .then(() => { setBase(snap); lastSync = new Date().toISOString(); })
      .catch((e) => { status = 'cloudError'; lastError = explain(e); emit(); });
  }

  function stop() {
    unsub?.();
    unsub = null;
    clearTimeout(pushTimer);
    pushTimer = null;
  }

  function listen() {
    stop();
    firstSnap = true;
    status = 'syncing';
    emit();
    unsub = fb.fs.onSnapshot(ref(), { includeMetadataChanges: true }, (snap) => {
      const meta = snap.metadata;
      if (meta.hasPendingWrites) { status = 'syncing'; emit(); return; }
      if (meta.fromCache && firstSnap) { status = navigator.onLine ? 'syncing' : 'offline'; emit(); }
      if (!snap.exists()) {
        // Первый вход: в облаке пусто — выгружаем то, что есть на телефоне
        if (!meta.fromCache) push();
        return;
      }
      let remote;
      try { remote = normalizeData(JSON.parse(snap.data().json)); }
      catch (e) { status = 'cloudError'; lastError = `Данные в облаке не читаются: ${e.message}`; emit(); return; }

      const local = DB.data;
      if (canon(remote) !== canon(local)) {
        // Есть неотправленная правка или это первая сверка устройства — сливаем, иначе берём облачное
        const merged = pushTimer || !base ? mergeDocs(local, remote, base) : remote;
        if (canon(merged) !== canon(local)) DB.applyRemote(merged);
        if (canon(merged) !== canon(remote)) push();
      }
      if (!meta.fromCache) {
        setBase(remote);
        firstSnap = false;
        lastSync = new Date().toISOString();
        if (status !== 'cloudError') status = 'idle';
        emit();
      }
    }, (e) => { status = 'cloudError'; lastError = explain(e); emit(); });
  }

  // DB сообщает о каждом локальном изменении: отправляем пачкой через секунду.
  function localChange({ replaceAll = false } = {}) {
    if (!user) return;
    clearTimeout(pushTimer);
    pushTimer = setTimeout(push, replaceAll ? 0 : 800);
    status = 'syncing';
    emit();
  }

  // ---------- Состояние для индикатора ----------
  function state() {
    if (!available) return null;
    if (!user) return { state: 'local' };
    const s = { cloud: true, at: lastSync, pending: pushTimer ? 1 : 0 };
    if (status === 'cloudError') return { ...s, state: 'cloudError' };
    if (!navigator.onLine || status === 'offline') return { ...s, state: 'offline' };
    if (status === 'syncing' || pushTimer) return { ...s, state: 'syncing' };
    return { ...s, state: 'saved' };
  }

  const info = () => ({
    available,
    connected: !!user,
    account: user?.email || user?.displayName || '',
    uid: user?.uid || '',
    isOwner: !!user && (!cfg.owner || user.uid === cfg.owner),
    lastSync,
    error: lastError,
  });

  let started = false;
  async function init() {
    if (!available || started) return;
    started = true;
    try { await load(); }
    catch { started = false; status = 'offline'; emit(); return; } // без сети библиотека не загрузилась — повторим при появлении сети
    fb.auth.getRedirectResult(fb.au).catch((e) => { lastError = explain(e); emit(); });
    fb.auth.onAuthStateChanged(fb.au, (u) => {
      user = u;
      if (u) listen(); else stop();
      emit();
    });
  }
  window.addEventListener('online', () => { if (!started) init(); emit(); });
  window.addEventListener('offline', emit);

  return {
    available,
    init,
    signInGoogle,
    signInEmail,
    signOut,
    localChange,
    state,
    info,
    onChange: (fn) => listeners.push(fn),
  };
})();

DB.attachSync(Cloud);
