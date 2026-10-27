// Закрепление вида: масштаб и положение по горизонтали фиксируются, страница
// двигается только вверх и вниз. Нужно при чтении в крупном масштабе, когда
// строка шире окна: без закрепления вид уезжает вбок от переходов по
// оглавлению, озвучки, случайного жеста тачпада.

import { $, on } from './dom.js';

const WHEEL_ZOOM_THRESHOLD = 60;

export function createViewLock(app) {
  const button = $('btnLock');
  let lock = null; // { scale, left }
  const listeners = new Set();

  function notify() {
    for (const listener of listeners) listener(lock ? { ...lock } : null);
  }

  function syncUi() {
    const locked = Boolean(lock);
    app.el.classList.toggle('view-locked', locked);
    button.classList.toggle('active', locked);
    button.setAttribute('aria-pressed', String(locked));
    app.icons?.setIcon(button, locked ? 'lock' : 'unlock');
    button.title = locked
      ? `Вид закреплён: ${Math.round(lock.scale * 100)}%. Щёлкните или нажмите L, чтобы открепить`
      : 'Закрепить масштаб и положение (L)';
    for (const id of ['zoomSelect', 'btnZoomIn', 'btnZoomOut']) $(id).disabled = locked;
  }

  function holdLeft() {
    if (lock && Math.abs(app.container.scrollLeft - lock.left) > 1) app.container.scrollLeft = lock.left;
  }

  function engage() {
    if (!app.loader.pdfDocument) {
      app.hud.show('Сначала откройте документ');
      return;
    }
    const scale = Number(app.pdfViewer.currentScale.toFixed(4));
    // Режим «по ширине» пересчитывается при изменении окна — превращаем его
    // в число, иначе масштаб продолжит меняться и после закрепления.
    app.setZoom(String(scale), { force: true });
    lock = { scale, left: Math.round(app.container.scrollLeft) };
    syncUi();
    notify();
    app.hud.show(`Вид закреплён на ${Math.round(scale * 100)}% — двигается только вниз. L — открепить`, {
      duration: 2600,
    });
  }

  function release({ silent = false } = {}) {
    if (!lock) return;
    lock = null;
    syncUi();
    notify();
    if (!silent) app.hud.show('Вид откреплён');
  }

  function toggle() {
    if (lock) release();
    else engage();
  }

  /** Сдвинуть закреплённый вид вбок, не снимая закрепления. */
  function nudge(direction) {
    const step = Math.round(app.container.clientWidth * 0.08) * direction;
    if (!lock) {
      app.container.scrollLeft += step;
      return;
    }
    const max = app.container.scrollWidth - app.container.clientWidth;
    lock.left = Math.max(0, Math.min(max, lock.left + step));
    app.container.scrollLeft = lock.left;
    notify();
  }

  function restore(saved) {
    if (!saved?.scale) {
      release({ silent: true });
      return;
    }
    lock = { scale: saved.scale, left: saved.left || 0 };
    app.setZoom(String(saved.scale), { force: true });
    syncUi();
    requestAnimationFrame(holdLeft);
  }

  on(button, 'click', toggle);
  on(app.container, 'scroll', holdLeft, { passive: true });

  // Ctrl+колесо масштабирует документ, а не весь интерфейс Firefox. Жест
  // тачпада присылает десятки мелких событий — копим их до порога.
  let wheelAccumulator = 0;
  on(
    app.container,
    'wheel',
    (event) => {
      if (!event.ctrlKey) return;
      event.preventDefault();
      if (lock) {
        app.hud.show('Масштаб закреплён — L, чтобы открепить');
        return;
      }
      wheelAccumulator += event.deltaY;
      if (Math.abs(wheelAccumulator) < WHEEL_ZOOM_THRESHOLD) return;
      app.toolbar.zoomBy(wheelAccumulator < 0 ? 1 : -1);
      wheelAccumulator = 0;
    },
    { passive: false }
  );

  app.eventBus.on('documentopened', () => release({ silent: true }));
  // Масштаб мог поменяться и не через нас (например, при восстановлении).
  app.eventBus.on('scalechanging', ({ scale }) => {
    if (lock && Math.abs(scale - lock.scale) > 0.001) app.pdfViewer.currentScale = lock.scale;
  });
  app.eventBus.on('pagerendered', holdLeft);

  syncUi();

  return {
    toggle,
    engage,
    release,
    nudge,
    restore,
    get locked() {
      return Boolean(lock);
    },
    get state() {
      return lock ? { ...lock } : null;
    },
    onChange(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
