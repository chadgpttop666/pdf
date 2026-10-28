import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { classifyFurniture, normalizeFurniture, profileFurniture } from '../../extension/src/page-furniture.js';
import { buildPageText, groupLines } from '../../extension/src/text-index.js';

const BOX = { bottom: 0, top: 842 };

function item(str, { x = 72, y = 700, size = 14, width = null } = {}) {
  return { str, transform: [size, 0, 0, size, x, y], width: width ?? str.length * size * 0.5, height: size, hasEOL: true };
}

/** Страница книги: колонтитул, текст, сноска и номер внизу. */
function bookPage(number, { header = 'Как читать с экрана', footnote = false } = {}) {
  const items = [
    item(header, { x: 230, y: 790, size: 11 }),
    item('Длинная строка основного текста книги, набранная по ширине полосы.', { y: 700, width: 450 }),
    item('Ещё одна строка основного текста, тоже до самого края полосы набора.', { y: 680, width: 450 }),
  ];
  if (footnote) items.push(item('1 Микрофильм — фотокопия документа на плёнке.', { y: 80, size: 10, width: 300 }));
  items.push(item(String(number), { x: 290, y: 40, size: 11 }));
  return items;
}

const sample = (items) => ({ lines: groupLines(items), box: BOX });

describe('normalizeFurniture', () => {
  it('не различает строки, отличающиеся только цифрами и римскими номерами', () => {
    assert.equal(normalizeFurniture('Глава 3 · 45'), normalizeFurniture('Глава 4 · 61'));
    assert.equal(normalizeFurniture('Часть IV'), normalizeFurniture('Часть II'));
  });
});

describe('profileFurniture и classifyFurniture', () => {
  const profile = profileFurniture([1, 2, 3, 4, 5].map((n) => sample(bookPage(n))));

  it('находит повторяющийся колонтитул и номер страницы', () => {
    assert.ok(profile.patterns.has('top:как читать с экрана'));
    assert.equal(profile.bodySize, 14);
  });

  it('выбрасывает колонтитул, номер страницы и сноску, но не текст', () => {
    const items = bookPage(7, { footnote: true });
    const { text } = buildPageText(items, (lines) => classifyFurniture(lines, BOX, profile));
    assert.ok(text.startsWith('Длинная строка'), text);
    assert.ok(!text.includes('Как читать'), text);
    assert.ok(!text.includes('Микрофильм'), text);
    assert.ok(!/\b7\b/.test(text), text);
  });

  it('не трогает заголовок, который встретился только один раз', () => {
    const items = [item('Глава I. Красная нить', { x: 200, y: 790, size: 16 }), ...bookPage(8).slice(1)];
    const { text } = buildPageText(items, (lines) => classifyFurniture(lines, BOX, profile));
    assert.ok(text.startsWith('Глава I. Красная нить'), text);
  });

  it('убирает мелкий знак сноски внутри строки и не оставляет пробела перед точкой', () => {
    const items = [
      { ...item('аппараты для микрофильмов', { y: 500, width: 200 }), hasEOL: false },
      { ...item('1', { x: 272, y: 505, size: 8, width: 4 }), hasEOL: false },
      item('.', { x: 278, y: 500, width: 4 }),
    ];
    const { text } = buildPageText(items, (lines) => classifyFurniture(lines, BOX, profile));
    assert.equal(text, 'аппараты для микрофильмов.');
  });

  it('номера спанов не сдвигаются от выброшенных строк', () => {
    const items = bookPage(9);
    const { entries } = buildPageText(items, (lines) => classifyFurniture(lines, BOX, profile));
    assert.deepEqual(
      entries.map((entry) => entry.spanIndex),
      [1, 2]
    );
  });
});
