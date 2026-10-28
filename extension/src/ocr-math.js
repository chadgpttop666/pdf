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
    const lineHeight = Math.max(1, ...(line.words || []).map((word) => word.bbox.y1 - word.bbox.y0));
    // Широкий пробел в строке «по ширине» tesseract порой читает как «—».
    // Настоящее тире почти во всю высоту строки, ложное — узкая чёрточка.
    const isGapDash = (word) => /^[—–-]$/.test(word.text.trim()) && word.bbox.x1 - word.bbox.x0 < lineHeight * 0.6;
    const all = fixHomoglyphs((line.words || []).filter((word) => word.text?.trim() && !isGapDash(word)));
    // Неуверенные слова отбрасываем только в «шумных» строках (обрывки
    // картинок). В нормальной строке слово с переносом или на краю скана
    // часто распознано неуверенно, но оно есть — без него фраза рвётся.
    const lineConfidence = all.reduce((sum, word) => sum + (word.confidence ?? 100), 0) / (all.length || 1);
    // Неуверенный «знак» без букв и цифр — это широкий пробел выключки или
    // пятно, его не оставляем и в хорошей строке.
    const confident = (word) => (word.confidence ?? 100) >= minConfidence;
    const words = lineConfidence >= TRUSTED_LINE ? all.filter((word) => confident(word) || /[\p{L}\p{N}]/u.test(word.text)) : all.filter(confident);
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
 * Язык распознавания документа по пробному тексту. Русские книги читаем
 * сразу двумя языками: иначе пропадают английские названия («Ethics»,
 * «Journal of Political Philosophy»). Латинские двойники русских слов,
 * которые при этом подставляет tesseract («Ha TO» вместо «на то»), чинит
 * fixHomoglyphs. Только английский — для английских документов.
 * @returns {string[]|null} null — текста мало, решить нельзя
 */
export function pickLanguages(text) {
  const cyrillic = (text.match(/\p{Script=Cyrillic}/gu) || []).length;
  const latin = (text.match(/\p{Script=Latin}/gu) || []).length;
  const total = cyrillic + latin;
  if (total < 30) return null;
  return cyrillic / total <= 0.2 ? ['eng'] : ['rus', 'eng'];
}

// Латинские буквы, неотличимые на письме от русских.
const HOMOGLYPHS = {
  A: 'А', B: 'В', C: 'С', E: 'Е', H: 'Н', K: 'К', M: 'М', O: 'О', P: 'Р', T: 'Т', X: 'Х', Y: 'У',
  a: 'а', c: 'с', e: 'е', o: 'о', p: 'р', x: 'х', y: 'у',
};
const LOOKALIKE_WORD = new RegExp(`^[^\\p{L}]*[${Object.keys(HOMOGLYPHS).join('')}]+[^\\p{L}]*$`, 'u');
const hasCyrillic = (text) => /\p{Script=Cyrillic}/u.test(text);
// Настоящее английское слово: есть буква, которой нет в кириллице.
const isEnglishWord = (text) => /\p{Script=Latin}/u.test(text) && !LOOKALIKE_WORD.test(text) && !hasCyrillic(text);
const toCyrillic = (text) => text.replace(/[A-Za-z]/g, (char) => HOMOGLYPHS[char] ?? char);

/**
 * Слово из одних «двойников» среди русских слов — это русское слово:
 * «силы Ha TO, чтобы» → «силы на то, чтобы». Рядом с английскими словами
 * («Great Ape Project») не трогаем. Смешанное «сеrдце» — тоже в кириллицу.
 */
export function fixHomoglyphs(words) {
  return words.map((word, i) => {
    const text = word.text;
    // «30Н» вместо «зон»: 3 и 0 вперемешку с русскими буквами — это «з» и «о».
    // С дефисом («30-х») и без русских букв («300») — настоящие числа.
    const core = text.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '');
    if (/^[03А-Яа-яЁё]+$/.test(core) && /[03]/.test(core) && /[А-Яа-яЁё]/.test(core)) {
      let fixed = text.replace(/[03]/g, (digit) => (digit === '3' ? 'З' : 'О'));
      const previous = words[i - 1]?.text || '';
      if (previous && !/[.!?…]$/.test(previous) && fixed.replace(/[^\p{L}]/gu, '').length <= 4) fixed = fixed.toLowerCase();
      return { ...word, text: fixed };
    }
    if (!/[A-Za-z]/.test(text)) return word;
    const mixed = hasCyrillic(text) && !/[^А-Яа-яЁё\p{P}\p{N}A-Za-z]/u.test(text) && LOOKALIKE_WORD.test(text.replace(/\p{Script=Cyrillic}/gu, ''));
    if (mixed) return { ...word, text: toCyrillic(text) };
    if (!LOOKALIKE_WORD.test(text)) return word;
    const neighbours = [words[i - 1], words[i + 1]].filter(Boolean).map((other) => other.text);
    if (!neighbours.some(hasCyrillic) || neighbours.some(isEnglishWord)) return word;
    let fixed = toCyrillic(text);
    // «TO» посреди строчных слов — это «то»: заглавные здесь — ошибка распознавания.
    const previous = words[i - 1]?.text || '';
    const midSentence = previous && !/[.!?…]$/.test(previous);
    if (midSentence && /\p{Lu}/u.test(fixed) && fixed.length <= 3) fixed = fixed.toLowerCase();
    return { ...word, text: fixed };
  });
}
