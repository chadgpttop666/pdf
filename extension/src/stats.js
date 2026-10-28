// Статистика чтения: активное время и пройденный текст по дням, скорость,
// оценка «сколько осталось до конца главы и книги».
//
// Время считается, только когда вкладка видна и читатель что-то делает
// (листает, прокручивает, слушает озвучку); простой дольше двух минут не
// считается. Прочитанный текст — продвижение места чтения вперёд, если оно
// по скорости похоже на чтение, а не на пролистывание или переход по
// оглавлению. Всё хранится только в браузере.

import { $, clear, el, on } from './dom.js';
import * as library from './library.js';
import { get as getSetting, onSettingsChanged } from './settings.js';
import { pageOffsetRatio } from './visible-text.js';
import {
  CHARS_PER_WORD,
  DEFAULT_LISTENING_SPEED,
  DEFAULT_READING_SPEED,
  IDLE_LIMIT_MS,
  STANDARD_PAGE,
  charsBetween,
  dayKey,
  emptyDay,
  formatCount,
  formatDuration,
  formatEta,
  hasActivity,
  lastDays,
  mergeDays,
  normalizePosition,
  plausibleReading,
  remainingChars,
  speedOf,
  streakDays,
} from './stats-math.js';

const TICK_MS = 5000;
const STASH_PREFIX = 'pdf-reader:stats-pending:';
const TAB_ID = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
const LOCK_NAME = 'pdf-reader-stats';
const FLUSH_MS = 30000;
const SPEED_WINDOW_DAYS = 30;
const SAMPLE_PAGES = 12;
const MINUTE = 60 * 1000;

const WEEKDAY = new Intl.DateTimeFormat('ru-RU', { weekday: 'short' });
const DAY_MONTH = new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'short' });

export function createStats(app) {
  const dialog = $('statsDialog');
  const body = $('statsBody');
  const chip = $('readingEta');
  const chipText = $('readingEtaText');

  const days = new Map(); // ключ дня → запись из базы, со всех вкладок
  let pending = emptyDay(dayKey()); // насчитано этой вкладкой и ещё не записано
  let lastTick = Date.now();
  let lastFlush = Date.now();
  let lastActivity = 0;
  let counted = null; // место, до которого прочитанное уже учтено
  let bankMs = 0; // активное время чтения с тех пор
  let averageChars = null; // знаков на средней странице текущего документа
  let docId = null;
  let busy = false;
  let stashSeq = 0;

  const enabled = () => getSetting('statsEnabled');
  const index = () => app.tts?.textIndex;
  const pagesCount = () => app.pdfViewer.pagesCount || 0;

  async function charsOf(pageNumber) {
    if (pageNumber < 1 || pageNumber > pagesCount()) return 0;
    return (await index()?.page(pageNumber))?.text.length ?? 0;
  }

  // ── Записи по дням ───────────────────────────────────────────────────
  //
  // Каждая вкладка копит своё приращение и прибавляет его к записи дня.
  // Перед записью приращение кладётся в localStorage: это синхронно и
  // успевает даже при закрытии вкладки, когда IndexedDB уже не дописывает.
  // Отложенное подберёт следующий запуск. Разбор очереди идёт под Web Lock,
  // чтобы две вкладки не прибавили одно и то же дважды.

  /** Запись дня вместе с тем, что эта вкладка ещё не записала. */
  function dayView(key) {
    const stored = days.get(key);
    if (pending.day !== key) return stored ?? null;
    return mergeDays(stored ?? emptyDay(key), pending);
  }

  function knownDays() {
    const keys = new Set(days.keys());
    keys.add(pending.day);
    return new Map([...keys].map((key) => [key, dayView(key)]));
  }

  function docEntry() {
    const record = app.readingState.record;
    const entry = (pending.docs[docId] ??= { ms: 0, chars: 0 });
    entry.title = record?.title || record?.name || entry.title;
    return entry;
  }

  /** Синхронно отложить приращение. */
  function stash() {
    const delta = pending;
    pending = emptyDay(dayKey());
    if (!hasActivity(delta)) return;
    try {
      localStorage.setItem(`${STASH_PREFIX}${TAB_ID}-${(stashSeq += 1)}`, JSON.stringify(delta));
    } catch {
      // Хранилище недоступно — пишем сразу, без страховки.
      library.addStatsDay(delta).then((saved) => days.set(saved.day, saved), () => {});
    }
  }

  function stashedKeys() {
    try {
      return Object.keys(localStorage).filter((key) => key.startsWith(STASH_PREFIX));
    } catch {
      return [];
    }
  }

  /** Перенести отложенное в базу; ключ убираем только после записи. */
  async function drain() {
    const work = async () => {
      for (const key of stashedKeys()) {
        let delta = null;
        try {
          delta = JSON.parse(localStorage.getItem(key));
        } catch {
          /* битая запись */
        }
        if (delta?.day) {
          const saved = await library.addStatsDay(delta);
          days.set(saved.day, saved);
        }
        localStorage.removeItem(key);
      }
    };
    try {
      if (navigator.locks) await navigator.locks.request(LOCK_NAME, work);
      else await work();
    } catch (error) {
      console.warn('Не удалось сохранить статистику', error);
    }
  }

  async function flush() {
    lastFlush = Date.now();
    stash();
    await drain();
  }

  async function reloadDays() {
    const stored = await library.listStatsDays().catch(() => []);
    days.clear();
    for (const record of stored) days.set(record.day, { ...emptyDay(record.day), ...record });
  }

  function rollover() {
    if (pending.day !== dayKey()) flush();
  }

  drain()
    .then(reloadDays)
    .then(() => updateEta())
    .catch((error) => console.warn('Статистика недоступна', error));

  // ── Учёт времени и прочитанного ──────────────────────────────────────

  function currentPosition() {
    if (app.reflow?.active) return app.reflow.position();
    return pagesCount() ? pageOffsetRatio(app) : null;
  }

  async function trackProgress() {
    const position = normalizePosition(currentPosition());
    if (!position) return;
    if (!counted) {
      counted = position;
      bankMs = 0;
      return;
    }
    const chars = await charsBetween(counted, position, charsOf);
    if (chars === null) {
      counted = position; // прыжок по оглавлению или поиску
      bankMs = 0;
    } else if (chars > 0) {
      if (plausibleReading(chars, bankMs)) {
        pending.readChars += chars;
        docEntry().chars += chars;
      }
      counted = position;
      bankMs = 0;
    } else if (position.pageNumber < counted.pageNumber || position.offsetRatio < counted.offsetRatio) {
      counted = position; // вернулись перечитать — время копится дальше
    }
  }

  async function tick() {
    const now = Date.now();
    const elapsed = Math.min(now - lastTick, TICK_MS * 2);
    lastTick = now;
    if (busy || !enabled() || !docId || document.visibilityState !== 'visible') return;
    busy = true;
    try {
      rollover();
      const listening = app.tts?.state === 'speaking';
      const reading = !listening && (app.autoScroll?.running || now - lastActivity < IDLE_LIMIT_MS);
      if (listening) {
        pending.listenMs += elapsed;
        docEntry().ms += elapsed;
        counted = null; // за озвучкой вид едет сам — это не чтение глазами
      } else if (reading) {
        pending.readMs += elapsed;
        docEntry().ms += elapsed;
        bankMs += elapsed;
        const position = normalizePosition(currentPosition());
        // Скан или картинка: время есть, а текста нет — в скорость не берём.
        if (position && (await charsOf(position.pageNumber)) === 0) pending.noTextMs += elapsed;
        await trackProgress();
      }
      if (now - lastFlush >= FLUSH_MS) await flush();
      await updateEta();
    } finally {
      busy = false;
    }
  }

  const markActive = () => {
    lastActivity = Date.now();
  };
  for (const type of ['wheel', 'keydown', 'pointerdown', 'touchstart']) {
    on(window, type, markActive, { capture: true, passive: true });
  }
  for (const container of [app.container, $('reflowContainer')]) on(container, 'scroll', markActive, { passive: true });

  app.eventBus.on('ttssentencespoken', ({ chars }) => {
    if (!enabled() || !docId) return;
    pending.listenChars += chars;
    docEntry().chars += chars;
  });

  setInterval(tick, TICK_MS);
  on(document, 'visibilitychange', () => {
    if (document.visibilityState === 'hidden') flush();
    lastTick = Date.now(); // время в фоне не считаем
  });
  on(window, 'pagehide', stash);

  // ── Документ ─────────────────────────────────────────────────────────

  app.eventBus.on('documentopened', () => {
    flush();
    docId = null;
    counted = null;
    bankMs = 0;
    averageChars = null;
    chip.hidden = true;
  });
  app.readingState.onChange(() => {
    const id = app.readingState.documentId;
    if (id === docId) return;
    docId = id;
    lastActivity = Date.now(); // открыть документ — уже начать читать
    updateEta();
  });
  app.eventBus.on('textindexchanged', () => setTimeout(sampleAverage, 1500));
  let resampleTimer = 0;
  app.eventBus.on('ocrpagedone', () => {
    clearTimeout(resampleTimer);
    resampleTimer = setTimeout(sampleAverage, 2000);
  });
  app.eventBus.on('pagechanging', () => updateEta());
  app.eventBus.on('viewmodechanged', () => {
    counted = null;
    updateEta();
  });

  /** Средняя страница по равномерной выборке — для оценки остатка книги. */
  async function sampleAverage() {
    const sampled = index();
    const total = pagesCount();
    if (!sampled || !total) return;
    const count = Math.min(SAMPLE_PAGES, total);
    const pages = new Set();
    for (let i = 0; i < count; i += 1) pages.add(1 + Math.round((i * (total - 1)) / Math.max(1, count - 1)));
    const counts = [];
    for (const pageNumber of pages) {
      counts.push(await charsOf(pageNumber));
      if (sampled !== index()) return; // пока считали, открыли другой документ
    }
    // Пустые страницы — обычно ещё не распознанные сканы: по ним среднее занизится.
    const withText = counts.filter((count) => count > 0);
    averageChars = withText.length ? withText.reduce((sum, count) => sum + count, 0) / withText.length : 0;
    updateEta();
  }

  // ── Скорость и остаток ───────────────────────────────────────────────

  function recentDays() {
    return lastDays(SPEED_WINDOW_DAYS)
      .map(dayView)
      .filter(Boolean)
      .map((day) => ({ ...day, textMs: Math.max(0, day.readMs - (day.noTextMs || 0)) }));
  }

  function readingSpeed() {
    return speedOf(recentDays(), { msKey: 'textMs', charsKey: 'readChars' });
  }

  function listeningSpeed() {
    return speedOf(recentDays(), { msKey: 'listenMs', charsKey: 'listenChars', minMs: MINUTE, minChars: 500 });
  }

  async function ttsPosition() {
    const { pageNumber, sentenceIndex } = app.tts.position || {};
    const page = pageNumber && (await index()?.page(pageNumber));
    if (!page) return null;
    const start = page.sentences[sentenceIndex]?.start ?? 0;
    return { pageNumber, offsetRatio: page.text.length ? start / page.text.length : 0 };
  }

  /** Остаток до конца главы и книги в знаках и минутах. */
  async function estimate() {
    if (averageChars === null || !pagesCount()) return null;
    const listening = app.tts?.state === 'speaking' || app.tts?.state === 'paused';
    const position = normalizePosition(listening ? await ttsPosition() : currentPosition());
    if (!position) return null;

    const ownSpeed = listening ? listeningSpeed() : readingSpeed();
    const speed = ownSpeed ?? (listening ? DEFAULT_LISTENING_SPEED * (getSetting('ttsRate') || 1) : DEFAULT_READING_SPEED);
    const currentChars = await charsOf(position.pageNumber);
    const book = remainingChars({ ...position, currentChars, endPage: pagesCount(), averageChars });
    const nextChapter = app.outline?.nextChapterStart(position.pageNumber) ?? null;
    const inChapter = nextChapter !== null || app.outline?.chapterTitleAt(position.pageNumber) != null;
    const chapter = inChapter
      ? remainingChars({ ...position, currentChars, endPage: (nextChapter ?? pagesCount() + 1) - 1, averageChars })
      : null;
    const toMs = (chars) => (chars / speed) * MINUTE;
    return {
      listening,
      speed,
      ownSpeed: ownSpeed !== null,
      position,
      bookMs: toMs(book),
      chapterMs: chapter === null ? null : toMs(chapter),
    };
  }

  async function updateEta() {
    if (!enabled() || !docId) {
      chip.hidden = true;
      return;
    }
    const eta = await estimate();
    if (!eta) {
      chip.hidden = true;
      return;
    }
    chipText.textContent = eta.chapterMs === null ? formatEta(eta.bookMs) : `${formatEta(eta.chapterMs)} · ${formatEta(eta.bookMs)}`;
    const how = eta.listening ? 'со скоростью озвучки' : 'с вашей скоростью чтения';
    const basis = eta.ownSpeed ? `${formatCount(eta.speed)} знаков в минуту` : `пока по средней скорости, ${formatCount(eta.speed)} знаков в минуту`;
    chip.title = [
      eta.chapterMs === null ? null : `До конца главы ≈ ${formatDuration(eta.chapterMs)}`,
      `До конца книги ≈ ${formatDuration(eta.bookMs)}`,
      `Оценка ${how}: ${basis}.`,
      'Щёлкните — статистика чтения.',
    ]
      .filter(Boolean)
      .join('\n');
    chip.hidden = false;
  }

  onSettingsChanged((_all, changed) => {
    if ('statsEnabled' in changed) updateEta();
  });

  // ── Окно статистики ──────────────────────────────────────────────────

  function tile(label, value, note) {
    return el('div', { class: 'stats-tile' }, [
      el('div', { class: 'stats-label' }, label),
      el('div', { class: 'stats-value' }, value),
      note ? el('div', { class: 'stats-note' }, note) : null,
    ]);
  }

  function dayLabel(key) {
    const [year, month, day] = key.split('-').map(Number);
    return new Date(year, month - 1, day);
  }

  function dayBreakdown(record) {
    const parts = [`чтение ${formatDuration(record.readMs)}`];
    if (record.listenMs >= MINUTE / 2) parts.push(`озвучка ${formatDuration(record.listenMs)}`);
    return parts.join(', ');
  }

  /** Минуты по дням: один ряд, подписаны только сегодня и лучший день. */
  function weekChart() {
    const keys = lastDays(7);
    const week = keys.map((key) => dayView(key) ?? emptyDay(key));
    const minutes = week.map((day) => (day.readMs + day.listenMs) / MINUTE);
    const max = Math.max(...minutes);
    const best = max > 0 ? minutes.indexOf(max) : -1;

    const tooltip = el('div', { class: 'stats-tooltip', role: 'tooltip' });
    tooltip.hidden = true;
    const columns = el('div', { class: 'stats-columns' });
    week.forEach((day, i) => {
      const date = dayLabel(day.day);
      const isToday = i === week.length - 1;
      const total = formatDuration(day.readMs + day.listenMs);
      const text = minutes[i] > 0 ? `${total} — ${dayBreakdown(day)}` : 'не читали';
      const bar = el('div', { class: 'stats-bar' });
      bar.style.height = max > 0 ? `${(minutes[i] / max) * 100}%` : '0';
      const column = el('div', { class: `stats-column${isToday ? ' today' : ''}`, tabindex: '0', 'aria-label': `${DAY_MONTH.format(date)}: ${text}` }, [
        el('div', { class: 'stats-plot' }, [
          isToday || i === best ? el('span', { class: 'stats-cap' }, minutes[i] > 0 ? formatEta(minutes[i] * MINUTE) : '0') : null,
          bar,
        ]),
        el('div', { class: 'stats-day' }, isToday ? 'сегодня' : WEEKDAY.format(date)),
      ]);
      const show = () => {
        tooltip.textContent = `${DAY_MONTH.format(date)}: ${text}`;
        tooltip.hidden = false;
        const chartRect = columns.getBoundingClientRect();
        const rect = column.getBoundingClientRect();
        // Подсказка над столбцом, но не шире краёв диаграммы.
        const half = tooltip.offsetWidth / 2;
        const center = rect.left - chartRect.left + rect.width / 2;
        tooltip.style.left = `${Math.min(chartRect.width - half, Math.max(half, center))}px`;
      };
      on(column, 'pointerenter', show);
      on(column, 'focus', show);
      on(column, 'pointerleave', () => (tooltip.hidden = true));
      on(column, 'blur', () => (tooltip.hidden = true));
      columns.append(column);
    });

    // Табличный вид для экранного диктора.
    const table = el('table', { class: 'visually-hidden' }, [
      el('caption', {}, 'Время чтения по дням'),
      ...week.map((day) =>
        el('tr', {}, [el('th', {}, DAY_MONTH.format(dayLabel(day.day))), el('td', {}, formatDuration(day.readMs + day.listenMs))])
      ),
    ]);

    return el('section', { class: 'stats-chart' }, [
      el('h3', {}, 'Время за неделю'),
      el('div', { class: 'stats-chart-body' }, [columns, tooltip]),
      table,
    ]);
  }

  async function bookSection() {
    if (!docId) return null;
    let ms = 0;
    for (const day of knownDays().values()) ms += day.docs?.[docId]?.ms || 0;
    const eta = await estimate();
    const total = pagesCount();
    const page = eta?.position.pageNumber ?? app.pdfViewer.currentPageNumber;
    const percent = total ? Math.round(((page - 1 + (eta?.position.offsetRatio ?? 0)) / total) * 100) : 0;
    const record = app.readingState.record;
    const lines = [
      `Всего за книгой: ${formatDuration(ms)}`,
      `Пройдено ${percent} % — страница ${page} из ${total}`,
    ];
    if (eta) {
      if (eta.chapterMs !== null) lines.push(`До конца главы ≈ ${formatDuration(eta.chapterMs)}`);
      lines.push(`До конца книги ≈ ${formatDuration(eta.bookMs)}`);
    }
    const fill = el('div', { class: 'stats-progress-fill' });
    fill.style.width = `${percent}%`;
    return el('section', { class: 'stats-book' }, [
      el('h3', {}, record?.title || record?.name || 'Эта книга'),
      el('div', { class: 'stats-progress', role: 'progressbar', 'aria-valuenow': String(percent), 'aria-valuemin': '0', 'aria-valuemax': '100' }, [fill]),
      el('ul', {}, lines.map((line) => el('li', {}, line))),
    ]);
  }

  async function render() {
    const day = dayView(dayKey()) ?? emptyDay(dayKey());
    const read = day.readChars + day.listenChars;
    const reading = readingSpeed();
    const listening = listeningSpeed();
    const byDay = knownDays();

    const speedNote = reading
      ? `≈ ${Math.round(reading / CHARS_PER_WORD)} слов в минуту${listening ? `; озвучка — ${formatCount(listening)}` : ''}`
      : 'появится, когда почитаете минут пять';

    const tiles = el('div', { class: 'stats-tiles' }, [
      tile('Сегодня', formatDuration(day.readMs + day.listenMs), day.readMs + day.listenMs ? dayBreakdown(day) : 'ещё не читали'),
      tile('Прочитано сегодня', `≈ ${Math.round(read / STANDARD_PAGE)} стр.`, `${formatCount(read)} знаков; страница — ${STANDARD_PAGE} знаков`),
      tile('Скорость', reading ? [formatCount(reading), el('span', { class: 'stats-unit' }, ' зн/мин')] : '—', speedNote),
      tile('Дней подряд', String(streakDays(byDay)), 'день считается от минуты чтения'),
    ]);

    clear(body);
    body.append(tiles, weekChart());
    const book = await bookSection();
    if (book) body.append(book);
    body.append(
      el(
        'p',
        { class: 'stats-footnote' },
        'Время идёт, пока вкладка открыта и вы листаете, прокручиваете или слушаете; простой дольше двух минут не считается. ' +
          'Прочитанным считается продвижение по тексту со скоростью чтения — пролистывание и переходы по оглавлению не в счёт. ' +
          'Всё хранится только в этом браузере.'
      )
    );
    if (!enabled()) body.prepend(el('p', { class: 'stats-off' }, 'Статистика выключена в настройках — новые данные не записываются.'));
  }

  async function open() {
    await flush();
    await reloadDays(); // с записями других вкладок
    await render();
    if (!dialog.open) dialog.showModal();
  }

  on(chip, 'click', open);
  on($('welcomeStats'), 'click', open);
  on($('statsReset'), 'click', async () => {
    if (!window.confirm('Удалить всю статистику чтения? Закладки, выделения и место чтения останутся.')) return;
    for (const key of stashedKeys()) localStorage.removeItem(key);
    pending = emptyDay(dayKey());
    await library.clearStats();
    days.clear();
    await render();
    updateEta();
  });

  return {
    open,
    close: () => dialog.close(),
    flush,
    tick,
    estimate,
    get isOpen() {
      return dialog.open;
    },
    /** Сегодняшняя запись вместе с ещё не записанным. */
    get today() {
      return dayView(dayKey()) ?? emptyDay(dayKey());
    },
    /** Для тестов: сдвинуть «последнюю активность» в прошлое. */
    markIdle(ms = IDLE_LIMIT_MS + 1000) {
      lastActivity = Date.now() - ms;
    },
  };
}
