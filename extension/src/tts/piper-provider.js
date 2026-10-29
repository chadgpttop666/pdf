// Провайдер нейроголосов Piper. Интерфейс тот же, что у web-speech.js, плюс
// управление голосами: скачать с HuggingFace, загрузить из файла, удалить.
// Синтез идёт в воркерах (piper-worker.js), звук играет audio-player.js.
// Контроллер заранее просит синтезировать несколько следующих фраз; на
// машине с 4+ ядрами работают два воркера параллельно — паузы между фразами
// не накапливаются, даже если синтез идёт почти со скоростью речи.

import * as library from '../library.js';
import { createAudioPlayer } from './audio-player.js';
import { normalizeRussian } from './normalize-ru.js';
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

// Предохранитель: запас подготовки задаёт контроллер (и отпускает лишнее через retain).
const CACHE_SIZE = 1000;
// Второй воркер — ещё одна копия модели в памяти (~150 МБ), поэтому только
// там, где ядер хватает на параллельный синтез.
const POOL_SIZE = (globalThis.navigator?.hardwareConcurrency || 2) >= 4 ? 2 : 1;

/** Записи хранилища голосов, которые принадлежат Piper (у TeraTTS — свои). */
export const isPiperRecord = (record) => (record.engine ?? 'piper') === 'piper';

const keyOf = (voiceId) => (voiceId?.startsWith(PIPER_PREFIX) ? voiceId.slice(PIPER_PREFIX.length) : voiceId);

/** Русские голоса получают текст с числами и сокращениями словами. */
function spokenForm(text, voiceId) {
  if (/^en/i.test(keyOf(voiceId) || '') || !/\p{Script=Cyrillic}/u.test(text)) return { text, segments: [] };
  return normalizeRussian(text);
}

export function createPiperProvider() {
  const slots = []; // воркеры: { worker, loadedKey, loading, pending }
  let seq = 0;
  const waiting = new Map();
  const cache = new Map(); // голос|скорость|текст → промис со звуком
  const player = createAudioPlayer();
  let speakingKey = null; // заготовка звучащей фразы — её retain не отпускает
  let token = 0; // растёт при каждой отмене — старые фразы узнают, что они не нужны
  let epoch = 0; // то же для очередей воркеров: задания старой эпохи пропускаются
  let download = null; // { key, controller }

  // ── Воркеры ──────────────────────────────────────────────────────────

  function createSlot() {
    const slot = { worker: null, loadedKey: null, loading: null, pending: 0 };
    slot.worker = new Worker(new URL('./piper-worker.js', import.meta.url), { type: 'module' });
    slot.worker.onmessage = ({ data }) => {
      const entry = waiting.get(data.id);
      if (!entry) return;
      waiting.delete(data.id);
      if (data.type === 'error') entry.reject(Object.assign(new Error(data.message), { dropped: Boolean(data.dropped) }));
      else entry.resolve(data);
    };
    slot.worker.onerror = (event) => {
      event.preventDefault?.();
      for (const [id, entry] of waiting) {
        if (entry.slot !== slot) continue;
        waiting.delete(id);
        entry.reject(new Error(event.message || 'Сбой синтеза Piper'));
      }
      slot.worker.terminate();
      slots.splice(slots.indexOf(slot), 1);
      cache.clear();
    };
    slot.worker.postMessage({ type: 'epoch', epoch });
    slots.push(slot);
    return slot;
  }

  function call(slot, message, transfer = []) {
    const id = (seq += 1);
    return new Promise((resolve, reject) => {
      waiting.set(id, { resolve, reject, slot });
      slot.worker.postMessage({ ...message, id }, transfer);
    });
  }

  async function ensureVoice(slot, voiceId) {
    const key = keyOf(voiceId);
    if (slot.loadedKey === key) return;
    if (slot.loading?.key === key) return slot.loading.promise;
    const promise = (async () => {
      const record = await library.getVoice(key);
      if (!record) throw new Error('Этот нейроголос ещё не скачан');
      const model = await record.model.arrayBuffer();
      await call(slot, { type: 'load', model, config: record.config }, [model]);
      slot.loadedKey = key;
    })();
    slot.loading = { key, promise };
    try {
      await promise;
    } finally {
      if (slot.loading?.promise === promise) slot.loading = null;
    }
  }

  /**
   * Воркер для задания: наименее загруженный из тех, где голос уже в памяти.
   * Пока голос не загружен нигде — первый воркер (он его и грузит).
   */
  function pickSlot(voiceId) {
    const key = keyOf(voiceId);
    if (!slots.length) return createSlot();
    const ready = slots.filter((slot) => slot.loadedKey === key);
    const candidates = ready.length ? ready : [slots.find((slot) => slot.loading?.key === key) ?? slots[0]];
    return candidates.reduce((a, b) => (b.pending < a.pending ? b : a));
  }

  /**
   * Второй воркер грузит голос заранее, без заданий: когда он понадобится,
   * следующая фраза не будет ждать загрузки модели. Заводим его, только
   * когда первый уже готов — на старте не грузим две модели разом.
   */
  function warmUp(voiceId) {
    if (slots.length >= POOL_SIZE || !slots.some((slot) => slot.loadedKey === keyOf(voiceId))) return;
    ensureVoice(createSlot(), voiceId).catch(() => {});
  }

  const keyFor = (spoken, { voiceId, rate = 1 }) => `${keyOf(voiceId)}|${rate}|${spoken}`;

  function synthesize(spoken, { voiceId, rate = 1 }) {
    const cacheKey = keyFor(spoken, { voiceId, rate });
    if (!cache.has(cacheKey)) {
      const slot = pickSlot(voiceId);
      slot.pending += 1;
      const promise = ensureVoice(slot, voiceId).then(() => {
        warmUp(voiceId);
        return call(slot, { type: 'synthesize', text: spoken, rate, epoch });
      });
      promise.then(
        () => (slot.pending -= 1),
        () => (slot.pending -= 1)
      );
      promise.catch(() => cache.delete(cacheKey));
      cache.set(cacheKey, promise);
      while (cache.size > CACHE_SIZE) cache.delete(cache.keys().next().value);
    }
    return cache.get(cacheKey);
  }

  // ── Голоса ───────────────────────────────────────────────────────────

  async function voices() {
    let installed = [];
    try {
      installed = (await library.listVoices()).filter(isPiperRecord);
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
    forgetVoice(key); // заменили модель — перечитать
    return PIPER_PREFIX + key;
  }

  async function removeVoice(voiceId) {
    const key = keyOf(voiceId);
    await library.deleteVoice(key);
    forgetVoice(key);
  }

  function forgetVoice(key) {
    for (const slot of slots) if (slot.loadedKey === key) slot.loadedKey = null;
    cache.clear();
  }

  return {
    id: 'piper',
    neural: true,
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
     * @param options.onStart вызывается, когда звук действительно пошёл
     * @returns {Promise<'ended'|'cancelled'>}
     */
    async speak(text, options = {}) {
      const myToken = token;
      const { text: spoken, segments } = spokenForm(text, options.voiceId);
      const key = keyFor(spoken, options);
      speakingKey = key;
      let audio;
      try {
        audio = await synthesize(spoken, options);
      } catch (error) {
        if (myToken !== token) return 'cancelled';
        if (!error.dropped) throw error;
        audio = await synthesize(spoken, options); // задание отменили по ошибке эпохи — ещё раз
      }
      if (myToken !== token) return 'cancelled';
      const result = await player.play(audio.pcm, audio.sampleRate, {
        volume: options.volume,
        timings: options.onBoundary ? estimateWordTimings(text, segments) : [],
        onBoundary: options.onBoundary,
        onStart: options.onStart,
        isCancelled: () => myToken !== token,
      });
      // Прозвучала — заготовка больше не нужна.
      if (result === 'ended') cache.delete(key);
      if (speakingKey === key) speakingKey = null;
      return result;
    },

    /** Громкость звучащей фразы — сразу. */
    setVolume(volume) {
      player.setVolume(volume);
    },

    /** Отпустить заготовки, которых нет среди нужных впереди. */
    retain(texts, options = {}) {
      const keep = new Set(texts.map((text) => keyFor(spokenForm(text, options.voiceId).text, options)));
      for (const key of [...cache.keys()]) if (!keep.has(key) && key !== speakingKey) cache.delete(key);
    },

    /** Голос уже в памяти воркера — первая фраза пойдёт без загрузки модели. */
    isVoiceReady(voiceId) {
      return slots.some((slot) => slot.loadedKey === keyOf(voiceId));
    },

    /**
     * Создать и запустить AudioContext. Вызывается прямо в обработчике
     * щелчка или клавиши: без жеста пользователя браузер может не дать
     * звуку начаться.
     */
    unlock() {
      player.unlock();
    },

    /**
     * Синтезировать заранее — пока звучит текущая фраза и на паузе.
     * @returns {Promise<number>} секунды готового звука
     */
    prepare(text, options = {}) {
      return synthesize(spokenForm(text, options.voiceId).text, options).then((audio) => audio.pcm.length / audio.sampleRate);
    },

    pause() {
      player.pause();
    },
    resume() {
      player.resume();
    },
    cancel() {
      token += 1;
      // Заготовки для прежнего места больше не нужны — воркеры их пропустят.
      epoch += 1;
      for (const slot of slots) slot.worker.postMessage({ type: 'epoch', epoch });
      player.stop('cancelled');
    },
    get speaking() {
      return player.speaking;
    },
    get paused() {
      return player.paused;
    },
    get audioBlocked() {
      return player.blocked;
    },
    /** Для тестов: фонемы текста, без модели голоса. */
    phonemize(text, voice = 'ru') {
      return call(slots[0] ?? createSlot(), { type: 'phonemize', text, voice }).then((data) => data.ids);
    },
    /** Для тестов: сколько воркеров синтеза запущено. */
    get workers() {
      return slots.length;
    },
  };
}
