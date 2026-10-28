// Локальная библиотека: место чтения, закладки, сами файлы недавних
// документов и статистика чтения по дням. Всё лежит в IndexedDB браузера и
// никуда не отправляется.

import { emptyDay, mergeDays } from './stats-math.js';

const DB_NAME = 'pdf-reader';
const DB_VERSION = 2;
const DOCUMENTS = 'documents';
const FILES = 'files';
const STATS = 'stats';

let dbPromise = null;

function openDb() {
  dbPromise ||= new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(DOCUMENTS)) {
        const store = db.createObjectStore(DOCUMENTS, { keyPath: 'id' });
        store.createIndex('openedAt', 'openedAt');
      }
      if (!db.objectStoreNames.contains(FILES)) {
        db.createObjectStore(FILES, { keyPath: 'id' });
      }
      // Версия 2: статистика, одна запись на день («2026-10-28»).
      if (!db.objectStoreNames.contains(STATS)) {
        db.createObjectStore(STATS, { keyPath: 'day' });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  return dbPromise;
}

async function transaction(storeNames, mode, action) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeNames, mode);
    let result;
    tx.oncomplete = () => resolve(result);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
    const stores = [].concat(storeNames).map((name) => tx.objectStore(name));
    Promise.resolve(action(...stores))
      .then((value) => {
        result = value;
      })
      .catch(reject);
  });
}

const request = (req) =>
  new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });

/**
 * Ключ документа: хеш начала файла вместе с размером. Имя брать нельзя —
 * один и тот же учебник у пользователя часто лежит под разными именами,
 * а место чтения должно быть общим.
 */
export async function computeDocumentId(bytes, size = bytes.byteLength) {
  const head = bytes.subarray ? bytes.subarray(0, 1024 * 1024) : new Uint8Array(bytes).subarray(0, 1024 * 1024);
  const digest = await crypto.subtle.digest('SHA-256', head);
  const hex = [...new Uint8Array(digest).slice(0, 8)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  return `${hex}-${size}`;
}

export async function getDocument(id) {
  return transaction(DOCUMENTS, 'readonly', (store) => request(store.get(id)));
}

export async function putDocument(record) {
  return transaction(DOCUMENTS, 'readwrite', (store) => request(store.put(record)));
}

export async function updateDocument(id, patch) {
  return transaction(DOCUMENTS, 'readwrite', async (store) => {
    const existing = (await request(store.get(id))) || { id };
    const merged = { ...existing, ...patch, state: { ...existing.state, ...patch.state } };
    await request(store.put(merged));
    return merged;
  });
}

export async function listRecent(limit = 20) {
  return transaction(DOCUMENTS, 'readonly', async (store) => {
    const all = await request(store.getAll());
    return all.sort((a, b) => (b.openedAt || 0) - (a.openedAt || 0)).slice(0, limit);
  });
}

export async function saveFile(id, blob) {
  return transaction(FILES, 'readwrite', (store) =>
    request(store.put({ id, blob, size: blob.size, storedAt: Date.now() }))
  );
}

export async function loadFile(id) {
  const record = await transaction(FILES, 'readonly', (store) => request(store.get(id)));
  return record?.blob || null;
}

export async function deleteDocument(id) {
  return transaction([DOCUMENTS, FILES], 'readwrite', async (documents, files) => {
    await request(documents.delete(id));
    await request(files.delete(id));
  });
}

export async function hasFile(id) {
  const record = await transaction(FILES, 'readonly', (store) => request(store.get(id)));
  return Boolean(record);
}

/** Общий размер хранилища — показываем в настройках, чтобы база не росла молча. */
export async function storageUsage() {
  return transaction(FILES, 'readonly', async (store) => {
    const all = await request(store.getAll());
    return { count: all.length, bytes: all.reduce((sum, item) => sum + (item.size || 0), 0) };
  });
}

/** Вытесняем самые старые файлы, когда библиотека перерастает лимит. */
export async function pruneFiles(maxBytes) {
  const files = await transaction(FILES, 'readonly', (store) => request(store.getAll()));
  let total = files.reduce((sum, file) => sum + (file.size || 0), 0);
  if (total <= maxBytes) return 0;

  const oldestFirst = files.sort((a, b) => (a.storedAt || 0) - (b.storedAt || 0));
  let removed = 0;
  for (const file of oldestFirst) {
    if (total <= maxBytes) break;
    await transaction(FILES, 'readwrite', (store) => request(store.delete(file.id)));
    total -= file.size || 0;
    removed += 1;
  }
  return removed;
}

export async function clearLibrary() {
  return transaction([DOCUMENTS, FILES], 'readwrite', async (documents, files) => {
    await request(documents.clear());
    await request(files.clear());
  });
}

/** Статистика за все дни — записей немного, по одной на день чтения. */
export async function listStatsDays() {
  return transaction(STATS, 'readonly', (store) => request(store.getAll()));
}

/**
 * Прибавить приращение к записи дня. Чтение и запись — в одной транзакции,
 * поэтому две открытые вкладки не затирают счёт друг друга.
 */
export async function addStatsDay(delta) {
  return transaction(STATS, 'readwrite', async (store) => {
    const existing = (await request(store.get(delta.day))) || emptyDay(delta.day);
    const merged = mergeDays(existing, delta);
    await request(store.put(merged));
    return merged;
  });
}

export async function clearStats() {
  return transaction(STATS, 'readwrite', (store) => request(store.clear()));
}
