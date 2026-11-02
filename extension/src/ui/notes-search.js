// Поиск по заметкам всех книг — во вкладке «Заметки» боковой панели. Ищет
// в выделениях, заметках к ним (и расшифровках голосовых заметок — они
// дописываются в заметку) и в закладках. Щелчок по найденному открывает
// книгу из библиотеки и переходит к месту. Там же — архив заметок всех книг.

import { $, clear, el, on, saveBlob } from '../dom.js';
import * as library from '../library.js';
import { bookArchiveFiles, bookFileName, hasNotes, searchNotes, snippet } from '../notes-export.js';
import { formatSeconds } from '../voice/recorder.js';
import { makeZip } from '../zip.js';

const SEARCH_DELAY_MS = 200;

const plural = (n, one, few, many) => {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return one;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return few;
  return many;
};

export function createNotesSearch(app) {
  const input = $('notesSearch');
  const local = $('notesLocal');
  const results = $('notesResults');
  let timer = 0;
  let token = 0;
  let pending = null; // { docId, match } — перейти, когда книга откроется

  /** Все книги библиотеки; открытая — со свежими заметками из памяти. */
  async function allRecords() {
    const records = await library.listRecent(Infinity);
    const current = app.readingState.record;
    return records.map((record) => (record.id === current?.id ? { ...record, highlights: current.highlights, bookmarks: current.bookmarks } : record));
  }

  /** Текст с подсветкой найденного слова. */
  function marked(text, query) {
    const part = snippet(text, query);
    return [part.before, part.match ? el('mark', {}, part.match) : null, part.after];
  }

  function render(groups, query) {
    clear(results);
    const total = groups.reduce((sum, group) => sum + group.matches.length, 0);
    if (!total) {
      results.append(el('p', { class: 'panel-empty' }, 'Ничего не нашлось — ни в выделениях, ни в заметках, ни в закладках'));
      return;
    }
    results.append(
      el(
        'p',
        { class: 'notes-found' },
        `${total} ${plural(total, 'находка', 'находки', 'находок')} в ${groups.length} ${plural(groups.length, 'книге', 'книгах', 'книгах')}`
      )
    );
    const currentId = app.readingState.documentId;
    for (const { record, matches } of groups) {
      const head = el('h5', { class: 'notes-book', title: record.name || '' }, [record.title || record.name || 'Документ']);
      if (record.id === currentId) head.append(el('span', { class: 'notes-here' }, 'открыта'));
      results.append(head);
      const ul = el('ul', { class: 'mark-list' });
      for (const match of matches) {
        const isBookmark = match.kind === 'bookmark';
        ul.append(
          el('li', { class: `mark-item notes-hit ${isBookmark ? 'bookmark-hit' : 'mark-yellow'}` }, [
            el(
              'button',
              {
                class: 'mark-jump',
                title: record.id === currentId ? 'Перейти к месту' : 'Открыть книгу на этом месте',
                onclick: () => openMatch(record, match),
              },
              [
                el('span', { class: 'bookmark-page' }, `с. ${match.pageNumber}`),
                el('span', { class: 'mark-text' }, isBookmark ? ['Закладка: ', ...marked(match.text, query)] : marked(match.text, query)),
                match.note ? el('span', { class: 'mark-note' }, marked(match.note, query)) : null,
                match.voice ? el('span', { class: 'bookmark-date' }, `голосовая заметка ${formatSeconds(match.voice.seconds)}`) : null,
              ]
            ),
          ])
        );
      }
      results.append(ul);
    }
  }

  async function run() {
    clearTimeout(timer);
    const query = input.value.trim();
    const searching = Boolean(query);
    local.hidden = searching;
    results.hidden = !searching;
    if (!searching) return;
    const mine = (token += 1);
    let groups = [];
    try {
      groups = searchNotes(await allRecords(), query);
    } catch (error) {
      console.warn('Поиск по заметкам не удался', error);
    }
    if (mine === token) render(groups, query);
  }

  function jump(match) {
    if (match.kind === 'highlight' && app.highlights.goToId(match.id)) return;
    const bookmark = match.id && (app.readingState.record?.bookmarks || []).find((candidate) => candidate.id === match.id);
    if (bookmark) app.bookmarks.goTo(bookmark);
    else app.pdfViewer.scrollPageIntoView({ pageNumber: match.pageNumber });
  }

  async function openMatch(record, match) {
    if (record.id === app.readingState.documentId) {
      jump(match);
      return;
    }
    pending = { docId: record.id, match };
    try {
      await app.recent.open(record);
    } catch (error) {
      pending = null;
      app.hud.show(`Книга не открылась: ${error.message}`);
    }
  }

  // Книга открылась и встала на сохранённое место — теперь к найденному.
  app.eventBus.on('viewrestored', () => {
    if (!pending || pending.docId !== app.readingState.documentId) return;
    const { match } = pending;
    pending = null;
    setTimeout(() => jump(match), 50);
  });

  /** Заметки всех книг: в архиве по папке на книгу — конспект и записи. */
  async function exportAll() {
    const records = (await allRecords()).filter(hasNotes);
    if (!records.length) {
      app.hud.show('Заметок пока нет ни в одной книге');
      return;
    }
    app.hud.show('Собираю архив заметок…', { duration: 30000 });
    const files = [];
    let missing = 0;
    const currentId = app.readingState.documentId;
    for (const record of records) {
      const book = await bookArchiveFiles(record, {
        loadRecording: library.getRecording,
        // Главы известны только у открытой книги.
        chapterAt: record.id === currentId ? app.highlights.chapterAt : undefined,
        prefix: `${bookFileName(record)}/`,
      });
      files.push(...book.files);
      missing += book.missing;
    }
    const date = new Date().toLocaleDateString('ru-RU');
    const filename = `Заметки PDF-читалки ${date}.zip`;
    saveBlob(await makeZip(files), filename);
    const books = `${records.length} ${plural(records.length, 'книга', 'книги', 'книг')}`;
    app.hud.show(`Сохраняю «${filename}» — ${books}${missing ? `, записей не нашлось: ${missing}` : ''}`, { duration: 4000 });
  }

  on(input, 'input', () => {
    clearTimeout(timer);
    timer = setTimeout(run, SEARCH_DELAY_MS);
  });
  on(input, 'keydown', (event) => {
    // Esc сначала очищает поиск, а не закрывает панель.
    if (event.key === 'Escape' && input.value) {
      event.stopPropagation();
      input.value = '';
      run();
    }
  });
  on($('exportAllNotes'), 'click', () => exportAll().catch((error) => app.hud.show(`Архив не собрался: ${error.message}`)));
  // Заметки поменялись (в этой или другой вкладке) — результаты тоже.
  app.readingState.onChange(() => {
    if (input.value.trim()) run();
  });

  return { run, exportAll };
}
