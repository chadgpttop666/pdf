// Чтение ZIP — без сжатия или deflate (так пишут и scripts/build-chrome.mjs,
// и обычные архиваторы). Нужно автообновлению в Chrome: архив новой версии
// раскладывается на файлы прямо в браузере (updates.js).

import { crc32 } from './zip.js';

async function inflate(bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/**
 * @param buffer ArrayBuffer | Uint8Array
 * @returns {Promise<Array<{ name: string, data: Uint8Array }>>} файлы, без папок
 */
export async function readZip(buffer) {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let end = -1;
  for (let at = bytes.length - 22; at >= Math.max(0, bytes.length - 22 - 0xffff); at -= 1) {
    if (view.getUint32(at, true) === 0x06054b50) {
      end = at;
      break;
    }
  }
  if (end < 0) throw new Error('Это не ZIP-архив');
  const count = view.getUint16(end + 10, true);
  let at = view.getUint32(end + 16, true);
  const decoder = new TextDecoder();
  const files = [];
  for (let n = 0; n < count; n += 1) {
    if (view.getUint32(at, true) !== 0x02014b50) throw new Error('ZIP-архив повреждён');
    const method = view.getUint16(at + 10, true);
    const crc = view.getUint32(at + 16, true);
    const packedSize = view.getUint32(at + 20, true);
    const size = view.getUint32(at + 24, true);
    const nameLength = view.getUint16(at + 28, true);
    const skip = view.getUint16(at + 30, true) + view.getUint16(at + 32, true);
    const local = view.getUint32(at + 42, true);
    const name = decoder.decode(bytes.subarray(at + 46, at + 46 + nameLength));
    at += 46 + nameLength + skip;
    if (name.endsWith('/')) continue;
    const dataAt = local + 30 + view.getUint16(local + 26, true) + view.getUint16(local + 28, true);
    const packed = bytes.subarray(dataAt, dataAt + packedSize);
    let data;
    if (method === 0) data = packed;
    else if (method === 8) data = await inflate(packed);
    else throw new Error(`${name}: незнакомое сжатие (${method})`);
    if (data.length !== size || crc32(data) !== crc) throw new Error(`${name}: файл в архиве повреждён`);
    files.push({ name, data });
  }
  return files;
}
