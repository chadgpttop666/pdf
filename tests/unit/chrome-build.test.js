import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { inflateRawSync } from 'node:zlib';
import { chromeManifest, MIN_CHROME, zipFolder } from '../../scripts/build-chrome.mjs';
import { pdfRules } from '../../extension/src/pdf-rules.js';

const firefox = JSON.parse(readFileSync(new URL('../../extension/manifest.json', import.meta.url), 'utf8'));

/** Файлы архива: имя → содержимое (распакованное). */
function unzip(buffer) {
  const end = buffer.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  const count = buffer.readUInt16LE(end + 10);
  let at = buffer.readUInt32LE(end + 16);
  const files = new Map();
  for (let i = 0; i < count; i += 1) {
    const method = buffer.readUInt16LE(at + 10);
    const packedSize = buffer.readUInt32LE(at + 20);
    const nameLength = buffer.readUInt16LE(at + 28);
    const local = buffer.readUInt32LE(at + 42);
    const name = buffer.toString('utf8', at + 46, at + 46 + nameLength);
    const dataAt = local + 30 + buffer.readUInt16LE(local + 26) + buffer.readUInt16LE(local + 28);
    const body = buffer.subarray(dataAt, dataAt + packedSize);
    files.set(name, method === 8 ? inflateRawSync(body) : body);
    at += 46 + nameLength;
  }
  return files;
}

describe('сборка для Chrome', () => {
  it('манифест: service worker, declarativeNetRequest, PNG-иконки, без настроек Firefox', () => {
    const chrome = chromeManifest(firefox);
    assert.deepEqual(chrome.background, { service_worker: 'background.js', type: 'module' });
    assert.equal(chrome.browser_specific_settings, undefined);
    assert.ok(!chrome.permissions.includes('webRequestBlocking'));
    assert.ok(!chrome.permissions.includes('webRequest'));
    assert.ok(chrome.permissions.includes('declarativeNetRequestWithHostAccess'));
    assert.equal(chrome.minimum_chrome_version, MIN_CHROME);
    assert.ok(Object.values(chrome.icons).every((path) => path.endsWith('.png')));
    assert.ok(Object.values(chrome.action.default_icon).every((path) => path.endsWith('.png')));
    assert.equal(chrome.version, firefox.version);
    // Исходный манифест Firefox не тронут.
    assert.ok(firefox.permissions.includes('webRequestBlocking'));
    assert.ok(firefox.browser_specific_settings.gecko.id);
  });

  it('правила перехвата: PDF по Content-Type, поток байтов — только с .pdf в адресе, скачивание — мимо', () => {
    const [pdf, octet] = pdfRules('chrome-extension://abc/viewer.html');
    assert.equal(pdf.action.redirect.regexSubstitution, 'chrome-extension://abc/viewer.html?src=\\0');
    assert.deepEqual(pdf.condition.resourceTypes, ['main_frame']);
    assert.ok(pdf.condition.responseHeaders[0].values.includes('application/pdf'));
    assert.ok(pdf.condition.excludedResponseHeaders[0].values.includes('attachment*'));
    const pdfUrl = new RegExp(pdf.condition.regexFilter);
    assert.ok(pdfUrl.test('https://example.com/download?id=7&x=1'));
    assert.ok(!pdfUrl.test('ftp://example.com/a.pdf'));
    const octetUrl = new RegExp(octet.condition.regexFilter);
    for (const url of ['https://a.ru/book.pdf', 'http://a.ru/b/Book.PDF?x=1&y=2', 'https://a.ru/x.pdf#page=3']) assert.ok(octetUrl.test(url), url);
    for (const url of ['https://a.ru/book.pdfx', 'https://a.ru/get?file=a.pdf', 'https://a.ru/archive.zip']) assert.ok(!octetUrl.test(url), url);
  });

  it('zip распаковывается, файлы целы, пути через «/»', () => {
    const dir = mkdtempSync(join(tmpdir(), 'chrome-zip-'));
    try {
      mkdirSync(join(dir, 'src', 'tts'), { recursive: true });
      writeFileSync(join(dir, 'manifest.json'), '{"name":"проверка"}');
      writeFileSync(join(dir, 'src', 'tts', 'a.js'), 'x'.repeat(5000));
      writeFileSync(join(dir, 'tiny.bin'), Buffer.from([1, 2, 3]));
      const files = unzip(zipFolder(dir));
      assert.deepEqual([...files.keys()].sort(), ['manifest.json', 'src/tts/a.js', 'tiny.bin']);
      assert.equal(files.get('manifest.json').toString('utf8'), '{"name":"проверка"}');
      assert.equal(files.get('src/tts/a.js').length, 5000);
      assert.deepEqual([...files.get('tiny.bin')], [1, 2, 3]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
