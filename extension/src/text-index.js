// Восстановление читаемого текста из PDF и разбиение его на предложения.
//
// Текстовый слой PDF — это набор позиционированных кусков, а не абзацы:
// строки приходят отдельными элементами, пробел между словами может
// отсутствовать, перенос по слогам разрывает слово. Здесь всё это собирается
// обратно, причём с сохранением карты «символ → элемент текстового слоя»,
// без которой невозможно подсветить читаемое место.

/** Ровно те же параметры, с которыми текстовый слой строит pdf.js, — иначе
 *  порядок элементов разойдётся с textDivs и подсветка уедет. */
export const TEXT_CONTENT_PARAMS = { includeMarkedContent: true, disableNormalization: true };

const MAX_SENTENCE_LENGTH = 320;
const MIN_SENTENCE_LENGTH = 3;

/**
 * Сборка читаемого текста страницы.
 *
 * Главная тонкость — перенос строки. Внутри абзаца он не должен попадать в
 * текст: сегментатор считает его концом предложения и рвёт фразу пополам.
 * Отличаем перенос от нового абзаца геометрически, по шагу между строками:
 * увеличенный шаг — новый абзац, обычный — та же фраза дальше. Длина
 * подставляемого разделителя всегда один символ, поэтому карта позиций
 * остаётся точной.
 *
 * @param {Array} items результат getTextContent().items
 * @returns {{ text: string, entries: Array<{divIndex:number,start:number,end:number}> }}
 */
export function buildPageText(items) {
  const records = [];
  let divIndex = -1;
  for (const item of items) {
    if (item.str === undefined) continue; // служебные маркеры структуры
    divIndex += 1;
    records.push({ item, divIndex, empty: item.str === '' });
  }

  const lineStep = medianLineStep(records);

  let text = '';
  const entries = [];
  let previous = null;
  let pendingNewline = false;

  for (const record of records) {
    const { item } = record;
    if (record.empty) {
      pendingNewline = pendingNewline || Boolean(item.hasEOL);
      continue;
    }
    if (previous) text += separatorBetween(previous, item, text, { lineStep, pendingNewline });

    const start = text.length;
    text += item.str;
    entries.push({ divIndex: record.divIndex, start, end: text.length });
    pendingNewline = Boolean(item.hasEOL);
    previous = item;
  }

  return { text, entries };
}

const itemX = (item) => item.transform?.[4] ?? 0;
const itemY = (item) => item.transform?.[5] ?? 0;
const itemFontSize = (item) => Math.abs(item.transform?.[3]) || item.height || 10;

function isLineBreak(previous, item, pendingNewline = false) {
  return pendingNewline || Math.abs(itemY(item) - itemY(previous)) > itemFontSize(previous) * 0.5;
}

/** Типичный шаг между строками — опора для распознавания абзацев. */
function medianLineStep(records) {
  const steps = [];
  let previous = null;
  let pendingNewline = false;
  for (const record of records) {
    if (record.empty) {
      pendingNewline = pendingNewline || Boolean(record.item.hasEOL);
      continue;
    }
    if (previous && isLineBreak(previous, record.item, pendingNewline)) {
      const step = Math.abs(itemY(record.item) - itemY(previous));
      if (step > 0) steps.push(step);
    }
    pendingNewline = Boolean(record.item.hasEOL);
    previous = record.item;
  }
  return steps.length ? median(steps) : 0;
}

function separatorBetween(previous, item, text, { lineStep, pendingNewline }) {
  if (!text) return '';
  const last = text.at(-1);
  if (last === '\n' || last === ' ' || item.str.startsWith(' ')) return '';

  if (isLineBreak(previous, item, pendingNewline)) {
    const step = Math.abs(itemY(item) - itemY(previous));
    const paragraph = lineStep > 0 && step > lineStep * 1.4;
    return paragraph ? '\n' : ' ';
  }

  const gap = itemX(item) - (itemX(previous) + (previous.width ?? 0));
  return gap > itemFontSize(previous) * 0.2 ? ' ' : '';
}

export function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

/** Диапазоны предложений в координатах текста страницы. */
export function segmentSentences(text, lang = 'ru') {
  // Замена посимвольная, длина не меняется — карта позиций остаётся верной.
  // Перенос по слогам на границе абзаца иначе разрывает слово пополам.
  const source = text.replace(/-\n(?=\p{L})/gu, '- ');

  const ranges = [];
  if (typeof Intl !== 'undefined' && Intl.Segmenter) {
    const segmenter = new Intl.Segmenter(lang, { granularity: 'sentence' });
    for (const { segment, index } of segmenter.segment(source)) {
      if (segment.trim()) ranges.push({ start: index, end: index + segment.length });
    }
  } else {
    // Запасной разбор, если Intl.Segmenter недоступен.
    const regex = /[^.!?…]+[.!?…]+[\s'")\]]*|[^.!?…]+$/gu;
    let match;
    while ((match = regex.exec(source))) {
      if (match[0].trim()) ranges.push({ start: match.index, end: match.index + match[0].length });
    }
  }

  return mergeNumbering(ranges, source)
    .flatMap((range) => splitLong(trimRange(source, range), source))
    .filter(Boolean);
}

/**
 * «Глава 1.» — не предложение, а начало заголовка: сегментатор видит точку
 * после числа и обрывает фразу. Такие огрызки приклеиваем к следующему куску.
 */
function mergeNumbering(ranges, text) {
  const merged = [];
  for (const range of ranges) {
    const piece = text.slice(range.start, range.end).trim();
    const previous = merged.at(-1);
    const isNumbering = piece.length < 20 && /\d[.)]$/.test(piece);
    if (previous && previous.numbering) {
      merged[merged.length - 1] = { start: previous.start, end: range.end, numbering: false };
      continue;
    }
    merged.push({ ...range, numbering: isNumbering });
  }
  return merged.map(({ start, end }) => ({ start, end }));
}

/** Обрезает пробелы по краям диапазона, чтобы подсветка не захватывала пустоту. */
function trimRange(text, { start, end }) {
  let from = start;
  let to = end;
  while (from < to && /\s/.test(text[from])) from += 1;
  while (to > from && /\s/.test(text[to - 1])) to -= 1;
  return from < to ? { start: from, end: to } : null;
}

/**
 * Длинные куски (таблицы, списки без точек) режем по знакам препинания:
 * синтезаторы плохо держат длинные фразы, а пауза становится неуправляемой.
 */
function splitLong(range, text) {
  if (!range) return [];
  if (range.end - range.start <= MAX_SENTENCE_LENGTH) return [range];

  const parts = [];
  let cursor = range.start;
  while (cursor < range.end) {
    const limit = Math.min(cursor + MAX_SENTENCE_LENGTH, range.end);
    if (limit === range.end) {
      parts.push({ start: cursor, end: range.end });
      break;
    }
    const slice = text.slice(cursor, limit);
    const breakAt = Math.max(
      slice.lastIndexOf('; '),
      slice.lastIndexOf(', '),
      slice.lastIndexOf(' — '),
      slice.lastIndexOf('\n')
    );
    const end = breakAt > MIN_SENTENCE_LENGTH ? cursor + breakAt + 1 : limit;
    parts.push({ start: cursor, end });
    cursor = end;
  }
  return parts.map((part) => trimRange(text, part)).filter(Boolean);
}

/**
 * Текст для синтезатора: переносы строк и слоговые переносы убираем, но
 * храним карту в исходные позиции, чтобы подсветка слов оставалась точной.
 * @returns {{ text: string, map: number[] }}
 */
export function cleanForSpeech(raw) {
  const out = [];
  const map = [];
  let index = 0;

  while (index < raw.length) {
    const char = raw[index];

    // Перенос по слогам: «пере-\nнос» читается как одно слово.
    if (char === '-' && /\s/.test(raw[index + 1] || '') && /\p{L}/u.test(raw[index - 1] || '')) {
      let lookahead = index + 1;
      while (lookahead < raw.length && /\s/.test(raw[lookahead])) lookahead += 1;
      if (/\p{L}/u.test(raw[lookahead] || '')) {
        index = lookahead;
        continue;
      }
    }

    if (/\s/.test(char)) {
      if (out.at(-1) !== ' ') {
        out.push(' ');
        map.push(index);
      }
      index += 1;
      continue;
    }

    out.push(char);
    map.push(index);
    index += 1;
  }

  while (out.length && out.at(-1) === ' ') {
    out.pop();
    map.pop();
  }
  return { text: out.join(''), map };
}

/** Грубое определение языка — нужно только для выбора голоса и сегментации. */
export function detectLanguage(text) {
  const sample = text.slice(0, 4000);
  const cyrillic = (sample.match(/\p{Script=Cyrillic}/gu) || []).length;
  const latin = (sample.match(/\p{Script=Latin}/gu) || []).length;
  if (cyrillic > latin) return 'ru';
  if (latin > 0) return 'en';
  return 'ru';
}

/** Индекс текста документа с ленивой загрузкой и кешем по страницам. */
export class TextIndex {
  constructor(pdfDocument) {
    this.pdfDocument = pdfDocument;
    this.pages = new Map();
    this.language = null;
  }

  get numPages() {
    return this.pdfDocument?.numPages || 0;
  }

  async page(pageNumber) {
    if (pageNumber < 1 || pageNumber > this.numPages) return null;
    if (this.pages.has(pageNumber)) return this.pages.get(pageNumber);

    const promise = (async () => {
      const page = await this.pdfDocument.getPage(pageNumber);
      const content = await page.getTextContent(TEXT_CONTENT_PARAMS);
      const { text, entries } = buildPageText(content.items);
      this.language ??= detectLanguage(text);
      const sentences = segmentSentences(text, this.language);
      return { pageNumber, text, entries, sentences };
    })();

    this.pages.set(pageNumber, promise);
    return promise;
  }

  /** Номер предложения на странице, покрывающего указанную позицию в тексте. */
  async sentenceIndexAt(pageNumber, charOffset) {
    const page = await this.page(pageNumber);
    if (!page) return 0;
    const index = page.sentences.findIndex((sentence) => charOffset < sentence.end);
    return index < 0 ? Math.max(0, page.sentences.length - 1) : index;
  }

  /** Позиция в тексте страницы по элементу текстового слоя и смещению в нём. */
  async offsetForDiv(pageNumber, divIndex, offsetInDiv = 0) {
    const page = await this.page(pageNumber);
    const entry = page?.entries.find((candidate) => candidate.divIndex === divIndex);
    if (!entry) return 0;
    return Math.min(entry.end, entry.start + offsetInDiv);
  }
}
