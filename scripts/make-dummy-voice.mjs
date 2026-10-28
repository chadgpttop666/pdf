// Крошечная ONNX-модель с входами и выходом как у голоса Piper — для
// сквозного теста: настоящие голоса весят по 60 МБ и лежат на HuggingFace.
// Модель превращает номера фонем в «звук» (каждый номер × 0.01, повторённый
// 400 раз), этого хватает, чтобы проверить всю цепочку: загрузку голоса,
// фонемизатор, ONNX Runtime, воспроизведение и подсветку.
//
// Протобуф собираем вручную: сообщений всего несколько, тащить ради них
// зависимость незачем. Номера полей — из onnx.proto.
import { writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const out = join(root, 'tests', 'fixtures');

const FLOAT = 1;
const INT64 = 7;
const ATTRIBUTE_INT = 2;

function varint(value) {
  const bytes = [];
  let n = BigInt(value);
  do {
    let byte = Number(n & 0x7fn);
    n >>= 7n;
    if (n) byte |= 0x80;
    bytes.push(byte);
  } while (n);
  return Buffer.from(bytes);
}

const key = (field, wire) => varint((field << 3) | wire);
const int = (field, value) => Buffer.concat([key(field, 0), varint(value)]);
const bytes = (field, payload) => Buffer.concat([key(field, 2), varint(payload.length), payload]);
const str = (field, text) => bytes(field, Buffer.from(text, 'utf8'));
const message = (...parts) => Buffer.concat(parts);

function floats(values) {
  const buffer = Buffer.alloc(values.length * 4);
  values.forEach((value, i) => buffer.writeFloatLE(value, i * 4));
  return buffer;
}

const dim = (value) => (typeof value === 'number' ? bytes(1, int(1, value)) : bytes(1, str(2, value)));

function valueInfo(name, elemType, dims) {
  const shape = message(...dims.map(dim));
  const tensorType = message(int(1, elemType), bytes(2, shape));
  return message(str(1, name), bytes(2, bytes(1, tensorType)));
}

function node(opType, inputs, outputs, attributes = []) {
  return message(...inputs.map((name) => str(1, name)), ...outputs.map((name) => str(2, name)), str(4, opType), ...attributes);
}

const castTo = bytes(5, message(str(1, 'to'), int(3, FLOAT), int(20, ATTRIBUTE_INT)));
const scale = message(int(2, FLOAT), bytes(4, floats([0.01])), str(8, 'k')); // скаляр 0.01
const repeats = message(int(1, 2), int(2, INT64), bytes(7, Buffer.concat([varint(1), varint(400)])), str(8, 'r'));

const graph = message(
  bytes(1, node('Cast', ['input'], ['x'], [castTo])),
  bytes(1, node('Mul', ['x', 'k'], ['y'])),
  bytes(1, node('Tile', ['y', 'r'], ['output'])),
  str(2, 'piper-dummy'),
  bytes(5, scale),
  bytes(5, repeats),
  bytes(11, valueInfo('input', INT64, [1, 'phonemes'])),
  bytes(11, valueInfo('input_lengths', INT64, [1])),
  bytes(11, valueInfo('scales', FLOAT, [3])),
  bytes(12, valueInfo('output', FLOAT, [1, 'samples']))
);

const model = message(int(1, 8), str(2, 'pdf-reader-test'), bytes(7, graph), bytes(8, message(str(1, ''), int(2, 17))));

const config = {
  dataset: 'dummy',
  audio: { sample_rate: 22050, quality: 'test' },
  espeak: { voice: 'ru' },
  language: { code: 'ru_RU' },
  inference: { noise_scale: 0.667, length_scale: 1, noise_w: 0.8 },
  num_speakers: 1,
  speaker_id_map: {},
};

await writeFile(join(out, 'piper-dummy.onnx'), model);
await writeFile(join(out, 'piper-dummy.onnx.json'), `${JSON.stringify(config, null, 2)}\n`);
console.log(`tests/fixtures/piper-dummy.onnx: ${model.length} байт`);
