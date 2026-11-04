import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import { parseTtf } from '../../extension/src/books/ttf.js';
import { addFreeTextAppearances, decodePdfString, parseFreeText, readLiteral } from '../../extension/src/editing/freetext-appearance.js';

const ttf = parseTtf(new Uint8Array(readFileSync(new URL('../../extension/vendor/fonts/PTSerif-Regular.ttf', import.meta.url))));
const fixture = (name) => new Uint8Array(readFileSync(new URL(`../fixtures/${name}`, import.meta.url)));
const latin1 = (text) => Uint8Array.from(text, (char) => char.charCodeAt(0));

/** Маленький PDF с потоком XRef вместо таблицы — как у большинства современных файлов. */
function xrefStreamPdf() {
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 300] /Contents 4 0 R >>',
    '<< /Length 0 >>\nstream\n\nendstream',
  ];
  let text = '%PDF-1.7\n';
  const offsets = [];
  objects.forEach((body, i) => {
    offsets.push(text.length);
    text += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xrefAt = text.length;
  offsets.push(xrefAt);
  const rows = [[0, 0, 255], ...offsets.map((offset) => [1, offset, 0])];
  const data = rows.map(([type, offset, gen]) => String.fromCharCode(type, offset >> 8, offset & 0xff, gen)).join('');
  text += `5 0 obj\n<< /Type /XRef /Size 6 /W [1 2 1] /Root 1 0 R /Length ${data.length} >>\nstream\n${data}\nendstream\nendobj\nstartxref\n${xrefAt}\n%%EOF\n`;
  return latin1(text);
}

/** Сохранить через pdf.js с текстовыми заметками — как кнопка «Скачать» с правками. */
async function saveWithNotes(bytes, notes) {
  const doc = await pdfjs.getDocument({ data: bytes, verbosity: 0 }).promise;
  // pdf.js записывает только ключи своего вида — и правки, восстановленные читалкой, тоже.
  notes.forEach((note, i) => doc.annotationStorage.setValue(`pdfjs_internal_editor_restored_${i}`, { annotationType: 3, pageIndex: 0, rotation: 0, ...note }));
  const saved = await doc.saveDocument();
  await doc.loadingTask.destroy();
  return saved;
}

/** Текст, который рисует страница вместе с заметками. */
async function drawnText(bytes) {
  const doc = await pdfjs.getDocument({ data: bytes.slice(), verbosity: 0 }).promise;
  const page = await doc.getPage(1);
  const ops = await page.getOperatorList({ annotationMode: pdfjs.AnnotationMode.ENABLE });
  const pieces = [];
  ops.fnArray.forEach((fn, i) => {
    if (fn === pdfjs.OPS.showText) pieces.push(ops.argsArray[i][0].map((glyph) => glyph?.unicode ?? '').join(''));
  });
  const annotations = (await page.getAnnotations()).filter((annotation) => annotation.subtype === 'FreeText');
  await doc.loadingTask.destroy();
  return { pieces, annotations };
}

describe('строки PDF', () => {
  it('скобки, экранирование, восьмеричные коды, перенос внутри строки', () => {
    const text = String.raw`(a\(b\)c (d) \\ \101\n\
e)tail`;
    const { bytes, end } = readLiteral(text, 0);
    assert.equal(String.fromCharCode(...bytes), 'a(b)c (d) \\ A\ne');
    assert.equal(text.slice(end), 'tail');
  });

  it('UTF-16BE с меткой FE FF и Latin-1', () => {
    assert.equal(decodePdfString([0xfe, 0xff, 0x04, 0x1f, 0x04, 0x40, 0x00, 0x21]), 'Пр!');
    assert.equal(decodePdfString([0x48, 0x69]), 'Hi');
  });

  it('заметка из словаря pdf.js: поле, кегль, цвет, текст', () => {
    const dict = '<< /Type /Annot /Subtype /FreeText /Rect [10 20 110 50] /DA (/Helv 14 Tf 0.78 0 0 rg) /Contents (\xfe\xff\x04\x1f\x00\\n\x00!) /Rotate 90 >>';
    assert.deepEqual(parseFreeText(dict), { rect: [10, 20, 110, 50], rotation: 90, fontSize: 14, color: [0.78, 0, 0], opacity: 1, text: 'П\n!' });
    assert.equal(parseFreeText('<< /Subtype /Ink /Rect [0 0 1 1] >>'), null);
  });
});

describe('оформление текстовых заметок', () => {
  it('кириллица: pdf.js оформления не пишет, мы дописываем — текст рисуется нашим шрифтом', async () => {
    const saved = await saveWithNotes(fixture('sample.pdf'), [
      { color: [200, 0, 0], fontSize: 14, value: 'Привет, мир!\nВторая строка — ёжик', rect: [60, 650, 260, 700] },
      { color: [0, 0, 0], fontSize: 10, value: 'Latin only', rect: [60, 600, 160, 616] },
    ]);
    // До нашей правки у кириллической заметки оформления нет.
    assert.ok(!/\/Subtype \/FreeText[^\n]*\/AP/.test(new TextDecoder('latin1').decode(saved.subarray(-20000)).split('\n').find((line) => line.includes('ёжик')) ?? ''));
    const fixed = await addFreeTextAppearances(saved, ttf);
    assert.ok(fixed.length > saved.length);
    assert.deepEqual([...fixed.subarray(0, saved.length)], [...saved], 'исходные байты не тронуты — только дописано обновление');
    const { pieces, annotations } = await drawnText(fixed);
    assert.ok(pieces.includes('Привет, мир!'), JSON.stringify(pieces));
    assert.ok(pieces.includes('Вторая строка — ёжик'));
    assert.ok(pieces.includes('Latin only'));
    assert.equal(annotations.length, 2);
    // Кегль и цвет pdf.js берёт из нашего оформления — правка в читалке откроется как была.
    const note = annotations.find((annotation) => annotation.textContent?.join(' ').includes('Привет'));
    assert.equal(note.defaultAppearanceData.fontSize, 14);
  });

  it('файл с потоком XRef — обновление тоже потоком, файл открывается', async () => {
    const saved = await saveWithNotes(xrefStreamPdf(), [{ color: [0, 0, 0], fontSize: 12, value: 'Заметка на полях', rect: [20, 200, 200, 220] }]);
    const fixed = await addFreeTextAppearances(saved, ttf);
    const tail = new TextDecoder('latin1').decode(fixed.subarray(saved.length));
    assert.match(tail, /\/Type \/XRef/);
    assert.doesNotMatch(tail, /\ntrailer\n/);
    const { pieces } = await drawnText(fixed);
    assert.ok(pieces.includes('Заметка на полях'), JSON.stringify(pieces));
  });

  it('без текстовых заметок файл не меняется', async () => {
    const original = fixture('sample.pdf');
    assert.equal(await addFreeTextAppearances(original, ttf), original);
  });
});
