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
//
// Если установлен ускоритель (tera-native.js, программа native/), шаг 3
// делает он — в несколько раз быстрее и почти без памяти браузера; воркеры
// синтеза тогда не запускаются вовсе.

import { createAudioPlayer } from './audio-player.js';
import { normalizeRussian } from './normalize-ru.js';
import { fetchHelper } from './helper-install.js';
import { HELPER_RELEASE } from './helper-release.js';
import { estimateWordTimings } from './piper-math.js';
import { HELPER_PROTOCOL, compareVersions, connectHelper, missingModels, syncModels } from './tera-native.js';
import { encodeText, keepSupported, modelText, planPieces, voicedRange } from './tera-text.js';
import { samplerCount } from './tera-threads.js';
import {
  ACCENT_PARTS,
  DERIVED_PARTS,
  DERIVED_VERSION,
  PACK_SIZE_MB,
  SAMPLER_PARTS,
  TERA_VOICES,
  downloadPack,
  getPack,
  isPackInstalled,
  loadParts,
  dropLegacyParts,
  removePack,
  storeDerivedPart,
} from './tera-pack.js';

export const TERA_PREFIX = 'tera:';
// Заготовки фраз впрок: их число ограничивает запас подготовки из настроек
// (контроллер сам отпускает лишние через retain), здесь — только предохранитель.
const CACHE_SIZE = 1000;
// Модели занимают гигабайты памяти — после долгого простоя выгружаем их;
// следующая фраза загрузит снова (около десяти секунд).
const IDLE_UNLOAD_MS = 10 * 60 * 1000;
// Сколько секунд звучания должно быть готово, чтобы начать фразу на большой скорости.
const HEAD_START_SECONDS = 2.5;

const keyOf = (voiceId) => (voiceId?.startsWith(TERA_PREFIX) ? voiceId.slice(TERA_PREFIX.length) : voiceId);

function withPause(pcm, sampleRate, seconds) {
  if (!seconds) return pcm;
  const out = new Float32Array(pcm.length + Math.round(sampleRate * seconds));
  out.set(pcm);
  return out;
}

/**
 * @param options.threads () => 'auto' | '1' | '2' | '3' — сколько сэмплеров
 *   держать (tera-threads.js)
 * @param options.rate () => скорость чтения: от неё зависит, сколько нужно
 * @param options.quality () => 'max' | 'steps6' | 'fast' — какой сэмплер: исходный,
 *   на 6 шагов или ещё и в 8 бит (tera-pack.js, DERIVED_PARTS)
 * @param options.useHelper () => boolean — синтезировать ускорителем, если он установлен
 */
export function createTeraProvider({ threads = () => 'auto', rate = () => 1, quality = () => 'max', useHelper = () => true } = {}) {
  const player = createAudioPlayer();
  const cache = new Map(); // голос|текст → { pieces, fastStart }
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
  let lagging = false; // синтез уже не успевал за речью — нужен ещё сэмплер
  let samplerPart = 'sampler'; // какой сэмплер в памяти — часть пакета
  let omographPart = 'omographModel'; // какая модель омографов в памяти
  let lastEnded = 0; // когда договорила предыдущая фраза
  let helper = null; // { client, hello } — синтез идёт через ускоритель
  let helperLosses = 0; // ускоритель отключался посреди работы
  let table = null; // символ → номер: с ускорителем текст для модели готовит страница

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
    helper?.client.close(); // помощник завершится сам и освободит память
    helper = null;
    table = null;
    for (const [id, entry] of waiting) {
      waiting.delete(id);
      entry.reject(error);
    }
    workers.samplers = [];
    workers.vocoder = null;
    workers.accent = null;
    ready = false;
    lagging = false;
    loading = null;
    for (const item of deferred) item.reject(error);
    deferred = [];
    cache.clear();
  }

  async function loadSampler(slot) {
    const sampler = samplerPart;
    const parts = await loadParts(['textEncoder', 'duration', sampler, 'indexer']);
    const models = {
      textEncoder: await parts.textEncoder.arrayBuffer(),
      duration: await parts.duration.arrayBuffer(),
      sampler: await parts[sampler].arrayBuffer(),
    };
    const indexer = await parts.indexer.arrayBuffer();
    await call(slot, { type: 'load', models, indexer }, [...Object.values(models), indexer]);
    slot.loaded = true;
  }

  /** Файлы воркера ударений — с той моделью омографов, что собралась. */
  async function loadAccentParts() {
    const files = await loadParts(ACCENT_PARTS.map((name) => (name === 'omographModel' ? omographPart : name)));
    if (omographPart !== 'omographModel') {
      files.omographModel = files[omographPart];
      delete files[omographPart];
    }
    return files;
  }

  /**
   * Производная модель (tera-pack.js, DERIVED_PARTS) — из скачанной, один раз
   * (секунды при первой загрузке после скачивания или обновления).
   * @returns {Promise<boolean>} есть; нет — читаем исходной моделью
   */
  async function ensureDerived(name) {
    if (pack.derived?.[name] === DERIVED_VERSION) return true;
    const slot = spawn('synth');
    try {
      const { from, steps, exclude, int8Weights, dynamic, hoist } = DERIVED_PARTS[name];
      const model = await (await loadParts([from]))[from].arrayBuffer();
      const reply = await call(slot, { type: 'quantize', model, steps, exclude, int8Weights, dynamic, hoist }, [model]);
      await storeDerivedPart(name, new Blob([reply.model]));
      pack = await getPack();
      return true;
    } catch (error) {
      console.warn(`TeraTTS: модель ${name} не собралась — беру исходную`, error);
      return false;
    } finally {
      slot.worker.terminate();
    }
  }

  // ── Ускоритель ───────────────────────────────────────────────────────

  /** Модели для ускорителя: сэмплер — с вынесенными весами, если собрался. */
  async function helperBlobs() {
    const sampler = (await ensureDerived(SAMPLER_PARTS.max)) ? SAMPLER_PARTS.max : 'sampler';
    const parts = await loadParts(['textEncoder', 'duration', sampler, 'vocoder']);
    return { textEncoder: parts.textEncoder, duration: parts.duration, sampler: parts[sampler], vocoder: parts.vocoder };
  }

  /** Помощник старее, чем ждёт расширение, — он поставит новую версию себе сам. */
  async function updateIfOld(connection) {
    if (compareVersions(connection.hello.version, HELPER_RELEASE.version) >= 0) return connection;
    try {
      const { blob, sha256 } = await fetchHelper();
      await connection.client.update(blob, sha256);
    } catch (error) {
      console.warn('TeraTTS: ускоритель не обновился', error);
      return connection;
    }
    connection.client.close();
    const fresh = await connectHelper();
    if (!fresh) throw new Error('После обновления ускоритель не запустился');
    return fresh;
  }

  /** Подключиться к ускорителю и передать ему модели; null — синтез в браузере. */
  async function attachHelper(onProgress) {
    if (!useHelper() || helperLosses >= 2) return null;
    let connection = await connectHelper();
    if (!connection) return null;
    try {
      connection = await updateIfOld(connection);
      const { hello, client } = connection;
      if (hello.protocol !== HELPER_PROTOCOL) throw new Error(`ускоритель другой версии (${hello.version})`);
      if (hello.ortError) throw new Error(hello.ortError);
      if ((await syncModels(client, hello.files, await helperBlobs(), onProgress)).length) connection.hello = await client.hello();
      table = Int32Array.from(JSON.parse(await (await loadParts(['indexer'])).indexer.text()));
      await client.load();
      client.onClose(() => {
        if (helper !== connection) return;
        // Упал посреди чтения — следующая фраза подключит заново, а после
        // второго раза читаем в браузере до перезагрузки страницы.
        helperLosses += 1;
        shutdown(new Error('Ускоритель отключился'));
      });
      return connection;
    } catch (error) {
      console.warn('TeraTTS: ускоритель не подключился — синтез в браузере', error);
      connection.client.close();
      return null;
    }
  }

  async function ensureLoaded() {
    if (ready) return;
    loading ||= (async () => {
      pack = await dropLegacyParts(await getPack());
      // Облегчённая модель омографов на звук не влияет — она всегда; сэмплер — по настройке.
      omographPart = (await ensureDerived('omographLight')) ? 'omographLight' : 'omographModel';
      workers.accent = spawn('accent');
      const accent = loadAccentParts().then((files) => call(workers.accent, { type: 'load', files }));
      accent.catch(() => {}); // ошибку разберём ниже, когда дождёмся
      helper = await attachHelper();
      if (!helper) {
        const wanted = SAMPLER_PARTS[quality()] ?? SAMPLER_PARTS.max;
        // Не собралась — исходный с вынесенными весами, а нет и его — как скачан.
        samplerPart = (await ensureDerived(wanted)) ? wanted : (await ensureDerived(SAMPLER_PARTS.max)) ? SAMPLER_PARTS.max : 'sampler';
        workers.vocoder = spawn('synth');
        const first = addSampler();
        // На большой скорости нужен и второй сэмплер — грузим его вместе с
        // первым, чтобы и первая фраза синтезировалась в два потока.
        for (let i = 1; i < wantedSamplers(); i += 1) addSampler();
        const vocoder = await (await loadParts(['vocoder'])).vocoder.arrayBuffer();
        await Promise.all([first, call(workers.vocoder, { type: 'load', models: { vocoder } }, [vocoder])]);
      }
      await accent;
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

  const wantedSamplers = () => samplerCount(threads(), { rate: rate(), lagging, cores: navigator.hardwareConcurrency || 4, fast: quality() === 'fast' });

  function addSampler() {
    const slot = spawn('synth');
    workers.samplers.push(slot);
    const loaded = loadSampler(slot);
    loaded.catch(() => {
      slot.worker.terminate();
      workers.samplers = workers.samplers.filter((other) => other !== slot);
    });
    return loaded;
  }

  /** Сколько сэмплеров нужно — по настройке и скорости; первый уже работает. */
  function adjustThreads() {
    if (!ready || helper) return;
    const wanted = wantedSamplers();
    while (workers.samplers.length < wanted) addSampler();
    // Лишний гасим, только когда ему нечего доделывать: иначе его куски не
    // пришли бы никогда и чтение встало бы.
    for (const slot of workers.samplers.slice(wanted)) {
      if (slot.pending || !slot.loaded) continue;
      slot.worker.terminate();
      workers.samplers = workers.samplers.filter((other) => other !== slot);
    }
  }

  /**
   * На большой скорости первый короткий кусок фразы звучит считаные секунды:
   * пара слов — и тишина, пока готовится следующий. Поэтому там начинаем,
   * когда готово хотя бы HEAD_START_SECONDS звучания (или вся фраза). На
   * обычной скорости первого куска хватает — звук не задерживается.
   */
  async function headStart(entry, playbackRate, myToken) {
    if (playbackRate <= 1.25) return;
    const need = HEAD_START_SECONDS * playbackRate;
    for (;;) {
      let seconds = 0;
      const next = entry.pieces.find((piece) => {
        if (!piece.done) return true;
        seconds += piece.seconds;
        return false;
      });
      if (!next || seconds >= need || myToken !== token) return;
      await next.audio.catch(() => {}); // ошибку разберёт основной цикл
      if (!next.done) return;
    }
  }

  /** Звук понадобился, а куска ещё нет — синтез не успевает за речью. */
  function noteLag() {
    if (lagging || helper) return;
    lagging = true;
    adjustThreads();
  }

  const pickSampler = () => workers.samplers.filter((slot) => slot.loaded).reduce((a, b) => (b.pending < a.pending ? b : a));

  // ── Куски фразы ──────────────────────────────────────────────────────

  function synthesizePiece(piece, style, jobEpoch) {
    const spoken = piece.lang === 'ru' ? normalizeRussian(piece.text) : { text: piece.text, segments: [] };
    piece.segments = spoken.segments;
    const accented =
      piece.lang === 'ru' ? call(workers.accent, { type: 'accent', text: spoken.text, epoch: jobEpoch }).then((reply) => reply.text) : Promise.resolve(spoken.text);
    // В сэмплер куски уходят строго в порядке создания: английскому куску
    // следующей фразы ударения не нужны, и иначе он обгонял бы русский кусок
    // текущей — а читатель ждал бы звука.
    if (helper) return synthesizeWithHelper(piece, accented, style, jobEpoch);
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
        // Всегда обычная скорость: ускоряет проигрыватель (audio-player.js),
        // сжатую речь модель «зажёвывает».
        durationScale: 1,
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
    piece.audio.then(
      (audio) => {
        piece.done = true;
        piece.seconds = audio.pcm.length / audio.sampleRate + (piece.pause || 0);
      },
      () => {}
    );
    return piece;
  }

  /** То же через ускоритель: текст в номера символов — здесь, звук — у него. */
  function synthesizeWithHelper(piece, accented, style, jobEpoch) {
    const { client } = helper;
    const posting = lane.then(async () => {
      const { withStress, plain } = encodeText(modelText(piece.lang, keepSupported(await accented, table)), table);
      const request = client.synth({ ids: withStress, plain, ttl: style.ttl, dp: style.dp, maxSeconds: piece.maxSeconds, epoch: jobEpoch });
      return { request }; // в обёртке: очередь ждёт отправки, а не синтеза
    });
    lane = posting.catch(() => {});
    piece.audio = posting.then(async ({ request }) => {
      const { pcm, sampleRate } = await request;
      const [start, end] = voicedRange(pcm, sampleRate);
      return { pcm: pcm.slice(start, end), sampleRate };
    });
    piece.audio.then(
      (audio) => {
        piece.done = true;
        piece.seconds = audio.pcm.length / audio.sampleRate + (piece.pause || 0);
      },
      () => {}
    );
    return piece;
  }

  function createJob(text, { voiceId }, fastStart) {
    const style = pack.styles[keyOf(voiceId)] ?? pack.styles[TERA_VOICES[0].key];
    const measure = (part, lang) => (lang === 'ru' ? normalizeRussian(part).text.length : part.length);
    const pieces = planPieces(text, { fastStart, measure }).map((piece) => synthesizePiece(piece, style, epoch));
    return { pieces, fastStart };
  }

  // Скорость в ключ не входит: заготовка одна на любую скорость.
  const keyFor = (text, options) => `${keyOf(options.voiceId)}|${text}`;

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
      // Скорость фразы — сразу, до загрузки и синтеза: если её поменяют в это
      // время, новое значение (setRate) не должно затереться старым.
      player.setRate(options.rate || 1);
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
      // Предыдущая фраза только что договорила, а эта не готова — не успеваем.
      if (performance.now() - lastEnded < 300 && !entry.pieces[0].done) noteLag();
      await headStart(entry, player.rate, myToken);
      if (myToken !== token) return 'cancelled';
      let retried = false;
      for (let i = 0; i < entry.pieces.length; i += 1) {
        const piece = entry.pieces[i];
        if (i > 0 && !piece.done) noteLag();
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
      lastEnded = performance.now();
      adjustThreads(); // скорость могли снизить — лишний сэмплер отпускаем
      touch();
      return 'ended';
    },

    /** Скорость — сразу, посреди фразы, без повторного синтеза. */
    setRate(value) {
      player.setRate(value);
      adjustThreads(); // на большей скорости синтезу нужен ещё поток
    },
    /** Для проверок: скорость, с которой сейчас играет звук. */
    get playbackRate() {
      return player.rate;
    },

    /** Громкость — сразу, и для оставшихся кусков звучащей фразы. */
    setVolume(volume) {
      liveVolume = volume;
      player.setVolume(volume);
    },

    /**
     * Отпустить заготовки, которых нет среди нужных впереди (читатель ушёл
     * в другое место): запас не копится без предела.
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
      adjustThreads();
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
      helper?.client.setEpoch(epoch);
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
    /** Выгрузить модели — например, сменили качество: следующая фраза загрузит нужные. */
    unload() {
      shutdown();
    },
    /** Для проверок: какие модели в памяти; sampler: 'helper' — синтез у ускорителя. */
    get models() {
      return ready ? { sampler: helper ? 'helper' : samplerPart, omograph: omographPart } : null;
    },

    /**
     * Что с ускорителем — для настроек.
     * @returns {Promise<{ installed: boolean, version?, active?, packInstalled?, modelsReady? }>}
     */
    async helperStatus() {
      const connection = helper ?? (await connectHelper());
      if (!connection) return { installed: false };
      try {
        // У работающего — свежий ответ: модели могли передать после подключения.
        const hello = connection === helper ? await helper.client.hello() : connection.hello;
        const packInstalled = await isPackInstalled();
        let modelsReady = false;
        // Сэмплер для ускорителя ещё не собран — значит, и не передан.
        pack = packInstalled ? await getPack() : pack;
        if (packInstalled && pack.derived?.[SAMPLER_PARTS.max] === DERIVED_VERSION) {
          const blobs = await helperBlobs();
          modelsReady = !missingModels(hello.files, Object.fromEntries(Object.entries(blobs).map(([name, blob]) => [name, blob.size]))).length;
        }
        return { installed: true, version: hello.version, active: connection === helper, packInstalled, modelsReady };
      } finally {
        if (connection !== helper) connection.client.close();
      }
    },

    /** Обновить ускоритель и передать ему модели заранее — сразу после установки. */
    async prepareHelper(onProgress) {
      pack = await dropLegacyParts(await getPack());
      let connection = helper ?? (await connectHelper());
      if (!connection) throw new Error('Ускоритель не отвечает');
      try {
        if (connection !== helper) connection = await updateIfOld(connection);
        await syncModels(connection.client, connection.hello.files, await helperBlobs(), onProgress);
      } finally {
        if (connection !== helper) connection.client.close();
      }
    },

    /** Удалить ускоритель: он сотрёт себя и свои модели сам. */
    async removeHelper() {
      if (helper) shutdown();
      const connection = await connectHelper();
      if (!connection) return;
      await connection.client.uninstall().catch(() => {}); // отвечает и сразу завершается
      connection.client.close();
    },
    /** Сколько сэмплеров сейчас работает или грузится. */
    get samplers() {
      return workers.samplers.length;
    },
    get workers() {
      return workers.samplers.length + (workers.vocoder ? 1 : 0) + (workers.accent ? 1 : 0);
    },
  };
}
