// Провайдер для внешнего движка синтеза, работающего по HTTP: локальный
// Piper, Silero и подобные. Протокол описан в docs/tts-http-provider.md.
// Интерфейс совпадает с web-speech.js, поэтому контроллер их не различает.

export function createHttpProvider({ url }) {
  const audio = new Audio();
  let objectUrl = null;
  let controller = null;

  function releaseAudio() {
    audio.pause();
    if (objectUrl) URL.revokeObjectURL(objectUrl);
    objectUrl = null;
  }

  return {
    id: 'http',
    get available() {
      return Boolean(url);
    },

    async voices() {
      if (!url) return [];
      try {
        const response = await fetch(new URL('voices', ensureSlash(url)), { method: 'GET' });
        if (!response.ok) return [];
        const list = await response.json();
        return (Array.isArray(list) ? list : list.voices || []).map((voice) => ({
          id: voice.id ?? voice.name,
          name: voice.name ?? voice.id,
          lang: voice.lang ?? '',
        }));
      } catch {
        return []; // список голосов необязателен
      }
    },

    async speak(text, { voiceId, rate = 1, pitch = 1, volume = 1, lang } = {}) {
      if (!url) throw new Error('Не указан адрес внешнего движка синтеза');
      releaseAudio();
      controller = new AbortController();

      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text, voice: voiceId || undefined, rate, pitch, lang }),
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(`Движок синтеза ответил ${response.status}`);

      const blob = await response.blob();
      objectUrl = URL.createObjectURL(blob);
      audio.src = objectUrl;
      audio.volume = volume;
      // Скорость применяем и на стороне плеера: не каждый движок её умеет.
      audio.playbackRate = rate;

      return new Promise((resolve, reject) => {
        audio.onended = () => resolve('ended');
        audio.onerror = () => reject(new Error('Не удалось воспроизвести ответ движка синтеза'));
        audio.play().catch(reject);
      });
    },

    pause() {
      audio.pause();
    },
    resume() {
      audio.play().catch(() => {});
    },
    cancel() {
      controller?.abort();
      controller = null;
      releaseAudio();
    },
    get speaking() {
      return !audio.paused && !audio.ended;
    },
    get paused() {
      return audio.paused;
    },
  };
}

function ensureSlash(value) {
  return value.endsWith('/') ? value : `${value}/`;
}
