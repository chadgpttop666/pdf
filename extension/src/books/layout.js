// Вёрстка книги (FB2, EPUB) в PDF: страницы 6×9 дюймов, PT Serif, выключка
// по ширине с красной строкой — как бумажная книга. Так её понимает вся
// остальная читалка:
// - абзацы — по красной строке, заголовки — по кеглю;
// - главы — в оглавлении PDF, каждая с новой страницы;
// - сноски — надстрочным номером в тексте и разделом «Примечания» в конце
//   (его читалка уже умеет зачитывать прямо на месте сноски);
// - номер страницы внизу — как колонтитул, вслух не читается.

import { hyphenPointsOf } from './hyphen.js';
import { createPdf } from './pdf-writer.js';

const PAGE = { width: 432, height: 648, top: 56, bottom: 64, left: 50, right: 50 };
const BODY = 11.5;
const LEADING = 1.42;
const INDENT = 1.5; // красная строка, в кеглях
const SUP_SCALE = 0.62;
// Насколько можно растянуть пробел при выключке; дальше — строка без выключки.
const MAX_STRETCH = 2.4;

const HEADING_SIZES = [17, 14.5, 13, 12];

/** Ключ шрифта по начертанию. */
const fontOf = (run) => (run.bold && run.italic ? 'boldItalic' : run.bold ? 'bold' : run.italic ? 'italic' : 'regular');

// Символы, которых нет в PT Serif, — близкими, чтобы не было пустых квадратов.
const SUBSTITUTES = { '→': '—>', '←': '<—', '⇒': '=>', '−': '−', ' ': ' ', '​': '' };
const substitute = (text) => text.replace(/[→←⇒ ​]/gu, (char) => SUBSTITUTES[char] ?? char);

/**
 * Слова абзаца: каждое — куски одного начертания подряд (курсив может
 * начаться посреди слова), между словами — пробел.
 */
function wordsOf(runs) {
  const words = [];
  let current = null;
  for (const run of runs) {
    const text = substitute(run.text ?? '').replace(/\s+/g, ' ');
    const parts = text.split(' ');
    parts.forEach((part, i) => {
      if (i > 0) current = null; // был пробел — новое слово
      if (!part) return;
      if (!current) {
        current = { pieces: [] };
        words.push(current);
      }
      current.pieces.push({ text: part, font: fontOf(run), sup: Boolean(run.sup) });
    });
  }
  return words;
}

/**
 * @param book { title, author, lang, cover?: { jpeg }, blocks: [...], notes: [[runs]...] }
 *   блоки: { type: 'heading', level, runs } | { type: 'paragraph', runs, style? } |
 *          { type: 'verse', runs } | { type: 'gap' } | { type: 'image', jpeg: { bytes, width, height } } |
 *          { type: 'pagebreak' }
 *   style абзаца: 'normal' | 'epigraph' | 'cite' | 'center' | 'subtitle' | 'note'
 * @param fonts { regular, italic, bold, boldItalic } — разобранные TTF
 * @param options.hyphens переносить длинные слова по слогам (по умолчанию да)
 * @returns {Promise<Uint8Array>} PDF
 */
export async function layoutBook(book, fonts, { hyphens = true } = {}) {
  const doc = createPdf({ fonts, info: { title: book.title, author: book.author, lang: book.lang || 'ru' } });
  const contentWidth = PAGE.width - PAGE.left - PAGE.right;
  let page = null;
  let y = 0; // базовая линия следующей строки — от верха страницы
  let pageEmpty = true;
  const pages = []; // { page, numbered }

  function newPage({ number = true } = {}) {
    page = doc.addPage(PAGE.width, PAGE.height);
    pages.push({ page, numbered: number });
    y = PAGE.top;
    pageEmpty = true;
    return page;
  }

  const room = () => PAGE.height - PAGE.bottom - y;
  const pdfY = (fromTop) => PAGE.height - fromTop;

  /** Ширина слова: куски разных начертаний, надстрочные — мельче. */
  const pieceSize = (piece, size) => (piece.sup ? size * SUP_SCALE : size);
  const wordWidth = (word, size) => word.pieces.reduce((sum, piece) => sum + doc.measure(piece.font, pieceSize(piece, size), piece.text), 0);
  const spaceWidth = (size) => doc.measure('regular', size, ' ');

  /** Разбить слишком длинное слово по буквам. */
  function splitLong(word, size, width) {
    const out = [];
    let current = { pieces: [] };
    let currentWidth = 0;
    for (const piece of word.pieces) {
      for (const char of piece.text) {
        const w = doc.measure(piece.font, pieceSize(piece, size), char);
        if (currentWidth + w > width && current.pieces.length) {
          out.push(current);
          current = { pieces: [] };
          currentWidth = 0;
        }
        const last = current.pieces.at(-1);
        if (last && last.font === piece.font && last.sup === piece.sup) last.text += char;
        else current.pieces.push({ ...piece, text: char });
        currentWidth += w;
      }
    }
    if (current.pieces.length) out.push(current);
    return out;
  }

  /**
   * Перенос слова, чтобы строка не была слишком разреженной: самая длинная
   * часть с дефисом, которая ещё влезает. null — переносить некуда.
   */
  function hyphenate(word, size, room) {
    // Переносим внутри первого куска; знак сноски и прочее — со второй частью.
    const [piece, ...rest] = word.pieces;
    if (!piece || piece.sup || (rest.length && rest.some((other) => !other.sup && /[а-яё]/i.test(other.text[0] ?? '')))) return null;
    const points = hyphenPointsOf(piece.text);
    for (let i = points.length - 1; i >= 0; i -= 1) {
      const at = points[i];
      const compound = piece.text[at - 1] === '-';
      const head = piece.text.slice(0, at) + (compound ? '' : '-');
      if (doc.measure(piece.font, size, head) <= room) {
        return [{ pieces: [{ ...piece, text: head }] }, { pieces: [{ ...piece, text: piece.text.slice(at) }, ...rest] }];
      }
    }
    return null;
  }

  /** Строки абзаца: слова и их ширины. */
  function breakLines(words, size, width, firstIndent, { hyphens = true } = {}) {
    const lines = [];
    let line = [];
    let lineWidth = 0;
    let available = width - firstIndent;
    const space = spaceWidth(size);
    const queue = [...words];
    while (queue.length) {
      const word = queue.shift();
      const w = wordWidth(word, size);
      if (w > available && !line.length) {
        const [head, ...rest] = splitLong(word, size, available);
        queue.unshift(...rest);
        line.push({ word: head, width: wordWidth(head, size) });
        lines.push({ items: line, natural: wordWidth(head, size), available });
        line = [];
        lineWidth = 0;
        available = width;
        continue;
      }
      const extra = line.length ? space + w : w;
      if (lineWidth + extra > available && line.length) {
        // Строка вышла бы редкой — переносим часть слова.
        const loose = (available - lineWidth) / Math.max(1, line.length - 1) > space * 0.7;
        const parts = hyphens && loose ? hyphenate(word, size, available - lineWidth - space) : null;
        if (parts) {
          const headWidth = wordWidth(parts[0], size);
          line.push({ word: parts[0], width: headWidth });
          lines.push({ items: line, natural: lineWidth + space + headWidth, available });
          line = [];
          lineWidth = 0;
          available = width;
          queue.unshift(parts[1]);
          continue;
        }
        lines.push({ items: line, natural: lineWidth, available });
        line = [];
        lineWidth = 0;
        available = width;
        queue.unshift(word);
        continue;
      }
      line.push({ word, width: w });
      lineWidth += extra;
    }
    if (line.length) lines.push({ items: line, natural: lineWidth, available, last: true });
    return lines;
  }

  /** Нарисовать строку: куски одного начертания — одним вызовом. */
  function drawLine(line, size, x, justify) {
    const space = spaceWidth(size);
    const gaps = line.items.length - 1;
    let gap = 0;
    if (justify && gaps > 0 && !line.last) {
      const extra = (line.available - line.natural) / gaps;
      if (extra > 0 && extra <= space * MAX_STRETCH) gap = extra;
    }
    const baseline = pdfY(y);
    let cursor = x;
    // Сборка кусков: соседние куски одного начертания и не надстрочные — вместе, с пробелами.
    let chunk = null;
    const flush = () => {
      if (!chunk) return;
      const raise = chunk.sup ? size * 0.38 : 0;
      page.text(chunk.font, pieceSize(chunk, size), chunk.x, baseline + raise, chunk.text, { gaps: chunk.sup ? 0 : gap });
      chunk = null;
    };
    line.items.forEach(({ word }, index) => {
      word.pieces.forEach((piece, pieceIndex) => {
        const leadingSpace = index > 0 && pieceIndex === 0;
        if (chunk && (chunk.font !== piece.font || chunk.sup !== piece.sup || piece.sup)) flush();
        if (leadingSpace && chunk) {
          chunk.text += ' ';
          cursor += space + gap;
        } else if (leadingSpace) {
          cursor += space + gap;
        }
        if (!chunk) chunk = { font: piece.font, sup: piece.sup, x: cursor, text: '' };
        chunk.text += piece.text;
        cursor += doc.measure(piece.font, pieceSize(piece, size), piece.text);
        if (piece.sup) flush(); // знак сноски — отдельным куском
      });
    });
    flush();
  }

  /**
   * Абзац целиком.
   * @param options { size, indent, align: 'justify'|'left'|'center'|'right', left, right, before, after, keepWithNext }
   */
  function paragraph(runs, options = {}) {
    const size = options.size ?? BODY;
    const leading = size * LEADING;
    const left = PAGE.left + (options.left ?? 0);
    const width = contentWidth - (options.left ?? 0) - (options.right ?? 0);
    const indent = options.indent ?? 0;
    const words = wordsOf(runs);
    if (!words.length) return null;
    // Переносы по слогам — только если их не выключили (настройка «Переносить слова»).
    const hyphenate = hyphens && (options.hyphens ?? (options.align == null || options.align === 'justify'));
    const lines = breakLines(words, size, width, indent, { hyphens: hyphenate });
    const before = pageEmpty ? 0 : (options.before ?? 0);
    // Заголовок не остаётся последней строкой страницы.
    const keep = options.keepWithNext ? leading * 2 : 0;
    if (!pageEmpty && room() < before + leading + keep) newPage();
    else y += before;
    if (pageEmpty) y += size * 0.8; // первая строка — по высоте букв
    const first = { page, y: pdfY(y - size) };
    lines.forEach((line, i) => {
      if (i > 0) {
        y += leading;
        if (room() < 0) {
          newPage();
          y += size * 0.8;
        }
      }
      const lineIndent = i === 0 ? indent : 0;
      let x = left + lineIndent;
      const free = line.available - line.natural;
      if (options.align === 'center') x += free / 2;
      else if (options.align === 'right') x += free;
      drawLine(line, size, x, options.align === 'justify' || options.align == null);
      pageEmpty = false;
    });
    y += leading;
    y += options.after ?? 0;
    return first;
  }

  function gap(height) {
    if (pageEmpty) return;
    y += height;
  }

  function image(jpeg) {
    const maxWidth = contentWidth;
    const maxHeight = (PAGE.height - PAGE.top - PAGE.bottom) * 0.75;
    const scale = Math.min(1, maxWidth / jpeg.width, maxHeight / jpeg.height);
    const width = jpeg.width * scale;
    const height = jpeg.height * scale;
    if (!pageEmpty && room() < height + BODY) newPage();
    const ref = doc.addJpeg(jpeg.bytes, jpeg.width, jpeg.height);
    y += pageEmpty ? 0 : BODY * 0.6;
    page.image(ref, PAGE.left + (contentWidth - width) / 2, pdfY(y + height), width, height);
    y += height + BODY;
    pageEmpty = false;
  }

  // ── Титульный лист ──
  newPage({ number: false });
  if (book.cover) {
    const cover = book.cover;
    const scale = Math.min((PAGE.width - 60) / cover.width, (PAGE.height - 60) / cover.height);
    const ref = doc.addJpeg(cover.bytes, cover.width, cover.height);
    const width = cover.width * scale;
    const height = cover.height * scale;
    page.image(ref, (PAGE.width - width) / 2, (PAGE.height - height) / 2, width, height);
    newPage({ number: false });
  }
  y = PAGE.height * 0.3;
  pageEmpty = false;
  if (book.author) paragraph([{ text: book.author }], { size: 13, align: 'center', after: 10 });
  paragraph([{ text: book.title || 'Без названия', bold: true }], { size: 20, align: 'center' });
  // Текст — со следующей страницы; разрыв или глава на пустой странице её не добавляют.
  newPage();

  // ── Текст ──
  for (const block of book.blocks) {
    if (block.type === 'pagebreak') {
      if (!pageEmpty) newPage();
      continue;
    }
    if (block.type === 'gap') {
      gap(BODY * LEADING * 0.8);
      continue;
    }
    if (block.type === 'image') {
      if (block.jpeg) image(block.jpeg);
      continue;
    }
    if (block.type === 'heading') {
      const level = Math.min(block.level ?? 0, HEADING_SIZES.length - 1);
      // Глава — с новой страницы.
      if (level === 0 && !pageEmpty) newPage();
      const at = paragraph(
        block.runs.map((run) => ({ ...run, bold: true })),
        { size: HEADING_SIZES[level], align: level === 0 ? 'center' : 'left', before: BODY * 1.6, after: BODY * (level === 0 ? 1.2 : 0.5), keepWithNext: true }
      );
      if (at && block.outline !== false) {
        // Знак сноски в заголовке — не часть названия главы.
        const title = block.runs
          .filter((run) => !run.sup)
          .map((run) => run.text)
          .join('')
          .replace(/\s+/g, ' ')
          .trim();
        if (title) doc.addOutline(title, level, at.page, at.y + HEADING_SIZES[level] * 1.5);
      }
      continue;
    }
    if (block.type === 'verse') {
      paragraph(block.runs, { align: 'left', left: BODY * 2.5 });
      continue;
    }
    const style = block.style ?? 'normal';
    if (style === 'epigraph') paragraph(block.runs.map((run) => ({ ...run, italic: !run.italic })), { size: BODY * 0.92, align: 'left', left: contentWidth * 0.35, before: 2 });
    else if (style === 'cite') paragraph(block.runs, { size: BODY * 0.95, indent: BODY * INDENT, left: BODY * 2, right: BODY, before: 2 });
    else if (style === 'center') paragraph(block.runs, { align: 'center', before: BODY * 0.4, after: BODY * 0.4 });
    else if (style === 'subtitle') paragraph(block.runs.map((run) => ({ ...run, bold: true })), { align: 'center', before: BODY * 0.8, after: BODY * 0.4, keepWithNext: true });
    else if (style === 'right') paragraph(block.runs, { align: 'right' });
    else paragraph(block.runs, { indent: BODY * INDENT });
  }

  // ── Примечания ──
  if (book.notes?.length) {
    newPage();
    const at = paragraph([{ text: 'Примечания', bold: true }], { size: HEADING_SIZES[0], align: 'center', after: BODY * 1.2, keepWithNext: true });
    if (at) doc.addOutline('Примечания', 0, at.page, at.y + HEADING_SIZES[0] * 1.5);
    book.notes.forEach((note, i) => {
      const [first = [], ...rest] = note;
      // Запись — с надстрочного номера; между записями — отбивка (новый абзац).
      paragraph([{ text: String(i + 1), sup: true }, { text: ' ' }, ...first], { size: BODY * 0.95, before: BODY * 0.7 });
      for (const runs of rest) paragraph(runs, { size: BODY * 0.95, indent: BODY * INDENT });
    });
  }

  // ── Номера страниц — те же, что в читалке ──
  pages.forEach(({ page: target, numbered }, index) => {
    if (!numbered) return;
    const label = String(index + 1);
    target.text('regular', 9, (PAGE.width - doc.measure('regular', 9, label)) / 2, PAGE.bottom / 2, label);
  });
  return doc.save();
}
