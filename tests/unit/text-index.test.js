import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  buildPageText,
  cleanForSpeech,
  detectLanguage,
  segmentSentences,
} from '../../extension/src/text-index.js';

/** Кусок текстового слоя PDF: строка на позиции (x, y) с высотой шрифта. */
function item(str, { x = 72, y = 700, size = 11, width = null, hasEOL = true } = {}) {
  return {
    str,
    transform: [size, 0, 0, size, x, y],
    width: width ?? str.length * size * 0.5,
    height: size,
    hasEOL,
  };
}

describe('buildPageText', () => {
  it('склеивает строки одного абзаца пробелом, а не переводом строки', () => {
    const { text } = buildPageText([
      item('Первая строка абзаца,', { y: 700 }),
      item('его продолжение.', { y: 684 }),
    ]);
    assert.equal(text, 'Первая строка абзаца, его продолжение.');
  });

  it('распознаёт новый абзац по увеличенному шагу между строками', () => {
    const { text } = buildPageText([
      item('Строка один.', { y: 700 }),
      item('Строка два.', { y: 684 }),
      item('Новый абзац.', { y: 640 }),
    ]);
    assert.equal(text, 'Строка один. Строка два.\nНовый абзац.');
  });

  it('ведёт карту символов на элементы текстового слоя', () => {
    const { text, entries } = buildPageText([item('Раз', { y: 700 }), item('два', { y: 684 })]);
    assert.deepEqual(entries, [
      { divIndex: 0, start: 0, end: 3 },
      { divIndex: 1, start: 4, end: 7 },
    ]);
    assert.equal(text.slice(entries[1].start, entries[1].end), 'два');
  });

  it('нумерует элементы подряд, включая пустые: иначе подсветка съедет', () => {
    const { entries } = buildPageText([
      item('Текст', { y: 700 }),
      item('', { y: 700 }),
      item('дальше', { y: 684 }),
    ]);
    assert.deepEqual(
      entries.map((entry) => entry.divIndex),
      [0, 2]
    );
  });

  it('ставит пробел между кусками одной строки, разделёнными на письме', () => {
    const { text } = buildPageText([
      item('первый', { x: 72, y: 700, width: 40, hasEOL: false }),
      item('второй', { x: 130, y: 700, hasEOL: false }),
    ]);
    assert.equal(text, 'первый второй');
  });

  it('не разрывает слово, разложенное на несколько кусков вплотную', () => {
    const { text } = buildPageText([
      item('сло', { x: 72, y: 700, width: 20, hasEOL: false }),
      item('во', { x: 92, y: 700, hasEOL: false }),
    ]);
    assert.equal(text, 'слово');
  });
});

describe('segmentSentences', () => {
  it('делит текст по предложениям', () => {
    const text = 'Первое предложение. Второе предложение! Третье?';
    const parts = segmentSentences(text, 'ru').map((range) => text.slice(range.start, range.end));
    assert.deepEqual(parts, ['Первое предложение.', 'Второе предложение!', 'Третье?']);
  });

  it('не отрывает номер главы от заголовка', () => {
    const text = 'Глава 1. Как читать';
    const parts = segmentSentences(text, 'ru').map((range) => text.slice(range.start, range.end));
    assert.deepEqual(parts, ['Глава 1. Как читать']);
  });

  it('сохраняет позиции в исходном тексте при слоговом переносе', () => {
    const text = 'Это пере-\nнос слова.';
    const [range] = segmentSentences(text, 'ru');
    assert.equal(range.start, 0);
    assert.equal(text.slice(range.start, range.end), text);
  });

  it('режет слишком длинные куски по знакам препинания', () => {
    const text = `${'слово '.repeat(60)}, ${'ещё '.repeat(60)}`;
    const ranges = segmentSentences(text, 'ru');
    assert.ok(ranges.length > 1, 'длинный кусок должен быть разбит');
    for (const range of ranges) assert.ok(range.end - range.start <= 320);
  });
});

describe('cleanForSpeech', () => {
  it('склеивает слово, разорванное переносом', () => {
    const { text } = cleanForSpeech('пере-\nнос слова');
    assert.equal(text, 'перенос слова');
  });

  it('схлопывает пробелы и переводы строк', () => {
    const { text } = cleanForSpeech('первая\n  вторая\tтретья');
    assert.equal(text, 'первая вторая третья');
  });

  it('карта ведёт в исходные позиции — по ней подсвечивается слово', () => {
    const raw = 'первая\nвторая';
    const { text, map } = cleanForSpeech(raw);
    assert.equal(text, 'первая вторая');
    assert.equal(map.length, text.length);
    assert.equal(raw[map[text.indexOf('вторая')]], 'в');
  });

  it('не оставляет хвостовых пробелов', () => {
    const { text, map } = cleanForSpeech('текст  \n');
    assert.equal(text, 'текст');
    assert.equal(map.length, 5);
  });
});

describe('detectLanguage', () => {
  it('различает русский и английский', () => {
    assert.equal(detectLanguage('Совершенно русский текст про чтение'), 'ru');
    assert.equal(detectLanguage('A plain english sentence'), 'en');
  });
});
