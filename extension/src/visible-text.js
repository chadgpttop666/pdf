// Где сейчас находится взгляд читателя: первый элемент текстового слоя,
// попавший в видимую часть окна. Нужен и озвучке (откуда читать), и
// закладкам (что писать в подпись).

export function textSpansOfPage(app, pageNumber) {
  const layer = app.pdfViewer.getPageView(pageNumber - 1)?.textLayer?.div;
  if (!layer) return [];
  return [...layer.querySelectorAll('span')].filter((span) => !span.classList.contains('markedContent'));
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
