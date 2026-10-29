// Озвучка выделенного прямо на сайте. Фоновая страница вставляет этот
// скрипт в страницу, где выделен текст. Он собирает выделенное, подсвечивает
// на самой странице читаемую фразу и слово и ставит в углу маленькую плашку
// управления — страницу расширения speak-pill.html в iframe. Голос звучит
// из неё: нейроголосам нужны воркеры и файлы расширения, а у страницы сайта
// их нет.
//
// Текст собирается из текстовых узлов выделения вместе с картой «символ →
// место в узле»: по ней фраза, которую читает плашка, становится диапазоном
// на странице. Плашка и страница говорят через MessageChannel; канал плашка
// принимает только с секретом из своего адреса, его странице не узнать.
//
// Выделения копятся очередью: следующий кусок (мусор между ними можно не
// выделять) читается после предыдущего, а ещё не прочитанное слабо
// подсвечено на странице.
//
// Обычный (не модульный) скрипт: так его можно вставить в любую страницу.

(() => {
  if (globalThis.__pdfReaderSpeak) return;

  const SENTENCE = 'pdf-reader-speak-sentence';
  const WORD = 'pdf-reader-speak-word';
  const QUEUE = 'pdf-reader-speak-queue';
  const SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE']);
  const INLINE_DISPLAY = /^(inline|contents|ruby)/;
  // Пользователь сам листает — некоторое время страницу за чтением не тянем.
  const USER_SCROLL_PAUSE_MS = 5000;
  const PILL_WIDTH = 380;
  const PILL_HEIGHT = 56;

  // { host, frame, port, text, map, pieces: [{ start, end, first, last }], readTo }
  let session = null;
  let lastUserScroll = 0;
  // Последнее непустое выделение на странице: щелчок по «＋» в плашке может
  // его снять раньше, чем плашка попросит добавить кусок.
  let remembered = [];
  let selectionTimer = 0;

  const frameUrl = () => globalThis.__pdfReaderSpeakFrameUrl || browser.runtime.getURL('speak-pill.html');

  /** Стили через CSSOM: атрибут style и <style> страница может запретить своей политикой. */
  function css(element, properties) {
    for (const [name, value] of Object.entries(properties)) element.style.setProperty(name, value, 'important');
  }

  // ── Выделенный текст с картой символов ────────────────────────────────

  const hasText = (text) => /[\p{L}\p{N}]/u.test(text);
  const rangesOf = (selection) =>
    Array.from({ length: selection?.rangeCount ?? 0 }, (_, i) => selection.getRangeAt(i)).filter((range) => !range.collapsed);

  /**
   * @param ranges выделенные диапазоны (в Firefox их может быть несколько — с Ctrl)
   * @returns {{ text: string, map: Array<[Text, number]> }} абзацы — через
   *   '\n', пробелы схлопнуты; map[i] — узел и место i-го символа
   */
  function collect(ranges) {
    const chars = [];
    const map = [];
    const visibility = new Map();
    const blocks = new Map();
    const isVisible = (element) => {
      if (!visibility.has(element)) visibility.set(element, element.checkVisibility ? element.checkVisibility({ visibilityProperty: true }) : true);
      return visibility.get(element);
    };
    // Блок, в котором стоит текст: смена блока — новый абзац.
    const blockOf = (element) => {
      if (!blocks.has(element)) {
        const display = getComputedStyle(element).display;
        blocks.set(element, INLINE_DISPLAY.test(display) && element.parentElement ? blockOf(element.parentElement) : element);
      }
      return blocks.get(element);
    };
    let lastBlock = null;
    let space = false;
    const newline = () => {
      if (chars.length && chars.at(-1) !== '\n') {
        chars.push('\n');
        map.push(map.at(-1));
      }
      space = false;
    };

    for (const [r, range] of ranges.entries()) {
      if (r > 0) newline();
      const root = range.commonAncestorContainer;
      const nodes = [];
      if (root.nodeType === Node.TEXT_NODE) nodes.push(root);
      else {
        const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT, {
          acceptNode(node) {
            if (!range.intersectsNode(node)) return NodeFilter.FILTER_REJECT;
            if (node.nodeType === Node.TEXT_NODE) return NodeFilter.FILTER_ACCEPT;
            if (SKIP_TAGS.has(node.tagName) || node === session?.host) return NodeFilter.FILTER_REJECT;
            return node.tagName === 'BR' ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP;
          },
        });
        while (walker.nextNode()) nodes.push(walker.currentNode);
      }
      for (const node of nodes) {
        if (node.nodeType === Node.ELEMENT_NODE) {
          newline(); // <br>
          continue;
        }
        const parent = node.parentElement;
        if (!parent || !isVisible(parent)) continue;
        const block = blockOf(parent);
        if (lastBlock && block !== lastBlock) newline();
        lastBlock = block;
        const from = node === range.startContainer ? range.startOffset : 0;
        const to = node === range.endContainer ? range.endOffset : node.data.length;
        for (let i = from; i < to; i += 1) {
          const char = node.data[i];
          if (char === '\u00ad' || char === '\u200b') continue; // мягкий перенос, невидимый пробел
          if (/\s/.test(char)) {
            space = true;
            continue;
          }
          if (space && chars.length && chars.at(-1) !== '\n') {
            chars.push(' ');
            map.push([node, i]);
          }
          space = false;
          chars.push(char);
          map.push([node, i]);
        }
      }
    }
    while (chars.length && /\s/.test(chars.at(-1))) {
      chars.pop();
      map.pop();
    }
    return { text: chars.join(''), map };
  }

  // ── Подсветка на странице ─────────────────────────────────────────────

  function rangeFor(start, end) {
    const map = session?.map;
    if (!map || start >= end || !map[start] || !map[end - 1]) return null;
    const range = new Range();
    try {
      range.setStart(...map[start]);
      range.setEnd(map[end - 1][0], map[end - 1][1] + 1);
    } catch {
      return null; // страница успела перестроиться
    }
    return range;
  }

  function highlight(name, start, end) {
    if (!globalThis.CSS?.highlights) return null;
    const range = rangeFor(start, end);
    if (range) CSS.highlights.set(name, new Highlight(range));
    else CSS.highlights.delete(name);
    return range;
  }

  function clearHighlights() {
    CSS.highlights?.delete(SENTENCE);
    CSS.highlights?.delete(WORD);
    CSS.highlights?.delete(QUEUE);
  }

  /** Слабая подсветка того, что ещё будет прочитано, — правее звучащей фразы. */
  function showQueue() {
    if (!globalThis.CSS?.highlights || !session) return;
    const ranges = [];
    for (const piece of session.pieces) {
      let start = Math.max(piece.start, session.readTo);
      while (start < piece.end && /\s/.test(session.text[start])) start += 1;
      const range = start < piece.end ? rangeFor(start, piece.end) : null;
      if (range) ranges.push(range);
    }
    if (ranges.length) CSS.highlights.set(QUEUE, new Highlight(...ranges));
    else CSS.highlights.delete(QUEUE);
  }

  /**
   * Добавить кусок в очередь (первый — начать чтение).
   * @returns {boolean} кусок прочитается: новый или уже стоит в очереди
   */
  function add(ranges) {
    const { text, map } = collect(ranges);
    if (!hasText(text)) return false;
    session ??= createPill();
    const same = (a, b) => a[0] === b[0] && a[1] === b[1];
    if (session.pieces.some((piece) => same(piece.first, map[0]) && same(piece.last, map.at(-1)))) return true;
    const offset = session.text ? session.text.length + 1 : 0;
    if (session.text) {
      session.text += '\n';
      session.map.push(session.map.at(-1));
    }
    session.text += text;
    session.map = session.map.concat(map); // без push(...map): длинное выделение переполнило бы стек
    session.pieces.push({ start: offset, end: offset + text.length, first: map[0], last: map.at(-1) });
    session.port.postMessage({ type: 'append', text, offset, title: document.title });
    showQueue();
    return true;
  }

  /** Выделение поменялось — плашка показывает или прячет «＋». */
  function onSelectionChange() {
    clearTimeout(selectionTimer);
    selectionTimer = setTimeout(() => {
      if (!session) return;
      const selection = getSelection();
      const ranges = rangesOf(selection);
      if (ranges.length && hasText(String(selection))) remembered = ranges.map((range) => range.cloneRange());
      // Фокус ушёл в плашку — выделение могло сняться щелчком по «＋»: помним его.
      else if (document.activeElement !== session.host) remembered = [];
      session.port.postMessage({ type: 'selection', available: remembered.length > 0 });
    }, 150);
  }

  function forgetSelection() {
    getSelection()?.removeAllRanges(); // синее выделение закрывало бы подсветку
    remembered = [];
    session?.port.postMessage({ type: 'selection', available: false });
  }

  /** Фраза ушла за край окна — подтянуть к ней страницу, если читатель сам не листает. */
  function reveal(range) {
    if (Date.now() - lastUserScroll < USER_SCROLL_PAUSE_MS) return;
    const rect = range.getBoundingClientRect();
    if (!rect.height || (rect.top >= 40 && rect.bottom <= innerHeight - PILL_HEIGHT - 40)) return;
    (range.startContainer.parentElement ?? document.documentElement).scrollIntoView({ block: 'center', behavior: 'smooth' });
  }

  const noteUserScroll = (event) => {
    if (event.type !== 'keydown' || ['PageDown', 'PageUp', 'ArrowDown', 'ArrowUp', 'Space', 'Home', 'End'].includes(event.code)) {
      lastUserScroll = Date.now();
    }
  };

  // ── Плашка в углу ─────────────────────────────────────────────────────

  function createPill() {
    // randomUUID на сайтах по http недоступен, getRandomValues — везде.
    const token = [...crypto.getRandomValues(new Uint8Array(16))].map((byte) => byte.toString(16).padStart(2, '0')).join('');
    const host = document.createElement('pdf-reader-speak');
    css(host, {
      all: 'initial',
      position: 'fixed',
      right: '16px',
      bottom: '16px',
      width: `${PILL_WIDTH}px`,
      height: `${PILL_HEIGHT}px`,
      'z-index': '2147483647',
      display: 'block',
    });
    const root = host.attachShadow({ mode: 'closed' });
    const frame = document.createElement('iframe');
    frame.allow = 'autoplay';
    frame.title = 'Озвучка выделенного';
    css(frame, { width: '100%', height: '100%', border: '0', display: 'block', background: 'transparent', 'color-scheme': 'normal' });
    frame.src = `${frameUrl()}#${token}`;
    root.append(frame);
    (document.body ?? document.documentElement).append(host);

    // Канал и секрет уходят только в документ расширения: если страница
    // подменит адрес плашки, сообщение до чужого документа не дойдёт.
    const target = new URL(frame.src, location.href);
    const origin = target.origin !== 'null' ? target.origin : `${target.protocol}//${target.host}`;
    const channel = new MessageChannel();
    frame.addEventListener('load', () => frame.contentWindow.postMessage({ type: 'pdf-reader-speak-connect', token }, origin, [channel.port2]), {
      once: true,
    });
    channel.port1.onmessage = ({ data }) => fromPill(data);
    for (const type of ['wheel', 'touchmove', 'keydown']) addEventListener(type, noteUserScroll, { passive: true, capture: true });
    document.addEventListener('selectionchange', onSelectionChange);
    return { host, frame, port: channel.port1, text: '', map: [], pieces: [], readTo: 0 };
  }

  /** Плашку перетаскивают: дальше она стоит там, куда её поставили. */
  function move(dx, dy) {
    const { host } = session;
    const rect = host.getBoundingClientRect();
    const left = Math.min(innerWidth - rect.width, Math.max(0, rect.left + dx));
    const top = Math.min(innerHeight - rect.height, Math.max(0, rect.top + dy));
    css(host, { left: `${left}px`, top: `${top}px`, right: 'auto', bottom: 'auto' });
  }

  /** Плашка выросла (меню, строка состояния) — растёт вверх, низ остаётся на месте. */
  function resize(width, height) {
    const { host } = session;
    const rect = host.getBoundingClientRect();
    const anchoredTop = host.style.getPropertyValue('top');
    css(host, { width: `${Math.ceil(width)}px`, height: `${Math.ceil(height)}px` });
    if (anchoredTop) css(host, { top: `${Math.max(0, rect.bottom - height)}px` });
  }

  function close() {
    if (!session) return;
    clearHighlights();
    session.port.close();
    session.host.remove();
    for (const type of ['wheel', 'touchmove', 'keydown']) removeEventListener(type, noteUserScroll, { capture: true });
    document.removeEventListener('selectionchange', onSelectionChange);
    clearTimeout(selectionTimer);
    remembered = [];
    session = null;
  }

  function fromPill(message) {
    if (!session) return;
    switch (message?.type) {
      case 'sentence': {
        CSS.highlights?.delete(WORD);
        const range = highlight(SENTENCE, message.start, message.end);
        if (range) reveal(range);
        session.readTo = message.end;
        showQueue();
        break;
      }
      case 'word':
        highlight(WORD, message.start, message.end);
        break;
      case 'clear':
        clearHighlights();
        break;
      case 'size':
        resize(message.width, message.height);
        break;
      case 'move':
        move(message.dx, message.dy);
        break;
      case 'close':
        close();
        break;
      case 'add-selection': {
        const live = rangesOf(getSelection());
        const ranges = live.length && hasText(String(getSelection())) ? live : remembered;
        if (ranges.length) add(ranges);
        forgetSelection();
        break;
      }
      default:
    }
  }

  // ── Что вызывает фоновая страница ─────────────────────────────────────

  globalThis.__pdfReaderSpeak = {
    /** Прочитать текущее выделение — первым или следом за уже выделенным. false — выделения нет. */
    fromSelection() {
      const selection = getSelection();
      const ranges = rangesOf(selection);
      if (!ranges.length || !hasText(String(selection))) return false;
      const added = add(ranges);
      forgetSelection();
      return added;
    },
    /** Пауза или продолжение. false — здесь ничего не читается. */
    toggle() {
      if (!session) return false;
      session.port.postMessage({ type: 'toggle' });
      return true;
    },
    close,
    get active() {
      return Boolean(session);
    },
  };
})();
