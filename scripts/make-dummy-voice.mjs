// Крошечная ONNX-модель с входами и выходом как у голоса Piper — для
// сквозного теста: настоящие голоса весят по 60 МБ и лежат на HuggingFace.
// Модель превращает номера фонем в «звук» (каждый номер × 0.01, повторённый
// 400 раз), этого хватает, чтобы проверить всю цепочку: загрузку голоса,
// фонемизатор, ONNX Runtime, воспроизведение и подсветку.
import { writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FLOAT, INT64, attribute, model, node, tensor } from './onnx-proto.mjs';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const out = join(root, 'tests', 'fixtures');

const voice = model({
  name: 'piper-dummy',
  opset: 17,
  nodes: [
    node('Cast', ['input'], ['x'], [attribute('to', FLOAT)]),
    node('Mul', ['x', 'k'], ['y']),
    node('Tile', ['y', 'r'], ['output']),
  ],
  initializers: [tensor('k', FLOAT, [], [0.01]), tensor('r', INT64, [2], [1, 400])],
  inputs: [
    ['input', INT64, [1, 'phonemes']],
    ['input_lengths', INT64, [1]],
    ['scales', FLOAT, [3]],
  ],
  outputs: [['output', FLOAT, [1, 'samples']]],
});

const config = {
  dataset: 'dummy',
  audio: { sample_rate: 22050, quality: 'test' },
  espeak: { voice: 'ru' },
  language: { code: 'ru_RU' },
  inference: { noise_scale: 0.667, length_scale: 1, noise_w: 0.8 },
  num_speakers: 1,
  speaker_id_map: {},
};

await writeFile(join(out, 'piper-dummy.onnx'), voice);
await writeFile(join(out, 'piper-dummy.onnx.json'), `${JSON.stringify(config, null, 2)}\n`);
console.log(`tests/fixtures/piper-dummy.onnx: ${voice.length} байт`);
