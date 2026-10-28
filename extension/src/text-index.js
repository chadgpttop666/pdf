// Восстановление читаемого текста из PDF и разбиение его на предложения.
//
// Текстовый слой PDF — это набор позиционированных кусков, а не абзацы:
// строки приходят отдельными элементами, пробел между словами может
// отсутствовать, перенос по слогам разрывает слово. Здесь всё это собирается
// обратно, причём с сохранением карты «символ → элемент текстового слоя»,
// без которой невозможно подсветить читаемое место.

import { classifyFurniture, profileFurniture } from './page-furniture.js';

/** Ровно те же параметры, с которыми текстовый слой строит pdf.js, — иначе
 *  порядок кусков разойдётся со спанами слоя и подсветка уедет. */
export const TEXT_CONTENT_PARAMS = { includeMarkedContent: true, disableNormalization: true };

const MAX_SENTENCE_LENGTH = 320;
const MIN_SENTENCE_LENGTH = 3;

/**
 * Сборка читаемого текста страницы.
 *
 * Главная тонкость — перенос строки. Внутри абзаца он не должен попадать в
 * текст: сегментатор считает его концом предложения и рвёт фразу пополам.
 * Новый абзац узнаём по признакам книжной вёрстки: увеличенный шаг между
 * строками, короткая строка (конец абзаца, заголовок, «* * *») или красная
 * строка у следующей. Длина подставляемого разделителя всегда один символ,
 * поэтому карта позиций остаётся точной.
 *
 * Номер спана считаем только по непустым кускам: пустые (pdf.js ставит их
 * в конце почти каждой строки книжной вёрстки) он создаёт, но в DOM не
 * вставляет. Если их считать, подсветка отстаёт на элемент с каждой строкой.
 *
 * @param {Array} items результат getTextContent().items
 * @param {(lines: Array) => {dropLines?: Set<number>, dropSpans?: Set<number>}} [filter]
 *   что выбросить из текста (колонтитулы, сноски); номера спанов при этом не
 *   сдвигаются — они посчитаны по всем непустым кускам заранее
 * @returns {{ text: string, entries: Array<{spanIndex:number,start:number,end:number}> }}
 */
export function buildPageText(items, filter) {
  const allLines = groupLines(items);
  const { dropLines = new Set(), dropSpans = new Set() } = filter?.(allLines) ?? {};
  const lines = allLines
    .filter((_, index) => !dropLines.has(index))
    .map((line) =>
      dropSpans.size ? { ...line, records: line.records.filter((record) => !dropSpans.has(record.spanIndex)) } : line
    )
    .filter((line) => line.records.length);
  const layout = measureLayout(lines);

  let text = '';
  const entries = [];
  lines.forEach((line, lineIndex) => {
    if (lineIndex > 0 && text) {
      const last = text.at(-1);
      if (last !== ' ' && last !== '\n') {
        text += isParagraphBreak(lines[lineIndex - 1], line, layout) ? '\n' : ' ';
      }
    }
    let previous = null;
    for (const { item, spanIndex } of line.records) {
      if (previous) text += gapSeparator(previous, item, text);
      const start = text.length;
      text += item.str;
      entries.push({ spanIndex, start, end: text.length });
      previous = item;
    }
  });

  return { text, entries };
}

const itemX = (item) => item.transform?.[4] ?? 0;
const itemY = (item) => item.transform?.[5] ?? 0;
const itemFontSize = (item) => Math.abs(item.transform?.[3]) || item.height || 10;

/**
 * Новая строка — заметный сдвиг по вертикали. Мерим по большему из двух
 * шрифтов: знак сноски мелкий и приподнят, и по его собственному размеру
 * строка рвалась бы сразу после него.
 */
function isLineBreak(previous, item, pendingNewline = false) {
  const size = Math.max(itemFontSize(previous), itemFontSize(item));
  return pendingNewline || Math.abs(itemY(item) - itemY(previous)) > size * 0.5;
}

/** Куски текста по строкам; пустые куски только отмечают конец строки. */
export function groupLines(items) {
  const lines = [];
  let spanIndex = -1;
  let current = null;
  let previous = null;
  let pendingNewline = false;

  for (const item of items) {
    if (item.str === undefined) continue; // служебные маркеры структуры
    if (item.str === '') {
      pendingNewline = pendingNewline || Boolean(item.hasEOL);
      continue;
    }
    spanIndex += 1;
    if (!current || isLineBreak(previous, item, pendingNewline)) {
      current = { records: [] };
      lines.push(current);
    }
    current.records.push({ item, spanIndex });
    pendingNewline = Boolean(item.hasEOL);
    previous = item;
  }

  for (const line of lines) {
    const first = line.records[0].item;
    line.left = Math.min(...line.records.map(({ item }) => itemX(item)));
    line.right = Math.max(...line.records.map(({ item }) => itemX(item) + (item.width ?? 0)));
    line.y = itemY(first);
    line.fontSize = itemFontSize(first);
    line.firstText = first.str.trimStart();
    line.lastText = line.records.at(-1).item.str.trimEnd();
    line.text = line.records
      .map(({ item }) => item.str)
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim();
  }
  return lines;
}

/** Типичные шаг строк, ширина и левый край — то, от чего отличается абзац. */
function measureLayout(lines) {
  const steps = [];
  for (let i = 1; i < lines.length; i += 1) {
    const step = Math.abs(lines[i].y - lines[i - 1].y);
    if (step > 0) steps.push(step);
  }
  const usable = lines.length >= 3;
  return {
    lineStep: steps.length ? median(steps) : 0,
    width: usable ? median(lines.map((line) => line.right - line.left)) : 0,
    left: usable ? median(lines.map((line) => line.left)) : 0,
  };
}

const SENTENCE_END = /[.!?…:;»"')\]]$/;
const STARTS_PARAGRAPH = /^[\p{Lu}\d«„"—–-]/u;

function isParagraphBreak(previous, next, layout) {
  const step = Math.abs(next.y - previous.y);
  if (layout.lineStep > 0 && step > layout.lineStep * 1.4) return true;
  // Сменился размер шрифта — заголовок и подзаголовок, заголовок и текст.
  const sizes = [previous.fontSize, next.fontSize].sort((a, b) => a - b);
  if (sizes[1] > sizes[0] * 1.12) return true;
  if (!layout.width) return false;

  // Совсем короткая строка — заголовок, «* * *» или хвост абзаца.
  const width = previous.right - previous.left;
  if (width < layout.width * 0.5) return true;
  // Недотянутая до края строка перед фразой с заглавной — конец абзаца.
  // Одной короткой строки мало: в тексте без выравнивания такие на каждом шагу.
  const startsAnew = STARTS_PARAGRAPH.test(next.firstText);
  if (width < layout.width * 0.85 && startsAnew && SENTENCE_END.test(previous.lastText)) return true;
  // Красная строка у следующей строки.
  return startsAnew && next.left > layout.left + next.fontSize * 0.8;
}

/** Пробел между кусками одной строки, если на письме между ними зазор. */
function gapSeparator(previous, item, text) {
  const last = text.at(-1);
  if (last === ' ' || last === '\n' || item.str.startsWith(' ')) return '';
  // Перед закрывающей пунктуацией пробела не бывает — зазор там остаётся,
  // например, от выброшенного знака сноски.
  if (/^[.,;:!?…)\]»"]/.test(item.str)) return '';
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

  return mergeFalseBreaks(ranges, source)
    .flatMap((range) => splitLong(trimRange(source, range), source))
    .filter(Boolean);
}

// Сокращения, после которых точка не заканчивает фразу. Сегментатор рвёт
// фразу только перед заглавной буквой, поэтому важны сокращения, за которыми
// обычно идёт имя: «проф. Франца», «ул. Ленина». А «и т. д.» или «в 1928 г.»
// перед заглавной — это как раз настоящий конец предложения.
const ABBREVIATION = new RegExp(
  '(?:^|[\\s(«„"])(?:' +
    [
      'проф', 'акад', 'доц', 'ген', 'тов', 'кн', 'гр', 'св', 'им', 'ул', 'пр', 'см', 'ср', 'напр',
      'т\\.\\s?е', 'Mr', 'Mrs', 'Dr', 'Prof', 'St', 'vs', 'e\\.g', 'i\\.e',
    ].join('|') +
    ')\\.$',
  'iu'
);
// Инициал: одна заглавная буква с точкой — «А. С. Пушкин», «Л. Эрхард».
const INITIAL = /(?:^|[\s(«„"])\p{Lu}\.$/u;
// Номер в заголовке: «Глава 1.», «§ 2)».
const NUMBERING = /\d[.)]$/;

/**
 * Сегментатор рвёт фразу после любой точки перед заглавной буквой: после
 * номера главы, инициала, сокращения «проф.». Такие огрызки приклеиваем к
 * следующему куску.
 */
function mergeFalseBreaks(ranges, text) {
  const merged = [];
  let glueNext = false;
  for (const range of ranges) {
    const piece = text.slice(range.start, range.end).trimEnd();
    const previous = merged.at(-1);
    if (previous && glueNext) previous.end = range.end;
    else merged.push({ start: range.start, end: range.end });
    glueNext =
      (piece.trim().length < 20 && NUMBERING.test(piece)) || INITIAL.test(piece) || ABBREVIATION.test(piece);
  }
  return merged;
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

/**
 * Длина слова, начинающегося с позиции. Firefox присылает в событиях
 * синтеза только начало слова, без длины, — её досчитываем сами.
 */
export function wordLength(text, start) {
  const match = /^[\p{L}\p{N}\p{M}'’-]+/u.exec(text.slice(start));
  return match ? match[0].length : 1;
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

const FURNITURE_SAMPLE = 12;

/** Границы страницы по вертикали в координатах PDF — для полос колонтитулов. */
function pageBox(page) {
  const [, bottom, , top] = page.view;
  return { bottom, top };
}

/** Индекс текста документа с ленивой загрузкой и кешем по страницам. */
export class TextIndex {
  /**
   * @param {object} pdfDocument
   * @param {{ skipFurniture?: boolean }} [options] выбрасывать колонтитулы,
   *   номера страниц и сноски — для чтения вслух и режима «только текст»
   */
  constructor(pdfDocument, { skipFurniture = false } = {}) {
    this.pdfDocument = pdfDocument;
    this.pages = new Map();
    this.language = null;
    this.skipFurniture = skipFurniture;
    this.furniturePromise = null;
  }

  get numPages() {
    return this.pdfDocument?.numPages || 0;
  }

  /** Профиль колонтитулов по выборке страниц равномерно по документу; считается один раз. */
  furnitureProfile() {
    this.furniturePromise ||= (async () => {
      const total = this.numPages;
      const step = Math.max(1, Math.floor(total / FURNITURE_SAMPLE));
      const samples = [];
      for (let number = 1; number <= total && samples.length < FURNITURE_SAMPLE; number += step) {
        try {
          const page = await this.pdfDocument.getPage(number);
          const content = await page.getTextContent(TEXT_CONTENT_PARAMS);
          samples.push({ lines: groupLines(content.items), box: pageBox(page) });
        } catch {
          /* страница без текста или битая — просто пропускаем */
        }
      }
      return profileFurniture(samples);
    })();
    return this.furniturePromise;
  }

  async page(pageNumber) {
    if (pageNumber < 1 || pageNumber > this.numPages) return null;
    if (this.pages.has(pageNumber)) return this.pages.get(pageNumber);

    const promise = (async () => {
      const page = await this.pdfDocument.getPage(pageNumber);
      const content = await page.getTextContent(TEXT_CONTENT_PARAMS);
      let filter;
      if (this.skipFurniture) {
        const profile = await this.furnitureProfile();
        const box = pageBox(page);
        filter = (lines) => classifyFurniture(lines, box, profile);
      }
      const { text, entries } = buildPageText(content.items, filter);
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

  /** Позиция в тексте страницы по спану текстового слоя и смещению в нём. */
  async offsetForSpan(pageNumber, spanIndex, offsetInSpan = 0) {
    const page = await this.page(pageNumber);
    const entry = page?.entries.find((candidate) => candidate.spanIndex === spanIndex);
    if (!entry) return 0;
    return Math.min(entry.end, entry.start + offsetInSpan);
  }
}
