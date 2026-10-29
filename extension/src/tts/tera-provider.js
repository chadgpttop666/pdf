// Провайдер нейроголосов TeraTTSv2. Интерфейс тот же, что у piper-provider.js:
// контроллер не знает, какой движок говорит.
//
// Как идёт фраза:
//   1. tera-text.js режет её на куски: по языку (английские названия —
//      отдельно, иначе модель сбивается) и по длине;
//   2. русский кусок — числа словами (normalize-ru.js), ударения и «ё»
//      (accent-worker.js);
//   3. воркер-сэмплер готовит скрытое представление речи, воркер-вокодер
//      делает из него звук. Они работают конвейером: пока один занят
//      следующим куском, другой — предыдущим;
//   4. куски играют по очереди: первый звучит, пока синтезируются остальные.
// Контроллер заранее просит подготовить несколько следующих фраз — к тому
// времени, как до них дойдёт чтение, их звук уже готов.

import { createAudioPlayer } from './audio-player.js';
import { normalizeRussian } from './normalize-ru.js';
import { estimateWordTimings } from './piper-math.js';
import { planPieces } from './tera-text.js';
import {
  ACCENT_PARTS,
  PACK_SIZE_MB,
  SYNTH_PARTS,
  TERA_VOICES,
  VOCODER_PARTS,
  downloadPack,
  getPack,
  isPackInstalled,
  loadParts,
  removePack,
} from './tera-pack.js';

export const TERA_PREFIX = 'tera:';
// Заготовки фраз впрок: их число ограничивает запас подготовки из настроек
// (контроллер сам отпускает лишние через retain), здесь — только предохранитель.
const CACHE_SIZE = 1000;
// Модели занимают гигабайты памяти — после долгого простоя выгружаем их;
// следующая фраза загрузит снова (около десяти секунд).
const IDLE_UNLOAD_MS = 10 * 60 * 1000;

const keyOf = (voiceId) => (voiceId?.startsWith(TERA_PREFIX) ? voiceId.slice(TERA_PREFIX.length) : voiceId);

function withPause(pcm, sampleRate, seconds) {
  if (!seconds) return pcm;
  const out = new Float32Array(pcm.length + Math.round(sampleRate * seconds));
  out.set(pcm);
  return out;
}

/**
 * @param options.secondThread () => boolean — второй воркер-сэмплер: быстрее,
 *   но ещё ~1 ГБ памяти
 */
export function createTeraProvider({ secondThread = () => false } = {}) {
  const player = createAudioPlayer();
  const cache = new Map(); // голос|скорость|текст → { pieces, fastStart }
  const waiting = new Map();
  const workers = { samplers: [], vocoder: null, accent: null };
  let seq = 0;
  let token = 0; // растёт при каждой отмене — старые фразы узнают, что они не нужны
  let epoch = 0; // то же для очередей воркеров
  let loading = null;
  let ready = false;
  let pack = null;
  let download = null;
  let deferred = []; // фразы, которые просили подготовить, пока модели грузились
  let speakingKey = null; // заготовка звучащей фразы — её retain не отпускает
  let liveVolume = 1; // громкость, поменянная посреди фразы, — для её следующих кусков
  let lane = Promise.resolve(); // очередь отправки кусков в сэмплер
  let idleTimer = 0;

  function touch() {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      if (!player.speaking && !download) shutdown();
    }, IDLE_UNLOAD_MS);
  }

  // ── Воркеры ──────────────────────────────────────────────────────────

  function spawn(kind) {
    const url = kind === 'accent' ? new URL('./accent-worker.js', import.meta.url) : new URL('./tera-worker.js', import.meta.url);
    const slot = { worker: new Worker(url, { type: 'module' }), pending: 0, loaded: false };
    slot.worker.onmessage = ({ data }) => {
      const entry = waiting.get(data.id);
      if (!entry) return;
      waiting.delete(data.id);
      if (data.type === 'error') entry.reject(Object.assign(new Error(data.message), { dropped: Boolean(data.dropped) }));
      else entry.resolve(data);
    };
    slot.worker.onerror = (event) => {
      event.preventDefault?.();
      // Упал один воркер — перезапустим все при следующей фразе: память
      // скорее всего кончилась, и полумеры тут не помогут.
      shutdown(new Error(event.message || 'Сбой синтеза TeraTTS'));
    };
    slot.worker.postMessage({ type: 'epoch', epoch });
    return slot;
  }

  function call(slot, message, transfer = []) {
    const id = (seq += 1);
    return new Promise((resolve, reject) => {
      waiting.set(id, { resolve, reject, slot });
      slot.worker.postMessage({ ...message, id }, transfer);
    });
  }

  function shutdown(error = new Error('Голоса TeraTTS выгружены')) {
    for (const slot of [...workers.samplers, workers.vocoder, workers.accent]) slot?.worker.terminate();
    for (const [id, entry] of waiting) {
      waiting.delete(id);
      entry.reject(error);
    }
    workers.samplers = [];
    workers.vocoder = null;
    workers.accent = null;
    ready = false;
    loading = null;
    for (const item of deferred) item.reject(error);
    deferred = [];
    cache.clear();
  }

  async function loadSampler(slot) {
    const parts = await loadParts([...SYNTH_PARTS, 'indexer']);
    const models = {};
    for (const name of SYNTH_PARTS) models[name] = await parts[name].arrayBuffer();
    const indexer = await parts.indexer.arrayBuffer();
    await call(slot, { type: 'load', models, indexer }, [...Object.values(models), indexer]);
    slot.loaded = true;
  }

  async function ensureLoaded() {
    if (ready) return;
    loading ||= (async () => {
      pack = await getPack();
      workers.accent = spawn('accent');
      workers.vocoder = spawn('synth');
      workers.samplers = [spawn('synth')];
      const vocoderParts = await loadParts(VOCODER_PARTS);
      const vocoder = await vocoderParts.vocoder.arrayBuffer();
      await Promise.all([
        loadSampler(workers.samplers[0]),
        call(workers.vocoder, { type: 'load', models: { vocoder } }, [vocoder]),
        loadParts(ACCENT_PARTS).then((files) => call(workers.accent, { type: 'load', files })),
      ]);
      ready = true;
    })();
    const current = loading;
    try {
      await current;
    } catch (error) {
      if (loading === current) shutdown(error);
      throw error;
    }
  }

  /** Второй сэмплер — по настройке, когда первый уже работает. */
  function adjustThreads() {
    if (!ready) return;
    if (secondThread() && workers.samplers.length < 2) {
      const slot = spawn('synth');
      workers.samplers.push(slot);
      loadSampler(slot).catch(() => {
        slot.worker.terminate();
        workers.samplers = workers.samplers.filter((other) => other !== slot);
      });
    } else if (!secondThread() && workers.samplers.length > 1) {
      for (const slot of workers.samplers.splice(1)) slot.worker.terminate();
    }
  }

  const pickSampler = () => workers.samplers.filter((slot) => slot.loaded).reduce((a, b) => (b.pending < a.pending ? b : a));

  // ── Куски фразы ──────────────────────────────────────────────────────

  function synthesizePiece(piece, style, rate, jobEpoch) {
    const spoken = piece.lang === 'ru' ? normalizeRussian(piece.text) : { text: piece.text, segments: [] };
    piece.segments = spoken.segments;
    const accented =
      piece.lang === 'ru' ? call(workers.accent, { type: 'accent', text: spoken.text, epoch: jobEpoch }).then((reply) => reply.text) : Promise.resolve(spoken.text);
    // В сэмплер куски уходят строго в порядке создания: английскому куску
    // следующей фразы ударения не нужны, и иначе он обгонял бы русский кусок
    // текущей — а читатель ждал бы звука.
    const posting = lane.then(async () => {
      const text = await accented;
      const sampler = pickSampler();
      sampler.pending += 1;
      const request = call(sampler, {
        type: 'latent',
        lang: piece.lang,
        text,
        ttl: style.ttl,
        dp: style.dp,
        durationScale: 1 / Math.max(0.3, rate || 1),
        maxSeconds: piece.maxSeconds,
        epoch: jobEpoch,
      });
      const done = () => (sampler.pending -= 1);
      request.then(done, done);
      return { request }; // в обёртке: очередь ждёт отправки, а не синтеза
    });
    lane = posting.catch(() => {});
    piece.audio = posting.then(async ({ request }) => {
      const { latent: data, frames, samples } = await request;
      return call(workers.vocoder, { type: 'vocode', latent: data, frames, samples, epoch: jobEpoch }, [data.buffer]);
    });
    piece.audio.catch(() => {});
    return piece;
  }

  function createJob(text, { voiceId, rate = 1 }, fastStart) {
    const style = pack.styles[keyOf(voiceId)] ?? pack.styles[TERA_VOICES[0].key];
    const measure = (part, lang) => (lang === 'ru' ? normalizeRussian(part).text.length : part.length);
    const pieces = planPieces(text, { fastStart, measure }).map((piece) => synthesizePiece(piece, style, rate, epoch));
    return { pieces, fastStart };
  }

  const keyFor = (text, options) => `${keyOf(options.voiceId)}|${options.rate}|${text}`;

  /** Сколько секунд звука в заготовке, когда она готова целиком. */
  const readySeconds = (entry) =>
    Promise.all(entry.pieces.map((piece) => piece.audio)).then((audios) =>
      audios.reduce((sum, audio, i) => sum + audio.pcm.length / audio.sampleRate + entry.pieces[i].pause, 0)
    );

  function job(text, options, { forSpeak = false } = {}) {
    const key = keyFor(text, options);
    let entry = cache.get(key);
    if (!entry) {
      // Фразу просят сразу сказать, а заранее она не готовилась — первый
      // кусок покороче, чтобы звук пошёл быстрее.
      entry = createJob(text, options, forSpeak);
      cache.set(key, entry);
      for (const piece of entry.pieces) piece.audio.catch(() => cache.get(key) === entry && cache.delete(key));
      while (cache.size > CACHE_SIZE) cache.delete(cache.keys().next().value);
    }
    return entry;
  }

  /** Звук куска с паузой после него и подсветкой слов по оценке. */
  function playable(piece, audio, onBoundary) {
    const pcm = withPause(audio.pcm, audio.sampleRate, piece.pause);
    const voicedShare = audio.pcm.length / pcm.length;
    const timings = onBoundary
      ? estimateWordTimings(piece.text, piece.segments).map((timing) => ({
          charIndex: timing.charIndex + piece.start,
          charLength: timing.charLength,
          at: timing.at * voicedShare,
        }))
      : [];
    return { pcm, timings };
  }

  // ── Голоса ───────────────────────────────────────────────────────────

  async function voices() {
    const installed = await isPackInstalled();
    return TERA_VOICES.map(({ key, name }) => ({
      id: TERA_PREFIX + key,
      name,
      lang: 'ru-RU',
      sizeMb: PACK_SIZE_MB,
      installed,
      neural: true,
    }));
  }

  /** Индекс словаря ударений строит воркер ударений — тот же, что и потом работает. */
  async function buildIndex(blob) {
    const slot = workers.accent ?? spawn('accent');
    try {
      return (await call(slot, { type: 'build-index', blob })).index;
    } finally {
      if (slot !== workers.accent) slot.worker.terminate();
    }
  }

  async function downloadVoice(voiceId, onProgress) {
    download?.controller.abort();
    const controller = new AbortController();
    download = { controller };
    try {
      await downloadPack({ onProgress, signal: controller.signal, buildIndex });
      return voiceId;
    } catch (error) {
      // Недокачанные части — сотни мегабайт без оглавления: не оставляем.
      await removePack().catch(() => {});
      if (error.name === 'AbortError') throw new Error('Загрузка отменена');
      throw error;
    } finally {
      if (download?.controller === controller) download = null;
    }
  }

  return {
    id: 'tera',
    neural: true,
    available: typeof Worker !== 'undefined' && typeof AudioContext !== 'undefined' && typeof DecompressionStream !== 'undefined',
    voices,
    downloadVoice,
    async removeVoice() {
      shutdown();
      await removePack();
    },
    cancelDownload() {
      download?.controller.abort();
    },
    get downloading() {
      return download ? TERA_PREFIX + TERA_VOICES[0].key : null;
    },
    isInstalled: () => isPackInstalled(),
    /** Размер пакета в МБ — для вопроса перед скачиванием. */
    sizeMb: PACK_SIZE_MB,

    /**
     * @param options.onStart вызывается, когда звук действительно пошёл
     * @returns {Promise<'ended'|'cancelled'>}
     */
    async speak(text, options = {}) {
      const myToken = token;
      touch();
      // Модели готовы — задание фразы ставится в очередь сразу, до любого
      // await: контроллер следом просит подготовить следующие фразы, и они
      // должны встать в очередь воркеров после этой, а не перед ней.
      if (!ready) {
        await ensureLoaded();
        if (myToken !== token) return 'cancelled';
      }
      adjustThreads();
      const key = keyFor(text, options);
      let entry = job(text, options, { forSpeak: true });
      speakingKey = key;
      liveVolume = options.volume ?? 1;
      // Заготовки, отложенные на время загрузки, — после текущей фразы.
      for (const item of deferred.splice(0)) {
        if (item.epoch === epoch) readySeconds(job(item.text, item.options)).then(item.resolve, item.reject);
        else item.reject(Object.assign(new Error('Фраза больше не нужна'), { dropped: true }));
      }
      let retried = false;
      for (let i = 0; i < entry.pieces.length; i += 1) {
        const piece = entry.pieces[i];
        let audio;
        try {
          audio = await piece.audio;
        } catch (error) {
          if (myToken !== token) return 'cancelled';
          if (!error.dropped || retried) throw error;
          // Задание сбросила отмена, случившаяся между нашими шагами, — заново.
          retried = true;
          entry = createJob(text, options, entry.fastStart);
          i -= 1;
          continue;
        }
        if (myToken !== token) return 'cancelled';
        const { pcm, timings } = playable(piece, audio, options.onBoundary);
        const result = await player.play(pcm, audio.sampleRate, {
          volume: liveVolume,
          timings,
          onBoundary: options.onBoundary,
          onStart: i === 0 ? options.onStart : undefined,
          isCancelled: () => myToken !== token,
        });
        if (result === 'cancelled') return 'cancelled';
      }
      // Прозвучала — заготовка больше не нужна, память освобождаем.
      if (cache.get(key) === entry) cache.delete(key);
      if (speakingKey === key) speakingKey = null;
      touch();
      return 'ended';
    },

    /** Громкость — сразу, и для оставшихся кусков звучащей фразы. */
    setVolume(volume) {
      liveVolume = volume;
      player.setVolume(volume);
    },

    /**
     * Отпустить заготовки, которых нет среди нужных впереди (читатель ушёл
     * в другое место, сменилась скорость): запас не копится без предела.
     */
    retain(texts, options = {}) {
      const keep = new Set(texts.map((text) => keyFor(text, options)));
      for (const key of [...cache.keys()]) if (!keep.has(key) && key !== speakingKey) cache.delete(key);
    },

    /** Модели уже в памяти воркеров — первая фраза пойдёт без загрузки. */
    isVoiceReady() {
      return ready;
    },

    /**
     * Начать загрузку моделей заранее — пока читатель выбирает место:
     * в память уходит около гигабайта, это десяток секунд.
     */
    preload() {
      touch();
      isPackInstalled()
        .then((installed) => installed && ensureLoaded())
        .catch(() => {});
    },

    unlock() {
      player.unlock();
    },

    /**
     * Синтезировать заранее — пока звучит текущая фраза и на паузе.
     * @returns {Promise<number>|null} секунды готового звука; null — модели не скачаны
     */
    prepare(text, options = {}) {
      touch();
      if (ready) return readySeconds(job(text, options));
      if (!loading) return null;
      return new Promise((resolve, reject) => deferred.push({ text, options, epoch, resolve, reject }));
    },

    /** Вся фраза одним звуком — для проверок и сохранения в файл. */
    async render(text, options = {}) {
      await ensureLoaded();
      const { pieces } = createJob(text, options, false);
      const parts = [];
      let sampleRate = 44100;
      for (const piece of pieces) {
        const audio = await piece.audio;
        sampleRate = audio.sampleRate;
        parts.push(withPause(audio.pcm, audio.sampleRate, piece.pause));
      }
      const pcm = new Float32Array(parts.reduce((sum, part) => sum + part.length, 0));
      let offset = 0;
      for (const part of parts) {
        pcm.set(part, offset);
        offset += part.length;
      }
      return { pcm, sampleRate, pieces: pieces.map(({ lang, text: pieceText }) => ({ lang, text: pieceText })) };
    },

    /** Как разметились ударения — для проверок. */
    async accent(text) {
      await ensureLoaded();
      return (await call(workers.accent, { type: 'accent', text, epoch })).text;
    },

    pause() {
      player.pause();
    },
    resume() {
      player.resume();
    },
    cancel() {
      token += 1;
      epoch += 1;
      for (const slot of [...workers.samplers, workers.vocoder, workers.accent]) slot?.worker.postMessage({ type: 'epoch', epoch });
      player.stop('cancelled');
    },
    /** Освободить память: выгрузить модели из воркеров. */
    unload() {
      shutdown();
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
    /** Для тестов: сколько воркеров запущено. */
    get workers() {
      return workers.samplers.length + (workers.vocoder ? 1 : 0) + (workers.accent ? 1 : 0);
    },
  };
}
