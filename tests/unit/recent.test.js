import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createRecent } from '../../extension/src/tts/recent.js';

describe('прозвучавшие фразы держатся ещё немного (recent.js)', () => {
  it('не дольше заданного и не больше заданного числа; ушедшие отпускаются', () => {
    let time = 0;
    const dropped = [];
    const recent = createRecent((key) => dropped.push(key), { keepMs: 1000, max: 3, now: () => time });
    for (const key of ['a', 'b', 'c']) recent.add(key);
    assert.deepEqual(recent.keys(), ['a', 'b', 'c']);
    recent.add('d'); // четвёртая — самая старая уходит
    assert.deepEqual(dropped, ['a']);
    time = 500;
    recent.add('b'); // прозвучала снова — свежая
    assert.deepEqual(recent.keys(), ['c', 'd', 'b']);
    time = 1200; // c и d старше секунды
    assert.deepEqual(recent.keys(), ['b']);
    assert.deepEqual(dropped, ['a', 'c', 'd']);
    assert.equal(recent.has('b'), true);
    time = 1600;
    assert.equal(recent.has('b'), false);
  });
});
