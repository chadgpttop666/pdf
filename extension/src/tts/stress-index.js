// Словарь ударений RUAccent в компактном виде. В исходном JSON 3,2 млн
// словоформ («аароновец»: «аар+оновец») — 175 МБ текста; разобранный
// целиком, он занял бы в памяти полгигабайта. Поэтому при скачивании голоса
// словарь один раз превращается в отсортированный массив хешей слов и место
// ударения при каждом: ≈19 МБ, поиск — двоичный.
//
// Хеш 32-битный, плюс 8 бит проверки другим хешем: два разных слова с
// одинаковым ключом различаются проверкой, а слово, которого в словаре нет,
// примет чужое ударение с вероятностью порядка 10⁻⁶ — тогда оно просто
// прозвучит с другим ударением.

const MAGIC = 0x58525453; // «STRX»
const VERSION = 1;
const HEADER_BYTES = 12;

/** Два независимых хеша слова: ключ и байт проверки. */
export function hashWord(word) {
  let key = 0x811c9dc5;
  let check = 0x2545f491;
  for (let i = 0; i < word.length; i += 1) {
    const code = word.charCodeAt(i);
    key = Math.imul(key ^ code, 0x01000193) >>> 0;
    check = Math.imul(check ^ code, 0x5bd1e995) >>> 0;
  }
  return [key, check >>> 24];
}

const LINE = /^\s*"([^"]+)":\s*"([^"]+)"/;

/**
 * Строка словаря → [слово, номер буквы, перед которой стоит «+»].
 * @returns {[string, number]|null} null — не запись или запись без ударения
 */
export function parseAccentLine(line) {
  const match = LINE.exec(line);
  if (!match) return null;
  const position = match[2].indexOf('+');
  if (position < 0 || match[2].replace('+', '') !== match[1]) return null;
  return [match[1], position];
}

export class StressIndexBuilder {
  constructor(capacity = 1 << 16) {
    this.keys = new Uint32Array(capacity);
    this.values = new Uint16Array(capacity);
    this.count = 0;
  }

  add(word, position) {
    if (this.count === this.keys.length) {
      const keys = new Uint32Array(this.keys.length * 2);
      const values = new Uint16Array(this.values.length * 2);
      keys.set(this.keys);
      values.set(this.values);
      this.keys = keys;
      this.values = values;
    }
    const [key, check] = hashWord(word);
    this.keys[this.count] = key;
    this.values[this.count] = (check << 8) | position;
    this.count += 1;
  }

  /** Строки словаря по одной — из потока распаковки. */
  addLine(line) {
    const entry = parseAccentLine(line);
    if (entry) this.add(entry[0], entry[1]);
  }

  /** @returns {ArrayBuffer} заголовок, ключи по возрастанию, значения */
  finish() {
    const { count } = this;
    // Ключ и значение в одном числе: сортировка типизированного массива
    // быстрая и не тащит пары за собой. 32 + 16 бит < 2⁵³ — точно.
    const packed = new Float64Array(count);
    for (let i = 0; i < count; i += 1) packed[i] = this.keys[i] * 65536 + this.values[i];
    packed.sort();
    const buffer = new ArrayBuffer(HEADER_BYTES + count * 6);
    const header = new Uint32Array(buffer, 0, 3);
    header.set([MAGIC, VERSION, count]);
    const keys = new Uint32Array(buffer, HEADER_BYTES, count);
    const values = new Uint16Array(buffer, HEADER_BYTES + count * 4, count);
    for (let i = 0; i < count; i += 1) {
      keys[i] = Math.floor(packed[i] / 65536);
      values[i] = packed[i] % 65536;
    }
    return buffer;
  }
}

/**
 * Построить индекс из потока строк словаря (уже распакованного).
 * @param {AsyncIterable<string>|Iterable<string>} lines
 */
export async function buildStressIndex(lines) {
  const builder = new StressIndexBuilder(1 << 20);
  for await (const line of lines) builder.addLine(line);
  return builder.finish();
}

/** Текстовый поток → строки, без накопления всего текста в памяти. */
export async function* splitLines(chunks) {
  let rest = '';
  for await (const chunk of chunks) {
    const lines = (rest + chunk).split('\n');
    rest = lines.pop();
    yield* lines;
  }
  if (rest) yield rest;
}

export class StressIndex {
  constructor(buffer) {
    const [magic, version, count] = new Uint32Array(buffer, 0, 3);
    if (magic !== MAGIC || version !== VERSION) throw new Error('Словарь ударений повреждён — скачайте голос заново');
    this.keys = new Uint32Array(buffer, HEADER_BYTES, count);
    this.values = new Uint16Array(buffer, HEADER_BYTES + count * 4, count);
  }

  get size() {
    return this.keys.length;
  }

  /** @returns {number} номер буквы под ударением или -1, если слова нет */
  lookup(word) {
    const [key, check] = hashWord(word);
    const { keys, values } = this;
    let low = 0;
    let high = keys.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (keys[middle] < key) low = middle + 1;
      else high = middle;
    }
    for (let i = low; i < keys.length && keys[i] === key; i += 1) {
      if (values[i] >>> 8 === check) return values[i] & 0xff;
    }
    return -1;
  }

  /** Слово с «+» перед ударной буквой, как в исходном словаре; null — нет в словаре. */
  accent(word) {
    const position = this.lookup(word);
    if (position < 0 || position >= word.length) return null;
    return `${word.slice(0, position)}+${word.slice(position)}`;
  }
}
