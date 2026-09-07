// Сквозная проверка вьюера в настоящем браузере.
//
// Расширение целиком здесь не проверить: Firefox с загруженным дополнением
// автоматизации не поддаётся. Зато viewer.html — обычная страница, поэтому
// поднимаем dev-сервер и гоняем чтение, прокрутку, поиск и озвучку в
// Chromium. Синтез речи подменяется заглушкой: голосов в headless нет.

import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const root = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const PORT = Number(process.env.PORT || 8123);
const BASE = `http://localhost:${PORT}`;
const VIEWER = `${BASE}/viewer.html?file=/fixtures/sample.pdf`;

const results = [];
let failures = 0;

function check(name, condition, details = '') {
  results.push({ name, ok: Boolean(condition), details });
  if (!condition) failures += 1;
  const mark = condition ? '✓' : '✗';
  console.log(`${mark} ${name}${details ? ` — ${details}` : ''}`);
}

async function waitForServer(url, attempts = 40) {
  for (let i = 0; i < attempts; i += 1) {
    try {
      const response = await fetch(url);
      if (response.ok) return true;
    } catch {
      /* ещё не поднялся */
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return false;
}

const speechMock = () => {
  const voices = [{ voiceURI: 'mock-ru', name: 'Мок', lang: 'ru-RU', default: true }];
  let current = null;
  window.spokenSentences = [];
  Object.defineProperty(window, 'speechSynthesis', {
    configurable: true,
    value: {
      getVoices: () => voices,
      speak(utterance) {
        current = utterance;
        window.spokenSentences.push(utterance.text);
        setTimeout(() => utterance.onboundary?.({ charIndex: 0, charLength: 7, name: 'word' }), 30);
        utterance._timer = setTimeout(() => {
          current = null;
          utterance.onend?.();
        }, 800);
      },
      cancel() {
        if (!current) return;
        clearTimeout(current._timer);
        const utterance = current;
        current = null;
        utterance.onerror?.({ error: 'canceled' });
      },
      pause() {},
      resume() {},
      get speaking() {
        return Boolean(current);
      },
      get paused() {
        return false;
      },
      addEventListener() {},
      removeEventListener() {},
    },
  });
  window.SpeechSynthesisUtterance = class {
    constructor(text) {
      this.text = text;
    }
  };
};

const server = spawn(process.execPath, [join(root, 'scripts', 'dev-server.mjs')], {
  env: { ...process.env, PORT: String(PORT) },
  stdio: 'ignore',
});

let browser;
try {
  if (!(await waitForServer(`${BASE}/viewer.html`))) throw new Error('dev-сервер не поднялся');

  browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium' });
  const context = await browser.newContext({ viewport: { width: 1280, height: 860 } });
  const page = await context.newPage();
  const consoleErrors = [];
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text());
  });
  page.on('pageerror', (error) => consoleErrors.push(`pageerror: ${error.message}`));
  await page.addInitScript(speechMock);

  await page.goto(VIEWER);
  await page.waitForFunction(() => window.pdfReaderApp?.pdfViewer?.pagesCount > 0, null, { timeout: 20000 });
  await page.waitForTimeout(1500);

  const pages = await page.evaluate(() => document.querySelectorAll('.pdfViewer .page').length);
  check('документ открыт', pages === 8, `страниц: ${pages}`);
  const canvases = await page.evaluate(() => document.querySelectorAll('.pdfViewer .page canvas').length);
  check('страницы отрисованы', canvases > 0, `холстов: ${canvases}`);

  // Перемотка ровно на экран с нахлёстом
  const scrollTop = () => page.evaluate(() => document.getElementById('viewerContainer').scrollTop);
  const viewportHeight = await page.evaluate(() => document.getElementById('viewerContainer').clientHeight);
  const before = await scrollTop();
  await page.keyboard.press('Space');
  await page.waitForTimeout(500);
  const moved = (await scrollTop()) - before;
  const expected = Math.round(viewportHeight * 0.92);
  check('пробел листает на экран с нахлёстом', Math.abs(moved - expected) <= 2, `${Math.round(moved)} при ожидании ${expected}`);

  await page.keyboard.press('Shift+Space');
  await page.waitForTimeout(500);
  check('обратный шаг возвращает на место', Math.abs((await scrollTop()) - before) <= 2);

  // Автопрокрутка
  await page.keyboard.press('a');
  await page.waitForTimeout(1600);
  const running = await page.evaluate(() => window.pdfReaderApp.autoScroll.running);
  const autoMoved = (await scrollTop()) - before;
  await page.keyboard.press('a');
  await page.waitForTimeout(300);
  const stopped = await page.evaluate(() => !window.pdfReaderApp.autoScroll.running);
  check('автопрокрутка идёт с заданной скоростью', running && autoMoved > 30 && autoMoved < 120, `сдвиг ${Math.round(autoMoved)} px за 1,6 с при 40 px/с`);
  check('автопрокрутка останавливается', stopped);

  // Обрезка полей и инверсия
  const scaleBefore = await page.evaluate(() => window.pdfReaderApp.pdfViewer.currentScale);
  await page.evaluate(() => window.pdfReaderApp.appearance.toggleCrop());
  await page.waitForTimeout(2500);
  const crop = await page.evaluate(() => ({
    box: window.pdfReaderApp.appearance.crop.box,
    scale: window.pdfReaderApp.pdfViewer.currentScale,
    applied: document.getElementById('app').classList.contains('crop-on'),
  }));
  check('поля определились', crop.box.left > 0.05 && crop.box.top > 0.02, JSON.stringify(crop.box));
  check('обрезка увеличила масштаб', crop.applied && crop.scale > scaleBefore, `${scaleBefore.toFixed(2)} → ${crop.scale.toFixed(2)}`);
  await page.evaluate(() => window.pdfReaderApp.appearance.toggleCrop());

  await page.keyboard.press('i');
  await page.waitForTimeout(300);
  const filter = await page.evaluate(() => document.getElementById('viewer').style.getPropertyValue('--page-filter'));
  check('инверсия включается', filter.includes('invert(1)'), filter);
  await page.keyboard.press('i');

  // Оглавление и миниатюры
  await page.evaluate(() => window.pdfReaderApp.sidebar.open('outline'));
  await page.waitForTimeout(400);
  const outlineTitles = await page.evaluate(() =>
    [...document.querySelectorAll('#outlinePanel .outline-tree > li > button')].map((button) => button.textContent)
  );
  check('оглавление прочитано', outlineTitles.length === 4, outlineTitles.join(' | '));
  await page.click('#outlinePanel .outline-tree > li:nth-child(3) > button');
  await page.waitForTimeout(700);
  const chapterPage = await page.evaluate(() => window.pdfReaderApp.pdfViewer.currentPageNumber);
  check('переход по оглавлению работает', chapterPage === 5, `страница ${chapterPage}`);

  await page.evaluate(() => window.pdfReaderApp.sidebar.open('thumbs'));
  await page.waitForTimeout(1500);
  const thumbs = await page.evaluate(() => document.querySelectorAll('#thumbsPanel canvas').length);
  check('миниатюры рисуются', thumbs > 0, `отрисовано ${thumbs}`);

  // Поиск
  await page.evaluate(() => window.pdfReaderApp.find.open());
  await page.fill('#findInput', 'overlap');
  await page.waitForTimeout(1500);
  const findStatus = await page.evaluate(() => document.getElementById('findStatus').textContent);
  const highlights = await page.evaluate(() => document.querySelectorAll('.textLayer .highlight').length);
  check('поиск находит совпадения', /из 6/.test(findStatus) && highlights > 0, `${findStatus}, подсветок ${highlights}`);
  await page.evaluate(() => window.pdfReaderApp.find.close());

  // Озвучка
  await page.evaluate(() => window.pdfReaderApp.pdfViewer.scrollPageIntoView({ pageNumber: 1 }));
  await page.waitForTimeout(500);
  await page.evaluate(() => {
    window.pdfReaderApp.tts.start();
  });
  await page.waitForTimeout(1000);
  const tts = await page.evaluate(() => ({
    state: window.pdfReaderApp.tts.state,
    spoken: window.spokenSentences.length,
    first: window.spokenSentences[0],
    sentenceBoxes: document.querySelectorAll('.tts-sentence-box').length,
    wordBoxes: document.querySelectorAll('.tts-word-box').length,
  }));
  check('озвучка читает предложениями', tts.state === 'speaking' && tts.spoken >= 1, `${tts.spoken}: ${JSON.stringify(tts.first)}`);
  check('читаемое место подсвечено', tts.sentenceBoxes > 0 && tts.wordBoxes > 0, `предложение ${tts.sentenceBoxes}, слово ${tts.wordBoxes}`);
  await page.evaluate(() => window.pdfReaderApp.tts.stop());
  await page.waitForTimeout(300);
  const cleared = await page.evaluate(() => document.querySelectorAll('.tts-sentence-box').length);
  check('после остановки подсветка убрана', cleared === 0);

  // Память места чтения
  await page.evaluate(() => window.pdfReaderApp.setZoom('page-width'));
  await page.waitForTimeout(400);
  await page.evaluate(() => window.pdfReaderApp.pdfViewer.scrollPageIntoView({ pageNumber: 4 }));
  await page.waitForTimeout(2200);
  const savedTop = await page.evaluate(() => Math.round(window.pdfReaderApp.container.scrollTop));
  await page.evaluate(() => window.pdfReaderApp.bookmarks.addHere());
  await page.waitForTimeout(600);

  await page.reload();
  await page.waitForFunction(() => window.pdfReaderApp?.pdfViewer?.pagesCount > 0, null, { timeout: 20000 });
  await page.waitForTimeout(2500);
  const restoredTop = await page.evaluate(() => Math.round(window.pdfReaderApp.container.scrollTop));
  const restoredPage = await page.evaluate(() => window.pdfReaderApp.pdfViewer.currentPageNumber);
  check('место чтения восстановлено', Math.abs(restoredTop - savedTop) <= 20 && restoredPage === 4, `${savedTop} → ${restoredTop}, страница ${restoredPage}`);

  const bookmarks = await page.evaluate(() => window.pdfReaderApp.readingState.record?.bookmarks?.length || 0);
  check('закладка сохранилась', bookmarks === 1, `закладок: ${bookmarks}`);

  const recent = await page.evaluate(() => document.querySelectorAll('#welcomeRecent li').length);
  check('документ попал в недавние', recent >= 1, `записей: ${recent}`);

  check('в консоли нет ошибок', consoleErrors.length === 0, consoleErrors.join(' | '));
} catch (error) {
  failures += 1;
  console.error('✗ проверка прервана:', error);
} finally {
  await browser?.close();
  server.kill();
}

console.log(`\nпройдено ${results.filter((item) => item.ok).length} из ${results.length}`);
process.exit(failures ? 1 : 0);
