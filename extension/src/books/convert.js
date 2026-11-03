// Книга FB2 / FB2.ZIP / EPUB → PDF, прямо в браузере. Дальше она открывается
// как обычный PDF: поиск, озвучка, выделения, статистика, аудиокнига.

import { parseEpub } from './epub.js';
import { parseFb2 } from './fb2.js';
import { layoutBook } from './layout.js';
import { parseTtf } from './ttf.js';
import { readZip } from './unzip.js';

const BOOK_NAME = /\.(fb2|fb2\.zip|fbz|epub)$/i;

/** Похоже ли на книгу FB2/EPUB — по имени или по первым байтам. */
export function bookFormat(name = '', head = new Uint8Array()) {
  const lower = name.toLowerCase();
  if (/\.epub$/.test(lower)) return 'epub';
  if (/\.(fb2\.zip|fbz)$/.test(lower)) return 'fb2zip';
  if (/\.fb2$/.test(lower)) return 'fb2';
  const text = new TextDecoder('latin1').decode(head.subarray(0, 200));
  if (head[0] === 0x50 && head[1] === 0x4b && text.includes('mimetypeapplication/epub+zip')) return 'epub';
  if (/<FictionBook/i.test(text)) return 'fb2';
  return null;
}

export const isBookName = (name) => BOOK_NAME.test(name ?? '');

/** Имя PDF для книги: «Книга.fb2» → «Книга.pdf». */
export const pdfName = (name) => `${String(name || 'книга').replace(BOOK_NAME, '')}.pdf`;

const FONT_FILES = { regular: 'PTSerif-Regular.ttf', italic: 'PTSerif-Italic.ttf', bold: 'PTSerif-Bold.ttf', boldItalic: 'PTSerif-BoldItalic.ttf' };
let fontsPromise = null;

/** Шрифты для вёрстки: PT Serif (OFL), лежат в vendor/fonts. */
export function loadFonts(readFile = async (name) => new Uint8Array(await (await fetch(new URL(`../../vendor/fonts/${name}`, import.meta.url))).arrayBuffer())) {
  fontsPromise ??= Promise.all(Object.entries(FONT_FILES).map(async ([key, file]) => [key, parseTtf(await readFile(file))])).then(Object.fromEntries);
  return fontsPromise;
}

// Картинки — не крупнее этого по большей стороне: страница всё равно небольшая.
const MAX_IMAGE = 1400;

/** Любая картинка → JPEG на белом фоне (у PNG бывает прозрачность). */
export async function toJpeg(blob) {
  const bitmap = await createImageBitmap(blob);
  const scale = Math.min(1, MAX_IMAGE / Math.max(bitmap.width, bitmap.height));
  const width = Math.max(1, Math.round(bitmap.width * scale));
  const height = Math.max(1, Math.round(bitmap.height * scale));
  const canvas = new OffscreenCanvas(width, height);
  const context = canvas.getContext('2d');
  context.fillStyle = '#fff';
  context.fillRect(0, 0, width, height);
  context.drawImage(bitmap, 0, 0, width, height);
  bitmap.close?.();
  const jpeg = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.86 });
  return { bytes: new Uint8Array(await jpeg.arrayBuffer()), width, height };
}

/** Первый .fb2 внутри архива. */
async function unzipFb2(bytes) {
  const entries = readZip(bytes);
  const name = [...entries.keys()].find((entry) => /\.fb2$/i.test(entry));
  if (!name) throw new Error('в архиве нет файла .fb2');
  return entries.get(name)();
}

/**
 * @param bytes Uint8Array книги
 * @param name имя файла (по нему и по первым байтам определяется формат)
 * @returns {Promise<{ pdf: Uint8Array, title: string, author: string, format: string }>}
 */
export async function convertBook(bytes, name, { fonts, images = toJpeg } = {}) {
  const format = bookFormat(name, bytes);
  if (!format) throw new Error('это не FB2 и не EPUB');
  const book =
    format === 'epub'
      ? await parseEpub(bytes, { toJpeg: images })
      : await parseFb2(format === 'fb2zip' ? await unzipFb2(bytes) : bytes, { toJpeg: images });
  if (!book.title) book.title = String(name || 'Книга').replace(BOOK_NAME, '');
  const pdf = await layoutBook(book, fonts ?? (await loadFonts()));
  return { pdf, title: book.title, author: book.author, format, notes: book.notes.length };
}
