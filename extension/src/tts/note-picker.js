// Какие примечания читать. Выключенное примечание голос пропускает — и при
// чтении вслух, и в аудиокниге. Выбор у каждой книги свой (запись документа,
// mutedNotes): выключить можно из окошка примечания («Не читать это») или в
// окне всех примечаний книги — там две вкладки, «Читаются» и «Не читаются».
//
// Список можно выгрузить для нейросети (ChatGPT, Claude…): у каждого
// примечания пометка [x] / [ ], номер и короткий код. Нейросеть меняет
// пометки, ответ вставляют обратно — выбор применяется (и его можно вернуть).

import { closeOnBackdropClick, el } from '../dom.js';
import { setIcon } from '../ui/icons.js';

/**
 * Ключ примечания — буквы и цифры начала текста: номера страниц меняются
 * (переверстка книги), а переносы, пробелы, «ё» и знаки в тексте одного и
 * того же примечания могут отличаться от раза к разу.
 */
export const noteKey = (text) =>
  String(text ?? '')
    .toLowerCase()
    .replaceAll('ё', 'е')
    .replace(/[^\p{L}\p{N}]+/gu, '')
    .slice(0, 120);

/** Короткий код примечания для выгрузки: по нему ответ нейросети находит примечание. */
export function noteCode(text) {
  let hash = 0x811c9dc5;
  for (const char of noteKey(text)) {
    hash ^= char.codePointAt(0);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(36).padStart(5, '0').slice(-5);
}

/** Выключенные примечания открытой книги. */
export function createNoteFilter(readingState) {
  const stored = () => readingState()?.record?.mutedNotes ?? [];
  // Старые ключи (0.28) — в нынешний вид: выбор, сделанный раньше, не теряется.
  const muted = () => new Set(stored().map(noteKey));

  /** Поменять выбор: change(множество ключей) правит его на месте. false — запомнить негде. */
  async function update(change) {
    const state = readingState();
    if (!state?.record) return false;
    await state.mutate(
      (record) => {
        const next = new Set((record.mutedNotes ?? []).map(noteKey));
        change(next);
        return { mutedNotes: [...next] };
      },
      { silent: true }
    );
    return true;
  }

  return {
    isMuted: (text) => muted().has(noteKey(text)),
    get count() {
      return muted().size;
    },
    /** Ключи выключенных — чтобы вернуть всё как было. */
    snapshot: () => [...muted()],
    /**
     * Выключить (mute) или включить примечания с такими текстами.
     * @returns false — документа нет в библиотеке, запомнить негде
     */
    set: (texts, mute) =>
      update((keys) => {
        for (const text of texts) {
          if (mute) keys.add(noteKey(text));
          else keys.delete(noteKey(text));
        }
      }),
    /** Сразу много: { mute: [тексты], unmute: [тексты] }. */
    apply: ({ mute = [], unmute = [] }) =>
      update((keys) => {
        for (const text of unmute) keys.delete(noteKey(text));
        for (const text of mute) keys.add(noteKey(text));
      }),
    /** Выбор целиком — ключи из snapshot. */
    restore: (saved) =>
      update((keys) => {
        keys.clear();
        for (const key of saved) keys.add(key);
      }),
  };
}

/**
 * Найти примечания документа по порядку: { mark, text, page }. Повторы (одна
 * сноска на двух страницах, «Там же») — один раз. Можно прервать и
 * продолжить: progress хранит, докуда дошли.
 * @param progress { notes, seen, nextPage, done } — из newScan()
 */
export async function scanNotes(index, progress, { onProgress, onNote, isCancelled = () => false } = {}) {
  while (progress.nextPage <= index.numPages && !isCancelled()) {
    const pageNumber = progress.nextPage;
    const page = await index.page(pageNumber);
    for (const ref of page?.refs ?? []) {
      const text = await index.noteFor(pageNumber, ref).catch(() => null);
      const key = text && noteKey(text);
      if (!key || progress.seen.has(key)) continue;
      progress.seen.add(key);
      const note = { mark: ref.key, text, page: pageNumber };
      progress.notes.push(note);
      onNote?.(note);
    }
    progress.nextPage += 1;
    onProgress?.(pageNumber, index.numPages);
  }
  progress.done = progress.nextPage > index.numPages;
  return progress.notes;
}

export const newScan = () => ({ notes: [], seen: new Set(), nextPage: 1, done: false });

/** Все примечания документа разом (для проверок и аудиокниги). */
export async function collectNotes(index, options = {}) {
  return scanNotes(index, newScan(), options);
}

const oneLine = (text) => String(text).replace(/\s+/g, ' ').trim();

/** Текст для нейросети: задание и список с пометками [x] / [ ]. */
export function notesForAi(notes, { title = '', isMuted = () => false } = {}) {
  return [
    `Примечания книги${title ? ` «${title}»` : ''} — всего ${notes.length}.`,
    '',
    'Задача: отметь, какие примечания стоит читать вслух, а какие голос должен пропускать.',
    'В начале каждой строки пометка: [x] — читать, [ ] — пропустить. Сейчас там текущий выбор.',
    'Если не сказано иначе: читать — пояснения, переводы, комментарии по смыслу и интересные факты;',
    'пропускать — ссылки на источники и литературу, «Там же», «Цит. по», выходные данные книг, номера страниц, адреса сайтов.',
    'Ответь этим же списком целиком: меняй только пометки, номер и код в фигурных скобках оставь как есть. Текст можно сокращать.',
    '',
    ...notes.map((note, i) => `[${isMuted(note.text) ? ' ' : 'x'}] ${i + 1} {${noteCode(note.text)}} стр. ${note.page}: ${oneLine(note.text)}`),
    '',
  ].join('\n');
}

// Пометка в начале строки: «[x] 12 {k3f9a} …», «- [ ] 12 …», «**[x]** 12 …».
const MARK_LINE = /^[\s>*_`•-]*\[\s*([^\]\s]?)\s*\]\s*(.*)$/u;
const OFF_MARKS = new Set(['', '-', '–', '—', '_', '0', 'o', 'о', 'O', 'О']);

/**
 * Разобрать ответ нейросети.
 * @returns {{ mode: 'marks'|'numbers'|'none', read: object[], muted: object[], unknown: number }}
 *   marks — список с пометками: что не упомянуто, не меняется;
 *   numbers — просто номера тех, что читать («1, 4, 7–9»): остальные — не читать
 */
export function parseAiAnswer(answer, notes) {
  const byCode = new Map();
  for (const note of notes) {
    const code = noteCode(note.text);
    // Совпали коды у разных примечаний — по коду не узнать, только по номеру.
    byCode.set(code, byCode.has(code) ? null : note);
  }
  const read = new Map();
  const muted = new Map();
  let marks = 0;
  let unknown = 0;
  for (const line of String(answer ?? '').split(/\r?\n/)) {
    const match = MARK_LINE.exec(line);
    if (!match) continue;
    marks += 1;
    const on = !OFF_MARKS.has(match[1]);
    const code = /\{\s*([0-9a-z]{5})\s*\}/i.exec(match[2])?.[1]?.toLowerCase();
    const number = /^[\s*_]*(\d+)/.exec(match[2])?.[1];
    const note = (code && byCode.get(code)) || (number ? notes[Number(number) - 1] : null);
    if (!note) {
      unknown += 1;
      continue;
    }
    const key = noteKey(note.text);
    (on ? muted : read).delete(key);
    (on ? read : muted).set(key, note);
  }
  if (marks) return { mode: 'marks', read: [...read.values()], muted: [...muted.values()], unknown };
  // Без пометок — номера тех, что читать: «1, 4, 7–9».
  const numbers = new Set();
  for (const [, from, to, single] of String(answer ?? '').matchAll(/(\d+)\s*(?:[-–—]|\.\.)\s*(\d+)|(\d+)/g)) {
    if (single) numbers.add(Number(single));
    else for (let n = Number(from); n <= Math.min(Number(to), Number(from) + 5000); n += 1) numbers.add(n);
  }
  if (!numbers.size) return { mode: 'none', read: [], muted: [], unknown: 0 };
  return {
    mode: 'numbers',
    read: notes.filter((_, i) => numbers.has(i + 1)),
    muted: notes.filter((_, i) => !numbers.has(i + 1)),
    unknown: [...numbers].filter((n) => n < 1 || n > notes.length).length,
  };
}

const plural = (n, one, few, many) => {
  const tens = n % 100;
  const last = n % 10;
  if (tens >= 11 && tens <= 14) return many;
  if (last === 1) return one;
  if (last >= 2 && last <= 4) return few;
  return many;
};

/**
 * Окно «Примечания книги»: вкладки «Читаются» / «Не читаются», поиск,
 * раскрытие длинного текста, переход к странице и выгрузка для нейросети.
 * @param textIndex () => индекс текста открытого документа
 * @param available () => причина, почему примечаний не найти, или ''
 * @param warning () => предупреждение над списком (например, примечания не читаются вовсе) или ''
 * @param title () => название книги — для выгрузки
 * @param onChange выбор поменялся (чтение подстроит заготовки)
 * @param onJump (page) => показать страницу примечания
 */
export function createNotePicker({ filter, textIndex, available = () => '', warning = () => '', title = () => '', onChange = () => {}, onJump = () => {} }) {
  const scans = new WeakMap(); // индекс документа → докуда просмотрели
  let notes = [];
  let tab = 'read';
  let generation = 0;
  let renderQueued = false;
  let undo = null; // выбор до применения ответа нейросети
  const expanded = new Set(); // раскрытые примечания (ключи) — переживают перерисовку списка

  const status = el('span', { class: 'hint note-picker-status', 'aria-live': 'polite' });
  const warningLine = el('p', { class: 'note-picker-warning', hidden: true });
  const tabRead = el('button', { type: 'button', role: 'tab', class: 'note-picker-tab', dataset: { tab: 'read' } });
  const tabMuted = el('button', { type: 'button', role: 'tab', class: 'note-picker-tab', dataset: { tab: 'muted' } });
  const search = el('input', { type: 'search', class: 'note-picker-search', placeholder: 'Найти в примечаниях', 'aria-label': 'Найти в примечаниях' });
  const bulk = el('button', { type: 'button', class: 'note-picker-bulk' });
  const list = el('ul', { class: 'note-picker-list', role: 'tabpanel' });
  const empty = el('p', { class: 'note-picker-empty hint', hidden: true });

  // ── Для нейросети ──
  const answer = el('textarea', { class: 'note-picker-answer', rows: 5, placeholder: 'Вставьте сюда ответ нейросети — список с пометками [x] / [ ] или просто номера тех, что читать: 1, 4, 7–9' });
  const aiResult = el('span', { class: 'hint note-picker-ai-result', 'aria-live': 'polite' });
  const fileInput = el('input', { type: 'file', accept: '.txt,.md,text/plain', hidden: true });
  const copyButton = el('button', { type: 'button' }, 'Скопировать список');
  const saveButton = el('button', { type: 'button' }, 'Сохранить файлом');
  const loadButton = el('button', { type: 'button' }, 'Ответ из файла…');
  const applyButton = el('button', { type: 'button', class: 'primary' }, 'Применить ответ');
  const undoButton = el('button', { type: 'button', hidden: true }, 'Вернуть как было');
  const ai = el('details', { class: 'note-picker-ai' }, [
    el('summary', {}, 'Выбрать с помощью нейросети'),
    el(
      'p',
      { class: 'hint' },
      'Скопируйте список (или сохраните файлом) и отправьте нейросети — ChatGPT, Claude, любой. Задание уже в начале списка; можно дописать своё: «читать только переводы». Её ответ вставьте ниже и примените.'
    ),
    el('div', { class: 'note-picker-row' }, [copyButton, saveButton]),
    answer,
    el('div', { class: 'note-picker-row' }, [applyButton, loadButton, undoButton, fileInput, aiResult]),
  ]);

  const closeButton = el('button', { type: 'button', class: 'icon note-picker-close', title: 'Закрыть', 'aria-label': 'Закрыть', onclick: () => dialog.close() });
  setIcon(closeButton, 'close');
  const dialog = el('dialog', { class: 'note-picker', id: 'notePickerDialog', 'aria-label': 'Примечания книги' }, [
    el('div', { class: 'note-picker-head' }, [el('h2', {}, 'Примечания книги'), closeButton]),
    warningLine,
    el('div', { class: 'note-picker-tabs', role: 'tablist' }, [tabRead, tabMuted]),
    el('div', { class: 'note-picker-tools' }, [search, bulk, status]),
    list,
    empty,
    ai,
  ]);
  document.body.append(dialog);
  closeOnBackdropClick(dialog);

  const isMuted = (note) => filter.isMuted(note.text);
  const query = () => search.value.trim().toLowerCase();
  const matches = (note) => {
    const q = query();
    return !q || note.text.toLowerCase().includes(q) || note.mark === q || `стр. ${note.page}` === q || String(note.page) === q;
  };
  const shown = () => notes.filter((note) => isMuted(note) === (tab === 'muted') && matches(note));

  function row(note) {
    const muted = isMuted(note);
    const key = noteKey(note.text);
    const open = expanded.has(key);
    const text = el('div', { class: `note-picker-text${open ? ' expanded' : ''}`, title: 'Щёлкните, чтобы раскрыть или свернуть' }, note.text);
    const expand = el('button', { type: 'button', class: 'note-picker-expand link', hidden: !open || null }, open ? 'Свернуть' : 'Показать полностью');
    const toggle = () => {
      const now = text.classList.toggle('expanded');
      if (now) expanded.add(key);
      else expanded.delete(key);
      expand.textContent = now ? 'Свернуть' : 'Показать полностью';
      expand.hidden = false;
    };
    text.addEventListener('click', toggle);
    expand.addEventListener('click', toggle);
    const move = el('button', { type: 'button', class: 'note-picker-move' }, muted ? 'Читать' : 'Не читать');
    move.addEventListener('click', async () => {
      if (!(await filter.set([note.text], !muted))) {
        status.textContent = 'Не получилось запомнить выбор: документа нет в библиотеке';
        return;
      }
      onChange();
      render();
    });
    const item = el('li', { class: 'note-picker-item' }, [
      el('div', { class: 'note-picker-meta' }, [
        el('span', {}, `Сноска ${note.mark}`),
        el('button', { type: 'button', class: 'link', title: 'Показать эту страницу', onclick: () => jump(note.page) }, `стр. ${note.page}`),
      ]),
      text,
      el('div', { class: 'note-picker-actions' }, [expand, move]),
    ]);
    // Длинный текст обрезан — кнопка «Показать полностью» (у раскрытого — «Свернуть»).
    if (!open) {
      requestAnimationFrame(() => {
        expand.hidden = text.scrollHeight <= text.clientHeight + 2;
      });
    }
    return item;
  }

  function render() {
    renderQueued = false;
    const muted = notes.filter(isMuted).length;
    tabRead.textContent = `Читаются · ${notes.length - muted}`;
    tabMuted.textContent = `Не читаются · ${muted}`;
    for (const button of [tabRead, tabMuted]) {
      const active = button.dataset.tab === tab;
      button.classList.toggle('active', active);
      button.setAttribute('aria-selected', String(active));
    }
    const items = shown();
    const filtered = Boolean(query());
    bulk.textContent = tab === 'read' ? (filtered ? 'Не читать найденные' : 'Не читать ни одного') : filtered ? 'Читать найденные' : 'Читать все';
    bulk.disabled = !items.length;
    const scrollTop = list.scrollTop;
    list.replaceChildren(...items.map(row));
    list.scrollTop = scrollTop;
    empty.hidden = Boolean(items.length) || !notes.length;
    empty.textContent = filtered
      ? 'Ничего не нашлось'
      : tab === 'read'
        ? 'Все примечания выключены — голос их пропустит'
        : 'Здесь появятся примечания, которые голос пропускает: «Не читать» в списке или в окошке примечания';
    copyButton.disabled = saveButton.disabled = applyButton.disabled = !notes.length;
  }

  function queueRender() {
    if (renderQueued) return;
    renderQueued = true;
    requestAnimationFrame(render);
  }

  function jump(page) {
    dialog.close();
    onJump(page);
  }

  for (const button of [tabRead, tabMuted]) {
    button.addEventListener('click', () => {
      tab = button.dataset.tab;
      render();
      list.scrollTop = 0;
    });
  }
  search.addEventListener('input', () => render());
  bulk.addEventListener('click', async () => {
    const items = shown();
    if (!(await filter.set(
      items.map((note) => note.text),
      tab === 'read'
    ))) {
      status.textContent = 'Не получилось запомнить выбор: документа нет в библиотеке';
      return;
    }
    onChange();
    render();
  });

  // ── Нейросеть: выгрузка и ответ ──
  const exportText = () => notesForAi(notes, { title: title(), isMuted: (text) => filter.isMuted(text) });
  copyButton.addEventListener('click', async () => {
    const text = exportText();
    try {
      await navigator.clipboard.writeText(text);
      aiResult.textContent = `Скопировано: ${notes.length} ${plural(notes.length, 'примечание', 'примечания', 'примечаний')}. Вставьте в чат с нейросетью`;
    } catch {
      // Буфер обмена недоступен — текст в поле ответа, откуда его можно скопировать руками.
      answer.value = text;
      answer.select();
      aiResult.textContent = 'Скопировать не вышло — список в поле ниже, скопируйте его (Ctrl+C)';
    }
  });
  saveButton.addEventListener('click', () => {
    const url = URL.createObjectURL(new Blob([exportText()], { type: 'text/plain;charset=utf-8' }));
    const name = `Примечания — ${(title() || 'книга').replace(/[\\/:*?"<>|]+/g, ' ').slice(0, 80)}.txt`;
    el('a', { href: url, download: name }).click();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
    aiResult.textContent = `Сохранено: ${name}`;
  });
  loadButton.addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', async () => {
    const file = fileInput.files?.[0];
    fileInput.value = '';
    if (!file) return;
    answer.value = await file.text();
    applyAnswer();
  });
  applyButton.addEventListener('click', () => applyAnswer());
  undoButton.addEventListener('click', async () => {
    if (!undo) return;
    await filter.restore(undo);
    undo = null;
    undoButton.hidden = true;
    aiResult.textContent = 'Вернул выбор, какой был до ответа нейросети';
    onChange();
    render();
  });

  async function applyAnswer() {
    const parsed = parseAiAnswer(answer.value, notes);
    if (parsed.mode === 'none' || (!parsed.read.length && !parsed.muted.length)) {
      aiResult.textContent = 'В ответе не нашлось ни пометок [x] / [ ], ни номеров примечаний';
      return;
    }
    const before = filter.snapshot();
    const saved = await filter.apply({ mute: parsed.muted.map((note) => note.text), unmute: parsed.read.map((note) => note.text) });
    if (!saved) {
      aiResult.textContent = 'Не получилось запомнить выбор: документа нет в библиотеке';
      return;
    }
    undo = before;
    undoButton.hidden = false;
    const muted = notes.filter(isMuted).length;
    aiResult.textContent =
      `Применено: читаются ${notes.length - muted}, не читаются ${muted}` +
      (parsed.unknown ? `; не узнал строк: ${parsed.unknown}` : '') +
      (parsed.mode === 'marks' && parsed.read.length + parsed.muted.length < notes.length
        ? `; без пометки в ответе — ${notes.length - parsed.read.length - parsed.muted.length}, их не трогал`
        : '');
    onChange();
    render();
  }

  dialog.addEventListener('close', () => (generation += 1));

  return {
    async open() {
      const mine = (generation += 1);
      search.value = '';
      tab = 'read';
      aiResult.textContent = '';
      undo = null;
      undoButton.hidden = true;
      const note = warning();
      warningLine.textContent = note;
      warningLine.hidden = !note;
      if (!dialog.open) dialog.showModal();
      const index = textIndex();
      const reason = available() || (index ? '' : 'Сначала откройте документ');
      if (reason) {
        notes = [];
        render();
        empty.hidden = false;
        empty.textContent = reason;
        status.textContent = '';
        return;
      }
      if (!scans.has(index)) scans.set(index, newScan());
      const progress = scans.get(index);
      notes = progress.notes;
      render();
      if (progress.done) {
        status.textContent = notes.length ? '' : 'В этой книге примечаний не нашлось';
        if (!notes.length) {
          empty.hidden = false;
          empty.textContent = 'В этой книге примечаний не нашлось';
        }
        return;
      }
      // Длинную книгу просматриваем постранично — список растёт по ходу;
      // закрыли окно — продолжим с того же места в следующий раз.
      status.textContent = 'Ищу примечания…';
      await scanNotes(index, progress, {
        isCancelled: () => mine !== generation,
        onNote: () => mine === generation && queueRender(),
        onProgress: (pageNumber, total) => {
          if (mine === generation) status.textContent = `Ищу примечания: стр. ${pageNumber} из ${total}…`;
        },
      });
      if (mine !== generation) return;
      render();
      status.textContent = notes.length ? '' : 'В этой книге примечаний не нашлось';
      if (!notes.length) {
        empty.hidden = false;
        empty.textContent = 'В этой книге примечаний не нашлось';
      }
    },
    close() {
      dialog.close();
    },
    get isOpen() {
      return dialog.open;
    },
  };
}
