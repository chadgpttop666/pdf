// Прозвучавшие фразы нейроголос держит в памяти ещё немного. Остановили
// чтение и снова нажали «Читать» — оно начинается с начала экрана, на пару
// фраз раньше места остановки, — звук этих фраз уже готов, синтезировать
// заново не нужно. Держим последние фразы, но не дольше нескольких минут:
// звук занимает память (минута речи — около 10 МБ).

export const RECENT_KEEP_MS = 10 * 60 * 1000;
export const RECENT_MAX = 30;

/**
 * @param drop (key) => отпустить заготовку: из «недавних» она ушла
 */
export function createRecent(drop, { keepMs = RECENT_KEEP_MS, max = RECENT_MAX, now = () => Date.now() } = {}) {
  const spoken = new Map(); // ключ → когда прозвучала (по порядку)

  function trim() {
    const time = now();
    for (const [key, at] of spoken) {
      if (spoken.size <= max && time - at < keepMs) break;
      spoken.delete(key);
      drop(key);
    }
  }

  return {
    /** Фраза прозвучала. */
    add(key) {
      spoken.delete(key);
      spoken.set(key, now());
      trim();
    },
    /** Какие ещё держим. */
    keys() {
      trim();
      return [...spoken.keys()];
    },
    has(key) {
      trim();
      return spoken.has(key);
    },
    delete(key) {
      spoken.delete(key);
    },
    clear() {
      spoken.clear();
    },
  };
}
