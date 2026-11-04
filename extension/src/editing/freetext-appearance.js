// Оформление текстовых заметок для других программ.
//
// pdf.js, сохраняя текстовую заметку (FreeText), рисует её оформление (/AP)
// шрифтом Helvetica, а если в тексте есть что-то кроме латиницы — не рисует
// вовсе: сам pdf.js и Firefox потом строят его на лету, а Adobe Reader,
// Chrome, читалки на телефоне показывают пустое место или «?». Поэтому после
// сохранения дописываем к файлу ещё одно обновление: каждой заметке из
// последнего обновления pdf.js — оформление шрифтом PT Serif (кириллица,
// латиница), вложенным в файл и с ToUnicode — текст заметки и выделяется, и
// ищется. В читалке заметка набирается тем же шрифтом (viewer.css), поэтому
// размеры совпадают.

import { createFont, deflate, writeType0Font } from '../books/pdf-writer.js';

const encoder = new TextEncoder();
// Как в pdf.js: межстрочный — 1,35 кегля, поле вокруг текста — 2 пт.
const LINE_FACTOR = 1.35;
const PADDING = 2;

const number = (value) => {
  if (Number.isInteger(value)) return String(value);
  const text = value.toFixed(4).replace(/\.?0+$/, '');
  return text === '-0' ? '0' : text;
};

/** Байты → строка «байт = символ» (индексы совпадают со смещениями в файле). */
function binary(bytes) {
  let out = '';
  for (let i = 0; i < bytes.length; i += 0x8000) out += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return out;
}

const ESCAPES = { n: 10, r: 13, t: 9, b: 8, f: 12, '(': 40, ')': 41, '\\': 92 };

/**
 * Строка PDF в круглых скобках, начиная с «(» на позиции at.
 * @returns {{ bytes: number[], end: number }} байты строки и позиция после «)»
 */
export function readLiteral(text, at) {
  const bytes = [];
  let depth = 0;
  let i = at;
  for (; i < text.length; i += 1) {
    const char = text[i];
    if (char === '\\') {
      const next = text[i + 1];
      if (next in ESCAPES) {
        bytes.push(ESCAPES[next]);
        i += 1;
      } else if (/[0-7]/.test(next)) {
        const digits = text.slice(i + 1, i + 4).match(/^[0-7]{1,3}/)[0];
        bytes.push(parseInt(digits, 8) & 0xff);
        i += digits.length;
      } else if (next === '\r' || next === '\n') {
        i += next === '\r' && text[i + 2] === '\n' ? 2 : 1; // перенос строки внутри строки — не символ
      } else {
        i += 1; // неизвестное «\x» — просто x
        bytes.push(next.charCodeAt(0) & 0xff);
      }
      continue;
    }
    if (char === '(') {
      depth += 1;
      if (depth === 1) continue;
    } else if (char === ')') {
      depth -= 1;
      if (depth === 0) return { bytes, end: i + 1 };
    }
    bytes.push(char.charCodeAt(0) & 0xff);
  }
  return { bytes, end: i };
}

/** Байты строки PDF → текст: UTF-16BE с меткой FE FF, иначе как Latin-1. */
export function decodePdfString(bytes) {
  if (bytes[0] === 0xfe && bytes[1] === 0xff) {
    let out = '';
    for (let i = 2; i + 1 < bytes.length; i += 2) out += String.fromCharCode((bytes[i] << 8) | bytes[i + 1]);
    return out;
  }
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) return new TextDecoder().decode(new Uint8Array(bytes.slice(3)));
  return String.fromCharCode(...bytes);
}

/** Значение ключа словаря: число, массив чисел или строка. */
function numbersAfter(dict, key) {
  const match = dict.match(new RegExp(`/${key}\\s*\\[([^\\]]*)\\]`));
  return match ? match[1].trim().split(/\s+/).map(Number) : null;
}
function numberAfter(dict, key) {
  const match = dict.match(new RegExp(`/${key}\\s+(-?[\\d.]+)`));
  return match ? Number(match[1]) : null;
}

/**
 * Текстовая заметка из словаря объекта (как его пишет pdf.js).
 * @returns {{ rect, rotation, fontSize, color: number[], opacity, text } | null}
 */
export function parseFreeText(dict) {
  if (!/\/Subtype\s*\/FreeText\b/.test(dict)) return null;
  const rect = numbersAfter(dict, 'Rect');
  const da = dict.match(/\/DA\s*\(([^)]*)\)/)?.[1] ?? '';
  const contentsAt = dict.search(/\/Contents\s*\(/);
  if (!rect || rect.length !== 4 || contentsAt < 0) return null;
  const { bytes } = readLiteral(dict, dict.indexOf('(', contentsAt));
  const fontSize = Number(da.match(/([\d.]+)\s+Tf/)?.[1]) || 10;
  const rgb = da.match(/([\d.]+)\s+([\d.]+)\s+([\d.]+)\s+rg/);
  const gray = da.match(/([\d.]+)\s+g\b/);
  const color = rgb ? rgb.slice(1, 4).map(Number) : gray ? [Number(gray[1]), Number(gray[1]), Number(gray[1])] : [0, 0, 0];
  const [x1, y1, x2, y2] = rect;
  return {
    rect: [Math.min(x1, x2), Math.min(y1, y2), Math.max(x1, x2), Math.max(y1, y2)],
    rotation: ((numberAfter(dict, 'Rotate') ?? 0) % 360 + 360) % 360,
    fontSize,
    color,
    opacity: numberAfter(dict, 'CA') ?? 1,
    text: decodePdfString(bytes),
  };
}

/**
 * Содержимое оформления заметки: строки текста шрифтом /F1 по раскладке
 * редактора pdf.js (поле, межстрочный, поворот страницы).
 * @param font createFont() с PT Serif — символы набираются в нём
 */
export function appearanceContent(note, font, { opacityName = null } = {}) {
  const { rect, rotation, fontSize, color, text } = note;
  const { ttf } = font;
  const [x1, y1, x2, y2] = rect;
  let w = x2 - x1;
  let h = y2 - y1;
  if (rotation % 180 !== 0) [w, h] = [h, w];
  // Символов, которых нет в шрифте, не рисуем пустыми квадратами.
  const lines = text.split(/\r\n?|\n/).map((line) => [...line].map((char) => (ttf.has(char.codePointAt(0)) || /\s/.test(char) ? char : '?')).join(''));
  const ascent = ttf.ascent / ttf.unitsPerEm;
  const descent = -ttf.descent / ttf.unitsPerEm;
  // Первая базовая линия — как в CSS: половина межстрочного «воздуха» над строкой плюс высота над линией.
  const baseline = PADDING + ((LINE_FACTOR - (ascent + descent)) / 2 + ascent) * fontSize;
  const widest = Math.max(...lines.map((line) => font.width(line) * fontSize), 0);
  const room = w - 2 * PADDING;
  const squeeze = widest > room && widest > 0 ? (100 * room) / widest : 100;
  let matrix;
  let clip;
  let first;
  switch (rotation) {
    case 90:
      matrix = [0, 1, -1, 0];
      clip = [y1, -x2, w, h];
      first = [y1 + PADDING, -x1 - baseline];
      break;
    case 180:
      matrix = [-1, 0, 0, -1];
      clip = [-x2, -y2, w, h];
      first = [-x2 + PADDING, -y1 - baseline];
      break;
    case 270:
      matrix = [0, -1, 1, 0];
      clip = [-y2, x1, w, h];
      first = [-y2 + PADDING, x2 - baseline];
      break;
    default:
      matrix = [1, 0, 0, 1];
      clip = [x1, y1, w, h];
      first = [x1 + PADDING, y2 - baseline];
  }
  const ops = ['q', `${matrix.join(' ')} 0 0 cm`, `${clip.map(number).join(' ')} re W n`];
  if (opacityName) ops.push(`/${opacityName} gs`);
  ops.push('BT', `${color.map(number).join(' ')} rg`, `/F1 ${number(fontSize)} Tf`);
  if (squeeze < 100) ops.push(`${number(squeeze)} Tz`);
  lines.forEach((line, i) => {
    const move = i === 0 ? `${number(first[0])} ${number(first[1])}` : `0 ${number(-LINE_FACTOR * fontSize)}`;
    ops.push(`${move} Td <${font.encode(line).hex}> Tj`);
  });
  ops.push('ET', 'Q');
  return ops.join('\n');
}

/** Объекты одного раздела файла: номер → { start, end, body } (body — между «obj» и «endobj»). */
function objectsIn(text, from) {
  const objects = [];
  const header = /(\d+)\s+(\d+)\s+obj\b/g;
  header.lastIndex = from;
  for (let match = header.exec(text); match; match = header.exec(text)) {
    const bodyStart = match.index + match[0].length;
    const end = text.indexOf('endobj', bodyStart);
    if (end < 0) break;
    objects.push({ id: Number(match[1]), gen: Number(match[2]), body: text.slice(bodyStart, end).trim() });
    header.lastIndex = end + 6;
  }
  return objects;
}

/** Словарь трейлера последнего раздела: из «trailer << >>» или из потока XRef. */
function lastTrailer(text) {
  const startxref = [...text.matchAll(/startxref\s+(\d+)/g)].at(-1);
  if (!startxref) return null;
  const offset = Number(startxref[1]);
  if (text.startsWith('xref', offset)) {
    const at = text.indexOf('trailer', offset);
    const dict = at >= 0 ? text.slice(at, text.indexOf('startxref', at)) : '';
    return { offset, stream: false, dict };
  }
  const end = text.indexOf('stream', offset);
  return { offset, stream: true, dict: end > 0 ? text.slice(offset, end) : '' };
}

/** Таблица xref: номера идут подряд — одним подразделом. */
function xrefTable(entries) {
  const sorted = [...entries].sort((a, b) => a.id - b.id);
  const lines = ['xref'];
  for (let i = 0; i < sorted.length; ) {
    let j = i;
    while (j + 1 < sorted.length && sorted[j + 1].id === sorted[j].id + 1) j += 1;
    lines.push(`${sorted[i].id} ${j - i + 1}`);
    for (let k = i; k <= j; k += 1) lines.push(`${String(sorted[k].offset).padStart(10, '0')} ${String(sorted[k].gen).padStart(5, '0')} n `);
    i = j + 1;
  }
  return `${lines.join('\n')}\n`;
}

/**
 * Дописать к сохранённому pdf.js файлу оформление его текстовых заметок.
 * @param bytes результат pdfDocument.saveDocument()
 * @param ttf шрифт PT Serif Regular (books/ttf.js)
 * @returns {Promise<Uint8Array>} новый файл; если заметок нет или файл
 *   непривычного вида — исходные байты без изменений
 */
export async function addFreeTextAppearances(bytes, ttf) {
  // Последнее обновление — после предпоследнего %%EOF; читаем только его.
  const tailStart = Math.max(0, bytes.length - 4 * 1024 * 1024);
  const tail = binary(bytes.subarray(tailStart));
  const eofs = [...tail.matchAll(/%%EOF/g)].map((match) => match.index);
  if (eofs.length < 2 && tailStart === 0) return bytes;
  const sectionStart = eofs.length >= 2 ? eofs.at(-2) + 5 : 0;
  const trailer = lastTrailer(tail);
  if (!trailer || /\/Encrypt\b/.test(trailer.dict)) return bytes; // зашифрованный — оставляем как есть
  const size = numberAfter(trailer.dict, 'Size');
  const root = trailer.dict.match(/\/Root\s+(\d+\s+\d+\s+R)/)?.[1];
  if (!size || !root) return bytes;
  const info = trailer.dict.match(/\/Info\s+(\d+\s+\d+\s+R)/)?.[1];
  const id = trailer.dict.match(/\/ID\s*(\[[^\]]*\])/)?.[1];

  const notes = [];
  for (const object of objectsIn(tail, sectionStart)) {
    if (!object.body.startsWith('<<') || /\bstream\b/.test(object.body)) continue;
    const note = parseFreeText(object.body);
    if (note && note.text.trim()) notes.push({ ...object, note });
  }
  if (!notes.length) return bytes;

  // Новые объекты: шрифт, прозрачность, оформление каждой заметки.
  let nextId = size;
  const created = []; // { id, parts }
  const reserve = () => {
    const entry = { id: nextId, parts: null };
    nextId += 1;
    created.push(entry);
    return entry;
  };
  const put = (entry, dict) => {
    entry.parts = [dict];
    return entry.id;
  };
  const putStream = async (entry, dict, data, { compress = true } = {}) => {
    const body = compress ? await deflate(data) : data;
    entry.parts = [`<< ${dict}${compress ? ' /Filter /FlateDecode' : ''} /Length ${body.length} >>\nstream\n`, body, '\nendstream'];
    return entry.id;
  };

  const font = createFont('annotation', ttf);
  const fontEntry = reserve(); // номер нужен в каждом оформлении, сам шрифт пишем, когда символы набраны
  const appearances = [];
  for (const item of notes) {
    const { note } = item;
    const alpha = note.opacity < 1 ? reserve() : null;
    if (alpha) put(alpha, `<< /Type /ExtGState /ca ${number(note.opacity)} /CA ${number(note.opacity)} >>`);
    const content = appearanceContent(note, font, { opacityName: alpha ? 'GS1' : null });
    const [x1, y1, x2, y2] = note.rect;
    const resources = `/Resources << /Font << /F1 ${fontEntry.id} 0 R >>${alpha ? ` /ExtGState << /GS1 ${alpha.id} 0 R >>` : ''} >>`;
    const entry = reserve();
    await putStream(
      entry,
      `/Type /XObject /Subtype /Form /FormType 1 /BBox [${[x1, y1, x2, y2].map(number).join(' ')}] /Matrix [1 0 0 1 ${number(-x1)} ${number(-y1)}] ${resources}`,
      encoder.encode(content)
    );
    appearances.push({ item, ap: entry.id });
  }
  // Шрифт — с теми символами, что набраны выше, в заранее выделенный объект.
  await writeType0Font(font, 'PTSerif-Regular', { reserve, put, putStream }, fontEntry);

  // Заметки — те же словари, только с новым /AP.
  const rewritten = appearances.map(({ item, ap }) => {
    let dict = item.body.replace(/\/AP\s*<<(?:[^<>]|<<[^<>]*>>)*>>/, '');
    dict = dict.replace(/>>\s*$/, ` /AP << /N ${ap} 0 R >> >>`);
    return { id: item.id, gen: item.gen, parts: [dict] };
  });

  // Сборка обновления.
  const chunks = [];
  let offset = bytes.length;
  const entries = [];
  // Строки — побайтно: в переписанных словарях есть байты строк PDF (UTF-16), а не текст.
  const emit = (part) => {
    const data = typeof part === 'string' ? Uint8Array.from(part, (char) => char.charCodeAt(0) & 0xff) : part;
    chunks.push(data);
    offset += data.length;
  };
  emit('\n');
  for (const object of [...rewritten, ...created.map((entry) => ({ ...entry, gen: 0 }))]) {
    entries.push({ id: object.id, gen: object.gen, offset });
    emit(`${object.id} ${object.gen} obj\n`);
    for (const part of object.parts) emit(part);
    emit('\nendobj\n');
  }
  const prev = trailer.offset;
  const trailerKeys = `/Root ${root}${info ? ` /Info ${info}` : ''}${id ? ` /ID ${id}` : ''} /Prev ${prev}`;
  if (!trailer.stream) {
    const xrefAt = offset;
    emit(xrefTable(entries));
    emit(`trailer\n<< /Size ${nextId} ${trailerKeys} >>\nstartxref\n${xrefAt}\n%%EOF\n`);
  } else {
    // Раньше был поток XRef — и дальше поток: смещения по 4 байта, без сжатия.
    const self = nextId;
    const xrefAt = offset;
    entries.push({ id: self, gen: 0, offset: xrefAt });
    const sorted = entries.sort((a, b) => a.id - b.id);
    const data = new Uint8Array(sorted.length * 7);
    sorted.forEach((entry, i) => {
      const at = i * 7;
      data[at] = 1;
      data[at + 1] = (entry.offset >>> 24) & 0xff;
      data[at + 2] = (entry.offset >>> 16) & 0xff;
      data[at + 3] = (entry.offset >>> 8) & 0xff;
      data[at + 4] = entry.offset & 0xff;
      data[at + 5] = (entry.gen >> 8) & 0xff;
      data[at + 6] = entry.gen & 0xff;
    });
    const index = sorted.map((entry) => `${entry.id} 1`).join(' ');
    emit(`${self} 0 obj\n<< /Type /XRef /Size ${self + 1} /W [1 4 2] /Index [${index}] ${trailerKeys} /Length ${data.length} >>\nstream\n`);
    emit(data);
    emit(`\nendstream\nendobj\nstartxref\n${xrefAt}\n%%EOF\n`);
  }

  const out = new Uint8Array(offset);
  out.set(bytes, 0);
  let at = bytes.length;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.length;
  }
  return out;
}
