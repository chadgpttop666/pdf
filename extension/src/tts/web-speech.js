// Провайдер поверх системного синтеза речи. В Windows это голоса SAPI,
// они же дают события границ слов; на других системах события могут не
// приходить — тогда остаётся подсветка целого предложения.

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

  return {
    id: 'web-speech',
    get available() {
      return Boolean(synth);
    },
    voices,

    /**
     * @returns {Promise<'ended'|'cancelled'>} промис завершения фразы
     */
    async speak(text, { voiceId, rate = 1, pitch = 1, volume = 1, lang, onBoundary } = {}) {
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
