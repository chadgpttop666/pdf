// Проигрывание синтезированного звука для нейроголосов (Piper, TeraTTS):
// AudioContext, громкость, пауза и подсветка слов по часам звука.
//
// Границ слов нейроголоса не сообщают — они оцениваются заранее (доля
// произнесённых букв, см. piper-math.js) и сверяются с часами AudioContext:
// на паузе часы стоят, подсветка тоже.

const BOUNDARY_POLL_MS = 40;

export function createAudioPlayer() {
  let context = null;
  let current = null; // { source, timer, resolve, gain }
  let paused = false;

  function audioContext() {
    context ||= new AudioContext();
    return context;
  }

  function stop(result = 'cancelled') {
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

  /**
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

    const buffer = ctx.createBuffer(1, pcm.length, sampleRate);
    buffer.copyToChannel(pcm, 0);
    const source = ctx.createBufferSource();
    source.buffer = buffer;
    const gain = ctx.createGain();
    gain.gain.value = volume;
    source.connect(gain).connect(ctx.destination);

    const startedAt = ctx.currentTime;
    let next = 0;
    return new Promise((resolve) => {
      const timer = setInterval(() => {
        const progress = (ctx.currentTime - startedAt) / buffer.duration;
        while (next < timings.length && timings[next].at <= progress) {
          const { charIndex, charLength } = timings[next];
          next += 1;
          onBoundary?.({ charIndex, charLength, name: 'word' });
        }
      }, BOUNDARY_POLL_MS);
      current = { source, timer, resolve, gain };
      source.onended = () => {
        if (current?.source !== source) return;
        current = null;
        clearInterval(timer);
        resolve('ended');
      };
      source.start();
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
    get speaking() {
      return Boolean(current);
    },
  };
}
