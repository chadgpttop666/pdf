import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createExternalApi } from '../../extension/src/tts/external-api.js';

const CLIENT = { id: 'yt-transcript@yt-skach.local' };

function fakeTera({ installed = true, available = true } = {}) {
  const calls = [];
  return {
    calls,
    available,
    isInstalled: async () => installed,
    voices: async () => [
      { id: 'tera:ru_m5', name: 'TeraTTS — мужской', installed, neural: true },
      { id: 'tera:ru_f1', name: 'TeraTTS — женский', installed, neural: true },
    ],
    preload: () => calls.push(['preload']),
    render: async (text, options) => {
      calls.push(['render', text, options]);
      return { pcm: Float32Array.of(0.1, -0.1), sampleRate: 44100, pieces: [] };
    },
  };
}

describe('озвучка для других расширений (external-api.js)', () => {
  it('чужим расширениям и страницам не отвечает', () => {
    const api = createExternalApi({ getProvider: async () => fakeTera() });
    assert.equal(api({ type: 'tts-render', text: 'Привет' }, { id: 'evil@example.com' }), undefined);
    assert.equal(api({ type: 'tts-render', text: 'Привет' }, {}), undefined);
  });

  it('на неизвестные команды молчит', () => {
    const api = createExternalApi({ getProvider: async () => fakeTera() });
    assert.equal(api({ type: 'pdf-reader-install-update' }, CLIENT), undefined);
  });

  it('фразу озвучивает выбранным голосом и отдаёт звук без лишнего', async () => {
    const tera = fakeTera();
    const api = createExternalApi({ getProvider: async () => tera });
    const reply = await api({ type: 'tts-render', text: '  Привет, мир  ', voiceId: 'tera:ru_f1' }, CLIENT);
    assert.deepEqual(Object.keys(reply).sort(), ['pcm', 'sampleRate']);
    assert.equal(reply.sampleRate, 44100);
    assert.deepEqual(tera.calls, [['render', 'Привет, мир', { voiceId: 'tera:ru_f1' }]]);
  });

  it('без голоса — мужской TeraTTS; чужие голоса не принимает', async () => {
    const tera = fakeTera();
    const api = createExternalApi({ getProvider: async () => tera });
    await api({ type: 'tts-render', text: 'Раз' }, CLIENT);
    assert.equal(tera.calls[0][2].voiceId, 'tera:ru_m5');
    await assert.rejects(api({ type: 'tts-render', text: 'Раз', voiceId: 'piper:irina' }, CLIENT), /Неизвестный голос/);
  });

  it('пустую и огромную фразу не синтезирует', async () => {
    const tera = fakeTera();
    const api = createExternalApi({ getProvider: async () => tera });
    await assert.rejects(api({ type: 'tts-render', text: '   ' }, CLIENT), /Пустая фраза/);
    await assert.rejects(api({ type: 'tts-render', text: 'а'.repeat(5000) }, CLIENT), /длиннее/);
    assert.deepEqual(tera.calls, []);
  });

  it('голоса не скачаны — понятная ошибка с подсказкой', async () => {
    const api = createExternalApi({ getProvider: async () => fakeTera({ installed: false }) });
    await assert.rejects(api({ type: 'tts-render', text: 'Привет' }, CLIENT), /Голоса и модели/);
    const voices = await api({ type: 'tts-voices' }, CLIENT);
    assert.equal(voices.installed, false);
    assert.deepEqual(voices.voices.map((voice) => voice.id), ['tera:ru_m5', 'tera:ru_f1']);
  });

  it('заранее загружает модели по просьбе', async () => {
    const tera = fakeTera();
    const api = createExternalApi({ getProvider: async () => tera });
    assert.deepEqual(await api({ type: 'tts-preload' }, CLIENT), { ok: true });
    assert.deepEqual(tera.calls, [['preload']]);
  });
});
