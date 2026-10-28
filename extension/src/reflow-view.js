// Режим «только текст»: книга как сплошной текст, перекомпонованный под
// ширину окна, — свой шрифт, размер, интервал и ширина колонки. Крупно читать
// можно без горизонтальной прокрутки вообще.
//
// Текст берётся из того же индекса, что и у озвучки (колонтитулы и сноски уже
// выброшены, абзацы размечены), поэтому номера предложений совпадают: место
// чтения, озвучка и закладки переходят между режимами без пересчёта.
// Каждое предложение — отдельный элемент с номером страницы и предложения.

import { $, clear, el, on } from './dom.js';
import { get as getSetting, onSettingsChanged, updateSettings } from './settings.js';
import { cleanForSpeech, wordLength } from './text-index.js';
import { firstVisibleSpanIndex, textSpansOfPage } from './visible-text.js';

const FONT_SERIF = "Georgia, 'PT Serif', 'Times New Roman', serif";
const FONT_SANS = "'Segoe UI', system-ui, 'PT Sans', Roboto, sans-serif";
const HEADING_MAX = 90;
// Отступ сверху при переходе к фразе; место чтения ищем ниже него, иначе
// за «текущую» принимался бы хвост предыдущей страницы над фразой.
const TOP_GAP = 24;
const STARTS_SENTENCE = /^[\p{Lu}\d«„"—–*(]/u;
const WORD_HIGHLIGHT = 'rf-word';

const nextIdle = () =>
  new Promise((resolve) => (window.requestIdleCallback ? requestIdleCallback(() => resolve()) : setTimeout(resolve, 16)));

export function createReflow(app) {
  const container = $('reflowContainer');
  const article = $('reflowArticle');
  const button = $('btnReflow');

  let active = false;
  let index = null;
  let builtFor = null;
  let sections = [];
  let filled = new Set();
  let fillToken = 0;
  let currentPage = 0;
  let scrollFrame = 0;

  function applyLook() {
    const chosen = getSetting('reflowTheme');
    container.dataset.theme = chosen === 'auto' ? (getSetting('uiTheme') === 'light' ? 'paper' : 'night') : chosen;
    const { style } = container;
    style.setProperty('--rf-font', getSetting('reflowFont') === 'sans' ? FONT_SANS : FONT_SERIF);
    style.setProperty('--rf-size', `${getSetting('reflowSize')}px`);
    style.setProperty('--rf-line', String(getSetting('reflowLineHeight')));
    style.setProperty('--rf-width', `${getSetting('reflowWidth')}ch`);
    style.setProperty('--rf-align', getSetting('reflowAlign'));
  }

  /** Пустые секции на все страницы сразу: текст заполняется по мере готовности. */
  function buildSkeleton() {
    clear(article);
    sections = [];
    filled = new Set();
    builtFor = index;
    article.lang = index?.language || 'ru';
    for (let pageNumber = 1; pageNumber <= (index?.numPages || 0); pageNumber += 1) {
      const section = el('section', { class: 'rf-page', dataset: { page: String(pageNumber) } });
      article.append(section);
      sections.push(section);
    }
  }

  async function fillPage(pageNumber) {
    if (!index || filled.has(pageNumber) || !sections[pageNumber - 1]) return;
    filled.add(pageNumber);
    const section = sections[pageNumber - 1];
    const page = await index.page(pageNumber);
    if (!page || sections[pageNumber - 1] !== section) return;

    const paragraphs = [];
    let paragraph = null;
    let cursor = 0;
    page.sentences.forEach((sentence, sentenceIndex) => {
      const gap = page.text.slice(cursor, sentence.start);
      if (!paragraph || gap.includes('\n')) {
        paragraph = el('p', { class: 'rf-p' });
        paragraphs.push(paragraph);
      } else {
        paragraph.append(' ');
      }
      // Тот же текст, что уходит в синтезатор, — поэтому границы слов из
      // озвучки ложатся прямо на этот элемент.
      const text = cleanForSpeech(page.text.slice(sentence.start, sentence.end)).text;
      paragraph.append(el('span', { class: 'rf-s', dataset: { page: String(pageNumber), s: String(sentenceIndex) } }, text));
      cursor = sentence.end;
    });

    for (const candidate of paragraphs) {
      const text = candidate.textContent.trim();
      // Короткая одиночная строка без точки — заголовок или «* * *».
      if (candidate.children.length === 1 && text.length <= HEADING_MAX && !/[.!?…:;,]$/.test(text)) {
        candidate.classList.add('rf-heading');
      }
    }
    // Страница началась с середины фразы — абзац продолжается без отступа.
    if (paragraphs[0] && !STARTS_SENTENCE.test(page.text.trimStart())) paragraphs[0].classList.add('rf-continued');

    const marker = el('div', { class: 'rf-page-marker', 'aria-hidden': 'true' }, String(pageNumber));
    section.replaceChildren(marker, ...paragraphs);
    if (!page.sentences.length) {
      section.append(el('p', { class: 'rf-empty' }, 'На этой странице нет текста — возможно, это картинка или скан.'));
    }
    app.eventBus.dispatch('reflowpagefilled', { source: api, pageNumber });
  }

  /** Заполнение всех страниц в фоне: сначала вокруг места чтения, потом дальше. */
  async function fillAround(start) {
    const token = (fillToken += 1);
    const total = sections.length;
    for (let distance = 1; distance < total; distance += 1) {
      for (const pageNumber of [start + distance, start - distance]) {
        if (token !== fillToken || !active) return;
        if (pageNumber < 1 || pageNumber > total || filled.has(pageNumber)) continue;
        await fillPage(pageNumber);
        await nextIdle();
      }
    }
  }

  function sectionIndexAtTop() {
    const y = container.scrollTop - article.offsetTop + TOP_GAP + 8;
    let low = 0;
    let high = sections.length - 1;
    let found = 0;
    while (low <= high) {
      const middle = (low + high) >> 1;
      if (sections[middle].offsetTop <= y) {
        found = middle;
        low = middle + 1;
      } else {
        high = middle - 1;
      }
    }
    return found;
  }

  /** Место чтения: первое предложение, видимое сверху. */
  function position() {
    const sectionIndex = sectionIndexAtTop();
    const pageNumber = sectionIndex + 1;
    const top = container.getBoundingClientRect().top + TOP_GAP + 8;
    const spans = [...(sections[sectionIndex]?.querySelectorAll('.rf-s') || [])];
    const visible = spans.find((span) => span.getBoundingClientRect().bottom > top) ?? spans.at(-1);
    const sentenceIndex = visible ? Number(visible.dataset.s) : 0;
    return { pageNumber, sentenceIndex, offsetRatio: spans.length ? sentenceIndex / spans.length : 0 };
  }

  function spanOf(pageNumber, sentenceIndex) {
    return sections[pageNumber - 1]?.querySelector(`.rf-s[data-s="${sentenceIndex}"]`) ?? null;
  }

  async function scrollToSentence(pageNumber, sentenceIndex = 0, { smooth = false } = {}) {
    await fillPage(pageNumber);
    const target = spanOf(pageNumber, sentenceIndex) ?? sections[pageNumber - 1];
    if (!target) return;
    const top = container.scrollTop + target.getBoundingClientRect().top - container.getBoundingClientRect().top - TOP_GAP;
    await app.scroller.scrollTo(top, { smooth, duration: 260 });
  }

  /** Место в обычном виде — для входа в режим. */
  async function pdfPosition() {
    const pageNumber = app.pdfViewer.currentPageNumber || 1;
    const offset = await index.offsetForSpan(pageNumber, firstVisibleSpanIndex(app, pageNumber));
    return { pageNumber, sentenceIndex: await index.sentenceIndexAt(pageNumber, offset) };
  }

  /** Возврат в обычный вид: на ту же страницу и, если получится, к той же фразе. */
  async function scrollPdfTo({ pageNumber, sentenceIndex }) {
    app.pdfViewer.scrollPageIntoView({ pageNumber });
    const page = await index?.page(pageNumber);
    const sentence = page?.sentences[sentenceIndex];
    if (!sentence) return;
    // Текстовый слой страницы появляется не сразу — ждём его, но недолго.
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const entry = page.entries.find((candidate) => candidate.end > sentence.start);
      const span = entry && textSpansOfPage(app, pageNumber)[entry.spanIndex];
      if (span?.getBoundingClientRect().height) {
        const shift = span.getBoundingClientRect().top - app.container.getBoundingClientRect().top - 24;
        app.container.scrollTop += shift;
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 80));
    }
  }

  function syncUi() {
    button.classList.toggle('active', active);
    button.setAttribute('aria-pressed', String(active));
    app.el.classList.toggle('reflow-on', active);
    container.hidden = !active;
  }

  async function enter(target) {
    if (active || !app.loader.pdfDocument) return;
    index = app.tts?.textIndex;
    if (!index) return;
    const from = target ?? (await pdfPosition());
    if (builtFor !== index) buildSkeleton();

    active = true;
    applyLook();
    syncUi();
    await fillPage(from.pageNumber);
    await fillPage(from.pageNumber + 1);
    await scrollToSentence(from.pageNumber, from.sentenceIndex);
    currentPage = from.pageNumber;
    fillAround(from.pageNumber);
    container.focus({ preventScroll: true });
    app.eventBus.dispatch('viewmodechanged', { source: api, mode: 'reflow' });
  }

  async function exit() {
    if (!active) return;
    const where = position();
    active = false;
    fillToken += 1; // фоновое заполнение больше не нужно
    clearHighlight();
    syncUi();
    app.eventBus.dispatch('viewmodechanged', { source: api, mode: 'pdf' });
    await scrollPdfTo(where);
    app.container.focus({ preventScroll: true });
  }

  function clearHighlight() {
    container.querySelector('.rf-s.rf-current')?.classList.remove('rf-current');
    globalThis.CSS?.highlights?.delete(WORD_HIGHLIGHT);
  }

  /** Держим читаемую фразу в верхней трети экрана, как в обычном виде. */
  function follow(span) {
    if (!span || !getSetting('ttsFollowScroll')) return;
    const rect = span.getBoundingClientRect();
    const box = container.getBoundingClientRect();
    if (rect.top >= box.top + 8 && rect.bottom <= box.bottom - 40) return;
    app.scroller.scrollTo(container.scrollTop + rect.top - box.top - box.height * 0.3, { smooth: true, duration: 320 });
  }

  async function adjustFontSize(direction) {
    const where = position();
    const size = Math.min(48, Math.max(12, getSetting('reflowSize') + direction * 2));
    await updateSettings({ reflowSize: size });
    applyLook();
    await scrollToSentence(where.pageNumber, where.sentenceIndex);
    app.hud.show(`Шрифт ${size} px`);
  }

  on(button, 'click', () => api.toggle());

  on(container, 'scroll', () => {
    if (scrollFrame) return;
    scrollFrame = requestAnimationFrame(() => {
      scrollFrame = 0;
      if (!active || !sections.length) return;
      const pageNumber = sectionIndexAtTop() + 1;
      if (pageNumber === currentPage) return;
      currentPage = pageNumber;
      app.eventBus.dispatch('pagechanging', { source: api, pageNumber });
    });
  }, { passive: true });

  // Переход из тулбара, оглавления или миниатюр приходит через вид PDF.
  app.eventBus.on('pagechanging', ({ source, pageNumber }) => {
    if (!active || source === api || pageNumber === currentPage) return;
    currentPage = pageNumber;
    scrollToSentence(pageNumber, 0);
  });

  app.eventBus.on('documentopened', () => {
    active = false;
    fillToken += 1;
    builtFor = null;
    clear(article);
    sections = [];
    syncUi();
  });

  // Индекс перестроили (например, сменилась настройка колонтитулов).
  app.eventBus.on('textindexchanged', async ({ index: next }) => {
    if (!active || next === index) return;
    const where = position();
    index = next;
    buildSkeleton();
    // Номера предложений в новом индексе другие — возвращаемся к началу страницы.
    await scrollToSentence(where.pageNumber, 0);
    fillAround(where.pageNumber);
  });

  onSettingsChanged((_all, changed) => {
    if (Object.keys(changed).some((key) => key.startsWith('reflow') || key === 'uiTheme')) applyLook();
  });

  const api = {
    get active() {
      return active;
    },
    get container() {
      return container;
    },
    enter,
    exit,
    toggle() {
      return active ? exit() : enter();
    },
    position,
    adjustFontSize,
    scrollToSentence,
    async scrollToPageRatio(pageNumber, ratio) {
      await fillPage(pageNumber);
      const count = sections[pageNumber - 1]?.querySelectorAll('.rf-s').length || 0;
      await scrollToSentence(pageNumber, Math.min(count - 1, Math.max(0, Math.round(ratio * count))));
    },

    /** Номер страницы и предложения по узлу внутри текста (щелчок, выделение). */
    positionOfNode(node) {
      const element = node?.nodeType === Node.TEXT_NODE ? node.parentElement : node;
      const span = element?.closest?.('.rf-s');
      if (!span || !container.contains(span)) return null;
      return { pageNumber: Number(span.dataset.page), sentenceIndex: Number(span.dataset.s) };
    },

    // Тот же интерфейс показа читаемого места, что у вида PDF в tts/controller.js.
    ensurePage: fillPage,
    highlightSentence(page, sentenceIndex, { scroll = true } = {}) {
      container.querySelector('.rf-s.rf-current')?.classList.remove('rf-current');
      const span = spanOf(page.pageNumber, sentenceIndex);
      span?.classList.add('rf-current');
      if (scroll) follow(span);
    },
    highlightWord(page, sentenceIndex, _map, { charIndex, charLength }, spokenText) {
      if (!globalThis.CSS?.highlights || typeof Highlight === 'undefined') return;
      const node = spanOf(page.pageNumber, sentenceIndex)?.firstChild;
      if (!node || node.nodeType !== Node.TEXT_NODE) return;
      const length = charLength || wordLength(spokenText ?? node.data, charIndex);
      const range = new Range();
      range.setStart(node, Math.min(charIndex, node.length));
      range.setEnd(node, Math.min(charIndex + length, node.length));
      CSS.highlights.set(WORD_HIGHLIGHT, new Highlight(range));
    },
    clearWords() {
      globalThis.CSS?.highlights?.delete(WORD_HIGHLIGHT);
    },
    clear: clearHighlight,
    async firstVisible() {
      const { pageNumber, sentenceIndex } = position();
      return { pageNumber, sentenceIndex };
    },
  };

  return api;
}
