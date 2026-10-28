// Синтез нейроголосом Piper в отдельном потоке, чтобы не подтормаживали
// прокрутка и подсветка. Текст → фонемы (espeak-ng в WASM) → звук (модель
// VITS в ONNX Runtime). Код рантайма лежит в расширении, по сети приходит
// только сама модель голоса.

import * as ort from '../../vendor/ort/ort.wasm.min.mjs';
import createPiperPhonemize from '../../vendor/piper/piper_phonemize.mjs';
import { splitPhrases } from './piper-math.js';

const PIPER_BASE = new URL('../../vendor/piper/', import.meta.url);
// Пауза между фразами, на которые espeak сам делит предложение.
const CLAUSE_PAUSE_S = 0.12;

ort.env.wasm.wasmPaths = new URL('../../vendor/ort/', import.meta.url).href;
ort.env.wasm.numThreads = 1; // SharedArrayBuffer в расширении недоступен
ort.env.wasm.proxy = false;

let phonemizer = null;
let session = null;
let config = null;
let queue = Promise.resolve();

async function loadPhonemizer() {
  if (phonemizer) return phonemizer;
  const load = async (name) => {
    const response = await fetch(new URL(name, PIPER_BASE));
    if (!response.ok) throw new Error(`Не загрузился ${name}`);
    return response.arrayBuffer();
  };
  const [wasm, data] = await Promise.all([load('piper_phonemize.wasm'), load('piper_phonemize.data')]);
  phonemizer = { module: await WebAssembly.compile(wasm), data };
  return phonemizer;
}

/**
 * Фонемы предложения, по фразам.
 * @returns {Promise<number[][]>}
 */
async function phonemize(text, voice) {
  const { module, data } = await loadPhonemizer();
  const lines = [];
  const errors = [];
  const instance = await createPiperPhonemize({
    print: (line) => lines.push(line),
    printErr: (line) => errors.push(line),
    locateFile: (name) => new URL(name, PIPER_BASE).href,
    // Скомпилированный модуль и данные словарей переиспользуем между вызовами.
    instantiateWasm(imports, done) {
      WebAssembly.instantiate(module, imports).then((instanceObject) => done(instanceObject));
      return {};
    },
    getPreloadedPackage: () => data,
  });
  instance.callMain(['-l', voice, '--input', JSON.stringify([{ text }]), '--espeak_data', '/espeak-ng-data']);
  const ids = lines
    .map((line) => {
      try {
        return JSON.parse(line).phoneme_ids;
      } catch {
        return null;
      }
    })
    .filter((list) => Array.isArray(list) && list.length)
    .flatMap(splitPhrases);
  if (!ids.length) throw new Error(`Фонемизатор не разобрал текст${errors.length ? `: ${errors.join(' ')}` : ''}`);
  return ids;
}

async function loadVoice(model, voiceConfig) {
  session = null;
  config = voiceConfig;
  session = await ort.InferenceSession.create(new Uint8Array(model), {
    executionProviders: ['wasm'],
    graphOptimizationLevel: 'all',
  });
}

async function infer(ids, lengthScale) {
  const inference = config.inference || {};
  const feeds = {
    input: new ort.Tensor('int64', BigInt64Array.from(ids, BigInt), [1, ids.length]),
    input_lengths: new ort.Tensor('int64', BigInt64Array.from([BigInt(ids.length)]), [1]),
    scales: new ort.Tensor('float32', Float32Array.from([inference.noise_scale ?? 0.667, lengthScale, inference.noise_w ?? 0.8]), [3]),
  };
  if ((config.num_speakers || 1) > 1) feeds.sid = new ort.Tensor('int64', BigInt64Array.from([0n]), [1]);
  const result = await session.run(feeds);
  return result.output.data;
}

async function synthesize(text, rate) {
  if (!session) throw new Error('Голос не загружен');
  const sampleRate = config.audio?.sample_rate || 22050;
  // Скорость речи у VITS — это длительность фонем: больше length_scale — медленнее.
  const lengthScale = (config.inference?.length_scale ?? 1) / Math.max(0.3, rate || 1);
  const parts = [];
  for (const ids of await phonemize(text, config.espeak?.voice || 'ru')) parts.push(await infer(ids, lengthScale));

  const gap = Math.round(CLAUSE_PAUSE_S * sampleRate);
  const total = parts.reduce((sum, part) => sum + part.length, 0) + gap * (parts.length - 1);
  const pcm = new Float32Array(total);
  let offset = 0;
  for (const part of parts) {
    pcm.set(part, offset);
    offset += part.length + gap;
  }
  return { pcm, sampleRate };
}

// Запросы выполняем по одному: сессия ONNX не любит параллельных run().
self.onmessage = ({ data: message }) => {
  queue = queue.then(async () => {
    try {
      if (message.type === 'load') {
        await loadVoice(message.model, message.config);
        self.postMessage({ id: message.id, type: 'loaded' });
      } else if (message.type === 'synthesize') {
        const { pcm, sampleRate } = await synthesize(message.text, message.rate);
        self.postMessage({ id: message.id, type: 'audio', pcm, sampleRate }, [pcm.buffer]);
      } else if (message.type === 'phonemize') {
        self.postMessage({ id: message.id, type: 'phonemes', ids: await phonemize(message.text, message.voice) });
      }
    } catch (error) {
      self.postMessage({ id: message.id, type: 'error', message: error?.message || String(error) });
    }
  });
};
