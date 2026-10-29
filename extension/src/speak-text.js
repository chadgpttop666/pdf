// Текст, выделенный на странице сайта, → абзацы и предложения для чтения
// вслух. Без DOM — проверяется юнит-тестами.
//
// getSelection().toString() отдаёт блоки страницы отдельными строками, а
// текст, скопированный из PDF или книги, — строками по ширине колонки, с
// переносами по слогам. Строку, оборванную посреди фразы (дальше идёт
// строчная буква), склеиваем со следующей; остальные строки — абзацы.

import { segmentSentences } from './text-index.js';

const SENTENCE_END = /[.!?…:;»"”')\]]$/u;

/** @returns {string[]} абзацы, пробелы внутри схлопнуты */
export function paragraphsFromSelection(raw) {
  const text = String(raw || '')
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t  ]/g, ' ')
    .replace(/[​­]/g, ''); // невидимые пробелы и мягкие переносы
  const paragraphs = [];
  for (const block of text.split(/\n\s*\n/)) {
    let current = '';
    for (const rawLine of block.split('\n')) {
      const line = rawLine.replace(/\s+/g, ' ').trim();
      if (!line) continue;
      if (!current) {
        current = line;
        continue;
      }
      if (/\p{L}-$/u.test(current) && /^\p{Ll}/u.test(line)) {
        current = current.slice(0, -1) + line; // перенос по слогам
      } else if (!SENTENCE_END.test(current) && /^\p{Ll}/u.test(line)) {
        current += ` ${line}`; // фраза продолжается на следующей строке
      } else {
        paragraphs.push(current);
        current = line;
      }
    }
    if (current) paragraphs.push(current);
  }
  return paragraphs;
}

/**
 * Абзацы → предложения для чтения.
 * @returns {{ text: string, paragraph: number, start: number, end: number }[]}
 *   start/end — место предложения в своём абзаце
 */
export function sentencesOf(paragraphs, lang = 'ru') {
  const sentences = [];
  paragraphs.forEach((paragraph, index) => {
    for (const { start, end } of segmentSentences(paragraph, lang)) {
      sentences.push({ text: paragraph.slice(start, end), paragraph: index, start, end });
    }
  });
  return sentences;
}

/**
 * Предложения прямо в тексте, собранном со страницы сайта: места совпадают
 * с ним символ в символ — по ним фраза и слово подсвечиваются на самой
 * странице. Абзацы в тексте разделены '\n', пробелы уже схлопнуты.
 * @returns {{ text: string, start: number, end: number }[]}
 */
export function sentencesInText(text, lang = 'ru') {
  const sentences = [];
  let offset = 0;
  for (const paragraph of String(text || '').split('\n')) {
    for (const { start, end } of segmentSentences(paragraph, lang)) {
      sentences.push({ text: paragraph.slice(start, end), start: offset + start, end: offset + end });
    }
    offset += paragraph.length + 1;
  }
  return sentences;
}
