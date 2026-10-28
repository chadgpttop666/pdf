import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  cleanForSpeech,
  cleanedIndexForRaw,
  offsetToSpanPoint,
  spanPointToOffset,
} from '../../extension/src/text-index.js';

// «Первая строка» + пробел + «вторая» — спан 2 выброшен как колонтитул.
const entries = [
  { spanIndex: 0, start: 0, end: 13 },
  { spanIndex: 1, start: 14, end: 20 },
  { spanIndex: 3, start: 21, end: 30 },
];

describe('координаты выделений', () => {
  it('позиция в тексте страницы переводится в спан и обратно', () => {
    for (const offset of [0, 7, 13, 14, 17, 20, 21, 25, 30]) {
      const point = offsetToSpanPoint(entries, offset);
      assert.equal(spanPointToOffset(entries, point), offset, `смещение ${offset}`);
    }
  });

  it('граница спанов: конец предыдущего и начало следующего различаются', () => {
    assert.deepEqual(offsetToSpanPoint(entries, 14), { span: 1, offset: 0 });
    assert.deepEqual(offsetToSpanPoint(entries, 20), { span: 1, offset: 6 });
  });

  it('за концом текста — конец последнего спана', () => {
    assert.deepEqual(offsetToSpanPoint(entries, 99), { span: 3, offset: 9 });
    assert.equal(offsetToSpanPoint([], 5), null);
  });

  it('выброшенный спан не даёт позиции', () => {
    assert.equal(spanPointToOffset(entries, { span: 2, offset: 0 }), null);
    assert.equal(spanPointToOffset(entries, { span: 0, offset: 99 }), 13);
  });

  it('очищенный текст: позиция в исходном переводится с учётом переносов', () => {
    const raw = 'пере-\nнос слова';
    const { text, map } = cleanForSpeech(raw);
    assert.equal(text, 'перенос слова');
    const rawStart = raw.indexOf('слова');
    assert.equal(text.slice(cleanedIndexForRaw(map, rawStart)), 'слова');
    assert.equal(cleanedIndexForRaw(map, raw.length), text.length);
  });
});
