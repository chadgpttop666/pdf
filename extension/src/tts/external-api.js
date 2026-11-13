// Озвучка для других расширений. Закадровый перевод YouTube (расширение
// yt-skach) присылает фразу — читалка отдаёт её звук голосом TeraTTS: тем же
// пакетом голосов, ускорителем и словарём ударений, что и при чтении PDF.
// Скачивать голоса второй раз не нужно, а ускоритель Firefox пускает только
// к читалке.
//
// Отвечаем только расширениям из списка. Только Firefox: фоновая страница
// Chrome — service worker, а в нём нет ни AudioContext, ни import().

export const EXTERNAL_CLIENTS = ['yt-transcript@yt-skach.local'];
const DEFAULT_VOICE = 'tera:ru_m5';
const MAX_TEXT = 2000; // фраза субтитров; больше — явно не то, что нам шлют

/**
 * @param getProvider async () => провайдер TeraTTS (tera-provider.js)
 * @param clients id расширений, которым можно
 * @returns обработчик для runtime.onMessageExternal
 */
export function createExternalApi({ getProvider, clients = EXTERNAL_CLIENTS }) {
  async function ready() {
    const tera = await getProvider();
    if (!tera.available) throw new Error('TeraTTS недоступен в этом браузере');
    if (!(await tera.isInstalled())) {
      throw new Error('Голоса TeraTTS не скачаны: PDF-читалка → Настройки → Голоса и модели');
    }
    return tera;
  }

  const handlers = {
    async 'tts-voices'() {
      const tera = await getProvider();
      const voices = tera.available ? await tera.voices() : [];
      return {
        installed: voices.some((voice) => voice.installed),
        voices: voices.map(({ id, name }) => ({ id, name })),
      };
    },
    /** Загрузить модели заранее: первая фраза пойдёт без десяти секунд ожидания. */
    async 'tts-preload'() {
      (await ready()).preload();
      return { ok: true };
    },
    /** Фраза целиком одним звуком: { pcm: Float32Array, sampleRate }. */
    async 'tts-render'({ text, voiceId }) {
      const phrase = String(text ?? '').trim();
      if (!phrase) throw new Error('Пустая фраза');
      if (phrase.length > MAX_TEXT) throw new Error(`Фраза длиннее ${MAX_TEXT} символов`);
      const voice = String(voiceId || DEFAULT_VOICE);
      if (!voice.startsWith('tera:')) throw new Error(`Неизвестный голос ${voice}`);
      const { pcm, sampleRate } = await (await ready()).render(phrase, { voiceId: voice });
      return { pcm, sampleRate };
    },
  };

  return (message, sender) => {
    if (!clients.includes(sender?.id)) return undefined;
    const handler = handlers[message?.type];
    return handler ? handler(message) : undefined;
  };
}
