import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createStretcher, timeStretch } from '../../extension/src/tts/time-stretch.js';

const sine = (hz, seconds, sampleRate) => Float32Array.from({ length: Math.round(seconds * sampleRate) }, (_, i) => Math.sin((2 * Math.PI * hz * i) / sampleRate));

/** Частота по числу переходов через ноль — в середине записи, без краёв. */
function frequency(pcm, sampleRate) {
  const from = Math.floor(pcm.length * 0.1);
  const to = Math.floor(pcm.length * 0.9);
  let crossings = 0;
  for (let i = from + 1; i < to; i += 1) if (pcm[i - 1] < 0 !== pcm[i] < 0) crossings += 1;
  return crossings / 2 / ((to - from) / sampleRate);
}

function rms(pcm) {
  const middle = pcm.subarray(Math.floor(pcm.length * 0.1), Math.floor(pcm.length * 0.9));
  return Math.sqrt(middle.reduce((sum, v) => sum + v * v, 0) / middle.length);
}

describe('ускорение речи без изменения высоты голоса', () => {
  it('на 1× — та же запись', () => {
    const pcm = sine(200, 0.2, 22050);
    assert.deepEqual(timeStretch(pcm, 22050, 1), pcm);
  });

  for (const rate of [0.7, 1.5, 2, 2.5]) {
    it(`${rate}×: длина — исходная / ${rate}, высота и громкость те же`, () => {
      for (const [hz, sampleRate] of [
        [110, 44100],
        [220, 22050],
      ]) {
        const pcm = sine(hz, 1, sampleRate);
        const out = timeStretch(pcm, sampleRate, rate);
        assert.equal(out.length, Math.ceil(pcm.length / rate));
        assert.ok(Math.abs(frequency(out, sampleRate) / hz - 1) < 0.03, `${hz} Гц → ${frequency(out, sampleRate).toFixed(1)}`);
        // Окна складываются в фазе — волна не гасит сама себя.
        assert.ok(Math.abs(rms(out) / Math.SQRT1_2 - 1) < 0.05, `громкость ${rms(out).toFixed(3)}`);
        assert.ok(out.every(Number.isFinite));
      }
    });
  }

  it('кусками — то же, что целиком', () => {
    const pcm = sine(150, 0.8, 44100);
    const whole = timeStretch(pcm, 44100, 1.7);
    const stretcher = createStretcher(pcm, 44100, 1.7);
    const parts = [];
    for (const size of [1000, 13230, 7, 50000, 100000]) {
      const block = stretcher.take(size);
      if (block) parts.push(...block);
    }
    assert.equal(stretcher.take(10), null);
    assert.equal(parts.length, whole.length);
    assert.deepEqual(Float32Array.from(parts), whole);
  });

  it('начало записи не гаснет: окна у края нормированы', () => {
    const pcm = new Float32Array(4410).fill(0.5);
    const out = timeStretch(pcm, 44100, 1.5);
    assert.ok(Math.abs(out[1] - 0.5) < 1e-6 && Math.abs(out[200] - 0.5) < 1e-6, `${out[1]} ${out[200]}`);
  });
});
