// Движки озвучки и список голосов — общие для читалки PDF и окна озвучки
// выделенного текста. Какой движок говорит, решает выбранный голос: id
// нейроголосов начинаются с «tera:» или «piper:», остальное — голоса системы
// (или внешнего движка по HTTP).

import { el, formatBytes } from '../dom.js';
import { get as getSetting } from '../settings.js';
import { createHttpProvider } from './http-provider.js';
import { PIPER_PREFIX, createPiperProvider } from './piper-provider.js';
import { TERA_PREFIX, createTeraProvider } from './tera-provider.js';
import { createWebSpeechProvider } from './web-speech.js';

export function createEngines() {
  const piper = createPiperProvider();
  const tera = createTeraProvider({
    threads: () => getSetting('teraThreads'),
    rate: () => getSetting('ttsRate'),
    quality: () => getSetting('teraQuality'),
    useHelper: () => getSetting('teraUseHelper'),
  });
  let system = null;

  const systemEngine = () =>
    getSetting('ttsProvider') === 'http' ? createHttpProvider({ url: getSetting('ttsHttpUrl') }) : createWebSpeechProvider();

  const engines = {
    piper,
    tera,
    /** Голоса системы или внешний движок — по настройке. */
    get system() {
      system ??= systemEngine();
      return system;
    },
    /** Настройки движка системы поменялись — создать заново. */
    resetSystem() {
      system = systemEngine();
      return system;
    },
    /** Нейроголос, которому принадлежит голос, или null — голос системы. */
    neuralFor(voiceId = getSetting('ttsVoiceUri')) {
      const id = String(voiceId || '');
      if (id.startsWith(TERA_PREFIX)) return tera.available ? tera : null;
      if (id.startsWith(PIPER_PREFIX)) return piper.available ? piper : null;
      return null;
    },
    /** Движок выбранного голоса. */
    pick(voiceId) {
      return engines.neuralFor(voiceId) ?? engines.system;
    },
    /** Все голоса: системы, TeraTTS, Piper. */
    async voices() {
      const [systemVoices, best, neural] = await Promise.all([
        engines.system.voices(),
        tera.available ? tera.voices() : [],
        piper.available ? piper.voices() : [],
      ]);
      return { system: systemVoices, best, neural };
    },
  };
  return engines;
}

/**
 * Заполнить выпадающий список голосов: TeraTTS (лучшие), Piper, системные.
 * Голоса языка документа — первыми.
 * @returns {{ chosen: object|null, empty: boolean }} chosen — голос, который
 *   стоит выбрать (сохранённый, если он ещё доступен); empty — системных нет
 */
export function fillVoiceSelect(select, { system, best, neural }, { documentLang = 'ru', stored = '' } = {}) {
  select.replaceChildren();
  const rank = (voice) => ((voice.lang || '').toLowerCase().startsWith(documentLang) ? 0 : 1);
  const sortedSystem = [...system].sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name));
  const sortedNeural = [...neural].sort((a, b) => rank(a) - rank(b));

  // Скачать TeraTTS — один пакет на все его голоса: предлагаем первый.
  const offered = best.some((voice) => voice.installed) ? best : best.slice(0, 1);
  if (offered.length) {
    const group = el('optgroup', { label: 'Нейроголоса TeraTTS — лучшее качество, без интернета' });
    for (const voice of offered) {
      group.append(el('option', { value: voice.id }, voice.installed ? voice.name : `TeraTTS — скачать ≈${voice.sizeMb} МБ`));
    }
    select.append(group);
  }
  if (sortedNeural.length) {
    const group = el('optgroup', { label: 'Нейроголоса Piper — работают без интернета' });
    for (const voice of sortedNeural) {
      group.append(el('option', { value: voice.id }, voice.installed ? voice.name : `${voice.name} — скачать ≈${voice.sizeMb} МБ`));
    }
    select.append(group);
  }
  if (sortedSystem.length) {
    const group = el('optgroup', { label: getSetting('ttsProvider') === 'http' ? 'Внешний движок' : 'Голоса системы' });
    for (const voice of sortedSystem) {
      group.append(el('option', { value: voice.id }, `${voice.name}${voice.lang ? ` (${voice.lang})` : ''}`));
    }
    select.append(group);
  }
  if (!select.options.length) {
    select.append(el('option', { value: '' }, 'голосов не найдено'));
    return { chosen: null, empty: true };
  }

  const usable = [...sortedSystem, ...best.filter((voice) => voice.installed), ...sortedNeural.filter((voice) => voice.installed)];
  const chosen = usable.find((voice) => voice.id === stored) || usable[0] || null;
  if (chosen) select.value = chosen.id;
  return { chosen, empty: !sortedSystem.length };
}

/**
 * Нейроголос ещё не скачан: спросить и скачать с HuggingFace, показывая
 * прогресс в строке состояния.
 * @returns {Promise<boolean>} голос скачан
 */
export async function downloadWithConsent(engines, voiceId, setStatus) {
  const engine = engines.neuralFor(voiceId);
  const voice = (await engine?.voices())?.find((item) => item.id === voiceId);
  if (!voice) return false;
  const question =
    engine === engines.tera
      ? `Скачать голоса TeraTTS (≈${voice.sizeMb} МБ) с HuggingFace?\n\n` +
        'Это нужно один раз: четыре голоса и словари ударений сохранятся в браузере и дальше будут работать без интернета. ' +
        'Во время чтения TeraTTS занимает 1,5–2 ГБ памяти; с ускорителем (Настройки → Озвучка) — меньше и в несколько раз быстрее.'
      : `Скачать нейроголос «${voice.name}» (≈${voice.sizeMb} МБ) с HuggingFace?\n\n` +
        'Это нужно один раз: голос сохранится в браузере и дальше будет работать без интернета.';
  if (!window.confirm(question)) return false;
  try {
    await engine.downloadVoice(voiceId, (loaded, total, stage) => {
      setStatus(
        stage === 'index'
          ? 'Готовлю словарь ударений — это меньше минуты…'
          : `Скачиваю голос «${voice.name}»: ${formatBytes(loaded)} из ${formatBytes(total)}`
      );
    });
  } catch (error) {
    setStatus(`Голос не скачался: ${error.message}. Его можно загрузить из файла: Настройки → Нейроголоса.`);
    return false;
  }
  setStatus(`Голос «${voice.name}» скачан и работает без интернета`);
  return true;
}
