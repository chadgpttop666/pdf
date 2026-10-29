// Связь с ускорителем — программой-помощником (native/ в репозитории):
// синтез TeraTTS вне браузера, в несколько раз быстрее WebAssembly. Firefox
// запускает её сам (native messaging), говорим сообщениями JSON.
//
// Помощник делает только тяжёлое — модели речи. Текст в номера символов,
// ударения и обрезку тишины по-прежнему делает расширение. Модели помощник
// получает от расширения — те, что уже скачаны в браузер, — один раз.

export const HELPER_NAME = 'pdf_reader_tts';
export const HELPER_PROTOCOL = 1;
/** Части пакета TeraTTS (tera-pack.js), которые нужны помощнику. */
export const HELPER_MODELS = ['textEncoder', 'duration', 'sampler', 'vocoder'];
// Куски при передаче файлов: от расширения к программе можно и больше, но так
// памяти нужно немного, а прогресс плавный.
const CHUNK = 4 * 1024 * 1024;

const toBase64 = (bytes) => {
  if (bytes.toBase64) return bytes.toBase64();
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
};

const fromBase64 = (text) => {
  if (Uint8Array.fromBase64) return Uint8Array.fromBase64(text);
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
};

const floatBytes = (values) => new Uint8Array(values.buffer, values.byteOffset, values.byteLength);

/**
 * Клиент поверх порта: Port из runtime.connectNative или такой же объект
 * (postMessage, onMessage, onDisconnect, disconnect) — в проверках вне браузера.
 */
export function createHelperClient(port) {
  const waiting = new Map(); // id → { resolve, reject, chunks }
  const closeListeners = [];
  let seq = 0;
  let closed = null;

  port.onMessage.addListener((message) => {
    const entry = waiting.get(message?.id);
    if (!entry) return;
    if (message.type === 'error') {
      waiting.delete(message.id);
      entry.reject(Object.assign(new Error(message.message), { dropped: Boolean(message.dropped) }));
      return;
    }
    if (message.type === 'audio') {
      entry.chunks.push(fromBase64(message.data));
      if (!message.last) return;
      waiting.delete(message.id);
      const bytes = new Uint8Array(message.samples * 4);
      let offset = 0;
      for (const chunk of entry.chunks) {
        bytes.set(chunk, offset);
        offset += chunk.length;
      }
      entry.resolve({ pcm: new Float32Array(bytes.buffer), sampleRate: message.sampleRate });
      return;
    }
    waiting.delete(message.id);
    entry.resolve(message);
  });

  port.onDisconnect.addListener((source) => {
    closed = new Error(source?.error?.message || port.error?.message || 'Ускоритель отключился');
    for (const [id, entry] of waiting) {
      waiting.delete(id);
      entry.reject(closed);
    }
    for (const listener of closeListeners) listener(closed);
  });

  function request(message) {
    if (closed) return Promise.reject(closed);
    const id = (seq += 1);
    return new Promise((resolve, reject) => {
      waiting.set(id, { resolve, reject, chunks: [] });
      try {
        port.postMessage({ ...message, id });
      } catch (error) {
        waiting.delete(id);
        reject(error);
      }
    });
  }

  /** Файл кусками: каждый следующий — после подтверждения предыдущего. */
  async function upload(type, fields, blob, onProgress) {
    let last = null;
    for (let offset = 0; offset < blob.size || offset === 0; offset += CHUNK) {
      const bytes = new Uint8Array(await blob.slice(offset, offset + CHUNK).arrayBuffer());
      const end = offset + bytes.length >= blob.size;
      last = await request({ type, ...fields, offset, size: blob.size, data: toBase64(bytes), last: end });
      onProgress?.(offset + bytes.length, blob.size);
      if (end) break;
    }
    return last;
  }

  return {
    hello: () => request({ type: 'hello' }),
    /** Загрузить модели заранее — первая фраза пойдёт без ожидания. */
    load: () => request({ type: 'load' }),
    unload: () => request({ type: 'unload' }),
    /** Отмена: фразы с меньшей эпохой помощник пропускает. */
    setEpoch(epoch) {
      if (!closed) port.postMessage({ type: 'epoch', epoch });
    },
    /**
     * Звук фразы, уже переведённой в номера символов (tera-text.js, encodeText).
     * @returns {Promise<{ pcm: Float32Array, sampleRate: number }>}
     */
    synth({ ids, plain, ttl, dp, maxSeconds = null, durationScale = 1, epoch = 0 }) {
      return request({
        type: 'synth',
        ids: Array.from(ids, Number),
        plain: Array.from(plain, Number),
        ttl: toBase64(floatBytes(ttl)),
        dp: toBase64(floatBytes(dp)),
        maxSeconds,
        durationScale,
        epoch,
      });
    },
    sendFile: (name, blob, onProgress) => upload('file', { name }, blob, onProgress),
    /** Новая версия помощника: он поставит её себе сам. */
    update: (blob, sha256, onProgress) => upload('update', { sha256 }, blob, onProgress),
    uninstall: () => request({ type: 'uninstall' }),
    close() {
      if (closed) return;
      closed = new Error('Ускоритель отключён');
      port.disconnect();
      for (const [id, entry] of waiting) {
        waiting.delete(id);
        entry.reject(closed);
      }
    },
    onClose(listener) {
      closeListeners.push(listener);
    },
    get closed() {
      return closed;
    },
  };
}

/**
 * Каких моделей у помощника нет (или они другие) — по размерам.
 * @param files размеры у помощника (ответ hello)
 * @param sizes размеры частей пакета в браузере
 */
export function missingModels(files, sizes) {
  return HELPER_MODELS.filter((name) => (files?.[name] ?? -1) !== sizes[name]);
}

/** Передать помощнику недостающие модели. */
export async function syncModels(client, files, blobs, onProgress) {
  const missing = missingModels(
    files,
    Object.fromEntries(HELPER_MODELS.map((name) => [name, blobs[name].size]))
  );
  const total = missing.reduce((sum, name) => sum + blobs[name].size, 0);
  let done = 0;
  for (const name of missing) {
    await client.sendFile(name, blobs[name], (loaded) => onProgress?.(done + loaded, total));
    done += blobs[name].size;
  }
  return missing;
}

/** Сравнить версии вида 1.2.3. */
export function compareVersions(a, b) {
  const pa = String(a).split('.').map(Number);
  const pb = String(b).split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
    const diff = (pa[i] || 0) - (pb[i] || 0);
    if (diff) return Math.sign(diff);
  }
  return 0;
}

function withTimeout(promise, ms, message) {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => (timer = setTimeout(() => reject(new Error(message)), ms)))]).finally(() =>
    clearTimeout(timer)
  );
}

/**
 * Подключиться к установленному помощнику.
 * @returns {Promise<{ client, hello }|null>} null — нет разрешения или помощник не установлен
 */
export async function connectHelper({ timeout = 8000 } = {}) {
  const runtime = globalThis.browser?.runtime;
  if (typeof runtime?.connectNative !== 'function') return null;
  let port;
  try {
    port = runtime.connectNative(HELPER_NAME);
  } catch {
    return null;
  }
  const client = createHelperClient(port);
  try {
    return { client, hello: await withTimeout(client.hello(), timeout, 'Ускоритель не ответил') };
  } catch {
    client.close();
    return null;
  }
}
