// Память читалки: место чтения, масштаб, обрезка полей и закладки для
// каждого документа, плюс сам файл для списка недавних.

import { get as getSetting } from './settings.js';
import * as library from './library.js';
import { pageOffsetRatio } from './visible-text.js';

const SAVE_DELAY_MS = 1200;

export function createReadingState(app) {
  let record = null;
  let saveTimer = 0;
  let restoring = false;
  let pagesReady = false;
  let pending = null; // состояние ждёт, пока страницы получат размеры
  const listeners = new Set();

  function notify() {
    for (const listener of listeners) listener(record);
  }

  /** Ключ считаем по началу файла: для локального файла хватит первого мегабайта. */
  async function identify(source) {
    if (source.id) return source.id;
    if (source.kind === 'file' && source.file) {
      const head = new Uint8Array(await source.file.slice(0, 1024 * 1024).arrayBuffer());
      return library.computeDocumentId(head, source.file.size);
    }
    const bytes = await app.loader.getBytes();
    if (!bytes) return null;
    return library.computeDocumentId(bytes, source.size ?? bytes.byteLength);
  }

  async function blobFor(source) {
    if (source.kind === 'file' && source.file) return source.file;
    const bytes = await app.loader.getBytes();
    return bytes ? new Blob([bytes], { type: 'application/pdf' }) : null;
  }

  async function rememberFile(id, source) {
    if (!getSetting('storeFilesInLibrary')) return;
    const limit = getSetting('maxStoredFileMb') * 1024 * 1024;
    if ((source.size ?? 0) > limit) return;
    if (await library.hasFile(id)) return;

    const blob = await blobFor(source);
    if (!blob || blob.size > limit) return;
    await library.saveFile(id, blob);
    // Держим библиотеку в разумных пределах: лимит на файл × 10.
    await library.pruneFiles(limit * 10);
  }

  function currentState() {
    // В режиме «только текст» вид PDF стоит на месте входа — место берём из текста.
    const reflow = app.reflow?.active ? app.reflow.position() : null;
    const { pageNumber, offsetRatio } = reflow ?? pageOffsetRatio(app);
    return {
      pageNumber,
      offsetRatio,
      viewMode: reflow ? 'reflow' : 'pdf',
      sentenceIndex: reflow?.sentenceIndex ?? null,
      zoom: app.zoomIntent,
      left: Math.round(app.container.scrollLeft),
      viewLock: app.viewLock?.state ?? null,
      cropEnabled: app.appearance?.crop.enabled ?? false,
      cropBox: app.appearance?.crop.box,
      tts: app.tts?.position,
      updatedAt: Date.now(),
    };
  }

  function scheduleSave() {
    if (!record || restoring || !getSetting('rememberPosition')) return;
    clearTimeout(saveTimer);
    saveTimer = setTimeout(save, SAVE_DELAY_MS);
  }

  async function save() {
    if (!record) return;
    clearTimeout(saveTimer);
    record = { ...record, state: currentState() };
    await library.putDocument(record).catch((error) => console.warn('Не удалось сохранить место чтения', error));
  }

  /** Прокрутка к сохранённому месту: страница плюс доля её высоты. */
  function scrollToSaved(state) {
    app.pdfViewer.scrollPageIntoView({ pageNumber: state.pageNumber });
    const div = app.pdfViewer.getPageView(state.pageNumber - 1)?.div;
    if (div && state.offsetRatio) app.container.scrollTop += state.offsetRatio * div.clientHeight;
    return Math.round(app.container.scrollTop);
  }

  /**
   * Восстановление вида. Сразу после pagesinit прокрутку возвращать нельзя:
   * pdf.js там доводит вид до начальной позиции и затирает наши изменения,
   * поэтому ждём pagesloaded и на всякий случай проверяем результат ещё раз.
   */
  function restore(state) {
    restoring = true;
    try {
      app.setZoom(state?.zoom || getSetting('defaultZoom'), { force: true });
      app.appearance?.restore(state);
      app.viewLock?.restore(state?.viewLock);

      if (!state?.pageNumber || !getSetting('rememberPosition')) return;

      const expected = scrollToSaved(state);
      if (Number.isFinite(state.left) && !state.viewLock) app.container.scrollLeft = state.left;
      if (state.tts?.pageNumber) app.tts?.setPosition(state.tts);
      if (state.viewMode === 'reflow') {
        app.reflow?.enter({ pageNumber: state.pageNumber, sentenceIndex: state.sentenceIndex ?? 0 });
      }

      // Масштаб применяется асинхронно и может сдвинуть вид — сверяемся.
      setTimeout(() => {
        if (Math.abs(app.container.scrollTop - expected) > 8) scrollToSaved(state);
      }, 250);
    } finally {
      setTimeout(() => {
        restoring = false;
      }, 700);
    }
  }

  app.eventBus.on('documentopened', async ({ documentSource, title }) => {
    record = null;
    try {
      const id = await identify(documentSource);
      if (!id) return;
      const existing = await library.getDocument(id);
      record = {
        id,
        name: documentSource.name,
        title,
        size: documentSource.size ?? existing?.size,
        url: documentSource.kind === 'url' ? documentSource.url : existing?.url,
        numPages: app.loader.pdfDocument?.numPages,
        addedAt: existing?.addedAt || Date.now(),
        openedAt: Date.now(),
        bookmarks: existing?.bookmarks || [],
        state: existing?.state || null,
      };
      await library.putDocument(record);
      applyState(record.state);
      notify();
      await rememberFile(id, { ...documentSource, size: documentSource.size ?? record.size });
    } catch (error) {
      console.warn('Библиотека недоступна', error);
      applyState(null); // без сохранённого состояния берём настройки по умолчанию
    }
  });

  // Восстанавливать вид можно только когда страницы размещены и pdf.js
  // закончил собственную установку начальной позиции.
  app.eventBus.on('pagesloaded', () => {
    pagesReady = true;
    if (pending !== null) {
      const { state } = pending;
      pending = null;
      restore(state);
    }
  });

  app.eventBus.on('documentopened', () => {
    pagesReady = false;
    pending = null;
  });

  function applyState(state) {
    if (pagesReady) restore(state);
    else pending = { state };
  }

  app.eventBus.on('pagechanging', scheduleSave);
  app.eventBus.on('scalechanging', scheduleSave);
  app.viewLock?.onChange(() => scheduleSave());
  app.container.addEventListener('scroll', scheduleSave, { passive: true });
  document.getElementById('reflowContainer').addEventListener('scroll', scheduleSave, { passive: true });
  app.eventBus.on('viewmodechanged', scheduleSave);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') save();
  });
  window.addEventListener('pagehide', () => save());

  return {
    save,
    scheduleSave,
    get record() {
      return record;
    },
    get documentId() {
      return record?.id || null;
    },
    /** Изменение полей записи мимо состояния чтения — например, закладок. */
    async patch(patch, { silent = false } = {}) {
      if (!record) return null;
      record = { ...record, ...patch };
      await library.putDocument(record);
      if (!silent) notify();
      return record;
    },
    onChange(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
