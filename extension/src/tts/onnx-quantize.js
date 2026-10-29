// Быстрая версия ONNX-модели TeraTTS — делается прямо в браузере из
// скачанной исходной, без отдельного хостинга и повторной загрузки.
//
// Веса поточечных свёрток (1×1), MatMul и Gemm переводятся в uint8, вход
// квантуется на лету (DynamicQuantizeLinear) — так же, как это делает
// onnxruntime.quantization.quantize_dynamic, только избирательно:
// глубинные свёртки (по каналу, ядро 5–7) остаются во float. Их квантование
// и портит звук (у вокодера SNR падал до −1 дБ, пропадали высокие частоты),
// и не ускоряет — ConvInteger для них медленнее обычной свёртки.
//
// Веса, уже хранящиеся в int8 «только веса» (Cast(int8) → Mul(масштаб) —
// так сжата модель омографов RUAccent), onnxruntime при загрузке
// разворачивает в fp32 и держит в памяти вчетверо больше: воркер ударений
// занимал 1,1 ГБ. Режим int8Weights переписывает их потребителей на целые
// числа (MatMulInteger, Gather по int8-таблице), и веса остаются int8.
//
// Сэмплеру можно задать число шагов потока: модель — цикл из 8 шагов Эйлера
// (sampler_trip_count и total_step внутри цикла). 6 шагов — на четверть
// меньше работы, на слух и для распознавания речи разницы нет.
//
// Замеры (Chromium, WASM, один поток): работа процессора на секунду речи
// 1,16 с → 0,60 с, память воркера сэмплера ≈ втрое меньше.
//
// Протобуф разбирается и собирается вручную: нужно всего несколько
// сообщений onnx.proto, а неизменённые части копируются байт в байт.

const FLOAT = 1;
const UINT8 = 2;
const INT8 = 3;
const INT64 = 7;
const ATTRIBUTE_INT = 2;
const ATTRIBUTE_TENSOR = 4;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

// ── Протобуф ──────────────────────────────────────────────────────────

function readVarint(buf, pos) {
  let value = 0;
  let scale = 1;
  let byte;
  do {
    byte = buf[pos++];
    value += (byte & 0x7f) * scale;
    scale *= 128;
  } while (byte & 0x80);
  return [value, pos];
}

/** Поля сообщения: номер, тип и место в буфере (вместе с ключом — для копирования как есть). */
function fields(buf, start = 0, end = buf.length) {
  const out = [];
  let pos = start;
  while (pos < end) {
    const keyStart = pos;
    let key;
    [key, pos] = readVarint(buf, pos);
    const field = Math.floor(key / 8);
    const wire = key % 8;
    if (wire === 0) {
      const valueStart = pos;
      let value;
      [value, pos] = readVarint(buf, pos);
      out.push({ field, wire, keyStart, start: valueStart, end: pos, value });
    } else if (wire === 2) {
      let length;
      [length, pos] = readVarint(buf, pos);
      out.push({ field, wire, keyStart, start: pos, end: pos + length });
      pos += length;
    } else if (wire === 5 || wire === 1) {
      const size = wire === 5 ? 4 : 8;
      out.push({ field, wire, keyStart, start: pos, end: pos + size });
      pos += size;
    } else {
      throw new Error(`Неизвестный тип поля протобуфа: ${wire}`);
    }
  }
  return out;
}

const text = (buf, f) => decoder.decode(buf.subarray(f.start, f.end));
const raw = (buf, f) => buf.subarray(f.keyStart, f.end);

function varintBytes(value) {
  const out = [];
  let n = value;
  while (n >= 0x80) {
    out.push((n % 128) | 0x80);
    n = Math.floor(n / 128);
  }
  out.push(n);
  return out;
}

function concat(parts) {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

const key = (field, wire) => varintBytes(field * 8 + wire);
const lengthField = (field, payload) => concat([Uint8Array.from(key(field, 2)), Uint8Array.from(varintBytes(payload.length)), payload]);
const intField = (field, value) => Uint8Array.from([...key(field, 0), ...varintBytes(value)]);
const stringField = (field, value) => lengthField(field, encoder.encode(value));

// ── Сообщения onnx.proto ──────────────────────────────────────────────

function tensorProto(name, dataType, dims, data) {
  return concat([...dims.map((dim) => intField(1, dim)), intField(2, dataType), stringField(8, name), lengthField(9, data)]);
}

function intAttribute(name, value) {
  return concat([stringField(1, name), intField(3, value), intField(20, ATTRIBUTE_INT)]);
}

function tensorAttribute(name, tensor) {
  return concat([stringField(1, name), lengthField(5, tensor), intField(20, ATTRIBUTE_TENSOR)]);
}

/** NodeProto; attributes — готовые байты AttributeProto. */
function nodeProto(opType, inputs, outputs, name, attributes = []) {
  return concat([
    ...inputs.map((input) => stringField(1, input)),
    ...outputs.map((output) => stringField(2, output)),
    stringField(3, name),
    stringField(4, opType),
    ...attributes.map((attribute) => lengthField(5, attribute)),
  ]);
}

function parseNode(buf, f) {
  const node = { inputs: [], outputs: [], name: '', opType: '', attributes: [], bytes: raw(buf, f), start: f.start, end: f.end };
  for (const field of fields(buf, f.start, f.end)) {
    if (field.field === 1) node.inputs.push(text(buf, field));
    else if (field.field === 2) node.outputs.push(text(buf, field));
    else if (field.field === 3) node.name = text(buf, field);
    else if (field.field === 4) node.opType = text(buf, field);
    else if (field.field === 5) node.attributes.push(parseAttribute(buf, field));
  }
  return node;
}

function parseAttribute(buf, f) {
  const attribute = { name: '', start: f.start, end: f.end, ints: [], int: null, float: null, graph: null, tensor: null };
  for (const field of fields(buf, f.start, f.end)) {
    if (field.field === 1) attribute.name = text(buf, field);
    else if (field.field === 2) attribute.float = new DataView(buf.buffer, buf.byteOffset + field.start, 4).getFloat32(0, true);
    else if (field.field === 3) attribute.int = field.value;
    else if (field.field === 5) attribute.tensor = field;
    else if (field.field === 6) attribute.graph = field;
    else if (field.field === 8) {
      if (field.wire === 0) attribute.ints.push(field.value);
      else for (let pos = field.start; pos < field.end; ) [attribute.ints[attribute.ints.length], pos] = readVarint(buf, pos);
    }
  }
  return attribute;
}

const attributeOf = (node, name) => node.attributes.find((attribute) => attribute.name === name);

function parseTensor(buf, f) {
  const tensor = { name: '', dims: [], dataType: 0, raw: null, floats: null, bytes: raw(buf, f) };
  for (const field of fields(buf, f.start, f.end)) {
    if (field.field === 1) {
      if (field.wire === 0) tensor.dims.push(field.value);
      else for (let pos = field.start; pos < field.end; ) [tensor.dims[tensor.dims.length], pos] = readVarint(buf, pos);
    } else if (field.field === 2) tensor.dataType = field.value;
    else if (field.field === 8) tensor.name = text(buf, field);
    else if (field.field === 9) tensor.raw = field;
    else if (field.field === 4) tensor.floats = field;
  }
  return tensor;
}

/** Значения float-тензора (копия: в буфере модели они могут лежать невыровненно). */
function floatValues(buf, tensor) {
  if (tensor.dataType !== FLOAT) return null;
  if (tensor.raw) return new Float32Array(buf.slice(tensor.raw.start, tensor.raw.end).buffer);
  if (tensor.floats?.wire === 2) return new Float32Array(buf.slice(tensor.floats.start, tensor.floats.end).buffer);
  return null;
}

// ── Квантование ───────────────────────────────────────────────────────

/** uint8 с нулевой точкой: диапазон всегда включает ноль (как в onnxruntime). */
export function quantizeWeights(values) {
  let min = 0;
  let max = 0;
  for (const value of values) {
    if (value < min) min = value;
    if (value > max) max = value;
  }
  const scale = (max - min) / 255 || 1;
  const zeroPoint = Math.min(255, Math.max(0, Math.round(-min / scale)));
  const quantized = new Uint8Array(values.length);
  for (let i = 0; i < values.length; i += 1) quantized[i] = Math.min(255, Math.max(0, Math.round(values[i] / scale) + zeroPoint));
  return { quantized, scale, zeroPoint };
}

const floatBytes = (values) => new Uint8Array(Float32Array.from(values).buffer);
const int64Bytes = (value) => {
  const out = new Uint8Array(8);
  new DataView(out.buffer).setBigInt64(0, BigInt(value), true);
  return out;
};

/** [K, N] из [N, K] — веса Gemm с transB. */
function transpose(values, rows, cols) {
  const out = new Float32Array(values.length);
  for (let r = 0; r < rows; r += 1) for (let c = 0; c < cols; c += 1) out[c * rows + r] = values[r * cols + c];
  return out;
}

/**
 * Быстрая версия модели.
 * @param model Uint8Array — исходный ModelProto
 * @param options.steps число шагов цикла сэмплера (sampler_trip_count и total_step)
 * @param options.exclude (имя узла) => true — не трогать этот узел
 * @param options.int8Weights только оставить int8-веса int8 (см. начало файла);
 *   float-веса при этом не трогаются
 * @param options.dynamic переводить float-веса в uint8; false — только число шагов
 * @param options.hoist вынести веса из тела цикла в основной граф (см. ниже)
 * @returns {{ model: Uint8Array, quantized: number }}
 */
export function quantizeModel(model, { steps = null, exclude = () => false, int8Weights = false, dynamic = true, hoist = false } = {}) {
  let quantized = 0;
  // Веса сэмплера лежат в теле цикла (Loop), и onnxruntime держит такие в
  // памяти трижды: 244 МБ файла — 750 МБ памяти. Вынесенные в основной граф
  // (тело цикла видит его имена) — 280 МБ, а считается всё то же.
  const hoisted = [];
  const topNames = new Set();

  function rewriteGraph(buf, start, end, isTop) {
    const graphFields = fields(buf, start, end);
    const tensors = new Map();
    for (const f of graphFields) {
      if (f.field === 5) {
        const tensor = parseTensor(buf, f);
        tensors.set(tensor.name, tensor);
      }
    }
    const nodes = graphFields.filter((f) => f.field === 1).map((f) => parseNode(buf, f));
    // Входы графа: инициализатор с тем же именем — значение по умолчанию, его не выносим.
    const inputNames = new Set(graphFields.filter((f) => f.field === 11).map((f) => text(buf, fields(buf, f.start, f.end).find((v) => v.field === 1))));
    if (isTop) {
      for (const name of [...tensors.keys(), ...inputNames]) topNames.add(name);
      for (const node of nodes) for (const name of [...node.inputs, ...node.outputs]) topNames.add(name);
    }
    const canHoist = (name) => hoist && !isTop && !inputNames.has(name) && !topNames.has(name);

    // Сколько узлов этого графа (и вложенных) читают каждый тензор.
    const uses = new Map();
    const countUses = (graphBuf, s, e) => {
      for (const f of fields(graphBuf, s, e)) {
        if (f.field !== 1) continue;
        const node = parseNode(graphBuf, f);
        for (const input of node.inputs) uses.set(input, (uses.get(input) || 0) + 1);
        for (const attribute of node.attributes) if (attribute.graph) countUses(graphBuf, attribute.graph.start, attribute.graph.end);
      }
    };
    countUses(buf, start, end);

    const newTensors = [];
    const replacedUses = new Map();
    const quantizedInputs = new Map(); // вход → [квантованный, масштаб, нулевая точка]
    const nodeBytes = [];
    const unit = (name) => replacedUses.set(name, (replacedUses.get(name) || 0) + 1);

    /** Вход узла в uint8 — один DynamicQuantizeLinear на тензор. */
    function quantizedInput(input, out) {
      if (!quantizedInputs.has(input)) {
        const names = [`${input}::q8`, `${input}::q8_scale`, `${input}::q8_zero`];
        quantizedInputs.set(input, names);
        out.push(nodeProto('DynamicQuantizeLinear', [input], names, `${input}::q8_dql`));
      }
      return quantizedInputs.get(input);
    }

    /** Общий хвост: целое → float, умножить на произведение масштабов, прибавить смещение. */
    function scaleBack(node, integerOutput, inputScale, weightScale, biasName, out) {
      const base = node.name || node.outputs[0];
      const cast = `${base}::q8_float`;
      const scales = `${base}::q8_scales`;
      out.push(nodeProto('Cast', [integerOutput], [cast], `${base}::q8_cast`, [intAttribute('to', FLOAT)]));
      out.push(nodeProto('Mul', [inputScale, weightScale], [scales], `${base}::q8_scales_mul`));
      if (biasName) {
        const scaled = `${base}::q8_scaled`;
        out.push(nodeProto('Mul', [cast, scales], [scaled], `${base}::q8_output_mul`));
        out.push(nodeProto('Add', [scaled, biasName], [node.outputs[0]], `${base}::q8_bias_add`));
      } else {
        out.push(nodeProto('Mul', [cast, scales], [node.outputs[0]], `${base}::q8_output_mul`));
      }
    }

    // Одни и те же веса могут читать несколько узлов — квантуем их один раз.
    const weightsDone = new Map();
    function addWeights(name, values, dims) {
      if (!weightsDone.has(name)) {
        const { quantized: data, scale, zeroPoint } = quantizeWeights(values);
        newTensors.push(tensorProto(`${name}::q8`, UINT8, dims, data));
        newTensors.push(tensorProto(`${name}::q8_scale`, FLOAT, [], floatBytes([scale])));
        newTensors.push(tensorProto(`${name}::q8_zero`, UINT8, [], Uint8Array.of(zeroPoint)));
        weightsDone.set(name, [`${name}::q8`, `${name}::q8_scale`, `${name}::q8_zero`]);
      }
      return weightsDone.get(name);
    }

    function tryConv(node, out) {
      const weight = tensors.get(node.inputs[1]);
      const group = attributeOf(node, 'group')?.int ?? 1;
      if (!weight || group !== 1 || weight.dims.length < 3 || weight.dims.slice(2).some((dim) => dim !== 1)) return false;
      const values = floatValues(buf, weight);
      const bias = node.inputs[2] ? tensors.get(node.inputs[2]) : null;
      if (!values || (node.inputs[2] && !bias)) return false;
      const [input] = node.inputs;
      const [q, qScale, qZero] = quantizedInput(input, out);
      const [w, wScale, wZero] = addWeights(weight.name, values, weight.dims);
      const base = node.name || node.outputs[0];
      const integer = `${base}::q8_int`;
      // Атрибуты свёртки (шаг, отступы, расширение) — как у исходной.
      const attributes = node.attributes.map((attribute) => buf.subarray(attribute.start, attribute.end));
      out.push(nodeProto('ConvInteger', [q, w, qZero, wZero], [integer], `${base}::q8_conv`, attributes));
      let biasName = null;
      if (bias) {
        biasName = `${bias.name}::q8_shaped`;
        if (!weightsDone.has(biasName)) {
          const shape = [1, weight.dims[0], ...weight.dims.slice(2).map(() => 1)];
          newTensors.push(tensorProto(biasName, FLOAT, shape, floatBytes(floatValues(buf, bias))));
          weightsDone.set(biasName, [biasName]);
        }
        unit(bias.name);
      }
      unit(weight.name);
      scaleBack(node, integer, qScale, wScale, biasName, out);
      return true;
    }

    function tryMatMul(node, out) {
      const isGemm = node.opType === 'Gemm';
      const weight = tensors.get(node.inputs[1]);
      if (!weight || weight.dims.length !== 2 || tensors.has(node.inputs[0])) return false;
      if (isGemm) {
        const transA = attributeOf(node, 'transA')?.int ?? 0;
        const alpha = attributeOf(node, 'alpha')?.float ?? 1;
        const beta = attributeOf(node, 'beta')?.float ?? 1;
        if (transA || alpha !== 1 || beta !== 1) return false;
      }
      let values = floatValues(buf, weight);
      if (!values) return false;
      let dims = weight.dims;
      if (isGemm && (attributeOf(node, 'transB')?.int ?? 0)) {
        values = transpose(values, dims[0], dims[1]);
        dims = [dims[1], dims[0]];
      }
      const bias = isGemm && node.inputs[2] ? tensors.get(node.inputs[2]) : null;
      if (isGemm && node.inputs[2] && !bias) return false;
      const [q, qScale, qZero] = quantizedInput(node.inputs[0], out);
      const [w, wScale, wZero] = addWeights(`${weight.name}${isGemm ? '::t' : ''}`, values, dims);
      const base = node.name || node.outputs[0];
      const integer = `${base}::q8_int`;
      out.push(nodeProto('MatMulInteger', [q, w, qZero, wZero], [integer], `${base}::q8_matmul`));
      unit(weight.name); // смещение Gemm остаётся прежним тензором — его не трогаем
      scaleBack(node, integer, qScale, wScale, bias?.name ?? null, out);
      return true;
    }

    // int8-веса «Cast → Mul(масштаб)», которые читают только MatMul (как B) и Gather (как таблицу).
    const packed = new Map(); // имя веса → { q, scale, cast, mul }
    if (int8Weights) {
      const readers = new Map();
      for (const node of nodes) node.inputs.forEach((input, index) => readers.set(input, [...(readers.get(input) || []), { node, index }]));
      for (const cast of nodes) {
        const q = cast.opType === 'Cast' ? tensors.get(cast.inputs[0]) : null;
        if (!q || q.dataType !== INT8) continue;
        const [use, ...more] = readers.get(cast.outputs[0]) || [];
        if (!use || more.length || use.node.opType !== 'Mul') continue;
        const mul = use.node;
        const scale = mul.inputs.find((input) => input !== cast.outputs[0]);
        if (!tensors.has(scale)) continue;
        const users = readers.get(mul.outputs[0]) || [];
        const supported = ({ node, index }) =>
          !exclude(node.name) && ((node.opType === 'MatMul' && index === 1) || (node.opType === 'Gather' && index === 0));
        if (users.length && users.every(supported)) packed.set(mul.outputs[0], { q: q.name, scale, cast, mul });
      }
    }
    const packedNodes = new Set([...packed.values()].flatMap(({ cast, mul }) => [cast, mul]));

    function packedMatMul(node, out) {
      const { q: w, scale } = packed.get(node.inputs[1]);
      const [q, qScale, qZero] = quantizedInput(node.inputs[0], out);
      const base = node.name || node.outputs[0];
      // B — int8 с нулевой точкой 0: её можно не передавать.
      out.push(nodeProto('MatMulInteger', [q, w, qZero], [`${base}::q8_int`], `${base}::q8_matmul`));
      out.push(nodeProto('Cast', [`${base}::q8_int`], [`${base}::q8_float`], `${base}::q8_cast`, [intAttribute('to', FLOAT)]));
      out.push(nodeProto('Mul', [`${base}::q8_float`, qScale], [`${base}::q8_scaled`], `${base}::q8_input_mul`));
      // Масштаб весов — по столбцам [1, N]: ложится на последнюю ось.
      out.push(nodeProto('Mul', [`${base}::q8_scaled`, scale], [node.outputs[0]], `${base}::q8_weight_mul`));
    }

    function packedGather(node, out) {
      const { q: table, scale } = packed.get(node.inputs[0]);
      const base = node.name || node.outputs[0];
      const attributes = node.attributes.map((attribute) => buf.subarray(attribute.start, attribute.end));
      out.push(nodeProto('Gather', [table, node.inputs[1]], [`${base}::q8_rows`], `${base}::q8_gather`, attributes));
      out.push(nodeProto('Cast', [`${base}::q8_rows`], [`${base}::q8_float`], `${base}::q8_cast`, [intAttribute('to', FLOAT)]));
      // Масштаб — по строкам [V, 1]: берём строки тех же слов.
      out.push(nodeProto('Gather', [scale, node.inputs[1]], [`${base}::q8_row_scale`], `${base}::q8_scale_gather`, attributes));
      out.push(nodeProto('Mul', [`${base}::q8_float`, `${base}::q8_row_scale`], [node.outputs[0]], `${base}::q8_scale_mul`));
    }

    for (const node of nodes) {
      const out = [];
      if (exclude(node.name)) {
        nodeBytes.push(node.bytes);
        continue;
      }
      if (packedNodes.has(node)) continue; // fp32-копия веса больше не нужна
      if (node.opType === 'MatMul' && packed.has(node.inputs[1])) {
        packedMatMul(node, out);
        quantized += 1;
        nodeBytes.push(...out.map((bytes) => lengthField(1, bytes)));
        continue;
      }
      if (node.opType === 'Gather' && packed.has(node.inputs[0])) {
        packedGather(node, out);
        quantized += 1;
        nodeBytes.push(...out.map((bytes) => lengthField(1, bytes)));
        continue;
      }
      if (int8Weights) {
        nodeBytes.push(node.bytes);
        continue;
      }
      if (dynamic && ((node.opType === 'Conv' && tryConv(node, out)) || ((node.opType === 'MatMul' || node.opType === 'Gemm') && tryMatMul(node, out)))) {
        quantized += 1;
        nodeBytes.push(...out.map((bytes) => lengthField(1, bytes)));
        continue;
      }
      if (node.opType === 'Loop' || node.opType === 'If' || node.opType === 'Scan') {
        nodeBytes.push(lengthField(1, rewriteSubgraphs(node)));
        continue;
      }
      if (steps && node.opType === 'ConstantOfShape' && node.outputs[0] === 'total_step') {
        const value = tensorAttribute('value', tensorProto('', FLOAT, [1], floatBytes([steps])));
        nodeBytes.push(lengthField(1, nodeProto(node.opType, node.inputs, node.outputs, node.name, [value])));
        continue;
      }
      nodeBytes.push(node.bytes);
    }

    function rewriteSubgraphs(node) {
      const parts = [];
      for (const f of fields(buf, node.start, node.end)) {
        if (f.field !== 5) {
          parts.push(raw(buf, f));
          continue;
        }
        const attribute = parseAttribute(buf, f);
        if (!attribute.graph) {
          parts.push(raw(buf, f));
          continue;
        }
        const attributeParts = [];
        for (const af of fields(buf, f.start, f.end)) {
          attributeParts.push(af.field === 6 ? lengthField(6, rewriteGraph(buf, af.start, af.end, false)) : raw(buf, af));
        }
        parts.push(lengthField(5, concat(attributeParts)));
      }
      return concat(parts);
    }

    // Собираем граф: узлы — на месте прежних, исходные веса заменённых узлов убираем.
    const out = [];
    let nodesWritten = false;
    for (const f of graphFields) {
      if (f.field === 1) {
        if (!nodesWritten) out.push(...nodeBytes);
        nodesWritten = true;
      } else if (f.field === 5) {
        const tensor = tensors.get(parseTensor(buf, f).name);
        if (replacedUses.has(tensor.name) && replacedUses.get(tensor.name) >= (uses.get(tensor.name) || 0)) continue;
        if (isTop && steps && tensor.name === 'sampler_trip_count') {
          out.push(lengthField(5, tensorProto(tensor.name, INT64, tensor.dims, int64Bytes(steps))));
          continue;
        }
        if (canHoist(tensor.name)) {
          topNames.add(tensor.name);
          hoisted.push(raw(buf, f));
          continue;
        }
        out.push(raw(buf, f));
      } else {
        out.push(raw(buf, f));
      }
    }
    for (const bytes of newTensors) (hoist && !isTop ? hoisted : out).push(lengthField(5, bytes));
    if (isTop) out.push(...hoisted.splice(0));
    return concat(out);
  }

  const parts = [];
  for (const f of fields(model)) {
    parts.push(f.field === 7 ? lengthField(7, rewriteGraph(model, f.start, f.end, true)) : raw(model, f));
  }
  return { model: concat(parts), quantized };
}
