// Синтез TeraTTSv2 в отдельном потоке. Работа делится на две части по
// разным воркерам — так они идут конвейером: пока один готовит следующий
// кусок речи (text_encoder → длительность → sampler, ~¾ времени), другой
// превращает предыдущий в звук (vocoder, ~¼). Роль воркеру задаёт загрузка:
// какие модели ему прислали, то он и умеет.

import * as ort from '../../vendor/ort/ort.wasm.min.mjs';
import { quantizeModel } from './onnx-quantize.js';
import { encodeText, keepSupported, modelText, voicedRange } from './tera-text.js';

ort.env.wasm.wasmPaths = new URL('../../vendor/ort/', import.meta.url).href;
ort.env.wasm.numThreads = 1; // SharedArrayBuffer в расширении недоступен
ort.env.wasm.proxy = false;

const SAMPLE_RATE = 44100;
const SAMPLES_PER_FRAME = 3072;
const LATENT_CHANNELS = 144;
// Множитель длительности, с которым модель обучена звучать естественно.
const SPEED = 1.05;
const GUIDANCE = 3;
const SEED = 1234;

const sessions = {};
let table = null;
let queue = Promise.resolve();
let currentEpoch = 0;

/** Повторяемый шум: одна и та же фраза звучит одинаково при каждом синтезе. */
function noise(count, seed = SEED) {
  let state = seed >>> 0;
  const uniform = () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const out = new Float32Array(count);
  for (let i = 0; i < count; i += 2) {
    const radius = Math.sqrt(-2 * Math.log(uniform() || 1e-12));
    const angle = 2 * Math.PI * uniform();
    out[i] = radius * Math.cos(angle);
    if (i + 1 < count) out[i + 1] = radius * Math.sin(angle);
  }
  return out;
}

async function load({ models, indexer }) {
  const options = { executionProviders: ['wasm'], graphOptimizationLevel: 'all' };
  // По одной: пиковая память при разборе модели — её двойной размер.
  for (const [name, bytes] of Object.entries(models)) {
    sessions[name] = null;
    sessions[name] = await ort.InferenceSession.create(new Uint8Array(bytes), options);
  }
  if (indexer) table = Int32Array.from(JSON.parse(new TextDecoder().decode(indexer)));
}

const tensor = (type, data, dims) => new ort.Tensor(type, data, dims);
const ones = (count) => new Float32Array(count).fill(1);
const output = (result) => Object.values(result)[0];

/** Текст → скрытое представление речи (то, из чего вокодер делает звук). */
async function latent({ lang, text, ttl, dp, durationScale = 1, maxSeconds = null }) {
  if (!sessions.textEncoder || !table) throw new Error('Модель TeraTTS не загружена');
  const prepared = modelText(lang, keepSupported(text, table));
  const { withStress, plain } = encodeText(prepared, table);
  const styleTtl = tensor('float32', ttl, [1, 50, 256]);
  const styleDp = tensor('float32', dp, [1, 8, 16]);
  const textIds = tensor('int64', withStress, [1, withStress.length]);
  const textMask = tensor('float32', ones(withStress.length), [1, 1, withStress.length]);
  const textEmb = output(await sessions.textEncoder.run({ text_ids: textIds, style_ttl: styleTtl, text_mask: textMask }));
  const duration = output(
    await sessions.duration.run({
      text_ids: tensor('int64', plain, [1, plain.length]),
      style_dp: styleDp,
      text_mask: tensor('float32', ones(plain.length), [1, 1, plain.length]),
    })
  );
  let seconds = (duration.data[0] * durationScale) / SPEED;
  if (maxSeconds) seconds = Math.min(seconds, maxSeconds * durationScale);
  if (!(seconds > 0)) throw new Error('Модель не смогла оценить длительность фразы');
  const frames = Math.max(1, Math.ceil((seconds * SAMPLE_RATE) / SAMPLES_PER_FRAME));
  const result = output(
    await sessions.sampler.run({
      initial_latent: tensor('float32', noise(LATENT_CHANNELS * frames), [1, LATENT_CHANNELS, frames]),
      text_emb: textEmb,
      style_ttl: styleTtl,
      latent_mask: tensor('float32', ones(frames), [1, 1, frames]),
      text_mask: textMask,
      guidance: tensor('float32', Float32Array.of(GUIDANCE), [1]),
    })
  );
  // Копия: буфер уходит в другой поток целиком, а у тензора он может быть общим.
  return { latent: result.data.slice(), frames, samples: Math.round(seconds * SAMPLE_RATE) };
}

/** Скрытое представление → звук без тишины по краям. */
async function vocode({ latent: data, frames, samples }) {
  if (!sessions.vocoder) throw new Error('Вокодер TeraTTS не загружен');
  const wav = output(await sessions.vocoder.run({ latent: tensor('float32', data, [1, LATENT_CHANNELS, frames]) }));
  const pcm = wav.data.subarray(0, Math.min(samples, wav.data.length));
  const [start, end] = voicedRange(pcm, SAMPLE_RATE);
  return { pcm: pcm.slice(start, end), sampleRate: SAMPLE_RATE };
}

// Задания по одному: сессия ONNX не любит параллельных run(). Эпоха
// меняется сразу, вне очереди: куски для места, откуда читатель ушёл,
// пропускаются, не дожидаясь своей очереди.
self.onmessage = ({ data: message }) => {
  if (message.type === 'epoch') {
    currentEpoch = message.epoch;
    return;
  }
  queue = queue.then(async () => {
    try {
      if (message.type === 'load') {
        await load(message);
        self.postMessage({ id: message.id, type: 'loaded' });
        return;
      }
      // Быстрая версия модели (onnx-quantize.js) — один раз, после скачивания.
      if (message.type === 'quantize') {
        const exclude = message.exclude ?? [];
        const { model } = quantizeModel(new Uint8Array(message.model), {
          steps: message.steps ?? null,
          int8Weights: Boolean(message.int8Weights),
          exclude: (name) => exclude.some((part) => name.includes(part)),
        });
        self.postMessage({ id: message.id, type: 'quantized', model: model.buffer }, [model.buffer]);
        return;
      }
      if (message.epoch < currentEpoch) {
        self.postMessage({ id: message.id, type: 'error', message: 'Фраза больше не нужна', dropped: true });
        return;
      }
      if (message.type === 'latent') {
        const result = await latent(message);
        self.postMessage({ id: message.id, type: 'latent', ...result }, [result.latent.buffer]);
      } else if (message.type === 'vocode') {
        const result = await vocode(message);
        self.postMessage({ id: message.id, type: 'audio', ...result }, [result.pcm.buffer]);
      }
    } catch (error) {
      self.postMessage({ id: message.id, type: 'error', message: error?.message || String(error) });
    }
  });
};
