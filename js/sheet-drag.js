// Нижние окна (.sheet) закрываются свайпом вниз за «чёрточку» (.sheet__grip) — как в мобильных приложениях.
// Подключено и в приложении, и на странице работников. У окна «Доступно обновление» свайп = кнопка «Позже».
(() => {
  const CLOSE_DY = 110; // потянули дальше этого (px) — закрываем
  const CLOSE_V = 0.5; // или быстрый бросок вниз (px/мс)
  const reduce = matchMedia('(prefers-reduced-motion: reduce)');
  let g = null;

  function finish(dlg, close) {
    dlg.style.transition = '';
    dlg.style.transform = '';
    if (close) {
      const later = dlg.querySelector('[data-later], #update-later');
      if (later) later.click(); else dlg.close();
    }
  }

  document.addEventListener('pointerdown', (e) => {
    const grip = e.target.closest?.('.sheet__grip');
    if (!grip || g || (e.pointerType === 'mouse' && e.button !== 0)) return;
    const dlg = grip.closest('dialog');
    if (!dlg?.open) return;
    g = { dlg, id: e.pointerId, y0: e.clientY, dy: 0, v: 0, y: e.clientY, t: performance.now() };
    try { grip.setPointerCapture(e.pointerId); } catch { /* без захвата тоже работает */ }
    dlg.style.transition = 'none';
  });

  document.addEventListener('pointermove', (e) => {
    if (!g || e.pointerId !== g.id) return;
    const now = performance.now();
    if (now > g.t) g.v = 0.7 * g.v + 0.3 * ((e.clientY - g.y) / (now - g.t)); // сглаженная скорость
    g.y = e.clientY; g.t = now;
    g.dy = Math.max(0, e.clientY - g.y0);
    g.dlg.style.transform = `translateY(${g.dy}px)`;
  });

  function end(e) {
    if (!g || e.pointerId !== g.id) return;
    const { dlg, dy, v } = g;
    g = null;
    const close = e.type === 'pointerup' && (dy > CLOSE_DY || (v > CLOSE_V && dy > 20));
    if (reduce.matches || dy === 0) { finish(dlg, close); return; }
    dlg.style.transition = `transform .${close ? '2' : '25'}s ${close ? 'ease-in' : 'cubic-bezier(.2,.8,.2,1)'}`;
    dlg.style.transform = close ? `translateY(${dlg.offsetHeight}px)` : '';
    let done = false;
    const fin = () => { if (done) return; done = true; finish(dlg, close); };
    dlg.addEventListener('transitionend', fin, { once: true });
    setTimeout(fin, 320);
  }
  document.addEventListener('pointerup', end);
  document.addEventListener('pointercancel', end);
})();

// Шутка на кнопке «Позже» в окне обновления: трижды «не пускает», на третий раз сдаётся (работника не запираем).
// Использование: laterJoke(кнопка, функция «закрыть окно и напомнить позже»).
window.laterJoke = (btn, giveUp) => {
  const PHRASES = ['Позже нельзя, обновляй сейчас 😄', 'Серьёзно, это две секунды', 'Ладно, уговорил. Напомню позже'];
  const reduce = matchMedia('(prefers-reduced-motion: reduce)');
  let n = 0;
  btn.onclick = () => {
    if (n >= PHRASES.length) return; // уже сдались, окно закрывается
    let joke = btn.closest('.sheet__body').querySelector('.sheet__joke');
    if (!joke) {
      joke = document.createElement('p');
      joke.className = 'sheet__joke';
      joke.setAttribute('role', 'status');
      btn.closest('.sheet__actions').before(joke);
    }
    joke.textContent = PHRASES[n++];
    if (n < PHRASES.length) {
      if (!reduce.matches) btn.animate([{ transform: 'translateX(0)' }, { transform: 'translateX(-7px)' }, { transform: 'translateX(7px)' }, { transform: 'translateX(-5px)' }, { transform: 'translateX(5px)' }, { transform: 'translateX(0)' }], { duration: 380, easing: 'ease-in-out' });
      return;
    }
    btn.disabled = true;
    setTimeout(() => { n = 0; btn.disabled = false; joke.textContent = ''; giveUp(); }, 1400);
  };
};
