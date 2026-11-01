import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createHelperClient, pcm16Bytes } from '../../extension/src/tts/tera-native.js';
import { formatSeconds } from '../../extension/src/voice/recorder.js';
import { SPEECH_MODELS, VAD_MODEL, WHISPER_MODEL, missingSpeechModels, resample } from '../../extension/src/voice/whisper.js';

/** Порт помощника, который подтверждает каждое сообщение. */
function echoPort(reply = (message) => ({ type: `${message.type}-ok`, id: message.id })) {
  const listeners = [];
  const sent = [];
  return {
    sent,
    onMessage: { addListener: (fn) => listeners.push(fn) },
    onDisconnect: { addListener() {} },
    postMessage(message) {
      sent.push(message);
      queueMicrotask(() => listeners.forEach((fn) => fn(reply(message))));
    },
    disconnect() {},
  };
}

/** Поток из нескольких кусков произвольной длины — как ответ fetch. */
function streamOf(bytes, sizes) {
  let offset = 0;
  let index = 0;
  return new ReadableStream({
    pull(controller) {
      if (offset >= bytes.length) return controller.close();
      const size = sizes[index++ % sizes.length];
      controller.enqueue(bytes.subarray(offset, offset + size));
      offset += size;
    },
  });
}

describe('голосовые заметки', () => {
  it('модель из потока уходит помощнику кусками по 4 МБ, по порядку, с хэшем', async () => {
    const size = 9 * 1024 * 1024 + 123;
    const bytes = Uint8Array.from({ length: size }, (_, i) => i % 251);
    const port = echoPort();
    const client = createHelperClient(port);
    const progress = [];
    await client.streamFile('whisper', streamOf(bytes, [1_000_003, 777_777, 3_333_333]), { size, sha256: 'abc' }, (loaded) => progress.push(loaded));
    assert.equal(port.sent.length, 3);
    assert.deepEqual(port.sent.map((m) => m.offset), [0, 4 * 1024 * 1024, 8 * 1024 * 1024]);
    assert.deepEqual(port.sent.map((m) => m.last), [false, false, true]);
    assert.ok(port.sent.every((m) => m.name === 'whisper' && m.sha256 === 'abc' && m.size === size));
    const joined = Buffer.concat(port.sent.map((m) => Buffer.from(m.data, 'base64')));
    assert.ok(joined.equals(Buffer.from(bytes)));
    assert.equal(progress.at(-1), size);
  });

  it('оборванная загрузка — ошибка, а не неполный файл у помощника', async () => {
    const client = createHelperClient(echoPort());
    await assert.rejects(client.streamFile('vad', streamOf(new Uint8Array(500), [500]), { size: 1000, sha256: 'x' }), /оборвалась/);
  });

  it('звук для расшифровки — 16 бит со знаком, с ограничением', async () => {
    const bytes = pcm16Bytes(Float32Array.of(0, 0.5, -1, 2));
    assert.deepEqual(Array.from(new Int16Array(bytes.buffer)), [0, 16384, -32767, 32767]);
    const port = echoPort((message) => ({ type: 'transcript', id: message.id, text: 'привет', seconds: 1 }));
    const client = createHelperClient(port);
    const { text } = await client.transcribe(Float32Array.of(0.25), 'ru');
    assert.equal(text, 'привет');
    assert.equal(port.sent[0].type, 'transcribe');
    assert.equal(port.sent[0].language, 'ru');
    assert.deepEqual(Array.from(new Int16Array(Uint8Array.from(Buffer.from(port.sent[0].pcm, 'base64')).buffer)), [8192]);
  });

  it('передискретизация в 16 кГц: длина и тон сохраняются', () => {
    const rate = 44100;
    const tone = Float32Array.from({ length: rate }, (_, i) => Math.sin((2 * Math.PI * 440 * i) / rate));
    const out = resample(tone, rate);
    assert.equal(out.length, 16000);
    // Пересечения нуля: 440 Гц — около 880 за секунду.
    let crossings = 0;
    for (let i = 1; i < out.length; i += 1) if (Math.sign(out[i]) !== Math.sign(out[i - 1])) crossings += 1;
    assert.ok(Math.abs(crossings - 880) < 10, `пересечений ${crossings}`);
  });

  it('каких моделей расшифровки нет у помощника — по размерам', () => {
    assert.deepEqual(missingSpeechModels({}), SPEECH_MODELS);
    assert.deepEqual(missingSpeechModels({ whisper: WHISPER_MODEL.size }), [VAD_MODEL]);
    assert.deepEqual(missingSpeechModels({ whisper: WHISPER_MODEL.size, vad: VAD_MODEL.size }), []);
    assert.deepEqual(missingSpeechModels({ whisper: 10, vad: VAD_MODEL.size }), [WHISPER_MODEL]);
    // Адреса закреплены за ревизией, хэши — полные.
    for (const model of SPEECH_MODELS) {
      assert.match(model.url, /^https:\/\/huggingface\.co\/.+\/resolve\/[0-9a-f]{40}\//);
      assert.match(model.sha256, /^[0-9a-f]{64}$/);
    }
  });

  it('длительность записи — минуты и секунды', () => {
    assert.equal(formatSeconds(0), '0:00');
    assert.equal(formatSeconds(7.4), '0:07');
    assert.equal(formatSeconds(85), '1:25');
  });
});
