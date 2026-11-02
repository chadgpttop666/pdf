// Числа и сокращения — словами, для нейроголоса. Фонемизатор Piper (espeak)
// читает «в 1928 году» как «в одна тысяча девятьсот двадцать восемь году»,
// а «т. е.» — по буквам. Здесь годы, века, номера глав и числа с
// наращением («5-й») становятся порядковыми числительными в нужном падеже,
// а сокращения раскрываются с согласованием («592 страницы»).
//
// Результат — произносимый текст и список замен: по нему подсветка слова
// знает, сколько времени занимает каждое исходное слово.

const UNITS = ['', 'один', 'два', 'три', 'четыре', 'пять', 'шесть', 'семь', 'восемь', 'девять'];
const UNITS_F = ['', 'одна', 'две', 'три', 'четыре', 'пять', 'шесть', 'семь', 'восемь', 'девять'];
const TEENS = [
  'десять', 'одиннадцать', 'двенадцать', 'тринадцать', 'четырнадцать',
  'пятнадцать', 'шестнадцать', 'семнадцать', 'восемнадцать', 'девятнадцать',
];
const TENS = ['', '', 'двадцать', 'тридцать', 'сорок', 'пятьдесят', 'шестьдесят', 'семьдесят', 'восемьдесят', 'девяносто'];
const HUNDREDS = ['', 'сто', 'двести', 'триста', 'четыреста', 'пятьсот', 'шестьсот', 'семьсот', 'восемьсот', 'девятьсот'];

// Основы порядковых: «перв-ый», «втор-ой», «восьм-ой»…
const UNIT_STEMS = ['', 'перв', 'втор', 'трет', 'четвёрт', 'пят', 'шест', 'седьм', 'восьм', 'девят'];
const TEEN_STEMS = [
  'десят', 'одиннадцат', 'двенадцат', 'тринадцат', 'четырнадцат',
  'пятнадцат', 'шестнадцат', 'семнадцат', 'восемнадцат', 'девятнадцат',
];
const TEN_STEMS = ['', '', 'двадцат', 'тридцат', 'сороков', 'пятидесят', 'шестидесят', 'семидесят', 'восьмидесят', 'девяност'];
const HUNDRED_STEMS = ['', 'сот', 'двухсот', 'трёхсот', 'четырёхсот', 'пятисот', 'шестисот', 'семисот', 'восьмисот', 'девятисот'];
// «двух-тысячный», «пяти-тысячный» — первая часть сложного слова.
const COMBINING = {
  2: 'двух', 3: 'трёх', 4: 'четырёх', 5: 'пяти', 6: 'шести', 7: 'семи', 8: 'восьми', 9: 'девяти',
  10: 'десяти', 11: 'одиннадцати', 12: 'двенадцати', 15: 'пятнадцати', 20: 'двадцати', 30: 'тридцати',
  40: 'сорока', 50: 'пятидесяти', 100: 'сто',
};
// У этих основ ударное окончание: «второй», а не «вторый».
const STRESSED = new Set(['втор', 'шест', 'седьм', 'восьм', 'сороков']);

const ENDINGS = {
  m: { nom: 'ый', gen: 'ого', dat: 'ому', acc: 'ый', ins: 'ым', prep: 'ом' },
  f: { nom: 'ая', gen: 'ой', dat: 'ой', acc: 'ую', ins: 'ой', prep: 'ой' },
  n: { nom: 'ое', gen: 'ого', dat: 'ому', acc: 'ое', ins: 'ым', prep: 'ом' },
  pl: { nom: 'ые', gen: 'ых', dat: 'ым', acc: 'ые', ins: 'ыми', prep: 'ых' },
};
const THIRD = {
  m: { nom: 'третий', gen: 'третьего', dat: 'третьему', acc: 'третий', ins: 'третьим', prep: 'третьем' },
  f: { nom: 'третья', gen: 'третьей', dat: 'третьей', acc: 'третью', ins: 'третьей', prep: 'третьей' },
  n: { nom: 'третье', gen: 'третьего', dat: 'третьему', acc: 'третье', ins: 'третьим', prep: 'третьем' },
  pl: { nom: 'третьи', gen: 'третьих', dat: 'третьим', acc: 'третьи', ins: 'третьими', prep: 'третьих' },
};

/** До тысячи, именительный падеж. */
function belowThousand(n, feminine = false) {
  const words = [];
  const hundreds = Math.floor(n / 100);
  const rest = n % 100;
  if (hundreds) words.push(HUNDREDS[hundreds]);
  if (rest >= 10 && rest < 20) words.push(TEENS[rest - 10]);
  else {
    if (rest >= 20) words.push(TENS[Math.floor(rest / 10)]);
    if (rest % 10) words.push((feminine ? UNITS_F : UNITS)[rest % 10]);
  }
  return words;
}

/** Число словами в именительном падеже: «две тысячи десять». */
export function cardinal(n, gender = 'm') {
  if (!Number.isInteger(n) || n < 0) return String(n);
  if (n === 0) return 'ноль';
  const words = [];
  const groups = [
    [1e9, ['миллиард', 'миллиарда', 'миллиардов'], false],
    [1e6, ['миллион', 'миллиона', 'миллионов'], false],
    [1e3, ['тысяча', 'тысячи', 'тысяч'], true],
  ];
  let rest = n;
  for (const [size, forms, feminine] of groups) {
    const count = Math.floor(rest / size);
    rest %= size;
    if (!count) continue;
    // «тысяча девятьсот», а не «одна тысяча девятьсот».
    if (!(count === 1 && size === 1e3)) words.push(...belowThousand(count, feminine));
    words.push(plural(count, forms));
  }
  words.push(...belowThousand(rest, gender === 'f'));
  return words.join(' ');
}

/** Форма слова после числа: 1 страница, 2 страницы, 5 страниц. */
export function plural(n, [one, few, many]) {
  const lastTwo = Math.abs(n) % 100;
  const last = lastTwo % 10;
  if (lastTwo >= 11 && lastTwo <= 14) return many;
  if (last === 1) return one;
  if (last >= 2 && last <= 4) return few;
  return many;
}

/**
 * Порядковое числительное: в составном порядковое только последнее слово
 * («тысяча девятьсот двадцать восьмом»).
 * @param {'nom'|'gen'|'dat'|'acc'|'ins'|'prep'} grammaticalCase
 * @param {'m'|'f'|'n'|'pl'} gender
 */
export function ordinal(n, grammaticalCase = 'nom', gender = 'm') {
  if (!Number.isInteger(n) || n <= 0) return String(n);
  let stem;
  let prefixValue;
  if (n % 100 >= 10 && n % 100 < 20) {
    stem = TEEN_STEMS[(n % 100) - 10];
    prefixValue = n - (n % 100);
  } else if (n % 10) {
    stem = UNIT_STEMS[n % 10];
    prefixValue = n - (n % 10);
  } else if (n % 100) {
    stem = TEN_STEMS[Math.floor((n % 100) / 10)];
    prefixValue = n - (n % 100);
  } else if (n % 1000) {
    stem = HUNDRED_STEMS[Math.floor((n % 1000) / 100)];
    prefixValue = n - (n % 1000);
  } else {
    const thousands = Math.floor(n / 1000) % 1000;
    if (n >= 1e6 || (thousands !== 1 && !COMBINING[thousands])) return `${cardinal(n)}-й`;
    stem = `${thousands === 1 ? '' : COMBINING[thousands]}тысячн`;
    prefixValue = n - (n % 1e6);
  }

  const prefix = prefixValue ? `${cardinal(prefixValue)} ` : '';
  if (stem === 'трет') return prefix + THIRD[gender][grammaticalCase];
  let ending = ENDINGS[gender][grammaticalCase];
  if (ending === 'ый' && STRESSED.has(stem)) ending = 'ой';
  return prefix + stem + ending;
}

// Римские цифры в русском тексте часто набраны кириллицей: «ХХ век» (Х —
// русская «ха»), «ХIХ» вперемешку, «І» — украинская буква.
const ROMAN_LETTERS = 'IVXLCDMХІ';
const latinRoman = (text) => text.replace(/Х/g, 'X').replace(/І/g, 'I');

/** Римское число → арабское (I…MMM), null — не римское. Кириллические Х и І — как латинские. */
export function fromRoman(raw) {
  const text = latinRoman(raw);
  if (!/^[IVXLCDM]+$/.test(text)) return null;
  const values = { I: 1, V: 5, X: 10, L: 50, C: 100, D: 500, M: 1000 };
  let total = 0;
  for (let i = 0; i < text.length; i += 1) {
    const value = values[text[i]];
    const next = values[text[i + 1]] || 0;
    total += value < next ? -value : value;
  }
  // Проверка обратным преобразованием отсекает «IIII» и прочие не-числа.
  return toRoman(total) === text ? total : null;
}

function toRoman(n) {
  const table = [[1000, 'M'], [900, 'CM'], [500, 'D'], [400, 'CD'], [100, 'C'], [90, 'XC'], [50, 'L'], [40, 'XL'], [10, 'X'], [9, 'IX'], [5, 'V'], [4, 'IV'], [1, 'I']];
  let rest = n;
  let out = '';
  for (const [value, letters] of table) {
    while (rest >= value) {
      out += letters;
      rest -= value;
    }
  }
  return out;
}

// ── Падеж по контексту ─────────────────────────────────────────────────

const PREPOSITION_CASE = {
  в: 'prep', во: 'prep', о: 'prep', об: 'prep', обо: 'prep', при: 'prep',
  к: 'dat', ко: 'dat',
  по: 'acc', за: 'acc', через: 'acc', на: 'acc', про: 'acc',
  между: 'ins', перед: 'ins', над: 'ins', под: 'ins',
};

/** Падеж по предлогу перед числом; без предлога — родительный («издание 2010 г.»). */
function caseFromPreposition(before) {
  const word = /([а-яё]+)\s*$/i.exec(before)?.[1]?.toLowerCase();
  return PREPOSITION_CASE[word] || 'gen';
}

const YEAR_NOUN = {
  год: ['nom', false], года: ['gen', false], году: [null, false], годом: ['ins', false], годе: ['prep', false],
  годы: ['nom', true], годов: ['gen', true], годам: ['dat', true], годами: ['ins', true], годах: ['prep', true],
};
const YEAR_FORMS = {
  sg: { nom: 'год', gen: 'года', dat: 'году', acc: 'год', ins: 'годом', prep: 'году' },
  pl: { nom: 'годы', gen: 'годов', dat: 'годам', acc: 'годы', ins: 'годами', prep: 'годах' },
};
// Слово после номера века: падеж, род числительного и число («веков» —
// множественное: «XVIII и XIX веков»). Столетие и тысячелетие — среднего рода.
const CENTURY_WORDS = {
  век: ['nom', 'm', false], века: ['gen', 'm', false], веку: ['dat', 'm', false], веком: ['ins', 'm', false], веке: ['prep', 'm', false],
  веков: ['gen', 'm', true], векам: ['dat', 'm', true], веками: ['ins', 'm', true], веках: ['prep', 'm', true],
};
for (const stem of ['столети', 'тысячелети']) {
  const forms = { е: ['nom', false], я: ['gen', false], ю: ['dat', false], ем: ['ins', false], и: ['prep', false], й: ['gen', true], ям: ['dat', true], ями: ['ins', true], ях: ['prep', true] };
  for (const [ending, [grammaticalCase, pluralNoun]] of Object.entries(forms)) CENTURY_WORDS[stem + ending] = [grammaticalCase, 'n', pluralNoun];
}
const CENTURY_NOUN = new RegExp(String.raw`^\s*(${Object.keys(CENTURY_WORDS).sort((a, b) => b.length - a.length).join('|')})(?![\p{L}])`, 'iu');
const CENTURY_ABBR = /^\s*(вв?)\.(?![\p{L}])/u;
const CENTURY_FORMS = {
  sg: { nom: 'век', gen: 'века', dat: 'веку', acc: 'век', ins: 'веком', prep: 'веке' },
  pl: { nom: 'века', gen: 'веков', dat: 'векам', acc: 'века', ins: 'веками', prep: 'веках' },
};
// После этих слов номер века — в родительном: «конца XIX — начала XX века».
const GENITIVE_BEFORE = new Set(['начала', 'конца', 'середины', 'половины', 'рубежа', 'исхода', 'границы', 'литературы', 'истории', 'искусства']);

// Существительные перед номером: «глава 5» → «глава пятая».
const NUMBERED_NOUNS = {
  f: {
    глава: 'nom', главы: 'gen', главе: 'prep', главу: 'acc', главой: 'ins',
    часть: 'nom', части: 'gen', частью: 'ins',
    книга: 'nom', книги: 'gen', книге: 'prep', книгу: 'acc', книгой: 'ins',
    лекция: 'nom', лекции: 'gen', лекцию: 'acc', лекцией: 'ins',
    тема: 'nom', темы: 'gen', теме: 'prep', тему: 'acc', темой: 'ins',
  },
  m: {
    том: 'nom', тома: 'gen', тому: 'dat', томе: 'prep', томом: 'ins',
    раздел: 'nom', раздела: 'gen', разделу: 'dat', разделе: 'prep', разделом: 'ins',
    параграф: 'nom', параграфа: 'gen', параграфе: 'prep',
    урок: 'nom', урока: 'gen', уроке: 'prep',
  },
};

// Наращение после числа: «5-й», «2-го», «1990-х».
const SUFFIX_FORMS = [
  [/^(й|ый|ой|ий)$/, 'nom', 'm'],
  [/^(го|ого|его)$/, 'gen', 'm'],
  [/^(му|ому|ему)$/, 'dat', 'm'],
  [/^(м|ым|ом|ем)$/, null, 'm'], // творительный или предложный — по предлогу
  [/^(я|ая|ья)$/, 'nom', 'f'],
  [/^(ю|ую|ью)$/, 'acc', 'f'],
  [/^(е|ое|ье)$/, 'nom', 'n'],
  [/^(х|ых|их)$/, 'prep', 'pl'],
  [/^(ми|ыми|ими)$/, 'ins', 'pl'],
];

// Единицы после числа: число словами нужного рода, слово — в нужной форме.
const UNITS_AFTER = [
  [/^тыс\./, ['тысяча', 'тысячи', 'тысяч'], 'f'],
  [/^млн\.?/, ['миллион', 'миллиона', 'миллионов'], 'm'],
  [/^млрд\.?/, ['миллиард', 'миллиарда', 'миллиардов'], 'm'],
  [/^руб\./, ['рубль', 'рубля', 'рублей'], 'm'],
  [/^коп\./, ['копейка', 'копейки', 'копеек'], 'f'],
  [/^экз\./, ['экземпляр', 'экземпляра', 'экземпляров'], 'm'],
  [/^(?:с|стр)\./, ['страница', 'страницы', 'страниц'], 'f'],
  [/^%/, ['процент', 'процента', 'процентов'], 'm'],
  [/^чел\./, ['человек', 'человека', 'человек'], 'm'],
  [/^км(?![\p{L}])\.?/u, ['километр', 'километра', 'километров'], 'm'],
  [/^кг(?![\p{L}])\.?/u, ['килограмм', 'килограмма', 'килограммов'], 'm'],
  [/^см(?![\p{L}])\.?/u, ['сантиметр', 'сантиметра', 'сантиметров'], 'm'],
  [/^мм(?![\p{L}])\.?/u, ['миллиметр', 'миллиметра', 'миллиметров'], 'm'],
];

const MONTHS_GEN = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];
// После этих слов голое четырёхзначное число — год: «с осени 1945 по…».
const DATE_WORDS = new Set([
  ...MONTHS_GEN,
  'январе', 'феврале', 'марте', 'апреле', 'мае', 'июне', 'июле', 'августе', 'сентябре', 'октябре', 'ноябре', 'декабре',
  'весны', 'весной', 'лета', 'летом', 'осени', 'осенью', 'зимы', 'зимой',
  'начала', 'начале', 'конца', 'конце', 'середины', 'середине',
]);
const GEN_PREPOSITIONS = new Set(['с', 'со', 'от', 'до', 'из', 'после', 'около', 'у', 'для', 'без', 'кроме', 'начиная', 'вплоть']);
// После года без слова «год» обычно идёт не существительное, а связка.
const AFTER_YEAR = new Set(['по', 'и', 'или', 'до', 'а', 'но', 'когда', 'где', 'как', 'что', 'при', 'после', 'к', 'в', 'на']);

// Сокращения без числа. Регистр первой буквы сохраняется. true — сокращением
// может кончаться фраза («и т. д.»): тогда его точка — ещё и конец фразы.
// После «проф.» или «см.» заглавная — это имя, а не новая фраза.
const ABBREVIATIONS = [
  [/в т\.\s?ч\./iuy, 'в том числе'],
  [/до н\.\s?э\./iuy, 'до нашей эры', true],
  [/н\.\s?э\./iuy, 'нашей эры', true],
  [/т\.\s?е\./iuy, 'то есть'],
  [/т\.\s?д\./iuy, 'так далее', true],
  [/т\.\s?п\./iuy, 'тому подобное', true],
  [/т\.\s?к\./iuy, 'так как'],
  [/и др\./iuy, 'и другие', true],
  [/и пр\./iuy, 'и прочие', true],
  [/см\./iuy, 'смотри'],
  [/напр\./iuy, 'например'],
  [/проф\./iuy, 'профессор'],
  // «д-р Уэйс», «о д-ре Уэйсе», «у д-ра», «с д-ром» — доктор в нужном падеже.
  [/д-рами/iuy, 'докторами'],
  [/д-рах/iuy, 'докторах'],
  [/д-ром/iuy, 'доктором'],
  [/д-ров/iuy, 'докторов'],
  [/д-рам/iuy, 'докторам'],
  [/д-ре/iuy, 'докторе'],
  [/д-ра/iuy, 'доктора'],
  [/д-ру/iuy, 'доктору'],
  [/д-р/iuy, 'доктор'],
  [/акад\./iuy, 'академик'],
  [/доц\./iuy, 'доцент'],
  [/рис\./iuy, 'рисунок'],
  [/табл\./iuy, 'таблица'],
  [/гл\./iuy, 'глава'],
  [/стр\./iuy, 'страница'],
  [/ок\./iuy, 'около'],
  [/№\s?/iuy, 'номер '],
  [/§\s?/iuy, 'параграф '],
];

const NUMBER = /\d{1,3}(?:[  ]\d{3})+(?!\d)|\d+/y;
const parseNumber = (text) => Number(text.replace(/[  ]/g, ''));
const capitalize = (text, like) => (/^\p{Lu}/u.test(like) ? text[0].toUpperCase() + text.slice(1) : text);
const isWordChar = (char) => /[\p{L}\p{N}]/u.test(char || '');

/**
 * Если на месте сокращения стояла точка конца предложения — вернуть её,
 * иначе голос не сделает паузу и интонацию конца фразы.
 */
function keepSentenceEnd(text, end, spoken) {
  const after = text.slice(end);
  return /^\s*($|\p{Lu})/u.test(after) && text[end - 1] === '.' ? `${spoken}.` : spoken;
}

/** Попробовать разобрать число с контекстом в позиции i. */
function matchNumber(text, i) {
  NUMBER.lastIndex = i;
  const numberMatch = NUMBER.exec(text);
  if (!numberMatch) return null;
  const first = parseNumber(numberMatch[0]);
  let end = i + numberMatch[0].length;
  const before = text.slice(Math.max(0, i - 30), i);

  // Диапазон: «1945–1946».
  let second = null;
  const range = /^\s*[-–—]\s*(\d{1,4})(?!\d)/.exec(text.slice(end));
  const afterRange = range ? end + range[0].length : end;

  // Год со словом «год» в любой форме.
  const nounMatch = /^\s+(год|года|году|годом|годе|годы|годов|годам|годами|годах)(?![\p{L}])/u.exec(text.slice(afterRange));
  if (nounMatch && first > 0 && first < 3000) {
    if (range) second = Number(range[1]);
    let [grammaticalCase] = YEAR_NOUN[nounMatch[1]];
    if (!grammaticalCase) grammaticalCase = caseFromPreposition(before) === 'dat' ? 'dat' : 'prep';
    const years = [first, second].filter(Boolean).map((year) => ordinal(year, grammaticalCase, 'm'));
    return { end: afterRange, spoken: years.join(' — ') };
  }

  // Год с сокращением: «1947 г.», «1945–1946 гг.».
  const abbrMatch = /^\s*(гг?)\.(?![\p{L}])/u.exec(text.slice(afterRange));
  if (abbrMatch && numberMatch[0].length >= 3 && first < 3000) {
    if (range) second = Number(range[1]);
    const pluralNoun = abbrMatch[1] === 'гг' || Boolean(second);
    const grammaticalCase = caseFromPreposition(before);
    const years = [first, second].filter(Boolean).map((year) => ordinal(year, grammaticalCase, 'm'));
    const noun = YEAR_FORMS[pluralNoun ? 'pl' : 'sg'][grammaticalCase];
    const fullEnd = afterRange + abbrMatch[0].length;
    return { end: fullEnd, spoken: keepSentenceEnd(text, fullEnd, `${years.join(' — ')} ${noun}`) };
  }

  // Век арабскими цифрами: «в 19 веке», «до 19-го века», «20 век», «18–19 вв.».
  // «За 20 веков», «2 века назад» — это счёт, а не номер века: не трогаем.
  if (first >= 1 && first <= 40 && (!range || Number(range[1]) <= 40)) {
    const after = centuryAfter(text.slice(afterRange));
    const fromBefore = centuryCaseFromBefore(before);
    const pair = range ? [first, Number(range[1])] : [first];
    if (after && !after.abbr) {
      const count = !range && (after.pluralNoun || (after.grammaticalCase === 'gen' && !fromBefore && !after.suffix));
      if (!count) {
        return { end: afterRange + after.suffix, spoken: pair.map((value) => ordinal(value, after.grammaticalCase, after.gender)).join(' — ') };
      }
    } else if (after) {
      const grammaticalCase = fromBefore || 'gen';
      const fullEnd = afterRange + after.suffix + after.abbr.length;
      const noun = CENTURY_FORMS[after.pluralNoun || range ? 'pl' : 'sg'][grammaticalCase];
      return { end: fullEnd, spoken: keepSentenceEnd(text, fullEnd, `${pair.map((value) => ordinal(value, grammaticalCase, 'm')).join(' — ')} ${noun}`) };
    }
  }

  // Наращение: «5-й», «1990-х».
  const suffixMatch = /^-([а-яё]{1,3})(?![\p{L}])/u.exec(text.slice(end));
  if (suffixMatch) {
    const suffix = suffixMatch[1];
    for (const [pattern, fixedCase, fixedGender] of SUFFIX_FORMS) {
      if (!pattern.test(suffix)) continue;
      let gender = fixedGender;
      let grammaticalCase = fixedCase;
      if (!grammaticalCase) grammaticalCase = caseFromPreposition(before) === 'prep' ? 'prep' : 'ins';
      // «1990-е», «20-е годы» — десятилетия, это множественное число.
      if (gender === 'n' && first % 10 === 0) gender = 'pl';
      if (gender === 'pl' && grammaticalCase === 'prep' && caseFromPreposition(before) !== 'prep') grammaticalCase = 'gen';
      return { end: end + suffixMatch[0].length, spoken: ordinal(first, grammaticalCase, gender) };
    }
  }

  // Число с единицей: «592 с.», «1000 экз.», «15%».
  const rest = text.slice(end).replace(/^[  ]?/, '');
  const gap = text.slice(end).length - rest.length;
  for (const [pattern, forms, gender] of UNITS_AFTER) {
    const unitMatch = pattern.exec(rest);
    if (!unitMatch) continue;
    const fullEnd = end + gap + unitMatch[0].length;
    const spoken = `${cardinal(first, gender)} ${plural(first, forms)}`;
    return { end: fullEnd, spoken: unitMatch[0].endsWith('.') ? keepSentenceEnd(text, fullEnd, spoken) : spoken };
  }

  const previousWord = /([а-яё]+)[\s,]*$/i.exec(before)?.[1]?.toLowerCase();
  const nextWord = /^\s*([\p{L}]*)/u.exec(text.slice(end))[1];

  // Дата: «1 мая» → «первого мая».
  if (first >= 1 && first <= 31 && MONTHS_GEN.includes(nextWord.toLowerCase())) {
    return { end, spoken: ordinal(first, caseFromPreposition(before), 'n') };
  }

  // Год без слова «год»: «с осени 1945 по…», «в 1945 Эрхард…», «в мае 1945».
  const looksLikeYear = /^\d{4}$/.test(numberMatch[0]) && first >= 1000 && first <= 2100;
  const yearContext = previousWord && (DATE_WORDS.has(previousWord) || previousWord in PREPOSITION_CASE || GEN_PREPOSITIONS.has(previousWord));
  const nextFits = !/^\p{Ll}/u.test(nextWord) || AFTER_YEAR.has(nextWord);
  if (looksLikeYear && yearContext && nextFits) {
    const grammaticalCase = DATE_WORDS.has(previousWord) ? 'gen' : caseFromPreposition(before);
    return { end, spoken: ordinal(first, grammaticalCase, 'm') };
  }
  return null;
}

const ROMAN_TOKEN = new RegExp(String.raw`[${ROMAN_LETTERS}]+(?![\p{L}\p{N}])`, 'uy');
const ROMAN_RANGE = new RegExp(String.raw`^\s*[-–—]\s*([${ROMAN_LETTERS}]+)(?![\p{L}\p{N}])`, 'u');
// Наращение после номера: «XX-го века», «XIX-м веке».
const ORDINAL_SUFFIX = /^-[а-яё]{1,3}(?![\p{L}])/u;
// Номер века дальше в той же части фразы: «XIX — начала XX века», «XVIII и XIX веков».
const LATER_CENTURY = new RegExp(String.raw`^[^.!?;:\d]{1,40}?(?<![\p{L}])([${ROMAN_LETTERS}]+)(?:-[а-яё]{1,3})?(?=(?:\s*(?:вв?)\.(?![\p{L}]))|${CENTURY_NOUN.source.slice(1)})`, 'iu');

const COORDINATED = new RegExp(String.raw`(${Object.keys(CENTURY_WORDS).join('|')})\s+(?:и|или|либо|а)\s*$`, 'iu');

/**
 * Падеж номера века по словам перед ним: предлог, «начала», «конца»… или
 * века через союз — «в XIX веке и XX в.» (тот же падеж, что у «веке»).
 */
function centuryCaseFromBefore(before) {
  const word = /([а-яё]+)\s*$/i.exec(before)?.[1]?.toLowerCase();
  if (word && word in PREPOSITION_CASE) return PREPOSITION_CASE[word];
  if (word && (GENITIVE_BEFORE.has(word) || GEN_PREPOSITIONS.has(word))) return 'gen';
  const coordinated = COORDINATED.exec(before);
  return coordinated ? CENTURY_WORDS[coordinated[1].toLowerCase()][0] : null;
}

/** Слово века после номера (с наращением или без): { case, gender, plural, abbr, length }. */
function centuryAfter(rest) {
  const suffix = ORDINAL_SUFFIX.exec(rest)?.[0] || '';
  const tail = rest.slice(suffix.length);
  const noun = CENTURY_NOUN.exec(tail);
  if (noun) {
    const [grammaticalCase, gender, pluralNoun] = CENTURY_WORDS[noun[1].toLowerCase()];
    return { grammaticalCase, gender, pluralNoun, suffix: suffix.length, abbr: null };
  }
  const abbr = CENTURY_ABBR.exec(tail);
  if (abbr) return { grammaticalCase: null, gender: 'm', pluralNoun: abbr[1] === 'вв', suffix: suffix.length, abbr: abbr[0] };
  return null;
}

/** Римские века (и тысячелетия) — порядковым в нужном падеже. */
function matchRoman(text, i) {
  ROMAN_TOKEN.lastIndex = i;
  const found = ROMAN_TOKEN.exec(text);
  if (!found) return null;
  const first = fromRoman(found[0]);
  if (!first) return null;
  let end = i + found[0].length;
  let second = null;
  const range = ROMAN_RANGE.exec(text.slice(end));
  if (range && fromRoman(range[1])) {
    second = fromRoman(range[1]);
    end += range[0].length;
  }
  const before = text.slice(Math.max(0, i - 30), i);
  const numbers = (grammaticalCase, gender) => [first, second].filter(Boolean).map((value) => ordinal(value, grammaticalCase, gender)).join(' — ');

  const after = centuryAfter(text.slice(end));
  if (after && !after.abbr) {
    return { end: end + after.suffix, spoken: numbers(after.grammaticalCase, after.gender) };
  }
  if (after) {
    const grammaticalCase = centuryCaseFromBefore(before) || 'gen';
    const pluralNoun = after.pluralNoun || Boolean(second);
    const fullEnd = end + after.suffix + after.abbr.length;
    const spoken = `${numbers(grammaticalCase, 'm')} ${CENTURY_FORMS[pluralNoun ? 'pl' : 'sg'][grammaticalCase]}`;
    return { end: fullEnd, spoken: keepSentenceEnd(text, fullEnd, spoken) };
  }
  // Слово века — после следующего номера: «конца XIX — начала XX века».
  const later = LATER_CENTURY.exec(text.slice(end));
  if (later && fromRoman(later[1])) {
    const next = centuryAfter(text.slice(end + later[0].length));
    const grammaticalCase = centuryCaseFromBefore(before) || next?.grammaticalCase || 'gen';
    return { end, spoken: numbers(grammaticalCase, next?.gender || 'm') };
  }
  return null;
}

/**
 * Латинские буквы на месте [start, end) — римский номер века или главы в
 * русской фразе, а не английское слово: его читает русский голос (сначала
 * normalizeRussian сделает из него числительное). Кириллические Х и І рядом
 * — часть того же номера («ХVIII»).
 */
export function isRomanInRussian(text, start, end) {
  let from = start;
  let to = end;
  while (to > from && /[.'’-]/.test(text[to - 1])) to -= 1; // «IV.» — точка не часть номера
  while (from > 0 && /[ХІ]/.test(text[from - 1])) from -= 1;
  while (to < text.length && /[ХІ]/.test(text[to])) to += 1;
  const token = text.slice(from, to);
  if (!/^[IVXLCDMХІ]+(?:[-–—][IVXLCDMХІ]+)?$/.test(token) || !token.split(/[-–—]/).every((part) => fromRoman(part))) return false;
  if (isWordChar(text[from - 1]) || isWordChar(text[to])) return false;
  const rest = text.slice(to);
  if (centuryAfter(rest) || LATER_CENTURY.exec(rest)) return true;
  const word = /([\p{L}]+)\s+$/u.exec(text.slice(Math.max(0, from - 20), from))?.[1]?.toLowerCase();
  return Boolean(word && (word in NUMBERED_NOUNS.f || word in NUMBERED_NOUNS.m));
}

/** «Глава 5», «Часть II», «в главе 3» → номер порядковым в падеже слова. */
function matchNumberedNoun(text, i) {
  const word = /([\p{L}]+)\s+([IVXLCХІ]+|\d{1,3})(?![\p{L}\p{N}]|-)/uy;
  word.lastIndex = i;
  const found = word.exec(text);
  if (!found) return null;
  const lower = found[1].toLowerCase();
  const gender = lower in NUMBERED_NOUNS.f ? 'f' : lower in NUMBERED_NOUNS.m ? 'm' : null;
  if (!gender) return null;
  const value = /^\d/.test(found[2]) ? Number(found[2]) : fromRoman(found[2]);
  if (!value) return null;
  const grammaticalCase = NUMBERED_NOUNS[gender][lower];
  return { end: i + found[0].length, spoken: `${found[1]} ${ordinal(value, grammaticalCase, gender)}` };
}

function matchAbbreviation(text, i) {
  for (const [pattern, spoken, canEndSentence] of ABBREVIATIONS) {
    pattern.lastIndex = i;
    const found = pattern.exec(text);
    if (!found) continue;
    const end = i + found[0].length;
    if (isWordChar(text[end]) && !/\s$/.test(found[0])) continue;
    const words = capitalize(spoken, found[0]);
    return { end, spoken: canEndSentence ? keepSentenceEnd(text, end, words) : words };
  }
  return null;
}

/**
 * @returns {{ text: string, segments: { start: number, end: number, spoken: string }[] }}
 *   text — что произносить; segments — какие куски исходного текста заменены
 */
const YEAR_RANGE = /(\d{4})\s?[-–—]\s?(\d{4})(?!\d)/y;
const RANGE = /(\d+)\s?[–—-]\s?(\d+)(?![\d,.]\d)/y;
const DECIMAL = /(\d+)[,.](\d{1,2})(?!\d)/y;
const isYear = (n) => n >= 1000 && n <= 2100;

/**
 * Число, у которого нет слова-подсказки рядом. Годы жизни и периоды
 * «(1796–1857)» — порядковыми («тысяча семьсот девяносто шестой —
 * тысяча восемьсот пятьдесят седьмой»), диапазон «253–254» и всё прочее —
 * количественными, дробь «2,5» — «две целых пять десятых».
 */
function plainNumber(text, start) {
  const words = (n) => cardinal(n);
  YEAR_RANGE.lastIndex = start;
  let match = YEAR_RANGE.exec(text);
  if (match && isYear(Number(match[1])) && isYear(Number(match[2]))) {
    return { end: YEAR_RANGE.lastIndex, spoken: `${ordinal(Number(match[1]))} — ${ordinal(Number(match[2]))}` };
  }
  DECIMAL.lastIndex = start;
  match = DECIMAL.exec(text);
  // «2,5» — дробь; «1,2,3» и «2.5.1» (номера пунктов) — нет.
  const inSequence = /\d[,.]$/.test(text.slice(Math.max(0, start - 2), start));
  if (match && !inSequence && !/[,.]\d/.test(text.slice(DECIMAL.lastIndex, DECIMAL.lastIndex + 2))) {
    const whole = Number(match[1]);
    const part = Number(match[2]);
    const unit = match[2].length === 1 ? ['десятая', 'десятых', 'десятых'] : ['сотая', 'сотых', 'сотых'];
    return {
      end: DECIMAL.lastIndex,
      spoken: `${cardinal(whole, 'f')} ${plural(whole, ['целая', 'целых', 'целых'])} ${cardinal(part, 'f')} ${plural(part, unit)}`,
    };
  }
  RANGE.lastIndex = start;
  match = RANGE.exec(text);
  if (match && !/^0\d/.test(match[1]) && !/^0\d/.test(match[2])) {
    return { end: RANGE.lastIndex, spoken: `${words(Number(match[1]))} — ${words(Number(match[2]))}` };
  }
  NUMBER.lastIndex = start;
  const plain = NUMBER.exec(text)[0];
  const end = start + plain.length;
  // Номер с ведущим нулём («0002», код, ORCID) — по цифрам.
  if (/^0\d/.test(plain)) return { end, spoken: [...plain.replace(/\D/g, '')].map((digit) => cardinal(Number(digit))).join(' ') };
  const value = Number(plain.replace(/\D/g, ''));
  // Год сам по себе — «(1882)», «М., 2010.» — порядковым: «тысяча восемьсот
  // восемьдесят второй». Если за числом слово («2000 рублей») — это счёт.
  if (isYear(value) && !/^\s*\p{L}/u.test(text.slice(end, end + 3))) return { end, spoken: ordinal(value) };
  return { end, spoken: words(value) };
}

export function normalizeRussian(text) {
  const segments = [];
  let out = '';
  let i = 0;
  while (i < text.length) {
    const atWordStart = !isWordChar(text[i - 1]);
    let match = null;
    if (atWordStart) {
      match =
        (/\p{L}/u.test(text[i]) && matchNumberedNoun(text, i)) ||
        (/\d/.test(text[i]) && matchNumber(text, i)) ||
        (/[IVXLCDMХІ]/.test(text[i]) && matchRoman(text, i)) ||
        matchAbbreviation(text, i);
    }
    if (match) {
      segments.push({ start: i, end: match.end, spoken: match.spoken });
      out += match.spoken;
      i = match.end;
      continue;
    }
    // Число без контекста — тоже словами: у TeraTTS в словаре нет цифр, и
    // «39 статей» или годы жизни «(1796–1857)» она бы просто пропустила.
    if (atWordStart && /\d/.test(text[i])) {
      const plain = plainNumber(text, i);
      segments.push({ start: i, end: plain.end, spoken: plain.spoken });
      out += plain.spoken;
      i = plain.end;
      continue;
    }
    out += text[i];
    i += 1;
  }
  return { text: out, segments };
}
