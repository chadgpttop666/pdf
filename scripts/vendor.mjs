// Копирует нужные куски pdfjs-dist, ONNX Runtime и фонемизатора Piper в
// extension/vendor/, чтобы расширение устанавливалось из репозитория без
// npm install. Загружать код из сети расширению нельзя — всё, что исполняется
// (включая WASM), должно лежать внутри.
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
const ortSrc = join(root, 'node_modules', 'onnxruntime-web', 'dist');
const piperSrc = join(root, 'node_modules', '@diffusionstudio', 'piper-wasm', 'build');

// ONNX Runtime: только CPU-сборка на WASM. Потоки в расширении недоступны
// (нет cross-origin isolation), поэтому работает однопоточно.
const ortFiles = ['ort.wasm.min.mjs', 'ort-wasm-simd-threaded.mjs', 'ort-wasm-simd-threaded.wasm'];

// Из словарей espeak-ng берём только нужные языки: все вместе весят 18 МБ,
// русский с английским — около 9.
const ESPEAK_DICTS = new Set(['ru_dict', 'en_dict']);

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

/**
 * Линтер AMO не разбирает регулярные выражения с флагом v (ES2024) и из-за
 * одного такого литерала в pdf.js отказывает в подписи. Firefox флаг
 * понимает, поэтому превращаем литерал в вызов конструктора с тем же
 * исходником: поведение то же, а парсеру линтера разбирать нечего.
 */
function rewriteUnicodeSetsRegexes(code) {
  return code.replace(/= \/((?:[^/\\\n]|\\.)+)\/([dgimsuy]*v[dgimsuy]*);/g, (_, source, flags) => {
    if (source.includes('`') || source.includes('${')) throw new Error('Регулярное выражение не переносится в String.raw');
    return `= new RegExp(String.raw\`${source}\`, "${flags}");`;
  });
}

/** Фонемизатор Piper: ES-модуль из сборки Emscripten и урезанный пакет данных. */
async function vendorPiper() {
  const out = join(dst, 'piper');
  await mkdir(out, { recursive: true });
  const code = await readFile(join(piperSrc, 'piper_phonemize.js'), 'utf8');
  const data = await readFile(join(piperSrc, 'piper_phonemize.data'));

  const match = code.match(/loadPackage\((\{"files":.*?"remote_package_size":\d+\})\)/);
  if (!match) throw new Error('Не найдено описание пакета данных в piper_phonemize.js');
  const meta = JSON.parse(match[1]);
  const kept = meta.files.filter((file) => {
    const name = file.filename.split('/').pop();
    return !name.endsWith('_dict') || ESPEAK_DICTS.has(name);
  });
  const chunks = [];
  let offset = 0;
  const files = kept.map((file) => {
    const bytes = data.subarray(file.start, file.end);
    chunks.push(bytes);
    const entry = { ...file, start: offset, end: offset + bytes.length };
    offset += bytes.length;
    return entry;
  });
  const packed = { ...meta, files, remote_package_size: offset };

  const module = code
    .replace(match[0], `loadPackage(${JSON.stringify(packed)})`)
    // Хвост UMD не нужен: модуль подключается через import.
    .replace(/\nif \(typeof exports === 'object'[\s\S]*$/, '\n')
    .concat('export default createPiperPhonemize;\n');
  await writeFile(join(out, 'piper_phonemize.mjs'), module);
  await writeFile(join(out, 'piper_phonemize.data'), Buffer.concat(chunks));
  await cp(join(piperSrc, 'piper_phonemize.wasm'), join(out, 'piper_phonemize.wasm'));
  return offset;
}

async function vendorOrt() {
  const out = join(dst, 'ort');
  await mkdir(out, { recursive: true });
  for (const file of ortFiles) {
    if (file.endsWith('.mjs')) {
      const code = await readFile(join(ortSrc, file), 'utf8');
      await writeFile(join(out, file), code.replace(/\/\/# sourceMappingURL=\S*\s*$/, ''));
    } else {
      await cp(join(ortSrc, file), join(out, file));
    }
  }
}

async function main() {
  if (!existsSync(src)) {
    console.error('Нет node_modules/pdfjs-dist — сначала выполните npm install');
    process.exit(1);
  }

  await rm(dst, { recursive: true, force: true });
  await mkdir(dst, { recursive: true });

  for (const [from, to] of scripts) {
    const code = await readFile(join(src, from), 'utf8');
    const cleaned = rewriteUnicodeSetsRegexes(code.replace(/^\/\/# sourceMappingURL=.*$/m, ''));
    await writeFile(join(dst, to), cleaned);
  }

  await cp(join(src, 'legacy', 'web', 'pdf_viewer.css'), join(dst, 'pdf_viewer.css'));
  await cp(join(src, 'legacy', 'web', 'images'), join(dst, 'images'), { recursive: true });
  for (const dir of assets) {
    await cp(join(src, dir), join(dst, dir), { recursive: true });
  }

  await vendorOrt();
  const espeakBytes = await vendorPiper();

  const versionOf = async (dir) => JSON.parse(await readFile(join(dir, 'package.json'), 'utf8')).version;
  const versions = [
    `pdfjs-dist ${await versionOf(src)}`,
    `onnxruntime-web ${await versionOf(dirname(ortSrc))}`,
    `@diffusionstudio/piper-wasm ${await versionOf(dirname(piperSrc))} (espeak-ng: ${[...ESPEAK_DICTS].join(', ')})`,
  ];
  await writeFile(
    join(dst, 'VERSION'),
    `${versions.join('\n')}\nСодержимое каталога генерируется командой npm run vendor, руками не правится.\n`
  );
  console.log(`vendor: ${versions.join('; ')} → extension/vendor/ (данные espeak ${(espeakBytes / 1e6).toFixed(1)} МБ)`);
}

await main();
