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
    assert.deepEqual(pickLanguages('Красная нить любого длинного текста — это непрерывность.'), ['rus']);
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
