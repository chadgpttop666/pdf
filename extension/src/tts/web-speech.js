// Провайдер поверх системного синтеза речи. В Windows это голоса SAPI,
// они же дают события границ слов; на других системах события могут не
// приходить — тогда остаётся подсветка целого предложения.
//
// Английские вставки в русской фразе («Journal of Political Philosophy»)
// русский голос читает плохо — их произносит английский голос системы.

import { splitLanguageRuns } from './language-runs.js';

export function createWebSpeechProvider() {
  const synth = typeof speechSynthesis !== 'undefined' ? speechSynthesis : null;
  // Chromium глушит речь примерно через 15 секунд, если её не «поддёргивать».
  // Firefox в этом не нуждается, поэтому страховку включаем только вне его.
  const needsKeepAlive = !navigator.userAgent.includes('Firefox');
  let keepAliveTimer = 0;
  let currentUtterance = null;

  function startKeepAlive() {
    if (!needsKeepAlive || keepAliveTimer) return;
    keepAliveTimer = setInterval(() => {
      if (synth?.speaking && !synth.paused) {
        synth.pause();
        synth.resume();
      }
    }, 10000);
  }

  function stopKeepAlive() {
    clearInterval(keepAliveTimer);
    keepAliveTimer = 0;
  }

  async function voices() {
    if (!synth) return [];
    const list = synth.getVoices();
    if (list.length) return normalize(list);
    // Список голосов приезжает асинхронно — ждём событие, но не бесконечно.
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve(normalize(synth.getVoices())), 1500);
      synth.addEventListener(
        'voiceschanged',
        () => {
          clearTimeout(timer);
          resolve(normalize(synth.getVoices()));
        },
        { once: true }
      );
    });
  }

  function normalize(list) {
    return list.map((voice) => ({
      id: voice.voiceURI,
      name: voice.name,
      lang: voice.lang,
      default: voice.default,
      native: voice,
    }));
  }

  /** Английский голос системы для вставок, если выбранный голос не английский. */
  async function englishVoiceFor(voiceId) {
    const list = await voices();
    const chosen = list.find((voice) => voice.id === voiceId);
    if (/^en/i.test(chosen?.lang || '')) return null;
    const english = list.filter((voice) => /^en/i.test(voice.lang || ''));
    return english.find((voice) => voice.default) || english.find((voice) => /^en-US/i.test(voice.lang)) || english[0] || null;
  }

  /** Одна фраза одним голосом. */
  async function speakOne(text, { voiceId, rate = 1, pitch = 1, volume = 1, lang, onBoundary, onStart } = {}) {
    if (!synth) throw new Error('Синтез речи недоступен в этом браузере');
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.rate = rate;
    utterance.pitch = pitch;
    utterance.volume = volume;
    if (lang) utterance.lang = lang;

    if (voiceId) {
      const match = (await voices()).find((voice) => voice.id === voiceId);
      if (match) utterance.voice = match.native;
    }

    currentUtterance = utterance;
    startKeepAlive();

    return new Promise((resolve, reject) => {
      utterance.onstart = () => onStart?.();
      utterance.onboundary = (event) => {
        onBoundary?.({ charIndex: event.charIndex, charLength: event.charLength, name: event.name });
      };
      utterance.onend = () => {
        if (currentUtterance === utterance) currentUtterance = null;
        resolve('ended');
      };
      utterance.onerror = (event) => {
        if (currentUtterance === utterance) currentUtterance = null;
        // Прерывание — это наш собственный cancel(), а не сбой.
        if (['interrupted', 'canceled'].includes(event.error)) resolve('cancelled');
        else reject(new Error(`Синтез речи: ${event.error}`));
      };
      synth.speak(utterance);
    });
  }

  return {
    id: 'web-speech',
    get available() {
      return Boolean(synth);
    },
    voices,

    /**
     * @param options.mixLanguages английские вставки — английским голосом
     * @returns {Promise<'ended'|'cancelled'>} промис завершения фразы
     */
    async speak(text, options = {}) {
      const runs = options.mixLanguages ? splitLanguageRuns(text) : [];
      const english = runs.some((run) => run.lang === 'en') ? await englishVoiceFor(options.voiceId) : null;
      if (!english) return speakOne(text, options);

      // Фраза по кускам: русские — выбранным голосом, английские — английским.
      // Границы слов приходят от каждого куска — сдвигаем их к началу фразы.
      let started = false;
      for (const run of runs) {
        const part = text.slice(run.start, run.end);
        if (!/[\p{L}\p{N}]/u.test(part)) continue;
        const isEnglish = run.lang === 'en';
        const result = await speakOne(part, {
          ...options,
          voiceId: isEnglish ? english.id : options.voiceId,
          lang: isEnglish ? english.lang : options.lang,
          onStart: started ? undefined : options.onStart,
          onBoundary: (event) => options.onBoundary?.({ ...event, charIndex: event.charIndex + run.start }),
        });
        started = true;
        if (result !== 'ended') return result;
      }
      return 'ended';
    },

    pause() {
      synth?.pause();
    },
    resume() {
      synth?.resume();
    },
    cancel() {
      stopKeepAlive();
      currentUtterance = null;
      synth?.cancel();
    },
    get speaking() {
      return Boolean(synth?.speaking);
    },
    get paused() {
      return Boolean(synth?.paused);
    },
  };
}
