import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { StressIndex, StressIndexBuilder, buildStressIndex, parseAccentLine, splitLines } from '../../extension/src/tts/stress-index.js';

describe('словарь ударений', () => {
  it('строка словаря → слово и место ударения', () => {
    assert.deepEqual(parseAccentLine(' "аароновец": "аар+оновец",'), ['аароновец', 3]);
    assert.deepEqual(parseAccentLine('"замок": "з+амок"'), ['замок', 1]);
    assert.equal(parseAccentLine('{'), null);
    assert.equal(parseAccentLine(' "аав": "аав",'), null, 'без ударения — не запись');
    assert.equal(parseAccentLine(' "дом": "д+ам",'), null, 'значение не совпадает со словом');
  });

  it('индекс находит слова и не находит чужих', () => {
    const builder = new StressIndexBuilder(2); // маленькая ёмкость — проверим рост
    const words = { все: 2, всё: 2, году: 1, справедливости: 8, на: 1 };
    for (const [word, position] of Object.entries(words)) builder.add(word, position);
    const index = new StressIndex(builder.finish());
    assert.equal(index.size, 5);
    for (const [word, position] of Object.entries(words)) assert.equal(index.lookup(word), position, word);
    assert.equal(index.lookup('кимлика'), -1);
    assert.equal(index.accent('справедливости'), 'справедл+ивости');
    assert.equal(index.accent('кимлика'), null);
  });

  it('строится из потока кусков текста, режущих строки где попало', async () => {
    const text = '{\n "аароновец": "аар+оновец",\n "замок": "з+амок",\n "мука": "м+ука"\n}';
    const chunks = [text.slice(0, 17), text.slice(17, 40), text.slice(40)];
    const index = new StressIndex(await buildStressIndex(splitLines(chunks)));
    assert.equal(index.size, 3);
    assert.equal(index.accent('замок'), 'з+амок');
    assert.equal(index.accent('аароновец'), 'аар+оновец');
  });

  it('чужой буфер не принимается', () => {
    assert.throws(() => new StressIndex(new ArrayBuffer(16)), /повреждён/);
  });
});
