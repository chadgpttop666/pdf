// Ударения для TeraTTS — перенос логики RUAccent (MIT, Денис Петров) в
// браузер. Модель TeraTTS обучена на тексте, размеченном RUAccent: «+»
// перед ударной гласной («з+амок»), «ё» на месте. Без разметки она ставит
// ударения хуже, поэтому размечаем так же:
//   1. «ё» — по словарю (ещё, её) и нейросетью для двояких слов (все/всё);
//   2. омографы (замок, мука) — нейросетью по контексту фразы;
//   3. остальные слова — по словарю на 3,2 млн словоформ; незнакомые —
//      маленькой нейросетью по буквам.
// Служебные слова (предлоги, союзы, частицы) ударения не получают: в
// RUAccent это решает отдельная модель на 111 МБ, у нас — список, сверенный
// с её разметкой на книжном тексте. Слово, написанное через «ё», тоже без
// «+» — ударение и так ясно (а вот «ё», поставленная нами, «+» получает).
//
// Здесь только логика, без ONNX: нейросети приходят снаружи функциями —
// так модуль проверяется юнит-тестами, а в браузере работает в воркере.

/** Слова, которые RUAccent оставляет без ударения. */
export const UNSTRESSED = new Set([
  'а', 'бы', 'б', 'в', 'во', 'где', 'до', 'есть', 'ж', 'же', 'и', 'из', 'к', 'как', 'ко', 'ли', 'мы', 'на', 'над', 'не',
  'ни', 'но', 'о', 'об', 'обо', 'от', 'по', 'под', 'при', 'про', 'с', 'со', 'у', 'что', 'чтобы',
]);
// Частицы через дефис: «где-то», «кто-нибудь».
const HYPHEN_PARTICLES = new Set(['то', 'либо', 'нибудь', 'ка', 'таки']);

const VOWELS = /[аеёиоуыэюя]/giu;
// Символы, которые RUAccent оставляет во фразе для нейросетей; остальное
// (многоточие «…», кавычки-лапки, короткое тире) он вычищает. «+» оставляем:
// слово с ручным ударением должно узнаваться и остаться как есть.
const NOT_KEPT = /[^a-zA-Z0-9\sа-яА-ЯёЁ—.,!?:;'(){}[\]«»„“”+-]/g;
// Предложение со знаком конца и закрывающей кавычкой, как делит RUAccent.
const SENTENCE = /[^.!?…]+[.!?…]*["»“]*/g;
const TOKEN = /[\p{L}\p{N}_]+(?:\+[\p{L}\p{N}_]+)*|[^\p{L}\p{N}_\s]+/gu;
const WORD = /^[\p{L}\p{N}_+]+$/u;

const vowelCount = (word) => (word.match(VOWELS) || []).length;

/** Регистр исходного слова — на слово из словаря (там всё строчное). */
export function fixCapital(source, target) {
  const plain = target.replace(/\+/g, '');
  if (plain.length !== source.length) return target;
  let out = '';
  let i = 0;
  for (const char of target) {
    if (char === '+') {
      out += char;
      continue;
    }
    out += source[i] === source[i].toLowerCase() ? char.toLowerCase() : char.toUpperCase();
    i += 1;
  }
  return out;
}

/** Слово со знаком «+» перед буквой номер position (как в словаре). */
export function markStress(word, position) {
  if (position < 0 || position >= word.length) return word;
  return `${word.slice(0, position)}+${word.slice(position)}`;
}

/** Слова и знаки фразы — как их видит RUAccent. */
export function tokens(text) {
  return [...text.matchAll(TOKEN)].map((match) => ({ text: match[0], start: match.index, word: WORD.test(match[0]) }));
}

/**
 * Границы «слов» BERT-токенизатора: пробелы разделяют, каждый знак
 * препинания — отдельное слово. По ним раскладываются ответы нейросети «ё».
 * @returns {{start: number, end: number}[]}
 */
export function bertWordSpans(text) {
  const spans = [];
  let start = -1;
  // Как в BERT: вся пунктуация Юникода плюс ASCII-символы вроде «+», «$», «<».
  const isPunctuation = (char) => /\p{P}/u.test(char) || /[!-/:-@[-`{-~]/.test(char);
  for (let i = 0; i <= text.length; i += 1) {
    const char = text[i];
    const boundary = i === text.length || /\s/u.test(char) || isPunctuation(char);
    if (boundary && start >= 0) {
      spans.push({ start, end: i });
      start = -1;
    }
    if (i < text.length && isPunctuation(char)) spans.push({ start: i, end: i + 1 });
    else if (!boundary && start < 0) start = i;
  }
  return spans;
}

/**
 * Куски WordPiece («неу», «##жели») → номера слов: продолжение слова
 * начинается с «##».
 * @returns {number[]} для каждого куска — номер слова
 */
export function groupWordPieces(pieces) {
  const groups = [];
  let word = -1;
  for (const piece of pieces) {
    if (!piece.startsWith('##') || word < 0) word += 1;
    groups.push(word);
  }
  return groups;
}

/**
 * Контекст омографа для нейросети — строка ровно того вида, на котором её
 * учили: слова через пробел, омограф в <w>…</w>, пробелы перед знаками убраны.
 */
export function omographContext(words, index) {
  const parts = words.map((word, i) => (i === index ? ` <w>${word}</w> ` : word));
  return parts.join(' ').replace(/\s+(?=[,.?!:;…])/g, '');
}

/**
 * @param dictionary.stress { accent(word): string|null } — словарь ударений
 * @param dictionary.yoWords Map: слово без «ё» → с «ё» (однозначные)
 * @param dictionary.yoHomographs Map: слово без «ё» → с «ё» (двоякие: все/всё)
 * @param dictionary.omographs Map: слово → варианты с «+»
 * @param models.yoLabels(text) → Promise<string[]> метка 'YO' и др. для каждого слова из bertWordSpans(text)
 * @param models.chooseOmograph(context, variants) → Promise<string> выбранный вариант
 * @param models.accentWord(word) → Promise<string|null> незнакомое слово с «+»
 */
export function createAccentuator({ stress, yoWords, yoHomographs, omographs }, models = {}) {
  async function yoFix(sentence, items) {
    const words = items.filter((item) => item.word);
    for (const item of words) {
      const known = yoWords.get(item.text.toLowerCase());
      if (known) item.text = fixCapital(item.text, known);
    }
    const doubtful = words.filter((item) => yoHomographs.has(item.text.toLowerCase()));
    if (!doubtful.length || !models.yoLabels) return;
    const lower = sentence.toLowerCase();
    const labels = await models.yoLabels(lower);
    const spans = bertWordSpans(lower);
    const labelAt = new Map(spans.map((span, i) => [span.start, labels[i]]));
    for (const item of doubtful) {
      if (labelAt.get(item.start) === 'YO') item.text = fixCapital(item.text, yoHomographs.get(item.text.toLowerCase()));
    }
  }

  async function omographFix(items) {
    if (!models.chooseOmograph) return;
    const texts = items.map((item) => item.text);
    for (const [i, item] of items.entries()) {
      if (!item.word || item.text.includes('+')) continue;
      const variants = omographs.get(item.text.toLowerCase());
      if (!variants?.length) continue;
      const chosen = variants.length === 1 ? variants[0] : await models.chooseOmograph(omographContext(texts, i), variants);
      item.text = fixCapital(item.text, chosen);
      texts[i] = chosen;
    }
  }

  async function accentFix(items, writtenYo) {
    for (const [i, item] of items.entries()) {
      if (!item.word || item.text.includes('+') || writtenYo.has(i) || UNSTRESSED.has(item.text.toLowerCase())) continue;
      if (items[i - 1]?.text === '-' && HYPHEN_PARTICLES.has(item.text.toLowerCase())) continue;
      const lower = item.text.toLowerCase();
      const known = stress.accent(lower);
      if (known) item.text = fixCapital(item.text, known);
      else if (models.accentWord && vowelCount(lower) > 1 && /^\p{Script=Cyrillic}+$/u.test(lower)) {
        const guessed = await models.accentWord(lower);
        if (guessed) item.text = fixCapital(item.text, guessed);
      }
    }
  }

  async function processSentence(text) {
    // Для нейросетей — фраза в том виде, как её чистит RUAccent; слова
    // в ней те же, поэтому правки переносятся обратно по порядку слов.
    const clean = text.replace(NOT_KEPT, '');
    const items = tokens(clean);
    const original = tokens(text).filter((item) => item.word);
    const cleanWords = items.filter((item) => item.word);
    const aligned = original.length === cleanWords.length && original.every((item, i) => item.text === cleanWords[i].text);
    if (!aligned) return text; // экзотические символы внутри слов — оставим как есть

    const writtenYo = new Set(items.flatMap((item, i) => (/[ёЁ]/.test(item.text) ? [i] : [])));
    await yoFix(clean, items);
    await omographFix(items);
    await accentFix(items, writtenYo);

    let out = '';
    let cursor = 0;
    cleanWords.forEach((item, i) => {
      out += text.slice(cursor, original[i].start) + item.text;
      cursor = original[i].start + original[i].text.length;
    });
    return out + text.slice(cursor);
  }

  return {
    /**
     * Разметить русский текст: «ё» и «+» перед ударными гласными. Всё
     * остальное в тексте остаётся как было. Слова, где «+» уже стоит, не
     * трогаем — ручное ударение главнее. Контекст для нейросетей — одно
     * предложение, как в RUAccent.
     */
    async process(text) {
      let out = '';
      let cursor = 0;
      for (const match of text.matchAll(SENTENCE)) {
        out += text.slice(cursor, match.index) + (await processSentence(match[0]));
        cursor = match.index + match[0].length;
      }
      return out + text.slice(cursor);
    },
  };
}
