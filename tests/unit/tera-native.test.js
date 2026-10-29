import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { compareVersions, createHelperClient, missingModels, syncModels } from '../../extension/src/tts/tera-native.js';

/** Порт как у runtime.connectNative; ответы помощника задаёт reply(message, send). */
function fakePort(reply) {
  const listeners = { message: [], disconnect: [] };
  const sent = [];
  const send = (message) => queueMicrotask(() => listeners.message.forEach((fn) => fn(message)));
  const port = {
    sent,
    onMessage: { addListener: (fn) => listeners.message.push(fn) },
    onDisconnect: { addListener: (fn) => listeners.disconnect.push(fn) },
    postMessage(message) {
      sent.push(structuredClone(message));
      reply(message, send);
    },
    disconnect() {},
    drop(error) {
      port.error = { message: error };
      listeners.disconnect.forEach((fn) => fn(port));
    },
  };
  return port;
}

const base64 = (bytes) => Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('base64');

describe('клиент ускорителя (tera-native.js)', () => {
  it('звук фразы собирается из кусков по порядку', async () => {
    const pcm = Float32Array.from({ length: 10 }, (_, i) => i / 10);
    const port = fakePort((message, send) => {
      if (message.type !== 'synth') return;
      send({ type: 'audio', id: message.id, part: 0, parts: 2, samples: 10, sampleRate: 44100, data: base64(pcm.subarray(0, 6)), last: false });
      send({ type: 'audio', id: message.id, part: 1, parts: 2, samples: 10, sampleRate: 44100, data: base64(pcm.subarray(6)), last: true });
    });
    const client = createHelperClient(port);
    const result = await client.synth({ ids: BigInt64Array.of(5n, 7n), plain: BigInt64Array.of(5n), ttl: Float32Array.of(1.5), dp: Float32Array.of(-2), epoch: 3 });
    assert.deepEqual(Array.from(result.pcm), Array.from(pcm));
    assert.equal(result.sampleRate, 44100);
    const [request] = port.sent;
    assert.deepEqual(request.ids, [5, 7]);
    assert.deepEqual(request.plain, [5]);
    assert.equal(request.epoch, 3);
    // Стиль — float32 в base64, как его читает помощник.
    assert.deepEqual(Array.from(new Float32Array(Uint8Array.from(Buffer.from(request.ttl, 'base64')).buffer)), [1.5]);
  });

  it('ошибка и «фраза не нужна» — отказом с пометкой', async () => {
    const port = fakePort((message, send) => send({ type: 'error', id: message.id, message: 'Фраза больше не нужна', dropped: true }));
    const client = createHelperClient(port);
    await assert.rejects(client.synth({ ids: [1], plain: [1], ttl: new Float32Array(1), dp: new Float32Array(1) }), (error) => error.dropped === true);
  });

  it('помощник отключился — ждущие запросы отклоняются, слушатели узнают', async () => {
    const port = fakePort(() => {});
    const client = createHelperClient(port);
    let heard = null;
    client.onClose((error) => (heard = error.message));
    const waiting = client.hello();
    port.drop('No such native application pdf_reader_tts');
    await assert.rejects(waiting, /No such native application/);
    assert.match(heard, /No such native application/);
    await assert.rejects(client.hello(), /No such native application/);
  });

  it('файл уходит кусками по 4 МБ, каждый — после подтверждения', async () => {
    const port = fakePort((message, send) => send({ type: 'file-ok', id: message.id, name: message.name, done: message.last }));
    const client = createHelperClient(port);
    const blob = new Blob([new Uint8Array(9 * 1024 * 1024).fill(7)]);
    const progress = [];
    await client.sendFile('sampler', blob, (loaded) => progress.push(loaded));
    assert.deepEqual(
      port.sent.map(({ offset, last }) => [offset, last]),
      [
        [0, false],
        [4 * 1024 * 1024, false],
        [8 * 1024 * 1024, true],
      ]
    );
    assert.equal(progress.at(-1), blob.size);
    assert.equal(port.sent.reduce((sum, message) => sum + Buffer.from(message.data, 'base64').length, 0), blob.size);
  });

  it('передаются только модели, которых у помощника нет или они другие', async () => {
    const blobs = { textEncoder: new Blob(['a']), duration: new Blob(['bb']), sampler: new Blob(['ccc']), vocoder: new Blob(['dddd']) };
    assert.deepEqual(missingModels({ textEncoder: 1, duration: 2, sampler: 99 }, { textEncoder: 1, duration: 2, sampler: 3, vocoder: 4 }), ['sampler', 'vocoder']);
    const port = fakePort((message, send) => send({ type: 'file-ok', id: message.id }));
    const sent = await syncModels(createHelperClient(port), { textEncoder: 1, duration: 2, sampler: 3, vocoder: 4 }, blobs);
    assert.deepEqual(sent, []);
    assert.equal(port.sent.length, 0);
  });

  it('версии сравниваются по числам', () => {
    assert.equal(compareVersions('1.0.0', '1.0.0'), 0);
    assert.equal(compareVersions('1.2.0', '1.10.0'), -1);
    assert.equal(compareVersions('2.0', '1.9.9'), 1);
  });
});
