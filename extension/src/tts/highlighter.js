// Подсветка читаемого места. Спаны текстового слоя не трогаем: подсветка
// рисуется отдельным слоем поверх страницы по координатам из Range API —
// так остаются целыми выделение мышью и подсветка поиска.

const LAYER_CLASS = 'tts-highlight-layer';

export function createHighlighter(app) {
  let currentPage = 0;

  /** Спаны текстового слоя в том же порядке, в каком pdf.js складывал textDivs. */
  function textSpans(pageView) {
    const layer = pageView?.textLayer?.div;
    if (!layer) return [];
    return [...layer.querySelectorAll('span')].filter((span) => !span.classList.contains('markedContent'));
  }

  function pageViewOf(pageNumber) {
    return app.pdfViewer.getPageView(pageNumber - 1) || null;
  }

  function layerFor(pageView) {
    let layer = pageView.div.querySelector(`.${LAYER_CLASS}`);
    if (!layer) {
      layer = document.createElement('div');
      layer.className = LAYER_CLASS;
      pageView.div.append(layer);
    }
    return layer;
  }

  function rectsForRange(span, from, to) {
    const node = span.firstChild;
    if (!node || node.nodeType !== Node.TEXT_NODE) return [];
    const length = node.length;
    const start = Math.max(0, Math.min(from, length));
    const end = Math.max(start, Math.min(to, length));
    if (start === end) return [];
    const range = document.createRange();
    range.setStart(node, start);
    range.setEnd(node, end);
    return [...range.getClientRects()];
  }

  /**
   * @param {number} pageNumber
   * @param {Array} entries карта символ→спан из text-index
   * @param {{start:number,end:number}} range диапазон символов страницы
   * @param {{ kind?: 'sentence'|'word', keepSentence?: boolean }} options
   * @returns {{ top: number, bottom: number } | null} границы в координатах контейнера
   */
  function highlight(pageNumber, entries, range, { kind = 'sentence' } = {}) {
    const pageView = pageViewOf(pageNumber);
    if (!pageView?.div) return null;

    if (currentPage && currentPage !== pageNumber) clearPage(currentPage);
    currentPage = pageNumber;

    const layer = layerFor(pageView);
    for (const box of layer.querySelectorAll(`.tts-${kind}-box`)) box.remove();

    const spans = textSpans(pageView);
    const pageRect = pageView.div.getBoundingClientRect();
    let top = Infinity;
    let bottom = -Infinity;

    for (const entry of entries) {
      if (entry.end <= range.start || entry.start >= range.end) continue;
      const span = spans[entry.divIndex];
      if (!span) continue;
      const from = Math.max(0, range.start - entry.start);
      const to = Math.min(entry.end - entry.start, range.end - entry.start);
      for (const rect of rectsForRange(span, from, to)) {
        if (!rect.width || !rect.height) continue;
        const box = document.createElement('div');
        box.className = `tts-${kind}-box`;
        box.style.left = `${rect.left - pageRect.left}px`;
        box.style.top = `${rect.top - pageRect.top}px`;
        box.style.width = `${rect.width}px`;
        box.style.height = `${rect.height}px`;
        layer.append(box);
        top = Math.min(top, rect.top);
        bottom = Math.max(bottom, rect.bottom);
      }
    }

    return Number.isFinite(top) ? { top, bottom } : null;
  }

  function clearPage(pageNumber) {
    const pageView = pageViewOf(pageNumber);
    pageView?.div?.querySelector(`.${LAYER_CLASS}`)?.remove();
  }

  function clear() {
    for (const layer of document.querySelectorAll(`.${LAYER_CLASS}`)) layer.remove();
    currentPage = 0;
  }

  return {
    highlight,
    clear,
    clearWords(pageNumber = currentPage) {
      const pageView = pageViewOf(pageNumber);
      for (const box of pageView?.div?.querySelectorAll('.tts-word-box') || []) box.remove();
    },
    textSpans,
    get currentPage() {
      return currentPage;
    },
  };
}
