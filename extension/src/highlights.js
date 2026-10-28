// Выделения маркером и заметки к ним, плюс экспорт конспекта в Markdown.
//
// Выделение хранится в координатах спанов текстового слоя (страница, номер
// спана, смещение в нём): эта система не зависит ни от масштаба, ни от того,
// выбрасываются ли колонтитулы, и одинаково переводится и в слой поверх
// страницы PDF, и в предложения режима «только текст».

import { $, clear, el, formatDate, on, safeFileName, saveBlob } from './dom.js';
import { icon } from './ui/icons.js';
import { cleanForSpeech, cleanedIndexForRaw, offsetToSpanPoint, spanPointToOffset } from './text-index.js';
import { locateInSpan, offsetInSpan, textSpansOfPage } from './visible-text.js';
import { mergeRectsByLine } from './tts/highlighter.js';

export const MARK_COLORS = { yellow: 'жёлтый', green: 'зелёный', blue: 'голубой', pink: 'розовый' };
const NOTE_SAVE_DELAY = 500;

export function createHighlights(app) {
  const toolbar = $('markToolbar');
  const noteInput = $('markNote');
  const deleteButton = $('markDelete');
  const list = $('highlightsPanel');

  let pendingRange = null; // свежее выделение мышью, ещё не превращённое в маркер
  let editingId = null; // выделение, которое сейчас правят
  let lastColor = 'yellow';
  let noteTimer = 0;
  let reflowFrame = 0;

  const items = () => app.readingState.record?.highlights || [];
  const index = () => app.tts?.textIndex;

  function byPosition(a, b) {
    const [pa, pb] = [a.pieces[0], b.pieces[0]];
    return pa.pageNumber - pb.pageNumber || pa.from.span - pb.from.span || pa.from.offset - pb.from.offset;
  }

  // ── Выделение → координаты ───────────────────────────────────────────

  function offsetAt(span, node, offset) {
    if (node.nodeType === Node.TEXT_NODE) return offsetInSpan(span, node, offset);
    return offset === 0 ? 0 : span.textContent.length; // граница пришлась на сам элемент
  }

  /** Выделение в обычном виде: по каждой странице первый и последний задетый спан. */
  function piecesFromPdf(range) {
    const pieces = [];
    for (const pageDiv of app.viewerEl.querySelectorAll('.page')) {
      if (!range.intersectsNode(pageDiv)) continue;
      const pageNumber = Number(pageDiv.dataset.pageNumber);
      let from = null;
      let to = null;
      textSpansOfPage(app, pageNumber).forEach((span, spanIndex) => {
        if (!range.intersectsNode(span)) return;
        const start = span.contains(range.startContainer) ? offsetAt(span, range.startContainer, range.startOffset) : 0;
        const end = span.contains(range.endContainer)
          ? offsetAt(span, range.endContainer, range.endOffset)
          : span.textContent.length;
        if (end <= start) return; // выделение лишь касается спана
        from ??= { span: spanIndex, offset: start };
        to = { span: spanIndex, offset: end };
      });
      if (from && to) pieces.push({ pageNumber, from, to });
    }
    return pieces;
  }

  /** Выделение в режиме текста: предложения → позиции в тексте страницы → спаны. */
  async function piecesFromReflow(range) {
    const byPage = new Map();
    for (const span of app.reflow.container.querySelectorAll('.rf-s')) {
      if (!range.intersectsNode(span)) continue;
      const length = span.textContent.length;
      const start = span.contains(range.startContainer) && range.startContainer.nodeType === Node.TEXT_NODE ? range.startOffset : 0;
      const end = span.contains(range.endContainer) && range.endContainer.nodeType === Node.TEXT_NODE ? range.endOffset : length;
      if (end <= start) continue;

      const pageNumber = Number(span.dataset.page);
      const page = await index().page(pageNumber);
      const sentence = page?.sentences[Number(span.dataset.s)];
      if (!sentence) continue;
      const { map } = cleanForSpeech(page.text.slice(sentence.start, sentence.end));
      const rawStart = sentence.start + (map[start] ?? 0);
      const rawEnd = sentence.start + (map[Math.max(0, end - 1)] ?? map.at(-1) ?? 0) + 1;
      const current = byPage.get(pageNumber) ?? { start: Infinity, end: -Infinity, entries: page.entries };
      current.start = Math.min(current.start, rawStart);
      current.end = Math.max(current.end, rawEnd);
      byPage.set(pageNumber, current);
    }
    return [...byPage].map(([pageNumber, bounds]) => ({
      pageNumber,
      from: offsetToSpanPoint(bounds.entries, bounds.start),
      to: offsetToSpanPoint(bounds.entries, bounds.end),
    }));
  }

  function selectionKind(range) {
    const node = range.commonAncestorContainer;
    const element = node.nodeType === Node.TEXT_NODE ? node.parentElement : node;
    if (app.reflow?.active && app.reflow.container.contains(element)) return 'reflow';
    if (app.container.contains(element) && (element.closest('.textLayer') || element.querySelector?.('.textLayer'))) return 'pdf';
    return null;
  }

  /**
   * Текст выделения для списка и конспекта. Берём его из индекса страницы, а
   * не из выделения: в слое PDF между строками нет пробелов, а переносы по
   * слогам там не склеены.
   */
  async function textOfPieces(pieces) {
    const parts = [];
    for (const piece of pieces) {
      const page = await index()?.page(piece.pageNumber);
      const start = page && spanPointToOffset(page.entries, piece.from);
      const end = page && spanPointToOffset(page.entries, piece.to);
      if (start == null || end == null) return null; // задет выброшенный колонтитул
      parts.push(cleanForSpeech(page.text.slice(start, end)).text);
    }
    return parts.join(' ').replace(/\s+/g, ' ').trim() || null;
  }

  // ── Создание, правка, удаление ───────────────────────────────────────

  async function createFromRange(range, color) {
    if (!app.readingState.record) return null;
    const kind = selectionKind(range);
    const pieces = kind === 'reflow' ? await piecesFromReflow(range) : kind === 'pdf' ? piecesFromPdf(range) : [];
    if (!pieces.length) return null;
    const text = (await textOfPieces(pieces)) ?? range.toString().replace(/\s+/g, ' ').trim();
    const highlight = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      color,
      pieces,
      text,
      note: '',
      createdAt: Date.now(),
    };
    lastColor = color;
    await app.readingState.patch({ highlights: [...items(), highlight].sort(byPosition) });
    return highlight;
  }

  async function update(id, patch, { silent = false } = {}) {
    await app.readingState.patch(
      { highlights: items().map((item) => (item.id === id ? { ...item, ...patch } : item)) },
      { silent }
    );
  }

  async function remove(id) {
    await app.readingState.patch({ highlights: items().filter((item) => item.id !== id) });
  }

  // ── Всплывающая панель ───────────────────────────────────────────────

  function placeToolbar(rect) {
    toolbar.hidden = false;
    const width = toolbar.offsetWidth;
    const height = toolbar.offsetHeight;
    const below = rect.bottom + 10 + height < window.innerHeight;
    toolbar.style.left = `${Math.min(window.innerWidth - width - 8, Math.max(8, rect.left + rect.width / 2 - width / 2))}px`;
    toolbar.style.top = `${below ? rect.bottom + 10 : Math.max(8, rect.top - height - 10)}px`;
  }

  function showForSelection(range) {
    pendingRange = range.cloneRange();
    editingId = null;
    deleteButton.hidden = true;
    noteInput.hidden = true;
    noteInput.value = '';
    markActiveSwatch(null);
    placeToolbar(range.getBoundingClientRect());
  }

  function showForExisting(highlight, rect) {
    pendingRange = null;
    editingId = highlight.id;
    deleteButton.hidden = false;
    noteInput.hidden = !highlight.note;
    noteInput.value = highlight.note || '';
    markActiveSwatch(highlight.color);
    placeToolbar(rect);
  }

  /** Дописанную заметку сохраняем до того, как панель спрячется. */
  function flushNote() {
    clearTimeout(noteTimer);
    // Не тихо: пока печатали, список в боковой панели не перерисовывался.
    if (editingId && !noteInput.hidden) update(editingId, { note: noteInput.value.trim() });
  }

  function hideToolbar() {
    flushNote();
    toolbar.hidden = true;
    pendingRange = null;
    editingId = null;
  }

  function markActiveSwatch(color) {
    for (const swatch of toolbar.querySelectorAll('.mark-swatch')) {
      swatch.classList.toggle('active', swatch.dataset.color === color);
    }
  }

  async function chooseColor(color) {
    if (editingId) {
      await update(editingId, { color });
      markActiveSwatch(color);
      lastColor = color;
      return;
    }
    // Панель и выделение убираем сразу: пока маркер сохраняется, читатель
    // может уже выделять следующий кусок.
    const range = pendingRange;
    hideToolbar();
    window.getSelection()?.removeAllRanges();
    if (range) await createFromRange(range, color);
  }

  async function openNote() {
    if (!editingId && pendingRange) {
      const range = pendingRange;
      pendingRange = null;
      window.getSelection()?.removeAllRanges();
      const created = await createFromRange(range, lastColor);
      if (!created) {
        hideToolbar();
        return;
      }
      editingId = created.id;
      deleteButton.hidden = false;
      markActiveSwatch(created.color);
    }
    noteInput.hidden = false;
    noteInput.focus();
  }

  for (const swatch of toolbar.querySelectorAll('.mark-swatch')) {
    on(swatch, 'click', () => chooseColor(swatch.dataset.color));
  }
  on($('markNoteToggle'), 'click', openNote);
  on(deleteButton, 'click', async () => {
    if (editingId) await remove(editingId);
    hideToolbar();
  });
  on(noteInput, 'input', () => {
    clearTimeout(noteTimer);
    const id = editingId;
    noteTimer = setTimeout(() => id && update(id, { note: noteInput.value.trim() }, { silent: true }), NOTE_SAVE_DELAY);
  });
  on(noteInput, 'blur', flushNote);

  // Выделили текст мышью — предлагаем маркер.
  on(document, 'mouseup', (event) => {
    if (toolbar.contains(event.target)) return;
    setTimeout(() => {
      const selection = window.getSelection();
      if (!selection || selection.isCollapsed || !selection.rangeCount) return;
      const range = selection.getRangeAt(0);
      if (!selectionKind(range) || !range.toString().trim()) return;
      showForSelection(range);
    }, 0);
  });

  on(document, 'pointerdown', (event) => {
    if (toolbar.hidden || toolbar.contains(event.target)) return;
    // Новое выделение покажет панель заново, щелчок по маркеру — тоже.
    hideToolbar();
  });

  for (const container of [app.container, $('reflowContainer')]) {
    on(container, 'scroll', () => {
      if (!toolbar.hidden && document.activeElement !== noteInput) hideToolbar();
    }, { passive: true });
  }

  // ── Отрисовка в обычном виде ─────────────────────────────────────────

  function rectsOfPiece(spans, piece) {
    const rects = [];
    for (let spanIndex = piece.from.span; spanIndex <= piece.to.span; spanIndex += 1) {
      const span = spans[spanIndex];
      if (!span) continue;
      const start = locateInSpan(span, spanIndex === piece.from.span ? piece.from.offset : 0);
      const end = locateInSpan(span, spanIndex === piece.to.span ? piece.to.offset : span.textContent.length);
      if (!start || !end) continue;
      const range = document.createRange();
      range.setStart(start.node, start.offset);
      range.setEnd(end.node, end.offset);
      for (const rect of range.getClientRects()) if (rect.width && rect.height) rects.push(rect);
    }
    return rects;
  }

  function renderPdfPage(pageNumber) {
    const div = app.pdfViewer.getPageView(pageNumber - 1)?.div;
    if (!div) return;
    div.querySelector('.mark-layer')?.remove();
    const mine = items().flatMap((item) =>
      item.pieces.filter((piece) => piece.pageNumber === pageNumber).map((piece) => ({ item, piece }))
    );
    const spans = textSpansOfPage(app, pageNumber);
    if (!mine.length || !spans.length) return;

    const layer = el('div', { class: 'mark-layer' });
    const pageRect = div.getBoundingClientRect();
    for (const { item, piece } of mine) {
      for (const line of mergeRectsByLine(rectsOfPiece(spans, piece))) {
        const box = el('div', { class: `mark-box mark-${item.color}`, dataset: { id: item.id } });
        box.style.left = `${line.left - pageRect.left - 1}px`;
        box.style.top = `${line.top - pageRect.top}px`;
        box.style.width = `${line.right - line.left + 2}px`;
        box.style.height = `${line.bottom - line.top}px`;
        if (item.note) box.classList.add('has-note');
        layer.append(box);
      }
    }
    div.append(layer);
  }

  function renderPdf() {
    for (let pageNumber = 1; pageNumber <= (app.pdfViewer.pagesCount || 0); pageNumber += 1) renderPdfPage(pageNumber);
  }

  // ── Отрисовка в режиме текста: CSS Custom Highlight API ──────────────

  async function renderReflow() {
    const registry = globalThis.CSS?.highlights;
    if (!registry || typeof Highlight === 'undefined' || !app.reflow?.active || !index()) return;
    const ranges = Object.fromEntries(Object.keys(MARK_COLORS).map((color) => [color, []]));
    for (const item of items()) {
      for (const piece of item.pieces) {
        const page = await index().page(piece.pageNumber);
        if (!page) continue;
        const start = spanPointToOffset(page.entries, piece.from);
        const end = spanPointToOffset(page.entries, piece.to);
        if (start == null || end == null) continue;
        page.sentences.forEach((sentence, sentenceIndex) => {
          if (sentence.end <= start || sentence.start >= end) return;
          const node = app.reflow.container.querySelector(
            `.rf-page[data-page="${piece.pageNumber}"] .rf-s[data-s="${sentenceIndex}"]`
          )?.firstChild;
          if (!node) return;
          const { map } = cleanForSpeech(page.text.slice(sentence.start, sentence.end));
          const from = cleanedIndexForRaw(map, Math.max(start, sentence.start) - sentence.start);
          const to = cleanedIndexForRaw(map, Math.min(end, sentence.end) - sentence.start);
          if (to <= from) return;
          const range = new Range();
          range.setStart(node, Math.min(from, node.length));
          range.setEnd(node, Math.min(to, node.length));
          ranges[item.color]?.push(range);
        });
      }
    }
    for (const [color, colorRanges] of Object.entries(ranges)) {
      if (colorRanges.length) registry.set(`mark-${color}`, new Highlight(...colorRanges));
      else registry.delete(`mark-${color}`);
    }
  }

  function scheduleReflowRender() {
    cancelAnimationFrame(reflowFrame);
    reflowFrame = requestAnimationFrame(() => renderReflow());
  }

  // ── Щелчок по маркеру — правка ───────────────────────────────────────

  on(app.container, 'click', (event) => {
    if (window.getSelection()?.toString() || app.tts?.pickMode) return;
    const pageDiv = event.target.closest('.page');
    const box = [...(pageDiv?.querySelectorAll('.mark-box') || [])].find((candidate) => {
      const rect = candidate.getBoundingClientRect();
      return event.clientX >= rect.left && event.clientX <= rect.right && event.clientY >= rect.top && event.clientY <= rect.bottom;
    });
    const item = box && items().find((candidate) => candidate.id === box.dataset.id);
    if (item) showForExisting(item, box.getBoundingClientRect());
  });

  on($('reflowContainer'), 'click', async (event) => {
    if (window.getSelection()?.toString() || app.tts?.pickMode || !index()) return;
    const caret = document.caretPositionFromPoint?.(event.clientX, event.clientY);
    const node = caret?.offsetNode;
    const span = (node?.nodeType === Node.TEXT_NODE ? node.parentElement : node)?.closest?.('.rf-s');
    if (!span) return;
    const pageNumber = Number(span.dataset.page);
    const page = await index().page(pageNumber);
    const sentence = page?.sentences[Number(span.dataset.s)];
    if (!sentence) return;
    const { map } = cleanForSpeech(page.text.slice(sentence.start, sentence.end));
    const offset = sentence.start + (map[Math.min(caret.offset, map.length - 1)] ?? 0);
    const item = items().find((candidate) =>
      candidate.pieces.some((piece) => {
        if (piece.pageNumber !== pageNumber) return false;
        const start = spanPointToOffset(page.entries, piece.from);
        const end = spanPointToOffset(page.entries, piece.to);
        return start != null && end != null && offset >= start && offset < end;
      })
    );
    if (item) showForExisting(item, span.getBoundingClientRect());
  });

  // ── Список и конспект ────────────────────────────────────────────────

  async function goTo(item) {
    const [piece] = item.pieces;
    if (app.reflow?.active) {
      const page = await index()?.page(piece.pageNumber);
      const start = page && spanPointToOffset(page.entries, piece.from);
      const sentenceIndex = start != null ? await index().sentenceIndexAt(piece.pageNumber, start) : 0;
      await app.reflow.scrollToSentence(piece.pageNumber, sentenceIndex);
      return;
    }
    app.pdfViewer.scrollPageIntoView({ pageNumber: piece.pageNumber });
    requestAnimationFrame(() => {
      const span = textSpansOfPage(app, piece.pageNumber)[piece.from.span];
      if (!span) return;
      const shift = span.getBoundingClientRect().top - app.container.getBoundingClientRect().top - app.container.clientHeight * 0.3;
      app.container.scrollTop += shift;
    });
  }

  function renderList() {
    clear(list);
    const sorted = [...items()].sort(byPosition);
    $('exportNotes').disabled = !sorted.length && !(app.readingState.record?.bookmarks || []).length;
    if (!sorted.length) {
      list.append(el('p', { class: 'panel-empty' }, 'Выделите текст мышью и выберите цвет маркера — выделение появится здесь.'));
      return;
    }
    const ul = el('ul', { class: 'mark-list' });
    for (const item of sorted) {
      const remover = el('button', { class: 'icon bookmark-delete', title: 'Убрать выделение', onclick: () => remove(item.id) });
      remover.append(icon('trash'));
      ul.append(
        el('li', { class: `mark-item mark-${item.color}` }, [
          el('button', { class: 'mark-jump', title: 'Перейти к выделению', onclick: () => goTo(item) }, [
            el('span', { class: 'bookmark-page' }, `с. ${item.pieces[0].pageNumber}`),
            el('span', { class: 'mark-text' }, item.text),
            item.note ? el('span', { class: 'mark-note' }, item.note) : null,
            el('span', { class: 'bookmark-date' }, formatDate(item.createdAt)),
          ]),
          remover,
        ])
      );
    }
    list.append(ul);
  }

  /** Конспект: выделения по главам, с номерами страниц и заметками, затем закладки. */
  function buildMarkdown() {
    const record = app.readingState.record;
    const title = record?.title || record?.name || 'Документ';
    const lines = [`# ${title}`, '', `_Конспект из PDF-читалки, ${new Date().toLocaleDateString('ru-RU')}_`, ''];
    let chapter;
    for (const item of [...items()].sort(byPosition)) {
      const pageNumber = item.pieces[0].pageNumber;
      const itemChapter = app.outline?.chapterTitleAt(pageNumber) ?? null;
      if (itemChapter !== chapter || lines.length === 4) {
        chapter = itemChapter;
        lines.push(`## ${chapter ?? 'Выделения'}`, '');
      }
      lines.push(`> ${item.text}`, `> — с. ${pageNumber}`, '');
      if (item.note) lines.push(item.note, '');
    }
    const bookmarks = record?.bookmarks || [];
    if (bookmarks.length) {
      lines.push('## Закладки', '');
      for (const bookmark of bookmarks) {
        lines.push(`- с. ${bookmark.pageNumber} — ${bookmark.label}${bookmark.note ? ` — ${bookmark.note}` : ''}`);
      }
      lines.push('');
    }
    return lines.join('\n');
  }

  function exportMarkdown() {
    const record = app.readingState.record;
    const base = (record?.name || 'документ').replace(/\.pdf$/i, '');
    const filename = `${safeFileName(base)} — конспект.md`;
    saveBlob(new Blob([buildMarkdown()], { type: 'text/markdown;charset=utf-8' }), filename);
    app.hud.show(`Сохраняю «${filename}»`);
  }

  on($('exportNotes'), 'click', exportMarkdown);

  function render() {
    renderList();
    renderPdf();
    scheduleReflowRender();
  }

  app.readingState.onChange(() => render());
  app.eventBus.on('textlayerrendered', ({ pageNumber }) => renderPdfPage(pageNumber));
  app.eventBus.on('reflowpagefilled', scheduleReflowRender);
  app.eventBus.on('viewmodechanged', ({ mode }) => {
    hideToolbar();
    if (mode === 'reflow') scheduleReflowRender();
  });
  render();

  return {
    render,
    buildMarkdown,
    exportMarkdown,
    hideToolbar,
    /** Клавиша H: выделить маркером последнего цвета то, что выделено мышью. */
    async markSelection() {
      const selection = window.getSelection();
      if (!selection || selection.isCollapsed || !selection.rangeCount) {
        app.hud.show('Сначала выделите текст мышью');
        return null;
      }
      const range = selection.getRangeAt(0).cloneRange();
      hideToolbar();
      selection.removeAllRanges();
      const created = await createFromRange(range, lastColor);
      if (created) app.hud.show(`Выделено: ${MARK_COLORS[created.color]} маркер`);
      return created;
    },
    get items() {
      return items();
    },
    get toolbarOpen() {
      return !toolbar.hidden;
    },
  };
}
