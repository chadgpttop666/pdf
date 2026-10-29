// Ударения для TeraTTS в отдельном потоке: словари RUAccent и три небольшие
// нейросети (см. ruaccent.js). Здесь же один раз, при скачивании голоса,
// строится компактный индекс словаря ударений из его 175 МБ JSON.

import * as ort from '../../vendor/ort/ort.wasm.min.mjs';
import { Tokenizer } from '../../vendor/tokenizers/tokenizers.min.mjs';
import { createAccentuator } from './ruaccent.js';
import { createAccentModels } from './ruaccent-models.js';
import { StressIndex, buildStressIndex, splitLines } from './stress-index.js';

ort.env.wasm.wasmPaths = new URL('../../vendor/ort/', import.meta.url).href;
ort.env.wasm.numThreads = 1;
ort.env.wasm.proxy = false;

let accentuator = null;
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

async function load(files) {
  const [yoWords, yoHomographs, omographs] = await Promise.all([gunzipJson(files.yoWords), gunzipJson(files.yoHomographs), gunzipJson(files.omographs)]);
  omographs['коса'] ??= ['к+оса', 'кос+а']; // так дополняет словарь и сам RUAccent
  const models = await createAccentModels(ort, Tokenizer, {
    yoModel: await files.yoModel.arrayBuffer(),
    yoTokenizer: await json(files.yoTokenizer),
    yoTokenizerConfig: await json(files.yoTokenizerConfig),
    yoLabels: (await json(files.yoConfig)).id2label,
    omographModel: await files.omographModel.arrayBuffer(),
    omographTokenizer: await json(files.omographTokenizer),
    omographTokenizerConfig: await json(files.omographTokenizerConfig),
    accentModel: await files.accentModel.arrayBuffer(),
    accentVocab: await files.accentVocab.text(),
    accentLabels: (await json(files.accentConfig)).id2label,
  });
  accentuator = createAccentuator(
    {
      stress: new StressIndex(await files.stressIndex.arrayBuffer()),
      yoWords: new Map(Object.entries(yoWords)),
      yoHomographs: new Map(Object.entries(yoHomographs)),
      omographs: new Map(Object.entries(omographs)),
    },
    models
  );
}

self.onmessage = ({ data: message }) => {
  if (message.type === 'epoch') {
    currentEpoch = message.epoch;
    return;
  }
  queue = queue.then(async () => {
    try {
      if (message.type === 'build-index') {
        const index = await buildStressIndex(splitLines(iterate(gunzipText(message.blob))));
        self.postMessage({ id: message.id, type: 'index', index }, [index]);
      } else if (message.type === 'load') {
        await load(message.files);
        self.postMessage({ id: message.id, type: 'loaded' });
      } else if (message.type === 'accent') {
        if (message.epoch < currentEpoch) {
          self.postMessage({ id: message.id, type: 'error', message: 'Фраза больше не нужна', dropped: true });
          return;
        }
        if (!accentuator) throw new Error('Ударения не загружены');
        self.postMessage({ id: message.id, type: 'accented', text: await accentuator.process(message.text) });
      }
    } catch (error) {
      self.postMessage({ id: message.id, type: 'error', message: error?.message || String(error) });
    }
  });
};
