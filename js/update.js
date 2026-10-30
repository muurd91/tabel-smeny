// ================= «Доступно обновление» =================
// Пока приложение открыто, раз в минуту и при возврате в него смотрим, не вышла ли на сайте версия новее запущенной
// (номер — meta app-version в index.html, его поднимает tools/bump.sh). Если вышла — окно с кнопкой «Обновить».
// Так на телефоне не остаётся старая копия, о которой никто не знает. Без сети проверка тихо пропускается.

(() => {
  const RUNNING = document.querySelector('meta[name="app-version"]')?.content || '';
  if (!RUNNING || location.protocol !== 'https:') return;

  let shown = false;
  let lastCheck = 0;

  function show(v) {
    shown = true;
    const dlg = document.createElement('dialog');
    dlg.className = 'sheet';
    dlg.innerHTML = `<div class="sheet__body">
      <div class="sheet__grip" tabindex="-1"></div>
      <h3>Доступно обновление</h3>
      <p class="sheet__sub">Вышла новая версия приложения (${v}), у вас ${RUNNING}. Нажмите «Обновить», чтобы продолжить работу с новой версией.</p>
      <div class="sheet__actions"><button class="btn" data-later type="button">Позже</button><button class="btn btn--primary" data-now type="button">Обновить</button></div>
    </div>`;
    document.body.appendChild(dlg);
    dlg.querySelector('[data-now]').onclick = async () => {
      try { for (const r of await navigator.serviceWorker.getRegistrations()) await r.update(); } catch { /* обновим и так */ }
      location.reload();
    };
    const later = () => {
      dlg.close();
      dlg.remove();
      setTimeout(() => { shown = false; check(); }, 30 * 60e3);
    };
    if (window.laterJoke) window.laterJoke(dlg.querySelector('[data-later]'), later); // шутка на кнопке «Позже» (js/sheet-drag.js)
    else dlg.querySelector('[data-later]').onclick = later;
    dlg.showModal();
  }

  async function check() {
    if (shown || Date.now() - lastCheck < 30e3) return;
    lastCheck = Date.now();
    try {
      const res = await fetch(`index.html?check=${Date.now()}`, { cache: 'no-store', headers: { Range: 'bytes=0-1023' } } /* номер версии — в самом начале страницы */);
      const v = ((await res.text()).match(/name="app-version" content="([^"]+)"/) || [])[1];
      if (v && v !== RUNNING) show(v);
    } catch { /* нет сети — проверим позже */ }
  }

  document.addEventListener('visibilitychange', () => { if (!document.hidden) check(); });
  setInterval(check, 60e3);
  setTimeout(check, 8000);
})();
