import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { deflateRawSync } from 'node:zlib';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import { bookFormat, pdfName } from '../../extension/src/books/convert.js';
import { hyphenPoints, hyphenPointsOf } from '../../extension/src/books/hyphen.js';
import { layoutBook } from '../../extension/src/books/layout.js';
import { createPdf, pdfText } from '../../extension/src/books/pdf-writer.js';
import { parseTtf } from '../../extension/src/books/ttf.js';
import { readZip } from '../../extension/src/books/unzip.js';
import { TextIndex } from '../../extension/src/text-index.js';
import { makeZip } from '../../extension/src/zip.js';

const fontFile = (style) => new Uint8Array(readFileSync(new URL(`../../extension/vendor/fonts/PTSerif-${style}.ttf`, import.meta.url)));
const fonts = { regular: parseTtf(fontFile('Regular')), italic: parseTtf(fontFile('Italic')), bold: parseTtf(fontFile('Bold')), boldItalic: parseTtf(fontFile('BoldItalic')) };

/** Текст страниц PDF — тем же pdf.js, что в читалке. */
async function readPdf(bytes) {
  const doc = await pdfjs.getDocument({ data: bytes.slice(), verbosity: 0 }).promise;
  const pages = [];
  for (let i = 1; i <= doc.numPages; i += 1) {
    const content = await (await doc.getPage(i)).getTextContent();
    pages.push(content.items.filter((item) => item.str.trim()).map((item) => ({ str: item.str, size: Math.round(item.height * 10) / 10, x: item.transform[4], y: item.transform[5] })));
  }
  const outline = (await doc.getOutline()) ?? [];
  const { info } = await doc.getMetadata();
  await doc.cleanup?.();
  return { pages, outline, info };
}

const show = (word) => {
  const points = hyphenPoints(word);
  return [...word].map((char, i) => (points.includes(i) ? `-${char}` : char)).join('');
};

describe('переносы', () => {
  it('по слогам, без одной буквы на строке, «ь» и «й» — с предыдущей', () => {
    assert.equal(show('мама'), 'ма-ма');
    assert.equal(show('кошка'), 'кош-ка');
    assert.equal(show('большой'), 'боль-шой');
    assert.equal(show('майка'), 'май-ка');
    assert.equal(show('строка'), 'стро-ка');
    assert.equal(show('взгляда'), 'взгля-да');
    assert.equal(show('ГЛАВА'), 'ГЛАВА');
    assert.equal(show('ах'), 'ах');
  });

  it('пунктуация вокруг слова и составные слова', () => {
    assert.deepEqual(hyphenPointsOf('«мама,»'), [3]);
    assert.deepEqual(hyphenPointsOf('одну-две'), [5]);
    assert.deepEqual(hyphenPointsOf('PDF'), []);
  });
});

describe('шрифт TrueType', () => {
  it('PT Serif: кириллица, «ё», кавычки, тире и знак ударения есть', () => {
    const { regular } = fonts;
    assert.equal(regular.unitsPerEm, 1000);
    for (const char of 'АЯаяЁё«»—–…́') assert.ok(regular.has(char.codePointAt(0)), char);
    assert.ok(regular.advance(regular.glyphOf('Ж'.codePointAt(0))) > regular.advance(regular.glyphOf('i'.codePointAt(0))));
    assert.equal(fonts.italic.italicAngle < 0, true);
    assert.equal(fonts.bold.weight, 700);
  });
});

describe('генератор PDF', () => {
  it('текст извлекается как набран; оглавление и свойства на месте', async () => {
    const doc = createPdf({ fonts, info: { title: 'Книга «Ё»', author: 'Автор' } });
    const page = doc.addPage(300, 400);
    page.text('bold', 16, 20, 360, 'Глава первая');
    page.text('regular', 11, 20, 330, 'Съешь же ещё этих мягких булок, да выпей чаю.', { gaps: 1 });
    page.text('italic', 11, 20, 310, 'Ударе́ние — «ёлочки» и 1928 год…');
    doc.addOutline('Глава первая', 0, page, 380);
    const second = doc.addPage(300, 400);
    second.text('regular', 11, 20, 360, 'Санкт‑Петербург');
    doc.addOutline('Раздел', 1, second, 380);
    const bytes = await doc.save();
    const { pages, outline, info } = await readPdf(bytes);
    assert.deepEqual(
      pages[0].map((item) => item.str),
      ['Глава первая', 'Съешь же ещё этих мягких булок, да выпей чаю.', 'Ударе́ние — «ёлочки» и 1928 год…']
    );
    assert.equal(pages[1][0].str, 'Санкт‑Петербург');
    assert.equal(info.Title, 'Книга «Ё»');
    assert.deepEqual(
      outline.map((item) => [item.title, item.items.map((child) => child.title)]),
      [['Глава первая', ['Раздел']]]
    );
  });

  it('одна и та же книга — один и тот же файл', async () => {
    const make = async () => {
      const doc = createPdf({ fonts: { regular: fonts.regular } });
      doc.addPage(200, 200).text('regular', 10, 10, 100, 'Повтор');
      return doc.save();
    };
    assert.deepEqual(await make(), await make());
  });

  it('строки PDF в UTF-16 с меткой порядка байт', () => {
    assert.equal(pdfText('Ё'), '<FEFF0401>');
  });
});

describe('вёрстка книги', () => {
  const paragraph = (text) => ({ type: 'paragraph', runs: [{ text }] });
  const long = 'Красная нить любого длинного текста — это непрерывность, и пока читатель видит предыдущую строку, он помнит, о чём шла речь.';
  const book = {
    title: 'Проверка',
    author: 'Автор',
    blocks: [
      { type: 'heading', level: 0, runs: [{ text: 'Глава первая' }] },
      { type: 'paragraph', runs: [{ text: 'Слово со сноской' }, { text: '1', sup: true }, { text: ' и ' }, { text: 'курсив', italic: true }, { text: '.' }] },
      ...Array.from({ length: 30 }, () => paragraph(long)),
      { type: 'heading', level: 1, runs: [{ text: 'Раздел' }] },
      { type: 'verse', runs: [{ text: 'Строка стиха,' }] },
      { type: 'heading', level: 0, runs: [{ text: 'Глава вторая' }] },
      paragraph('Конец.'),
    ],
    notes: [[[{ text: 'Текст сноски.' }]]],
  };

  it('титул, главы с новой страницы, оглавление, сноска — надстрочно, «Примечания» в конце, номера страниц', async () => {
    const { pages, outline } = await readPdf(await layoutBook(book, fonts));
    const texts = pages.map((items) => items.map((item) => item.str).join('|'));
    assert.match(texts[0], /Автор\|Проверка/);
    assert.match(texts[1], /^Глава первая\|/);
    // Знак сноски — отдельный мелкий кусок.
    const mark = pages[1].find((item) => item.str === '1');
    assert.ok(mark && mark.size < 8, JSON.stringify(mark));
    const chapterTwo = texts.findIndex((text) => text.startsWith('Глава вторая'));
    assert.ok(chapterTwo > 2);
    const notes = texts.at(-1);
    assert.match(notes, /^Примечания\|1\|/);
    assert.match(notes, /Текст сноски\./);
    assert.deepEqual(
      outline.map((item) => [item.title, item.items.map((child) => child.title)]),
      [['Глава первая', ['Раздел']], ['Глава вторая', []], ['Примечания', []]]
    );
    // Номер страницы внизу — со второй страницы, совпадает с номером в читалке.
    const footer = pages[1].find((item) => item.y < 40);
    assert.equal(footer?.str, '2');
    assert.ok(!pages[0].some((item) => item.y < 40));
    // Переносы: строка кончается дефисом, а слово продолжается со строчной.
    assert.ok(texts.some((text) => /\p{L}-\|\p{Ll}/u.test(text)));
  });
});

describe('ZIP и формат книги', () => {
  it('читает архив без сжатия и с deflate', async () => {
    const stored = await makeZip([{ name: 'mimetype', data: 'application/epub+zip' }, { name: 'папка/текст.xhtml', data: '<p>Привет</p>' }]);
    const entries = readZip(new Uint8Array(await stored.arrayBuffer()));
    assert.equal(new TextDecoder().decode(await entries.get('папка/текст.xhtml')()), '<p>Привет</p>');
    // Запись со сжатием deflate — как в настоящих EPUB.
    const raw = Buffer.from('Сжатый текст '.repeat(50));
    const packed = deflateRawSync(raw);
    // Архив из одной записи, помеченной как сжатая: метод — в двух заголовках.
    const zip = await makeZip([{ name: 'a.txt', data: packed }]);
    const zipBytes = new Uint8Array(await zip.arrayBuffer());
    const zipView = new DataView(zipBytes.buffer);
    zipView.setUint16(8, 8, true); // метод в локальном заголовке
    const central = zipView.getUint32(zipBytes.length - 6, true);
    zipView.setUint16(central + 10, 8, true); // и в центральном каталоге
    assert.equal(new TextDecoder().decode(await readZip(zipBytes).get('a.txt')()), raw.toString());
  });

  it('формат книги — по имени или по первым байтам', () => {
    assert.equal(bookFormat('Книга.fb2'), 'fb2');
    assert.equal(bookFormat('Книга.FB2.ZIP'), 'fb2zip');
    assert.equal(bookFormat('book.epub'), 'epub');
    assert.equal(bookFormat('download', new TextEncoder().encode('<?xml version="1.0"?><FictionBook xmlns=')), 'fb2');
    assert.equal(bookFormat('file.pdf', new TextEncoder().encode('%PDF-1.7')), null);
    assert.equal(pdfName('Война и мир.fb2.zip'), 'Война и мир.pdf');
  });
});

describe('книга в читалке: примечания', () => {
  it('примечания длиннее 40% книги: все записи найдены (по оглавлению), внизу страницы — не подстрочные сноски', async () => {
    const long = 'Длинное примечание с подробным разбором источника, которое тянется строка за строкой. ';
    const book = {
      title: 'Научная книга',
      blocks: [
        { type: 'heading', level: 0, runs: [{ text: 'Глава' }] },
        ...Array.from({ length: 12 }, (_, i) => ({
          type: 'paragraph',
          runs: [{ text: `Утверждение ${i + 1} со ссылкой` }, { text: String(i + 1), sup: true }, { text: '. Дальше абзац продолжается.' }],
        })),
      ],
      notes: Array.from({ length: 12 }, (_, i) => [[{ text: `Источник ${i + 1}. ${long.repeat(6)}` }]]),
    };
    const doc = await pdfjs.getDocument({ data: await layoutBook(book, fonts), verbosity: 0 }).promise;
    const index = new TextIndex(doc, { skipFurniture: true });
    const notes = await index.endnotes();
    assert.ok(notes.fromPage / doc.numPages < 0.6, `примечания с ${notes.fromPage} из ${doc.numPages}`);
    assert.deepEqual(
      notes.entries.map((entry) => entry.key),
      Array.from({ length: 12 }, (_, i) => String(i + 1))
    );
    const page = await index.page(2);
    const ref = page.refs.find((candidate) => candidate.key === '5');
    assert.match(await index.noteFor(2, ref), /^Источник 5\./);
  });
});
