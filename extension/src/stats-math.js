// Расчёты статистики чтения без DOM и базы — чтобы их можно было проверить
// юнит-тестами.

/** Простой дольше этого не считается чтением: человек отошёл. */
export const IDLE_LIMIT_MS = 2 * 60 * 1000;
/** Быстрее этого не читают — это пролистывание, его в прочитанное не пишем. */
export const MAX_READING_SPEED = 4000; // знаков в минуту
/** Скачок дальше этого числа страниц — переход по оглавлению, не чтение. */
export const MAX_PAGE_JUMP = 3;
/** Пока своих данных мало, считаем по средней скорости чтения про себя. */
export const DEFAULT_READING_SPEED = 1300;
/** Голос со скоростью 1× произносит примерно столько знаков в минуту. ⚠️ грубо */
export const DEFAULT_LISTENING_SPEED = 900;
/** Стандартная машинописная страница — 1800 знаков с пробелами. */
export const STANDARD_PAGE = 1800;
/** Средняя длина русского слова с пробелом — для перевода знаков в слова. */
export const CHARS_PER_WORD = 7;

const MINUTE = 60 * 1000;

/** Ключ дня в местном времени: «2026-10-28». */
export function dayKey(date = new Date()) {
  const pad = (value) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** Ключи последних n дней, от старого к сегодняшнему. */
export function lastDays(n, today = new Date()) {
  const days = [];
  for (let back = n - 1; back >= 0; back -= 1) {
    const date = new Date(today.getFullYear(), today.getMonth(), today.getDate() - back);
    days.push(dayKey(date));
  }
  return days;
}

export function emptyDay(day) {
  return { day, readMs: 0, readChars: 0, listenMs: 0, listenChars: 0, noTextMs: 0, docs: {} };
}

/** Место чтения как {страница, доля страницы}; доля обрезается до 0…1. */
export function normalizePosition(position) {
  if (!position?.pageNumber) return null;
  return { pageNumber: position.pageNumber, offsetRatio: Math.min(1, Math.max(0, position.offsetRatio || 0)) };
}

/**
 * Сколько знаков между двумя местами при движении вперёд.
 * @param charsOf async (страница) → число знаков на ней
 * @returns {Promise<number|null>} 0 — назад или на месте, null — скачок
 */
export async function charsBetween(from, to, charsOf) {
  const a = normalizePosition(from);
  const b = normalizePosition(to);
  if (!a || !b) return 0;
  if (b.pageNumber < a.pageNumber || (b.pageNumber === a.pageNumber && b.offsetRatio <= a.offsetRatio)) return 0;
  if (b.pageNumber - a.pageNumber > MAX_PAGE_JUMP) return null;
  if (a.pageNumber === b.pageNumber) return (b.offsetRatio - a.offsetRatio) * (await charsOf(a.pageNumber));

  let total = (1 - a.offsetRatio) * (await charsOf(a.pageNumber));
  for (let page = a.pageNumber + 1; page < b.pageNumber; page += 1) total += await charsOf(page);
  return total + b.offsetRatio * (await charsOf(b.pageNumber));
}

/**
 * Похоже ли продвижение на чтение: за накопленное активное время столько
 * текста прочитать можно. Пролистывание и прыжки отбрасываются.
 */
export function plausibleReading(chars, activeMs, maxSpeed = MAX_READING_SPEED) {
  return chars > 0 && activeMs > 0 && chars <= (activeMs / MINUTE) * maxSpeed;
}

/** Знаков в минуту по сумме дней; null — данных пока мало. */
export function speedOf(days, { msKey, charsKey, minMs = 3 * MINUTE, minChars = 1000 }) {
  let ms = 0;
  let chars = 0;
  for (const day of days) {
    ms += day?.[msKey] || 0;
    chars += day?.[charsKey] || 0;
  }
  if (ms < minMs || chars < minChars) return null;
  return chars / (ms / MINUTE);
}

/** Сколько дней подряд, включая сегодня (или вчера, если сегодня ещё не читали). */
export function streakDays(byDay, today = new Date(), minMs = MINUTE) {
  const active = (key) => {
    const day = byDay.get(key);
    return Boolean(day) && day.readMs + day.listenMs >= minMs;
  };
  let cursor = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  if (!active(dayKey(cursor))) cursor.setDate(cursor.getDate() - 1);
  let count = 0;
  while (active(dayKey(cursor))) {
    count += 1;
    cursor.setDate(cursor.getDate() - 1);
  }
  return count;
}

/**
 * Сколько знаков осталось до конца страницы endPage: остаток текущей
 * страницы точно, дальше — по средней странице документа.
 */
export function remainingChars({ pageNumber, offsetRatio, currentChars, endPage, averageChars }) {
  if (!pageNumber || endPage < pageNumber) return 0;
  const ratio = Math.min(1, Math.max(0, offsetRatio || 0));
  return (1 - ratio) * currentChars + (endPage - pageNumber) * averageChars;
}

/** «меньше минуты», «12 мин», «3 ч 40 мин», «2 ч». */
export function formatDuration(ms) {
  const minutes = Math.round(ms / MINUTE);
  if (minutes < 1) return 'меньше минуты';
  if (minutes < 60) return `${minutes} мин`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest ? `${hours} ч ${rest} мин` : `${hours} ч`;
}

/** Короткая форма для тулбара: «12 мин», «3 ч 40 мин», «12 ч». */
export function formatEta(ms) {
  const minutes = Math.max(1, Math.round(ms / MINUTE));
  if (minutes < 60) return `${minutes} мин`;
  const hours = Math.floor(minutes / 60);
  if (hours >= 10) return `${Math.round(minutes / 60)} ч`;
  const rest = minutes % 60;
  return rest ? `${hours} ч ${rest} мин` : `${hours} ч`;
}

/** 1284 → «1 284», 25300 → «25,3 тыс.» */
export function formatCount(value) {
  const rounded = Math.round(value);
  if (rounded >= 10000) {
    return `${(rounded / 1000).toLocaleString('ru-RU', { maximumFractionDigits: 1 })} тыс.`;
  }
  return rounded.toLocaleString('ru-RU');
}

const DAY_FIELDS = ['readMs', 'readChars', 'listenMs', 'listenChars', 'noTextMs'];

/** Сложить две записи одного дня — так вкладки дописывают свои приращения. */
export function mergeDays(base, delta) {
  const merged = { ...emptyDay(base.day), ...base, docs: { ...base.docs } };
  for (const key of DAY_FIELDS) merged[key] = (base[key] || 0) + (delta[key] || 0);
  for (const [id, entry] of Object.entries(delta.docs || {})) {
    const target = merged.docs[id] || { ms: 0, chars: 0 };
    merged.docs[id] = {
      ms: (target.ms || 0) + (entry.ms || 0),
      chars: (target.chars || 0) + (entry.chars || 0),
      title: entry.title || target.title,
    };
  }
  return merged;
}

/** Есть ли в записи что сохранять. */
export function hasActivity(day) {
  return DAY_FIELDS.some((key) => (day?.[key] || 0) > 0);
}
