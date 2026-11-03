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

// Не омографы, а норма и просторечие: в словаре омографов RUAccent у них оба
// ударения, и нейросеть порой выбирала просторечное — «зв+онит», «щ+авель»,
// «н+ачался». Здесь — только нормативное (по орфоэпическому словарю).
export const NORMATIVE_STRESS = new Map(
  Object.entries({
    звонит: 'звон+ит', звонишь: 'звон+ишь', звоним: 'звон+им', звоните: 'звон+ите', звонят: 'звон+ят',
    позвонит: 'позвон+ит', позвонишь: 'позвон+ишь', позвоним: 'позвон+им', позвоните: 'позвон+ите', позвонят: 'позвон+ят',
    щавель: 'щав+ель', щавеля: 'щав+еля', щавелем: 'щав+елем',
    договор: 'догов+ор', договоры: 'догов+оры', договоров: 'догов+оров',
    бармен: 'б+армен', бармена: 'б+армена', торты: 'т+орты', тортов: 'т+ортов', тортами: 'т+ортами',
    столяр: 'стол+яр', оптовый: 'опт+овый', оптовая: 'опт+овая', оптовые: 'опт+овые', оптовых: 'опт+овых',
    начался: 'нач+ался', началась: 'начал+ась', началось: 'начал+ось', начались: 'начал+ись',
    принялся: 'прин+ялся', принялась: 'принял+ась', поняла: 'понял+а', взяла: 'взял+а',
    понял: 'п+онял', поняли: 'п+оняли', отдал: '+отдал', занял: 'з+анял',
    включим: 'включ+им', включит: 'включ+ит', включишь: 'включ+ишь', включат: 'включ+ат',
    кровоточащий: 'кровоточ+ащий', мастерски: 'мастерск+и', донельзя: 'дон+ельзя',
    искра: '+искра', обеспечение: 'обесп+ечение', сливовый: 'сл+ивовый', свекла: 'св+ёкла',
    шарфы: 'ш+арфы', шарфов: 'ш+арфов', банты: 'б+анты', бантов: 'б+антов', краны: 'кр+аны',
    красивее: 'крас+ивее', закупорить: 'зак+упорить', ломоть: 'л+омоть', знамение: 'зн+амение',
    газопровод: 'газопров+од', черпать: 'ч+ерпать', баловать: 'балов+ать', балуясь: 'бал+уясь', балует: 'бал+ует',
  })
);

// Омографы, у которых второй вариант в обычном тексте почти не встречается
// («бы́ла», «сво́ему», «ду́ша» — это «быль», «свой» и «душ» в редких формах).
// Сеть омографов всё же выбирала его то тут, то там — проверено на «Вии»
// Гоголя и сборнике статей начала XX века; здесь — только частый вариант.
export const COMMON_STRESS = new Map(
  Object.entries({
    была: 'был+а', своему: 'своем+у', кому: 'ком+у', тому: 'том+у', раза: 'р+аза', судя: 'с+удя',
    душа: 'душ+а', душе: 'душ+е', отчего: 'отчег+о', моя: 'мо+я', отдали: '+отдали', одновременно: 'одновр+еменно',
    // Сеть выбирала редкий вариант и на корпусе SynTagRus: «т+акая», «мал+о», «р+авно», «+один».
    такая: 'так+ая', мало: 'м+ало', равно: 'равн+о', широко: 'широк+о', один: 'од+ин', деньги: 'д+еньги', части: 'ч+асти',
  })
);

// «Уже» — почти всегда «уже́»; «у́же» (сравнительная от «узкий») — только
// перед «чем» или после «всё», «ещё», «стала»… («дорога становилась всё у́же»).
const NARROWER_BEFORE = new Set(
  'ещё еще гораздо намного чуть несколько значительно куда стал стала стало стали становится становятся становился становилась становилось становились сделался сделалась сделалось сделались'.split(' ')
);
// «Начала» и «начало» перед инфинитивом — глагол («она начала́ понимать»,
// «дверей на́чало представляться»), после предлога — существительное
// («после нача́ла войны»). Сеть путала и то, и другое.
const INFINITIVE = /(?:ть|ться|ти|тись|чь|чься)$/u;
const NOUN_AFTER = new Set('после до с со от для без у из около вместо кроме самого самому самом начиная'.split(' '));

// «Ё» в двояких словах (все/всё, нем/нём) по соседним словам — до сети.
// Сеть «ё» RUAccent на корпусе SynTagRus (Universal Dependencies, где по
// грамматике видно, какое слово) ошибалась в 7–8 % таких слов: «Вс+ё
// замерли», «прошло много лёт», «ясное нёбо», «о нем». С правилами ниже
// ошибок втрое меньше: 74 → 24 на тестовой части корпуса, по которой
// правила не подбирались; испорчены два спорных места («все переврали»).
const YO_NEVER = new Set('лет летом самое далеко небо неба небу небом небе'.split(' '));
const YO_ALWAYS = new Set('объем счету полет полета полету полетом полете'.split(' '));
// «О нём», «во всём», «в моём», «о чём» — после предлога; без него — «нем», «всем», «моем», «чем».
const YO_AFTER_PREPOSITION = new Set(['нем', 'всем', 'моем', 'чем']);
const LOCATIVE_PREPOSITIONS = new Set('о об обо в во на при'.split(' '));
// «Все» — подлежащее во множественном числе: дальше глагол или прилагательное
// во множественном («все замерли», «все торопятся», «все высокие»), «все мы»,
// «все друг с другом», «все до одного», «как все.».
const PLURAL_VERB = /(?:ли|лись|ют|ются|ят|ятся)$/u;
const PLURAL_ADJECTIVE = /(?:ые|кие|гие|хие|шие|щие|жие|чие)$/u;
const PLURAL_SHORT = new Set('должны нужны рады готовы правы согласны живы равны'.split(' '));
const BEFORE_VERB = new Set('вдруг сразу дружно разом вместе тут сейчас теперь опять снова тоже давно уже'.split(' '));
const ALL_OF = new Set('мы вы они друг до'.split(' '));
const NOT_SUBJECT_BEFORE = new Set('на за про через в во'.split(' '));

const pluralVerb = (word) => word.length > 3 && PLURAL_VERB.test(word);

/**
 * «Ё» по соседним словам (все слова строчные, без «ё»).
 * @param last за словом — знак или конец фразы
 * @returns {boolean|undefined} true — с «ё», false — без, undefined — решает сеть
 */
export function yoByContext(word, previous, next, afterNext, last = false) {
  if (YO_NEVER.has(word)) return false;
  if (YO_ALWAYS.has(word)) return true;
  if (YO_AFTER_PREPOSITION.has(word)) return LOCATIVE_PREPOSITIONS.has(previous);
  if (word === 'слезы') return previous !== 'ни';
  if (word !== 'все') return undefined;
  if (ALL_OF.has(next)) return false;
  // «Все, кроме…» — но «бросив всё, кроме…», «на всё, кроме…».
  if ((next === 'кроме' || next === 'включая') && !NOT_SUBJECT_BEFORE.has(previous) && !/в$/u.test(previous)) return false;
  if (previous === 'как' && last) return false;
  if (pluralVerb(next) || PLURAL_SHORT.has(next)) return false;
  // «Всё новые и новые» — оборот; остальные прилагательные — «все высокие».
  if (next.length > 3 && PLURAL_ADJECTIVE.test(next) && next !== 'новые') return false;
  // «Все дружно закричали», «все удивлённо посмотрели» — но «всё равно ушли».
  if ((BEFORE_VERB.has(next) || (next.length > 4 && next.endsWith('о') && next !== 'равно')) && pluralVerb(afterNext)) return false;
  return undefined;
}

// Существительные, где родительный единственного и множественное различаются
// только ударением: «стороны́ / сто́роны», «го́рода / города́», «руки́ / ру́ки».
// Какое из них нужно, обычно видно по слову перед ним, а сеть омографов в
// этих словах ошибалась чаще всего (корпус SynTagRus).
const FEW = new Set('два две три четыре оба обе полтора полторы'.split(' '));
const GENITIVE_PREPOSITIONS = new Set(
  'из от у до без для около возле после вокруг среди мимо кроме вместо против напротив ради с со посреди внутри вдоль из-за из-под'.split(' ')
);
const GENITIVE_ADJECTIVE = /(?:ого|его|ой|ей)$/u;
const NOT_GENITIVE_ADJECTIVE = new Set('него кого чего ничего никого людей детей'.split(' '));
const PLURAL_BEFORE = new Set('все эти те мои твои свои наши ваши чьи'.split(' '));
const ACCUSATIVE_PREPOSITIONS = new Set('в во на за под через про сквозь'.split(' '));

/** Падеж по слову перед существительным: 'genitive' | 'plural' | undefined. */
export function caseBefore(previous) {
  if (FEW.has(previous) || GENITIVE_PREPOSITIONS.has(previous)) return 'genitive';
  if (previous.length > 3 && GENITIVE_ADJECTIVE.test(previous) && !NOT_GENITIVE_ADJECTIVE.has(previous)) return 'genitive';
  if (PLURAL_BEFORE.has(previous) || ACCUSATIVE_PREPOSITIONS.has(previous)) return 'plural';
  if (previous.length > 3 && PLURAL_ADJECTIVE.test(previous)) return 'plural';
  return undefined;
}

/** Номер ударной гласной в «з+амок» / «звёзды» (с нуля); -1 — не помечена. */
function stressedVowel(variant) {
  const plus = variant.indexOf('+');
  const at = plus >= 0 ? plus + 1 : variant.indexOf('ё');
  return at < 0 ? -1 : vowelCount(variant.slice(0, at));
}

/**
 * Омограф-существительное «родительный ед. / именительный мн.»: какой
 * вариант какой. Родительный единственного ударен там же, где творительный
 * (он в словаре однозначен): «го́дом — го́да», «лицо́м — лица́», «руко́й — руки́»;
 * множественное — другой вариант.
 * @param stress словарь ударений (accent(word) → «сл+ово» | null)
 * @returns {{ genitive: string, plural: string } | null}
 */
export function caseForms(word, variants, stress) {
  if (variants.length !== 2 || !/[ыиая]$/u.test(word)) return null;
  const last = vowelCount(word) - 1;
  if (last < 1) return null;
  const ending = variants.find((variant) => stressedVowel(variant) === last);
  const stem = variants.find((variant) => stressedVowel(variant) >= 0 && stressedVowel(variant) < last);
  if (!ending || !stem) return null;
  const base = word.slice(0, -1);
  const known = (form) => stress.accent(form);
  const feminine = /[ыи]$/u.test(word);
  // Краткое прилагательное («нужны́ / ну́жны», «права́») и третье склонение («в связи́») — не сюда.
  if ((known(`${base}ая`) && known(`${base}ое`)) || (feminine && known(`${base}ь`))) return null;
  for (const end of feminine ? ['ой', 'ей', 'ёй'] : ['ом', 'ем', 'ём']) {
    const instrumental = known(base + end);
    if (!instrumental) continue;
    return stressedVowel(instrumental) === vowelCount(instrumental) - 1 ? { genitive: ending, plural: stem } : { genitive: stem, plural: ending };
  }
  return null;
}

// «Потом» сеть омографов RUAccent путает наоборот — и в оригинале на Python:
// наречие («а потом пошли») читает «пот+ом», а «покрылся потом» — «п+отом»
// (видимо, варианты перепутаны в её обучающих данных). Наречие — почти всегда.
const SELF = { самому: 'самом+у', самого: 'самог+о', самом: 'сам+ом', самой: 'сам+ой' };
const SWEAT_BEFORE = /^(?:покры|обли|исход|залит|пропит|пахн|пахл|запах|мокр)/u;

/** Ударение по соседним словам; undefined — решает сеть. */
export function contextStress(word, previous, next, afterNext = '') {
  // «В прошлом году́», но «к двадцатому го́ду», «по го́ду».
  if (word === 'году') return /(?:ому|ему)$/u.test(previous) || previous === 'к' || previous === 'по' ? 'г+оду' : 'год+у';
  // «Стоит ли», «стоит начать» — «сто́ит».
  if (word === 'стоит' && (next === 'ли' || (INFINITIVE.test(next) && next.length > 3))) return 'ст+оит';
  // «Самому себе», «самого себя» — от «сам».
  if (next.startsWith('себ') && SELF[word]) return SELF[word];
  // Третье склонение: «в сети́», «в связи́ с» — но «торговой се́ти», «средства свя́зи».
  if (word === 'сети') return previous === 'в' || previous === 'во' || previous === 'на' ? 'сет+и' : 'с+ети';
  if (word === 'связи') return previous === 'в' || previous === 'во' ? 'связ+и' : 'св+язи';
  if (word === 'потом') return SWEAT_BEFORE.test(previous) || (next === 'и' && afterNext.startsWith('кров')) ? 'пот+ом' : 'п+отом';
  if (word === 'уже') return next === 'чем' || NARROWER_BEFORE.has(previous) ? '+уже' : 'уж+е';
  if (word === 'начала' || word === 'начало') {
    if (INFINITIVE.test(next) && next.length > 3) return word === 'начала' ? 'начал+а' : 'н+ачало';
    if (NOUN_AFTER.has(previous)) return word === 'начала' ? 'нач+ала' : 'нач+ало';
  }
  return undefined;
}

// «Века» после порядкового в родительном — единственное число: «двадцатого
// в+ека», а не «век+а» (нейросеть путала с «века́» — множественным).
const AFTER_GENITIVE_ORDINAL = new Map([
  ['века', 'в+ека'],
  ['года', 'г+ода'],
]);
const GENITIVE_ORDINAL = /(?:ого|его)$/u;

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
    const plain = (item) => item?.text.toLowerCase().replace(/ё/g, 'е') ?? '';
    const doubtful = [];
    for (const item of words.filter((word) => yoHomographs.has(word.text.toLowerCase()))) {
      const at = words.indexOf(item);
      const index = items.indexOf(item);
      const decided = yoByContext(plain(item), plain(words[at - 1]), plain(words[at + 1]), plain(words[at + 2]), !items[index + 1]?.word);
      if (decided === undefined) doubtful.push(item);
      else if (decided) item.text = fixCapital(item.text, yoHomographs.get(item.text.toLowerCase()));
    }
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
    const texts = items.map((item) => item.text);
    for (const [i, item] of items.entries()) {
      if (!item.word || item.text.includes('+')) continue;
      const previous = items.slice(0, i).findLast((other) => other.word)?.text.toLowerCase().replace(/\+/g, '') || '';
      const [next = '', afterNext = ''] = items
        .slice(i + 1)
        .filter((other) => other.word)
        .slice(0, 2)
        .map((other) => other.text.toLowerCase().replace(/\+/g, ''));
      const lower = item.text.toLowerCase();
      const normative =
        NORMATIVE_STRESS.get(lower) ||
        COMMON_STRESS.get(lower) ||
        contextStress(lower, previous, next, afterNext) ||
        (GENITIVE_ORDINAL.test(previous) ? AFTER_GENITIVE_ORDINAL.get(lower) : undefined);
      if (normative) {
        item.text = fixCapital(item.text, normative);
        texts[i] = normative;
        continue;
      }
      const variants = omographs.get(lower);
      if (!variants?.length) continue;
      // «Из го́рода», «две стороны́», «все города́» — падеж виден по слову перед ним.
      const forms = caseForms(lower, variants, stress);
      const wanted = forms ? caseBefore(previous) : undefined;
      if (!wanted && !models.chooseOmograph) continue;
      const chosen = wanted ? forms[wanted] : variants.length === 1 ? variants[0] : await models.chooseOmograph(omographContext(texts, i), variants);
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
    // Выброшенный знак — пробел, а не пусто: из «Москва–Петербург» или
    // «1796–1857» иначе выходило одно слово, слова не совпадали, и вся фраза
    // оставалась без ударений («фИлософ»).
    const clean = text.replace(NOT_KEPT, ' ');
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
    async process(raw) {
      // Ударение знаком над гласной («за́мок») — то же, что ручное «+».
      const text = raw.replace(/([аеёиоуыэюяАЕЁИОУЫЭЮЯ])\u0301/g, '+$1');
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
