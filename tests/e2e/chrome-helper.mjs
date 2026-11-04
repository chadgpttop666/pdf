// Ускоритель в Chrome — путь человека: «Установить» в настройках → читалка
// скачивает программу и сверяет SHA-256 → «Запустить установку» → программа
// ставит себя → карточка «Работает».
//
// Вместо GitHub отдаётся локальная сборка (native/target/release/pdf-reader-tts),
// её хэш вписывается в копию расширения (src/tts/helper-release.js). Скачанный
// файл «запускает человек» — тест, с --install --quiet, во временном HOME.
// Сначала: npm run build:chrome и cargo build --release в native/.

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const root = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const HELPER = process.env.HELPER_BIN || join(root, 'native', 'target', 'release', 'pdf-reader-tts');

const results = [];
function check(name, condition, details = '') {
  results.push(Boolean(condition));
  console.log(`${condition ? '✓' : '✗'} ${name}${details ? ` — ${details}` : ''}`);
}

if (!existsSync(HELPER)) {
  console.log(`· нет ${HELPER} — соберите ускоритель: cd native && cargo build --release`);
  process.exit(0);
}

const work = mkdtempSync(join(tmpdir(), 'pdf-reader-helper-'));
const home = join(work, 'home');
const profile = join(work, 'profile');
const extension = join(work, 'extension');
for (const dir of [home, profile]) mkdirSync(dir, { recursive: true });
cpSync(join(root, 'dist', 'chrome'), extension, { recursive: true });

const binary = readFileSync(HELPER);
const sha256 = createHash('sha256').update(binary).digest('hex');
const version = spawnSync(HELPER, ['--version'], { encoding: 'utf8' }).stdout.trim();
const releaseFile = join(extension, 'src', 'tts', 'helper-release.js');
writeFileSync(
  releaseFile,
  readFileSync(releaseFile, 'utf8')
    .replace(/version: '[\d.]+'/, `version: '${version}'`)
    .replace(/linux: \{[^}]+\}/, `linux: { name: 'pdf-reader-tts-linux', size: ${binary.length}, sha256: '${sha256}' }`)
);

const env = {
  ...process.env,
  HOME: home,
  XDG_DATA_HOME: join(home, '.local', 'share'),
  XDG_CONFIG_HOME: join(home, '.config'),
  PDF_TTS_BROWSER_DIRS: profile,
};
const errors = [];
let context;
try {
  context = await chromium.launchPersistentContext(profile, {
    channel: 'chromium',
    headless: true,
    acceptDownloads: true,
    env,
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
  });
  const fetched = [];
  await context.route('https://github.com/**', (route) => {
    const url = route.request().url();
    fetched.push(url);
    if (url.endsWith(`/helper-v${version}/pdf-reader-tts-linux`)) route.fulfill({ status: 200, body: binary, contentType: 'application/octet-stream' });
    else route.fulfill({ status: 404, body: '' });
  });
  const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker', { timeout: 15000 }));
  const base = worker.url().replace(/\/background\.js$/, '');
  const page = await context.newPage();
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(`${base}/viewer.html`);
  await page.waitForFunction(() => window.pdfReaderApp, null, { timeout: 20000 });
  await page.click('#btnSettings');
  const card = page.locator('.tera-helper');
  const status = async () => (await card.locator('.piper-actions').textContent()) ?? '';
  const until = async (pattern, ms = 30000) => {
    for (let waited = 0; waited < ms && !pattern.test(await status()); waited += 500) await page.waitForTimeout(500);
    return status();
  };

  await card.getByRole('button', { name: 'Установить' }).waitFor({ timeout: 10000 });
  check('без ускорителя — кнопка «Установить», без вопроса о разрешениях', /Не установлен/.test(await status()), await status());

  await card.getByRole('button', { name: 'Установить' }).click();
  const ready = await until(/Запустить установку|Не получилось|Без разрешения/);
  check('«Установить»: программа скачана с GitHub и сверена', /Запустить установку/.test(ready) && fetched.some((url) => url.includes(`helper-v${version}`)), ready);

  const [download] = await worker.evaluate(() => chrome.downloads.search({ orderBy: ['-startTime'] }));
  check('установщик лежит в загрузках', download?.state === 'complete' && existsSync(download.filename), JSON.stringify({ state: download?.state, danger: download?.danger }));

  await card.getByRole('button', { name: 'Запустить установку' }).click();
  await page.waitForTimeout(1000);
  // Человек открывает скачанный файл.
  chmodSync(download.filename, 0o755);
  const run = spawnSync(download.filename, ['--install', '--quiet'], { env, encoding: 'utf8' });
  check('скачанный файл ставит ускоритель и регистрирует его для Chrome', run.status === 0 && existsSync(join(profile, 'NativeMessagingHosts', 'pdf_reader_tts.json')), run.stderr.trim());

  const working = await until(/Работает/);
  check('карточка: «Работает», кнопка «Удалить»', /Работает \(версия [\d.]+\)/.test(working) && (await card.getByRole('button', { name: 'Удалить' }).count()) === 1, working);

  check('без ошибок на странице', errors.length === 0, errors.slice(0, 3).join(' | '));
} catch (error) {
  results.push(false);
  console.error('✗ проверка прервана:', error);
} finally {
  await context?.close();
  rmSync(work, { recursive: true, force: true });
}

const passed = results.filter(Boolean).length;
console.log(`\nпройдено ${passed} из ${results.length}`);
process.exit(passed === results.length ? 0 : 1);
