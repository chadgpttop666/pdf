// Подсветка читаемого места. Спаны текстового слоя не трогаем: подсветка
// рисуется отдельным слоем поверх страницы по координатам из Range API —
// так остаются целыми выделение мышью и подсветка поиска.

import { locateInSpan, textSpansOfPage } from '../visible-text.js';

const LAYER_CLASS = 'tts-highlight-layer';
const PAD_X = 2;
const PAD_Y = 1;

/**
 * Прямоугольники одной строки сливаем в одну полосу. В тексте с выравниванием
 * по ширине каждое слово — отдельный спан, и без слияния подсветка выглядит
 * как россыпь кирпичиков с дырками между словами.
 */
export function mergeRectsByLine(rects) {
  const lines = [];
  const sorted = [...rects].sort((a, b) => a.top - b.top || a.left - b.left);
  for (const rect of sorted) {
    const middle = (rect.top + rect.bottom) / 2;
    const line = lines.find((candidate) => middle > candidate.top && middle < candidate.bottom);
    if (line) {
      line.left = Math.min(line.left, rect.left);
      line.right = Math.max(line.right, rect.right);
      line.top = Math.min(line.top, rect.top);
      line.bottom = Math.max(line.bottom, rect.bottom);
    } else {
      lines.push({ left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom });
    }
  }
  return lines;
}

export function createHighlighter(app) {
  let currentPage = 0;
  const lastText = { sentence: '', word: '' };

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

  function rangeInSpan(span, from, to) {
    const start = locateInSpan(span, Math.max(0, from));
    const end = locateInSpan(span, Math.max(from, to));
    if (!start || !end) return null;
    const range = document.createRange();
    range.setStart(start.node, start.offset);
    range.setEnd(end.node, end.offset);
    return range.collapsed ? null : range;
  }

  /**
   * @param {number} pageNumber
   * @param {Array} entries карта символ→спан из text-index
   * @param {{start:number,end:number}} range диапазон символов страницы
   * @param {{ kind?: 'sentence'|'word' }} options
   * @returns {{ top: number, bottom: number } | null} границы в координатах окна
   */
  function highlight(pageNumber, entries, range, { kind = 'sentence' } = {}) {
    const pageView = pageViewOf(pageNumber);
    if (!pageView?.div) return null;

    if (currentPage && currentPage !== pageNumber) clearPage(currentPage);
    currentPage = pageNumber;

    const layer = layerFor(pageView);
    for (const box of layer.querySelectorAll(`.tts-${kind}-box`)) box.remove();

    const spans = textSpansOfPage(app, pageNumber);
    const rects = [];
    const texts = [];

    for (const entry of entries) {
      if (entry.end <= range.start || entry.start >= range.end) continue;
      const span = spans[entry.spanIndex];
      if (!span) continue;
      const from = Math.max(0, range.start - entry.start);
      const to = Math.min(entry.end - entry.start, range.end - entry.start);
      const domRange = rangeInSpan(span, from, to);
      if (!domRange) continue;
      texts.push(domRange.toString());
      for (const rect of domRange.getClientRects()) {
        if (rect.width && rect.height) rects.push(rect);
      }
    }

    lastText[kind] = texts.join(' ');
    if (!rects.length) return null;

    const pageRect = pageView.div.getBoundingClientRect();
    for (const line of mergeRectsByLine(rects)) {
      const box = document.createElement('div');
      box.className = `tts-${kind}-box`;
      box.style.left = `${line.left - pageRect.left - PAD_X}px`;
      box.style.top = `${line.top - pageRect.top - PAD_Y}px`;
      box.style.width = `${line.right - line.left + PAD_X * 2}px`;
      box.style.height = `${line.bottom - line.top + PAD_Y * 2}px`;
      layer.append(box);
    }

    return {
      top: Math.min(...rects.map((rect) => rect.top)),
      bottom: Math.max(...rects.map((rect) => rect.bottom)),
    };
  }

  function clearPage(pageNumber) {
    pageViewOf(pageNumber)?.div?.querySelector(`.${LAYER_CLASS}`)?.remove();
  }

  function clear() {
    for (const layer of document.querySelectorAll(`.${LAYER_CLASS}`)) layer.remove();
    currentPage = 0;
    lastText.sentence = '';
    lastText.word = '';
  }

  return {
    highlight,
    clear,
    clearWords(pageNumber = currentPage) {
      for (const box of pageViewOf(pageNumber)?.div?.querySelectorAll('.tts-word-box') || []) box.remove();
      lastText.word = '';
    },
    /** Текст, который сейчас подсвечен, — по нему тесты сверяют точность подсветки. */
    lastText(kind = 'sentence') {
      return lastText[kind];
    },
    get currentPage() {
      return currentPage;
    },
  };
}
