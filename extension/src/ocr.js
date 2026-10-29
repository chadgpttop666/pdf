// Распознавание сканов (OCR). Страница без текстового слоя рисуется в
// картинку, tesseract.js находит на ней слова, а слова становятся обычным
// текстом страницы: подменяем getTextContent()/streamTextContent() у объекта
// страницы pdf.js. Поэтому распознанный текст сразу работает везде — в
// выделении, поиске, озвучке, заметках и режиме «только текст».
//
// Движок, ядро WASM и данные русского и английского лежат в расширении,
// по сети ничего не грузится. Результат хранится в библиотеке, второй раз
// страницу распознавать не нужно.

import { el } from './dom.js';
import * as library from './library.js';
import { OCR_STYLES, isTextless, ocrLinesToItems, pickLanguages } from './ocr-math.js';

const TESSERACT_BASE = new URL('../vendor/tesseract/', import.meta.url).href;
// Пока язык документа неизвестен, распознаём двумя языками сразу.
const PROBE_LANGUAGES = ['rus', 'eng'];
const OEM_LSTM_ONLY = 1;
// Около 300 dpi для страницы A4: мельче — хуже точность, крупнее — дольше.
const TARGET_SIDE = 2500;
const MAX_SCALE = 4;
// Движок держит в памяти около 100 МБ — отпускаем его, если он не нужен.
const IDLE_SHUTDOWN_MS = 3 * 60 * 1000;
// Слова неувереннее этого — обычно шум с картинок, а не текст.
const MIN_CONFIDENCE = 40;
// Сколько страниц проверить, чтобы понять, скан ли весь документ.
const SCAN_SAMPLE = 8;
// Версия способа распознавания. Сохранённое прежним способом не подставляем —
// такие страницы распознаются заново: версия 1 теряла английские названия,
// версия 2 оставляла пометки с полей («fo в ТОМ»).
const OCR_FORMAT = 3;

export function createOcr(app) {
  const results = new Map(); // страница → распознанные элементы текста
  const textless = new Map(); // страница → промис «без текста в самом PDF?»
  const pending = new Map(); // страница → промис распознавания
  let docId = null;
  let pdfDocument = null;
  let engineTask = null;
  let idleTimer = 0;
  let batch = null; // распознавание всего документа: { done, total, cancelled }
  let scannedTask = null; // промис «документ — скан?»
  let docLanguages = null; // язык распознавания документа, когда он понятен
  let engineLanguages = PROBE_LANGUAGES.join('+'); // с каким языком сейчас движок
  let exclusive = Promise.resolve(); // распознавания идут строго по одному
  const progressByPage = new Map(); // страница → доля 0…1 для подписи на кнопке

  // ── Движок ───────────────────────────────────────────────────────────

  let recognizingPage = null;

  function engine() {
    clearTimeout(idleTimer);
    if (!engineTask) {
      engineTask = (async () => {
        const Tesseract = (await import('../vendor/tesseract/tesseract.esm.min.js')).default;
        engineLanguages = PROBE_LANGUAGES.join('+');
        return Tesseract.createWorker(PROBE_LANGUAGES, OEM_LSTM_ONLY, {
          workerPath: `${TESSERACT_BASE}worker.min.js`,
          corePath: `${TESSERACT_BASE}tesseract-core-simd-lstm.wasm.js`,
          langPath: `${TESSERACT_BASE}lang`,
          // Воркер из blob: запрещён политикой расширения — грузим файлом.
          workerBlobURL: false,
          cacheMethod: 'none',
          gzip: true,
          logger: ({ status, progress }) => {
            if (recognizingPage && status === 'recognizing text') setProgress(recognizingPage, progress);
          },
        });
      })();
      engineTask.catch(() => {
        engineTask = null;
      });
    }
    return engineTask;
  }

  function scheduleShutdown() {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(async () => {
      if (pending.size) return;
      const task = engineTask;
      engineTask = null;
      (await task?.catch(() => null))?.terminate();
    }, IDLE_SHUTDOWN_MS);
  }

  // ── Текст страницы ───────────────────────────────────────────────────

  function patchPage(pdfPage, items) {
    const content = () => ({ items, styles: OCR_STYLES, lang: null });
    pdfPage.getTextContent = async () => content();
    pdfPage.streamTextContent = () =>
      new ReadableStream({
        start(controller) {
          controller.enqueue(content());
          controller.close();
        },
      });
  }

  /** Перерисовать текстовый слой страницы, не стирая картинку. */
  function refreshView(pageNumber) {
    const view = app.pdfViewer.getPageView(pageNumber - 1);
    view?.reset({ keepAnnotationLayer: true, keepAnnotationEditorLayer: true, keepXfaLayer: true, keepCanvasWrapper: true });
    app.pdfViewer.update();
  }

  async function apply(pageNumber, items) {
    // Распознают только страницы без текста; после подмены исходный текст
    // уже не прочитать — запоминаем ответ заранее.
    if (!textless.has(pageNumber)) textless.set(pageNumber, Promise.resolve(true));
    results.set(pageNumber, items);
    const pdfPage = await pdfDocument.getPage(pageNumber);
    patchPage(pdfPage, items);
    refreshView(pageNumber);
    // Поиск собирает текст страниц один раз — пусть соберёт заново.
    app.findController?.setDocument(pdfDocument);
    app.eventBus.dispatch('ocrpagedone', { source: api, pageNumber });
  }

  /** Нет ли текста на странице в самом PDF (до распознавания). */
  function originallyTextless(pageNumber) {
    if (!textless.has(pageNumber)) {
      const document = pdfDocument;
      textless.set(
        pageNumber,
        document
          .getPage(pageNumber)
          .then((page) => page.getTextContent())
          .then((content) => isTextless(content.items))
          .catch(() => false)
      );
    }
    return textless.get(pageNumber);
  }

  /** Страница без текста и ещё не распознана. */
  async function isPageTextless(pageNumber) {
    return !results.has(pageNumber) && originallyTextless(pageNumber);
  }

  async function pageImage(pageNumber) {
    const page = await pdfDocument.getPage(pageNumber);
    const base = page.getViewport({ scale: 1 });
    const scale = Math.min(MAX_SCALE, TARGET_SIDE / Math.max(base.width, base.height));
    const viewport = page.getViewport({ scale });
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(viewport.width);
    canvas.height = Math.round(viewport.height);
    const context = canvas.getContext('2d');
    context.fillStyle = '#fff';
    context.fillRect(0, 0, canvas.width, canvas.height);
    await page.render({ canvasContext: context, viewport }).promise;
    return { canvas, viewport };
  }

  async function readCanvas(worker, canvas, pageNumber, languages) {
    const key = languages.join('+');
    if (engineLanguages !== key) {
      await worker.reinitialize(languages, OEM_LSTM_ONLY);
      engineLanguages = key;
    }
    recognizingPage = pageNumber;
    setProgress(pageNumber, 0);
    try {
      return (await worker.recognize(canvas, {}, { text: true, blocks: true })).data;
    } finally {
      recognizingPage = null;
    }
  }

  async function runRecognition(pageNumber) {
    const document = pdfDocument;
    const id = docId;
    const worker = await engine();
    const { canvas, viewport } = await pageImage(pageNumber);
    const languages = docLanguages ?? PROBE_LANGUAGES;
    let data = await readCanvas(worker, canvas, pageNumber, languages);
    if (!docLanguages && document === pdfDocument) {
      docLanguages = pickLanguages(data.text || '');
      // Язык стал понятен — перечитываем страницу уже им одним.
      if (docLanguages && docLanguages.join('+') !== languages.join('+')) {
        data = await readCanvas(worker, canvas, pageNumber, docLanguages);
      }
    }
    if (document !== pdfDocument) return null; // пока распознавали, открыли другой документ
    const lines = (data.blocks || []).flatMap((block) => block.paragraphs.flatMap((paragraph) => paragraph.lines));
    const items = ocrLinesToItems(lines, (x, y) => viewport.convertToPdfPoint(x, y), { minConfidence: MIN_CONFIDENCE });
    await apply(pageNumber, items);
    if (id) {
      const record = { docId: id, pageNumber, items, languages: docLanguages, format: OCR_FORMAT, confidence: data.confidence, createdAt: Date.now() };
      await library.putOcr(record).catch(() => {});
    }
    return items;
  }

  /**
   * Распознать страницу. Повторный вызов для той же страницы ждёт первый.
   * @returns {Promise<object[]|null>} элементы текста или null
   */
  function recognize(pageNumber) {
    if (!pdfDocument) return Promise.resolve(null);
    if (results.has(pageNumber)) return Promise.resolve(results.get(pageNumber));
    if (!pending.has(pageNumber)) {
      // Движок один, и язык у него общий — задания выстраиваем в очередь.
      const task = exclusive.then(() => runRecognition(pageNumber)).finally(() => {
        pending.delete(pageNumber);
        progressByPage.delete(pageNumber);
        renderOffer(pageNumber);
        scheduleShutdown();
      });
      exclusive = task.catch(() => {});
      pending.set(pageNumber, task);
      renderOffer(pageNumber);
    }
    return pending.get(pageNumber);
  }

  /**
   * Похож ли документ на скан: больше половины проверенных страниц без
   * текста. Одна картинка во весь лист в обычной книге — не повод
   * распознавать её на ходу.
   */
  function looksScanned() {
    if (!scannedTask && pdfDocument) {
      const total = pdfDocument.numPages;
      const count = Math.min(SCAN_SAMPLE, total);
      const pages = new Set();
      for (let i = 0; i < count; i += 1) pages.add(1 + Math.round((i * (total - 1)) / Math.max(1, count - 1)));
      scannedTask = Promise.all([...pages].map((pageNumber) => originallyTextless(pageNumber))).then(
        (flags) => flags.filter(Boolean).length * 2 > flags.length
      );
    }
    return scannedTask ?? Promise.resolve(false);
  }

  /** Распознать все страницы без текста, начиная с текущей. */
  async function recognizeAll() {
    if (batch || !pdfDocument) return;
    const total = pdfDocument.numPages;
    const start = app.pdfViewer.currentPageNumber || 1;
    const order = [...Array(total).keys()].map((i) => ((start - 1 + i) % total) + 1);
    const pages = [];
    for (const pageNumber of order) if (await isPageTextless(pageNumber)) pages.push(pageNumber);
    if (!pages.length) {
      app.hud.show('Страниц без текста нет');
      return;
    }
    batch = { done: 0, total: pages.length, cancelled: false };
    const current = batch;
    renderAllOffers();
    for (const pageNumber of pages) {
      if (current.cancelled) break;
      app.hud.show(`Распознаю страницы: ${current.done + 1} из ${current.total}`, { duration: 60000 });
      try {
        await recognize(pageNumber);
      } catch (error) {
        console.warn('Не удалось распознать страницу', pageNumber, error);
      }
      current.done += 1;
    }
    batch = null;
    renderAllOffers();
    app.hud.show(current.cancelled ? 'Распознавание остановлено' : `Распознано страниц: ${current.done}`);
  }

  // ── Кнопка на страницах-сканах ───────────────────────────────────────

  function setProgress(pageNumber, progress) {
    progressByPage.set(pageNumber, progress);
    const label = app.pdfViewer.getPageView(pageNumber - 1)?.div.querySelector('.ocr-offer .ocr-progress');
    if (label) label.textContent = `Распознаю… ${Math.round(progress * 100)}%`;
  }

  function renderOffer(pageNumber) {
    const div = app.pdfViewer.getPageView(pageNumber - 1)?.div;
    if (!div) return;
    div.querySelector('.ocr-offer')?.remove();
    if (results.has(pageNumber) || !div.querySelector('.textLayer')) return;
    isPageTextless(pageNumber).then((empty) => {
      if (!empty || results.has(pageNumber) || div.querySelector('.ocr-offer')) return;
      const offer = el('div', { class: 'ocr-offer', 'data-keeps-popover': '' });
      if (pending.has(pageNumber)) {
        const progress = progressByPage.get(pageNumber) ?? 0;
        offer.append(el('span', { class: 'ocr-progress' }, `Распознаю… ${Math.round(progress * 100)}%`));
      } else {
        offer.append(
          el('span', { class: 'ocr-hint' }, 'На странице нет текста — похоже, это скан.'),
          el('button', { class: 'primary', onclick: () => recognize(pageNumber).catch(reportError) }, 'Распознать текст')
        );
      }
      if (batch) {
        offer.append(el('button', { onclick: () => batch && (batch.cancelled = true) }, `Остановить (${batch.done} из ${batch.total})`));
      } else if (!pending.has(pageNumber)) {
        offer.append(el('button', { onclick: () => recognizeAll() }, 'Все страницы'));
      }
      div.append(offer);
    });
  }

  function renderAllOffers() {
    for (let pageNumber = 1; pageNumber <= (app.pdfViewer.pagesCount || 0); pageNumber += 1) {
      if (app.pdfViewer.getPageView(pageNumber - 1)?.div.querySelector('.textLayer')) renderOffer(pageNumber);
    }
  }

  function reportError(error) {
    console.warn('Распознавание не удалось', error);
    app.hud.show(`Распознать не удалось: ${error.message || error}`, { duration: 5000 });
  }

  // ── Документ ─────────────────────────────────────────────────────────

  app.eventBus.on('documentopened', ({ pdfDocument: opened }) => {
    pdfDocument = opened;
    docId = null;
    results.clear();
    textless.clear();
    scannedTask = null;
    docLanguages = null;
    pending.clear();
    progressByPage.clear();
    if (batch) batch.cancelled = true;
    batch = null;
  });

  // Распознанное раньше — сразу на место, как только известен ключ документа.
  app.readingState.onChange(async () => {
    const id = app.readingState.documentId;
    if (!id || id === docId) return;
    docId = id;
    const document = pdfDocument;
    const stored = await library.listOcr(id).catch(() => []);
    for (const record of stored) {
      if (document !== pdfDocument || results.has(record.pageNumber)) continue;
      if ((record.format ?? 1) < OCR_FORMAT) continue;
      docLanguages ??= record.languages ?? null;
      await apply(record.pageNumber, record.items);
    }
  });

  app.eventBus.on('textlayerrendered', ({ pageNumber }) => renderOffer(pageNumber));

  const api = {
    recognize,
    recognizeAll,
    cancelAll() {
      if (batch) batch.cancelled = true;
    },
    isPageTextless,
    looksScanned,
    has: (pageNumber) => results.has(pageNumber),
    isPending: (pageNumber) => pending.has(pageNumber),
    /** Распознать заранее, если документ — скан (для озвучки). */
    async prefetch(pageNumber) {
      if (!pdfDocument || pageNumber < 1 || pageNumber > pdfDocument.numPages || results.has(pageNumber)) return;
      if ((await looksScanned()) && (await isPageTextless(pageNumber))) recognize(pageNumber).catch(() => {});
    },
  };
  return api;
}
