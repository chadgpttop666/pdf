// Тестовые книги FB2 и EPUB с одним и тем же текстом: главы, эпиграф, стихи,
// цитата, сноски, картинка. FB2 — в windows-1251, как многие старые книги;
// EPUB — со сносками epub:type="noteref" и отдельным файлом примечаний.
//
//   node scripts/make-book-fixtures.mjs  → tests/fixtures/book.fb2, book.epub

import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateRawSync } from 'node:zlib';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const fixtures = join(root, 'tests', 'fixtures');

const TITLE = 'Читать с экрана';
const AUTHOR = { first: 'Иван', last: 'Петров' };
// Красная точка 8×8 PNG — картинка внутри главы.
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAAE0lEQVR4nGP8z4AdMOEQHwgJADmPAQ8vLQzRAAAAAElFTkSuQmCC';

const filler = [
  'Глаз дочитывает строку у нижнего края, рука тянется к колесу мыши, страница уезжает слишком далеко, и нить рассуждения рвётся.',
  'Через полчаса такого чтения внимание уходит на прокрутку, а не на текст, и читатель устаёт не от смысла, а от механики.',
  'Хороший инструмент чтения похож на хорошую типографику: его не видно, пока он работает, и всё, что требует отдельного усилия, уже мешает.',
  'Достаточно оставить внизу одну-две строки прошлого экрана, чтобы глаз сразу нашёл продолжение, — так устроены телесуфлёры и бегущие строки.',
];
const paragraphs = (count, offset = 0) => Array.from({ length: count }, (_, i) => filler[(i + offset) % filler.length]);

const chapters = [
  {
    title: 'Глава первая. Красная нить',
    epigraph: ['Читать — значит не терять нить.', 'Старая поговорка'],
    paragraphs: [
      ['Красная нить любого длинного текста — это непрерывность', { note: 'Слово «непрерывность» здесь значит то же, что у типографов «ровный цвет полосы».' }, '. Пока читатель видит предыдущую строку, он помнит, о чём шла речь.'],
      ...paragraphs(9).map((text) => [text]),
      ['Вторая составляющая непрерывности — ', { italic: 'темп' }, '. Текст должен приходить к читателю с той скоростью, с какой он его усваивает', { note: 'Об этом подробно писал проф. Иванов в 1928 году.' }, '.'],
    ],
    poem: ['Строка уходит за строкой,', 'и глаз за ними вслед,', 'а мысль — своей дорогой', 'идёт, которой нет.'],
    image: true,
  },
  {
    title: 'Глава вторая. Голос и взгляд',
    paragraphs: [
      ['Озвучка превращает чтение в слушание, но не отменяет взгляда', { note: 'Подсветка читаемого слова помогает удерживать внимание.' }, '.'],
      ...paragraphs(10, 2).map((text) => [text]),
      ['Синтезатору нужен текст, разбитый на предложения, и ', { bold: 'только' }, ' тогда голос не делает пауз посреди мысли.'],
    ],
    cite: 'Тот, кто читает вслух, читает дважды.',
  },
];

const escapeXml = (text) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// ── FB2 ──
function fb2() {
  let notes = 0;
  const noteBodies = [];
  const inline = (parts) =>
    parts
      .map((part) => {
        if (typeof part === 'string') return escapeXml(part);
        if (part.note) {
          notes += 1;
          noteBodies.push(`<section id="n${notes}"><title><p>${notes}</p></title><p>${escapeXml(part.note)}</p></section>`);
          return `<a l:href="#n${notes}" type="note">[${notes}]</a>`;
        }
        if (part.italic) return `<emphasis>${escapeXml(part.italic)}</emphasis>`;
        if (part.bold) return `<strong>${escapeXml(part.bold)}</strong>`;
        return '';
      })
      .join('');
  const sections = chapters
    .map((chapter) => {
      const parts = [`<section><title><p>${escapeXml(chapter.title)}</p></title>`];
      if (chapter.epigraph) parts.push(`<epigraph><p>${escapeXml(chapter.epigraph[0])}</p><text-author>${escapeXml(chapter.epigraph[1])}</text-author></epigraph>`);
      for (const paragraph of chapter.paragraphs) parts.push(`<p>${inline(paragraph)}</p>`);
      if (chapter.poem) parts.push(`<poem><stanza>${chapter.poem.map((line) => `<v>${escapeXml(line)}</v>`).join('')}</stanza></poem>`);
      if (chapter.image) parts.push('<image l:href="#dot.png"/>');
      if (chapter.cite) parts.push(`<cite><p>${escapeXml(chapter.cite)}</p></cite>`);
      parts.push('</section>');
      return parts.join('\n');
    })
    .join('\n');
  return `<?xml version="1.0" encoding="windows-1251"?>
<FictionBook xmlns="http://www.gribuser.ru/xml/fictionbook/2.0" xmlns:l="http://www.w3.org/1999/xlink">
<description><title-info><genre>prose</genre><author><first-name>${AUTHOR.first}</first-name><last-name>${AUTHOR.last}</last-name></author>
<book-title>${TITLE}</book-title><lang>ru</lang></title-info></description>
<body><title><p>${AUTHOR.first} ${AUTHOR.last}</p><p>${TITLE}</p></title>
${sections}
</body>
<body name="notes"><title><p>Примечания</p></title>
${noteBodies.join('\n')}
</body>
<binary id="dot.png" content-type="image/png">${PNG}</binary>
</FictionBook>
`;
}

/** Строка → windows-1251. */
function cp1251(text) {
  const out = [];
  for (const char of text) {
    const code = char.codePointAt(0);
    if (code < 0x80) out.push(code);
    else if (code >= 0x410 && code <= 0x44f) out.push(code - 0x410 + 0xc0);
    else if (code === 0x401) out.push(0xa8);
    else if (code === 0x451) out.push(0xb8);
    else if (code === 0x2014) out.push(0x97);
    else if (code === 0x2013) out.push(0x96);
    else if (code === 0xab) out.push(0xab);
    else if (code === 0xbb) out.push(0xbb);
    else if (code === 0x2026) out.push(0x85);
    else throw new Error(`нет в windows-1251: ${char}`);
  }
  return Buffer.from(out);
}

// ── EPUB ──
function epubFiles() {
  let notes = 0;
  const noteItems = [];
  const inline = (parts) =>
    parts
      .map((part) => {
        if (typeof part === 'string') return escapeXml(part);
        if (part.note) {
          notes += 1;
          noteItems.push(`<aside epub:type="footnote" id="fn${notes}"><p><a href="ch${notes <= 2 ? 1 : 2}.xhtml#ref${notes}">${notes}.</a> ${escapeXml(part.note)}</p></aside>`);
          return `<sup><a epub:type="noteref" id="ref${notes}" href="notes.xhtml#fn${notes}">${notes}</a></sup>`;
        }
        if (part.italic) return `<em>${escapeXml(part.italic)}</em>`;
        if (part.bold) return `<strong>${escapeXml(part.bold)}</strong>`;
        return '';
      })
      .join('');
  const page = (title, body) => `<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" lang="ru"><head><title>${escapeXml(title)}</title></head>
<body>${body}</body></html>`;
  const chapterFiles = chapters.map((chapter, i) => {
    const parts = [`<h1>${escapeXml(chapter.title)}</h1>`];
    if (chapter.epigraph) parts.push(`<div class="epigraph"><p>${escapeXml(chapter.epigraph[0])}</p><p>${escapeXml(chapter.epigraph[1])}</p></div>`);
    for (const paragraph of chapter.paragraphs) parts.push(`<p>${inline(paragraph)}</p>`);
    if (chapter.poem) parts.push(`<p class="poem">${chapter.poem.map(escapeXml).join('<br/>')}</p>`);
    if (chapter.image) parts.push('<p><img src="../images/dot.png" alt="точка"/></p>');
    if (chapter.cite) parts.push(`<blockquote><p>${escapeXml(chapter.cite)}</p></blockquote>`);
    return [`OEBPS/text/ch${i + 1}.xhtml`, page(chapter.title, parts.join('\n'))];
  });
  // Ссылки в сносках — на главы в той же папке.
  const notesFile = ['OEBPS/text/notes.xhtml', page('Примечания', `<h1>Примечания</h1>\n${noteItems.join('\n')}`)];
  const opf = `<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="id">
<metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="id">test-book</dc:identifier><dc:title>${TITLE}</dc:title>
<dc:creator>${AUTHOR.first} ${AUTHOR.last}</dc:creator><dc:language>ru</dc:language></metadata>
<manifest>
${chapterFiles.map(([, ], i) => `<item id="ch${i + 1}" href="text/ch${i + 1}.xhtml" media-type="application/xhtml+xml"/>`).join('\n')}
<item id="notes" href="text/notes.xhtml" media-type="application/xhtml+xml"/>
<item id="dot" href="images/dot.png" media-type="image/png"/>
</manifest>
<spine>${chapterFiles.map((_, i) => `<itemref idref="ch${i + 1}"/>`).join('')}<itemref idref="notes"/></spine>
</package>`;
  return [
    ['mimetype', 'application/epub+zip', false],
    ['META-INF/container.xml', '<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>', true],
    ['OEBPS/content.opf', opf, true],
    ...chapterFiles.map(([name, text]) => [name, text, true]),
    [...notesFile, true],
    ['OEBPS/images/dot.png', Buffer.from(PNG, 'base64'), false],
  ];
}

/** ZIP: mimetype — первым и без сжатия, остальное — deflate. */
function zip(files) {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc32 = (bytes) => {
    let crc = 0xffffffff;
    for (const byte of bytes) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
    return (crc ^ 0xffffffff) >>> 0;
  };
  const locals = [];
  const central = [];
  let offset = 0;
  for (const [name, content, compress] of files) {
    const raw = typeof content === 'string' ? Buffer.from(content, 'utf8') : content;
    const data = compress ? deflateRawSync(raw) : raw;
    const nameBytes = Buffer.from(name, 'utf8');
    const head = Buffer.alloc(30);
    head.writeUInt32LE(0x04034b50, 0);
    head.writeUInt16LE(20, 4);
    head.writeUInt16LE(0x0800, 6);
    head.writeUInt16LE(compress ? 8 : 0, 8);
    head.writeUInt32LE(crc32(raw), 14);
    head.writeUInt32LE(data.length, 18);
    head.writeUInt32LE(raw.length, 22);
    head.writeUInt16LE(nameBytes.length, 26);
    locals.push(head, nameBytes, data);
    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50, 0);
    entry.writeUInt16LE(20, 4);
    entry.writeUInt16LE(20, 6);
    entry.writeUInt16LE(0x0800, 8);
    entry.writeUInt16LE(compress ? 8 : 0, 10);
    entry.writeUInt32LE(crc32(raw), 16);
    entry.writeUInt32LE(data.length, 20);
    entry.writeUInt32LE(raw.length, 24);
    entry.writeUInt16LE(nameBytes.length, 28);
    entry.writeUInt32LE(offset, 42);
    central.push(entry, nameBytes);
    offset += 30 + nameBytes.length + data.length;
  }
  const centralSize = central.reduce((sum, part) => sum + part.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, ...central, end]);
}

writeFileSync(join(fixtures, 'book.fb2'), cp1251(fb2()));
writeFileSync(join(fixtures, 'book.epub'), zip(epubFiles()));
console.log('tests/fixtures/book.fb2, tests/fixtures/book.epub');
