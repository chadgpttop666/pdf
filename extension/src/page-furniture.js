// «Служебный» текст страницы: колонтитулы, номера страниц, сноски и знаки
// сносок в тексте. Глазом их легко пропустить, а голос читает на каждом
// переходе страницы — «Как читать с экрана, три», — и это сбивает.
//
// Колонтитул узнаём по повтору: одна и та же строка в верхней или нижней
// полосе многих страниц (цифры при сравнении не важны). Сноску — по мелкому
// шрифту внизу страницы, начиная со строки «1 …» или «* …». Знак сноски в
// тексте — мелкая цифра или звёздочка внутри обычной строки.

const BAND = 0.1; // верхние и нижние 10% высоты страницы
const FOOTNOTE_ZONE = 0.45; // сноски ищем только в нижней части
const PAGE_NUMBER =
  /^[\s\-–—·.]*(?:(?:стр|с|page|p)\.?\s*)?(?:\d{1,4}|[ivxlcdm]{1,7})(?:\s*(?:из|of|\/)\s*\d{1,4})?[\s\-–—·.]*$/i;
const FOOTNOTE_START = /^\s*(?:\d{1,3}|\*{1,3}|[†‡])(?:[\s.)]|(?=\p{L}))/u;
const FOOTNOTE_MARK = /^\s*(?:\d{1,3}|\*{1,3}|[†‡])\s*$/;

const fontSizeOf = (item) => Math.abs(item.transform?.[3]) || item.height || 10;

/** Цифры и римские номера не важны: «Глава 3 · 45» и «Глава 4 · 61» — один колонтитул. */
export function normalizeFurniture(text) {
  return text
    .toLowerCase()
    .replace(/\d+/g, '#')
    .replace(/\b[ivxlcdm]+\b/g, '#')
    .replace(/\s+/g, ' ')
    .trim();
}

function bandOf(line, box) {
  const height = box.top - box.bottom;
  if (line.y >= box.top - height * BAND) return 'top';
  if (line.y <= box.bottom + height * BAND) return 'bottom';
  return null;
}

/** Кандидаты в колонтитулы: по две крайние строки сверху и снизу, лежащие в полосах. */
function edgeLines(lines, box) {
  const byHeight = [...lines].sort((a, b) => b.y - a.y);
  const edges = new Set([...byHeight.slice(0, 2), ...byHeight.slice(-2)]);
  return [...edges].filter((line) => bandOf(line, box));
}

function median(values) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

/**
 * Профиль документа по выборке страниц: повторяющиеся строки в полосах и
 * размер основного шрифта (по длинным строкам — это тело текста).
 * @param {Array<{lines: Array, box: {top:number, bottom:number}}>} samples
 */
export function profileFurniture(samples) {
  const counts = new Map();
  const bodySizes = [];

  for (const { lines, box } of samples) {
    const seen = new Set();
    for (const line of edgeLines(lines, box)) {
      const normalized = normalizeFurniture(line.text);
      if (!normalized) continue;
      const key = `${bandOf(line, box)}:${normalized}`;
      if (seen.has(key)) continue;
      seen.add(key);
      counts.set(key, (counts.get(key) || 0) + 1);
    }
    for (const line of lines) {
      if (line.text.length >= 30) bodySizes.push(line.fontSize);
    }
  }

  // Колонтитулы часто чередуются (название книги / название главы), поэтому
  // хватает трети страниц, но не меньше двух.
  const threshold = Math.max(2, Math.ceil(samples.length * 0.3));
  const patterns = new Set([...counts].filter(([, count]) => count >= threshold).map(([key]) => key));
  return { patterns, bodySize: median(bodySizes) };
}

/**
 * Что выбросить из текста страницы.
 * @returns {{ dropLines: Set<number>, dropSpans: Set<number> }} номера строк и спанов
 */
export function classifyFurniture(lines, box, profile) {
  const dropLines = new Set();
  const dropSpans = new Set();
  const edges = new Set(edgeLines(lines, box));

  lines.forEach((line, index) => {
    if (!edges.has(line)) return;
    const key = `${bandOf(line, box)}:${normalizeFurniture(line.text)}`;
    if (PAGE_NUMBER.test(line.text) || profile.patterns.has(key)) dropLines.add(index);
  });
  // Самая верхняя или нижняя строка из одного номера — номер страницы, даже
  // если он дальше от края, чем полоса колонтитула (так бывает на сканах).
  const byHeight = [...lines.keys()].sort((a, b) => lines[b].y - lines[a].y);
  for (const index of [byHeight[0], byHeight.at(-1)]) {
    if (index !== undefined && PAGE_NUMBER.test(lines[index].text)) dropLines.add(index);
  }

  if (!profile.bodySize) return { dropLines, dropSpans };
  const isSmall = (size) => size < profile.bodySize * 0.85;
  const footnoteLimit = box.bottom + (box.top - box.bottom) * FOOTNOTE_ZONE;

  // Сноски: от первой мелкой строки «1 …» внизу страницы и дальше, пока шрифт мелкий.
  let inFootnotes = false;
  lines.forEach((line, index) => {
    if (dropLines.has(index)) return;
    if (!inFootnotes && line.y < footnoteLimit && isSmall(line.fontSize) && FOOTNOTE_START.test(line.text)) {
      inFootnotes = true;
    }
    if (!inFootnotes) return;
    if (isSmall(line.fontSize)) dropLines.add(index);
    else inFootnotes = false;
  });

  // Знаки сносок внутри обычных строк: мелкая цифра или звёздочка.
  lines.forEach((line, index) => {
    if (dropLines.has(index) || line.records.length < 2) return;
    for (const record of line.records) {
      const size = fontSizeOf(record.item);
      if (size < profile.bodySize * 0.75 && FOOTNOTE_MARK.test(record.item.str)) dropSpans.add(record.spanIndex);
    }
  });

  return { dropLines, dropSpans };
}
