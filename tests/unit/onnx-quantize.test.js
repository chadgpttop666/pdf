import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import * as ort from 'onnxruntime-web';
import { quantizeModel, quantizeWeights } from '../../extension/src/tts/onnx-quantize.js';
import { FLOAT, INT64, attribute, bytes, int, message, model, node, str, tensor, valueInfo } from '../../scripts/onnx-proto.mjs';

ort.env.wasm.numThreads = 1;

const BOOL = 9;
const random = (count, seed = 1) => {
  let state = seed;
  return Array.from({ length: count }, () => {
    state = (state * 1103515245 + 12345) % 2147483648;
    return state / 2147483648 - 0.5;
  });
};

async function run(bytesOfModel, feeds) {
  const session = await ort.InferenceSession.create(new Uint8Array(bytesOfModel));
  const result = await session.run(feeds);
  return Object.fromEntries(Object.entries(result).map(([name, value]) => [name, Array.from(value.data, Number)]));
}

const snr = (reference, test) => {
  const signal = reference.reduce((sum, v) => sum + v * v, 0);
  const noise = reference.reduce((sum, v, i) => sum + (v - test[i]) ** 2, 0);
  return 10 * Math.log10(signal / noise);
};

/** Как сэмплер TeraTTS: свёртка 1×1 со смещением, глубинная свёртка, MatMul и Gemm с transB. */
function convNet() {
  return model({
    name: 'net',
    nodes: [
      node('Conv', ['x', 'pw.weight', 'pw.bias'], ['y1'], [attribute('kernel_shape', [1])]),
      node('Conv', ['y1', 'dw.weight'], ['y2'], [attribute('group', 16), attribute('kernel_shape', [3]), attribute('pads', [1, 1])]),
      node('Transpose', ['y2'], ['t'], [attribute('perm', [0, 2, 1])]),
      node('MatMul', ['t', 'proj.weight'], ['z']),
      node('Reshape', ['z', 'flat'], ['z2']),
      node('Gemm', ['z2', 'mlp.weight', 'mlp.bias'], ['out'], [attribute('transB', 1)]),
    ],
    initializers: [
      tensor('pw.weight', FLOAT, [16, 8, 1], random(128, 2)),
      tensor('pw.bias', FLOAT, [16], random(16, 3)),
      tensor('dw.weight', FLOAT, [16, 1, 3], random(48, 4)),
      tensor('proj.weight', FLOAT, [16, 4], random(64, 5)),
      tensor('flat', INT64, [2], [5, 4]),
      tensor('mlp.weight', FLOAT, [3, 4], random(12, 6)),
      tensor('mlp.bias', FLOAT, [3], random(3, 7)),
    ],
    inputs: [['x', FLOAT, [1, 8, 5]]],
    outputs: [['out', FLOAT, [5, 3]]],
  });
}

/** Цикл, как у сэмплера: sampler_trip_count шагов по 1/total_step. */
function loopNet() {
  const valueTensor = message(int(1, 1), int(2, FLOAT), bytes(4, Buffer.from(new Float32Array([8]).buffer)));
  const constantOfShape = bytes(
    1,
    message(str(1, 'one_shape'), str(2, 'total_step'), str(4, 'ConstantOfShape'), bytes(5, message(str(1, 'value'), bytes(5, valueTensor), int(20, 4))))
  );
  const body = message(
    constantOfShape,
    node('Reciprocal', ['total_step'], ['step']),
    node('Add', ['x_in', 'step'], ['x_out']),
    node('Add', ['n_in', 'one'], ['n_out']),
    node('Identity', ['cond_in'], ['cond_out']),
    str(2, 'body'),
    tensor('one_shape', INT64, [1], [1]),
    tensor('one', FLOAT, [1], [1]),
    ...[
      ['iteration', INT64, []],
      ['cond_in', BOOL, []],
      ['x_in', FLOAT, [1]],
      ['n_in', FLOAT, [1]],
    ].map((spec) => bytes(11, valueInfo(...spec))),
    ...[
      ['cond_out', BOOL, []],
      ['x_out', FLOAT, [1]],
      ['n_out', FLOAT, [1]],
    ].map((spec) => bytes(12, valueInfo(...spec)))
  );
  const loop = bytes(
    1,
    message(
      ...['sampler_trip_count', '', 'x', 'n'].map((name) => str(1, name)),
      ...['x_final', 'n_final'].map((name) => str(2, name)),
      str(4, 'Loop'),
      bytes(5, message(str(1, 'body'), bytes(6, body), int(20, 5)))
    )
  );
  return model({
    name: 'loop',
    nodes: [loop],
    initializers: [tensor('sampler_trip_count', INT64, [], [8])],
    inputs: [
      ['x', FLOAT, [1]],
      ['n', FLOAT, [1]],
    ],
    outputs: [
      ['x_final', FLOAT, [1]],
      ['n_final', FLOAT, [1]],
    ],
  });
}

/** int8-тензор (как в сжатой модели омографов): raw_data. */
const int8Tensor = (name, dims, values) =>
  bytes(5, message(...dims.map((dim) => int(1, dim)), int(2, 3), bytes(9, Buffer.from(Int8Array.from(values).buffer)), str(8, name)));

/** Веса int8 «только веса», как у модели омографов: Cast → Mul(масштаб) → MatMul / Gather. */
function int8Net() {
  const q = (count, seed) => random(count, seed).map((v) => Math.round(v * 254));
  return model({
    name: 'int8',
    nodes: [
      node('Cast', ['table_q'], ['table_f'], [attribute('to', FLOAT)]),
      node('Mul', ['table_f', 'table_scale'], ['table']),
      node('Gather', ['table', 'ids'], ['emb']),
      node('Cast', ['w_q'], ['w_f'], [attribute('to', FLOAT)]),
      node('Mul', ['w_f', 'w_scale'], ['w']),
      node('MatMul', ['emb', 'w'], ['out']),
    ],
    initializers: [
      int8Tensor('table_q', [6, 4], q(24, 11)),
      tensor('table_scale', FLOAT, [6, 1], random(6, 12).map((v) => 0.01 + Math.abs(v) / 50)),
      int8Tensor('w_q', [4, 3], q(12, 13)),
      tensor('w_scale', FLOAT, [1, 3], random(3, 14).map((v) => 0.01 + Math.abs(v) / 50)),
    ],
    inputs: [['ids', INT64, [1, 5]]],
    outputs: [['out', FLOAT, [1, 5, 3]]],
  });
}

describe('быстрая версия ONNX-модели (onnx-quantize.js)', () => {
  it('веса в uint8: ноль представим точно, ошибка не больше половины шага', () => {
    const values = Float32Array.from([-0.5, -0.1, 0, 0.2, 0.75]);
    const { quantized, scale, zeroPoint } = quantizeWeights(values);
    assert.equal(quantized[2], zeroPoint);
    values.forEach((value, i) => assert.ok(Math.abs((quantized[i] - zeroPoint) * scale - value) <= scale / 2 + 1e-7));
  });

  it('поточечная свёртка, MatMul и Gemm — в целых числах, глубинная свёртка — нет; результат почти тот же', async () => {
    const source = convNet();
    const { model: fast, quantized } = quantizeModel(new Uint8Array(source));
    assert.equal(quantized, 3);
    const text = new TextDecoder().decode(fast);
    assert.ok(text.includes('ConvInteger') && text.includes('MatMulInteger'));
    // Исходные float-веса заменённых узлов из модели убраны, глубинной свёртки — на месте.
    assert.ok(!text.includes('pw.weight\u0012') && text.includes('dw.weight'));
    const x = new ort.Tensor('float32', Float32Array.from(random(40, 9)), [1, 8, 5]);
    const reference = (await run(source, { x })).out;
    const test = (await run(fast, { x })).out;
    assert.ok(snr(reference, test) > 25, `SNR ${snr(reference, test).toFixed(1)} дБ`);
  });

  it('dynamic: false — веса не трогаются (только шаги цикла)', () => {
    const source = new Uint8Array(convNet());
    const { model: same, quantized } = quantizeModel(source, { dynamic: false });
    assert.equal(quantized, 0);
    assert.equal(same.length, source.length);
  });

  it('узлы из исключений не трогаются', () => {
    const { quantized } = quantizeModel(new Uint8Array(convNet()), { exclude: (name) => name === '' });
    assert.equal(quantized, 0);
  });

  it('число шагов цикла: и счётчик, и размер шага внутри', async () => {
    const source = loopNet();
    const feeds = { x: new ort.Tensor('float32', Float32Array.of(0), [1]), n: new ort.Tensor('float32', Float32Array.of(0), [1]) };
    const before = await run(source, feeds);
    assert.deepEqual([before.n_final[0], Math.round(before.x_final[0] * 1e5) / 1e5], [8, 1]);
    const after = await run(quantizeModel(new Uint8Array(source), { steps: 6 }).model, feeds);
    assert.deepEqual([after.n_final[0], Math.round(after.x_final[0] * 1e5) / 1e5], [6, 1]);
    // Только шаги, без перевода весов в 8 бит.
    const stepsOnly = quantizeModel(new Uint8Array(source), { steps: 3, dynamic: false });
    assert.equal(stepsOnly.quantized, 0);
    const third = await run(stepsOnly.model, feeds);
    assert.deepEqual([third.n_final[0], Math.round(third.x_final[0] * 1e5) / 1e5], [3, 1]);
  });

  it('int8-веса остаются int8: MatMul и Gather — по целым, результат почти тот же', async () => {
    const source = int8Net();
    const { model: fast, quantized } = quantizeModel(new Uint8Array(source), { int8Weights: true });
    assert.equal(quantized, 2);
    const text = new TextDecoder().decode(fast);
    assert.ok(text.includes('MatMulInteger') && !text.includes('w_f'), 'развёртка весов в float убрана');
    const ids = new ort.Tensor('int64', BigInt64Array.from([0, 3, 5, 1, 2], BigInt), [1, 5]);
    const reference = (await run(source, { ids })).out;
    const test = (await run(fast, { ids })).out;
    assert.ok(snr(reference, test) > 25, `SNR ${snr(reference, test).toFixed(1)} дБ`);
  });
});
