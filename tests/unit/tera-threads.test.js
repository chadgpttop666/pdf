import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { samplerCount } from '../../extension/src/tts/tera-threads.js';

describe('сколько потоков синтеза TeraTTS', () => {
  it('«сами»: на обычной скорости один, от 1,3× — два', () => {
    assert.equal(samplerCount('auto', { rate: 1, cores: 8 }), 1);
    assert.equal(samplerCount('auto', { rate: 1.2, cores: 8 }), 1);
    assert.equal(samplerCount('auto', { rate: 1.3, cores: 8 }), 2);
    assert.equal(samplerCount('auto', { rate: 2, cores: 8 }), 2);
  });

  it('«сами»: синтез уже не успевал — второй поток и на 1×', () => {
    assert.equal(samplerCount('auto', { rate: 1, lagging: true, cores: 4 }), 2);
  });

  it('«сами»: три — только на очень большой скорости и 8+ ядрах', () => {
    assert.equal(samplerCount('auto', { rate: 2.5, cores: 8 }), 3);
    assert.equal(samplerCount('auto', { rate: 2.5, cores: 4 }), 2);
  });

  it('на двух ядрах — один поток: остальным частям синтеза тоже нужно ядро', () => {
    assert.equal(samplerCount('auto', { rate: 2, cores: 2 }), 1);
  });

  it('выбранное вручную — как есть', () => {
    assert.equal(samplerCount('1', { rate: 3, lagging: true, cores: 16 }), 1);
    assert.equal(samplerCount('3', { rate: 1, cores: 2 }), 3);
    assert.equal(samplerCount('мусор'), 1);
  });
});
