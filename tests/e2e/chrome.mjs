// Сборка для Chrome — в настоящем Chromium, загруженная как расширение.
//
// smoke.mjs гоняет вьюер обычной веб-страницей; здесь — то, что есть только у
// расширения: service worker, перехват PDF правилами declarativeNetRequest,
// страницы chrome-extension://, хранилище расширения, скрипт озвучки на сайте.
// Сначала: node scripts/build-chrome.mjs (или npm run build:chrome).

import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const root = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const EXTENSION = process.env.CHROME_BUILD || join(root, 'dist', 'chrome');
const PORT = Number(process.env.PORT || 8126);
const BASE = `http://localhost:${PORT}`;

const results = [];
function check(name, condition, details = '') {
  results.push(Boolean(condition));
  console.log(`${condition ? '✓' : '✗'} ${name}${details ? ` — ${details}` : ''}`);
}

async function waitForServer(url, attempts = 40) {
  for (let i = 0; i < attempts; i += 1) {
    try {
      if ((await fetch(url)).ok) return true;
    } catch {
      /* ещё не поднялся */
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return false;
}

const server = spawn(process.execPath, [join(root, 'scripts', 'dev-server.mjs')], { env: { ...process.env, PORT: String(PORT) }, stdio: 'ignore' });
const profile = mkdtempSync(join(tmpdir(), 'pdf-reader-chrome-'));
let context;
const errors = [];
try {
  if (!(await waitForServer(`${BASE}/viewer.html`))) throw new Error('dev-сервер не поднялся');
  context = await chromium.launchPersistentContext(profile, {
    // Полный Chromium в новом headless: урезанная сборка headless shell расширений не грузит.
    channel: 'chromium',
    headless: true,
    viewport: { width: 1280, height: 860 },
    args: [`--disable-extensions-except=${EXTENSION}`, `--load-extension=${EXTENSION}`],
  });
  const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker', { timeout: 15000 }));
  // new URL(...).origin у chrome-extension:// в Node — «null»: берём начало адреса сами.
  const extensionUrl = worker.url().replace(/\/background\.js$/, '');
  check('расширение загрузилось, service worker запущен', worker.url().endsWith('/background.js'), worker.url());

  // Правила перехвата ставятся после чтения настроек — подождать.
  let rules = [];
  for (let i = 0; i < 40 && rules.length < 2; i += 1) {
    rules = await worker.evaluate(() => chrome.declarativeNetRequest.getDynamicRules());
    if (rules.length < 2) await new Promise((resolve) => setTimeout(resolve, 250));
  }
  check('правила перехвата PDF установлены', rules.length === 2, JSON.stringify(rules.map((rule) => rule.condition.responseHeaders?.[0]?.values?.[0])));

  // Пункты меню созданы при установке: повторное создание с тем же id — ошибка.
  const menus = await worker.evaluate(() =>
    Promise.all(
      ['open-link-in-reader', 'open-page-in-reader', 'speak-selection', 'open-reader'].map(
        (id) => new Promise((resolve) => chrome.contextMenus.create({ id, title: 'проверка', contexts: ['page'] }, () => resolve(chrome.runtime.lastError?.message ?? 'создан заново')))
      )
    )
  );
  check('пункты контекстного меню созданы при установке', menus.every((message) => /duplicate/i.test(message)), menus.join(' | '));

  const page = await context.newPage();
  page.on('pageerror', (error) => errors.push(`страница: ${error.message}`));
  page.on('console', (message) => {
    if (message.type() !== 'error') return;
    errors.push(`консоль: ${message.text()}`);
    if (process.env.DEBUG) console.log('  консоль:', message.text().slice(0, 300));
  });
  const opened = async (url) => {
    await page.goto(url);
    await page.waitForURL((current) => current.href.startsWith(extensionUrl), { timeout: 10000 }).catch(() => {});
    if (!page.url().startsWith(extensionUrl)) return { url: page.url(), pages: 0 };
    await page.waitForFunction(() => window.pdfReaderApp?.pdfViewer?.pagesCount > 0, null, { timeout: 20000 }).catch(() => {});
    return page.evaluate(() => ({ url: location.href, pages: window.pdfReaderApp?.pdfViewer?.pagesCount ?? 0, name: window.pdfReaderApp?.readingState?.record?.name }));
  };

  const plain = await opened(`${BASE}/fixtures/sample.pdf`);
  check('ссылка на PDF открывается в читалке, а не во встроенном просмотре', plain.url.startsWith(`${extensionUrl}/viewer.html?src=`) && plain.pages === 8, JSON.stringify(plain));

  const query = await opened(`${BASE}/fixtures/sample.pdf?a=1&b=два`);
  check('адрес с ? и & доходит до читалки целиком', query.pages === 8 && decodeURIComponent(query.url).includes('sample.pdf?a=1&b=два'), query.url);

  const octet = await opened(`${BASE}/octet/kniga.pdf`);
  check('PDF как поток байтов (octet-stream) с .pdf в адресе — тоже в читалку', octet.pages === 6, JSON.stringify(octet));

  // Локальный файл: в Chrome — если расширению разрешён доступ к файлам.
  const fileAccess = await worker.evaluate(() => chrome.extension.isAllowedFileSchemeAccess());
  if (fileAccess) {
    const local = await opened(`file://${join(root, 'tests', 'fixtures', 'sample.pdf')}`);
    check('локальный PDF (file://) при доступе к файлам — в читалке', local.url.startsWith(`${extensionUrl}/viewer.html?file=file`) && local.pages === 8, JSON.stringify(local));
  } else {
    console.log('· доступ к файлам выключен — локальный PDF не проверяю');
  }

  // Скачивание просили явно — не перехватываем: браузер скачивает файл.
  const downloadPage = await context.newPage();
  const download = downloadPage.waitForEvent('download', { timeout: 8000 }).catch(() => null);
  await downloadPage.goto(`${BASE}/attachment/kniga.pdf`).catch(() => {});
  const downloaded = await download;
  check('Content-Disposition: attachment — скачивается, а не открывается в читалке', Boolean(downloaded) && !downloadPage.url().startsWith(extensionUrl), downloadPage.url());
  await downloadPage.close();

  // Библиотека и настройки — в хранилище расширения: место чтения возвращается.
  await page.goto(`${extensionUrl}/viewer.html?file=${encodeURIComponent(`${BASE}/fixtures/sample.pdf`)}`);
  await page.waitForFunction(() => window.pdfReaderApp?.readingState?.record && window.pdfReaderApp.pdfViewer.pagesCount > 0, null, { timeout: 20000 });
  await page.evaluate(async () => {
    window.pdfReaderApp.pdfViewer.scrollPageIntoView({ pageNumber: 5 });
    await new Promise((resolve) => setTimeout(resolve, 500));
    await window.pdfReaderApp.readingState.save();
  });
  await page.reload();
  await page.waitForFunction(() => window.pdfReaderApp?.readingState?.record && window.pdfReaderApp.pdfViewer.pagesCount > 0, null, { timeout: 20000 });
  await page.waitForFunction(() => !document.getElementById('app').classList.contains('booting'), null, { timeout: 10000 }).catch(() => {});
  const resumed = await page.evaluate(() => window.pdfReaderApp.pdfViewer.currentPageNumber);
  check('место чтения сохраняется в библиотеке расширения', resumed === 5, `страница ${resumed}`);

  // Ускоритель ставится и в Chrome; раздел «Обновления» — с версией и галочкой.
  await page.click('#btnSettings');
  await page.waitForFunction(() => /Не установлен/.test(document.querySelector('.tera-helper')?.textContent ?? ''), null, { timeout: 8000 }).catch(() => {});
  const settings = await page.evaluate(() => {
    const card = document.querySelector('.tera-helper');
    return {
      helper: card?.textContent ?? '',
      buttons: [...(card?.querySelectorAll('button') ?? [])].map((button) => button.textContent.trim()),
      updates: document.querySelector('.updates')?.textContent ?? '',
      auto: [...document.querySelectorAll('#settingsGrid .setting')].find((row) => /Обновлять читалку автоматически/.test(row.textContent))?.querySelector('input')?.checked,
    };
  });
  check(
    'настройки: ускоритель ставится кнопкой «Установить», «Обновления» — с версией и включённой галочкой',
    settings.buttons.includes('Установить') && /PDF-читалка \d/.test(settings.updates) && settings.auto === true,
    JSON.stringify({ buttons: settings.buttons, updates: settings.updates.slice(0, 60), auto: settings.auto })
  );
  await page.keyboard.press('Escape');

  // Правка и «Скачать» с правками.
  await page.keyboard.press('KeyE');
  await page.click('#editText');
  await page.waitForFunction(() => window.pdfReaderApp.pdfViewer.annotationEditorMode === 3);
  const box = await page.locator('.page[data-page-number="5"]').boundingBox();
  await page.mouse.click(box.x + 120, Math.max(box.y, 0) + 200);
  await page.waitForFunction(() => document.activeElement?.classList.contains('internal'));
  await page.keyboard.type('Заметка в Chrome');
  await page.keyboard.press('Escape');
  await page.click('#editDone');
  const [saved] = await Promise.all([page.waitForEvent('download', { timeout: 15000 }), page.keyboard.press('Control+s')]);
  check('«Скачать» с правками работает', saved.suggestedFilename().endsWith('.pdf'), saved.suggestedFilename());

  // Озвучка выделенного на обычном сайте: скрипт на странице и плашка в углу.
  const site = await context.newPage();
  site.on('pageerror', (error) => errors.push(`сайт: ${error.message}`));
  await site.goto(`${BASE}/fixtures/site.html`);
  await site.evaluate(() => {
    const paragraph = document.querySelector('p');
    const range = document.createRange();
    range.selectNodeContents(paragraph);
    getSelection().removeAllRanges();
    getSelection().addRange(range);
  });
  await worker.evaluate(async (url) => {
    const [tab] = await chrome.tabs.query({ url });
    await globalThis.pdfReaderBackground.speakSelection(tab);
  }, `${BASE}/fixtures/site.html`);
  await site.waitForTimeout(1500);
  const pill = site.frames().find((frame) => frame.url().startsWith(`${extensionUrl}/speak-pill.html`));
  check('выделенное на сайте: скрипт встал, плашка озвучки в углу', Boolean(pill), site.frames().map((frame) => frame.url()).join(' | '));

  check('без ошибок на страницах', errors.length === 0, errors.slice(0, 5).join(' | '));
} catch (error) {
  results.push(false);
  console.error('✗ проверка прервана:', error);
} finally {
  await context?.close();
  server.kill();
  rmSync(profile, { recursive: true, force: true });
}

const passed = results.filter(Boolean).length;
console.log(`\nпройдено ${passed} из ${results.length}`);
process.exit(passed === results.length ? 0 : 1);
