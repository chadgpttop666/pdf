// Подготовка фразы для TeraTTS — без ONNX и DOM, проверяется юнит-тестами.
//
// Замеры на настоящей модели (Whisper слушал результат):
//   • русский и английский в одном вызове («<ru>…</ru><en>…</en>») ломают
//     всю фразу — получается бормотание; английский кусок отдельным вызовом
//     тем же русским голосом звучит чисто. Поэтому фраза режется на куски
//     по языку, каждый синтезируется сам по себе, звук склеивается;
//   • однобуквенный кусок («в» между двумя названиями) модель тянет на
//     секунду («о-о-о»); если ужать длительность до ~0,1 с на букву —
//     звучит нормально;
//   • один вызов — не длиннее ~25 с речи: длинное предложение режем по
//     знакам препинания. Первый кусок после старта делаем короче, чтобы
//     звук пошёл быстрее.

import { splitLanguageRuns } from './language-runs.js';

const MAX_CHARS = 220;
// Быстрый старт: куски нарастают — первый звучит, пока готовится второй,
// второй — пока третий. Пределы — в произносимых знаках: «1945» звучит как
// «тысяча девятьсот сорок пятого».
const START_CHARS = [40, 70, 120];
const MIN_CHUNK = 25;
// Кавычки и скобки по краям куска не звучат, а модели только мешают.
const EDGE_OPEN = /^[\s«»"“”„'‘’()[\]{}—–\-,;:]+/u;
const EDGE_CLOSE = /[\s«»"“”„'‘’()[\]{}—–-]+$/u;
const SPEAKABLE = /[\p{L}\p{N}]/u;

const letterCount = (text) => (text.match(/[\p{L}\p{N}]/gu) || []).length;

/** Пауза после куска — по знаку, которым он кончается. */
export function pauseAfter(text, last) {
  if (last) return 0.25;
  if (/[.!?…]$/.test(text)) return 0.3;
  if (/[;:—–]$/.test(text)) return 0.2;
  if (/,$/.test(text)) return 0.12;
  return 0.05; // смена языка посреди фразы
}

/**
 * Длительность совсем коротких кусков ограничиваем: иначе одна буква
 * растягивается на секунду. null — не ограничиваем.
 */
export function maxSecondsFor(text) {
  const letters = letterCount(text);
  return letters <= 4 ? 0.25 + 0.11 * letters : null;
}

const PUNCTUATION_CUT = /[,;:](?=\s)|\s[—–](?=\s)/g;
// Начало оборота: кавычка, скобка, предлог или союз — здесь пауза не рвёт смысл.
const PHRASE_START = /\s(?=[«(„"]|(?:в|во|на|по|к|ко|с|со|у|о|об|от|до|из|за|для|при|про|через|и|а|но|или|что|чтобы|как|когда|который|которая|которое|которые|если)\s)/giu;

function lastCut(text, pattern, from, to) {
  let best = -1;
  for (const match of text.slice(0, to).matchAll(pattern)) {
    const end = match.index + match[0].length;
    if (end >= from) best = end;
  }
  return best;
}

/**
 * Где резать длинный кусок: по последнему знаку препинания до предела,
 * иначе по пробелу. Первые куски быстрого старта короткие — им годится и
 * начало оборота, и запятая чуть дальше предела: пауза там звучит
 * естественнее обрыва посреди словосочетания.
 */
function cutPoint(text, limit, early = false) {
  const min = early ? 12 : MIN_CHUNK;
  const candidates = early
    ? [lastCut(text, PUNCTUATION_CUT, min, limit), lastCut(text, PHRASE_START, min, limit), lastCut(text, PUNCTUATION_CUT, min, Math.round(limit * 1.5))]
    : [lastCut(text, PUNCTUATION_CUT, min, limit)];
  const found = candidates.find((cut) => cut > 0);
  if (found) return found;
  const space = text.slice(0, limit).lastIndexOf(' ');
  return space >= min ? space : limit;
}

/**
 * Куски фразы для синтеза.
 * @param options.fastStart первые куски короче — звук начнётся быстрее
 * @param options.measure (кусок, язык) → сколько знаков в нём прозвучит
 * @returns {{ lang: 'ru'|'en', start: number, end: number, text: string, pause: number, maxSeconds: number|null }[]}
 *   start/end — в исходном тексте (для подсветки слов), text — сам кусок
 */
export function planPieces(text, { fastStart = false, maxChars = MAX_CHARS, startChars = START_CHARS, measure = (part) => part.length } = {}) {
  const pieces = [];
  for (const run of splitLanguageRuns(text)) {
    let start = run.start;
    let end = run.end;
    const lead = EDGE_OPEN.exec(text.slice(start, end));
    if (lead) start += lead[0].length;
    const tail = EDGE_CLOSE.exec(text.slice(start, end));
    if (tail) end -= tail[0].length;
    if (end <= start || !SPEAKABLE.test(text.slice(start, end))) continue;

    while (start < end) {
      const early = fastStart ? startChars[pieces.length] : undefined;
      const rest = text.slice(start, end);
      // Предел в знаках исходного текста — с поправкой на то, насколько
      // длиннее он прозвучит.
      const stretch = early ? Math.max(1, measure(rest, run.lang) / rest.length) : 1;
      const limit = Math.round((early ?? maxChars) / stretch);
      let stop = end;
      if (end - start > limit) stop = start + cutPoint(rest, limit, Boolean(early));
      const chunk = text.slice(start, stop).trimEnd();
      if (SPEAKABLE.test(chunk)) pieces.push({ lang: run.lang, start, end: start + chunk.length, text: chunk });
      start = stop;
      while (start < end && /\s/.test(text[start])) start += 1;
    }
  }
  pieces.forEach((piece, i) => {
    // Знак сразу за куском (точка после «Ethics») решает, какая нужна пауза.
    const after = text.slice(piece.end).match(/^[\s«»"“”„'()[\]{}]*([.!?…;:,—–])/u)?.[1] || '';
    piece.pause = pauseAfter(piece.text + after, i === pieces.length - 1);
    piece.maxSeconds = maxSecondsFor(piece.text);
  });
  return pieces;
}

/**
 * Текст для модели: пробелы после знаков, языковой тег, NFKD (так модель
 * обучали: «й» — это «и» + бреве). Символов, которых нет в словаре модели,
 * быть не должно — их убирает keepSupported.
 */
export function modelText(lang, text) {
  // Знак вплотную к следующему слову модель читает хуже — так готовит текст
  // и её собственный код (кроме десятичных дробей: «2,5»).
  // Скобки и черты модель не произносит, но спотыкается на них (так их
  // убирает и подготовка текста Supertonic, на котором она основана);
  // кавычки внутри английского куска — стык двух названий.
  const cleaned = text.replace(/[[\]{}|/#]/g, ' ').replace(lang === 'en' ? /[«»„“”"]/g : /$^/g, '');
  const spaced = cleaned
    .normalize('NFC')
    .replace(/[,.!?;:…](?=[^\s<])/g, (mark, at, all) => ('.,'.includes(mark) && /\d/.test(all[at - 1]) && /\d/.test(all[at + 1]) ? mark : `${mark} `))
    .replace(/(?<=\d)(?=\p{L})/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return `<${lang}>${spaced}</${lang}>`.normalize('NFKD');
}

/**
 * Убрать символы, которых нет в словаре модели (эмодзи, редкие знаки).
 * @param table Int32Array: код символа → номер в словаре или -1
 */
export function keepSupported(text, table) {
  let out = '';
  for (const char of text.normalize('NFC')) {
    const parts = char.normalize('NFKD');
    if ([...parts].every((part) => (table[part.codePointAt(0)] ?? -1) >= 0)) out += char;
  }
  return out;
}

/** Номера символов для text_encoder (с «+») и duration_predictor (без «+»). */
export function encodeText(text, table) {
  const ids = (value) => BigInt64Array.from(value, (char) => BigInt(table[char.codePointAt(0)]));
  return { withStress: ids(text), plain: ids(text.replaceAll('+', '')) };
}

/**
 * Тишина по краям куска: модель оставляет до 0,2 с с каждой стороны, при
 * склейке кусков это превращается в запинки. Срезаем, оставляя margin.
 * @returns {[number, number]} начало и конец звучащей части
 */
export function voicedRange(pcm, sampleRate, { threshold = 0.01, margin = 0.03 } = {}) {
  const window = Math.round(sampleRate * 0.01);
  const loud = (from) => {
    let sum = 0;
    const to = Math.min(pcm.length, from + window);
    for (let i = from; i < to; i += 1) sum += pcm[i] * pcm[i];
    return Math.sqrt(sum / Math.max(1, to - from)) > threshold;
  };
  let first = 0;
  while (first < pcm.length && !loud(first)) first += window;
  let last = pcm.length;
  while (last > first && !loud(Math.max(0, last - window))) last -= window;
  if (first >= last) return [0, pcm.length];
  const pad = Math.round(sampleRate * margin);
  return [Math.max(0, first - pad), Math.min(pcm.length, last + pad)];
}

/** Стиль голоса из файла .npy (float32, little-endian). */
export function parseNpy(buffer) {
  const bytes = new Uint8Array(buffer);
  if (bytes[0] !== 0x93 || String.fromCharCode(...bytes.slice(1, 6)) !== 'NUMPY') throw new Error('Не файл .npy');
  const major = bytes[6];
  const view = new DataView(buffer);
  const headerLength = major === 1 ? view.getUint16(8, true) : view.getUint32(8, true);
  const headerStart = major === 1 ? 10 : 12;
  const header = new TextDecoder().decode(bytes.slice(headerStart, headerStart + headerLength));
  if (!/'descr':\s*'<f4'/.test(header) || /'fortran_order':\s*True/.test(header)) throw new Error('Стиль голоса в неожиданном формате');
  const shape = (header.match(/'shape':\s*\(([^)]*)\)/)?.[1] || '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean)
    .map(Number);
  const start = headerStart + headerLength;
  return { shape, data: new Float32Array(buffer.slice(start, start + shape.reduce((a, b) => a * b, 1) * 4)) };
}
