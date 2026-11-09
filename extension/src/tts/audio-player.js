// Проигрывание синтезированного звука для нейроголосов (Piper, TeraTTS):
// AudioContext, громкость, скорость, пауза и подсветка слов по часам звука.
//
// Скорость речи — забота проигрывателя, а не модели: нейроголос всегда
// синтезирует на обычной скорости, а здесь запись ускоряется без изменения
// высоты голоса (time-stretch.js). Модель, которую просят говорить быстрее,
// «зажёвывает» слова. Заодно скорость меняется сразу, посреди фразы: с
// места, где сейчас звук, запись ускоряется заново, старый и новый звук
// сменяют друг друга за доли секунды без щелчка.
//
// Звук идёт цепочкой: каждая запись (enqueue) встаёт по часам AudioContext
// встык к предыдущей. Поэтому следующую фразу ставят, пока звучит текущая, —
// и стык не зависит от того, успеет ли страница: перерисовка страниц,
// сборка мусора, переключение окон подвешивают её на сотни миллисекунд, а
// звук уже стоит в очереди звуковой системы и идёт без дыр. Раньше
// следующая фраза начиналась, только когда страница узнавала о конце
// предыдущей, — и каждое подвисание на стыке было слышно.
//
// Ускоренный звук считается кусками: первые полторы секунды — сразу, чтобы
// звук пошёл без задержки и с запасом, остальное — следом.
//
// Границ слов нейроголоса не сообщают — они оцениваются заранее (доля
// произнесённых букв, см. piper-math.js) и сверяются с часами AudioContext:
// на паузе часы стоят, подсветка тоже.

import { createStretcher } from './time-stretch.js';

const BOUNDARY_POLL_MS = 40;
const FIRST_BLOCK_SECONDS = 0.3;
// Сразу за первым куском — ещё столько: запас, если страница подвиснет
// прежде, чем досчитает остальное.
const LEAD_SECONDS = 1.2;
const BLOCK_SECONDS = 2;
const FADE_SECONDS = 0.012;
// Вход каждой фразы: короче, чтобы не смазать первый согласный, но без щелчка.
const ENTRY_FADE_SECONDS = 0.004;
// Пока тянут ползунок, звук перезапускается не чаще этого.
const RATE_RESTART_MS = 80;
// Если от фразы осталось меньше — доигрываем как есть, новая скорость со следующей.
const MIN_RESTART_SECONDS = 0.05;

const clampRate = (value) => Math.min(4, Math.max(0.25, Number(value) || 1));

export function createAudioPlayer() {
  let context = null;
  const chain = []; // записи по порядку звучания: первая звучит (или вот-вот)
  let paused = false;
  let rate = 1;
  let rateTimer = 0;
  let lastRestart = 0;
  let poll = 0;
  let lastEnd = 0; // когда по часам звука кончилась последняя запись — для паузы между фразами

  function audioContext() {
    context ||= new AudioContext();
    return context;
  }

  /** Когда по часам звука кончится запись (на её нынешней скорости). */
  const endOf = (entry) => entry.run.startedAt + entry.run.stretcher.length / entry.sampleRate;

  /** Сколько отсчётов исходной записи уже прозвучало. */
  function position(entry) {
    const { run } = entry;
    const elapsed = Math.max(0, context.currentTime - run.startedAt);
    return Math.min(entry.pcm.length, run.offset + elapsed * entry.sampleRate * run.rate);
  }

  /** Поставить запись с отсчёта offset на текущей скорости: звучать с момента at, плавно войдя за fade секунд. */
  function startRun(entry, offset, at, fade) {
    const ctx = audioContext();
    const run = {
      stretcher: createStretcher(entry.pcm.subarray(offset), entry.sampleRate, rate),
      rate,
      offset,
      startedAt: at,
      emitted: 0, // сколько отсчётов ускоренной записи уже поставлено в очередь
      sources: [],
      fade: ctx.createGain(),
      timer: 0,
    };
    run.fade.connect(entry.gain);
    run.fade.gain.setValueAtTime(0, at);
    run.fade.gain.linearRampToValueAtTime(1, at + fade);
    entry.run = run;
    /** Посчитать и поставить следующий кусок; false — больше нечего. */
    const pump = (seconds) => {
      if (entry.run !== run) return false;
      const block = run.stretcher.take(Math.max(1, Math.round(seconds * entry.sampleRate)));
      if (!block) return false;
      const buffer = ctx.createBuffer(1, block.length, entry.sampleRate);
      buffer.copyToChannel(block, 0);
      const source = ctx.createBufferSource();
      source.buffer = buffer;
      source.connect(run.fade);
      source.start(run.startedAt + run.emitted / entry.sampleRate);
      run.emitted += block.length;
      run.sources.push(source);
      if (run.emitted < run.stretcher.length) return true;
      // Кусок последний — по его концу запись и кончилась.
      source.onended = () => {
        if (entry.run === run) ended(entry);
      };
      return false;
    };
    if (pump(FIRST_BLOCK_SECONDS) && pump(LEAD_SECONDS)) {
      const more = () => {
        if (pump(BLOCK_SECONDS)) run.timer = setTimeout(more, 0);
      };
      run.timer = setTimeout(more, 0);
    }
  }

  /** Заглушить звук записи: сразу или плавно, за FADE_SECONDS. */
  function stopRun(run, smoothly = false) {
    clearTimeout(run.timer);
    const end = smoothly ? context.currentTime + FADE_SECONDS : 0;
    if (smoothly) {
      const { gain } = run.fade;
      gain.cancelScheduledValues(context.currentTime);
      gain.setValueAtTime(gain.value, context.currentTime);
      gain.linearRampToValueAtTime(0, end);
    }
    for (const source of run.sources) {
      source.onended = null;
      try {
        source.stop(end);
      } catch {
        /* уже закончился */
      }
    }
    if (smoothly) setTimeout(() => run.fade.disconnect(), FADE_SECONDS * 1000 + 100);
    else run.fade.disconnect();
  }

  function settle(entry, result) {
    if (entry.result) return;
    entry.result = result;
    entry.resolve(result);
  }

  /** Запись дозвучала (и все, что стояли перед ней, — их конец мог ещё не прийти). */
  function ended(entry) {
    const index = chain.indexOf(entry);
    if (index < 0) return;
    for (const done of chain.splice(0, index + 1)) {
      clearTimeout(done.run.timer);
      done.gain.disconnect();
      settle(done, 'ended');
    }
    lastEnd = endOf(entry);
    if (!chain.length) stopPoll();
  }

  /** Снять записи с index и дальше: звучащую — плавно, ещё не начатые — сразу. */
  function cancelFrom(index, result = 'cancelled') {
    const removed = chain.splice(index);
    for (const entry of removed) {
      // Оборвали посреди звука (следующее предложение, стоп) — гасим плавно:
      // резкий обрыв волны слышен щелчком.
      const smoothly = context?.state === 'running' && context.currentTime >= entry.run.startedAt;
      stopRun(entry.run, smoothly);
      if (smoothly) setTimeout(() => entry.gain.disconnect(), FADE_SECONDS * 1000 + 100);
      else entry.gain.disconnect();
      settle(entry, result);
    }
    if (!chain.length) {
      stopPoll();
      clearTimeout(rateTimer);
      lastEnd = 0; // оборвали — следующая запись без паузы перед ней
    }
  }

  function stop(result = 'cancelled') {
    cancelFrom(0, result);
  }

  // ── Начало записей и подсветка слов — по часам звука ─────────────────

  function begin(entry) {
    if (entry.started) return;
    entry.started = true;
    entry.onStart?.();
  }

  function boundaries(entry) {
    if (!entry.onBoundary) return; // подсветку ещё не попросили — слова догонят, когда попросят
    const progress = position(entry) / entry.pcm.length;
    while (entry.next < entry.timings.length && entry.timings[entry.next].at <= progress) {
      const { charIndex, charLength } = entry.timings[entry.next];
      entry.next += 1;
      entry.onBoundary({ charIndex, charLength, name: 'word' });
    }
  }

  function tick() {
    if (!context) return;
    const now = context.currentTime;
    for (const entry of [...chain]) {
      if (now < entry.run.startedAt) break; // и следующие ещё не начались
      begin(entry);
      boundaries(entry);
    }
  }

  function startPoll() {
    poll ||= setInterval(tick, BOUNDARY_POLL_MS);
  }

  function stopPoll() {
    clearInterval(poll);
    poll = 0;
  }

  /**
   * Поставить запись в очередь: она зазвучит встык к последней (через gap
   * секунд после неё) или сразу, если ничего не звучит.
   * @param timings [{ at: доля длительности 0…1, charIndex, charLength }]
   * @returns {{ done: Promise<'ended'|'cancelled'>, started: boolean,
   *   attach(callbacks): void, cancel(): void }} — attach добавляет onStart и
   *   onBoundary записи, поставленной заранее: начало и уже прозвучавшие
   *   слова сообщаются сразу; cancel снимает её и всё, что стоит за ней
   */
  function enqueue(pcm, sampleRate, { volume = 1, timings = [], onBoundary = null, onStart = null, gap = 0 } = {}) {
    const ctx = audioContext();
    if (paused) ctx.suspend();
    else if (ctx.state === 'suspended') ctx.resume();
    const entry = { pcm, sampleRate, timings, onBoundary, onStart, gap, next: 0, started: false, run: null, gain: null, result: null };
    entry.done = new Promise((resolve) => (entry.resolve = resolve));
    const handle = {
      done: entry.done,
      get started() {
        return entry.started;
      },
      attach({ onStart: start, onBoundary: boundary } = {}) {
        if (boundary) entry.onBoundary = boundary;
        if (!start) return;
        if (entry.started) start();
        else entry.onStart = start;
      },
      cancel() {
        const index = chain.indexOf(entry);
        if (index >= 0) cancelFrom(index);
      },
    };
    if (!pcm.length) {
      settle(entry, 'ended');
      return handle;
    }
    const tail = chain.at(-1);
    const now = ctx.currentTime;
    const at = Math.max(now, (tail ? endOf(tail) : lastEnd) + gap);
    entry.gain = ctx.createGain();
    entry.gain.gain.value = volume;
    entry.gain.connect(ctx.destination);
    chain.push(entry);
    startRun(entry, 0, at, ENTRY_FADE_SECONDS);
    startPoll();
    if (at <= now) begin(entry);
    return handle;
  }

  /**
   * Сыграть запись сразу, оборвав звучащее. Скорость — заданная setRate:
   * провайдер ставит её в начале фразы, ещё до синтеза, чтобы смена скорости
   * во время синтеза не затиралась.
   * @param isCancelled проверка перед стартом: фразу могли отменить, пока ждали контекст
   * @returns {Promise<'ended'|'cancelled'>}
   */
  async function play(pcm, sampleRate, { isCancelled = () => false, ...options } = {}) {
    const ctx = audioContext();
    // Поставили на паузу, пока фраза синтезировалась, — начнём её на паузе.
    if (paused) await ctx.suspend();
    else if (ctx.state === 'suspended') ctx.resume();
    if (isCancelled()) return 'cancelled';
    if (!pcm.length) return 'ended';
    stop('cancelled');
    return enqueue(pcm, sampleRate, options).done;
  }

  /** Новая скорость — звучащей записи с места, где сейчас звук, и всем, что стоят за ней. */
  function applyRate() {
    if (!chain.length || !context) return;
    lastRestart = performance.now();
    const now = context.currentTime;
    let previousEnd = null;
    for (const entry of chain) {
      const { run } = entry;
      if (now >= run.startedAt) {
        if (Math.abs(run.rate - rate) >= 0.001) {
          const at = Math.floor(position(entry));
          if (entry.pcm.length - at >= MIN_RESTART_SECONDS * entry.sampleRate) {
            stopRun(run, true);
            startRun(entry, at, now, FADE_SECONDS);
          }
        }
      } else {
        // Ещё не началась — встаёт встык к предыдущей, уже на новой скорости.
        const at = previousEnd === null ? run.startedAt : Math.max(now, previousEnd + entry.gap);
        if (Math.abs(run.rate - rate) >= 0.001 || Math.abs(at - run.startedAt) > 1e-6) {
          stopRun(run, false);
          startRun(entry, 0, at, ENTRY_FADE_SECONDS);
        }
      }
      previousEnd = endOf(entry);
    }
  }

  return {
    play,
    enqueue,
    stop,
    /** Громкость звучащих и поставленных записей — сразу, не дожидаясь следующей. */
    setVolume(volume) {
      for (const entry of chain) entry.gain.gain.value = volume;
    },
    /** Скорость — сразу, посреди фразы; и для следующих фраз. */
    setRate(value) {
      rate = clampRate(value);
      clearTimeout(rateTimer);
      const wait = lastRestart + RATE_RESTART_MS - performance.now();
      if (wait > 0) rateTimer = setTimeout(applyRate, wait);
      else applyRate();
    },
    get rate() {
      return rate;
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
    pause() {
      paused = true;
      context?.suspend();
    },
    resume() {
      paused = false;
      context?.resume();
    },
    get paused() {
      return paused;
    },
    /** Звук есть, но браузер не дал ему начаться без нажатия пользователя. */
    get blocked() {
      return Boolean(context) && context.state === 'suspended' && !paused;
    },
    get speaking() {
      return chain.length > 0;
    },
    /** Сколько секунд звука ещё впереди в очереди (для проверок). */
    get queuedSeconds() {
      return chain.length && context ? Math.max(0, endOf(chain.at(-1)) - context.currentTime) : 0;
    },
  };
}
