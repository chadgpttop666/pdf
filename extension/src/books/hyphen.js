// Переносы для вёрстки книги — по школьным правилам русского языка:
// - не оставлять и не переносить одну букву;
// - «ь», «ъ», «й» — с предыдущей буквой;
// - в каждой части — гласная;
// - переносим перед согласной с гласной («ма-ма»), между согласными
//   («кош-ка», «сол-нце»), после «ь», «ъ», «й» («боль-шой»), между гласными.
// Читалка склеивает такие слова обратно (text-index.js), поэтому поиск и
// озвучка видят слово целиком.

const VOWELS = 'аеёиоуыэюя';
const SIGNS = 'ьъй';
const isVowel = (char) => VOWELS.includes(char);
const isSign = (char) => SIGNS.includes(char);
const isLetter = (char) => /[а-яё]/.test(char);

/**
 * Места, где слово можно перенести: индексы, перед которыми ставится разрыв.
 * Только для русских слов из строчных (первая может быть заглавной).
 */
export function hyphenPoints(word) {
  const lower = word.toLowerCase();
  if (lower.length < 4 || ![...lower].every(isLetter)) return [];
  // Слово целиком заглавными (заголовок, аббревиатура) — не переносим.
  if (word.length > 1 && word === word.toUpperCase()) return [];
  const points = [];
  for (let i = 2; i <= lower.length - 2; i += 1) {
    const before = lower[i - 1];
    const after = lower[i];
    if (isSign(after)) continue;
    const left = lower.slice(0, i);
    const right = lower.slice(i);
    if (![...left].some(isVowel) || ![...right].some(isVowel)) continue;
    const next = lower[i + 1];
    if (isVowel(before) && !isVowel(after) && isVowel(next)) points.push(i); // ма-ма
    else if (!isVowel(before) && !isSign(before) && !isVowel(after) && isVowel(lower[i - 2] ?? '')) points.push(i); // кош-ка
    else if (isSign(before) && !isVowel(after)) points.push(i); // боль-шой
    else if (isVowel(before) && isVowel(after)) points.push(i); // по-эт
  }
  return points;
}

/**
 * Куда перенести слово с пунктуацией вокруг: «текста,» → ядро «текста».
 * @returns {number[]} индексы в исходной строке
 */
export function hyphenPointsOf(text) {
  const match = text.match(/^([^а-яёА-ЯЁ]*)([а-яёА-ЯЁ]+)([^а-яёА-ЯЁ]*)$/u);
  if (!match) {
    // Составное слово: «одну-две» переносится по своему дефису.
    const dash = text.indexOf('-');
    return dash > 1 && dash < text.length - 2 ? [dash + 1] : [];
  }
  const [, lead, core] = match;
  return hyphenPoints(core).map((index) => index + lead.length);
}
