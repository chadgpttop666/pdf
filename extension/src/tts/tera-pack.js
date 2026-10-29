// Пакет TeraTTSv2 (TeraSpace, лицензия OpenRAIL-M): модели речи, стили
// голосов и всё для ударений (RUAccent, MIT). Скачивается один раз с
// HuggingFace — ревизии закреплены, чтобы файлы не поменялись под нами — и
// хранится в IndexedDB: каждый большой файл отдельной записью (пиковая
// память при скачивании — один файл, а не весь пакет), плюс запись-оглавление.

import * as library from '../library.js';
import { parseNpy } from './tera-text.js';

export const TERA_PACK_ID = 'teratts-v2';
const PART = (name) => `${TERA_PACK_ID}:${name}`;

const TERA = 'https://huggingface.co/TeraSpace/TeraTTSv2/resolve/75983ac96062591d06ecd2ddb2aefb894104bc9e/';
const RUACCENT = `${TERA}ruaccent/`;

/** Голоса — это стили одной модели: скачав пакет, получаешь все. */
export const TERA_VOICES = [
  { key: 'ru_m5', name: 'TeraTTS — мужской' },
  { key: 'ru_f1', name: 'TeraTTS — женский' },
  { key: 'ru_m1', name: 'TeraTTS — мужской 2' },
  { key: 'ru_f2', name: 'TeraTTS — женский 2' },
];

// [имя, адрес, размер в байтах — для прогресса]
const FILES = [
  ['textEncoder', `${TERA}models/text_encoder.onnx`, 27910305],
  ['duration', `${TERA}models/duration_predictor.onnx`, 1572411],
  ['sampler', `${TERA}models/sampler_distilled_cfg3_8step.onnx`, 256417643],
  ['vocoder', `${TERA}models/vocoder.onnx`, 101416199],
  ['indexer', `${TERA}unicode_indexer.json`, 262171],
  ['accents', `${RUACCENT}dictionary/accents.json.gz`, 20954156],
  ['yoWords', `${RUACCENT}dictionary/yo_words.json.gz`, 548914],
  ['yoHomographs', `${RUACCENT}dictionary/yo_homographs.json.gz`, 5747],
  ['omographs', `${RUACCENT}dictionary/omographs.json.gz`, 219047],
  ['accentModel', `${RUACCENT}nn/nn_accent/model.onnx`, 803402],
  ['accentVocab', `${RUACCENT}nn/nn_accent/vocab.txt`, 140],
  ['accentConfig', `${RUACCENT}nn/nn_accent/config.json`, 841],
  ['yoModel', `${RUACCENT}nn/nn_yo_homograph_resolver/model.onnx`, 14332169],
  ['yoTokenizer', `${RUACCENT}nn/nn_yo_homograph_resolver/tokenizer.json`, 126952],
  ['yoTokenizerConfig', `${RUACCENT}nn/nn_yo_homograph_resolver/tokenizer_config.json`, 401],
  ['yoConfig', `${RUACCENT}nn/nn_yo_homograph_resolver/config.json`, 625],
  ...TERA_VOICES.flatMap(({ key }) => [
    [`style-${key}-ttl`, `${TERA}styles/${key}/style_ttl.npy`, 51328],
    [`style-${key}-dp`, `${TERA}styles/${key}/style_dp.npy`, 640],
  ]),
];

// Модель омографов (замок/замок): int8-копия большой модели RUAccent — в
// четыре раза меньше, выбирает так же; если её не станет — маленькая
// официальная (ошибается чаще).
const OMOGRAPH_SOURCES = [
  {
    base: 'https://huggingface.co/nerualdreming/ruaccent-omograph-int8/resolve/d5c4eb6864d55cfc24ae45530eb4ef96843efb2b/turbo3.1/',
    sizes: { 'model.onnx': 92305879, 'tokenizer.json': 5532343, 'tokenizer_config.json': 492 },
  },
  {
    base: 'https://huggingface.co/ruaccent/accentuator/resolve/b78ae5ea1e62beaf138bed1865cd8c3b0b5ca855/nn/nn_omograph/tiny2.1/',
    sizes: { 'model.onnx': 41532080, 'tokenizer.json': 882532, 'tokenizer_config.json': 401 },
  },
];
const OMOGRAPH_FILES = [
  ['omographModel', 'model.onnx'],
  ['omographTokenizer', 'tokenizer.json'],
  ['omographTokenizerConfig', 'tokenizer_config.json'],
];

/** Части, которые нужны воркеру ударений (словарь хранится уже индексом). */
export const ACCENT_PARTS = [
  'yoWords', 'yoHomographs', 'omographs', 'accentModel', 'accentVocab', 'accentConfig', 'yoModel', 'yoTokenizer',
  'yoTokenizerConfig', 'yoConfig', 'omographModel', 'omographTokenizer', 'omographTokenizerConfig', 'stressIndex',
];

// Быстрая версия сэмплера и вокодера (onnx-quantize.js): делается из
// скачанных моделей в браузере один раз и лежит рядом с ними. Версия растёт,
// когда меняется способ — тогда быстрые модели пересобираются.
export const FAST_VERSION = 1;
export const FAST_RECIPES = {
  sampler: { part: 'samplerFast', steps: 6 },
  // Последние слои вокодера отвечают за мелкие детали звука — их не трогаем.
  vocoder: { part: 'vocoderFast', exclude: ['head'] },
  // Омографы: веса уже int8, но onnxruntime разворачивал их в fp32 (воркер
  // ударений — 1,1 ГБ). Внимание оставляем во float: целочисленное меняло
  // спорные решения чаще, а памяти почти не добавляет.
  omographModel: { part: 'omographFast', int8Weights: true, exclude: ['attention'] },
};
const FAST_PART_NAMES = Object.values(FAST_RECIPES).map(({ part }) => part);

const totalBytes = FILES.reduce((sum, [, , size]) => sum + size, 0) + Object.values(OMOGRAPH_SOURCES[0].sizes).reduce((a, b) => a + b, 0);
export const PACK_SIZE_MB = Math.round(totalBytes / 1024 / 1024);

/** Адреса файлов пакета — для тестов, которые подменяют HuggingFace. */
export const PACK_URLS = [...FILES.map(([, url]) => url), ...OMOGRAPH_SOURCES.flatMap(({ base, sizes }) => Object.keys(sizes).map((file) => base + file))];

async function fetchBlob(url, { signal, onChunk }) {
  const response = await fetch(url, { signal });
  if (!response.ok || !response.body) {
    throw Object.assign(new Error(`HuggingFace ответил ${response.status} на ${url.split('/').slice(-2).join('/')}`), { status: response.status });
  }
  const reader = response.body.getReader();
  const chunks = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    onChunk(value.length);
  }
  return new Blob(chunks);
}

export async function isPackInstalled() {
  const record = await library.getVoice(TERA_PACK_ID).catch(() => null);
  return Boolean(record?.complete);
}

/**
 * Скачать пакет.
 * @param onProgress (загружено, всего, этап: 'download'|'index')
 * @param buildIndex (Blob accents.json.gz) → Promise<ArrayBuffer> — индекс словаря ударений
 */
export async function downloadPack({ onProgress, signal, buildIndex }) {
  let loaded = 0;
  let total = totalBytes;
  const progress = (bytes) => {
    loaded += bytes;
    onProgress?.(loaded, total, 'download');
  };
  const sizes = {};
  const store = async (name, blob) => {
    sizes[name] = blob.size;
    await library.putVoice({ id: PART(name), engine: 'tera-part', blob });
  };

  const styles = {};
  let accents = null;
  for (const [name, url] of FILES) {
    const blob = await fetchBlob(url, { signal, onChunk: progress });
    if (name === 'accents') accents = blob;
    else if (name.startsWith('style-')) styles[name] = parseNpy(await blob.arrayBuffer()).data;
    else await store(name, blob);
  }

  let omographSource = null;
  for (const [i, source] of OMOGRAPH_SOURCES.entries()) {
    const before = loaded;
    try {
      for (const [name, file] of OMOGRAPH_FILES) await store(name, await fetchBlob(source.base + file, { signal, onChunk: progress }));
      omographSource = source.base;
      break;
    } catch (error) {
      if (error.name === 'AbortError' || i === OMOGRAPH_SOURCES.length - 1) throw error;
      // Запасной источник: пересчитываем прогресс под его размеры.
      loaded = before;
      total += Object.values(OMOGRAPH_SOURCES[i + 1].sizes).reduce((a, b) => a + b, 0) - Object.values(source.sizes).reduce((a, b) => a + b, 0);
    }
  }

  onProgress?.(loaded, total, 'index');
  await store('stressIndex', new Blob([await buildIndex(accents)]));

  await library.putVoice({
    id: TERA_PACK_ID,
    engine: 'tera',
    name: 'TeraTTSv2',
    lang: 'ru-RU',
    styles: Object.fromEntries(TERA_VOICES.map(({ key }) => [key, { ttl: styles[`style-${key}-ttl`], dp: styles[`style-${key}-dp`] }])),
    parts: Object.keys(sizes),
    size: Object.values(sizes).reduce((a, b) => a + b, 0),
    omographSource,
    source: 'huggingface',
    storedAt: Date.now(),
    complete: true,
  });
}

export async function getPack() {
  const record = await library.getVoice(TERA_PACK_ID);
  if (!record?.complete) throw new Error('Голоса TeraTTS ещё не скачаны');
  return record;
}

/** Блобы частей пакета по именам. */
export async function loadParts(names) {
  const entries = await Promise.all(
    names.map(async (name) => {
      const record = await library.getVoice(PART(name));
      if (!record?.blob) throw new Error('Пакет TeraTTS повреждён — скачайте его заново');
      return [name, record.blob];
    })
  );
  return Object.fromEntries(entries);
}

/** Сохранить быструю версию моделей и отметить её в пакете. */
export async function storeFastParts(blobs) {
  for (const [name, blob] of Object.entries(blobs)) await library.putVoice({ id: PART(name), engine: 'tera-part', blob });
  const record = await library.getVoice(TERA_PACK_ID);
  await library.putVoice({ ...record, fast: FAST_VERSION });
}

export async function removePack() {
  const names = [...new Set([...FILES.map(([name]) => name), ...OMOGRAPH_FILES.map(([name]) => name), 'stressIndex', ...FAST_PART_NAMES])];
  await library.deleteVoice(TERA_PACK_ID);
  await Promise.all(names.map((name) => library.deleteVoice(PART(name)).catch(() => {})));
}
