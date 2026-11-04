// Ускоритель и автообновление в Chrome — в настоящем Chromium, с настоящим
// ускорителем (native/target/release/pdf-reader-tts, собранным под Linux).
//
// Ускоритель ставится во временный HOME, браузер — со своим профилем; новые
// версии расширения (9.9.9, 9.9.10, 9.9.11) раздаёт маленький сервер вместо
// GitHub. Проверяется:
// - браузер запускает ускоритель, ID расширения постоянный (ключ);
// - «Обновить сейчас» при открытой вкладке: версия встаёт, вкладка
//   открывается снова, место чтения на месте;
// - само, без участия человека: пока открыта вкладка — ждёт, закрыли —
//   встаёт;
// - галочка выключена: только «вышла версия», ставит кнопка в настройках.
// Сначала: npm run build:chrome и cargo build --release в native/.

import { spawn, spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { buildChrome, chromeKey } from '../../scripts/build-chrome.mjs';
import { chromeExtensionId } from '../../scripts/make-chrome-key.mjs';

const root = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const HELPER = process.env.HELPER_BIN || join(root, 'native', 'target', 'release', 'pdf-reader-tts');
const PORT = Number(process.env.PORT || 8128);
const BASE = `http://localhost:${PORT}`;
const UPDATES_PORT = PORT + 1;

const results = [];
function check(name, condition, details = '') {
  results.push(Boolean(condition));
  console.log(`${condition ? '✓' : '✗'} ${name}${details ? ` — ${details}` : ''}`);
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

if (!existsSync(HELPER)) {
  console.log(`· нет ${HELPER} — соберите ускоритель: cd native && cargo build --release`);
  process.exit(0);
}

const work = mkdtempSync(join(tmpdir(), 'pdf-reader-update-'));
const home = join(work, 'home');
const profile = join(work, 'profile');
const extension = join(work, 'extension');
const releases = join(work, 'releases');
for (const dir of [home, profile, releases]) mkdirSync(dir, { recursive: true });
cpSync(join(root, 'dist', 'chrome'), extension, { recursive: true });
const env = {
  ...process.env,
  HOME: home,
  XDG_DATA_HOME: join(home, '.local', 'share'),
  XDG_CONFIG_HOME: join(home, '.config'),
  // Ускоритель ищет профили браузера и здесь (браузер — со своей папкой профиля).
  PDF_TTS_BROWSER_DIRS: profile,
};

// «GitHub»: описание релиза и архивы версий.
let published = null;
const updates = createServer((req, res) => {
  if (req.url === '/updates-chrome.json' && published) {
    res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(published));
    return;
  }
  const file = join(releases, decodeURIComponent(req.url.slice(1)));
  if (req.url.endsWith('.zip') && existsSync(file)) res.writeHead(200, { 'Content-Type': 'application/zip' }).end(readFileSync(file));
  else res.writeHead(404).end();
});
await new Promise((resolve) => updates.listen(UPDATES_PORT, resolve));
function publish(version) {
  const build = buildChrome({ outDir: releases, version, dirName: `v${version}` });
  published = { version, url: `http://localhost:${UPDATES_PORT}/${build.zip.split('/').pop()}`, sha256: build.sha256 };
}

const server = spawn(process.execPath, [join(root, 'scripts', 'dev-server.mjs')], { env: { ...process.env, PORT: String(PORT) }, stdio: 'ignore' });
let context;
try {
  const installed = spawnSync(HELPER, ['--install', '--quiet'], { env, encoding: 'utf8' });
  check('ускоритель ставится и регистрируется для браузера', installed.status === 0 && existsSync(join(profile, 'NativeMessagingHosts', 'pdf_reader_tts.json')), installed.stderr.trim());

  context = await chromium.launchPersistentContext(profile, {
    channel: 'chromium',
    headless: true,
    env,
    viewport: { width: 1280, height: 860 },
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
  });
  let worker = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker', { timeout: 15000 }));
  const origin = worker.url().replace(/\/background\.js$/, '');
  // Режим разработчика — как у человека, который загрузил распакованное
  // расширение: без него Chrome отключает такое расширение при перезапуске.
  const settingsPage = await context.newPage();
  await settingsPage.goto('chrome://extensions');
  await settingsPage.evaluate(() => chrome.developerPrivate.updateProfileConfiguration({ inDeveloperMode: true }));
  await settingsPage.close();
  check('ID расширения постоянный — по ключу из chrome/key.txt', origin === `chrome-extension://${chromeExtensionId(chromeKey())}`, origin);

  const helper = (message) =>
    worker.evaluate(
      (payload) =>
        new Promise((resolve) => {
          const port = chrome.runtime.connectNative('pdf_reader_tts');
          port.onMessage.addListener((reply) => {
            resolve(reply);
            port.disconnect();
          });
          port.onDisconnect.addListener(() => resolve({ error: chrome.runtime.lastError?.message }));
          port.postMessage({ ...payload, id: 1 });
        }),
      message
    );
  const hello = await helper({ type: 'hello' });
  check('Chrome запускает ускоритель (native messaging)', hello.version && hello.features?.includes('ext-update'), JSON.stringify({ version: hello.version, error: hello.error }));

  // Chrome пишет настройки профиля на диск не сразу — ждём, пока ускоритель увидит папку.
  let paths = [];
  for (let i = 0; i < 40 && !paths.length; i += 1) {
    paths = (await helper({ type: 'ext-paths' })).paths ?? [];
    if (!paths.length) await sleep(1000);
  }
  check('ускоритель находит папку расширения в настройках браузера', paths[0]?.path === extension, JSON.stringify(paths));

  const version = () => worker.evaluate(() => chrome.runtime.getManifest().version);
  const state = () => worker.evaluate(async () => (await chrome.storage.local.get('updateState')).updateState ?? {});
  await worker.evaluate((url) => chrome.storage.local.set({ chromeUpdateUrl: url }), `http://localhost:${UPDATES_PORT}/updates-chrome.json`);
  // После перезапуска расширения — его новый service worker нужной версии.
  const restarted = async (expected) => {
    const started = Date.now();
    while (Date.now() - started < 90000) {
      for (const candidate of context.serviceWorkers()) {
        if ((await candidate.evaluate(() => chrome.runtime.getManifest().version).catch(() => null)) === expected) return candidate;
      }
      await sleep(500);
    }
    throw new Error(`service worker версии ${expected} не появился`);
  };

  // ── 1. «Обновить сейчас» при открытой вкладке ──
  const viewerUrl = `${origin}/viewer.html?file=${encodeURIComponent(`${BASE}/fixtures/sample.pdf`)}`;
  let page = await context.newPage();
  await page.goto(viewerUrl);
  await page.waitForFunction(() => window.pdfReaderApp?.readingState?.record && window.pdfReaderApp.pdfViewer.pagesCount > 0, null, { timeout: 20000 });
  await page.evaluate(async () => {
    window.pdfReaderApp.pdfViewer.scrollPageIntoView({ pageNumber: 3 });
    await new Promise((resolve) => setTimeout(resolve, 500));
    await window.pdfReaderApp.readingState.save();
  });
  publish('9.9.9');
  await worker
    .evaluate(() => {
      globalThis.pdfReaderBackground.checkForUpdate({ force: true, install: true });
    })
    .catch(() => {});
  worker = await restarted('9.9.9');
  const onDisk = JSON.parse(readFileSync(join(extension, 'manifest.json'), 'utf8')).version;
  check('«Обновить сейчас»: новая версия в папке и в браузере', onDisk === '9.9.9' && (await version()) === '9.9.9', `${onDisk} / ${await version()}`);
  let reopened = null;
  for (let i = 0; i < 40 && !reopened; i += 1) {
    reopened = context.pages().find((candidate) => candidate.url().startsWith(`${origin}/viewer.html`));
    if (!reopened) await sleep(250);
  }
  let resumed = null;
  if (reopened) {
    await reopened.waitForFunction(() => window.pdfReaderApp?.readingState?.record && window.pdfReaderApp.pdfViewer.pagesCount > 0, null, { timeout: 20000 });
    await reopened.waitForFunction(() => !document.getElementById('app').classList.contains('booting'), null, { timeout: 10000 }).catch(() => {});
    resumed = await reopened.evaluate(() => window.pdfReaderApp.pdfViewer.currentPageNumber);
  }
  check('вкладка читалки открылась снова, место чтения сохранилось', resumed === 3, `страница ${resumed}`);

  // ── 2. Само, без участия человека: ждёт закрытия вкладок ──
  publish('9.9.10');
  await worker.evaluate(() => globalThis.pdfReaderBackground.checkForUpdate({ force: true }));
  const waiting = await state();
  check('пока открыта вкладка читалки — версия ждёт', waiting.status === 'waiting' && (await version()) === '9.9.9', JSON.stringify({ status: waiting.status, message: waiting.message }));
  for (const candidate of context.pages()) if (candidate.url().startsWith(origin)) await candidate.close();
  worker = await restarted('9.9.10');
  check('закрыли вкладку — новая версия встала сама', (await version()) === '9.9.10', await version());

  // ── 3. Галочка выключена: только сообщить; поставить — кнопкой ──
  await worker.evaluate(async () => {
    const { 'settings.v1': settings = {} } = await chrome.storage.local.get('settings.v1');
    await chrome.storage.local.set({ 'settings.v1': { ...settings, autoUpdate: false } });
  });
  publish('9.9.11');
  await worker.evaluate(() => globalThis.pdfReaderBackground.checkForUpdate({ force: true }));
  const offered = await state();
  check('без галочки — только «вышла версия», ничего не ставится', offered.status === 'available' && (await version()) === '9.9.10', JSON.stringify({ status: offered.status }));
  page = await context.newPage();
  await page.goto(`${origin}/viewer.html`);
  await page.waitForFunction(() => window.pdfReaderApp?.pdfViewer, null, { timeout: 20000 });
  await page.click('#btnSettings');
  await page.waitForFunction(() => /9\.9\.11/.test(document.querySelector('.updates')?.textContent ?? ''), null, { timeout: 10000 }).catch(() => {});
  const card = await page.evaluate(() => ({
    text: document.querySelector('.updates')?.textContent ?? '',
    button: document.querySelector('.updates button')?.textContent ?? '',
    autoBox: [...document.querySelectorAll('#settingsGrid .setting')].find((row) => /Обновлять читалку автоматически/.test(row.textContent))?.querySelector('input')?.checked,
  }));
  check('в настройках: версия, «Вышла версия 9.9.11», «Обновить сейчас», галочка снята', /9\.9\.11/.test(card.text) && card.button === 'Обновить сейчас' && card.autoBox === false, JSON.stringify(card).slice(0, 220));
  await page.click('.updates button').catch(() => {});
  worker = await restarted('9.9.11');
  check('кнопка «Обновить сейчас» ставит версию', (await version()) === '9.9.11', await version());
} catch (error) {
  results.push(false);
  console.error('✗ проверка прервана:', error);
} finally {
  await context?.close().catch(() => {});
  server.kill();
  updates.close();
  rmSync(work, { recursive: true, force: true });
}

const passed = results.filter(Boolean).length;
console.log(`\nпройдено ${passed} из ${results.length}`);
process.exit(passed === results.length ? 0 : 1);
