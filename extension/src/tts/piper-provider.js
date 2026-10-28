// Провайдер нейроголосов Piper. Интерфейс тот же, что у web-speech.js, плюс
// управление голосами: скачать с HuggingFace, загрузить из файла, удалить.
// Синтез идёт в воркере (piper-worker.js), звук играет AudioContext.
// Пока звучит фраза, следующая уже синтезируется — пауз между ними нет.

import * as library from '../library.js';
import { estimateWordTimings } from './piper-math.js';

export const PIPER_PREFIX = 'piper:';

const HF_BASE = 'https://huggingface.co/rhasspy/piper-voices/resolve/v1.0.0/';

/** Голоса, которые предлагаем скачать. Размер — приблизительный. ⚠️ */
export const PIPER_CATALOG = [
  { key: 'ru_RU-irina-medium', name: 'Ирина', lang: 'ru-RU', path: 'ru/ru_RU/irina/medium/', sizeMb: 61 },
  { key: 'ru_RU-dmitri-medium', name: 'Дмитрий', lang: 'ru-RU', path: 'ru/ru_RU/dmitri/medium/', sizeMb: 61 },
  { key: 'ru_RU-denis-medium', name: 'Денис', lang: 'ru-RU', path: 'ru/ru_RU/denis/medium/', sizeMb: 61 },
  { key: 'ru_RU-ruslan-medium', name: 'Руслан', lang: 'ru-RU', path: 'ru/ru_RU/ruslan/medium/', sizeMb: 61 },
  { key: 'en_US-lessac-medium', name: 'Lessac (английский)', lang: 'en-US', path: 'en/en_US/lessac/medium/', sizeMb: 61 },
];

const CACHE_SIZE = 4;
const BOUNDARY_POLL_MS = 40;

const keyOf = (voiceId) => (voiceId?.startsWith(PIPER_PREFIX) ? voiceId.slice(PIPER_PREFIX.length) : voiceId);

export function createPiperProvider() {
  let worker = null;
  let seq = 0;
  const waiting = new Map();
  let loadedKey = null;
  let loading = null;
  const cache = new Map(); // голос|скорость|текст → промис со звуком
  let context = null;
  let current = null; // играющая фраза
  let token = 0; // растёт при каждой отмене — старые фразы узнают, что они не нужны
  let paused = false;
  let download = null; // { key, controller }

  // ── Воркер ───────────────────────────────────────────────────────────

  function ensureWorker() {
    if (worker) return worker;
    worker = new Worker(new URL('./piper-worker.js', import.meta.url), { type: 'module' });
    worker.onmessage = ({ data }) => {
      const entry = waiting.get(data.id);
      if (!entry) return;
      waiting.delete(data.id);
      if (data.type === 'error') entry.reject(new Error(data.message));
      else entry.resolve(data);
    };
    worker.onerror = (event) => {
      event.preventDefault?.();
      for (const entry of waiting.values()) entry.reject(new Error(event.message || 'Сбой синтеза Piper'));
      waiting.clear();
      worker?.terminate();
      worker = null;
      loadedKey = null;
      cache.clear();
    };
    return worker;
  }

  function call(message, transfer = []) {
    const id = (seq += 1);
    return new Promise((resolve, reject) => {
      waiting.set(id, { resolve, reject });
      ensureWorker().postMessage({ ...message, id }, transfer);
    });
  }

  async function ensureVoice(voiceId) {
    const key = keyOf(voiceId);
    if (loadedKey === key && worker) return;
    if (loading?.key === key) return loading.promise;
    const promise = (async () => {
      const record = await library.getVoice(key);
      if (!record) throw new Error('Этот нейроголос ещё не скачан');
      const model = await record.model.arrayBuffer();
      await call({ type: 'load', model, config: record.config }, [model]);
      loadedKey = key;
      cache.clear();
    })();
    loading = { key, promise };
    try {
      await promise;
    } finally {
      if (loading?.promise === promise) loading = null;
    }
  }

  function synthesize(text, { voiceId, rate = 1 }) {
    const cacheKey = `${keyOf(voiceId)}|${rate}|${text}`;
    if (!cache.has(cacheKey)) {
      const promise = ensureVoice(voiceId).then(() => call({ type: 'synthesize', text, rate }));
      promise.catch(() => cache.delete(cacheKey));
      cache.set(cacheKey, promise);
      while (cache.size > CACHE_SIZE) cache.delete(cache.keys().next().value);
    }
    return cache.get(cacheKey);
  }

  // ── Звук ─────────────────────────────────────────────────────────────

  function audioContext() {
    context ||= new AudioContext();
    return context;
  }

  function stopCurrent(result) {
    if (!current) return;
    const { source, timer, resolve } = current;
    current = null;
    clearInterval(timer);
    source.onended = null;
    try {
      source.stop();
    } catch {
      /* ещё не запущен или уже закончился */
    }
    resolve(result);
  }

  async function play(audio, text, { volume = 1, onBoundary }, myToken) {
    const ctx = audioContext();
    // Поставили на паузу, пока фраза синтезировалась, — начнём её на паузе.
    if (paused) await ctx.suspend();
    else if (ctx.state === 'suspended') ctx.resume();
    if (myToken !== token) return 'cancelled';

    const buffer = ctx.createBuffer(1, audio.pcm.length, audio.sampleRate);
    buffer.copyToChannel(audio.pcm, 0);
    const source = ctx.createBufferSource();
    source.buffer = buffer;
    const gain = ctx.createGain();
    gain.gain.value = volume;
    source.connect(gain).connect(ctx.destination);

    // Границ слов Piper не даёт: оцениваем их по доле произнесённых букв и
    // сверяем с часами AudioContext — на паузе они стоят, подсветка тоже.
    const timings = onBoundary ? estimateWordTimings(text) : [];
    const startedAt = ctx.currentTime;
    let next = 0;
    return new Promise((resolve) => {
      const timer = setInterval(() => {
        const progress = (ctx.currentTime - startedAt) / buffer.duration;
        while (next < timings.length && timings[next].at <= progress) {
          const { charIndex, charLength } = timings[next];
          next += 1;
          onBoundary({ charIndex, charLength, name: 'word' });
        }
      }, BOUNDARY_POLL_MS);
      current = { source, timer, resolve };
      source.onended = () => {
        if (current?.source !== source) return;
        current = null;
        clearInterval(timer);
        resolve('ended');
      };
      source.start();
    });
  }

  // ── Голоса ───────────────────────────────────────────────────────────

  async function voices() {
    let installed = [];
    try {
      installed = await library.listVoices();
    } catch {
      /* база недоступна — покажем только каталог */
    }
    const isInstalled = (key) => installed.some((voice) => voice.id === key);
    const catalog = PIPER_CATALOG.map((voice) => ({
      id: PIPER_PREFIX + voice.key,
      name: voice.name,
      lang: voice.lang,
      sizeMb: voice.sizeMb,
      installed: isInstalled(voice.key),
      neural: true,
    }));
    const imported = installed
      .filter((voice) => !PIPER_CATALOG.some((known) => known.key === voice.id))
      .map((voice) => ({ id: PIPER_PREFIX + voice.id, name: voice.name, lang: voice.lang, installed: true, neural: true }));
    return [...catalog, ...imported];
  }

  /**
   * Скачать голос из каталога с HuggingFace.
   * @param onProgress (загружено, всего) в байтах
   */
  async function downloadVoice(voiceId, onProgress) {
    const key = keyOf(voiceId);
    const entry = PIPER_CATALOG.find((voice) => voice.key === key);
    if (!entry) throw new Error('Такого голоса нет в каталоге');
    download?.controller.abort();
    const controller = new AbortController();
    download = { key, controller };
    try {
      const base = `${HF_BASE}${entry.path}${key}`;
      const configResponse = await fetch(`${base}.onnx.json`, { signal: controller.signal });
      if (!configResponse.ok) throw new Error(`HuggingFace ответил ${configResponse.status}`);
      const config = await configResponse.json();

      const response = await fetch(`${base}.onnx`, { signal: controller.signal });
      if (!response.ok || !response.body) throw new Error(`HuggingFace ответил ${response.status}`);
      const total = Number(response.headers.get('content-length')) || entry.sizeMb * 1024 * 1024;
      const reader = response.body.getReader();
      const chunks = [];
      let loaded = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
        loaded += value.length;
        onProgress?.(loaded, total);
      }
      const model = new Blob(chunks, { type: 'application/octet-stream' });
      await library.putVoice({
        id: key,
        name: entry.name,
        lang: entry.lang,
        config,
        model,
        size: model.size,
        source: 'huggingface',
        storedAt: Date.now(),
      });
      return PIPER_PREFIX + key;
    } catch (error) {
      if (error.name === 'AbortError') throw new Error('Загрузка отменена');
      throw error;
    } finally {
      if (download?.controller === controller) download = null;
    }
  }

  /** Голос из пары файлов: модель .onnx и описание .onnx.json. */
  async function importVoice(files) {
    const list = [...files];
    const model = list.find((file) => /\.onnx$/i.test(file.name));
    const description = list.find((file) => /\.json$/i.test(file.name));
    if (!model || !description) throw new Error('Нужны два файла: модель .onnx и её описание .onnx.json');
    let config;
    try {
      config = JSON.parse(await description.text());
    } catch {
      throw new Error('Описание голоса — не JSON');
    }
    if (!config.audio?.sample_rate || !config.espeak?.voice) throw new Error('Это не описание голоса Piper');

    const key = model.name.replace(/\.onnx$/i, '');
    const known = PIPER_CATALOG.find((voice) => voice.key === key);
    const dataset = config.dataset ? config.dataset[0].toUpperCase() + config.dataset.slice(1) : key;
    await library.putVoice({
      id: key,
      name: known?.name ?? dataset,
      lang: known?.lang ?? String(config.language?.code || config.espeak.voice).replace('_', '-'),
      config,
      model,
      size: model.size,
      source: 'file',
      storedAt: Date.now(),
    });
    if (loadedKey === key) loadedKey = null; // заменили модель — перечитать
    return PIPER_PREFIX + key;
  }

  async function removeVoice(voiceId) {
    const key = keyOf(voiceId);
    await library.deleteVoice(key);
    if (loadedKey === key) loadedKey = null;
    cache.clear();
  }

  return {
    id: 'piper',
    available: typeof Worker !== 'undefined' && typeof AudioContext !== 'undefined',
    voices,
    downloadVoice,
    importVoice,
    removeVoice,
    cancelDownload() {
      download?.controller.abort();
    },
    get downloading() {
      return download?.key ? PIPER_PREFIX + download.key : null;
    },
    async isInstalled(voiceId) {
      return Boolean(await library.getVoice(keyOf(voiceId)).catch(() => null));
    },

    /**
     * @returns {Promise<'ended'|'cancelled'>}
     */
    async speak(text, options = {}) {
      const myToken = token;
      const audio = await synthesize(text, options);
      if (myToken !== token) return 'cancelled';
      return play(audio, text, options, myToken);
    },

    /**
     * Создать и запустить AudioContext. Вызывается прямо в обработчике
     * щелчка или клавиши: без жеста пользователя браузер может не дать
     * звуку начаться.
     */
    unlock() {
      const ctx = audioContext();
      if (ctx.state === 'suspended' && !paused) ctx.resume();
    },

    /** Синтезировать заранее — пока звучит текущая фраза. */
    prepare(text, options = {}) {
      synthesize(text, options).catch(() => {});
    },

    pause() {
      paused = true;
      context?.suspend();
    },
    resume() {
      paused = false;
      context?.resume();
    },
    cancel() {
      token += 1;
      stopCurrent('cancelled');
    },
    get speaking() {
      return Boolean(current);
    },
    get paused() {
      return paused;
    },
    /** Для тестов: фонемы текста, без модели голоса. */
    phonemize(text, voice = 'ru') {
      return call({ type: 'phonemize', text, voice }).then((data) => data.ids);
    },
  };
}
