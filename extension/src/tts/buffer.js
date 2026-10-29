// Запас подготовленной речи — как подгрузка видео: нейроголос синтезирует
// фразы вперёд, пока звучит текущая и на паузе. Размер запаса — минуты речи
// из настроек; ненужные заготовки (читатель перескочил, сменил скорость)
// провайдер отпускает.

// Голос со скоростью 1× произносит примерно столько знаков в минуту (как в stats-math.js).
const SPEECH_CHARS_PER_MINUTE = 900;

/** Сколько знаков текста подготовить вперёд. */
export function bufferBudget(minutes, rate = 1) {
  return (Number(minutes) || 2) * SPEECH_CHARS_PER_MINUTE * (rate || 1);
}

/**
 * Попросить провайдер подготовить фразы по порядку.
 * @returns {{ seconds: number|null, failed: boolean }[]} заготовки; seconds — когда готова
 */
export function prepareAhead(provider, texts, options) {
  const items = [];
  for (const text of texts) {
    const ready = provider.prepare?.(text, options);
    if (!ready) break; // голос ещё не скачан или движок не готовит впрок
    const item = { seconds: null, failed: false };
    ready.then(
      (seconds) => (item.seconds = seconds),
      () => (item.failed = true)
    );
    items.push(item);
  }
  provider.retain?.(texts.slice(0, items.length), options);
  return items;
}

/** Сколько секунд речи впереди готово — подряд, без дыр. */
export function bufferedSeconds(items) {
  let total = 0;
  for (const item of items) {
    if (item.seconds === null || item.failed) break;
    total += item.seconds;
  }
  return total;
}

/** «1:40» — для значка на панели. */
export const formatClock = (seconds) => `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, '0')}`;

/** «1 мин 40 с» — для строки состояния. */
export const formatSpoken = (seconds) => (seconds < 60 ? `${Math.floor(seconds)} с` : `${Math.floor(seconds / 60)} мин ${Math.floor(seconds % 60)} с`);
