import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { bookComments, bookTags, chapterTime, createOggWriter, oggCrc, opusHead, opusTags, readOgg } from '../../extension/src/tts/ogg-opus.js';
import { wavBlob } from '../../extension/src/tts/audiobook.js';

const packet = (size, fill = 7) => new Uint8Array(size).fill(fill);

describe('Ogg Opus', () => {
  it('CRC страницы Ogg — как у libogg', () => {
    // Значение для «123456789» у CRC-32/MPEG-2-подобного варианта Ogg (init 0, без отражения).
    assert.equal(oggCrc(new TextEncoder().encode('123456789')), 0x89a1897f);
    assert.equal(oggCrc(new Uint8Array()), 0);
  });

  it('время главы', () => {
    assert.equal(chapterTime(0), '00:00:00.000');
    assert.equal(chapterTime(3723.456), '01:02:03.456');
  });

  it('OpusHead и OpusTags по RFC 7845', () => {
    const head = opusHead({ preSkip: 312, inputSampleRate: 24000 });
    assert.equal(new TextDecoder().decode(head.subarray(0, 8)), 'OpusHead');
    assert.equal(head[8], 1);
    assert.equal(head[9], 1);
    assert.equal(head[10] | (head[11] << 8), 312);
    assert.equal(new DataView(head.buffer).getUint32(12, true), 24000);
    const tags = opusTags(['TITLE=Глава 1']);
    const view = new DataView(tags.buffer);
    const vendorLength = view.getUint32(8, true);
    assert.equal(view.getUint32(12 + vendorLength, true), 1);
    const commentLength = view.getUint32(16 + vendorLength, true);
    assert.equal(new TextDecoder().decode(tags.subarray(20 + vendorLength, 20 + vendorLength + commentLength)), 'TITLE=Глава 1');
  });

  it('главы — в комментариях CHAPTERxxx', () => {
    assert.deepEqual(bookComments({ title: 'Книга', chapters: [{ title: 'Глава I', start: 0 }, { title: 'Глава II', start: 61.5 }] }), [
      'TITLE=Книга',
      'CHAPTER001=00:00:00.000',
      'CHAPTER001NAME=Глава I',
      'CHAPTER002=00:01:01.500',
      'CHAPTER002NAME=Глава II',
    ]);
    // Слишком много глав — заголовок всё равно влезает в страницу Ogg.
    const many = Array.from({ length: 2000 }, (_, i) => ({ title: `Очень длинное название главы номер ${i} `.repeat(3), start: i * 60 }));
    assert.ok(bookTags({ chapters: many }).length <= 64000);
  });

  it('страницы: заголовки, звук, CRC, гранулы, конец потока', async () => {
    const writer = createOggWriter({ serial: 42 });
    for (let i = 0; i < 300; i += 1) writer.addPacket(packet(60 + (i % 5), i % 256), 960);
    writer.addPacket(packet(600), 960); // пакет длиннее 255 байт — несколько сегментов
    const total = 301 * 960;
    const blob = writer.finish({ head: opusHead({ preSkip: 312 }), tags: opusTags(['TITLE=x']), endTrim: 500 });
    const pages = readOgg(new Uint8Array(await blob.arrayBuffer()));
    assert.ok(pages.every((page) => page.crcOk));
    assert.deepEqual(
      pages.map((page) => page.sequence),
      pages.map((_, i) => i)
    );
    assert.equal(pages[0].flags, 0x02); // начало потока
    assert.equal(new TextDecoder().decode(pages[0].packets[0].subarray(0, 8)), 'OpusHead');
    assert.equal(new TextDecoder().decode(pages[1].packets[0].subarray(0, 8)), 'OpusTags');
    assert.equal(pages.at(-1).flags, 0x04); // конец потока
    assert.equal(pages.at(-1).granule, total - 500);
    const audio = pages.slice(2).flatMap((page) => page.packets);
    assert.equal(audio.length, 301);
    assert.equal(audio.at(-1).length, 600);
    assert.equal(audio[7][0], 7);
    // Гранулы растут, у каждой страницы — конец её последнего пакета.
    const granules = pages.slice(2).map((page) => page.granule);
    assert.ok(granules.every((value, i) => i === 0 || value > granules[i - 1]));
    assert.equal(granules[0], pages[2].packets.length * 960);
  });
});

describe('WAV', () => {
  it('заголовок и 16-битные отсчёты', async () => {
    const blob = wavBlob([new Float32Array([0, 0.5, -1]), new Float32Array([1])], 24000);
    const bytes = new DataView(await blob.arrayBuffer());
    assert.equal(bytes.byteLength, 44 + 8);
    assert.equal(bytes.getUint32(24, true), 24000);
    assert.equal(bytes.getUint32(40, true), 8);
    assert.deepEqual([0, 1, 2, 3].map((i) => bytes.getInt16(44 + i * 2, true)), [0, 16383, -32767, 32767]);
  });
});
