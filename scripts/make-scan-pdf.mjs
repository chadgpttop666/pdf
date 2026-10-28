// «Скан» для проверки распознавания: страницы russian.pdf, растеризованные в
// картинки, без текстового слоя — как у отсканированной книги.
//
// Нужны pdftoppm (poppler-utils) и ImageMagick. Готовый файл лежит в
// репозитории, запускать скрипт нужно только при изменении russian.pdf.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const source = join(root, 'tests', 'fixtures', 'russian.pdf');
const out = join(root, 'tests', 'fixtures', 'scan.pdf');
const work = mkdtempSync(join(tmpdir(), 'scan-'));

// Страницы 3–4: глава с абзацами, сноской и колонтитулом.
execFileSync('pdftoppm', ['-r', '150', '-gray', '-jpeg', '-jpegopt', 'quality=70', '-f', '3', '-l', '4', source, join(work, 'page')]);
const pages = readdirSync(work)
  .filter((name) => name.endsWith('.jpg'))
  .sort()
  .map((name) => join(work, name));
execFileSync('convert', [...pages, '-density', '150', '-units', 'PixelsPerInch', out]);
console.log(`tests/fixtures/scan.pdf: ${pages.length} стр.`);
