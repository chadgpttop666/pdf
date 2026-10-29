import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { encodeText, keepSupported, maxSecondsFor, modelText, parseNpy, planPieces, voicedRange } from '../../extension/src/tts/tera-text.js';

const texts = (text, options) => planPieces(text, options).map((piece) => [piece.lang, piece.text]);

describe('TeraTTS: куски фразы', () => {
  it('английские названия — отдельными кусками, кавычки по краям убраны', () => {
    const text = 'Сегодня есть журналы, как «Journal of Political Philosophy» и «Ethics».';
    assert.deepEqual(texts(text), [
      ['ru', 'Сегодня есть журналы, как'],
      ['en', 'Journal of Political Philosophy'],
      ['ru', 'и'],
      ['en', 'Ethics'],
    ]);
    const pieces = planPieces(text);
    for (const piece of pieces) assert.equal(text.slice(piece.start, piece.end), piece.text);
    assert.equal(pieces[1].pause, 0.05);
    assert.equal(pieces.at(-1).pause, 0.25, 'конец фразы');
    assert.equal(pieces[2].maxSeconds, 0.36, 'однобуквенный кусок не тянется');
    assert.equal(pieces[0].maxSeconds, null);
  });

  it('фраза без английского — один кусок', () => {
    assert.deepEqual(texts('Неужели всё это было зря?'), [['ru', 'Неужели всё это было зря?']]);
  });

  it('длинное предложение режется по знакам препинания', () => {
    const clause = 'существовал только один журнал, посвящённый проблемам политической философии';
    const text = `${clause}, ${clause}; ${clause}, ${clause}.`;
    const pieces = planPieces(text);
    assert.ok(pieces.length >= 2, pieces.length);
    assert.ok(pieces.every((piece) => piece.text.length <= 220));
    assert.ok(pieces.slice(0, -1).every((piece) => /[,;]$/.test(piece.text)), JSON.stringify(pieces.map((p) => p.text)));
    assert.equal(pieces.map((piece) => piece.text).join(' '), text);
  });

  it('быстрый старт: куски нарастают, режутся по запятым', () => {
    const text = 'Когда Джон Ролз написал «Теорию справедливости» в тысяча девятьсот семьдесят первом году, существовал только один журнал.';
    const normal = planPieces(text);
    const fast = planPieces(text, { fastStart: true });
    assert.equal(normal.length, 1);
    assert.ok(fast.length >= 2, fast.length);
    assert.ok(fast[0].text.length <= 40, fast[0].text);
    assert.ok(fast[1].text.length <= 105, fast[1].text);
    // Граница — по запятой или перед оборотом, а не посреди словосочетания.
    assert.deepEqual(
      fast.map((piece) => piece.text),
      ['Когда Джон Ролз написал', '«Теорию справедливости» в тысяча девятьсот семьдесят первом году,', 'существовал только один журнал.']
    );
    assert.equal(fast[1].pause, 0.12);
  });

  it('пределы быстрого старта — в произносимых знаках', () => {
    const text = 'В 1945 и 1946 годах он работал в Баварии, потом переехал во Франкфурт.';
    const longer = (part) => part.length * 2;
    const plain = planPieces(text, { fastStart: true });
    const measured = planPieces(text, { fastStart: true, measure: longer });
    assert.deepEqual(
      plain.map((piece) => piece.text),
      ['В 1945 и 1946 годах он работал', 'в Баварии, потом переехал во Франкфурт.']
    );
    assert.deepEqual(
      measured.map((piece) => piece.text),
      ['В 1945 и 1946 годах', 'он работал в Баварии,', 'потом переехал во Франкфурт.']
    );
  });

  it('куски без букв не синтезируются', () => {
    assert.deepEqual(texts('«Ethics» — 1993.'), [
      ['en', 'Ethics'],
      ['ru', '1993.'],
    ]);
    assert.deepEqual(texts('* * *'), []);
  });

  it('предел длительности — только у коротких', () => {
    assert.equal(maxSecondsFor('в'), 0.36);
    assert.equal(maxSecondsFor('для'), 0.25 + 0.33);
    assert.equal(maxSecondsFor('журнал'), null);
  });
});

describe('TeraTTS: текст для модели', () => {
  it('тег языка, пробелы после знаков, NFKD', () => {
    assert.equal(modelText('ru', 'Мой,твой.  Ёж'), '<ru>Мой, твой. Ёж</ru>'.normalize('NFKD'));
    assert.equal(modelText('ru', '2,5 и 3.14'), '<ru>2,5 и 3.14</ru>'.normalize('NFKD'));
    assert.ok(modelText('ru', 'й').includes('̆'), 'й раскладывается');
  });

  it('неизвестные модели символы выбрасываются, «й» остаётся', () => {
    const table = new Int32Array(65536).fill(-1);
    for (const char of 'абвий̆ +') table[char.codePointAt(0)] = 1;
    assert.equal(keepSupported('аб😀в й+', table), 'абв й+');
  });

  it('номера символов с ударениями и без', () => {
    const table = new Int32Array(65536).fill(-1);
    table['а'.codePointAt(0)] = 5;
    table['+'.codePointAt(0)] = 9;
    const { withStress, plain } = encodeText('+аа', table);
    assert.deepEqual([...withStress], [9n, 5n, 5n]);
    assert.deepEqual([...plain], [5n, 5n]);
  });

  it('тишина по краям срезается с запасом', () => {
    const rate = 1000;
    const pcm = new Float32Array(1000);
    for (let i = 300; i < 700; i += 1) pcm[i] = 0.5;
    const [start, end] = voicedRange(pcm, rate);
    assert.ok(start >= 260 && start <= 300, start);
    assert.ok(end >= 700 && end <= 740, end);
    assert.deepEqual(voicedRange(new Float32Array(100), rate), [0, 100], 'тишина целиком — не трогаем');
  });

  it('стиль голоса из .npy', () => {
    const header = "{'descr': '<f4', 'fortran_order': False, 'shape': (1, 2, 3), }";
    const padded = header.padEnd(117, ' ') + '\n'; // 10 + 118 = 128: данные выровнены, как в настоящих файлах
    const bytes = new Uint8Array(10 + padded.length + 24);
    bytes.set([0x93, ...Buffer.from('NUMPY'), 1, 0]);
    new DataView(bytes.buffer).setUint16(8, padded.length, true);
    bytes.set(Buffer.from(padded), 10);
    new Float32Array(bytes.buffer, 10 + padded.length, 6).set([1, 2, 3, 4, 5, 6]);
    const { shape, data } = parseNpy(bytes.buffer);
    assert.deepEqual(shape, [1, 2, 3]);
    assert.deepEqual([...data], [1, 2, 3, 4, 5, 6]);
  });
});
