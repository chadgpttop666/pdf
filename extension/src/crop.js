// Обрезка полей страницы. Поля считаются один раз по выборке страниц и
// применяются ко всему документу: так вёрстка не прыгает при прокрутке,
// а код остаётся простым — вся обрезка это четыре CSS-переменные.

import { detectContentBox, medianBox } from './crop-math.js';

const EMPTY_BOX = { left: 0, right: 0, top: 0, bottom: 0 };
const SAMPLE_WIDTH = 220;

export function createCrop(app) {
  let box = { ...EMPTY_BOX };
  let enabled = false;
  const listeners = new Set();

  function notify() {
    for (const listener of listeners) listener({ box: { ...box }, enabled });
  }

  /** Выставляет размеры обрезки в пикселях текущего рендера страницы. */
  function apply() {
    const viewer = app.viewerEl;
    app.el.classList.toggle('crop-on', enabled);
    if (!enabled) {
      for (const name of ['--crop-l', '--crop-r', '--crop-t', '--crop-b']) viewer.style.removeProperty(name);
      return;
    }
    const pageView =
      app.pdfViewer.getPageView(app.pdfViewer.currentPageNumber - 1) || app.pdfViewer.getPageView(0);
    const div = pageView?.div;
    if (!div) return;
    const width = div.clientWidth;
    const height = div.clientHeight;
    viewer.style.setProperty('--crop-l', `${(box.left * width).toFixed(2)}px`);
    viewer.style.setProperty('--crop-r', `${(box.right * width).toFixed(2)}px`);
    viewer.style.setProperty('--crop-t', `${(box.top * height).toFixed(2)}px`);
    viewer.style.setProperty('--crop-b', `${(box.bottom * height).toFixed(2)}px`);
  }

  /**
   * Рендерит несколько страниц в маленький холст и ищет границы содержимого.
   * Берём страницы равномерно по документу: первая часто титульная.
   */
  async function detect({ sampleSize = 8 } = {}) {
    const pdfDocument = app.loader.pdfDocument;
    if (!pdfDocument) return null;

    const total = pdfDocument.numPages;
    const step = Math.max(1, Math.floor(total / sampleSize));
    const pageNumbers = [];
    for (let number = 1; number <= total && pageNumbers.length < sampleSize; number += step) {
      pageNumbers.push(number);
    }

    const canvas = document.createElement('canvas');
    const context = canvas.getContext('2d', { willReadFrequently: true });
    const boxes = [];

    for (const number of pageNumbers) {
      try {
        const page = await pdfDocument.getPage(number);
        const base = page.getViewport({ scale: 1 });
        const viewport = page.getViewport({ scale: SAMPLE_WIDTH / base.width });
        canvas.width = Math.ceil(viewport.width);
        canvas.height = Math.ceil(viewport.height);
        context.fillStyle = '#ffffff';
        context.fillRect(0, 0, canvas.width, canvas.height);
        await page.render({ canvasContext: context, viewport, annotationMode: 0 }).promise;
        const { data } = context.getImageData(0, 0, canvas.width, canvas.height);
        boxes.push(detectContentBox(data, canvas.width, canvas.height));
        page.cleanup();
      } catch (error) {
        console.warn('Не удалось проанализировать поля страницы', number, error);
      }
    }

    return medianBox(boxes);
  }

  async function autoDetect({ silent = false } = {}) {
    if (!app.loader.pdfDocument) return null;
    if (!silent) app.hud.show('Определяю поля…', { duration: 4000 });
    const detected = await detect();
    if (!detected) {
      if (!silent) app.hud.show('Поля определить не удалось');
      return null;
    }
    box = detected;
    apply();
    notify();
    if (!silent) {
      const percent = (value) => `${Math.round(value * 100)}%`;
      app.hud.show(
        `Поля: слева ${percent(box.left)}, справа ${percent(box.right)}, сверху ${percent(box.top)}, снизу ${percent(box.bottom)}`,
        { duration: 2500 }
      );
    }
    return box;
  }

  return {
    get box() {
      return { ...box };
    },
    get enabled() {
      return enabled;
    },
    setBox(next, { apply: shouldApply = true } = {}) {
      box = { ...EMPTY_BOX, ...next };
      if (shouldApply) apply();
      notify();
    },
    setEnabled(value) {
      enabled = Boolean(value);
      apply();
      notify();
    },
    reset() {
      box = { ...EMPTY_BOX };
      apply();
      notify();
    },
    apply,
    detect,
    autoDetect,
    onChange(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
