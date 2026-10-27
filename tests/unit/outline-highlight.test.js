import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { simplifyOutline } from '../../extension/src/outline.js';
import { mergeRectsByLine } from '../../extension/src/tts/highlighter.js';

const node = (title, items = [], dest = null) => ({ title, items, dest });

describe('simplifyOutline', () => {
  it('схлопывает цепочку одинаковых заголовков, как в книгах из FB2', () => {
    const outline = simplifyOutline([
      node('Предисловие', [node('Предисловие', [node('Предисловие', [node('* * *'), node('* * *')])])], 'p1'),
    ]);
    assert.equal(outline.length, 1);
    assert.equal(outline[0].title, 'Предисловие');
    assert.deepEqual(
      outline[0].items.map((item) => item.title),
      ['* * *', '* * *']
    );
    assert.equal(outline[0].dest, 'p1');
  });

  it('берёт назначение у потомка, если у верхнего пункта его нет', () => {
    const [chapter] = simplifyOutline([node('Глава I', [node('Глава I', [], 'ch1')])]);
    assert.equal(chapter.dest, 'ch1');
    assert.deepEqual(chapter.items, []);
  });

  it('не трогает разные заголовки и пункты с несколькими потомками', () => {
    const outline = simplifyOutline([node('Часть 1', [node('Глава 1')]), node('Часть 2', [node('Часть 2'), node('Глава 2')])]);
    assert.equal(outline[0].items[0].title, 'Глава 1');
    assert.equal(outline[1].items.length, 2);
  });

  it('сравнивает названия без учёта регистра и лишних пробелов', () => {
    const [chapter] = simplifyOutline([node('Глава  I', [node('глава i', [node('* * *')])])]);
    assert.equal(chapter.items[0].title, '* * *');
  });
});

describe('mergeRectsByLine', () => {
  const rect = (left, top, width, height = 20) => ({ left, top, right: left + width, bottom: top + height });

  it('сливает слова одной строки в сплошную полосу', () => {
    const lines = mergeRectsByLine([rect(10, 100, 40), rect(60, 101, 30), rect(100, 100, 50)]);
    assert.equal(lines.length, 1);
    assert.equal(lines[0].left, 10);
    assert.equal(lines[0].right, 150);
  });

  it('разные строки остаются разными полосами', () => {
    const lines = mergeRectsByLine([rect(10, 100, 40), rect(10, 130, 40), rect(60, 100, 30)]);
    assert.equal(lines.length, 2);
    assert.deepEqual(
      lines.map((line) => line.top),
      [100, 130]
    );
  });
});
