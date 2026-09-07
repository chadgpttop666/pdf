// Миниатюры страниц. В компонентах pdf.js их нет, поэтому рендерим сами —
// лениво, только для попавших в поле зрения плиток.

import { clear, el } from './dom.js';

const THUMB_WIDTH = 180;

export function createThumbnails(app) {
  const panel = document.getElementById('thumbsPanel');
  let observer = null;
  let pdfDocument = null;
  const rendered = new Set();

  function reset() {
    observer?.disconnect();
    observer = null;
    rendered.clear();
    clear(panel);
  }

  async function renderThumb(tile) {
    const pageNumber = Number(tile.dataset.pageNumber);
    if (rendered.has(pageNumber) || !pdfDocument) return;
    rendered.add(pageNumber);

    try {
      const page = await pdfDocument.getPage(pageNumber);
      const base = page.getViewport({ scale: 1 });
      const ratio = Math.min(window.devicePixelRatio || 1, 2);
      const viewport = page.getViewport({ scale: (THUMB_WIDTH / base.width) * ratio });

      const canvas = el('canvas');
      canvas.width = Math.ceil(viewport.width);
      canvas.height = Math.ceil(viewport.height);
      canvas.style.aspectRatio = `${base.width} / ${base.height}`;
      const context = canvas.getContext('2d', { alpha: false });
      context.fillStyle = '#ffffff';
      context.fillRect(0, 0, canvas.width, canvas.height);
      await page.render({ canvasContext: context, viewport, annotationMode: 0 }).promise;
      page.cleanup();

      tile.querySelector('.placeholder')?.replaceWith(canvas);
    } catch (error) {
      rendered.delete(pageNumber);
      console.warn('Миниатюра не отрисована', pageNumber, error);
    }
  }

  function build(document_) {
    reset();
    pdfDocument = document_;
    if (!pdfDocument) return;

    const grid = el('div', { class: 'thumb-grid' });
    for (let pageNumber = 1; pageNumber <= pdfDocument.numPages; pageNumber += 1) {
      const tile = el(
        'div',
        {
          class: 'thumb',
          dataset: { pageNumber: String(pageNumber) },
          onclick: () => app.pdfViewer.scrollPageIntoView({ pageNumber }),
        },
        [el('div', { class: 'placeholder' }), el('div', {}, String(pageNumber))]
      );
      grid.append(tile);
    }
    panel.append(grid);

    observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) renderThumb(entry.target);
        }
      },
      { root: panel, rootMargin: '200px' }
    );
    for (const tile of grid.children) observer.observe(tile);
    markCurrent(app.pdfViewer.currentPageNumber || 1);
  }

  function markCurrent(pageNumber) {
    for (const tile of panel.querySelectorAll('.thumb')) {
      tile.classList.toggle('current', Number(tile.dataset.pageNumber) === pageNumber);
    }
  }

  app.eventBus.on('documentopened', ({ pdfDocument: document_ }) => build(document_));
  app.eventBus.on('pagechanging', ({ pageNumber }) => markCurrent(pageNumber));

  return {
    build,
    markCurrent,
    /** Плитки рендерятся лениво, поэтому при открытии панели их надо подтолкнуть. */
    refresh() {
      for (const tile of panel.querySelectorAll('.thumb')) {
        const rect = tile.getBoundingClientRect();
        const panelRect = panel.getBoundingClientRect();
        if (rect.top < panelRect.bottom + 200 && rect.bottom > panelRect.top - 200) renderThumb(tile);
      }
      const current = panel.querySelector('.thumb.current');
      current?.scrollIntoView({ block: 'nearest' });
    },
  };
}
