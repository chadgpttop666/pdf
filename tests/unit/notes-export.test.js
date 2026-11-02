import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { audioExtension, bookArchiveFiles, notesMarkdown, recordingFileName, searchNotes, snippet } from '../../extension/src/notes-export.js';
import { crc32, makeZip } from '../../extension/src/zip.js';

const piece = (pageNumber, span = 0) => ({ pageNumber, from: { span, offset: 0 }, to: { span, offset: 5 } });

const books = [
  {
    id: 'a',
    name: 'Ролз.pdf',
    title: 'Теория справедливости',
    openedAt: 100,
    highlights: [
      { id: 'h2', pieces: [piece(12)], text: 'Справедливость есть первая добродетель общественных институтов', note: 'главная мысль', color: 'yellow' },
      { id: 'h1', pieces: [piece(3)], text: 'Исходная позиция', note: 'Расшифровка: про завесу неведения', color: 'green', voice: { id: 'v1', seconds: 41, transcribed: true, empty: false } },
    ],
    bookmarks: [{ pageNumber: 40, label: 'Принцип различия', note: 'вернуться' }],
  },
  {
    id: 'b',
    name: 'Нозик.pdf',
    openedAt: 200,
    highlights: [{ id: 'h3', pieces: [piece(7)], text: 'Минимальное государство', note: 'спор с Ролзом о справедливости', color: 'yellow' }],
    bookmarks: [],
  },
];

describe('поиск по заметкам всех книг', () => {
  it('находит в тексте выделения, в заметке и в закладке; книги — недавние первыми', () => {
    const groups = searchNotes(books, 'справедлив');
    assert.deepEqual(
      groups.map((group) => group.record.id),
      ['b', 'a']
    );
    assert.deepEqual(
      groups[1].matches.map((match) => match.id ?? match.text),
      ['h2']
    );
    assert.equal(searchNotes(books, 'неведения')[0].matches[0].id, 'h1'); // расшифровка голосовой заметки — в заметке
    assert.equal(searchNotes(books, 'различия')[0].matches[0].kind, 'bookmark');
  });

  it('все слова запроса, без учёта регистра и «ё»', () => {
    assert.equal(searchNotes(books, 'ролзом спор').length, 1);
    assert.equal(searchNotes(books, 'ролзом добродетель').length, 0);
    assert.equal(searchNotes([{ highlights: [{ id: 'x', pieces: [piece(1)], text: 'Всё ещё', note: '' }] }], 'ВСЕ').length, 1);
    assert.deepEqual(searchNotes(books, '   '), []);
  });

  it('кусок текста вокруг найденного', () => {
    const text = `${'а'.repeat(100)} философ ${'б'.repeat(100)}`;
    const part = snippet(text, 'Философ', 10);
    assert.equal(part.match, 'философ');
    assert.ok(part.before.startsWith('…') && part.after.endsWith('…'));
    assert.equal(snippet('коротко', 'нет').before, 'коротко');
  });
});

describe('конспект и записи', () => {
  it('Markdown: главы, страницы, заметки, ссылка на запись, закладки', () => {
    const markdown = notesMarkdown(books[0], {
      chapterAt: (page) => (page < 10 ? 'Глава 1' : 'Глава 2'),
      recordings: new Map([['h1', 'записи/с. 3 — 0-41.webm']]),
      date: new Date(2026, 10, 2),
    });
    const expected = [
      '# Теория справедливости',
      '',
      '_Конспект из PDF-читалки, 02.11.2026_',
      '',
      '## Глава 1',
      '',
      '> Исходная позиция',
      '> — с. 3',
      '',
      'Расшифровка: про завесу неведения',
      '',
      '[▶ Голосовая заметка, 0:41](<записи/с. 3 — 0-41.webm>) — текст выше',
      '',
      '## Глава 2',
      '',
      '> Справедливость есть первая добродетель общественных институтов',
      '> — с. 12',
      '',
      'главная мысль',
      '',
      '## Закладки',
      '',
      '- с. 40 — Принцип различия — вернуться',
      '',
    ].join('\n');
    assert.equal(markdown, expected);
  });

  it('без записей — как раньше: пометка курсивом', () => {
    assert.match(notesMarkdown(books[0]), /_Голосовая заметка, 0:41 — текст выше_/);
  });

  it('имя файла записи и расширение по типу', () => {
    assert.equal(recordingFileName(books[0].highlights[1], 'audio/ogg;codecs=opus'), 'с. 3 — 0-41.ogg');
    assert.equal(audioExtension('audio/webm;codecs=opus'), 'webm');
    assert.equal(audioExtension(''), 'webm');
  });

  it('файлы архива книги: конспект первым, записи в папке, потерянная запись — посчитана', async () => {
    const book = {
      ...books[0],
      highlights: [...books[0].highlights, { id: 'h9', pieces: [piece(5)], text: 'x', note: '', voice: { id: 'gone', seconds: 3 } }],
    };
    const blob = new Blob([new Uint8Array([1, 2, 3])], { type: 'audio/webm' });
    const { files, missing } = await bookArchiveFiles(book, {
      loadRecording: async (id) => (id === 'v1' ? { blob, createdAt: 0 } : null),
      prefix: 'Ролз/',
    });
    assert.deepEqual(
      files.map((file) => file.name),
      ['Ролз/Ролз — конспект.md', 'Ролз/записи/с. 3 — 0-41.webm']
    );
    assert.equal(missing, 1);
    assert.match(files[0].data, /\(<записи\/с\. 3 — 0-41\.webm>\)/);
  });
});

/** Разобрать ZIP без сжатия — проверить, что архиватор его прочтёт. */
function readZip(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const endAt = bytes.length - 22;
  assert.equal(view.getUint32(endAt, true), 0x06054b50);
  const count = view.getUint16(endAt + 10, true);
  let at = view.getUint32(endAt + 16, true);
  const files = [];
  for (let i = 0; i < count; i += 1) {
    assert.equal(view.getUint32(at, true), 0x02014b50);
    const flags = view.getUint16(at + 8, true);
    const crc = view.getUint32(at + 16, true);
    const size = view.getUint32(at + 24, true);
    const nameLength = view.getUint16(at + 28, true);
    const localAt = view.getUint32(at + 42, true);
    const name = new TextDecoder().decode(bytes.subarray(at + 46, at + 46 + nameLength));
    assert.equal(view.getUint32(localAt, true), 0x04034b50);
    const localName = view.getUint16(localAt + 26, true);
    const dataAt = localAt + 30 + localName + view.getUint16(localAt + 28, true);
    const data = bytes.subarray(dataAt, dataAt + size);
    assert.equal(crc32(data), crc, name);
    files.push({ name, flags, text: new TextDecoder().decode(data) });
    at += 46 + nameLength;
  }
  return files;
}

describe('ZIP', () => {
  it('CRC-32 как у всех', () => {
    assert.equal(crc32(new TextEncoder().encode('hello')), 0x3610a686);
    assert.equal(crc32(new Uint8Array()), 0);
  });

  it('файлы с русскими именами читаются обратно, одинаковые имена — с номером', async () => {
    const zip = await makeZip([
      { name: 'Ролз — конспект.md', data: '# Привет' },
      { name: 'записи/с. 3 — 0-41.webm', data: new Uint8Array([1, 2, 3]) },
      { name: 'записи/с. 3 — 0-41.webm', data: new Blob(['abc']) },
    ]);
    const files = readZip(new Uint8Array(await zip.arrayBuffer()));
    assert.deepEqual(
      files.map((file) => file.name),
      ['Ролз — конспект.md', 'записи/с. 3 — 0-41.webm', 'записи/с. 3 — 0-41 (2).webm']
    );
    assert.equal(files[0].text, '# Привет');
    assert.equal(files[0].flags & 0x0800, 0x0800);
    assert.equal(files[2].text, 'abc');
  });
});
