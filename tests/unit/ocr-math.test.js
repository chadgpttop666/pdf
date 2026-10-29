import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { OCR_FONT, isTextless, ocrLinesToItems, textLength } from '../../extension/src/ocr-math.js';
import { buildPageText } from '../../extension/src/text-index.js';

const word = (text, x0, x1, y0 = 100, y1 = 130, confidence = 90) => ({ text, confidence, bbox: { x0, y0, x1, y1 } });

// Картинка 2× крупнее страницы высотой 800 pt, без поворота.
const unrotated = (x, y) => [x / 2, 800 - y / 2];

describe('распознанный текст → текстовый слой', () => {
  it('слова одной строки — на одной базовой линии, с пробелами до следующего слова', () => {
    const items = ocrLinesToItems([{ words: [word('Красная', 100, 260), word('нить', 280, 360)] }], unrotated);
    assert.equal(items.length, 2);
    assert.deepEqual(items.map((item) => item.str), ['Красная ', 'нить']);
    assert.deepEqual(items.map((item) => item.hasEOL), [false, true]);
    // Высота строки 30 px = 15 pt; базовая линия на 80% высоты от верха.
    assert.deepEqual(items[0].transform, [15, 0, 0, 15, 50, 800 - 124 / 2]);
    assert.equal(items[0].width, (280 - 100) / 2); // до начала следующего слова
    assert.equal(items[1].width, (360 - 280) / 2);
    assert.ok(items.every((item) => item.fontName === OCR_FONT));
  });

  it('неуверенные слова (шум с картинок) отбрасываются', () => {
    const items = ocrLinesToItems([{ words: [word('шум', 0, 10, 0, 10, 12), word('текст', 20, 80)] }], unrotated, { minConfidence: 40 });
    assert.deepEqual(items.map((item) => item.str), ['текст']);
    assert.deepEqual(ocrLinesToItems([{ words: [word('  ', 0, 10)] }], unrotated), []);
  });

  it('на странице, повёрнутой на 90°, строка идёт вдоль своей оси', () => {
    // Поворот: x картинки идёт вверх по странице PDF.
    const rotated = (x, y) => [y / 2, x / 2];
    const [item] = ocrLinesToItems([{ words: [word('Слово', 100, 200)] }], rotated);
    const [a, b, c, d] = item.transform;
    assert.ok(Math.abs(a) < 1e-9 && b > 0, 'направление текста — вдоль оси y');
    assert.ok(c < 0 && Math.abs(d) < 1e-9, 'верх букв — перпендикулярно');
    assert.equal(item.width, 50);
  });

  it('распознанная страница даёт связный текст для озвучки', () => {
    const lines = [
      { words: [word('Красная', 100, 260, 100, 130), word('нить', 280, 360, 100, 130)] },
      { words: [word('любого', 100, 230, 150, 180), word('текста.', 250, 380, 150, 180)] },
    ];
    const { text } = buildPageText(ocrLinesToItems(lines, unrotated));
    assert.equal(text.replace(/\s+/g, ' ').trim(), 'Красная нить любого текста.');
  });

  it('страница без текста — меньше 20 знаков', () => {
    assert.equal(textLength([{ str: ' 12 ' }, { str: 'стр.' }]), 6);
    assert.equal(isTextless([{ str: '12' }]), true);
    assert.equal(isTextless([{ str: 'Достаточно длинная строка текста' }]), false);
  });
});

describe('язык распознавания', () => {
  it('по доле кириллицы', async () => {
    const { pickLanguages } = await import('../../extension/src/ocr-math.js');
    assert.deepEqual(pickLanguages('Красная нить любого длинного текста — это непрерывность.'), ['rus', 'eng']);
    assert.deepEqual(pickLanguages('The red thread of any long text is continuity itself.'), ['eng']);
    assert.deepEqual(pickLanguages('Глава о PDF: viewer, reader и прочие tools для чтения'), ['rus', 'eng']);
    assert.equal(pickLanguages('12 стр.'), null);
  });
});

describe('отбор слов распознавания', () => {
  it('неуверенное слово в хорошей строке остаётся', () => {
    const line = { words: [word('философа', 0, 100, 0, 20, 95), word('Кимлики', 110, 200, 0, 20, 92), word('слу-', 210, 250, 0, 20, 31)] };
    assert.deepEqual(ocrLinesToItems([line], unrotated, { minConfidence: 40 }).map((item) => item.str.trim()), ['философа', 'Кимлики', 'слу-']);
  });
});

describe('латинские двойники в русском тексте', () => {
  it('русское слово из «двойников» возвращается в кириллицу, английские названия остаются', async () => {
    const { fixHomoglyphs } = await import('../../extension/src/ocr-math.js');
    const line = (text) => fixHomoglyphs(text.split(' ').map((t) => ({ text: t, confidence: 90, bbox: {} }))).map((w) => w.text).join(' ');
    assert.equal(line('силы Ha TO, чтобы снова'), 'силы на то, чтобы снова');
    assert.equal(line('проект (Great Ape Project), международное'), 'проект (Great Ape Project), международное');
    assert.equal(line('журнал («Ethics»), посвящённый'), 'журнал («Ethics»), посвящённый');
    assert.equal(line('в сеpдце и'), 'в сердце и');
    assert.equal(line('[Cavalieri, Singer 1993]'), '[Cavalieri, Singer 1993]');
    assert.equal(line('трех западных 30Н).'), 'трех западных зон).');
    assert.equal(line('в 30-х годах и 300 лет'), 'в 30-х годах и 300 лет');
  });
});

describe('шум в хорошей строке', () => {
  it('неуверенное тире в широком пробеле выбрасывается, неуверенное слово — нет', () => {
    const line = {
      words: [word('поручена', 0, 100, 0, 20, 95), word('—', 110, 130, 0, 20, 22), word('разработка', 140, 260, 0, 20, 93), word('слу-', 270, 300, 0, 20, 31)],
    };
    assert.deepEqual(ocrLinesToItems([line], unrotated, { minConfidence: 40 }).map((item) => item.str.trim()), ['поручена', 'разработка', 'слу-']);
  });
});

describe('ложные тире в строке по ширине', () => {
  it('узкая чёрточка в широком пробеле — шум, тире во всю высоту строки — текст', () => {
    const line = {
      words: [
        word('поручена', 0, 100, 0, 36, 95),
        word('—', 110, 125, 0, 36, 73),
        word('разработка', 140, 260, 0, 36, 93),
        word('—', 270, 304, 0, 36, 90),
        word('это', 320, 360, 0, 36, 95),
      ],
    };
    assert.deepEqual(ocrLinesToItems([line], unrotated).map((item) => item.str.trim()), ['поручена', 'разработка', '—', 'это']);
  });
});

describe('пометки на полях скана', () => {
  // Колонка текста — x от 100 до 900; на левом поле рукописный номер,
  // который tesseract читает кусками в начале строк (как на скриншоте).
  const row = (y, parts) => {
    const words = [];
    for (const [text, x0, x1, confidence = 92] of parts) words.push(word(text, x0, x1, y, y + 30, confidence));
    return { words };
  };
  const spread = (y, text, from = 100, to = 900) => {
    const tokens = text.split(' ');
    const step = (to - from) / tokens.length;
    return tokens.map((token, i) => [token, Math.round(from + i * step), Math.round(from + (i + 1) * step - 12)]);
  };
  const page = [
    row(100, [['А}', 10, 40, 41], ...spread(100, 'Одним из поводов для написания этой книги стала моя убеждённость', 150)]),
    row(140, [['fo', 15, 35, 52], ['в', 100, 115], ['TOM,', 125, 185], ...spread(140, 'что в данной области ведётся масштабная, интересная и важная', 200)]),
    row(180, [['Го', 12, 38, 47], ...spread(180, 'работа. Проще говоря, интеллектуальный ландшафт в политической')]),
    row(220, spread(220, 'философии сегодня очень отличается от того, каким он был 20 или даже')),
    row(260, [['(например,', 100, 250], [':', 262, 268, 70], ...spread(260, 'развитие Р. Нозиком теории естественных прав Дж. Локка), но', 280)]),
  ];

  it('колонка текста — по краям строк', async () => {
    const { textColumn } = await import('../../extension/src/ocr-math.js');
    const column = textColumn(page);
    assert.ok(Math.abs(column.left - 100) < 20 && Math.abs(column.right - 888) < 20, JSON.stringify(column));
    // Две колонки: начала строк не у одного края — не трогаем ничего.
    const twoColumns = [0, 1, 2, 3, 4, 5].map((i) => row(100 + i * 40, spread(0, 'раз два три четыре пять', i % 2 ? 520 : 100, i % 2 ? 900 : 480)));
    assert.equal(textColumn(twoColumns), null);
  });

  it('мусор с полей уходит, абзац не рвётся, «TOM» становится «том», соринка-знак исчезает', () => {
    const { text } = buildPageText(ocrLinesToItems(page, unrotated, { minConfidence: 40 }));
    assert.ok(!/А\}|fo|Го /.test(text), text);
    assert.ok(text.startsWith('Одним из поводов'), text);
    assert.ok(text.includes('убеждённость в том, что'), text);
    assert.ok(text.includes('важная работа. Проще говоря'), text);
    assert.ok(text.includes('(например, развитие'), text);
    assert.ok(!text.includes('\n'), 'один абзац, без ложных разрывов');
  });

  it('длинное уверенное слово на поле — текст, а не пометка', () => {
    const withNote = [...page, row(300, [['Примечание', 10, 90, 95], ...spread(300, 'дальше идёт обычная строка текста книги', 100)])];
    const { text } = buildPageText(ocrLinesToItems(withNote, unrotated));
    assert.ok(text.includes('Примечание'), text);
  });

  it('огрызок из двух латинских букв не мешает исправить «двойников»', async () => {
    const { fixHomoglyphs } = await import('../../extension/src/ocr-math.js');
    const words = ['fo', 'в', 'TOM,', 'что'].map((text) => ({ text, confidence: 90, bbox: {} }));
    assert.deepEqual(fixHomoglyphs(words).map((w) => w.text), ['fo', 'в', 'том,', 'что']);
  });
});

describe('пометки на полях: короткие слова в начале строк', () => {
  it('строки, начинающиеся с «в», «и», не сдвигают край колонки', async () => {
    const { textColumn } = await import('../../extension/src/ocr-math.js');
    const line = (y, first) => ({
      words: [word(first, 100, 112, y, y + 30), word('длинное', 130, 300, y, y + 30), word('слово', 320, 450, y, y + 30), word('строки', 470, 900, y, y + 30)],
    });
    const lines = [line(100, 'в'), line(140, 'и'), line(180, 'на'), line(220, 'Абзац'), line(260, 'к')];
    const column = textColumn(lines);
    assert.equal(column.left, 100);
    const { text } = buildPageText(ocrLinesToItems(lines, unrotated));
    assert.ok(text.startsWith('в длинное слово строки и длинное'), text);
  });
});
