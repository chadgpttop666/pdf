// Интернет-ссылки в тексте для голоса. Адрес вслух — это долгое «эйч-ти-ти-
// пи-эс, двоеточие, слэш, слэш…», а пользы от него на слух никакой. Голос
// ссылки пропускает (на странице и в окошке примечания они остаются):
// https://…, www.…, сайт.ru/…, адреса почты, DOI. Карта позиций сохраняется —
// подсветка слов не съезжает.

// Домены верхнего уровня, по которым «слово.слово» без https:// — адрес сайта.
// Только частые: «index.html» или «Node.js» адресами не считаются.
const TLD =
  'ru|su|com|org|net|info|io|edu|gov|int|biz|ua|by|kz|uz|uk|de|fr|eu|us|me|co|ai|app|dev|tv|fm|pro|online|site|xyz|wiki|jp|cn|it|es|pl|cz|nl|ch|at|ca|au|in|ly|gl|gg|cc|to|be|se|fi|no|ee|lv|lt|ge|am|az|md';

const PATTERNS = [
  // Со схемой; текстовый слой PDF иногда вставляет пробел после «//».
  /\b(?:https?|ftp):\/\/\s?\S+/giu,
  /(?<![\p{L}\p{N}@./-])www\.\S+/giu,
  // Почта.
  /(?<![\p{L}\p{N}._%+-])[\p{L}\p{N}._%+-]+@[\p{L}\p{N}-]+(?:\.[\p{L}\p{N}-]+)+/gu,
  // DOI: 10.1000/182
  /\bdoi\s*:?\s*10\.\d{4,9}\/\S+/giu,
  // Без схемы: yandex.ru, vk.com/club1, t.me/channel — латиница строчными.
  new RegExp(`(?<![\\p{L}\\p{N}@./_-])(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\\.)+(?:${TLD})(?::\\d+)?(?:/\\S*)?(?![\\p{L}\\p{N}-])`, 'gu'),
  // Кириллические: кремль.рф, сайт.рус.
  /(?<![\p{L}\p{N}@./_-])(?:[а-яё0-9](?:[а-яё0-9-]*[а-яё0-9])?\.)+(?:рф|рус)(?:\/\S*)?(?![\p{L}\p{N}-])/gu,
];

// Знаки после адреса — уже не адрес: «см. https://x.ru.» — точка остаётся фразе.
const TRAILING = /[.,;:!?…»"'”’)\]}>]$/u;
// Адрес, разорванный строкой («…/article/» + «n/slovo»): продолжение — латиница без пробелов.
const CONTINUES_AFTER = /[/\-_=&?#%~]$/u;
const CONTINUATION = /^ ([A-Za-z0-9._~%/?#=&+-]+)/u;
// Подпись перед адресом — без него она повисла бы: «URL:», «Режим доступа:», «E-mail:».
const LABEL = /(?:\bURL|\bUrl|Режим доступа|\b[Ee]-?mail|\bЭл\.\s?почта|\bэл\.\s?почта)\s*:?\s*$/u;
// Что остаётся пустым после удаления: «()», «[]», «<>», «« »».
const EMPTY = /\(\s*\)|\[\s*\]|<\s*>|«\s*»/gu;

/** Конец адреса без хвостовых знаков; «)» — только непарная. */
function trimEnd(text, start, end) {
  while (end > start && TRAILING.test(text[end - 1])) {
    if (text[end - 1] === ')') {
      const inside = text.slice(start, end);
      if ((inside.match(/\(/g) ?? []).length >= (inside.match(/\)/g) ?? []).length) break;
    }
    end -= 1;
  }
  return end;
}

/** Где в тексте адреса: [начало, конец) — пересекающиеся слиты. */
export function findLinks(text) {
  const found = [];
  for (const pattern of PATTERNS) {
    pattern.lastIndex = 0;
    for (const match of text.matchAll(pattern)) {
      const start = match.index;
      let end = trimEnd(text, start, start + match[0].length);
      // Адрес, разорванный переносом строки, — с продолжением.
      for (let next; CONTINUES_AFTER.test(text.slice(start, end)) && (next = CONTINUATION.exec(text.slice(end))); ) {
        end = trimEnd(text, start, end + next[0].length);
      }
      if (end > start) found.push([start, end]);
    }
  }
  found.sort((a, b) => a[0] - b[0] || b[1] - a[1]);
  const merged = [];
  for (const range of found) {
    const last = merged.at(-1);
    if (last && range[0] <= last[1]) last[1] = Math.max(last[1], range[1]);
    else merged.push([...range]);
  }
  return merged;
}

/** Убрать куски [начало, конец) из { text, map }; пробелы на стыке — один. */
function cut({ text, map }, ranges) {
  if (!ranges.length) return { text, map };
  const out = [];
  const outMap = [];
  let r = 0;
  let skipped = false; // перед этим знаком что-то вырезано
  for (let i = 0; i < text.length; i += 1) {
    while (r < ranges.length && ranges[r][1] <= i) r += 1;
    if (r < ranges.length && ranges[r][0] <= i) {
      skipped = true;
      continue;
    }
    const char = text[i];
    const space = /\s/.test(char);
    if (space && (!out.length || /\s/.test(out.at(-1)))) continue;
    if (!space && skipped && /[.,;:!?…)\]»"”]/u.test(char)) {
      // Пробел перед знаком, оставшийся от адреса: «сайт , где» → «сайт, где».
      if (/\s/.test(out.at(-1) ?? '')) {
        out.pop();
        outMap.pop();
      }
      // Знаки сошлись на месте адреса: «см. .» → «см.», «Подробнее: .» → «Подробнее.»
      const last = out.at(-1) ?? '';
      if (/[.!?…]/u.test(char) && /[,;:]/u.test(last)) {
        out[out.length - 1] = char;
        outMap[outMap.length - 1] = map[i];
        skipped = false;
        continue;
      }
      if (/[.,;:!?…]/u.test(char) && (/[.!?…,;:]/u.test(last) || !out.length)) continue;
    }
    if (!space) skipped = false;
    out.push(char);
    outMap.push(map[i]);
  }
  while (out.length && /\s/.test(out.at(-1))) {
    out.pop();
    outMap.pop();
  }
  return { text: out.join(''), map: outMap };
}

/**
 * Текст для голоса без интернет-ссылок.
 * @param input строка или { text, map } (cleanForSpeech: map — в исходные позиции)
 * @returns {{ text: string, map: number[], removed: number }} map — в позиции входа
 *   (для { text, map } — в те же исходные, что и его map)
 */
export function stripLinks(input) {
  const source = typeof input === 'string' ? { text: input, map: null } : input;
  const map = source.map ?? Array.from(source.text, (_, i) => i);
  const links = findLinks(source.text);
  if (!links.length) return { text: source.text, map, removed: 0 };
  const ranges = links.map(([start, end]) => {
    const label = LABEL.exec(source.text.slice(0, start));
    return [label ? label.index : start, end];
  });
  let result = cut({ text: source.text, map }, ranges);
  // Скобки, в которых был только адрес, и повисшее двоеточие: «Подробнее: .»
  const leftovers = [...result.text.matchAll(EMPTY)].map((match) => [match.index, match.index + match[0].length]);
  for (const match of result.text.matchAll(/\s*:(?=\s*[—–])|\s*:\s*(?=[.!?…;]|$)/gu)) leftovers.push([match.index, match.index + match[0].length]);
  leftovers.sort((a, b) => a[0] - b[0]);
  result = cut(result, leftovers);
  // Осталось одни знаки — фразы для голоса нет.
  if (!/[\p{L}\p{N}]/u.test(result.text)) result = { text: '', map: [] };
  return { ...result, removed: links.length };
}
