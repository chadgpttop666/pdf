// Какие примечания читать. Выключенное примечание голос пропускает — и при
// чтении вслух, и в аудиокниге. Выбор у каждой книги свой (запись документа,
// mutedNotes): выключить можно прямо из окошка примечания («Не читать это»)
// или в списке всех примечаний книги.

import { closeOnBackdropClick, el } from '../dom.js';

/** Ключ примечания — по тексту: номера страниц меняются (переверстка книги), текст — нет. */
export const noteKey = (text) => String(text ?? '').toLowerCase().replace(/\s+/g, ' ').trim().slice(0, 200);

/** Выключенные примечания открытой книги. */
export function createNoteFilter(readingState) {
  const muted = () => new Set(readingState()?.record?.mutedNotes ?? []);
  return {
    isMuted: (text) => muted().has(noteKey(text)),
    get count() {
      return muted().size;
    },
    /** Выключить (mute) или включить примечания с такими текстами. */
    async set(texts, mute) {
      const state = readingState();
      if (!state?.record) return;
      const keys = texts.map(noteKey);
      await state.mutate(
        (record) => {
          const next = new Set(record.mutedNotes ?? []);
          for (const key of keys) {
            if (mute) next.add(key);
            else next.delete(key);
          }
          return { mutedNotes: [...next] };
        },
        { silent: true }
      );
    },
  };
}

/**
 * Все примечания документа по порядку: { mark, text, page }. Повторы (одна
 * сноска на двух страницах) — один раз.
 */
export async function collectNotes(index, { onProgress, isCancelled = () => false } = {}) {
  const notes = [];
  const seen = new Set();
  for (let pageNumber = 1; pageNumber <= index.numPages && !isCancelled(); pageNumber += 1) {
    const page = await index.page(pageNumber);
    for (const ref of page?.refs ?? []) {
      const text = await index.noteFor(pageNumber, ref).catch(() => null);
      const key = text && noteKey(text);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      notes.push({ mark: ref.key, text, page: pageNumber });
    }
    onProgress?.(pageNumber, index.numPages);
  }
  return notes;
}

/**
 * Окно «Какие примечания читать»: все примечания книги с галочками.
 * @param textIndex () => индекс текста открытого документа
 * @param available () => причина, почему примечаний нет, или '' — всё в порядке
 * @param onChange выбор поменялся (чтение подстроит заготовки)
 */
export function createNotePicker({ filter, textIndex, available = () => '', onChange = () => {} }) {
  const status = el('span', { class: 'hint note-picker-status', 'aria-live': 'polite' });
  const list = el('ul', { class: 'note-picker-list' });
  const allOn = el('button', { type: 'button' }, 'Читать все');
  const allOff = el('button', { type: 'button' }, 'Не читать ни одного');
  const dialog = el('dialog', { class: 'note-picker', id: 'notePickerDialog' }, [
    el('form', { method: 'dialog' }, [
      el('h2', {}, 'Какие примечания читать'),
      el('p', { class: 'hint' }, 'Снимите галочку — голос пропустит это примечание (и в аудиокниге тоже). Выбор хранится у этой книги.'),
      el('div', { class: 'note-picker-tools' }, [allOn, allOff, status]),
      list,
      el('menu', {}, [el('button', { value: 'close' }, 'Готово')]),
    ]),
  ]);
  document.body.append(dialog);
  closeOnBackdropClick(dialog);
  let notes = [];
  let generation = 0;

  function describeCount() {
    const off = notes.filter((note) => filter.isMuted(note.text)).length;
    status.textContent = notes.length ? `Примечаний: ${notes.length}${off ? `, не читаются: ${off}` : ''}` : status.textContent;
  }

  function row(note) {
    const box = el('input', { type: 'checkbox', 'aria-label': `Читать примечание ${note.mark}` });
    box.checked = !filter.isMuted(note.text);
    box.addEventListener('change', async () => {
      await filter.set([note.text], !box.checked);
      describeCount();
      onChange();
    });
    return el('li', {}, [
      el('label', {}, [box, el('span', { class: 'note-picker-mark' }, `${note.mark} · стр. ${note.page}`), el('span', { class: 'note-picker-text' }, note.text)]),
    ]);
  }

  async function setAll(mute) {
    await filter.set(
      notes.map((note) => note.text),
      mute
    );
    for (const box of list.querySelectorAll('input[type=checkbox]')) box.checked = !mute;
    describeCount();
    onChange();
  }
  allOn.addEventListener('click', () => setAll(false));
  allOff.addEventListener('click', () => setAll(true));
  dialog.addEventListener('close', () => (generation += 1));

  return {
    async open() {
      const mine = (generation += 1);
      list.replaceChildren();
      notes = [];
      allOn.disabled = allOff.disabled = true;
      dialog.showModal();
      const reason = available();
      const index = textIndex();
      if (reason || !index) {
        status.textContent = reason || 'Сначала откройте документ';
        return;
      }
      status.textContent = 'Ищу примечания…';
      // Длинную книгу просматриваем постранично — список растёт по ходу.
      await collectNotes(index, {
        isCancelled: () => mine !== generation,
        onProgress: (pageNumber, total) => {
          if (mine === generation) status.textContent = `Ищу примечания: стр. ${pageNumber} из ${total}…`;
        },
      }).then((found) => {
        if (mine !== generation) return;
        notes = found;
        list.replaceChildren(...found.map(row));
        allOn.disabled = allOff.disabled = !found.length;
        if (!found.length) status.textContent = 'В этой книге примечаний не нашлось';
        else describeCount();
      });
    },
    close() {
      dialog.close();
    },
    get isOpen() {
      return dialog.open;
    },
  };
}
