// Озвучка документа. Контроллер держит очередь предложений, ведёт подсветку
// и прокрутку за читаемым местом, а сам синтез делегирует провайдеру —
// системному, внешнему по HTTP или нейроголосу (TeraTTS, Piper), интерфейс
// у них одинаковый. Какой из них работает, решает выбранный голос.

import { $, on } from '../dom.js';
import { get as getSetting, onSettingsChanged, updateSettings } from '../settings.js';
import { TextIndex, cleanForSpeech, wordLength } from '../text-index.js';
import { bufferBudget, bufferedSeconds, formatClock, formatSpoken, prepareAhead } from './buffer.js';
import { createEngines, downloadWithConsent, fillVoiceSelect } from './engines.js';
import { createHighlighter } from './highlighter.js';
import { createMediaKeys } from './media-keys.js';
import { createNoteCard } from './note-card.js';
import { createNoteFilter, createNotePicker } from './note-picker.js';
import { createSleepTimer } from './sleep-timer.js';
import { onUserStressChange } from './user-stress.js';
import { createWordJoiner } from './word-breaks.js';
import { firstVisibleSpanIndex, offsetInSpan, textPointAt, textSpanOf, textSpansOfPage } from '../visible-text.js';

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const isSpeakable = (text) => /[\p{L}\p{N}]/u.test(text);
/** Позиция a дальше позиции b в документе. */
const isAfter = (a, b) => a.pageNumber > b.pageNumber || (a.pageNumber === b.pageNumber && a.sentenceIndex > b.sentenceIndex);
// Сколько синтезировать заранее, задаёт настройка — минуты речи (buffer.js).
// Дальше стольких страниц вперёд не заглядываем: на нераспознанном скане
// предложений нет, и поиск текста ушёл бы до конца книги.
const PREFETCH_PAGES = 30;
// Через столько без звука показываем, что нейроголос готовит фразу.
const BUSY_DELAY_MS = 350;
// Столько фраз подряд не синтезировалось — это уже не одна странная фраза, а сбой.
const MAX_FAILED_SENTENCES = 3;

export function createTts(app) {
  const bar = $('ttsBar');
  const highlighter = createHighlighter(app);
  const sleepTimer = createSleepTimer({
    select: $('ttsSleep'),
    label: $('ttsSleepLeft'),
    chapterEndAfter: (pageNumber) => app.outline?.nextChapterStart(pageNumber) ?? null,
  });

  let index = null;
  const engines = createEngines();
  const { piper, tera } = engines;
  let provider = null; // тот, что сейчас говорит
  let state = 'idle'; // idle | speaking | paused
  let generation = 0;
  let position = { pageNumber: 1, sentenceIndex: 0 };
  let voicesLoaded = false;
  let cursorShown = false; // место старта выбрано щелчком, но чтение ещё не началось
  let upcoming = null; // откуда продолжится чтение после текущей фразы
  let prefetchToken = 0;
  let busyTimer = 0;
  let buffer = []; // заготовки впереди по порядку: { seconds } — null, пока синтезируется
  let sentenceStatus = ''; // «Стр. N, предложение…» — вернуть после паузы
  let bufferTimer = 0;
  let spokenInRun = 0; // фраз прочитано с последнего старта
  // Сколько текущая фраза звучала: от первого звука до конца, без пауз и
  // ожидания синтеза — по этому статистика считает время озвучки.
  let heard = { ms: 0, since: 0, started: false };
  let lags = 0; // сколько раз посреди чтения нейроголос не успел
  let lagHintShown = false;
  // Чтение выделенного: текущий кусок и очередь следующих — { from, to },
  // позиции предложений, to включительно. range = null — читаем документ подряд.
  let range = null;
  let queued = [];
  // Примечания звучат отдельными фразами после своей: окошко показывает их
  // текст, и их можно пропустить.
  let pendingSegments = []; // примечания текущей фразы, которые ещё впереди: { text, note }
  let noteSpeaking = false; // сейчас звучит примечание
  let currentNote = null; // { key, text } звучащего примечания
  let noteSkipped = false;
  let currentText = ''; // что звучит сейчас: фраза или её примечание — его и переозвучивают
  // Какие примечания читать: выключенные голос пропускает (выбор у каждой книги свой).
  const noteFilter = createNoteFilter(() => app.readingState);
  /** Тексты примечаний текущей фразы, которые ещё прозвучат (выключенные — нет). */
  const pendingNotes = () => pendingSegments.filter((item) => !noteFilter.isMuted(item.note.text)).map((item) => item.text);
  const noteCard = createNoteCard({ onSkip: () => skipNote(), onMute: (note) => muteNote(note), onPick: () => pickNotes(), wordLength });
  const notePicker = createNotePicker({
    filter: noteFilter,
    textIndex: () => index,
    available: () => {
      if (getSetting('ttsFootnotes') !== 'inline') return 'Сейчас голос не читает примечания вовсе: в настройках озвучки «Примечания и сноски» — «не читать».';
      if (!index?.skipFurniture) return 'Примечания читаются отдельно, только когда колонтитулы и сноски не читаются подряд (настройки озвучки).';
      return '';
    },
    onChange: () => notesChanged(),
  });
  // Кнопки гарнитуры и медиаклавиши: пауза, дальше (во время примечания — пропустить его), назад.
  const mediaKeys = createMediaKeys({
    actions: { playPause: () => toggle(), next: () => next(), previous: () => jump(-1), stop: () => finish() },
    isNote: () => noteSpeaking,
    enabled: () => getSetting('ttsMediaKeys') !== false,
  });
  const bookTitle = () => $('docTitle')?.textContent?.trim() || document.title;

  const PICK_HINT = 'Щёлкните по тексту — начну читать с этого места';

  /** Пока панель озвучки открыта, щелчок по тексту выбирает место старта. */
  function showBar(visible) {
    // Нейроголос грузит модели, пока читатель выбирает, откуда читать.
    if (visible && bar.hidden) engines.neuralFor()?.preload?.();
    const changed = bar.hidden === visible;
    bar.hidden = !visible;
    if (changed) app.readingState?.scheduleSave(); // открытая панель вернётся с документом
    app.el.classList.toggle('tts-picking', visible);
    if (visible && state === 'idle' && !cursorShown) setStatus(PICK_HINT);
    if (!visible && state === 'idle') clearCursor();
  }

  function clearCursor() {
    if (!cursorShown) return;
    cursorShown = false;
    clearHighlights();
  }

  const pickProvider = () => engines.pick();

  /** Выбран голос другого движка — прерываем старый и говорим новым. */
  function switchProvider() {
    const next = pickProvider();
    if (next === provider) return;
    if (state === 'paused') provider?.resume();
    provider?.cancel();
    provider = next;
    syncUi();
  }

  function speechOptions() {
    return {
      voiceId: getSetting('ttsVoiceUri') || undefined,
      rate: getSetting('ttsRate'),
      pitch: getSetting('ttsPitch'),
      volume: getSetting('ttsVolume'),
      lang: index?.language === 'ru' ? 'ru-RU' : index?.language || undefined,
      mixLanguages: getSetting('ttsMixLanguages'),
    };
  }

  function setStatus(text) {
    $('ttsStatus').textContent = text;
  }

  function syncUi() {
    const playing = state === 'speaking';
    app.icons.setIcon($('ttsPlay'), playing ? 'pause' : 'play');
    $('btnSpeak').classList.toggle('active', playing || state === 'paused');
    $('btnSpeak').setAttribute('aria-pressed', String(playing));
    $('ttsRate').value = String(getSetting('ttsRate'));
    $('ttsPitch').value = String(getSetting('ttsPitch'));
    $('ttsRateValue').textContent = `${Number(getSetting('ttsRate')).toFixed(1)}×`;
    $('ttsVolume').value = String(getSetting('ttsVolume'));
    $('ttsVolumeValue').textContent = `${Math.round(Number(getSetting('ttsVolume')) * 100)} %`;
    $('ttsPitchValue').textContent = Number(getSetting('ttsPitch')).toFixed(1);
    showEngine();
    app.el.classList.toggle('speaking', playing);
    $('ttsRevoice').hidden = !provider?.revoice;
  }

  /** Метка «нейро»: синтез в браузере или через ускоритель (программу). */
  function showEngine() {
    const badge = $('ttsEngine');
    badge.hidden = !provider?.neural;
    const helper = provider === tera && tera.usingHelper;
    badge.textContent = helper ? 'нейро · ускоритель' : 'нейро';
    badge.title = helper
      ? 'Нейроголос: синтез идёт в программе-ускорителе — в «Диспетчере задач» она в группе Firefox (pdf-reader-tts)'
      : provider === tera && tera.helperError
        ? `Нейроголос: синтез в браузере — ускоритель не подключился (${tera.helperError})`
        : 'Нейроголос: синтез прямо в браузере, без интернета. Перед первой фразой голос загружается';
  }

  async function fillVoices() {
    const select = $('ttsVoice');
    const voices = await engines.voices();
    voicesLoaded = true;
    // Голоса языка документа показываем первыми — их обычно и выбирают.
    const stored = getSetting('ttsVoiceUri');
    const { chosen, empty } = fillVoiceSelect(select, voices, { documentLang: index?.language || 'ru', stored });
    if (empty) {
      setStatus(
        getSetting('ttsProvider') === 'http'
          ? 'Внешний движок не вернул список голосов'
          : 'Система не предоставила голоса синтеза — выберите нейроголос'
      );
    }
    if (!chosen) return;
    if (chosen.id !== stored) await updateSettings({ ttsVoiceUri: chosen.id });
    switchProvider();
  }

  /** Нейроголос ещё не скачан: спросить и скачать с прогрессом в строке панели. */
  async function offerDownload(voiceId) {
    if (!(await downloadWithConsent(engines, voiceId, setStatus))) return false;
    await updateSettings({ ttsVoiceUri: voiceId });
    await fillVoices();
    return true;
  }

  async function needsOcr(pageNumber) {
    if (!app.ocr || !getSetting('ocrAuto') || app.ocr.has(pageNumber)) return false;
    return (await app.ocr.looksScanned()) && app.ocr.isPageTextless(pageNumber);
  }

  function sentenceText(page, sentenceIndex) {
    const sentence = page.sentences[sentenceIndex];
    return cleanForSpeech(page.text.slice(sentence.start, sentence.end));
  }

  // Перенос без знака («сооб␤щает») — склеить по словарю ударений TeraTTS.
  // Своя склейка у каждого документа: потерял ли он дефисы, судим по нему.
  // Пока говорит другой голос, а TeraTTS не загружена, её не ждём.
  const newWordJoiner = () =>
    createWordJoiner((words) => (provider === tera || tera.isVoiceReady?.() ? tera.knownWords(words) : null));
  let wordJoiner = newWordJoiner();

  /** Текст предложения для голоса: очищенный и со склеенными переносами без знака. */
  async function spokenSentence(page, sentenceIndex) {
    const cleaned = sentenceText(page, sentenceIndex);
    if (!page.softBreaks?.length) return cleaned;
    return wordJoiner.join(page, page.sentences[sentenceIndex], cleaned).catch(() => cleaned);
  }

  /**
   * Что произнести с этого места. Обычно одно предложение; но если страница
   * обрывается посреди фразы, а следующая продолжает её со строчной, — обе
   * части вместе, одной фразой: иначе голос ставит точку посреди
   * предложения («…которому была.» «Поручена разработка…»).
   * @returns {Promise<{ parts: object[], text: string, next: { pageNumber: number, sentenceIndex: number } }>}
   */
  async function buildUtterance(page, sentenceIndex) {
    const first = await spokenSentence(page, sentenceIndex);
    const parts = [{ page, sentenceIndex, text: first.text, map: first.map, offset: 0 }];
    let text = first.text;
    let next = { pageNumber: page.pageNumber, sentenceIndex: sentenceIndex + 1 };
    if (sentenceIndex === page.sentences.length - 1 && page.runsOn && page.pageNumber < index.numPages) {
      const following = await index.page(page.pageNumber + 1);
      if (following?.runsIn && following.sentences.length) {
        const second = await spokenSentence(following, 0);
        // Перенос по слогам на стыке страниц: «окку-» + «пационными».
        const hyphenated = /\p{L}[-\u00ad\u2010\u2011]$/u.test(text) && /^\p{Ll}/u.test(second.text);
        if (hyphenated) text = text.slice(0, -1);
        // Без знака переноса — «сооб» + «щает», если по словарю это одно слово.
        const split =
          !hyphenated &&
          /^\p{Ll}/u.test(second.text) &&
          (await wordJoiner.joins(text.match(/\p{L}+$/u)?.[0] ?? '', second.text.match(/^\p{L}+/u)?.[0] ?? '').catch(() => false));
        const joiner = hyphenated || split ? '' : ' ';
        parts.push({ page: following, sentenceIndex: 0, text: second.text, map: second.map, offset: text.length + joiner.length });
        text += joiner + second.text;
        next = { pageNumber: following.pageNumber, sentenceIndex: 1 };
      }
    }
    // Примечания к знакам сносок в этой фразе — сразу за ней, каждое своей
    // фразой (main — без них): окошко показывает текст примечания, и его можно
    // пропустить. text — всё вместе, для аудиокниги.
    const main = text;
    const notes = [];
    for (const note of await notesOf(parts)) {
      const prefix = 'Примечание: ';
      const spoken = `${prefix}${note.text}${/[.!?…]$/.test(note.text) ? '' : '.'}`;
      notes.push({ key: note.key, text: note.text, spoken, prefix: prefix.length });
      text += (/[.!?…»"]$/.test(text.trim()) ? ' ' : '. ') + spoken;
    }
    return { parts, text, main, notes, next };
  }

  /**
   * Фразы страниц from…to по порядку — для аудиокниги: тот же текст, что
   * звучит при чтении вслух (примечания, склейка переносов, стык страниц).
   * Фраза, перетекающая за последнюю страницу, — целиком.
   */
  async function* utterancesOf(fromPage, toPage) {
    let cursor = { pageNumber: fromPage, sentenceIndex: 0 };
    while (cursor.pageNumber <= Math.min(toPage, index.numPages)) {
      const page = await index.page(cursor.pageNumber);
      if (!page) break;
      if (cursor.sentenceIndex === 0 && !page.sentences.length && (await needsOcr(page.pageNumber))) {
        await app.ocr.recognize(page.pageNumber).catch((error) => console.warn('Не удалось распознать страницу', error));
        if (app.ocr.has(page.pageNumber)) continue; // текст появился — перечитываем страницу
      }
      if (cursor.sentenceIndex >= page.sentences.length) {
        cursor = { pageNumber: cursor.pageNumber + 1, sentenceIndex: 0 };
        continue;
      }
      const utterance = await buildUtterance(page, cursor.sentenceIndex);
      cursor = utterance.next;
      if (isSpeakable(utterance.text)) {
        yield { text: utterance.text, pageNumber: page.pageNumber, chapter: app.outline?.chapterTitleAt(page.pageNumber) ?? null };
      }
    }
  }

  /** Примечания к знакам сносок в частях фразы — { key, text } по порядку, без повторов. */
  async function notesOf(parts) {
    if (getSetting('ttsFootnotes') !== 'inline' || !index?.skipFurniture) return [];
    const notes = [];
    for (const part of parts) {
      for (const ref of index.refsOfSentence(part.page, part.sentenceIndex)) {
        const note = await index.noteFor(part.page.pageNumber, ref).catch(() => null);
        // Выключенное примечание («Не читать это», список примечаний) — не читаем.
        if (note && !noteFilter.isMuted(note) && !notes.some((known) => known.text === note)) notes.push({ key: ref.key, text: note });
      }
    }
    return notes;
  }

  /**
   * Подготовить речь вперёд — на столько минут, сколько задано в настройках.
   * Синтез идёт и пока звучит фраза, и на паузе: после паузы чтение
   * продолжается без ожидания. Заготовки для других мест (читатель
   * перескочил, сменил скорость) провайдер отпускает.
   */
  async function prefetchAhead(from, leading = pendingNotes()) {
    if (!provider.prepare || !from) return;
    const token = (prefetchToken += 1);
    const options = speechOptions();
    const budget = bufferBudget(getSetting('ttsBufferMinutes'), options.rate);
    // Сначала — примечания звучащей фразы, что ещё впереди.
    const texts = [...leading];
    let cursor = { ...from };
    let chars = texts.reduce((sum, text) => sum + text.length, 0);
    // Читаем выделенное — заготовки только в его кусках, по очереди.
    const plan = range ? [range, ...queued] : null;
    let piece = 0;
    while (chars < budget && cursor.pageNumber - from.pageNumber <= PREFETCH_PAGES) {
      if (plan) {
        while (piece < plan.length && isAfter(cursor, plan[piece].to)) {
          piece += 1;
          if (piece < plan.length && isAfter(plan[piece].from, cursor)) cursor = { ...plan[piece].from };
        }
        if (piece >= plan.length) break;
      }
      const page = await index.page(cursor.pageNumber);
      if (!page || token !== prefetchToken) return;
      if (cursor.sentenceIndex >= page.sentences.length) {
        if (cursor.pageNumber >= index.numPages) break;
        cursor = { pageNumber: cursor.pageNumber + 1, sentenceIndex: 0 };
        continue;
      }
      const utterance = await buildUtterance(page, cursor.sentenceIndex);
      if (token !== prefetchToken) return;
      cursor = utterance.next;
      if (!isSpeakable(utterance.main)) continue;
      // В том же порядке, в каком зазвучат: фраза, потом её примечания.
      for (const text of [utterance.main, ...utterance.notes.map((note) => note.spoken)]) {
        texts.push(text);
        chars += text.length;
      }
    }
    if (token !== prefetchToken) return;
    buffer = prepareAhead(provider, texts, options);
  }

  /** Запас на панели — как полоса подгрузки у видео; на паузе — и в статусе. */
  function showBuffer() {
    const badge = $('ttsBuffer');
    const visible = state !== 'idle' && provider?.neural && provider.prepare;
    badge.hidden = !visible;
    if (!visible) return;
    // Заготовки — на обычной скорости; звучать они будут быстрее или медленнее.
    const seconds = bufferedSeconds(buffer) / (getSetting('ttsRate') || 1);
    badge.textContent = `запас ${formatClock(seconds)}`;
    if (state === 'paused') setStatus(`Пауза · вперёд готово ≈ ${formatSpoken(seconds)}`);
  }

  /** Нейроголос грузит модель или синтезирует — показываем это, а не молчим. */
  function waitForVoice() {
    clearTimeout(busyTimer);
    if (!provider.neural) return;
    const voice = $('ttsVoice').selectedOptions[0]?.textContent || 'нейроголос';
    const show = (text) => {
      bar.classList.add('tts-busy');
      setStatus(text);
    };
    if (!provider.isVoiceReady(getSetting('ttsVoiceUri'))) {
      show(
        provider === tera
          ? 'Загружаю TeraTTS в память — это до полуминуты, дальше фразы пойдут сразу…'
          : `Загружаю нейроголос «${voice}» — первый раз это несколько секунд…`
      );
    } else {
      busyTimer = setTimeout(() => {
        show('Нейроголос готовит фразу…');
        // Посреди чтения фраза не готова — синтез не успевает за речью.
        // При «сами» TeraTTS на первую же нехватку добавляет поток — подсказку
        // показываем, только если и это не помогло.
        const single = getSetting('teraThreads') === '1';
        if (provider === tera && spokenInRun > 1 && (lags += 1) >= (single ? 2 : 4) && !lagHintShown) {
          lagHintShown = true;
          app.hud.show(
            single
              ? 'TeraTTS не успевает на этом компьютере — в настройках «TeraTTS: потоки синтеза» выберите «сами» или «два»'
              : 'TeraTTS не успевает на этой скорости — уменьшите её или поставьте на паузу: запас наберётся',
            { duration: 8000 }
          );
        }
      }, BUSY_DELAY_MS);
    }
  }

  function voiceStarted(status) {
    clearTimeout(busyTimer);
    bar.classList.remove('tts-busy');
    if (status) setStatus(status);
  }

  /** Прокрутка за читаемым предложением: держим его в верхней трети экрана. */
  function follow(bounds) {
    if (!bounds || !getSetting('ttsFollowScroll')) return;
    const rect = app.container.getBoundingClientRect();
    const above = bounds.top < rect.top + 8;
    const below = bounds.bottom > rect.bottom - 40;
    if (!above && !below) return;
    const target = app.container.scrollTop + (bounds.top - rect.top) - rect.height * 0.3;
    app.scroller.scrollTo(target, { smooth: true, duration: 320 });
  }

  /**
   * Показ читаемого места в обычном виде: слой подсветки поверх страницы PDF.
   * У режима «только текст» (reflow-view.js) те же методы, но подсвечивает
   * он сами предложения текста.
   */
  const pdfView = {
    async ensurePage(pageNumber) {
      const div = app.pdfViewer.getPageView(pageNumber - 1)?.div;
      // Текстовый слой уже есть — подсветке этого хватает. Раньше здесь
      // сравнивалась «текущая» страница pdf.js: у низа страницы ею уже
      // считается следующая, и перед каждой фразой вид прыгал назад с паузой.
      if (div?.querySelector('.textLayer span')) return;
      // Окно свёрнуто или закрыто другим: страницы браузер не рисует, и
      // ждать слоя — полторы секунды тишины на каждой новой странице.
      // Подсветка нужна, только когда её видно.
      if (document.hidden) return;
      const rect = div?.getBoundingClientRect();
      const box = app.container.getBoundingClientRect();
      const near = rect && rect.bottom > box.top - box.height && rect.top < box.bottom + box.height;
      if (!near) app.pdfViewer.scrollPageIntoView({ pageNumber });
      await Promise.race([
        new Promise((resolve) => {
          const handler = (event) => {
            if (event.pageNumber === pageNumber) {
              app.eventBus.off('textlayerrendered', handler);
              resolve();
            }
          };
          app.eventBus.on('textlayerrendered', handler);
        }),
        delay(1500),
      ]);
    },
    highlightSentence(page, sentenceIndex, { scroll = true } = {}) {
      const sentence = page.sentences[sentenceIndex];
      if (!sentence) return;
      const bounds = highlighter.highlight(page.pageNumber, page.entries, sentence, { kind: 'sentence' });
      if (scroll) follow(bounds);
    },
    highlightWord(page, sentenceIndex, map, { charIndex, charLength }, spokenText) {
      const sentence = page.sentences[sentenceIndex];
      const startOffset = map[charIndex];
      if (!sentence || startOffset === undefined) return;
      const length = charLength || wordLength(spokenText, charIndex);
      const lastIndex = Math.min(map.length - 1, charIndex + length - 1);
      const endOffset = (map[lastIndex] ?? startOffset) + 1;
      highlighter.highlight(
        page.pageNumber,
        page.entries,
        { start: sentence.start + startOffset, end: sentence.start + endOffset },
        { kind: 'word' }
      );
    },
    clearWords(pageNumber) {
      highlighter.clearWords(pageNumber);
    },
    clear() {
      highlighter.clear();
    },
    /** Первое предложение, видимое на экране. */
    async firstVisible() {
      const pageNumber = app.pdfViewer.currentPageNumber || 1;
      const offset = await index.offsetForSpan(pageNumber, firstVisibleSpanIndex(app, pageNumber));
      return { pageNumber, sentenceIndex: await index.sentenceIndexAt(pageNumber, offset) };
    },
  };

  function view() {
    return app.reflow?.active ? app.reflow : pdfView;
  }

  function clearHighlights() {
    pdfView.clear();
    app.reflow?.clear();
  }

  function highlightWord(page, sentenceIndex, map, event, spokenText) {
    if (getSetting('ttsHighlightWords')) view().highlightWord(page, sentenceIndex, map, event, spokenText);
  }

  async function loop() {
    const myGeneration = ++generation;
    spokenInRun = 0;
    let failed = 0;
    clearInterval(bufferTimer);
    bufferTimer = setInterval(() => {
      showBuffer();
      showEngine(); // ускоритель могли подключить посреди чтения
    }, 1000);
    state = 'speaking';
    syncUi();
    app.wakeLock?.request();
    mediaKeys.playing(bookTitle());

    try {
      while (state !== 'idle' && myGeneration === generation) {
        const page = await index.page(position.pageNumber);
        if (!page) break;
        // Сканы распознаём на страницу вперёд, чтобы чтение не вставало.
        if (position.sentenceIndex === 0 && getSetting('ocrAuto')) app.ocr?.prefetch(page.pageNumber + 1);

        // Страница-скан: сначала распознать, потом читать.
        if (!page.sentences.length && (await needsOcr(page.pageNumber))) {
          setStatus(`Стр. ${page.pageNumber}: распознаю текст скана…`);
          try {
            await app.ocr.recognize(page.pageNumber);
          } catch (error) {
            console.warn('Не удалось распознать страницу', error);
          }
          if (myGeneration !== generation || state === 'idle') return;
          if (app.ocr.has(page.pageNumber)) continue; // текст появился — перечитываем страницу
        }

        if (position.sentenceIndex >= page.sentences.length) {
          if (position.pageNumber >= index.numPages) {
            finish('Документ прочитан');
            return;
          }
          position = { pageNumber: position.pageNumber + 1, sentenceIndex: 0 };
          continue;
        }
        if (position.sentenceIndex < 0) {
          if (position.pageNumber <= 1) position.sentenceIndex = 0;
          else {
            const previousPage = await index.page(position.pageNumber - 1);
            position = {
              pageNumber: position.pageNumber - 1,
              sentenceIndex: Math.max(0, (previousPage?.sentences.length || 1) - 1),
            };
          }
          continue;
        }

        // Кусок выделенного дочитан — следующий из очереди или конец.
        if (range && isAfter(position, range.to)) {
          const next = queued.shift();
          if (!next) {
            finish('Выделенное прочитано');
            return;
          }
          range = next;
          if (isAfter(next.from, position) || isAfter(position, next.from)) position = { ...next.from };
          continue;
        }

        const utterance = await buildUtterance(page, position.sentenceIndex);
        if (myGeneration !== generation) return;
        // «* * *» и прочие разделители читать вслух незачем.
        if (!isSpeakable(utterance.main)) {
          position = { ...utterance.next };
          continue;
        }

        sleepTimer.arm(page.pageNumber);
        if (sleepTimer.shouldStop(page.pageNumber)) {
          sleepTimer.reset();
          finish('Таймер сна: чтение остановлено');
          return;
        }

        await view().ensurePage(page.pageNumber);
        if (myGeneration !== generation) return;

        const sentenceIndex = position.sentenceIndex;
        view().highlightSentence(page, sentenceIndex);
        const status = `Стр. ${page.pageNumber}, предложение ${sentenceIndex + 1} из ${page.sentences.length}${queued.length ? ` · в очереди ещё ${queued.length}` : ''}`;
        sentenceStatus = status;
        setStatus(status);
        upcoming = utterance.next;

        // Слова приходят в координатах всей фразы — находим, к какой части
        // (странице) относится слово, и переносим подсветку туда.
        let currentPart = utterance.parts[0];
        const onBoundary = (event) => {
          const part = utterance.parts.findLast((candidate) => candidate.offset <= event.charIndex);
          if (!part) return;
          if (part !== currentPart) {
            view().clearWords(currentPart.page.pageNumber);
            currentPart = part;
            view().ensurePage(part.page.pageNumber);
            view().highlightSentence(part.page, part.sentenceIndex);
          }
          const local = { ...event, charIndex: event.charIndex - part.offset };
          highlightWord(part.page, part.sentenceIndex, part.map, local, part.text);
        };

        // Фраза, потом её примечания — каждое отдельной фразой: пока оно
        // звучит, окошко показывает его текст, и его можно пропустить.
        const segments = [{ text: utterance.main }, ...utterance.notes.map((note, i) => ({ text: note.spoken, note, number: i + 1 }))];
        let skipUtterance = false;
        for (let s = 0; s < segments.length; s += 1) {
          const segment = segments[s];
          // Примечание выключили, пока звучала фраза, — его не читаем.
          if (segment.note && noteFilter.isMuted(segment.note.text)) continue;
          pendingSegments = segments.slice(s + 1);
          const last = !pendingNotes().length;
          noteSpeaking = Boolean(segment.note);
          currentNote = segment.note ?? null;
          currentText = segment.text;
          noteSkipped = false;
          const options = speechOptions();
          const pause = getSetting('ttsSentencePauseMs');
          if (segment.note) {
            // Голос ушёл из текста в примечание — слово в тексте больше не подсвечиваем.
            for (const part of utterance.parts) view().clearWords(part.page.pageNumber);
            noteCard.show(segment.note, { number: segment.number, count: utterance.notes.length, rate: options.rate });
            setStatus(`${status} · примечание`);
          }
          waitForVoice();
          heard = { ms: 0, since: 0, started: false };
          const speaking = provider.speak(segment.text, {
            ...options,
            volume: options.volume * sleepTimer.volumeFactor(),
            // Пауза между фразами: нейроголос ставит её в звук сам, встык к предыдущей.
            gapMs: provider.gapless ? pause : 0,
            // Следующую фразу ставить встык заранее — если таймер сна не остановит чтение на ней.
            chain: !(last && sleepTimer.stopsSoon(utterance.next.pageNumber)),
            onStart: () => {
              heard.started = true;
              if (state === 'speaking') heard.since = performance.now();
              voiceStarted(segment.note ? `${status} · примечание` : status);
              if (segment.note) noteCard.started();
              showEngine(); // ускоритель мог подключиться, пока грузились модели
            },
            onBoundary: segment.note ? (event) => noteCard.boundary(event) : onBoundary,
          });
          // Заготовки — после текущей фразы: в очереди синтеза она первая.
          prefetchAhead(utterance.next);
          let result;
          try {
            result = await speaking;
            failed = 0;
          } catch (error) {
            // Одна фраза не синтезировалась — пропускаем её, а не обрываем чтение.
            noteSpeaking = false;
            noteCard.hide();
            if (myGeneration !== generation || state === 'idle') return;
            failed += 1;
            if (failed >= MAX_FAILED_SENTENCES) throw error;
            console.warn('Фраза не озвучилась — пропускаю', error);
            voiceStarted();
            stopHeard();
            app.hud.show('Фразу не удалось озвучить — пропускаю', { duration: 3000 });
            skipUtterance = true;
            break;
          }
          noteSpeaking = false;
          if (segment.note) noteCard.hide();
          voiceStarted();
          stopHeard();
          app.eventBus.dispatch('ttslistened', {
            source: app,
            ms: heard.ms,
            rate: options.rate,
            // Знаки — только у дослушанной фразы: по ним и времени считается скорость.
            chars: result === 'ended' ? segment.text.length : 0,
          });

          if (myGeneration !== generation || state === 'idle') return;
          // Пропустили примечание — дальше по порядку: следующее примечание или фраза.
          if (result === 'cancelled' && !(segment.note && noteSkipped)) return;
          if (!segment.note) for (const part of utterance.parts) view().clearWords(part.page.pageNumber);
          if (pause && !provider.gapless) await delay(pause);
          if (myGeneration !== generation) return;
        }
        pendingSegments = [];
        if (skipUtterance) {
          position = { ...utterance.next };
          continue;
        }
        spokenInRun += 1;
        position = { ...utterance.next };
      }
    } catch (error) {
      console.error('Ошибка озвучки', error);
      app.hud.show(`Озвучка: ${error.message || error}`, { duration: 5000 });
      finish();
    }
  }

  function finish(message) {
    // Остановили на паузе: проигрыватель снимаем с паузы, иначе следующий
    // «Старт» копил бы речь молча, пока не нажмут ещё раз.
    if (state === 'paused') provider?.resume();
    state = 'idle';
    range = null;
    queued = [];
    pendingSegments = [];
    currentNote = null;
    noteSpeaking = false;
    currentText = '';
    noteCard.hide();
    mediaKeys.stopped();
    clearInterval(bufferTimer);
    buffer = [];
    $('ttsBuffer').hidden = true;
    cursorShown = false;
    upcoming = null;
    prefetchToken += 1;
    voiceStarted();
    sleepTimer.disarm();
    generation += 1;
    provider?.cancel();
    clearHighlights();
    // Плавная прокрутка за последней фразой не должна доезжать после стопа.
    if (!app.autoScroll?.running) app.scroller?.cancel();
    if (!app.autoScroll?.running) app.wakeLock?.release();
    syncUi();
    // После остановки панель снова подсказывает, как выбрать место.
    setStatus(message || (bar.hidden ? '' : PICK_HINT));
    if (message) app.hud.show(message);
  }

  /**
   * Где точка выделения (узел и смещение в нём): спан текстового слоя или
   * предложение режима «только текст». Без ожидания: пока ждали бы, pdf.js
   * мог перерисовать слой, и узлы выделения стали бы уже не на странице.
   */
  function locatePoint(node, offset, atEnd = false) {
    const inReflow = app.reflow?.positionOfNode(node);
    if (inReflow) return { position: inReflow };
    const span = textSpanOf(node);
    if (span) {
      const pageNumber = Number(span.closest('.page')?.dataset.pageNumber);
      const spanIndex = pageNumber ? textSpansOfPage(app, pageNumber).indexOf(span) : -1;
      if (spanIndex < 0) return null;
      return { pageNumber, spanIndex, inSpan: node.nodeType === Node.TEXT_NODE ? offsetInSpan(span, node, offset) : 0 };
    }
    // Граница выделения пришлась между спанами — на перенос строки <br> или
    // на сам слой: конец относим к спану перед ней, начало — к спану после.
    const element = node.nodeType === Node.TEXT_NODE ? node.parentElement : node;
    const pageNumber = Number(element?.closest('.page')?.dataset.pageNumber);
    if (!pageNumber) return null;
    const boundary = node.nodeType === Node.ELEMENT_NODE ? node.childNodes[offset] ?? null : node;
    const spans = textSpansOfPage(app, pageNumber);
    const before = (candidate) => {
      if (!boundary) return candidate.compareDocumentPosition(node) & Node.DOCUMENT_POSITION_FOLLOWING || node.contains(candidate);
      return Boolean(boundary.compareDocumentPosition(candidate) & Node.DOCUMENT_POSITION_PRECEDING);
    };
    if (atEnd) {
      const spanIndex = spans.findLastIndex((candidate) => before(candidate));
      return spanIndex < 0 ? null : { pageNumber, spanIndex, inSpan: spans[spanIndex].textContent.length };
    }
    const spanIndex = spans.findIndex((candidate) => !before(candidate));
    return spanIndex < 0 ? null : { pageNumber, spanIndex, inSpan: 0 };
  }

  /** Предложение точки; atEnd — конец выделения: точка в начале спана относится к предыдущему символу. */
  async function positionOfPoint(point, atEnd = false) {
    if (!point) return null;
    if (point.position) return point.position;
    const at = await index.offsetForSpan(point.pageNumber, point.spanIndex, point.inSpan);
    return { pageNumber: point.pageNumber, sentenceIndex: await index.sentenceIndexAt(point.pageNumber, atEnd ? Math.max(0, at - 1) : at) };
  }

  /** Если в тексте что-то выделено, читать начинаем с начала выделения. */
  async function positionFromSelection() {
    const selection = window.getSelection();
    if (!selection || selection.isCollapsed || !selection.rangeCount) return null;
    const selected = selection.getRangeAt(0); // начало диапазона всегда раньше конца
    const position = await positionOfPoint(locatePoint(selected.startContainer, selected.startOffset));
    if (position) selection.removeAllRanges();
    return position;
  }

  /** Выделенный кусок — от предложения начала до предложения конца. */
  async function rangeOfSelection(selected) {
    if (!index || !selected || selected.collapsed) return null;
    const start = locatePoint(selected.startContainer, selected.startOffset);
    const end = locatePoint(selected.endContainer, selected.endOffset, true);
    const from = await positionOfPoint(start);
    const to = await positionOfPoint(end, true);
    if (!from || !to) return null;
    return { from, to: isAfter(from, to) ? from : to };
  }

  /**
   * Озвучить выделенное: ничего не читается (или читается документ) — читать
   * этот кусок; уже читается выделенное — поставить кусок в очередь, мусор
   * между кусками пропускается.
   * @param selected Range; по умолчанию — текущее выделение
   * @returns {Promise<boolean>} кусок принят
   */
  async function speakSelection(selected = window.getSelection()?.rangeCount ? window.getSelection().getRangeAt(0) : null) {
    return speakPiece(await rangeOfSelection(selected));
  }

  /** То же для куска, место которого уже найдено (rangeOfSelection). */
  async function speakPiece(piece) {
    if (!piece) {
      app.hud.show('Выделите текст документа — его и прочитаю');
      return false;
    }
    window.getSelection()?.removeAllRanges();
    const same = (a, b) => !isAfter(a.from, b.from) && !isAfter(b.from, a.from) && !isAfter(a.to, b.to) && !isAfter(b.to, a.to);
    if (range && state !== 'idle') {
      if ([range, ...queued].some((other) => same(other, piece))) {
        app.hud.show('Этот кусок уже в очереди');
        return true;
      }
      queued.push(piece);
      app.hud.show(`Добавлено в очередь — впереди ${queued.length}`);
      prefetchAhead(upcoming);
      return true;
    }
    queued = [];
    if (state === 'idle') {
      await start(piece.from, piece);
    } else {
      range = piece;
      restartAt(piece.from);
    }
    return true;
  }

  /** Показать, откуда начнётся чтение, не запуская его. */
  async function showCursor(target) {
    position = target;
    cursorShown = true;
    const page = await index.page(target.pageNumber);
    const sentence = page?.sentences[target.sentenceIndex];
    if (!sentence) return;
    clearHighlights();
    view().highlightSentence(page, target.sentenceIndex);
    const preview = cleanForSpeech(page.text.slice(sentence.start, sentence.end)).text;
    const short = preview.length > 50 ? `${preview.slice(0, 50)}…` : preview;
    setStatus(`Начну с «${short}» — нажмите ▶ или S`);
  }

  async function start(from, piece = null) {
    if (!index) {
      app.hud.show('Сначала откройте документ');
      return;
    }
    // Пока идёт щелчок или нажатие клавиши — разрешаем звук нейроголосу.
    engines.neuralFor()?.unlock();
    showBar(true);
    if (!voicesLoaded) await fillVoices();
    const picked = cursorShown ? position : null;
    position = from || (await positionFromSelection()) || picked || (await view().firstVisible());
    cursorShown = false;
    // Обычный старт — документ подряд; кусок — только выделенное.
    range = piece;
    queued = [];
    await loop();
  }

  /** Перескок во время чтения или паузы: прерываем фразу и читаем с новой позиции. */
  function restartAt(target) {
    position = target;
    pendingSegments = [];
    currentNote = null;
    noteSpeaking = false;
    noteCard.hide();
    // После паузы синтез остаётся «на паузе» и новую фразу не начнёт, пока не продолжить.
    if (state === 'paused') provider.resume();
    provider.cancel();
    loop();
  }

  function stopHeard() {
    if (heard.since) heard.ms += performance.now() - heard.since;
    heard.since = 0;
  }

  function pause() {
    if (state !== 'speaking') return;
    stopHeard();
    voiceStarted();
    provider.pause();
    noteCard.paused();
    mediaKeys.paused();
    state = 'paused';
    syncUi();
    setStatus('Пауза');
    // На паузе синтез не останавливается — добираем запас до нужного.
    prefetchAhead(upcoming);
    showBuffer();
  }

  function resume() {
    if (state !== 'paused') return;
    provider.resume();
    noteCard.resumed();
    mediaKeys.playing(bookTitle());
    if (heard.started) heard.since = performance.now();
    state = 'speaking';
    if (sentenceStatus) setStatus(sentenceStatus);
    syncUi();
  }

  /**
   * Скорость поменяли во время чтения. Нейроголос меняет её сразу, посреди
   * фразы: речь синтезирована на обычной скорости, ускоряет её проигрыватель.
   * Системный голос перечитывает фразу заново — у него это мгновенно.
   */
  function rateChanged() {
    if (state === 'idle') return;
    if (!provider.neural) {
      jump(0);
      return;
    }
    provider.setRate?.(getSetting('ttsRate'));
    setStatus(`Скорость ${Number(getSetting('ttsRate')).toFixed(1)}×`);
    prefetchAhead(upcoming); // на большей скорости запас нужен длиннее
  }

  function jump(delta) {
    if (state === 'idle') {
      start();
      return;
    }
    restartAt({ ...position, sentenceIndex: position.sentenceIndex + delta });
  }

  /**
   * Пропустить звучащее примечание: дальше — следующее примечание этой фразы
   * или следующая фраза. Заготовки впереди не сбрасываются — они уже готовы.
   */
  function skipNote() {
    if (!noteSpeaking) return false;
    noteSkipped = true;
    noteCard.hide();
    if (state === 'paused') resume();
    if (provider.skip) provider.skip();
    else provider.cancel();
    return true;
  }

  /**
   * «Не читать это»: примечание выключено у книги — пропускаем его сейчас и
   * не читаем больше (и в аудиокниге). Вернуть — в списке примечаний.
   */
  async function muteNote(note = currentNote) {
    if (!note?.text) return;
    if (currentNote?.text === note.text) skipNote();
    const saved = await noteFilter.set([note.text], true);
    app.hud.show(saved ? 'Это примечание больше не читается. Вернуть — «Какие примечания читать…»' : 'Не получилось запомнить выбор: документа нет в библиотеке', {
      duration: 4000,
    });
    notesChanged();
  }

  /** Выбор примечаний поменялся — звучащее выключенное пропускаем, заготовки подстраиваем. */
  function notesChanged() {
    if (state === 'idle') return;
    if (noteSpeaking && currentNote && noteFilter.isMuted(currentNote.text)) skipNote();
    prefetchAhead(upcoming);
  }

  /** Окно «Какие примечания читать»: все примечания книги с галочками. */
  function pickNotes() {
    return notePicker.open();
  }

  /** «Дальше»: во время примечания — пропустить его, иначе — следующее предложение. */
  function next() {
    if (!skipNote()) jump(1);
  }

  /**
   * Переозвучить фразу: TeraTTS иногда «дребезжит» на гласной, и многое
   * решает начальный шум модели. Фраза синтезируется с другим шумом и
   * звучит заново; выбор запоминается (tera-provider.js, revoice).
   */
  function revoice() {
    if (state === 'idle' || !provider?.revoice || !currentText) {
      app.hud.show('Переозвучить можно фразу голоса TeraTTS, пока она звучит');
      return;
    }
    provider.revoice(currentText, speechOptions());
    app.hud.show('Переозвучиваю фразу — прозвучит чуть иначе. Не понравится — нажмите ещё раз');
    restartAt({ ...position });
  }

  on($('btnSpeak'), 'click', () => {
    if (bar.hidden) showBar(true);
    else toggle();
  });
  on($('ttsPlay'), 'click', () => toggle());
  on($('ttsStop'), 'click', () => finish());
  on($('ttsNext'), 'click', () => next());
  on($('ttsRevoice'), 'click', () => revoice());
  on($('ttsPrev'), 'click', () => jump(-1));
  // Закрыть панель — значит закончить: и чтение, и подсветку на тексте.
  on($('ttsClose'), 'click', () => {
    finish();
    showBar(false);
  });
  on($('ttsVoice'), 'change', async () => {
    const select = $('ttsVoice');
    const voiceId = select.value;
    const engine = engines.neuralFor(voiceId);
    if (engine) {
      engine.unlock();
      if (!(await engine.isInstalled(voiceId)) && !(await offerDownload(voiceId))) {
        select.value = getSetting('ttsVoiceUri');
        return;
      }
    }
    await updateSettings({ ttsVoiceUri: voiceId });
    switchProvider();
    engine?.preload?.();
    if (state !== 'idle') jump(0);
  });
  on($('ttsRate'), 'input', async () => {
    await updateSettings({ ttsRate: Number($('ttsRate').value) });
    syncUi();
    // Нейроголос слышно на новой скорости, пока ползунок ещё тянут.
    if (state !== 'idle' && provider.neural) provider.setRate?.(getSetting('ttsRate'));
  });
  on($('ttsRate'), 'change', () => rateChanged());
  // Громкость: нейроголос меняет её сразу, посреди фразы; системный голос —
  // со следующей фразы (громкость у него задаётся фразе целиком).
  on($('ttsVolume'), 'input', async () => {
    const volume = Number($('ttsVolume').value);
    await updateSettings({ ttsVolume: volume });
    syncUi();
    if (state === 'idle') return;
    if (provider.setVolume) provider.setVolume(volume * sleepTimer.volumeFactor());
    else setStatus(`Громкость ${Math.round(volume * 100)} % — со следующей фразы`);
  });
  on($('ttsPitch'), 'input', async () => {
    await updateSettings({ ttsPitch: Number($('ttsPitch').value) });
    syncUi();
  });

  // Щелчок по тексту при открытой панели озвучки выбирает, откуда читать;
  // во время чтения — сразу перескакивает туда. Alt+щелчок работает всегда.
  function wantsPick(event) {
    if (!index || (bar.hidden && !event.altKey)) return false;
    if (event.button !== 0 || window.getSelection()?.toString()) return false; // текст выделяют, а не выбирают место
    return !event.target.closest('a, button, input, select, .annotationLayer section');
  }

  async function pickAt(target, event) {
    // Щелчок по тексту — читать отсюда подряд, а не выделенные куски.
    range = null;
    queued = [];
    if (state !== 'idle') restartAt(target);
    else if (event.altKey) await start(target);
    else await showCursor(target);
  }

  on(app.container, 'click', async (event) => {
    if (!wantsPick(event)) return;
    const point = textPointAt(app, event.clientX, event.clientY, event.target);
    if (!point) return;
    const offset = await index.offsetForSpan(point.pageNumber, point.spanIndex, point.offsetInSpan);
    await pickAt(
      { pageNumber: point.pageNumber, sentenceIndex: await index.sentenceIndexAt(point.pageNumber, offset) },
      event
    );
  });

  // В режиме «только текст» предложение и есть элемент — номер берём из него.
  on($('reflowContainer'), 'click', async (event) => {
    if (!wantsPick(event)) return;
    const target = app.reflow?.positionOfNode(event.target);
    if (target) await pickAt(target, event);
  });

  function buildIndex(pdfDocument) {
    const built = new TextIndex(pdfDocument, { skipFurniture: getSetting('ttsSkipFurniture') });
    // Режиму «только текст» нужен тот же индекс: те же предложения, те же номера.
    queueMicrotask(() => app.eventBus.dispatch('textindexchanged', { source: app, index: built }));
    return built;
  }

  app.eventBus.on('documentopened', ({ pdfDocument }) => {
    finish();
    sleepTimer.reset();
    index = buildIndex(pdfDocument);
    wordJoiner = newWordJoiner();
    voicesLoaded = false;
    setStatus('');
  });

  // Перерисовка страницы стирает наш слой подсветки — восстанавливаем.
  app.eventBus.on('pagerendered', ({ pageNumber }) => {
    if (app.reflow?.active) return;
    if ((state === 'idle' && !cursorShown) || pageNumber !== position.pageNumber) return;
    index?.page(pageNumber).then((page) => {
      if (page) pdfView.highlightSentence(page, position.sentenceIndex, { scroll: false });
    });
  });

  // Переключили вид посреди чтения — подсветка переезжает вместе с ним.
  app.eventBus.on('viewmodechanged', () => {
    if (state === 'idle' && !cursorShown) return;
    clearHighlights();
    index?.page(position.pageNumber).then((page) => {
      if (page) view().highlightSentence(page, position.sentenceIndex);
    });
  });

  // Вернулись на вкладку с открытой панелью озвучки: пока вкладка была в фоне,
  // голос мог выгрузиться из памяти — грузим его заново сразу, а не по «Читать».
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && (!bar.hidden || state !== 'idle')) engines.neuralFor()?.preload?.();
  });

  // Страницу распознали — её текст другой, перечитываем при следующем обращении.
  app.eventBus.on('ocrpagedone', ({ pageNumber }) => index?.forget(pageNumber));

  // Своё ударение исправили — заготовки впереди синтезируются заново.
  onUserStressChange(() => {
    if (state !== 'idle') prefetchAhead(upcoming);
  });

  onSettingsChanged(async (_all, changed) => {
    // Другой состав текста — другие предложения: индекс строим заново.
    if ('ttsSkipFurniture' in changed && index) {
      finish();
      index = buildIndex(index.pdfDocument);
    }
    if ('ttsBufferMinutes' in changed && state !== 'idle') prefetchAhead(upcoming);
    // Другая версия моделей TeraTTS или другой синтез: выгружаем, следующая фраза загрузит нужное.
    if ('teraQuality' in changed || 'teraUseHelper' in changed) {
      if (provider === tera) finish();
      tera.unload();
    }
    if ('ttsProvider' in changed || 'ttsHttpUrl' in changed) {
      finish();
      engines.resetSystem();
      provider = pickProvider();
      voicesLoaded = false;
      await fillVoices();
    }
  });

  function toggle() {
    if (state === 'speaking') pause();
    else if (state === 'paused') resume();
    else start();
  }

  provider = pickProvider();
  syncUi();

  return {
    start,
    stop: finish,
    piper,
    tera,
    /** Все движки — скачивание голосов из настроек идёт через них (engines.js). */
    engines,
    /** Какой движок сейчас говорит: web-speech, http, piper или tera. */
    get engine() {
      return provider?.id ?? null;
    },
    /** Перечитать список голосов — после загрузки или удаления нейроголоса. */
    async refreshVoices() {
      await fillVoices();
    },
    toggle,
    pause,
    resume,
    speakSelection,
    speakPiece,
    /**
     * Место выделения в документе: { from, to } — считать сразу, пока
     * текстовый слой тот же (его перерисовка обрывает сохранённый Range).
     */
    pieceOfRange: rangeOfSelection,
    /** Сколько кусков выделенного ждёт очереди (для проверок и панели). */
    get queued() {
      return queued.length;
    },
    next,
    previous: () => jump(-1),
    skipNote,
    muteNote,
    pickNotes,
    /** Какие примечания читать (выключенные — note-picker.js). */
    notes: noteFilter,
    revoice,
    /** Звучит примечание (окошко на экране). */
    get noteSpeaking() {
      return noteSpeaking;
    },
    async adjustRate(delta) {
      const rate = Math.min(3, Math.max(0.5, Number((getSetting('ttsRate') + delta).toFixed(2))));
      await updateSettings({ ttsRate: rate });
      syncUi();
      app.hud.show(`Скорость речи ${rate.toFixed(1)}×`);
      rateChanged();
    },
    get isSpeaking() {
      return state === 'speaking';
    },
    get state() {
      return state;
    },
    get position() {
      return { ...position };
    },
    /** Восстановление места чтения из библиотеки. */
    setPosition(next) {
      if (next?.pageNumber) position = { pageNumber: next.pageNumber, sentenceIndex: next.sentenceIndex || 0 };
    },
    get textIndex() {
      return index;
    },
    /** Открыта панель озвучки — щелчок по тексту выбирает место старта. */
    get pickMode() {
      return !bar.hidden;
    },
    showBar,
    utterancesOf,
    /** Нейроголос, выбранный на панели, — только он умеет синтезировать в файл. */
    neuralVoice() {
      const voiceId = getSetting('ttsVoiceUri');
      const engine = engines.neuralFor(voiceId);
      return engine?.render ? { engine, voiceId, name: $('ttsVoice').selectedOptions?.[0]?.textContent ?? voiceId } : null;
    },
    lastHighlight: (kind) => highlighter.lastText(kind),
    sleepTimer,
  };
}
