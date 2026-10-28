// «Сканы» для проверки распознавания: страницы russian.pdf и joint.pdf, растеризованные в
// картинки, без текстового слоя — как у отсканированной книги.
//
// Нужны pdftoppm (poppler-utils) и ImageMagick. Готовый файл лежит в
// репозитории, запускать скрипт нужно только при изменении russian.pdf или joint.pdf.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const fixtures = join(root, 'tests', 'fixtures');

/** Растеризовать страницы PDF в картинки и собрать из них PDF без текста. */
function scan(source, out, first, last) {
  const work = mkdtempSync(join(tmpdir(), 'scan-'));
  execFileSync('pdftoppm', ['-r', '150', '-gray', '-jpeg', '-jpegopt', 'quality=70', '-f', String(first), '-l', String(last), source, join(work, 'page')]);
  const pages = readdirSync(work)
    .filter((name) => name.endsWith('.jpg'))
    .sort()
    .map((name) => join(work, name));
  execFileSync('convert', [...pages, '-density', '150', '-units', 'PixelsPerInch', out]);
  console.log(`${out}: ${pages.length} стр.`);
}

// Страницы 3–4 русской книги: глава с абзацами, сноской и колонтитулом.
scan(join(fixtures, 'russian.pdf'), join(fixtures, 'scan.pdf'), 3, 4);
// Русский текст с английскими названиями — они не должны пропасть.
scan(join(fixtures, 'joint.pdf'), join(fixtures, 'scan-mixed.pdf'), 2, 2);
