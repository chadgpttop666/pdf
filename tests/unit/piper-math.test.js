import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { estimateWordTimings, splitPhrases } from '../../extension/src/tts/piper-math.js';

describe('нейроголос Piper', () => {
  it('фонемы режутся на фразы по маркеру начала', () => {
    assert.deepEqual(splitPhrases([1, 0, 28, 0, 2, 1, 0, 74, 0, 2]), [
      [1, 0, 28, 0, 2],
      [1, 0, 74, 0, 2],
    ]);
    assert.deepEqual(splitPhrases([1, 0, 5, 0, 2]), [[1, 0, 5, 0, 2]]);
    assert.deepEqual(splitPhrases([]), []);
  });

  it('время слов растёт по доле произнесённых букв', () => {
    const text = 'Мама мыла раму, а папа — окно.';
    const timings = estimateWordTimings(text);
    assert.deepEqual(
      timings.map(({ charIndex, charLength }) => text.slice(charIndex, charIndex + charLength)),
      ['Мама', 'мыла', 'раму', 'а', 'папа', 'окно']
    );
    assert.equal(timings[0].at, 0);
    assert.equal(timings[1].at, 4 / 21); // 21 буква всего
    assert.ok(timings.every((timing, i) => i === 0 || timing.at > timings[i - 1].at));
    assert.ok(timings.at(-1).at < 1);
  });

  it('слова с дефисом и цифрами — целиком; без букв — пусто', () => {
    const timings = estimateWordTimings('Из-за 2-х глав.');
    assert.deepEqual(timings.map((timing) => timing.charLength), [5, 3, 4]);
    assert.deepEqual(estimateWordTimings('* * *'), []);
  });
});

describe('тайминги слов с заменами', () => {
  it('число звучит дольше — следующее слово позже', () => {
    const text = 'В 1928 году.';
    const segments = [{ start: 2, end: 6, spoken: 'тысяча девятьсот двадцать восьмом' }];
    const timings = estimateWordTimings(text, segments);
    assert.deepEqual(timings.map((timing) => text.slice(timing.charIndex, timing.charIndex + timing.charLength)), ['В', '1928', 'году']);
    // «В» = 1 буква, замена = 30 букв, «году» = 4: «году» начинается на 31/35.
    assert.equal(timings[2].at, 31 / 35);
  });
});
