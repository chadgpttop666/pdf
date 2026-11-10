// Локальная библиотека: место чтения, закладки, сами файлы недавних
// документов, статистика чтения по дням, скачанные нейроголоса,
// распознанный текст сканов, голосовые заметки, правки на страницах (текст,
// рисунки, картинки) и сохранённые подписи. Всё лежит в IndexedDB браузера и
// никуда не отправляется.

import { emptyDay, mergeDays } from './stats-math.js';

const DB_NAME = 'pdf-reader';
const DB_VERSION = 6;
const DOCUMENTS = 'documents';
const FILES = 'files';
const STATS = 'stats';
const VOICES = 'voices';
const OCR = 'ocr';
const RECORDINGS = 'recordings';
const EDITS = 'edits';
const SIGNATURES = 'signatures';

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
      // Версия 3: нейроголоса Piper — модель (Blob) и её описание.
      if (!db.objectStoreNames.contains(VOICES)) {
        db.createObjectStore(VOICES, { keyPath: 'id' });
      }
      // Версия 4: распознанный текст страниц-сканов, ключ «документ#страница».
      if (!db.objectStoreNames.contains(OCR)) {
        db.createObjectStore(OCR, { keyPath: 'key' }).createIndex('docId', 'docId');
      }
      // Версия 5: голосовые заметки к выделениям — запись (Blob) и её документ.
      if (!db.objectStoreNames.contains(RECORDINGS)) {
        db.createObjectStore(RECORDINGS, { keyPath: 'id' }).createIndex('docId', 'docId');
      }
      // Версия 6: правки на страницах — одна запись на документ (ключ — ключ
      // документа) — и сохранённые подписи.
      if (!db.objectStoreNames.contains(EDITS)) {
        db.createObjectStore(EDITS, { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains(SIGNATURES)) {
        db.createObjectStore(SIGNATURES, { keyPath: 'id' });
      }
    };
    request.onsuccess = () => {
      const db = request.result;
      // Другая вкладка обновляет базу до новой версии — уступаем ей.
      db.onversionchange = () => {
        db.close();
        dbPromise = null;
      };
      resolve(db);
    };
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

/**
 * Изменить запись документа по её текущему виду в базе, одной транзакцией:
 * change(запись) → поля, которые заменить. Так две вкладки с одной книгой не
 * затирают изменения друг друга (выделение из одной вкладки не пропадёт,
 * когда другая сохранит свою копию).
 * @returns запись после изменения
 */
export async function mutateDocument(id, change) {
  return transaction(DOCUMENTS, 'readwrite', async (store) => {
    const existing = (await request(store.get(id))) || { id };
    const merged = { ...existing, ...change(existing), id };
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

/**
 * @param meta { kind: 'book', name } — в библиотеке сама книга FB2/EPUB, а не PDF
 */
export async function saveFile(id, blob, meta = {}) {
  return transaction(FILES, 'readwrite', (store) =>
    request(store.put({ ...meta, id, blob, size: blob.size, storedAt: Date.now() }))
  );
}

export async function loadFile(id) {
  return (await loadFileEntry(id))?.blob || null;
}

/** Файл из библиотеки с пометками: { blob, kind?, name? } или null. */
export async function loadFileEntry(id) {
  return (await transaction(FILES, 'readonly', (store) => request(store.get(id)))) ?? null;
}

export async function deleteDocument(id) {
  return transaction([DOCUMENTS, FILES, OCR, RECORDINGS, EDITS], 'readwrite', async (documents, files, ocr, recordings, edits) => {
    await request(documents.delete(id));
    await request(files.delete(id));
    await request(edits.delete(id));
    for (const key of await request(ocr.index('docId').getAllKeys(id))) await request(ocr.delete(key));
    for (const key of await request(recordings.index('docId').getAllKeys(id))) await request(recordings.delete(key));
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
  return transaction([DOCUMENTS, FILES, OCR, RECORDINGS, EDITS], 'readwrite', async (documents, files, ocr, recordings, edits) => {
    await request(edits.clear());
    await request(documents.clear());
    await request(files.clear());
    await request(ocr.clear());
    await request(recordings.clear());
  });
}

/** Голосовая заметка: { id, docId, blob, seconds, createdAt }. */
export async function putRecording(record) {
  return transaction(RECORDINGS, 'readwrite', (store) => request(store.put(record)));
}

export async function getRecording(id) {
  return transaction(RECORDINGS, 'readonly', (store) => request(store.get(id)));
}

export async function deleteRecording(id) {
  return transaction(RECORDINGS, 'readwrite', (store) => request(store.delete(id)));
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

/** Скачанные голоса без самих моделей — для списков. */
export async function listVoices() {
  const all = await transaction(VOICES, 'readonly', (store) => request(store.getAll()));
  return all.map(({ model, ...info }) => info);
}

export async function getVoice(id) {
  return transaction(VOICES, 'readonly', (store) => request(store.get(id)));
}

export async function putVoice(record) {
  return transaction(VOICES, 'readwrite', (store) => request(store.put(record)));
}

export async function deleteVoice(id) {
  return transaction(VOICES, 'readwrite', (store) => request(store.delete(id)));
}

/** Распознанные страницы документа. */
export async function listOcr(docId) {
  return transaction(OCR, 'readonly', (store) => request(store.index('docId').getAll(docId)));
}

export async function putOcr(record) {
  return transaction(OCR, 'readwrite', (store) => request(store.put({ ...record, key: `${record.docId}#${record.pageNumber}` })));
}

/**
 * Правки на страницах документа (editing/editing.js): список правок pdf.js
 * в виде для копирования — текст, рисунки, картинки (data: URL).
 * @returns {Promise<{ id, items: object[], updatedAt } | undefined>}
 */
export async function getEdits(docId) {
  return transaction(EDITS, 'readonly', (store) => request(store.get(docId)));
}

/** Записать правки документа; пустой список — удалить запись. */
export async function putEdits(docId, items) {
  return transaction(EDITS, 'readwrite', (store) =>
    request(items.length ? store.put({ id: docId, items, updatedAt: Date.now() }) : store.delete(docId))
  );
}

/** Сохранённые подписи: { id, blob (PNG), createdAt }. */
export async function listSignatures() {
  const all = await transaction(SIGNATURES, 'readonly', (store) => request(store.getAll()));
  return all.sort((a, b) => b.createdAt - a.createdAt);
}

export async function putSignature(record) {
  return transaction(SIGNATURES, 'readwrite', (store) => request(store.put(record)));
}

export async function deleteSignature(id) {
  return transaction(SIGNATURES, 'readwrite', (store) => request(store.delete(id)));
}
