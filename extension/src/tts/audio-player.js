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
// Ускоренный звук идёт кусками: первый готов сразу, остальные досчитываются,
// пока он звучит, и ставятся встык по часам AudioContext.
//
// Границ слов нейроголоса не сообщают — они оцениваются заранее (доля
// произнесённых букв, см. piper-math.js) и сверяются с часами AudioContext:
// на паузе часы стоят, подсветка тоже.

import { createStretcher } from './time-stretch.js';

const BOUNDARY_POLL_MS = 40;
const FIRST_BLOCK_SECONDS = 0.3;
const BLOCK_SECONDS = 2;
const FADE_SECONDS = 0.012;
// Пока тянут ползунок, звук перезапускается не чаще этого.
const RATE_RESTART_MS = 80;
// Если от фразы осталось меньше — доигрываем как есть, новая скорость со следующей.
const MIN_RESTART_SECONDS = 0.05;

const clampRate = (value) => Math.min(4, Math.max(0.25, Number(value) || 1));

export function createAudioPlayer() {
  let context = null;
  let current = null; // { pcm, sampleRate, gain, run, timer, resolve }
  let paused = false;
  let rate = 1;
  let rateTimer = 0;
  let lastRestart = 0;

  function audioContext() {
    context ||= new AudioContext();
    return context;
  }

  /** Сколько отсчётов исходной записи уже прозвучало. */
  function position(entry) {
    const { run } = entry;
    const elapsed = Math.max(0, context.currentTime - run.startedAt);
    return Math.min(entry.pcm.length, run.offset + elapsed * entry.sampleRate * run.rate);
  }

  /** Играть запись с отсчёта offset на текущей скорости; fade — плавно войти. */
  function startRun(entry, offset, fade = false) {
    const ctx = audioContext();
    const run = {
      stretcher: createStretcher(entry.pcm.subarray(offset), entry.sampleRate, rate),
      rate,
      offset,
      startedAt: ctx.currentTime,
      emitted: 0, // сколько отсчётов ускоренной записи уже поставлено в очередь
      sources: [],
      fade: ctx.createGain(),
      timer: 0,
    };
    run.fade.connect(entry.gain);
    if (fade) {
      run.fade.gain.setValueAtTime(0, run.startedAt);
      run.fade.gain.linearRampToValueAtTime(1, run.startedAt + FADE_SECONDS);
    }
    entry.run = run;
    const pump = (seconds) => {
      if (entry.run !== run) return;
      const block = run.stretcher.take(Math.round(seconds * entry.sampleRate));
      if (!block) return;
      const buffer = ctx.createBuffer(1, block.length, entry.sampleRate);
      buffer.copyToChannel(block, 0);
      const source = ctx.createBufferSource();
      source.buffer = buffer;
      source.connect(run.fade);
      source.start(run.startedAt + run.emitted / entry.sampleRate);
      run.emitted += block.length;
      run.sources.push(source);
      // Кусок последний — по его концу фраза и закончилась.
      if (run.emitted >= run.stretcher.length) {
        source.onended = () => {
          if (current === entry && entry.run === run) finish(entry, 'ended');
        };
      } else run.timer = setTimeout(() => pump(BLOCK_SECONDS), 0);
    };
    pump(FIRST_BLOCK_SECONDS);
  }

  /** Заглушить звук: сразу или плавно, за FADE_SECONDS. */
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

  function finish(entry, result) {
    if (current !== entry) return;
    current = null;
    clearInterval(entry.timer);
    clearTimeout(rateTimer);
    stopRun(entry.run);
    entry.gain.disconnect();
    entry.resolve(result);
  }

  function stop(result = 'cancelled') {
    if (current) finish(current, result);
  }

  /** Новая скорость звучащей фразы — с места, где сейчас звук. */
  function applyRate() {
    const entry = current;
    if (!entry || Math.abs(entry.run.rate - rate) < 0.001) return;
    lastRestart = performance.now();
    const at = Math.floor(position(entry));
    if (entry.pcm.length - at < MIN_RESTART_SECONDS * entry.sampleRate) return;
    stopRun(entry.run, true);
    startRun(entry, at, true);
  }

  /**
   * Скорость — заданная setRate: провайдер ставит её в начале фразы, ещё до
   * синтеза, чтобы смена скорости во время синтеза не затиралась.
   * @param timings [{ at: доля длительности 0…1, charIndex, charLength }]
   * @param isCancelled проверка перед стартом: фразу могли отменить, пока ждали контекст
   * @returns {Promise<'ended'|'cancelled'>}
   */
  async function play(pcm, sampleRate, { volume = 1, timings = [], onBoundary, onStart, isCancelled = () => false } = {}) {
    const ctx = audioContext();
    // Поставили на паузу, пока фраза синтезировалась, — начнём её на паузе.
    if (paused) await ctx.suspend();
    else if (ctx.state === 'suspended') ctx.resume();
    if (isCancelled()) return 'cancelled';
    if (!pcm.length) return 'ended';
    stop('cancelled');

    const gain = ctx.createGain();
    gain.gain.value = volume;
    gain.connect(ctx.destination);
    return new Promise((resolve) => {
      const entry = { pcm, sampleRate, gain, run: null, timer: 0, resolve };
      current = entry;
      startRun(entry, 0);
      let next = 0;
      entry.timer = setInterval(() => {
        const progress = position(entry) / pcm.length;
        while (next < timings.length && timings[next].at <= progress) {
          const { charIndex, charLength } = timings[next];
          next += 1;
          onBoundary?.({ charIndex, charLength, name: 'word' });
        }
      }, BOUNDARY_POLL_MS);
      onStart?.();
    });
  }

  return {
    play,
    stop,
    /** Громкость звучащей фразы — сразу, не дожидаясь следующей. */
    setVolume(volume) {
      if (current) current.gain.gain.value = volume;
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
      return Boolean(current);
    },
  };
}
