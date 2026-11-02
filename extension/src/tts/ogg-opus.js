// Ogg Opus: контейнер для звука аудиокниги. Кодирует сам браузер (WebCodecs,
// AudioEncoder), а пакеты Opus по страницам Ogg раскладываем здесь — по
// RFC 7845. Opus на 32 кбит/с: час речи — ≈14 МБ, против ≈170 МБ в WAV.
// Главы — в комментариях CHAPTERxxx (их понимают foobar2000, VLC и
// многие плееры аудиокниг).

const OGG_CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n << 24;
    for (let k = 0; k < 8; k += 1) c = c & 0x80000000 ? (c << 1) ^ 0x04c11db7 : c << 1;
    table[n] = c >>> 0;
  }
  return table;
})();

/** CRC страницы Ogg: многочлен 0x04C11DB7, без отражения, начальное 0. */
export function oggCrc(bytes) {
  let crc = 0;
  for (let i = 0; i < bytes.length; i += 1) crc = ((crc << 8) ^ OGG_CRC_TABLE[((crc >>> 24) ^ bytes[i]) & 0xff]) >>> 0;
  return crc >>> 0;
}

const utf8 = (text) => new TextEncoder().encode(text);

/** «01:02:03.456» — время главы для комментария CHAPTERxxx. */
export function chapterTime(seconds) {
  const ms = Math.max(0, Math.round(seconds * 1000));
  const pad = (value, size = 2) => String(value).padStart(size, '0');
  return `${pad(Math.floor(ms / 3600000))}:${pad(Math.floor(ms / 60000) % 60)}:${pad(Math.floor(ms / 1000) % 60)}.${pad(ms % 1000, 3)}`;
}

/** Заголовок OpusHead: версия 1, каналы, pre-skip, исходная частота. */
export function opusHead({ channels = 1, preSkip = 312, inputSampleRate = 48000 } = {}) {
  const head = new Uint8Array(19);
  head.set(utf8('OpusHead'));
  const view = new DataView(head.buffer);
  view.setUint8(8, 1);
  view.setUint8(9, channels);
  view.setUint16(10, preSkip, true);
  view.setUint32(12, inputSampleRate, true);
  view.setInt16(16, 0, true); // усиление
  view.setUint8(18, 0); // моно/стерео — без таблицы каналов
  return head;
}

/** OpusTags: поставщик и комментарии «ИМЯ=значение». */
export function opusTags(comments = [], vendor = 'PDF-читалка') {
  const encoded = comments.map(utf8);
  const vendorBytes = utf8(vendor);
  const size = 8 + 4 + vendorBytes.length + 4 + encoded.reduce((sum, item) => sum + 4 + item.length, 0);
  const tags = new Uint8Array(size);
  const view = new DataView(tags.buffer);
  tags.set(utf8('OpusTags'));
  let at = 8;
  view.setUint32(at, vendorBytes.length, true);
  tags.set(vendorBytes, at + 4);
  at += 4 + vendorBytes.length;
  view.setUint32(at, encoded.length, true);
  at += 4;
  for (const item of encoded) {
    view.setUint32(at, item.length, true);
    tags.set(item, at + 4);
    at += 4 + item.length;
  }
  return tags;
}

// Заголовок OpusTags должен уместиться в одну страницу Ogg (255 × 255 байт).
const MAX_TAGS_BYTES = 64000;
const MAX_CHAPTERS = 500;

/** Комментарии аудиокниги: название, автор, главы. */
export function bookComments({ title, artist, album, chapters = [] } = {}) {
  const comments = [];
  if (title) comments.push(`TITLE=${title}`);
  if (artist) comments.push(`ARTIST=${artist}`);
  if (album) comments.push(`ALBUM=${album}`);
  chapters.slice(0, MAX_CHAPTERS).forEach((chapter, i) => {
    const number = String(i + 1).padStart(3, '0');
    comments.push(`CHAPTER${number}=${chapterTime(chapter.start)}`, `CHAPTER${number}NAME=${String(chapter.title).slice(0, 120)}`);
  });
  return comments;
}

/** OpusTags книги; глав столько, сколько влезает в одну страницу Ogg. */
export function bookTags(meta = {}) {
  let chapters = meta.chapters ?? [];
  let tags = opusTags(bookComments({ ...meta, chapters }));
  while (tags.length > MAX_TAGS_BYTES && chapters.length) {
    chapters = chapters.slice(0, Math.floor(chapters.length * 0.8));
    tags = opusTags(bookComments({ ...meta, chapters }));
  }
  return tags;
}

/**
 * Собирает страницы Ogg из пакетов Opus.
 * @param head байты OpusHead, tags — OpusTags (их можно задать в конце: см. finish)
 */
export function createOggWriter({ serial = (Math.random() * 0xffffffff) >>> 0 } = {}) {
  const pages = [];
  let sequence = 0;
  let pending = []; // пакеты, ждущие своей страницы
  let pendingSegments = 0;

  function page(packets, granule, flags) {
    const lacing = [];
    for (const packet of packets) {
      let left = packet.length;
      while (left >= 255) {
        lacing.push(255);
        left -= 255;
      }
      lacing.push(left);
    }
    const bodySize = packets.reduce((sum, packet) => sum + packet.length, 0);
    const bytes = new Uint8Array(27 + lacing.length + bodySize);
    const view = new DataView(bytes.buffer);
    bytes.set(utf8('OggS'));
    view.setUint8(4, 0);
    view.setUint8(5, flags);
    view.setBigUint64(6, BigInt(granule), true);
    view.setUint32(14, serial, true);
    view.setUint32(18, sequence, true);
    sequence += 1;
    view.setUint8(26, lacing.length);
    bytes.set(lacing, 27);
    let at = 27 + lacing.length;
    for (const packet of packets) {
      bytes.set(packet, at);
      at += packet.length;
    }
    view.setUint32(22, oggCrc(bytes), true);
    return bytes;
  }

  const segmentsOf = (packet) => Math.floor(packet.length / 255) + 1;

  let granule = 0;
  let audioPages = [];

  return {
    /** Пакет Opus и сколько 48-кГц отсчётов он звучит. */
    addPacket(packet, samples48) {
      if (pendingSegments + segmentsOf(packet) > 255 || pending.reduce((sum, item) => sum + item.length, 0) > 4000) {
        audioPages.push({ packets: pending, granule });
        pending = [];
        pendingSegments = 0;
      }
      granule += samples48;
      pending.push(packet);
      pendingSegments += segmentsOf(packet);
    },
    get granule() {
      return granule;
    },
    /**
     * Готовый файл: заголовки (их содержимое известно только в конце — главы,
     * pre-skip от кодировщика), затем звук.
     * @param endTrim сколько отсчётов в конце — не звук, а добивка кадра
     */
    finish({ head, tags, endTrim = 0 }) {
      if (pending.length) audioPages.push({ packets: pending, granule: Math.max(0, granule - endTrim) });
      pending = [];
      sequence = 0;
      pages.length = 0;
      pages.push(page([head], 0, 0x02), page([tags], 0, 0));
      audioPages.forEach((item, i) => pages.push(page(item.packets, item.granule, i === audioPages.length - 1 ? 0x04 : 0)));
      if (!audioPages.length) pages[pages.length - 1][5] |= 0x04;
      audioPages = [];
      return new Blob(pages, { type: 'audio/ogg' });
    },
  };
}

/**
 * Разобрать Ogg обратно — для проверок: страницы, их пакеты, CRC.
 * @returns {{ flags, granule, sequence, crcOk, packets: Uint8Array[] }[]}
 */
export function readOgg(bytes) {
  const pages = [];
  let at = 0;
  let carry = null;
  while (at + 27 <= bytes.length) {
    const view = new DataView(bytes.buffer, bytes.byteOffset + at);
    if (new TextDecoder().decode(bytes.subarray(at, at + 4)) !== 'OggS') throw new Error(`нет OggS на ${at}`);
    const count = view.getUint8(26);
    const lacing = bytes.subarray(at + 27, at + 27 + count);
    const bodySize = lacing.reduce((sum, value) => sum + value, 0);
    const size = 27 + count + bodySize;
    const copy = bytes.slice(at, at + size);
    new DataView(copy.buffer).setUint32(22, 0, true);
    const packets = [];
    let offset = at + 27 + count;
    let current = carry ?? [];
    for (const value of lacing) {
      current.push(bytes.subarray(offset, offset + value));
      offset += value;
      if (value < 255) {
        const total = current.reduce((sum, part) => sum + part.length, 0);
        const packet = new Uint8Array(total);
        let p = 0;
        for (const part of current) {
          packet.set(part, p);
          p += part.length;
        }
        packets.push(packet);
        current = [];
      }
    }
    carry = current.length ? current : null;
    pages.push({
      flags: view.getUint8(5),
      granule: Number(view.getBigUint64(6, true)),
      sequence: view.getUint32(18, true),
      crcOk: oggCrc(copy) === view.getUint32(22, true),
      packets,
    });
    at += size;
  }
  return pages;
}
