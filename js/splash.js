// ================= Заставка при запуске (только телефон в портрете) =================
// Разметка — #splash в начале index.html, стили — css/splash.css.
// Скрипт стоит сразу после #splash, до скриптов приложения, поэтому срабатывает только при холодном старте
// (загрузке страницы); возврат в уже открытое приложение страницу не перезагружает — заставки нет.
// Держится не меньше MIN и до события load (скрипты приложения выполнены), но не дольше MAX —
// даже если картинка не загрузилась. Ошибка здесь не должна мешать приложению: всё в try.
(() => {
  const el = document.getElementById('splash');
  if (!el) return;
  try {
    if (!matchMedia('(max-width: 600px) and (orientation: portrait)').matches) { el.remove(); return; }

    const MIN = 2500, MAX = 6000;
    const t0 = performance.now();
    // Картинки — только на телефоне (на планшете и компьютере не скачиваются)
    el.querySelectorAll('img[data-src]').forEach((img) => { img.src = img.dataset.src; });
    el.classList.add('is-on');

    // Строка состояния Android — в цвет заставки, после — обратно в цвет шапки
    const meta = document.querySelector('meta[name="theme-color"]');
    const color = meta?.content;
    if (meta) meta.content = '#3b8f7c';

    let closed = false;
    const close = () => {
      if (closed) return;
      closed = true;
      if (meta) meta.content = color;
      el.classList.add('is-out');
      setTimeout(() => el.remove(), 600);
    };
    const ready = () => setTimeout(close, Math.max(0, MIN - (performance.now() - t0)));
    if (document.readyState === 'complete') ready(); else window.addEventListener('load', ready, { once: true });
    setTimeout(close, MAX);
  } catch (e) {
    el.remove();
  }
})();
