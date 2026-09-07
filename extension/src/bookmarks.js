// Закладки на конкретное место в документе, с подписью из текста рядом
// и произвольной заметкой. Хранятся вместе с записью документа.

import { $, clear, el, formatDate, on } from './dom.js';
import { firstVisibleSpanIndex, pageOffsetRatio } from './visible-text.js';

export function createBookmarks(app) {
  const panel = $('bookmarksPanel');

  function items() {
    return app.readingState.record?.bookmarks || [];
  }

  /** Подпись берём из текста рядом с текущим местом — по ней закладку узнают. */
  async function labelFor(pageNumber) {
    const index = app.tts?.textIndex;
    if (!index) return `Страница ${pageNumber}`;
    const page = await index.page(pageNumber).catch(() => null);
    if (!page?.text) return `Страница ${pageNumber}`;
    const offset = await index.offsetForDiv(pageNumber, firstVisibleSpanIndex(app, pageNumber));
    const fragment = page.text.slice(offset, offset + 90).replace(/\s+/g, ' ').trim();
    return fragment || `Страница ${pageNumber}`;
  }

  async function addHere() {
    if (!app.readingState.record) {
      app.hud.show('Закладки доступны после открытия документа');
      return null;
    }
    const { pageNumber, offsetRatio } = pageOffsetRatio(app);
    const bookmark = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      pageNumber,
      offsetRatio,
      label: await labelFor(pageNumber),
      note: '',
      createdAt: Date.now(),
    };
    await app.readingState.patch({ bookmarks: [...items(), bookmark].sort(byPosition) });
    app.hud.show(`Закладка на странице ${pageNumber}`);
    render();
    return bookmark;
  }

  function byPosition(a, b) {
    return a.pageNumber - b.pageNumber || a.offsetRatio - b.offsetRatio;
  }

  function goTo(bookmark) {
    app.pdfViewer.scrollPageIntoView({ pageNumber: bookmark.pageNumber });
    requestAnimationFrame(() => {
      const div = app.pdfViewer.getPageView(bookmark.pageNumber - 1)?.div;
      if (div && bookmark.offsetRatio) app.container.scrollTop += bookmark.offsetRatio * div.clientHeight;
    });
  }

  async function remove(id) {
    await app.readingState.patch({ bookmarks: items().filter((bookmark) => bookmark.id !== id) });
    render();
  }

  async function setNote(id, note) {
    await app.readingState.patch({
      bookmarks: items().map((bookmark) => (bookmark.id === id ? { ...bookmark, note } : bookmark)),
    });
  }

  function render() {
    clear(panel);
    const list = items();
    if (!list.length) {
      panel.append(el('p', { class: 'panel-empty' }, 'Закладок пока нет. Клавиша B — поставить закладку на текущем месте.'));
      return;
    }

    const ul = el('ul', { class: 'bookmark-list' });
    for (const bookmark of list) {
      const note = el('input', {
        type: 'text',
        value: bookmark.note,
        placeholder: 'заметка',
        class: 'note-input',
        onchange: (event) => setNote(bookmark.id, event.target.value),
      });

      ul.append(
        el('li', {}, [
          el('div', { style: 'flex:1;min-width:0' }, [
            el('button', { class: 'jump', title: `Страница ${bookmark.pageNumber}`, onclick: () => goTo(bookmark) }, [
              el('span', {}, `${bookmark.pageNumber}. ${bookmark.label}`),
              el('span', { class: 'note' }, formatDate(bookmark.createdAt)),
            ]),
            note,
          ]),
          el('button', { class: 'icon', title: 'Удалить закладку', onclick: () => remove(bookmark.id) }, '✕'),
        ])
      );
    }
    panel.append(ul);
  }

  on($('btnBookmark'), 'click', () => addHere());
  app.readingState.onChange(() => render());
  render();

  return { addHere, remove, render, goTo };
}
