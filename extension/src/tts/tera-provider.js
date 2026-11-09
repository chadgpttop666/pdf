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
import { NOISE_SEED } from './tera-noise.js';
import { normalizeRussian } from './normalize-ru.js';
import { applyUserStress, loadUserStress, onUserStressChange } from './user-stress.js';
import { updateIfOld } from './helper-install.js';
import { estimateWordTimings } from './piper-math.js';
import { HELPER_MODELS, HELPER_PROTOCOL, connectHelper, missingModels, syncModels } from './tera-native.js';
import { HELPER_ACCENT_MODELS } from './remote-ort.js';
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
// Пока вкладка на экране, простой до выгрузки дольше.
const IDLE_VISIBLE_UNLOAD_MS = 30 * 60 * 1000;
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
  // Исправили ударение — заготовленные фразы звучали бы по-старому.
  loadUserStress();
  onUserStressChange(() => cache.clear());
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
  let lastUsed = 0; // когда голос последний раз был нужен
  let lagging = false; // синтез уже не успевал за речью — нужен ещё сэмплер
  let samplerPart = 'sampler'; // какой сэмплер в памяти — часть пакета
  let omographPart = 'omographModel'; // какая модель омографов в памяти
  let lastEnded = 0; // когда договорила предыдущая фраза
  let helper = null; // { client, hello } — синтез идёт через ускоритель
  let helperLosses = 0; // ускоритель отключался посреди работы
  let table = null; // символ → номер: с ускорителем текст для модели готовит страница
  let switching = false; // идёт переход к ускорителю посреди работы
  let helperError = null; // почему ускоритель не подключился в последний раз
  let accentRemote = false; // сети ударений считает ускоритель
  // Встык: следующая фраза встаёт в проигрыватель, пока звучит текущая, —
  // стык не зависит от того, успеет ли страница (audio-player.js).
  let upcoming = []; // ключи фраз в порядке чтения — из последнего retain
  let upcomingSeq = 0; // растёт с каждым новым списком
  let scheduled = null; // { key, token, options, seq } — фраза, все куски которой уже в проигрывателе
  let ahead = null; // { key, entry, handles, token } — следующая фраза, поставленная заранее

  function touch() {
    lastUsed = Date.now();
    armIdle(IDLE_UNLOAD_MS);
  }

  function armIdle(delay) {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      if (player.speaking || download) return;
      // Вкладка перед глазами — читатель, скорее всего, вот-вот продолжит:
      // держим голос дольше, чтобы «Читать» не ждало новой загрузки.
      const idle = Date.now() - lastUsed;
      if (globalThis.document?.visibilityState === 'visible' && idle < IDLE_VISIBLE_UNLOAD_MS) {
        armIdle(IDLE_VISIBLE_UNLOAD_MS - idle);
        return;
      }
      shutdown();
    }, delay);
  }

  // ── Воркеры ──────────────────────────────────────────────────────────

  function spawn(kind) {
    const url = kind === 'accent' ? new URL('./accent-worker.js', import.meta.url) : new URL('./tera-worker.js', import.meta.url);
    const slot = { worker: new Worker(url, { type: 'module' }), pending: 0, loaded: false };
    slot.worker.onmessage = ({ data }) => {
      // Воркер ударений спрашивает сеть, которую считает ускоритель.
      if (data.type === 'infer') {
        answerInfer(slot, data);
        return;
      }
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

  /** Вопрос воркера ударений к сети в ускорителе → ответ ему же. */
  function answerInfer(slot, { rid, model, inputs }) {
    const client = helper?.client;
    const reply = client ? client.infer(model, inputs) : Promise.reject(new Error('Ускоритель отключился'));
    reply.then(
      ({ dims, data }) => slot.worker.postMessage({ type: 'infer-result', rid, dims, data }),
      (error) => slot.worker.postMessage({ type: 'infer-result', rid, error: error.message || String(error) })
    );
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
    accentRemote = false;
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

  /**
   * Файлы воркера ударений — с той моделью омографов, что собралась.
   * remote: сети считает ускоритель — вместо моделей их имена там.
   */
  async function loadAccentParts({ remote = false } = {}) {
    const modelParts = Object.values(HELPER_ACCENT_MODELS);
    const names = ACCENT_PARTS.filter((name) => !remote || !modelParts.includes(name)).map((name) => (name === 'omographModel' ? omographPart : name));
    const files = await loadParts(names);
    if (files[omographPart] && omographPart !== 'omographModel') {
      files.omographModel = files[omographPart];
      delete files[omographPart];
    }
    if (remote) for (const [helperName, part] of Object.entries(HELPER_ACCENT_MODELS)) files[part] = helperName;
    return files;
  }

  /**
   * Сети ударений — в ускоритель (с версии 1.3.0): передать модели, если их
   * там ещё нет. false — считаем в браузере, как раньше.
   */
  /**
   * Модели ударений для ускорителя. Омографы и ударения — свои версии
   * (omographHelper, accentHelper: веса uint8, без переполнения на AVX2 без
   * VNNI); не собрались — исходные.
   */
  async function accentBlobs() {
    const omograph = (await ensureDerived('omographHelper')) ? 'omographHelper' : 'omographModel';
    const stress = (await ensureDerived('accentHelper')) ? 'accentHelper' : 'accentModel';
    const parts = await loadParts(['yoModel', omograph, stress]);
    return { accentYo: parts.yoModel, accentOmograph: parts[omograph], accentStress: parts[stress] };
  }

  async function helperAccent(connection, onProgress) {
    if (!connection?.hello.features?.includes('accent')) return false;
    try {
      const sent = await syncModels(connection.client, connection.hello.files, await accentBlobs(), onProgress, Object.keys(HELPER_ACCENT_MODELS));
      if (sent.length) connection.hello = await connection.client.hello();
      return true;
    } catch (error) {
      console.warn('TeraTTS: ударения остаются в браузере — ускоритель не принял модели', error);
      return false;
    }
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
      const { from, steps, exclude, int8Weights, dynamic, hoist, unsignedWeights } = DERIVED_PARTS[name];
      const model = await (await loadParts([from]))[from].arrayBuffer();
      const reply = await call(slot, { type: 'quantize', model, steps, exclude, int8Weights, dynamic, hoist, unsignedWeights }, [model]);
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

  /** Подключиться к ускорителю и передать ему модели; null — синтез в браузере. */
  async function attachHelper(onProgress) {
    if (!useHelper() || helperLosses >= 2) return null;
    // Первый запуск на Windows бывает долгим: антивирус проверяет программу.
    let connection = await connectHelper({ timeout: 30000 });
    if (!connection) return null;
    try {
      helperError = null;
      connection = await updateIfOld(connection);
      const { hello, client } = connection;
      if (hello.protocol !== HELPER_PROTOCOL) throw new Error(`ускоритель другой версии (${hello.version})`);
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
      helperError = error.message || String(error);
      connection.client.close();
      return null;
    }
  }

  /**
   * Ускоритель поставили, пока синтез уже идёт в браузере: переходим к нему
   * сразу, не перезагружая ударения. Воркеры синтеза закрываются, их
   * недоделанные куски синтезируются заново — уже ускорителем.
   */
  async function switchToHelper() {
    if (!ready || helper || switching || !useHelper()) return;
    switching = true;
    try {
      const connection = await attachHelper();
      if (!connection) return;
      if (!ready || helper) {
        connection.client.close(); // пока подключались, модели выгрузили
        return;
      }
      helper = connection;
      const old = [...workers.samplers, workers.vocoder].filter(Boolean);
      workers.samplers = [];
      workers.vocoder = null;
      lagging = false;
      for (const slot of old) slot.worker.terminate();
      for (const [id, entry] of waiting) {
        if (!old.includes(entry.slot)) continue;
        waiting.delete(id);
        entry.reject(dropped('Синтез перешёл к ускорителю'));
      }
    } finally {
      switching = false;
    }
  }

  async function ensureLoaded() {
    if (ready) return;
    loading ||= (async () => {
      pack = await dropLegacyParts(await getPack());
      // Облегчённая модель омографов на звук не влияет — она всегда; сэмплер — по настройке.
      omographPart = (await ensureDerived('omographLight')) ? 'omographLight' : 'omographModel';
      workers.accent = spawn('accent');
      helper = await attachHelper();
      // С ускорителем и сети ударений там: во вкладке остаются только словари.
      accentRemote = await helperAccent(helper);
      const accent = loadAccentParts({ remote: accentRemote }).then((files) => call(workers.accent, { type: 'load', files, remote: accentRemote }));
      accent.catch(() => {}); // ошибку разберём ниже, когда дождёмся
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

  /** Ошибка «фраза больше не нужна в этом виде» — speak синтезирует её заново. */
  const dropped = (message) => Object.assign(new Error(message), { dropped: true });

  function pickSampler() {
    const loaded = workers.samplers.filter((slot) => slot.loaded);
    if (!loaded.length) throw dropped('Синтез перешёл к ускорителю');
    return loaded.reduce((a, b) => (b.pending < a.pending ? b : a));
  }

  // ── Куски фразы ──────────────────────────────────────────────────────

  function synthesizePiece(piece, style, jobEpoch, seed) {
    const spoken = piece.lang === 'ru' ? normalizeRussian(piece.text) : { text: piece.text, segments: [] };
    piece.segments = spoken.segments;
    // Свой словарь читателя — до RUAccent: слова с «+» он не трогает.
    const accented =
      piece.lang === 'ru'
        ? call(workers.accent, { type: 'accent', text: applyUserStress(spoken.text), epoch: jobEpoch }).then((reply) => reply.text)
        : Promise.resolve(spoken.text);
    // В сэмплер куски уходят строго в порядке создания: английскому куску
    // следующей фразы ударения не нужны, и иначе он обгонял бы русский кусок
    // текущей — а читатель ждал бы звука. Куда отправить — в ускоритель или в
    // воркер, — решается в момент отправки: ускоритель могли подключить, пока
    // кусок ждал очереди.
    const posting = lane.then(async () => {
      const text = await accented;
      if (helper) return { native: synthesizeWithHelper(piece, text, style, jobEpoch, seed) };
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
        seed,
        epoch: jobEpoch,
      });
      const done = () => (sampler.pending -= 1);
      request.then(done, done);
      return { request }; // в обёртке: очередь ждёт отправки, а не синтеза
    });
    lane = posting.catch(() => {});
    piece.audio = posting.then(async ({ request, native }) => {
      if (native) return native;
      const { latent: data, frames, samples } = await request;
      if (!workers.vocoder) throw dropped('Синтез перешёл к ускорителю');
      return call(workers.vocoder, { type: 'vocode', latent: data, frames, samples, epoch: jobEpoch }, [data.buffer]);
    });
    piece.audio.then(
      (audio) => {
        piece.done = true;
        piece.result = audio;
        piece.seconds = audio.pcm.length / audio.sampleRate + (piece.pause || 0);
        tryAhead(); // может, это кусок следующей фразы — встанет встык
      },
      () => {}
    );
    return piece;
  }

  /** Кусок через ускоритель: текст в номера символов — здесь, звук — у него. */
  async function synthesizeWithHelper(piece, text, style, jobEpoch, seed) {
    const { withStress, plain } = encodeText(modelText(piece.lang, keepSupported(text, table)), table);
    const { pcm, sampleRate } = await helper.client.synth({ ids: withStress, plain, ttl: style.ttl, dp: style.dp, maxSeconds: piece.maxSeconds, epoch: jobEpoch, seed });
    const [start, end] = voicedRange(pcm, sampleRate);
    return { pcm: pcm.slice(start, end), sampleRate };
  }

  function createJob(text, { voiceId }, fastStart) {
    const style = pack.styles[keyOf(voiceId)] ?? pack.styles[TERA_VOICES[0].key];
    const measure = (part, lang) => (lang === 'ru' ? normalizeRussian(part).text.length : part.length);
    // Фразу переозвучивали — свой начальный шум (revoice); иначе обычный.
    const seed = seeds.get(keyFor(text, { voiceId }));
    const pieces = planPieces(text, { fastStart, measure }).map((piece) => synthesizePiece(piece, style, epoch, seed));
    return { pieces, fastStart };
  }

  // Скорость в ключ не входит: заготовка одна на любую скорость.
  const keyFor = (text, options) => `${keyOf(options.voiceId)}|${text}`;

  // ── Переозвучить фразу ───────────────────────────────────────────────
  // Модель иногда «дребезжит» на гласной — многое решает начальный шум
  // сэмплера. Читатель переозвучивает фразу: она синтезируется с другим
  // шумом, и выбор запоминается — в следующий раз она звучит так же.
  const SEEDS_KEY = 'teraSeeds';
  const MAX_SEEDS = 2000;
  const seeds = new Map(); // ключ фразы → начальный шум
  const seedStore = {
    async load() {
      const stored = globalThis.browser?.storage?.local
        ? (await globalThis.browser.storage.local.get(SEEDS_KEY))[SEEDS_KEY]
        : JSON.parse(globalThis.localStorage?.getItem(SEEDS_KEY) || 'null');
      return stored && typeof stored === 'object' ? stored : {};
    },
    async save(entries) {
      const value = Object.fromEntries(entries);
      if (globalThis.browser?.storage?.local) await globalThis.browser.storage.local.set({ [SEEDS_KEY]: value });
      else globalThis.localStorage?.setItem(SEEDS_KEY, JSON.stringify(value));
    },
  };
  seedStore
    .load()
    .then((stored) => {
      for (const [key, seed] of Object.entries(stored)) if (!seeds.has(key)) seeds.set(key, seed >>> 0);
    })
    .catch(() => {});

  /** Синтезировать фразу заново, с другим шумом; выбор запомнить. @returns новый шум */
  function revoice(text, options = {}) {
    const key = keyFor(text, options);
    const seed = ((seeds.get(key) ?? NOISE_SEED) + 1) >>> 0;
    seeds.delete(key);
    seeds.set(key, seed);
    while (seeds.size > MAX_SEEDS) seeds.delete(seeds.keys().next().value);
    seedStore.save(seeds).catch(() => {});
    cache.delete(key);
    return seed;
  }

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

  // ── Встык ────────────────────────────────────────────────────────────

  const gapOf = (options) => Math.max(0, Number(options.gapMs) || 0) / 1000;

  /**
   * Поставить в проигрыватель следующую фразу (по списку заготовок), пока
   * звучит текущая: её готовые куски — встык, остальные — как досинтезируются.
   * speak этой фразы подхватит их; другую фразу — снимет (dropAhead).
   */
  function tryAhead() {
    const now = scheduled;
    if (!now || now.token !== token || now.options.chain === false) return;
    if (ahead && ahead.token !== token) ahead = null;
    if (!ahead) {
      // Начинать — только пока звучит текущая: иначе это уже не «встык».
      if (!player.speaking) return;
      const nextKey = nextKeyAfter(now);
      const entry = nextKey && cache.get(nextKey);
      if (!entry?.pieces[0]?.done) return;
      ahead = { key: nextKey, entry, handles: [], token };
    }
    const { entry, handles } = ahead;
    while (handles.length < entry.pieces.length && entry.pieces[handles.length].done) {
      const piece = entry.pieces[handles.length];
      const { pcm, timings } = playable(piece, piece.result, true);
      handles.push(player.enqueue(pcm, piece.result.sampleRate, { volume: liveVolume, timings, gap: handles.length ? 0 : gapOf(now.options) }));
    }
  }

  /** Какая фраза по списку заготовок зазвучит после этой. */
  function nextKeyAfter(now) {
    const at = upcoming.indexOf(now.key);
    // Список обновился уже после начала фразы и её в нём нет — он начинается со следующей.
    return at >= 0 ? upcoming[at + 1] : upcomingSeq > now.seq ? upcoming[0] : null;
  }

  /** Поставленная заранее фраза не понадобилась — снять её звук. */
  function dropAhead() {
    ahead?.handles[0]?.cancel(); // и всё, что за ней
    ahead = null;
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
      const seq = upcomingSeq;
      // Эта фраза уже стоит в проигрывателе встык к предыдущей — подхватываем.
      const adopted = ahead && ahead.token === token && ahead.key === key ? ahead : null;
      if (!adopted) dropAhead();
      ahead = null;
      scheduled = null;
      let entry = adopted ? adopted.entry : job(text, options, { forSpeak: true });
      speakingKey = key;
      if (!adopted) liveVolume = options.volume ?? 1;
      // Заготовки, отложенные на время загрузки, — после текущей фразы.
      for (const item of deferred.splice(0)) {
        if (item.epoch === epoch) readySeconds(job(item.text, item.options)).then(item.resolve, item.reject);
        else item.reject(Object.assign(new Error('Фраза больше не нужна'), { dropped: true }));
      }
      const handles = adopted ? adopted.handles : [];
      handles.forEach((handle, i) => handle.attach({ onStart: i === 0 ? options.onStart : undefined, onBoundary: options.onBoundary }));
      if (!adopted) {
        // Предыдущая фраза только что договорила, а эта не готова — не успеваем.
        if (performance.now() - lastEnded < 300 && !entry.pieces[0].done) noteLag();
        await headStart(entry, player.rate, myToken);
        if (myToken !== token) return 'cancelled';
      } else liveVolume = options.volume ?? liveVolume;
      let retried = false;
      // Куски — в проигрыватель, как только готовы: встают встык к предыдущим.
      for (let i = handles.length; i < entry.pieces.length; i += 1) {
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
        // Звук кончился раньше, чем досинтезировался этот кусок, — синтез не успевает.
        if (i > 0 && !player.speaking) noteLag();
        const { pcm, timings } = playable(piece, audio, true);
        handles.push(
          player.enqueue(pcm, audio.sampleRate, {
            volume: liveVolume,
            timings,
            onBoundary: options.onBoundary,
            onStart: i === 0 ? options.onStart : undefined,
            gap: i === 0 ? gapOf(options) : 0,
          })
        );
      }
      // Все куски в проигрывателе — пора ставить следующую фразу.
      const mine = { key, token: myToken, options, seq };
      scheduled = mine;
      tryAhead();
      const results = await Promise.all(handles.map((handle) => handle.done));
      if (scheduled === mine) scheduled = null;
      if (myToken !== token || results.includes('cancelled')) return 'cancelled';
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
      upcoming = texts.map((text) => keyFor(text, options));
      upcomingSeq += 1;
      const keep = new Set(upcoming);
      for (const key of [...cache.keys()]) if (!keep.has(key) && key !== speakingKey) cache.delete(key);
      // Встык уже стоит фраза, которой впереди больше нет (выключили примечание), — снимаем.
      if (ahead && scheduled && ahead.key !== nextKeyAfter(scheduled)) dropAhead();
      tryAhead();
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

    /**
     * Какие из слов есть в словаре ударений. null — словарь ещё не
     * загружен (грузить ради этого модели незачем) или не ответил.
     * @returns {Promise<Set<string>|null>}
     */
    async knownWords(words) {
      // Модели как раз грузятся (чтение начинается) — дождаться: иначе первые
      // фразы прозвучали бы без склейки, а потом синтезировались заново.
      if (!ready && loading) await loading.catch(() => {});
      const slot = workers.accent;
      if (!ready || !slot) return null;
      if (!words.length) return new Set();
      const reply = await call(slot, { type: 'known', words }).catch(() => null);
      return reply ? new Set(reply.words) : null;
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
      ahead = null;
      scheduled = null;
      player.stop('cancelled');
    },
    /**
     * Оборвать звучащую фразу, но заготовки впереди не трогать: пропустили
     * примечание — следующая фраза уже синтезирована и пойдёт сразу.
     */
    skip() {
      token += 1;
      ahead = null;
      scheduled = null;
      player.stop('cancelled');
    },
    /** Звук встаёт встык: паузу между фразами (gapMs) ставит сам проигрыватель. */
    gapless: true,
    revoice,
    /** Сколько фраз переозвучено (своим шумом). */
    get revoiced() {
      return seeds.size;
    },
    /** Забыть все переозвучки — фразы снова с обычным шумом. */
    forgetRevoiced() {
      seeds.clear();
      cache.clear();
      return seedStore.save(seeds);
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
    /** Синтез сейчас идёт через ускоритель. */
    get usingHelper() {
      return Boolean(helper);
    },
    /** Ускоритель установлен, но не подключился — почему (для подсказки). */
    get helperError() {
      return helperError;
    },
    /**
     * Ускоритель поставили или убрали (в этой или другой вкладке). Убрали —
     * отпускаем его сразу: программа удаляет себя, когда её никто не держит.
     */
    refreshHelper(installed = true) {
      helperLosses = 0;
      if (!installed) {
        if (helper) shutdown();
        return;
      }
      switchToHelper().catch((error) => console.warn('TeraTTS: переход к ускорителю не удался', error));
    },

    /** Для проверок: какие модели в памяти; sampler: 'helper' — синтез у ускорителя. */
    get models() {
      return ready ? { sampler: helper ? 'helper' : samplerPart, omograph: omographPart, accent: accentRemote ? 'helper' : 'browser' } : null;
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
        let blobs = await helperBlobs();
        let names = HELPER_MODELS;
        // Ускоритель считает и ударения — их модели передаём заодно, одним прогрессом.
        if (connection.hello.features?.includes('accent')) {
          blobs = { ...blobs, ...(await accentBlobs()) };
          names = [...HELPER_MODELS, ...Object.keys(HELPER_ACCENT_MODELS)];
        }
        await syncModels(connection.client, connection.hello.files, blobs, onProgress, names);
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
