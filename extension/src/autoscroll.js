// Автопрокрутка в двух режимах: плавное движение с заданной скоростью и
// шаг на долю экрана через паузу. Второй режим — это ровно «выставить,
// насколько крутить вниз», первый удобнее для сплошного текста.

import { $, on } from './dom.js';
import { get as getSetting, onSettingsChanged, updateSettings } from './settings.js';
import { MAX_SPEED, MIN_SPEED, autoStepDistance, clampSpeed, nextAutoScrollTop, speedIncrement } from './scroll-math.js';

export function createAutoScroll(app) {
  // Прокручиваем ту область, что видна: страницы PDF или «только текст».
  const viewport = () => app.activeContainer;
  const bar = $('autoscrollBar');
  const toggleButton = $('asToggle');
  const speedInput = $('asSpeed');
  const stepInput = $('asStep');
  const intervalInput = $('asInterval');
  const modeSelect = $('asMode');

  let running = false;
  let frame = 0;
  let timer = 0;
  let lastTs = 0;
  let virtualTop = 0;

  function mode() {
    return getSetting('autoScrollMode');
  }

  function statusText() {
    if (mode() === 'step') {
      return `Автоскролл: ${getSetting('autoScrollStepPercent')}% экрана каждые ${getSetting('autoScrollIntervalSec')} с`;
    }
    return `Автоскролл: ${getSetting('autoScrollSpeed')} px/с`;
  }

  function syncUi() {
    app.icons.setIcon(toggleButton, running ? 'pause' : 'play');
    toggleButton.setAttribute('aria-pressed', String(running));
    $('btnAutoScroll').setAttribute('aria-pressed', String(running));
    $('btnAutoScroll').classList.toggle('active', running);

    const stepMode = mode() === 'step';
    $('asSpeedField').hidden = stepMode;
    $('asStepField').hidden = !stepMode;
    $('asIntervalField').hidden = !stepMode;

    modeSelect.value = mode();
    speedInput.value = String(getSetting('autoScrollSpeed'));
    stepInput.value = String(getSetting('autoScrollStepPercent'));
    intervalInput.value = String(getSetting('autoScrollIntervalSec'));
    $('asSpeedValue').textContent = `${getSetting('autoScrollSpeed')} px/с`;
    $('asStepValue').textContent = `${getSetting('autoScrollStepPercent')}% экрана`;
    $('asIntervalValue').textContent = `${getSetting('autoScrollIntervalSec')} с`;
  }

  function finishAtBottom() {
    stop();
    app.hud.show('Конец документа');
  }

  function continuousFrame(ts) {
    if (!running) return;
    const dtMs = lastTs ? ts - lastTs : 16;
    lastTs = ts;
    const container = viewport();

    // Если пользователь прокрутил сам или переключил вид, подхватываем позицию.
    if (Math.abs(container.scrollTop - virtualTop) > 2) virtualTop = container.scrollTop;

    const maxTop = Math.max(0, container.scrollHeight - container.clientHeight);
    virtualTop = nextAutoScrollTop({ top: virtualTop, maxTop, speed: getSetting('autoScrollSpeed'), dtMs });
    container.scrollTop = virtualTop;

    if (virtualTop >= maxTop - 0.5) {
      finishAtBottom();
      return;
    }
    frame = requestAnimationFrame(continuousFrame);
  }

  function scheduleStep() {
    clearTimeout(timer);
    timer = setTimeout(async () => {
      if (!running) return;
      const distance = autoStepDistance(viewport().clientHeight, getSetting('autoScrollStepPercent'));
      await app.scroller.scrollBy(distance, { smooth: true, duration: getSetting('scrollAnimationMs') });
      if (!running) return;
      if (app.scroller.atBottom) {
        finishAtBottom();
        return;
      }
      scheduleStep();
    }, getSetting('autoScrollIntervalSec') * 1000);
  }

  function start() {
    if (running) return;
    if (!app.loader?.pdfDocument) {
      app.hud.show('Сначала откройте документ');
      return;
    }
    running = true;
    bar.hidden = false;
    virtualTop = viewport().scrollTop;
    lastTs = 0;
    if (mode() === 'step') scheduleStep();
    else frame = requestAnimationFrame(continuousFrame);
    app.wakeLock?.request();
    syncUi();
    app.hud.show(statusText(), { keep: true });
  }

  function stop() {
    if (!running) return;
    running = false;
    cancelAnimationFrame(frame);
    clearTimeout(timer);
    frame = 0;
    timer = 0;
    app.scroller.cancel();
    if (!app.tts?.isSpeaking) app.wakeLock?.release();
    syncUi();
    app.hud.hide();
  }

  function toggle() {
    if (running) stop();
    else start();
  }

  async function setSpeed(value) {
    await updateSettings({ autoScrollSpeed: clampSpeed(value) });
    syncUi();
    app.hud.show(statusText(), { keep: running });
  }

  function adjustSpeed(direction) {
    const speed = getSetting('autoScrollSpeed');
    setSpeed(speed + direction * speedIncrement(speed, direction));
  }

  function restartIfRunning() {
    if (!running) return;
    stop();
    start();
  }

  on(toggleButton, 'click', toggle);
  on($('btnAutoScroll'), 'click', () => {
    bar.hidden = false;
    toggle();
  });
  on($('asClose'), 'click', () => {
    bar.hidden = true;
  });
  on(speedInput, 'input', () => setSpeed(Number(speedInput.value)));
  on($('asSlower'), 'click', () => adjustSpeed(-1));
  on($('asFaster'), 'click', () => adjustSpeed(1));
  on(stepInput, 'input', async () => {
    await updateSettings({ autoScrollStepPercent: Number(stepInput.value) });
    syncUi();
  });
  on(intervalInput, 'input', async () => {
    await updateSettings({ autoScrollIntervalSec: Number(intervalInput.value) });
    syncUi();
    restartIfRunning();
  });
  on(modeSelect, 'change', async () => {
    await updateSettings({ autoScrollMode: modeSelect.value });
    syncUi();
    restartIfRunning();
  });

  // Ручное вмешательство останавливает автопрокрутку — иначе борьба с курсором.
  const stopOnUserInput = (event) => {
    if (!running || !getSetting('autoScrollStopOnInput')) return;
    if (event.type === 'wheel' && event.ctrlKey) return; // это масштабирование
    stop();
    app.hud.show('Автоскролл остановлен');
  };
  for (const container of [app.container, $('reflowContainer')]) {
    on(container, 'wheel', stopOnUserInput, { passive: true });
    on(container, 'touchstart', stopOnUserInput, { passive: true });
    on(container, 'mousedown', (event) => {
      // Клик по тексту не должен ронять автоскролл, а перетаскивание скроллбара — должно.
      if (event.offsetX > container.clientWidth) stopOnUserInput(event);
    });
  }

  onSettingsChanged((_all, changed) => {
    if ('autoScrollMode' in changed || 'autoScrollSpeed' in changed) syncUi();
  });

  syncUi();

  return {
    start,
    stop,
    toggle,
    setSpeed,
    adjustSpeed,
    showPanel() {
      bar.hidden = false;
    },
    get running() {
      return running;
    },
    limits: { min: MIN_SPEED, max: MAX_SPEED },
  };
}
