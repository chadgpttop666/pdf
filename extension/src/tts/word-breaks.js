// Перенос без знака: в некоторых PDF дефис переноса потерян, и строка
// обрывается посреди слова — «сооб␤щает». Голос прочёл бы два обрывка.
//
// Решаем по словарю ударений (3,2 млн словоформ):
// - склейка — слово, а хотя бы один обрывок — нет («сооб␤щает»,
//   «направ␤ленной»): склеиваем всегда;
// - и склейка, и оба обрывка — слова («на␤чало», «по␤том»): в обычном PDF
//   это настоящий конец строки, а в PDF, потерявшем дефисы, — скорее
//   разорванное слово. Потерял ли документ дефисы, видно по однозначным
//   склейкам: в обычном тексте их почти не бывает;
// - склейки нет в словаре: два слова.

// Короткие слова, которые в словаре ударений могут не числиться (служебные
// без ударения), — но это настоящие слова.
const FUNCTION_WORDS = new Set(
  (
    'а б бы в во вот да для до же за и из изо к ко ли на над надо не ни но о об обо от ото по под подо при про с со то у уж ' +
    'что как так там тут где все всё это этот эта эти тот та те том тем той его её ее их им ими ей ему он она оно они ' +
    'мы вы ты я мне меня нас нам вас вам себя себе свой своя своё свои чем чей кто кого кому ещё еще уже лишь если или ' +
    'без через между перед около после ради сквозь среди возле мимо вне'
  ).split(' ')
);

const CYRILLIC = /^[а-яё]+$/iu;
// Частица после служебного слова пишется отдельно: «тот␤же» — не «тотже»,
// хоть словарь его и знает. А «измени␤ли» — разорванное «изменили».
const PARTICLES = new Set(['же', 'ж', 'ли', 'ль', 'бы', 'б']);
// Документ потерял дефисы: однозначных склеек столько — и такая их доля.
const LOSSY_MIN = 3;
const LOSSY_SHARE = 0.1;

/**
 * Разрывы строк посреди возможного слова: слева и справа — кириллица.
 * @param text текст (страницы или фразы)
 * @param offsets позиции пробелов-разрывов в этом тексте
 * @returns {{ at: number, left: string, right: string }[]}
 */
export function breakWords(text, offsets) {
  const candidates = [];
  for (const at of offsets ?? []) {
    if (text[at] !== ' ') continue;
    const left = text.slice(0, at).match(/\p{L}+$/u)?.[0] ?? '';
    const right = text.slice(at + 1).match(/^\p{L}+/u)?.[0] ?? '';
    if (CYRILLIC.test(left) && CYRILLIC.test(right)) candidates.push({ at, left, right });
  }
  return candidates;
}

/** Слова, которые нужно проверить по словарю (строчными). */
export function wordsToCheck(candidates) {
  const words = new Set();
  for (const { left, right } of candidates) {
    for (const word of [left, right, left + right]) {
      const key = word.toLowerCase();
      if (!FUNCTION_WORDS.has(key)) words.add(key);
    }
  }
  return [...words];
}

/**
 * 'join' — склеить наверняка; 'maybe' — и склейка, и обрывки — слова;
 * 'no' — склейки нет в словаре.
 */
export function classifyBreak({ left, right }, known) {
  const isWord = (word) => {
    const key = word.toLowerCase();
    return FUNCTION_WORDS.has(key) || known.has(key);
  };
  if ((PARTICLES.has(right.toLowerCase()) && FUNCTION_WORDS.has(left.toLowerCase())) || !isWord(left + right)) return 'no';
  return isWord(left) && isWord(right) ? 'maybe' : 'join';
}

/** Похоже ли, что документ потерял знаки переноса. */
export function looksLossy({ sure, seen }) {
  return sure >= LOSSY_MIN && sure >= seen * LOSSY_SHARE;
}

/** Убрать пробелы в этих местах — и из текста, и из карты символов. */
export function joinAt(cleaned, positions) {
  if (!positions.length) return cleaned;
  const chars = [...cleaned.text];
  const map = [...cleaned.map];
  for (const at of [...positions].sort((a, b) => b - a)) {
    chars.splice(at, 1);
    map.splice(at, 1);
  }
  return { text: chars.join(''), map };
}

/**
 * Склейка для одного документа: словарь спрашиваем только о новых словах,
 * каждую страницу разбираем один раз.
 * @param knownWords async (words) => Set | null (null — словарь не готов)
 */
export function createWordJoiner(knownWords) {
  const memo = new Map(); // слово → есть ли в словаре
  const pages = new WeakMap(); // страница → Set позиций в её тексте, где склеить
  const stats = { sure: 0, seen: 0 };

  async function lookup(words) {
    const missing = words.filter((word) => !memo.has(word));
    if (missing.length) {
      const found = await knownWords(missing);
      if (!found) return null;
      for (const word of missing) memo.set(word, found.has(word));
    }
    return new Set(words.filter((word) => memo.get(word)));
  }

  /** Где на странице склеить. null — словарь ещё не готов. */
  async function pageJoins(page) {
    if (pages.has(page)) return pages.get(page);
    const candidates = breakWords(page.text, page.softBreaks);
    if (!candidates.length) {
      pages.set(page, new Set());
      return pages.get(page);
    }
    const known = await lookup(wordsToCheck(candidates));
    if (!known) return null;
    if (pages.has(page)) return pages.get(page); // пока ждали словарь, разобрали
    const classes = candidates.map((candidate) => classifyBreak(candidate, known));
    stats.sure += classes.filter((kind) => kind === 'join').length;
    stats.seen += candidates.length;
    const lossy = looksLossy(stats);
    const joins = new Set(candidates.filter((_, i) => classes[i] === 'join' || (lossy && classes[i] === 'maybe')).map(({ at }) => at));
    pages.set(page, joins);
    return joins;
  }

  return {
    pageJoins,
    /**
     * Склеить разорванные слова в очищенном тексте предложения.
     * @param cleaned { text, map } из cleanForSpeech — map указывает в текст предложения
     */
    async join(page, sentence, cleaned) {
      const joins = await pageJoins(page);
      if (!joins?.size) return cleaned;
      const positions = [];
      for (let i = 0; i < cleaned.text.length; i += 1) {
        if (cleaned.text[i] === ' ' && joins.has(sentence.start + cleaned.map[i])) positions.push(i);
      }
      return joinAt(cleaned, positions);
    },
    /** Склеить ли конец одной страницы с началом следующей. */
    async joins(left, right) {
      if (!CYRILLIC.test(left) || !CYRILLIC.test(right)) return false;
      const known = await lookup(wordsToCheck([{ left, right }]));
      if (!known) return false;
      const kind = classifyBreak({ left, right }, known);
      return kind === 'join' || (kind === 'maybe' && looksLossy(stats));
    },
    get lossy() {
      return looksLossy(stats);
    },
  };
}
