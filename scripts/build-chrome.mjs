// Сборка для Chrome, Edge и других браузеров на Chromium: тот же код
// extension/, свой манифест и PNG-иконки. Результат:
//   dist/chrome/                          — папка для «Загрузить распакованное»
//   dist/pdf-reader-chrome-<версия>.zip   — архив для Chrome Web Store и релиза
//
// Отличия манифеста от Firefox:
// - фоновый скрипт — service worker (в Chrome MV3 других нет);
// - вместо блокирующего webRequest — declarativeNetRequest (src/pdf-rules.js);
// - иконки PNG; нет настроек gecko (ID, адрес обновлений Firefox);
// - key — постоянный ID расширения (chrome/key.txt, scripts/make-chrome-key.mjs):
//   на него выдаёт разрешение ускоритель, по нему он находит папку для обновлений;
// - разрешения ускорителя — сразу, а не по запросу: в Firefox они по запросу,
//   чтобы обновление не останавливалось на вопросе о новых правах; у
//   распакованного расширения в Chrome такого вопроса нет, а ускоритель с
//   ними же обновляет и само расширение (src/updates.js).
// В папке лежит files.json — список файлов этой версии: обновляя, ускоритель
// удаляет только файлы прошлой версии, ничего чужого.

import { createHash } from 'node:crypto';
import { cpSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { deflateRawSync } from 'node:zlib';
import { crc32 } from '../extension/src/zip.js';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const ICON_SIZES = [16, 32, 48, 128];
// Условия на заголовки ответа в declarativeNetRequest появились в Chrome 128.
export const MIN_CHROME = '128';
export const FILE_LIST = 'files.json';

export function chromeKey() {
  return readFileSync(join(root, 'chrome', 'key.txt'), 'utf8').trim();
}

/** Манифест Firefox → манифест Chrome. */
export function chromeManifest(manifest, { key = chromeKey() } = {}) {
  const icon = (sizes) => Object.fromEntries(sizes.map((size) => [String(size), `icons/icon-${size}.png`]));
  const result = {
    ...manifest,
    key,
    minimum_chrome_version: MIN_CHROME,
    icons: icon(ICON_SIZES),
    action: { ...manifest.action, default_icon: icon([16, 32, 48]) },
    background: { service_worker: 'background.js', type: 'module' },
    permissions: [
      ...manifest.permissions.filter((permission) => !['webRequest', 'webRequestBlocking'].includes(permission)),
      'declarativeNetRequestWithHostAccess',
      ...(manifest.optional_permissions ?? []),
    ],
  };
  delete result.browser_specific_settings;
  delete result.optional_permissions;
  return result;
}

/** Все файлы папки — пути относительно неё, через «/». */
function listFiles(dir) {
  const files = [];
  const walk = (current) => {
    for (const name of readdirSync(current).sort()) {
      const path = join(current, name);
      if (statSync(path).isDirectory()) walk(path);
      else files.push(relative(dir, path).split(sep).join('/'));
    }
  };
  walk(dir);
  return files;
}

/** ZIP со сжатием deflate — chrome://extensions и Web Store принимают его. */
export function zipFolder(dir) {
  const chunks = [];
  const central = [];
  let offset = 0;
  for (const name of listFiles(dir)) {
    const data = readFileSync(join(dir, name));
    const packed = deflateRawSync(data, { level: 9 });
    const stored = packed.length >= data.length;
    const body = stored ? data : packed;
    const nameBytes = Buffer.from(name, 'utf8');
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(stored ? 0 : 8, 8);
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(0x21, 12); // 1980-01-01: архив одинаковый при одинаковых файлах
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    chunks.push(local, nameBytes, body);

    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50, 0);
    entry.writeUInt16LE(20, 4);
    entry.writeUInt16LE(20, 6);
    entry.writeUInt16LE(0x0800, 8);
    entry.writeUInt16LE(stored ? 0 : 8, 10);
    entry.writeUInt16LE(0, 12);
    entry.writeUInt16LE(0x21, 14);
    entry.writeUInt32LE(crc, 16);
    entry.writeUInt32LE(body.length, 20);
    entry.writeUInt32LE(data.length, 24);
    entry.writeUInt16LE(nameBytes.length, 28);
    entry.writeUInt32LE(offset, 42);
    central.push(entry, nameBytes);
    offset += local.length + nameBytes.length + body.length;
  }
  const centralSize = central.reduce((sum, part) => sum + part.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(central.length / 2, 8);
  end.writeUInt16LE(central.length / 2, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...chunks, ...central, end]);
}

/** Откуда расширение в Chrome узнаёт о новой версии (src/updates.js). */
export const RELEASES = 'https://github.com/chadgpttop666/pdf/releases';

/**
 * @param version другая версия в манифесте — для проверки обновления
 * @param dirName имя папки сборки внутри outDir
 */
export function buildChrome({ outDir = join(root, 'dist'), version = null, dirName = 'chrome' } = {}) {
  const source = join(root, 'extension');
  const target = join(outDir, dirName);
  rmSync(target, { recursive: true, force: true });
  mkdirSync(target, { recursive: true });
  cpSync(source, target, { recursive: true });

  const manifest = chromeManifest(JSON.parse(readFileSync(join(source, 'manifest.json'), 'utf8')));
  if (version) manifest.version = version;
  writeFileSync(join(target, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  for (const size of ICON_SIZES) {
    cpSync(join(root, 'chrome', 'icons', `icon-${size}.png`), join(target, 'icons', `icon-${size}.png`));
  }
  // Список файлов этой версии — сам он тоже в списке.
  const files = [...listFiles(target), FILE_LIST].sort();
  writeFileSync(join(target, FILE_LIST), `${JSON.stringify({ version: manifest.version, files })}\n`);

  const name = `pdf-reader-chrome-${manifest.version}.zip`;
  const zipPath = join(outDir, name);
  const zip = zipFolder(target);
  writeFileSync(zipPath, zip);
  // Описание релиза для автообновления: версия, адрес архива и его SHA-256.
  const update = { version: manifest.version, url: `${RELEASES}/download/v${manifest.version}/${name}`, sha256: createHash('sha256').update(zip).digest('hex') };
  const updatePath = join(outDir, 'updates-chrome.json');
  writeFileSync(updatePath, `${JSON.stringify(update, null, 2)}\n`);
  return { dir: target, zip: zipPath, update: updatePath, version: manifest.version, sha256: update.sha256 };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { dir, zip } = buildChrome();
  console.log(`${relative(root, dir)}/\n${relative(root, zip)} (${Math.round(statSync(zip).size / 1024 / 1024)} МБ)`);
}
