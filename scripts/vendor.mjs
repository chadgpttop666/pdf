// Копирует нужные куски pdfjs-dist в extension/vendor/, чтобы расширение
// устанавливалось из репозитория без npm install.
//
// Берём неминифицированные legacy-сборки: обычные требуют совсем свежих API
// (например Map.prototype.getOrInsertComputed), а legacy работает и в Firefox
// постарше, и в Chromium — на нём гоняются смоук-тесты.
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const src = join(root, 'node_modules', 'pdfjs-dist');
const dst = join(root, 'extension', 'vendor');

// Файлы, из которых надо срезать ссылку на sourcemap: карт мы не копируем,
// иначе devtools ругается на 404 при каждом открытии вьюера.
const scripts = [
  ['legacy/build/pdf.mjs', 'pdf.mjs'],
  ['legacy/build/pdf.worker.mjs', 'pdf.worker.mjs'],
  ['legacy/web/pdf_viewer.mjs', 'pdf_viewer.mjs'],
];

// Каталоги ресурсов, без которых часть документов рендерится неправильно:
// cmaps — кодировки CJK, standard_fonts — подстановка базовых шрифтов,
// wasm — декодеры JPEG2000/JBIG2, iccs — цветовые профили.
const assets = ['cmaps', 'standard_fonts', 'wasm', 'iccs'];

async function main() {
  if (!existsSync(src)) {
    console.error('Нет node_modules/pdfjs-dist — сначала выполните npm install');
    process.exit(1);
  }

  await rm(dst, { recursive: true, force: true });
  await mkdir(dst, { recursive: true });

  for (const [from, to] of scripts) {
    const code = await readFile(join(src, from), 'utf8');
    await writeFile(join(dst, to), code.replace(/^\/\/# sourceMappingURL=.*$/m, ''));
  }

  await cp(join(src, 'legacy', 'web', 'pdf_viewer.css'), join(dst, 'pdf_viewer.css'));
  await cp(join(src, 'legacy', 'web', 'images'), join(dst, 'images'), { recursive: true });
  for (const dir of assets) {
    await cp(join(src, dir), join(dst, dir), { recursive: true });
  }

  const { version } = JSON.parse(await readFile(join(src, 'package.json'), 'utf8'));
  await writeFile(
    join(dst, 'VERSION'),
    `pdfjs-dist ${version}\nСодержимое каталога генерируется командой npm run vendor, руками не правится.\n`
  );
  console.log(`vendor: pdfjs-dist ${version} → extension/vendor/`);
}

await main();
