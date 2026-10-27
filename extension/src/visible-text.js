// Работа со спанами текстового слоя pdf.js: какие из них соответствуют
// кускам текста, где сейчас взгляд читателя, куда пришёлся щелчок.
// Нужна озвучке (подсветка, место старта) и закладкам (подпись).

/**
 * Настоящий текстовый спан — тот, что pdf.js вставил для непустого куска.
 * Контейнеры markedContent — служебные, а подсветка поиска вкладывает свои
 * спаны внутрь текстовых; ни те, ни другие кусками текста не являются.
 */
function isTextSpan(element) {
  if (element.tagName !== 'SPAN' || element.classList.contains('markedContent')) return false;
  return !element.parentElement?.closest('span:not(.markedContent)');
}

export function textSpansIn(layer) {
  return layer ? [...layer.querySelectorAll('span')].filter(isTextSpan) : [];
}

export function textSpansOfPage(app, pageNumber) {
  return textSpansIn(app.pdfViewer.getPageView(pageNumber - 1)?.textLayer?.div);
}

/** Текстовый спан, внутри которого лежит узел (например, точка щелчка). */
export function textSpanOf(node) {
  let element = node?.nodeType === Node.TEXT_NODE ? node.parentElement : node;
  while (element && !element.classList?.contains('textLayer')) {
    if (isTextSpan(element)) return element;
    element = element.parentElement;
  }
  return null;
}

/**
 * Текстовый узел и смещение в нём для позиции внутри спана. Внутри спана
 * может быть несколько узлов — поиск разрезает текст своей подсветкой.
 */
export function locateInSpan(span, offset) {
  const walker = document.createTreeWalker(span, NodeFilter.SHOW_TEXT);
  let remaining = offset;
  let last = null;
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (remaining <= node.length) return { node, offset: remaining };
    remaining -= node.length;
    last = node;
  }
  return last ? { node: last, offset: last.length } : null;
}

/** Обратное преобразование: смещение от начала спана до точки в узле. */
export function offsetInSpan(span, node, offset) {
  const walker = document.createTreeWalker(span, NodeFilter.SHOW_TEXT);
  let total = 0;
  for (let current = walker.nextNode(); current; current = walker.nextNode()) {
    if (current === node) return total + offset;
    total += current.length;
  }
  return 0;
}

/** Точка в тексте под курсором: страница, номер спана и смещение в нём. */
export function textPointAt(app, clientX, clientY, fallbackTarget) {
  let node = null;
  let offset = 0;
  const caret = document.caretPositionFromPoint?.(clientX, clientY);
  if (caret) {
    node = caret.offsetNode;
    offset = caret.offset;
  } else {
    const range = document.caretRangeFromPoint?.(clientX, clientY);
    node = range?.startContainer ?? null;
    offset = range?.startOffset ?? 0;
  }

  let span = textSpanOf(node);
  if (!span) {
    span = textSpanOf(fallbackTarget);
    node = null;
  }
  if (!span) return null;

  const pageNumber = Number(span.closest('.page')?.dataset.pageNumber);
  if (!pageNumber) return null;
  const spanIndex = textSpansOfPage(app, pageNumber).indexOf(span);
  if (spanIndex < 0) return null;
  const inSpan = node && node.nodeType === Node.TEXT_NODE ? offsetInSpan(span, node, offset) : 0;
  return { pageNumber, spanIndex, offsetInSpan: inSpan };
}

export function firstVisibleSpanIndex(app, pageNumber) {
  const spans = textSpansOfPage(app, pageNumber);
  const containerRect = app.container.getBoundingClientRect();
  for (let index = 0; index < spans.length; index += 1) {
    const rect = spans[index].getBoundingClientRect();
    if (rect.height && rect.bottom > containerRect.top + 4) return index;
  }
  return 0;
}

/** Доля прокрутки внутри страницы — по ней место чтения восстанавливается точнее номера страницы. */
export function pageOffsetRatio(app) {
  const pageNumber = app.pdfViewer.currentPageNumber || 1;
  const div = app.pdfViewer.getPageView(pageNumber - 1)?.div;
  if (!div) return { pageNumber, offsetRatio: 0 };
  const containerRect = app.container.getBoundingClientRect();
  const pageRect = div.getBoundingClientRect();
  const ratio = pageRect.height ? (containerRect.top - pageRect.top) / pageRect.height : 0;
  return { pageNumber, offsetRatio: Number(Math.max(-0.5, Math.min(1, ratio)).toFixed(4)) };
}
