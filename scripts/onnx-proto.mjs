// Сборка маленьких ONNX-моделей для тестов без зависимостей: протобуф
// пишется вручную, сообщений всего несколько. Номера полей — из onnx.proto.

export const FLOAT = 1;
export const INT64 = 7;
const ATTRIBUTE_INT = 2;
const ATTRIBUTE_INTS = 7;

export function varint(value) {
  const bytes = [];
  let n = BigInt.asUintN(64, BigInt(value));
  do {
    let byte = Number(n & 0x7fn);
    n >>= 7n;
    if (n) byte |= 0x80;
    bytes.push(byte);
  } while (n);
  return Buffer.from(bytes);
}

const key = (field, wire) => varint((field << 3) | wire);
export const int = (field, value) => Buffer.concat([key(field, 0), varint(value)]);
export const bytes = (field, payload) => Buffer.concat([key(field, 2), varint(payload.length), payload]);
export const str = (field, text) => bytes(field, Buffer.from(text, 'utf8'));
export const message = (...parts) => Buffer.concat(parts.filter(Boolean));

export function floats(values) {
  const buffer = Buffer.alloc(values.length * 4);
  values.forEach((value, i) => buffer.writeFloatLE(value, i * 4));
  return buffer;
}

const dim = (value) => (typeof value === 'number' ? bytes(1, int(1, value)) : bytes(1, str(2, value)));

export function valueInfo(name, elemType, dims) {
  const shape = message(...dims.map(dim));
  const tensorType = message(int(1, elemType), bytes(2, shape));
  return message(str(1, name), bytes(2, bytes(1, tensorType)));
}

/** Атрибут узла: число или список чисел. */
export function attribute(name, value) {
  if (Array.isArray(value)) return bytes(5, message(str(1, name), ...value.map((item) => int(8, item)), int(20, ATTRIBUTE_INTS)));
  return bytes(5, message(str(1, name), int(3, value), int(20, ATTRIBUTE_INT)));
}

export function node(opType, inputs, outputs, attributes = []) {
  return bytes(1, message(...inputs.map((name) => str(1, name)), ...outputs.map((name) => str(2, name)), str(4, opType), ...attributes));
}

/** Константа-инициализатор: float или int64. */
export function tensor(name, elemType, dims, values) {
  const data = elemType === FLOAT ? bytes(4, floats(values)) : bytes(7, Buffer.concat(values.map(varint)));
  return bytes(5, message(...dims.map((value) => int(1, value)), int(2, elemType), data, str(8, name)));
}

/**
 * @param parts.nodes результаты node()
 * @param parts.initializers результаты tensor()
 * @param parts.inputs, parts.outputs [имя, тип, размерности]
 */
export function model({ name, nodes, initializers = [], inputs, outputs, opset = 17 }) {
  const graph = message(
    ...nodes,
    str(2, name),
    ...initializers,
    ...inputs.map((spec) => bytes(11, valueInfo(...spec))),
    ...outputs.map((spec) => bytes(12, valueInfo(...spec)))
  );
  return message(int(1, 8), str(2, 'pdf-reader-test'), bytes(7, graph), bytes(8, message(str(1, ''), int(2, opset))));
}
