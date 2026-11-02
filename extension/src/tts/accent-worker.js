// Ударения для TeraTTS в отдельном потоке: словари RUAccent и три небольшие
// нейросети (см. ruaccent.js). Здесь же один раз, при скачивании голоса,
// строится компактный индекс словаря ударений из его 175 МБ JSON.
//
// С ускорителем нейросети считает он (remote-ort.js): воркер спрашивает
// страницу, страница — ускоритель. Тогда ONNX Runtime сюда даже не грузится.

import { Tokenizer } from '../../vendor/tokenizers/tokenizers.min.mjs';
import { createRemoteOrt } from './remote-ort.js';
import { createAccentuator } from './ruaccent.js';
import { createAccentModels } from './ruaccent-models.js';
import { StressIndex, buildStressIndex, splitLines } from './stress-index.js';

/** ONNX Runtime в WebAssembly — только когда сети считаются здесь. */
async function wasmOrt() {
  const ort = await import('../../vendor/ort/ort.wasm.min.mjs');
  ort.env.wasm.wasmPaths = new URL('../../vendor/ort/', import.meta.url).href;
  ort.env.wasm.numThreads = 1;
  ort.env.wasm.proxy = false;
  return ort;
}

// Вопросы к сетям в ускорителе: ответ приходит от страницы мимо очереди.
const inferring = new Map(); // номер → { resolve, reject }
let inferSeq = 0;
const remoteOrt = createRemoteOrt(
  (model, inputs) =>
    new Promise((resolve, reject) => {
      const rid = (inferSeq += 1);
      inferring.set(rid, { resolve, reject });
      self.postMessage({ type: 'infer', rid, model, inputs });
    })
);

let accentuator = null;
let dictionaries = null; // для вопроса «есть ли такое слово»
let queue = Promise.resolve();
let currentEpoch = 0;

/** Сжатый gzip файл → текстовый поток. */
const gunzipText = (blob) => blob.stream().pipeThrough(new DecompressionStream('gzip')).pipeThrough(new TextDecoderStream());

async function streamChunks(stream) {
  const chunks = [];
  const reader = stream.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return chunks;
    chunks.push(value);
  }
}

async function* iterate(stream) {
  const reader = stream.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return;
    yield value;
  }
}

const gunzipJson = async (blob) => JSON.parse((await streamChunks(gunzipText(blob))).join(''));
const json = async (blob) => JSON.parse(await blob.text());

/** Модель — байты из пакета или, с ускорителем, её имя там. */
const modelOf = async (file) => (typeof file === 'string' ? file : file.arrayBuffer());

async function load(files, remote) {
  const [yoWords, yoHomographs, omographs] = await Promise.all([gunzipJson(files.yoWords), gunzipJson(files.yoHomographs), gunzipJson(files.omographs)]);
  omographs['коса'] ??= ['к+оса', 'кос+а']; // так дополняет словарь и сам RUAccent
  const models = await createAccentModels(remote ? remoteOrt : await wasmOrt(), Tokenizer, {
    yoModel: await modelOf(files.yoModel),
    yoTokenizer: await json(files.yoTokenizer),
    yoTokenizerConfig: await json(files.yoTokenizerConfig),
    yoLabels: (await json(files.yoConfig)).id2label,
    omographModel: await modelOf(files.omographModel),
    omographTokenizer: await json(files.omographTokenizer),
    omographTokenizerConfig: await json(files.omographTokenizerConfig),
    accentModel: await modelOf(files.accentModel),
    accentVocab: await files.accentVocab.text(),
    accentLabels: (await json(files.accentConfig)).id2label,
  });
  dictionaries = {
    stress: new StressIndex(await files.stressIndex.arrayBuffer()),
    yoWords: new Map(Object.entries(yoWords)),
    yoHomographs: new Map(Object.entries(yoHomographs)),
    omographs: new Map(Object.entries(omographs)),
  };
  accentuator = createAccentuator(dictionaries, models);
}

self.onmessage = ({ data: message }) => {
  if (message.type === 'epoch') {
    currentEpoch = message.epoch;
    return;
  }
  if (message.type === 'infer-result') {
    const entry = inferring.get(message.rid);
    inferring.delete(message.rid);
    if (message.error) entry?.reject(new Error(message.error));
    else entry?.resolve({ dims: message.dims, data: message.data });
    return;
  }
  queue = queue.then(async () => {
    try {
      if (message.type === 'build-index') {
        const index = await buildStressIndex(splitLines(iterate(gunzipText(message.blob))));
        self.postMessage({ id: message.id, type: 'index', index }, [index]);
      } else if (message.type === 'load') {
        await load(message.files, Boolean(message.remote));
        self.postMessage({ id: message.id, type: 'loaded' });
      } else if (message.type === 'accent') {
        if (message.epoch < currentEpoch) {
          self.postMessage({ id: message.id, type: 'error', message: 'Фраза больше не нужна', dropped: true });
          return;
        }
        if (!accentuator) throw new Error('Ударения не загружены');
        self.postMessage({ id: message.id, type: 'accented', text: await accentuator.process(message.text) });
      } else if (message.type === 'known') {
        // Какие слова есть в словарях — для склейки слов, разорванных
        // переносом строки без дефиса («сооб» + «щает»).
        if (!dictionaries) throw new Error('Ударения не загружены');
        const known = message.words.filter((word) => {
          const key = word.toLowerCase();
          return dictionaries.stress.accent(key) != null || dictionaries.omographs.has(key) || dictionaries.yoWords.has(key);
        });
        self.postMessage({ id: message.id, type: 'known', words: known });
      }
    } catch (error) {
      self.postMessage({ id: message.id, type: 'error', message: error?.message || String(error) });
    }
  });
};
