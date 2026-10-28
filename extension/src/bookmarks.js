// Закладки на конкретное место в документе, с подписью из текста рядом
// и заметкой. Хранятся вместе с записью документа, видны в панели у кнопки
// тулбара и флажками прямо на полях страниц.

import { $, clear, el, formatDate } from './dom.js';
import { icon } from './ui/icons.js';
import { createPopover } from './ui/popover.js';
import { firstVisibleSpanIndex, pageOffsetRatio } from './visible-text.js';

const EMPTY_HINT = 'Закладок пока нет. Нажмите «Добавить здесь» или клавишу B — флажок появится на полях страницы.';

export function createBookmarks(app) {
  const sidebarPanel = $('bookmarksPanel');
  const popoverList = $('bookmarksList');
  const popover = createPopover($('bookmarksPopover'), $('btnBookmark'), { onOpen: () => render() });
  let focusNoteOf = null; // свежая закладка: сразу предлагаем подписать

  function items() {
    return app.readingState.record?.bookmarks || [];
  }

  /** Подпись берём из текста рядом с текущим местом — по ней закладку узнают. */
  async function labelFor(pageNumber, sentenceIndex) {
    const index = app.tts?.textIndex;
    if (!index) return `Страница ${pageNumber}`;
    const page = await index.page(pageNumber).catch(() => null);
    if (!page?.text) return `Страница ${pageNumber}`;
    // В режиме «только текст» известно предложение, в обычном — видимый кусок текста.
    const offset =
      sentenceIndex != null
        ? (page.sentences[sentenceIndex]?.start ?? 0)
        : await index.offsetForSpan(pageNumber, firstVisibleSpanIndex(app, pageNumber));
    const fragment = page.text.slice(offset, offset + 90).replace(/\s+/g, ' ').trim();
    return fragment || `Страница ${pageNumber}`;
  }

  async function addHere({ openPanel = false } = {}) {
    if (!app.readingState.record) {
      app.hud.show('Закладки доступны после открытия документа');
      return null;
    }
    const where = app.reflow?.active ? app.reflow.position() : pageOffsetRatio(app);
    const { pageNumber, offsetRatio } = where;
    const bookmark = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      pageNumber,
      offsetRatio,
      label: await labelFor(pageNumber, where.sentenceIndex),
      note: '',
      createdAt: Date.now(),
    };
    focusNoteOf = openPanel ? bookmark.id : null;
    await app.readingState.patch({ bookmarks: [...items(), bookmark].sort(byPosition) });
    // Открытая панель уже перерисована патчем; повторное открытие перерисовало
    // бы её ещё раз и сбило фокус с поля заметки.
    if (openPanel && !popover.isOpen) popover.open();
    else if (!openPanel) app.hud.show(`Закладка на странице ${pageNumber} — список по кнопке закладок`, { duration: 2200 });
    return bookmark;
  }

  function byPosition(a, b) {
    return a.pageNumber - b.pageNumber || a.offsetRatio - b.offsetRatio;
  }

  function goTo(bookmark) {
    popover.close();
    if (app.reflow?.active) {
      app.reflow.scrollToPageRatio(bookmark.pageNumber, Math.max(0, bookmark.offsetRatio));
      return;
    }
    app.pdfViewer.scrollPageIntoView({ pageNumber: bookmark.pageNumber });
    requestAnimationFrame(() => {
      const div = app.pdfViewer.getPageView(bookmark.pageNumber - 1)?.div;
      if (div && bookmark.offsetRatio) app.container.scrollTop += bookmark.offsetRatio * div.clientHeight;
    });
  }

  async function remove(id) {
    await app.readingState.patch({ bookmarks: items().filter((bookmark) => bookmark.id !== id) });
  }

  /** Заметку сохраняем без перерисовки списка, чтобы не сбить фокус и щелчок. */
  async function setNote(id, note) {
    await app.readingState.patch(
      { bookmarks: items().map((bookmark) => (bookmark.id === id ? { ...bookmark, note } : bookmark)) },
      { silent: true }
    );
    renderMarkers();
  }

  function renderList(container) {
    clear(container);
    const list = items();
    if (!list.length) {
      container.append(el('p', { class: 'panel-empty' }, EMPTY_HINT));
      return;
    }

    const ul = el('ul', { class: 'bookmark-list' });
    for (const bookmark of list) {
      const note = el('input', {
        type: 'text',
        class: 'bookmark-note',
        placeholder: 'Добавить заметку…',
        'aria-label': 'Заметка к закладке',
        onchange: (event) => setNote(bookmark.id, event.target.value.trim()),
      });
      note.value = bookmark.note || '';

      const remover = el('button', {
        class: 'icon bookmark-delete',
        title: 'Удалить закладку',
        'aria-label': 'Удалить закладку',
        onclick: () => remove(bookmark.id),
      });
      remover.append(icon('trash'));

      const jump = el('button', { class: 'bookmark-jump', title: 'Перейти к закладке', onclick: () => goTo(bookmark) }, [
        el('span', { class: 'bookmark-page' }, `с. ${bookmark.pageNumber}`),
        el('span', { class: 'bookmark-label' }, bookmark.label),
        el('span', { class: 'bookmark-date' }, formatDate(bookmark.createdAt)),
      ]);

      ul.append(el('li', { class: 'bookmark-item', dataset: { id: bookmark.id } }, [jump, remover, note]));
    }
    container.append(ul);

    if (focusNoteOf) {
      const fresh = container.querySelector(`[data-id="${focusNoteOf}"] .bookmark-note`);
      if (fresh && !container.closest('[hidden]')) {
        fresh.focus();
        focusNoteOf = null;
      }
    }
  }

  /** Флажки закладок на полях страниц. pdf.js стирает их при перерисовке. */
  function renderMarkersOn(pageNumber) {
    const div = app.pdfViewer.getPageView(pageNumber - 1)?.div;
    if (!div) return;
    for (const marker of div.querySelectorAll('.bookmark-marker')) marker.remove();
    for (const bookmark of items()) {
      if (bookmark.pageNumber !== pageNumber) continue;
      const marker = el('button', {
        class: 'bookmark-marker',
        title: bookmark.note ? `${bookmark.note}\n${bookmark.label}` : bookmark.label,
        'aria-label': 'Закладка',
        'data-keeps-popover': '',
        onclick: (event) => {
          event.stopPropagation();
          popover.open();
        },
      });
      marker.style.top = `${Math.min(0.97, Math.max(0, bookmark.offsetRatio)) * 100}%`;
      marker.append(icon('bookmarkFilled'));
      div.append(marker);
    }
  }

  function renderMarkers() {
    const total = app.pdfViewer.pagesCount || 0;
    for (let pageNumber = 1; pageNumber <= total; pageNumber += 1) renderMarkersOn(pageNumber);
  }

  function render() {
    renderList(popoverList);
    renderList(sidebarPanel);
    renderMarkers();
  }

  $('bmAdd').addEventListener('click', () => addHere({ openPanel: true }));
  app.readingState.onChange(() => render());
  app.eventBus.on('pagerendered', ({ pageNumber }) => renderMarkersOn(pageNumber));
  render();

  return {
    addHere,
    remove,
    render,
    goTo,
    openPopover: () => popover.open(),
    closePopover: () => popover.close(),
  };
}
