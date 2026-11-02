// Заметки всех книг: поиск по выделениям, заметкам (в том числе
// расшифровкам голосовых) и закладкам, конспект в Markdown и архив
// «конспект + записи». Здесь только данные — без DOM, поэтому проверяется
// юнит-тестами; интерфейс — в ui/notes-search.js и highlights.js.

import { formatSeconds } from './voice/recorder.js';

/** Для поиска: строчные, «ё» как «е», пробелы схлопнуты. */
export const normalizeText = (text) =>
  String(text ?? '')
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/\s+/g, ' ');

/** Выделения по порядку в книге. */
export function byPosition(a, b) {
  const [pa, pb] = [a.pieces[0], b.pieces[0]];
  return pa.pageNumber - pb.pageNumber || pa.from.span - pb.from.span || pa.from.offset - pb.from.offset;
}

const titleOf = (record) => record.title || record.name || 'Документ';

/**
 * Найти во всех книгах. Слова запроса должны встретиться все — в тексте
 * выделения или в заметке к нему, в названии закладки или её заметке.
 * @returns {{ record, matches: { kind: 'highlight'|'bookmark', id, pageNumber, text, note, voice }[] }[]}
 */
export function searchNotes(records, query) {
  const terms = normalizeText(query).split(' ').filter(Boolean);
  if (!terms.length) return [];
  const hits = (...parts) => {
    const haystack = normalizeText(parts.filter(Boolean).join(' '));
    return terms.every((term) => haystack.includes(term));
  };
  const groups = [];
  for (const record of records) {
    const matches = [];
    for (const item of [...(record.highlights || [])].sort(byPosition)) {
      if (!hits(item.text, item.note)) continue;
      matches.push({ kind: 'highlight', id: item.id, pageNumber: item.pieces[0].pageNumber, text: item.text, note: item.note, voice: item.voice ?? null });
    }
    for (const bookmark of record.bookmarks || []) {
      if (!hits(bookmark.label, bookmark.note)) continue;
      matches.push({ kind: 'bookmark', id: bookmark.id ?? null, pageNumber: bookmark.pageNumber, text: bookmark.label, note: bookmark.note || '', voice: null });
    }
    if (matches.length) groups.push({ record, matches: matches.sort((a, b) => a.pageNumber - b.pageNumber) });
  }
  return groups.sort((a, b) => (b.record.openedAt || 0) - (a.record.openedAt || 0));
}

/**
 * Кусок текста вокруг первого найденного слова: «…и тогда философ сказал…».
 * @returns {{ before: string, match: string, after: string }}
 */
export function snippet(text, query, radius = 70) {
  const source = String(text ?? '');
  const normalized = source.toLowerCase().replace(/ё/g, 'е');
  const term = normalizeText(query).split(' ').filter(Boolean)[0] ?? '';
  const at = term ? normalized.indexOf(term) : -1;
  if (at < 0) {
    const cut = source.length > radius * 2 ? `${source.slice(0, radius * 2).trimEnd()}…` : source;
    return { before: cut, match: '', after: '' };
  }
  const from = Math.max(0, at - radius);
  const to = Math.min(source.length, at + term.length + radius);
  return {
    before: (from > 0 ? '…' : '') + source.slice(from, at),
    match: source.slice(at, at + term.length),
    after: source.slice(at + term.length, to) + (to < source.length ? '…' : ''),
  };
}

/** Расширение файла записи по её типу. */
export function audioExtension(type) {
  if (/ogg/i.test(type)) return 'ogg';
  if (/mp4|aac|m4a/i.test(type)) return 'm4a';
  if (/mpeg|mp3/i.test(type)) return 'mp3';
  if (/wav/i.test(type)) return 'wav';
  return 'webm';
}

/** Имя файла записи в архиве: «с. 12 — 0-41.webm» — по нему видно, откуда она. */
export function recordingFileName(item, type) {
  const page = item.pieces?.[0]?.pageNumber ?? 0;
  const time = formatSeconds(item.voice?.seconds ?? 0).replace(':', '-');
  return `с. ${page} — ${time}.${audioExtension(type)}`;
}

/**
 * Конспект книги в Markdown: выделения по главам, с номерами страниц и
 * заметками, затем закладки.
 * @param chapterAt (pageNumber) => название главы или null
 * @param recordings Map id выделения → путь к файлу записи (для архива)
 */
export function notesMarkdown(record, { chapterAt = () => null, recordings = null, date = new Date() } = {}) {
  const lines = [`# ${titleOf(record)}`, '', `_Конспект из PDF-читалки, ${date.toLocaleDateString('ru-RU')}_`, ''];
  let chapter;
  let first = true;
  for (const item of [...(record.highlights || [])].sort(byPosition)) {
    const pageNumber = item.pieces[0].pageNumber;
    const itemChapter = chapterAt(pageNumber) ?? null;
    if (itemChapter !== chapter || first) {
      chapter = itemChapter;
      first = false;
      lines.push(`## ${chapter ?? 'Выделения'}`, '');
    }
    lines.push(`> ${item.text}`, `> — с. ${pageNumber}`, '');
    if (item.note) lines.push(item.note, '');
    if (item.voice) {
      const length = formatSeconds(item.voice.seconds);
      const path = recordings?.get(item.id);
      const label = item.voice.transcribed && !item.voice.empty ? ' — текст выше' : '';
      // Пробелы в ссылке Markdown — в угловых скобках: так их понимают и Obsidian, и GitHub.
      lines.push(path ? `[▶ Голосовая заметка, ${length}](<${path}>)${label}` : `_Голосовая заметка, ${length}${label}_`, '');
    }
  }
  const bookmarks = record.bookmarks || [];
  if (bookmarks.length) {
    lines.push('## Закладки', '');
    for (const bookmark of bookmarks) {
      lines.push(`- с. ${bookmark.pageNumber} — ${bookmark.label}${bookmark.note ? ` — ${bookmark.note}` : ''}`);
    }
    lines.push('');
  }
  return lines.join('\n');
}

/** Есть ли у книги что выгружать. */
export const hasNotes = (record) => Boolean(record?.highlights?.length || record?.bookmarks?.length);

/** Имя папки или файла для книги — без запрещённых в Windows знаков. */
export function bookFileName(record) {
  const base = String(record.name || titleOf(record)).replace(/\.pdf$/i, '');
  return base.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').trim() || 'документ';
}

/**
 * Файлы архива одной книги: конспект и записи в папке «записи».
 * @param loadRecording async (id) => { blob } | null
 * @param prefix папка книги внутри архива ('' — в корне)
 * @returns {Promise<{ files: { name, data }[], missing: number }>}
 */
export async function bookArchiveFiles(record, { loadRecording, chapterAt, prefix = '', date } = {}) {
  const files = [];
  const recordings = new Map();
  let missing = 0;
  for (const item of [...(record.highlights || [])].sort(byPosition)) {
    if (!item.voice?.id) continue;
    const stored = await loadRecording(item.voice.id).catch(() => null);
    if (!stored?.blob) {
      missing += 1;
      continue;
    }
    const path = `записи/${recordingFileName(item, stored.blob.type)}`;
    // Одинаковые имена (две записи на одной странице одной длины) — с номером.
    let unique = path;
    for (let n = 2; [...recordings.values()].includes(unique); n += 1) unique = path.replace(/(\.[^.]+)$/, ` (${n})$1`);
    recordings.set(item.id, unique);
    files.push({ name: `${prefix}${unique}`, data: stored.blob, date: new Date(stored.createdAt || Date.now()) });
  }
  const markdown = notesMarkdown(record, { chapterAt, recordings, date });
  files.unshift({ name: `${prefix}${bookFileName(record)} — конспект.md`, data: markdown });
  return { files, missing };
}
