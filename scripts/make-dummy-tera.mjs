// Пакет-пустышка TeraTTS для сквозного теста: настоящий весит 520 МБ. Те
// же файлы, те же входы и выходы моделей, но внутри — пара умножений:
//   • text_encoder, sampler — маска × константа нужной формы;
//   • duration_predictor — 0,06 с на символ;
//   • vocoder — синус 220 Гц на каждый кадр (3072 отсчёта);
//   • нейросети ударений — нули: «ё» не нужна, омограф — первый вариант,
//     незнакомое слово — без ударения.
// Этого хватает, чтобы проверить всю цепочку: скачивание с прогрессом,
// индекс словаря, загрузку в воркеры, конвейер, звук и подсветку.
//
// Тест подменяет ответы HuggingFace этими файлами (по окончанию адреса).
// Запуск напрямую печатает список файлов.
import { gzipSync } from 'node:zlib';
import { FLOAT, INT64, attribute, model, node, tensor } from './onnx-proto.mjs';

const SAMPLES_PER_FRAME = 3072;

const textEncoder = model({
  name: 'tera-text-encoder',
  nodes: [node('Mul', ['text_mask', 'ones'], ['text_emb'])],
  initializers: [tensor('ones', FLOAT, [1, 256, 1], new Array(256).fill(1))],
  inputs: [
    ['text_ids', INT64, [1, 'T']],
    ['style_ttl', FLOAT, [1, 50, 256]],
    ['text_mask', FLOAT, [1, 1, 'T']],
  ],
  outputs: [['text_emb', FLOAT, [1, 256, 'T']]],
});

const duration = model({
  name: 'tera-duration',
  nodes: [node('ReduceSum', ['text_mask', 'axes'], ['chars'], [attribute('keepdims', 0)]), node('Mul', ['chars', 'perChar'], ['duration'])],
  initializers: [tensor('axes', INT64, [2], [1, 2]), tensor('perChar', FLOAT, [], [0.06])],
  inputs: [
    ['text_ids', INT64, [1, 'T']],
    ['style_dp', FLOAT, [1, 8, 16]],
    ['text_mask', FLOAT, [1, 1, 'T']],
  ],
  outputs: [['duration', FLOAT, [1]]],
});

const sampler = model({
  name: 'tera-sampler',
  nodes: [node('Mul', ['latent_mask', 'level'], ['latent'])],
  initializers: [tensor('level', FLOAT, [1, 144, 1], new Array(144).fill(0.1))],
  inputs: [
    ['initial_latent', FLOAT, [1, 144, 'L']],
    ['text_emb', FLOAT, [1, 256, 'T']],
    ['style_ttl', FLOAT, [1, 50, 256]],
    ['latent_mask', FLOAT, [1, 1, 'L']],
    ['text_mask', FLOAT, [1, 1, 'T']],
    ['guidance', FLOAT, [1]],
  ],
  outputs: [['latent', FLOAT, [1, 144, 'L']]],
});

const tone = Array.from({ length: SAMPLES_PER_FRAME }, (_, i) => Math.sin((2 * Math.PI * 220 * i) / 44100) * 5);
const vocoder = model({
  name: 'tera-vocoder',
  nodes: [
    node('ReduceMean', ['latent'], ['level'], [attribute('axes', [1]), attribute('keepdims', 1)]),
    node('Transpose', ['level'], ['column'], [attribute('perm', [0, 2, 1])]),
    node('Mul', ['column', 'tone'], ['frames']),
    node('Reshape', ['frames', 'flat'], ['wav_tts']),
  ],
  initializers: [tensor('tone', FLOAT, [1, 1, SAMPLES_PER_FRAME], tone), tensor('flat', INT64, [2], [1, -1])],
  inputs: [['latent', FLOAT, [1, 144, 'L']]],
  outputs: [['wav_tts', FLOAT, [1, 'samples']]],
});

/** Логиты [1, T, 3] с победой нулевого класса — «ничего не делать». */
function tokenClassifier(name, extraInputs = []) {
  return model({
    name,
    nodes: [
      node('Cast', ['attention_mask'], ['mask'], [attribute('to', FLOAT)]),
      node('Unsqueeze', ['mask', 'axis'], ['column']),
      node('Mul', ['column', 'classes'], ['logits']),
    ],
    initializers: [tensor('axis', INT64, [1], [2]), tensor('classes', FLOAT, [3], [1, 0, 0])],
    inputs: [['input_ids', INT64, [1, 'T']], ['attention_mask', INT64, [1, 'T']], ...extraInputs],
    outputs: [['logits', FLOAT, [1, 'T', 3]]],
  });
}

const omograph = model({
  name: 'ruaccent-omograph',
  nodes: [
    node('Cast', ['attention_mask'], ['mask'], [attribute('to', FLOAT)]),
    node('ReduceSum', ['mask', 'axis'], ['length'], [attribute('keepdims', 1)]),
    node('Mul', ['length', 'weights'], ['logits']),
  ],
  initializers: [tensor('axis', INT64, [1], [1]), tensor('weights', FLOAT, [2], [0, 0])],
  inputs: [
    ['input_ids', INT64, [1, 'T']],
    ['attention_mask', INT64, [1, 'T']],
  ],
  outputs: [['logits', FLOAT, [1, 2]]],
});

function wordPieceTokenizer(words) {
  const special = ['[PAD]', '[UNK]', '[CLS]', '[SEP]'];
  const vocab = Object.fromEntries([...special, ...words].map((token, i) => [token, i]));
  const added = special.map((content, id) => ({ id, content, single_word: false, lstrip: false, rstrip: false, normalized: false, special: true }));
  const sep = (typeId) => ({ SpecialToken: { id: '[SEP]', type_id: typeId } });
  return {
    version: '1.0',
    truncation: null,
    padding: null,
    added_tokens: added,
    normalizer: { type: 'BertNormalizer', clean_text: true, handle_chinese_chars: true, strip_accents: null, lowercase: false },
    pre_tokenizer: { type: 'BertPreTokenizer' },
    post_processor: {
      type: 'TemplateProcessing',
      single: [{ SpecialToken: { id: '[CLS]', type_id: 0 } }, { Sequence: { id: 'A', type_id: 0 } }, sep(0)],
      pair: [{ SpecialToken: { id: '[CLS]', type_id: 0 } }, { Sequence: { id: 'A', type_id: 0 } }, sep(0), { Sequence: { id: 'B', type_id: 1 } }, sep(1)],
      special_tokens: { '[CLS]': { id: '[CLS]', ids: [2], tokens: ['[CLS]'] }, '[SEP]': { id: '[SEP]', ids: [3], tokens: ['[SEP]'] } },
    },
    decoder: { type: 'WordPiece', prefix: '##', cleanup: true },
    model: { type: 'WordPiece', unk_token: '[UNK]', continuing_subword_prefix: '##', max_input_chars_per_word: 100, vocab },
  };
}

const tokenizerConfig = { cls_token: '[CLS]', sep_token: '[SEP]', unk_token: '[UNK]', pad_token: '[PAD]', do_lower_case: false, tokenizer_class: 'BertTokenizer' };
const labels = (names) => ({ id2label: Object.fromEntries(names.map((name, i) => [String(i), name])) });

/** Словарь в том виде, как у RUAccent: JSON с записью на строку, gzip. */
const gzJson = (object) => gzipSync(`{\n${Object.entries(object).map(([k, v]) => ` ${JSON.stringify(k)}: ${JSON.stringify(v)}`).join(',\n')}\n}`);

// Словарь символов модели: русские и латинские буквы, знаки, «+» и
// комбинируемые знаки (NFKD); остальное — -1.
const table = new Array(65536).fill(-1);
let next = 1;
for (const range of [[0x20, 0x7e], [0xa0, 0xff], [0x300, 0x36f], [0x400, 0x45f], [0x2010, 0x2026]]) {
  for (let code = range[0]; code <= range[1]; code += 1) table[code] = next++;
}

function npy(shape) {
  const header = `{'descr': '<f4', 'fortran_order': False, 'shape': (${shape.join(', ')}), }`;
  const padded = `${header.padEnd(117, ' ')}\n`;
  const count = shape.reduce((a, b) => a * b, 1);
  const out = Buffer.alloc(10 + padded.length + count * 4);
  out.set([0x93, ...Buffer.from('NUMPY'), 1, 0]);
  out.writeUInt16LE(padded.length, 8);
  out.write(padded, 10, 'latin1');
  return out;
}

const json = (object) => Buffer.from(JSON.stringify(object));

/** Окончание адреса HuggingFace → содержимое файла. */
export function dummyTeraFiles() {
  const files = {
    'models/text_encoder.onnx': textEncoder,
    'models/duration_predictor.onnx': duration,
    'models/sampler_distilled_cfg3_8step.onnx': sampler,
    'models/vocoder.onnx': vocoder,
    'unicode_indexer.json': json(table),
    'dictionary/accents.json.gz': gzJson({ сегодня: 'сег+одня', журналы: 'журн+алы', нашем: 'н+ашем', есть: '+есть', такие: 'так+ие' }),
    'dictionary/yo_words.json.gz': gzJson({ еще: 'ещё' }),
    'dictionary/yo_homographs.json.gz': gzJson({ все: 'всё' }),
    'dictionary/omographs.json.gz': gzJson({ замок: ['з+амок', 'зам+ок'] }),
    'nn_accent/model.onnx': tokenClassifier('ruaccent-accent', [['token_type_ids', INT64, [1, 'T']]]),
    'nn_accent/vocab.txt': Buffer.from(['[pad]', '[unk]', '[bos]', '[eos]', ...'абвгдеёжзийклмнопрстуфхцчшщъыьэюя'].join('\n')),
    'nn_accent/config.json': json(labels(['NO', 'STRESS_PRIMARY', 'STRESS_SECONDARY'])),
    'nn_yo_homograph_resolver/model.onnx': tokenClassifier('ruaccent-yo'),
    'nn_yo_homograph_resolver/tokenizer.json': json(wordPieceTokenizer(['все', 'это', 'было', 'зря'])),
    'nn_yo_homograph_resolver/tokenizer_config.json': json(tokenizerConfig),
    'nn_yo_homograph_resolver/config.json': json(labels(['NO_YO', 'PUNCT', 'YO'])),
    'turbo3.1/model.onnx': omograph,
    'turbo3.1/tokenizer.json': json(wordPieceTokenizer(['замок', 'з', '##амок'])),
    'turbo3.1/tokenizer_config.json': json(tokenizerConfig),
  };
  for (const voice of ['ru_m5', 'ru_f1', 'ru_m1', 'ru_f2']) {
    files[`styles/${voice}/style_ttl.npy`] = npy([1, 50, 256]);
    files[`styles/${voice}/style_dp.npy`] = npy([1, 8, 16]);
  }
  return files;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  for (const [name, content] of Object.entries(dummyTeraFiles())) console.log(`${name}: ${content.length} байт`);
}
