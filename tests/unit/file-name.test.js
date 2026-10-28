import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  filenameFromContentDisposition,
  filenameFromUrl,
  pickDocumentName,
  titleAsName,
} from '../../extension/src/file-name.js';

/** Как приходит заголовок с сырым UTF-8: каждый байт — отдельный символ. */
const asLatin1 = (text) => String.fromCharCode(...new TextEncoder().encode(text));

describe('имя из Content-Disposition', () => {
  it('filename* в UTF-8 важнее обычного filename', () => {
    const header = "inline; filename*=UTF-8''%D0%9A%D0%BD%D0%B8%D0%B3%D0%B0%20%E2%84%961.pdf; filename=\"kniga.pdf\"";
    assert.equal(filenameFromContentDisposition(header), 'Книга №1.pdf');
  });

  it('обычный filename — в кавычках и без', () => {
    assert.equal(filenameFromContentDisposition('inline; filename="Report 2024.pdf"'), 'Report 2024.pdf');
    assert.equal(filenameFromContentDisposition('attachment; filename=simple.pdf; size=10'), 'simple.pdf');
    assert.equal(filenameFromContentDisposition('inline; filename="C:\\\\docs\\\\a.pdf"'), 'a.pdf');
  });

  it('русское имя без кодирования и с процентами', () => {
    assert.equal(filenameFromContentDisposition(`inline; filename="${asLatin1('Учебник.pdf')}"`), 'Учебник.pdf');
    assert.equal(filenameFromContentDisposition('inline; filename="%D0%A3%D1%87%D0%B5%D0%B1%D0%BD%D0%B8%D0%BA.pdf"'), 'Учебник.pdf');
    assert.equal(filenameFromContentDisposition("inline; filename*=windows-1251''%D3%F7%E5%E1%ED%E8%EA.pdf"), 'Учебник.pdf');
  });

  it('нет имени — null', () => {
    assert.equal(filenameFromContentDisposition('inline'), null);
    assert.equal(filenameFromContentDisposition(''), null);
  });
});

describe('имя документа', () => {
  it('из адреса: сегмент пути или параметр с .pdf', () => {
    assert.equal(filenameFromUrl('https://x.ru/files/%D0%9A%D0%BD%D0%B8%D0%B3%D0%B0.pdf?v=2'), 'Книга.pdf');
    assert.equal(filenameFromUrl('https://x.ru/download.php?id=7&file=%D0%9E%D1%82%D1%87%D1%91%D1%82.pdf'), 'Отчёт.pdf');
    assert.equal(filenameFromUrl('https://x.ru/get/8f2a9c'), '8f2a9c');
  });

  it('сервер → адрес с .pdf → название PDF → остаток адреса', () => {
    assert.equal(pickDocumentName({ disposition: 'Книга.pdf', urlName: 'x.pdf', title: 'Т' }), 'Книга.pdf');
    assert.equal(pickDocumentName({ urlName: 'Отчёт.pdf', title: 'Годовой отчёт' }), 'Отчёт.pdf');
    assert.equal(pickDocumentName({ urlName: '8f2a9c', title: 'Как читать с экрана' }), 'Как читать с экрана');
    assert.equal(pickDocumentName({ urlName: 'download.php', title: 'Untitled' }), 'download.php');
    assert.equal(pickDocumentName({}), 'документ.pdf');
  });

  it('служебное в названии PDF отбрасывается', () => {
    assert.equal(titleAsName('Microsoft Word - Курсовая.docx'), 'Курсовая');
    assert.equal(titleAsName('  '), null);
    assert.equal(titleAsName('Документ'), null);
    assert.equal(titleAsName('123'), null);
  });
});
