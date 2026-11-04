import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { inflateRawSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { buildChrome, chromeKey, chromeManifest, FILE_LIST, MIN_CHROME, zipFolder } from '../../scripts/build-chrome.mjs';
import { chromeExtensionId } from '../../scripts/make-chrome-key.mjs';
import { pdfRules } from '../../extension/src/pdf-rules.js';
import { readZip } from '../../extension/src/unzip.js';
import { canInstall, describeUpdate } from '../../extension/src/updates.js';

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
    // Ускоритель и его установка — без отдельного вопроса о правах.
    for (const permission of ['nativeMessaging', 'downloads', 'downloads.open']) assert.ok(chrome.permissions.includes(permission), permission);
    assert.equal(chrome.optional_permissions, undefined);
    // Постоянный ID: по нему ускоритель пускает расширение, по нему же живёт библиотека.
    assert.equal(chrome.key, chromeKey());
    assert.equal(chromeExtensionId(chrome.key), 'jdjigmfbnjpcdccimgclkebcjbbaiddk');
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

  it('архив читается и в расширении (unzip.js): имена, содержимое, проверка CRC', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'chrome-unzip-'));
    try {
      mkdirSync(join(dir, 'src'), { recursive: true });
      writeFileSync(join(dir, 'manifest.json'), '{"version":"1.2.3"}');
      writeFileSync(join(dir, 'src', 'big.js'), 'проверка '.repeat(3000));
      writeFileSync(join(dir, 'empty.txt'), '');
      const zip = zipFolder(dir);
      const files = await readZip(new Uint8Array(zip));
      const byName = new Map(files.map((file) => [file.name, Buffer.from(file.data)]));
      assert.deepEqual([...byName.keys()].sort(), ['empty.txt', 'manifest.json', 'src/big.js']);
      assert.equal(byName.get('src/big.js').toString('utf8'), 'проверка '.repeat(3000));
      assert.equal(byName.get('empty.txt').length, 0);
      // Испорченный байт данных — отказ, а не тихо битый файл.
      const broken = Buffer.from(zip);
      const at = broken.indexOf(Buffer.from('{"version"')); // маленький файл лежит без сжатия
      assert.ok(at > 0);
      broken[at + 2] ^= 1;
      await assert.rejects(readZip(broken), /повреждён/);
      await assert.rejects(readZip(Buffer.from('не архив')), /не ZIP/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('сборка: список файлов версии и описание релиза для автообновления', () => {
    const out = mkdtempSync(join(tmpdir(), 'chrome-build-'));
    try {
      const built = buildChrome({ outDir: out, version: '9.8.7', dirName: 'ext' });
      const manifest = JSON.parse(readFileSync(join(built.dir, 'manifest.json'), 'utf8'));
      assert.equal(manifest.version, '9.8.7');
      const list = JSON.parse(readFileSync(join(built.dir, FILE_LIST), 'utf8'));
      assert.equal(list.version, '9.8.7');
      for (const name of ['manifest.json', 'background.js', 'viewer.html', FILE_LIST, 'icons/icon-128.png']) assert.ok(list.files.includes(name), name);
      assert.ok(list.files.every((name) => !name.includes('\\') && !name.startsWith('/')));
      const update = JSON.parse(readFileSync(built.update, 'utf8'));
      assert.deepEqual(update, {
        version: '9.8.7',
        url: 'https://github.com/chadgpttop666/pdf/releases/download/v9.8.7/pdf-reader-chrome-9.8.7.zip',
        sha256: createHash('sha256').update(readFileSync(built.zip)).digest('hex'),
      });
      // Архив — ровно эти файлы.
      assert.deepEqual([...unzip(readFileSync(built.zip)).keys()].sort(), [...list.files].sort());
    } finally {
      rmSync(out, { recursive: true, force: true });
    }
  });
});

describe('обновления в настройках', () => {
  it('кнопка «Обновить сейчас» — только когда есть что ставить', () => {
    for (const status of ['available', 'staged', 'waiting']) assert.ok(canInstall({ status }), status);
    for (const status of ['current', 'downloading', 'applied', 'error', 'no-helper', 'no-folder', undefined]) assert.ok(!canInstall({ status }), String(status));
    assert.ok(!canInstall(null));
  });

  it('строка состояния: Chrome и Firefox, с галочкой и без', () => {
    assert.match(describeUpdate({ status: 'current' }, '1.0.0', { auto: true, chrome: true }), /ставятся сами — проверяю раз в 6 часов/);
    assert.equal(describeUpdate({ status: 'current' }, '1.0.0', { auto: false, chrome: true }), 'Стоит последняя версия.');
    assert.equal(describeUpdate({ status: 'available', latest: '1.1.0' }, '1.0.0', { chrome: true }), 'Вышла версия 1.1.0.');
    assert.match(describeUpdate({ status: 'available', staged: '1.1.0' }, '1.0.0', { chrome: false }), /1\.1\.0 — Firefox поставит её и сам/);
    assert.match(describeUpdate({ status: 'waiting', staged: '1.1.0' }, '1.0.0', { chrome: true }), /1\.1\.0 готова — поставится сама, когда закроете вкладки читалки\.$/);
    assert.match(describeUpdate({ status: 'staged', staged: '1.1.0' }, '1.0.0', { chrome: false }), /или перезапустите Firefox/);
    assert.match(describeUpdate({ status: 'no-helper', latest: '1.1.0' }, '1.0.0', { chrome: true }), /ускоритель/);
    assert.equal(describeUpdate({ status: 'error', message: 'нет сети' }, '1.0.0', { chrome: true }), 'Не получилось: нет сети');
    assert.match(describeUpdate({}, '1.0.0', { chrome: false }), /Firefox проверяет обновления сам/);
  });
});
