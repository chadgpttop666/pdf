// Озвучка документа. Контроллер держит очередь предложений, ведёт подсветку
// и прокрутку за читаемым местом, а сам синтез делегирует провайдеру —
// системному или внешнему по HTTP, интерфейс у них одинаковый.

import { $, clear, el, on } from '../dom.js';
import { get as getSetting, onSettingsChanged, updateSettings } from '../settings.js';
import { TextIndex, cleanForSpeech } from '../text-index.js';
import { createHighlighter } from './highlighter.js';
import { createHttpProvider } from './http-provider.js';
import { createWebSpeechProvider } from './web-speech.js';
import { createSleepTimer } from './sleep-timer.js';
import { firstVisibleSpanIndex, offsetInSpan, textPointAt, textSpanOf, textSpansOfPage } from '../visible-text.js';

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function createTts(app) {
  const bar = $('ttsBar');
  const highlighter = createHighlighter(app);
  const sleepTimer = createSleepTimer({
    select: $('ttsSleep'),
    label: $('ttsSleepLeft'),
    chapterEndAfter: (pageNumber) => app.outline?.nextChapterStart(pageNumber) ?? null,
  });

  let index = null;
  let provider = null;
  let state = 'idle'; // idle | speaking | paused
  let generation = 0;
  let position = { pageNumber: 1, sentenceIndex: 0 };
  let voicesLoaded = false;
  let cursorShown = false; // место старта выбрано щелчком, но чтение ещё не началось

  const PICK_HINT = 'Щёлкните по тексту — начну читать с этого места';

  /** Пока панель озвучки открыта, щелчок по тексту выбирает место старта. */
  function showBar(visible) {
    bar.hidden = !visible;
    app.el.classList.toggle('tts-picking', visible);
    if (visible && state === 'idle' && !cursorShown) setStatus(PICK_HINT);
    if (!visible && state === 'idle') clearCursor();
  }

  function clearCursor() {
    if (!cursorShown) return;
    cursorShown = false;
    highlighter.clear();
  }

  function currentProvider() {
    const kind = getSetting('ttsProvider');
    if (kind === 'http') return createHttpProvider({ url: getSetting('ttsHttpUrl') });
    return createWebSpeechProvider();
  }

  function speechOptions() {
    return {
      voiceId: getSetting('ttsVoiceUri') || undefined,
      rate: getSetting('ttsRate'),
      pitch: getSetting('ttsPitch'),
      volume: getSetting('ttsVolume'),
      lang: index?.language === 'ru' ? 'ru-RU' : index?.language || undefined,
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
    $('ttsPitchValue').textContent = Number(getSetting('ttsPitch')).toFixed(1);
    app.el.classList.toggle('speaking', playing);
  }

  async function fillVoices() {
    const select = $('ttsVoice');
    const list = await provider.voices();
    voicesLoaded = true;
    clear(select);

    if (!list.length) {
      select.append(el('option', { value: '' }, 'голосов не найдено'));
      setStatus(
        getSetting('ttsProvider') === 'http'
          ? 'Внешний движок не вернул список голосов'
          : 'Система не предоставила голоса синтеза'
      );
      return;
    }

    // Голоса языка документа показываем первыми — их обычно и выбирают.
    const documentLang = index?.language || 'ru';
    const sorted = [...list].sort((a, b) => {
      const aMatch = (a.lang || '').toLowerCase().startsWith(documentLang) ? 0 : 1;
      const bMatch = (b.lang || '').toLowerCase().startsWith(documentLang) ? 0 : 1;
      return aMatch - bMatch || a.name.localeCompare(b.name);
    });

    for (const voice of sorted) {
      select.append(el('option', { value: voice.id }, `${voice.name}${voice.lang ? ` (${voice.lang})` : ''}`));
    }

    const stored = getSetting('ttsVoiceUri');
    const chosen = sorted.find((voice) => voice.id === stored) || sorted[0];
    select.value = chosen.id;
    if (chosen.id !== stored) await updateSettings({ ttsVoiceUri: chosen.id });
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

  async function ensurePageVisible(pageNumber) {
    if (app.pdfViewer.currentPageNumber === pageNumber) return;
    app.pdfViewer.scrollPageIntoView({ pageNumber });
    // Страница могла быть выгружена — ждём её отрисовки, но недолго.
    await Promise.race([
      new Promise((resolve) => {
        const handler = (event) => {
          if (event.pageNumber === pageNumber) {
            app.eventBus.off('pagerendered', handler);
            resolve();
          }
        };
        app.eventBus.on('pagerendered', handler);
      }),
      delay(600),
    ]);
  }

  function highlightSentence(page, sentence) {
    return highlighter.highlight(page.pageNumber, page.entries, sentence, { kind: 'sentence' });
  }

  function highlightWord(page, sentence, map, { charIndex, charLength }) {
    if (!getSetting('ttsHighlightWords')) return;
    const startOffset = map[charIndex];
    if (startOffset === undefined) return;
    const lastIndex = charLength ? Math.min(map.length - 1, charIndex + charLength - 1) : charIndex;
    const endOffset = (map[lastIndex] ?? startOffset) + 1;
    highlighter.highlight(
      page.pageNumber,
      page.entries,
      { start: sentence.start + startOffset, end: sentence.start + endOffset },
      { kind: 'word' }
    );
  }

  async function loop() {
    const myGeneration = ++generation;
    state = 'speaking';
    syncUi();
    app.wakeLock?.request();

    try {
      while (state !== 'idle' && myGeneration === generation) {
        const page = await index.page(position.pageNumber);
        if (!page) break;

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

        const sentence = page.sentences[position.sentenceIndex];
        const raw = page.text.slice(sentence.start, sentence.end);
        const { text, map } = cleanForSpeech(raw);
        // «* * *» и прочие разделители читать вслух незачем.
        if (!/[\p{L}\p{N}]/u.test(text)) {
          position.sentenceIndex += 1;
          continue;
        }

        sleepTimer.arm(page.pageNumber);
        if (sleepTimer.shouldStop(page.pageNumber)) {
          sleepTimer.reset();
          finish('Таймер сна: чтение остановлено');
          return;
        }

        await ensurePageVisible(page.pageNumber);
        if (myGeneration !== generation) return;

        const bounds = highlightSentence(page, sentence);
        follow(bounds);
        setStatus(`Стр. ${page.pageNumber}, предложение ${position.sentenceIndex + 1} из ${page.sentences.length}`);

        const options = speechOptions();
        const result = await provider.speak(text, {
          ...options,
          volume: options.volume * sleepTimer.volumeFactor(),
          onBoundary: (event) => highlightWord(page, sentence, map, event),
        });

        if (myGeneration !== generation || state === 'idle') return;
        if (result === 'cancelled') return;

        highlighter.clearWords(page.pageNumber);
        const pause = getSetting('ttsSentencePauseMs');
        if (pause) await delay(pause);
        position.sentenceIndex += 1;
      }
    } catch (error) {
      console.error('Ошибка озвучки', error);
      app.hud.show(`Озвучка: ${error.message || error}`, { duration: 5000 });
      finish();
    }
  }

  function finish(message) {
    state = 'idle';
    cursorShown = false;
    sleepTimer.disarm();
    generation += 1;
    provider?.cancel();
    highlighter.clear();
    if (!app.autoScroll?.running) app.wakeLock?.release();
    syncUi();
    // После остановки панель снова подсказывает, как выбрать место.
    setStatus(message || (bar.hidden ? '' : PICK_HINT));
    if (message) app.hud.show(message);
  }

  /** Начальная позиция чтения — первое предложение, видимое на экране. */
  async function positionFromViewport() {
    const pageNumber = app.pdfViewer.currentPageNumber || 1;
    const offset = await index.offsetForSpan(pageNumber, firstVisibleSpanIndex(app, pageNumber));
    return { pageNumber, sentenceIndex: await index.sentenceIndexAt(pageNumber, offset) };
  }

  /** Если в тексте что-то выделено, читать начинаем с начала выделения. */
  async function positionFromSelection() {
    const selection = window.getSelection();
    if (!selection || selection.isCollapsed || !selection.rangeCount) return null;
    const range = selection.getRangeAt(0); // начало диапазона всегда раньше конца
    const span = textSpanOf(range.startContainer);
    const pageNumber = Number(span?.closest('.page')?.dataset.pageNumber);
    if (!span || !pageNumber) return null;
    const spanIndex = textSpansOfPage(app, pageNumber).indexOf(span);
    if (spanIndex < 0) return null;
    const inSpan =
      range.startContainer.nodeType === Node.TEXT_NODE ? offsetInSpan(span, range.startContainer, range.startOffset) : 0;
    const offset = await index.offsetForSpan(pageNumber, spanIndex, inSpan);
    selection.removeAllRanges();
    return { pageNumber, sentenceIndex: await index.sentenceIndexAt(pageNumber, offset) };
  }

  /** Показать, откуда начнётся чтение, не запуская его. */
  async function showCursor(target) {
    position = target;
    cursorShown = true;
    const page = await index.page(target.pageNumber);
    const sentence = page?.sentences[target.sentenceIndex];
    if (!sentence) return;
    highlighter.clear();
    highlightSentence(page, sentence);
    const preview = cleanForSpeech(page.text.slice(sentence.start, sentence.end)).text;
    const short = preview.length > 50 ? `${preview.slice(0, 50)}…` : preview;
    setStatus(`Начну с «${short}» — нажмите ▶ или S`);
  }

  async function start(from) {
    if (!index) {
      app.hud.show('Сначала откройте документ');
      return;
    }
    showBar(true);
    if (!voicesLoaded) await fillVoices();
    const picked = cursorShown ? position : null;
    position = from || (await positionFromSelection()) || picked || (await positionFromViewport());
    cursorShown = false;
    await loop();
  }

  /** Перескок во время чтения или паузы: прерываем фразу и читаем с новой позиции. */
  function restartAt(target) {
    position = target;
    // После паузы синтез остаётся «на паузе» и новую фразу не начнёт, пока не продолжить.
    if (state === 'paused') provider.resume();
    provider.cancel();
    loop();
  }

  function pause() {
    if (state !== 'speaking') return;
    provider.pause();
    state = 'paused';
    syncUi();
    setStatus('Пауза');
  }

  function resume() {
    if (state !== 'paused') return;
    provider.resume();
    state = 'speaking';
    syncUi();
  }

  function jump(delta) {
    if (state === 'idle') {
      start();
      return;
    }
    restartAt({ ...position, sentenceIndex: position.sentenceIndex + delta });
  }

  on($('btnSpeak'), 'click', () => {
    if (bar.hidden) showBar(true);
    else toggle();
  });
  on($('ttsPlay'), 'click', () => toggle());
  on($('ttsStop'), 'click', () => finish());
  on($('ttsNext'), 'click', () => jump(1));
  on($('ttsPrev'), 'click', () => jump(-1));
  on($('ttsClose'), 'click', () => showBar(false));
  on($('ttsVoice'), 'change', async () => {
    await updateSettings({ ttsVoiceUri: $('ttsVoice').value });
    if (state !== 'idle') jump(0);
  });
  on($('ttsRate'), 'input', async () => {
    await updateSettings({ ttsRate: Number($('ttsRate').value) });
    syncUi();
  });
  on($('ttsRate'), 'change', () => {
    if (state !== 'idle') jump(0);
  });
  on($('ttsPitch'), 'input', async () => {
    await updateSettings({ ttsPitch: Number($('ttsPitch').value) });
    syncUi();
  });

  // Щелчок по тексту при открытой панели озвучки выбирает, откуда читать;
  // во время чтения — сразу перескакивает туда. Alt+щелчок работает всегда.
  on(app.container, 'click', async (event) => {
    if (!index || (bar.hidden && !event.altKey)) return;
    if (event.button !== 0 || window.getSelection()?.toString()) return; // текст выделяют, а не выбирают место
    if (event.target.closest('a, button, input, select, .annotationLayer section')) return;

    const point = textPointAt(app, event.clientX, event.clientY, event.target);
    if (!point) return;
    const offset = await index.offsetForSpan(point.pageNumber, point.spanIndex, point.offsetInSpan);
    const target = {
      pageNumber: point.pageNumber,
      sentenceIndex: await index.sentenceIndexAt(point.pageNumber, offset),
    };

    if (state !== 'idle') restartAt(target);
    else if (event.altKey) await start(target);
    else await showCursor(target);
  });

  function buildIndex(pdfDocument) {
    return new TextIndex(pdfDocument, { skipFurniture: getSetting('ttsSkipFurniture') });
  }

  app.eventBus.on('documentopened', ({ pdfDocument }) => {
    finish();
    sleepTimer.reset();
    index = buildIndex(pdfDocument);
    voicesLoaded = false;
    setStatus('');
  });

  // Перерисовка страницы стирает наш слой подсветки — восстанавливаем.
  app.eventBus.on('pagerendered', ({ pageNumber }) => {
    if ((state === 'idle' && !cursorShown) || pageNumber !== position.pageNumber) return;
    index?.page(pageNumber).then((page) => {
      const sentence = page?.sentences[position.sentenceIndex];
      if (sentence) highlightSentence(page, sentence);
    });
  });

  onSettingsChanged(async (_all, changed) => {
    // Другой состав текста — другие предложения: индекс строим заново.
    if ('ttsSkipFurniture' in changed && index) {
      finish();
      index = buildIndex(index.pdfDocument);
    }
    if ('ttsProvider' in changed || 'ttsHttpUrl' in changed) {
      finish();
      provider = currentProvider();
      voicesLoaded = false;
      await fillVoices();
    }
  });

  function toggle() {
    if (state === 'speaking') pause();
    else if (state === 'paused') resume();
    else start();
  }

  provider = currentProvider();
  syncUi();

  return {
    start,
    stop: finish,
    toggle,
    pause,
    resume,
    next: () => jump(1),
    previous: () => jump(-1),
    async adjustRate(delta) {
      const rate = Math.min(3, Math.max(0.5, Number((getSetting('ttsRate') + delta).toFixed(2))));
      await updateSettings({ ttsRate: rate });
      syncUi();
      app.hud.show(`Скорость речи ${rate.toFixed(1)}×`);
      if (state !== 'idle') jump(0);
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
    lastHighlight: (kind) => highlighter.lastText(kind),
    sleepTimer,
  };
}
