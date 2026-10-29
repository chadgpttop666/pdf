// Чтение вслух простого текста — для окна озвучки выделенного на сайтах.
// То же, что контроллер читалки PDF (controller.js), только без страниц:
// список предложений, пауза и продолжение, перескок, подготовка речи вперёд
// (buffer.js) и подсветка слова. Движок выбирается по голосу (engines.js).

import { get as getSetting } from '../settings.js';
import { bufferBudget, bufferedSeconds, prepareAhead } from './buffer.js';

const isSpeakable = (text) => /[\p{L}\p{N}]/u.test(text);
const BUSY_DELAY_MS = 350;

/**
 * @param engines движки озвучки (engines.js)
 * @param hooks.onSentence(index) — началось предложение
 * @param hooks.onWord(index, start, length) — слово внутри предложения
 * @param hooks.onState(state) — idle | speaking | paused
 * @param hooks.onStatus(text, { busy }) — строка состояния
 */
export function createTextReader(engines, hooks = {}) {
  let sentences = [];
  let index = 0;
  let until = Infinity; // последнее предложение, которое надо прочитать (выделенный кусок)
  let state = 'idle';
  let generation = 0;
  let provider = engines.pick();
  let buffer = [];
  let busyTimer = 0;

  const setState = (next) => {
    state = next;
    hooks.onState?.(state);
  };
  const status = (text, extra = {}) => hooks.onStatus?.(text, extra);

  function options() {
    return {
      voiceId: getSetting('ttsVoiceUri') || undefined,
      rate: getSetting('ttsRate'),
      pitch: getSetting('ttsPitch'),
      volume: getSetting('ttsVolume'),
      lang: 'ru-RU',
      mixLanguages: getSetting('ttsMixLanguages'),
    };
  }

  /** Подготовить речь вперёд — на заданные в настройках минуты. */
  function prefetch(from) {
    if (!provider.prepare) return;
    const opts = options();
    const budget = bufferBudget(getSetting('ttsBufferMinutes'), opts.rate);
    const texts = [];
    let chars = 0;
    for (let i = from; i < sentences.length && i <= until && chars < budget; i += 1) {
      if (!isSpeakable(sentences[i])) continue;
      texts.push(sentences[i]);
      chars += sentences[i].length;
    }
    buffer = prepareAhead(provider, texts, opts);
  }

  function waitForVoice() {
    clearTimeout(busyTimer);
    if (!provider.neural) return;
    if (!provider.isVoiceReady(getSetting('ttsVoiceUri'))) {
      status(provider.id === 'tera' ? 'Загружаю TeraTTS в память — это до полуминуты…' : 'Загружаю нейроголос…', { busy: true });
    } else {
      busyTimer = setTimeout(() => status('Нейроголос готовит фразу…', { busy: true }), BUSY_DELAY_MS);
    }
  }

  async function loop() {
    const mine = (generation += 1);
    setState('speaking');
    try {
      while (state !== 'idle' && mine === generation) {
        if (index >= sentences.length || index > until) {
          finish('Прочитано');
          return;
        }
        const text = sentences[index];
        if (!isSpeakable(text)) {
          index += 1;
          continue;
        }
        const current = index;
        hooks.onSentence?.(current);
        waitForVoice();
        const opts = options();
        const speaking = provider.speak(text, {
          ...opts,
          onStart: () => {
            clearTimeout(busyTimer);
            status(`Предложение ${current + 1} из ${sentences.length}`);
          },
          onBoundary: (event) => hooks.onWord?.(current, event.charIndex, event.charLength),
        });
        prefetch(current + 1);
        const result = await speaking;
        clearTimeout(busyTimer);
        if (mine !== generation || state === 'idle' || result === 'cancelled') return;
        index = current + 1;
      }
    } catch (error) {
      console.error('Ошибка озвучки', error);
      finish(`Озвучка: ${error.message || error}`);
    }
  }

  function finish(message = '') {
    clearTimeout(busyTimer);
    generation += 1;
    if (state === 'paused') provider.resume();
    provider.cancel();
    buffer = [];
    setState('idle');
    status(message);
  }

  /** Перескок: прерываем фразу и читаем с нового места. */
  function restartAt(target) {
    index = Math.max(0, Math.min(sentences.length - 1, target));
    if (state === 'paused') provider.resume();
    provider.cancel();
    loop();
  }

  return {
    /** Новый текст: прежнее чтение останавливается. */
    load(list) {
      if (state !== 'idle') finish();
      sentences = list;
      index = 0;
      until = Infinity;
    },
    /** Читать с предложения from; до to включительно (выделенный кусок) или до конца. */
    start(from = index, to = Infinity) {
      if (!sentences.length) return;
      until = to;
      provider.unlock?.();
      if (state === 'idle') {
        index = Math.max(0, Math.min(sentences.length - 1, from));
        loop();
      } else restartAt(from);
    },
    toggle() {
      if (state === 'speaking') this.pause();
      else if (state === 'paused') this.resume();
      else this.start(index >= sentences.length ? 0 : index);
    },
    pause() {
      if (state !== 'speaking') return;
      clearTimeout(busyTimer);
      provider.pause();
      setState('paused');
      status('Пауза');
    },
    resume() {
      if (state !== 'paused') return;
      provider.resume();
      setState('speaking');
      status(`Предложение ${index + 1} из ${sentences.length}`);
    },
    stop: () => finish(''),
    next() {
      if (state === 'idle') index = Math.min(sentences.length - 1, index + 1);
      else restartAt(index + 1);
    },
    previous() {
      if (state === 'idle') index = Math.max(0, index - 1);
      else restartAt(index - 1);
    },
    /** Сменили голос — дальше говорит его движок. */
    switchProvider() {
      const next = engines.pick();
      if (next === provider) return;
      const resumeAt = state === 'idle' ? null : index;
      if (state !== 'idle') finish();
      provider = next;
      if (resumeAt !== null) this.start(resumeAt, until);
    },
    /** Громкость — сразу у нейроголоса; у голоса системы — со следующей фразы. */
    setVolume(volume) {
      provider.setVolume?.(volume);
      return Boolean(provider.setVolume);
    },
    /**
     * Скорость поменяли. Нейроголос — сразу, посреди фразы (ускоряет
     * проигрыватель); системный голос перечитывает фразу.
     */
    rateChanged() {
      if (state === 'idle') return;
      if (provider.neural) {
        provider.setRate?.(getSetting('ttsRate'));
        prefetch(index + 1);
      } else restartAt(index);
    },
    /** Пока тянут ползунок — нейроголос сразу на новой скорости. */
    previewRate() {
      if (state !== 'idle' && provider.neural) provider.setRate?.(getSetting('ttsRate'));
    },
    get provider() {
      return provider;
    },
    get state() {
      return state;
    },
    get index() {
      return index;
    },
    /** Сколько секунд речи впереди уже готово. */
    bufferedSeconds: () => bufferedSeconds(buffer),
    /** Браузер не дал звуку начаться без нажатия. */
    get audioBlocked() {
      return Boolean(provider.audioBlocked);
    },
  };
}
