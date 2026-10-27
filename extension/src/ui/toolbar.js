// Верхняя панель: номер страницы, масштаб, заголовок документа.

import { $, on } from '../dom.js';
import { get as getSetting, updateSettings } from '../settings.js';

const ZOOM_STEPS = [0.25, 0.33, 0.5, 0.67, 0.75, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4];

export function createToolbar(app) {
  const pageInput = $('pageNumber');
  const pageCount = $('pageCount');
  const zoomSelect = $('zoomSelect');
  const docTitle = $('docTitle');

  function setPageCount(total) {
    pageCount.textContent = `/ ${total}`;
    pageInput.max = String(total);
  }

  function syncZoomSelect() {
    const value = app.pdfViewer.currentScaleValue;
    const known = [...zoomSelect.options].some((option) => option.value === value);
    if (known) {
      zoomSelect.value = value;
      return;
    }
    // Промежуточный масштаб после Ctrl+колесо показываем как процент.
    const percent = `${Math.round(app.pdfViewer.currentScale * 100)}%`;
    let custom = zoomSelect.querySelector('option[data-custom]');
    if (!custom) {
      custom = new Option(percent, 'custom');
      custom.dataset.custom = '1';
      zoomSelect.append(custom);
    }
    custom.textContent = percent;
    custom.value = String(app.pdfViewer.currentScale);
    zoomSelect.value = custom.value;
  }

  function zoomBy(direction) {
    const scale = app.pdfViewer.currentScale;
    const next =
      direction > 0
        ? ZOOM_STEPS.find((step) => step > scale + 0.001)
        : [...ZOOM_STEPS].reverse().find((step) => step < scale - 0.001);
    if (!next) return;
    app.setZoom(String(next), { fromUser: true, announce: true });
  }

  on(pageInput, 'change', () => {
    const value = Number(pageInput.value);
    if (Number.isFinite(value)) app.pdfViewer.currentPageNumber = Math.min(Math.max(1, value), app.pdfViewer.pagesCount || 1);
  });
  on($('btnPrevPage'), 'click', () => app.pdfViewer.previousPage());
  on($('btnNextPage'), 'click', () => app.pdfViewer.nextPage());
  on($('btnZoomIn'), 'click', () => zoomBy(1));
  on($('btnZoomOut'), 'click', () => zoomBy(-1));
  on(zoomSelect, 'change', () => app.setZoom(zoomSelect.value, { fromUser: true }));

  app.eventBus.on('pagesinit', () => {
    setPageCount(app.pdfViewer.pagesCount);
    syncZoomSelect();
  });
  app.eventBus.on('pagechanging', ({ pageNumber }) => {
    if (document.activeElement !== pageInput) pageInput.value = String(pageNumber);
  });
  app.eventBus.on('scalechanging', () => syncZoomSelect());
  app.eventBus.on('documentopened', ({ title }) => {
    docTitle.textContent = title;
    docTitle.title = title;
    document.title = `${title} — PDF-читалка`;
  });

  return {
    zoomBy,
    setPageCount,
    syncZoomSelect,
    /** Масштаб по умолчанию для только что открытого документа. */
    applyDefaultZoom() {
      app.setZoom(getSetting('defaultZoom'), { remember: false });
    },
    rememberZoom(value) {
      updateSettings({ defaultZoom: value });
    },
  };
}
