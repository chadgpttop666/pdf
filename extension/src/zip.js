// Простой ZIP без сжатия: конспект и голосовые записи одним файлом. Записи
// уже сжаты (Opus), Markdown маленький — сжимать незачем, а без сжатия
// хватает полусотни строк вместо библиотеки. Имена — в UTF-8 (флаг 11),
// их понимают и проводник Windows, и архиваторы.

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

export function crc32(bytes) {
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i += 1) crc = CRC_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

/** Время и дата в формате MS-DOS — так их хранит ZIP. */
function dosDateTime(date) {
  const time = (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2);
  const day = ((Math.max(1980, date.getFullYear()) - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
  return { time, day };
}

async function bytesOf(data) {
  if (data instanceof Uint8Array) return data;
  if (typeof data === 'string') return new TextEncoder().encode(data);
  return new Uint8Array(await data.arrayBuffer());
}

/**
 * Собрать архив.
 * @param files [{ name: 'папка/файл.md', data: string | Uint8Array | Blob, date?: Date }]
 * @returns {Promise<Blob>}
 */
export async function makeZip(files) {
  const encoder = new TextEncoder();
  const chunks = [];
  const central = [];
  let offset = 0;
  const used = new Set();

  for (const file of files) {
    // Одинаковые имена архиватор показал бы одним файлом — добавляем номер.
    let name = file.name;
    for (let n = 2; used.has(name); n += 1) name = file.name.replace(/(\.[^./]+)?$/, ` (${n})$1`);
    used.add(name);

    const nameBytes = encoder.encode(name);
    const data = await bytesOf(file.data);
    const crc = crc32(data);
    const { time, day } = dosDateTime(file.date ?? new Date());

    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true);
    local.setUint16(4, 20, true); // версия для распаковки
    local.setUint16(6, 0x0800, true); // имя в UTF-8
    local.setUint16(8, 0, true); // без сжатия
    local.setUint16(10, time, true);
    local.setUint16(12, day, true);
    local.setUint32(14, crc, true);
    local.setUint32(18, data.length, true);
    local.setUint32(22, data.length, true);
    local.setUint16(26, nameBytes.length, true);
    local.setUint16(28, 0, true);
    chunks.push(local, nameBytes, data);

    const entry = new DataView(new ArrayBuffer(46));
    entry.setUint32(0, 0x02014b50, true);
    entry.setUint16(4, 20, true);
    entry.setUint16(6, 20, true);
    entry.setUint16(8, 0x0800, true);
    entry.setUint16(10, 0, true);
    entry.setUint16(12, time, true);
    entry.setUint16(14, day, true);
    entry.setUint32(16, crc, true);
    entry.setUint32(20, data.length, true);
    entry.setUint32(24, data.length, true);
    entry.setUint16(28, nameBytes.length, true);
    entry.setUint32(42, offset, true);
    central.push(entry, nameBytes);

    offset += 30 + nameBytes.length + data.length;
  }

  const centralSize = central.reduce((sum, part) => sum + part.byteLength, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, files.length, true);
  end.setUint16(10, files.length, true);
  end.setUint32(12, centralSize, true);
  end.setUint32(16, offset, true);
  return new Blob([...chunks, ...central, end], { type: 'application/zip' });
}
