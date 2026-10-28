// Перевод результата распознавания в формат текстового слоя pdf.js — без DOM
// и WASM, чтобы его можно было проверить юнит-тестами.
//
// Распознанные слова становятся обычными элементами getTextContent():
// строка, ширина и матрица положения в координатах страницы PDF. Дальше
// с ними работает всё, что работает с текстом PDF: текстовый слой
// (выделение), поиск, озвучка, заметки, режим «только текст».

export const OCR_FONT = 'ocr-text';
/** Доля высоты строки над базовой линией: верх рамки слова = верх строки. */
const ASCENT = 0.8;
export const OCR_STYLES = { [OCR_FONT]: { fontFamily: 'sans-serif', ascent: ASCENT, descent: ASCENT - 1, vertical: false } };

/** Строка с такой средней уверенностью — текст, а не шум. */
const TRUSTED_LINE = 60;

/** Меньше стольких знаков — страница считается картинкой или сканом. */
export const TEXTLESS_CHARS = 20;

export function textLength(items = []) {
  return items.reduce((sum, item) => sum + (item.str || '').replace(/\s+/g, '').length, 0);
}

export function isTextless(items) {
  return textLength(items) < TEXTLESS_CHARS;
}

/**
 * Строки распознавания → элементы текстового слоя.
 * @param lines [{ bbox: {x0,y0,x1,y1}, words: [{ text, confidence, bbox }] }] в пикселях картинки
 * @param toPdf (x, y) → [x, y] в координатах страницы PDF
 */
export function ocrLinesToItems(lines, toPdf, { minConfidence = 20 } = {}) {
  const items = [];
  for (const line of lines) {
    const all = (line.words || []).filter((word) => word.text?.trim());
    // Неуверенные слова отбрасываем только в «шумных» строках (обрывки
    // картинок). В нормальной строке слово с переносом или на краю скана
    // часто распознано неуверенно, но оно есть — без него фраза рвётся.
    const lineConfidence = all.reduce((sum, word) => sum + (word.confidence ?? 100), 0) / (all.length || 1);
    const words = lineConfidence >= TRUSTED_LINE ? all : all.filter((word) => (word.confidence ?? 100) >= minConfidence);
    if (!words.length) continue;
    // Все слова строки — на одной базовой линии и одного кегля: так строка
    // текста остаётся строкой и для выделения, и для разбора на предложения.
    const top = Math.min(...words.map((word) => word.bbox.y0));
    const bottom = Math.max(...words.map((word) => word.bbox.y1));
    const height = Math.max(1, bottom - top);
    const baseline = top + height * ASCENT;

    words.forEach((word, i) => {
      const last = i === words.length - 1;
      // Ширина элемента — до начала следующего слова: пробел тоже выделяется.
      const right = last ? word.bbox.x1 : Math.max(word.bbox.x1, words[i + 1].bbox.x0);
      const [x0, y0] = toPdf(word.bbox.x0, baseline);
      const [x1, y1] = toPdf(right, baseline);
      const [xt, yt] = toPdf(word.bbox.x0, baseline - height);
      const width = Math.hypot(x1 - x0, y1 - y0);
      const fontSize = Math.hypot(xt - x0, yt - y0);
      const [dx, dy] = width > 0 ? [(x1 - x0) / width, (y1 - y0) / width] : [1, 0];
      items.push({
        str: last ? word.text.trim() : `${word.text.trim()} `,
        dir: 'ltr',
        width,
        height: fontSize,
        // «+ 0» превращает -0 в 0: матрица без поворота выглядит как обычно.
        transform: [dx * fontSize + 0, dy * fontSize + 0, -dy * fontSize + 0, dx * fontSize + 0, x0, y0],
        fontName: OCR_FONT,
        hasEOL: last,
      });
    });
  }
  return items;
}

/**
 * Язык распознавания документа по пробному тексту. Распознавать сразу
 * двумя языками хуже: tesseract подставляет латинские двойники кириллицы
 * («Ha TO» вместо «на то»). Поэтому первую страницу читаем двумя, а дальше —
 * тем, которого в тексте больше.
 * @returns {string[]|null} null — текста мало, решить нельзя
 */
export function pickLanguages(text) {
  const cyrillic = (text.match(/\p{Script=Cyrillic}/gu) || []).length;
  const latin = (text.match(/\p{Script=Latin}/gu) || []).length;
  const total = cyrillic + latin;
  if (total < 30) return null;
  if (cyrillic / total >= 0.6) return ['rus'];
  if (cyrillic / total <= 0.2) return ['eng'];
  return ['rus', 'eng'];
}
