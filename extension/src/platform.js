// Единственное место, где мы говорим с API расширения. Вьюер должен так же
// работать открытым по http (режим отладки), поэтому всё под feature detection.

export const extensionApi = typeof browser !== 'undefined' && browser?.runtime?.id ? browser : null;

/** Путь внутри расширения → абсолютный URL, одинаково в moz-extension и в dev. */
export function assetUrl(relativeToSrc) {
  return new URL(relativeToSrc, import.meta.url).href;
}

const memoryFallback = new Map();

export const storage = {
  async get(keys) {
    if (extensionApi?.storage?.local) return extensionApi.storage.local.get(keys);
    const result = {};
    for (const key of [].concat(keys)) {
      const raw = localStorage.getItem(key) ?? (memoryFallback.get(key) || null);
      if (raw != null) {
        try {
          result[key] = JSON.parse(raw);
        } catch {
          /* повреждённое значение просто игнорируем */
        }
      }
    }
    return result;
  },
  async set(items) {
    if (extensionApi?.storage?.local) return extensionApi.storage.local.set(items);
    for (const [key, value] of Object.entries(items)) {
      const raw = JSON.stringify(value);
      try {
        localStorage.setItem(key, raw);
      } catch {
        memoryFallback.set(key, raw);
      }
    }
  },
};

/** Не давать экрану гаснуть, пока идёт автопрокрутка или озвучка. */
export function createWakeLock() {
  let sentinel = null;
  const supported = 'wakeLock' in navigator;
  return {
    supported,
    async request() {
      if (!supported || sentinel) return;
      try {
        sentinel = await navigator.wakeLock.request('screen');
        sentinel.addEventListener('release', () => {
          sentinel = null;
        });
      } catch {
        sentinel = null;
      }
    },
    async release() {
      try {
        await sentinel?.release();
      } catch {
        /* уже отпущен */
      }
      sentinel = null;
    },
  };
}
