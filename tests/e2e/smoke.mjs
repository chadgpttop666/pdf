// Сквозная проверка вьюера в настоящем браузере.
//
// Расширение целиком здесь не проверить: Firefox с загруженным дополнением
// автоматизации не поддаётся. Зато viewer.html — обычная страница, поэтому
// поднимаем dev-сервер и гоняем чтение, прокрутку, поиск и озвучку в
// Chromium. Синтез речи подменяется заглушкой: голосов в headless нет.

import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
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
    // Скачивание голоса с HuggingFace: в среде тестов сеть может быть закрыта —
    // это проверяется отдельно, по сообщению на панели озвучки.
    if (message.location()?.url?.includes('huggingface.co')) return;
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
    [...document.querySelectorAll('#outlinePanel > .outline-tree > li > .outline-row .outline-title')].map(
      (button) => button.textContent
    )
  );
  check('оглавление прочитано', outlineTitles.length === 4, outlineTitles.join(' | '));
  await page.click('#outlinePanel > .outline-tree > li:nth-child(3) > .outline-row .outline-title');
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

  // Скачивание: сохраняется исходный PDF, а не страница вьюера
  const original = readFileSync(join(root, 'tests', 'fixtures', 'sample.pdf'));
  for (const [how, trigger] of [
    ['кнопкой', () => page.click('#btnDownload')],
    ['по Ctrl+S', () => page.keyboard.press('Control+KeyS')],
  ]) {
    const [download] = await Promise.all([page.waitForEvent('download', { timeout: 5000 }), trigger()]);
    const saved = readFileSync(await download.path());
    check(
      `PDF скачивается ${how}`,
      download.suggestedFilename() === 'sample.pdf' && saved.equals(original),
      `${download.suggestedFilename()}, ${saved.length} из ${original.length} байт`
    );
  }

  // ── Книжная вёрстка на русском: здесь всплывало то, чего не видно на простом PDF ──
  await page.goto(`${BASE}/viewer.html?file=/fixtures/russian.pdf`);
  await page.waitForFunction(() => window.pdfReaderApp?.pdfViewer?.pagesCount > 0, null, { timeout: 20000 });
  await page.waitForTimeout(1500);

  // Оглавление: цепочки одинаковых заголовков схлопнуты, у пунктов номера страниц
  await page.evaluate(() => window.pdfReaderApp.sidebar.open('outline'));
  await page.waitForTimeout(900);
  // Как в настоящей книге: сверху название, главы — уровнем ниже.
  const ruOutline = await page.evaluate(() =>
    [...document.querySelectorAll('#outlinePanel > .outline-tree > li > .outline-tree > li')].map((li) => ({
      title: li.querySelector(':scope > .outline-row .outline-title').textContent,
      page: li.querySelector(':scope > .outline-row .outline-page').textContent,
      children: [...li.querySelectorAll(':scope > .outline-tree > li > .outline-row .outline-title')].map(
        (button) => button.textContent
      ),
    }))
  );
  check(
    'оглавление без повторяющихся уровней',
    ruOutline.length === 4 && ruOutline.every((entry) => entry.children.length && entry.children.every((t) => t === '* * *')),
    ruOutline.map((entry) => `${entry.title} [${entry.children.length}]`).join(' | ')
  );
  check('у пунктов оглавления есть номера страниц', ruOutline.every((entry) => /^\d+$/.test(entry.page)), ruOutline.map((entry) => entry.page).join(', '));

  const overflow = await page.evaluate(() => {
    const container = window.pdfReaderApp.container;
    return container.scrollWidth - container.clientWidth;
  });
  check('«по ширине» пересчитывается при открытой боковой панели', overflow <= 2, `лишняя ширина ${overflow}px`);
  await page.evaluate(() => window.pdfReaderApp.sidebar.toggle(false));
  await page.waitForTimeout(500);

  // Колонтитул, номер страницы и сноска не попадают в текст для чтения
  const page3 = await page.evaluate(async () => {
    const textPage = await window.pdfReaderApp.tts.textIndex.page(3);
    return textPage.text;
  });
  check(
    'колонтитул, номер страницы и сноска не читаются',
    !page3.includes('Как читать с экрана') && !page3.includes('Микрофильм —') && !/\n3$/.test(page3) && page3.includes('микрофильмов.'),
    `начало «${page3.slice(0, 30)}», конец «${page3.slice(-40)}»`
  );

  // Таймер сна «до конца главы»: дочитали страницу перед новой главой — тишина
  const chapterStart = await page.evaluate(() => window.pdfReaderApp.outline.nextChapterStart(4));
  await page.evaluate(async () => {
    const reader = window.pdfReaderApp.tts;
    const page4 = await reader.textIndex.page(4);
    reader.sleepTimer.choose('chapter');
    reader.start({ pageNumber: 4, sentenceIndex: page4.sentences.length - 1 });
  });
  await page.waitForTimeout(2500);
  const sleepResult = await page.evaluate(() => ({
    state: window.pdfReaderApp.tts.state,
    status: document.getElementById('ttsStatus').textContent,
    page: window.pdfReaderApp.tts.position.pageNumber,
  }));
  check(
    'таймер сна останавливает чтение в начале следующей главы',
    chapterStart === 5 && sleepResult.state === 'idle' && sleepResult.status.includes('Таймер сна') && sleepResult.page === 5,
    `глава со стр. ${chapterStart}; ${JSON.stringify(sleepResult)}`
  );

  // Подсветка совпадает с тем, что читается, на каждой строке
  await page.evaluate(() => {
    window.pdfReaderApp.tts.start({ pageNumber: 2, sentenceIndex: 0 });
  });
  // Первое предложение ждёт, пока страница 2 отрисуется.
  await page.waitForFunction(() => window.pdfReaderApp.tts.lastHighlight('sentence'), null, { timeout: 5000 });
  const squash = (text) => text.replace(/[\s­-]/g, '');
  let exact = 0;
  let total = 0;
  let firstMismatch = '';
  for (let step = 0; step < 10; step += 1) {
    await page.waitForTimeout(300);
    const sample = await page.evaluate(async () => {
      const reader = window.pdfReaderApp.tts;
      const { pageNumber, sentenceIndex } = reader.position;
      const textPage = await reader.textIndex.page(pageNumber);
      const sentence = textPage.sentences[sentenceIndex];
      return { expected: textPage.text.slice(sentence.start, sentence.end), got: reader.lastHighlight('sentence') };
    });
    total += 1;
    if (squash(sample.expected) === squash(sample.got)) exact += 1;
    else firstMismatch ||= `ждали «${sample.expected.slice(0, 40)}», подсвечено «${sample.got.slice(0, 40)}»`;
    await page.evaluate(() => window.pdfReaderApp.tts.next());
  }
  check('подсвечено ровно читаемое предложение', exact === total, `${exact} из ${total} ${firstMismatch}`);
  await page.evaluate(() => window.pdfReaderApp.tts.stop());

  // Щелчок по тексту при открытой панели озвучки выбирает место старта
  await page.evaluate(() => window.pdfReaderApp.tts.showBar(true));
  await page.evaluate(() => window.pdfReaderApp.pdfViewer.scrollPageIntoView({ pageNumber: 2 }));
  await page.waitForTimeout(800);
  const target = await page.evaluate(() => {
    // markedContent — служебные контейнеры без размеров, щёлкать нужно по тексту.
    const spans = document.querySelectorAll('.page[data-page-number="2"] .textLayer span:not(.markedContent)');
    const span = [...spans].find((candidate) =>
      candidate.textContent.includes('Проф.')
    );
    span.scrollIntoView({ block: 'center' });
    const rect = span.getBoundingClientRect();
    return { x: rect.left + 4, y: rect.top + rect.height / 2 };
  });
  await page.waitForTimeout(400);
  await page.mouse.click(target.x, target.y);
  await page.waitForTimeout(500);
  const pickStatus = await page.evaluate(() => document.getElementById('ttsStatus').textContent);
  await page.click('#ttsPlay');
  await page.waitForTimeout(400);
  const spokenAfterPick = await page.evaluate(() => window.spokenSentences.at(-1));
  check(
    'щелчок по тексту выбирает, откуда читать',
    pickStatus.includes('Проф. Иванов') && spokenAfterPick.startsWith('Проф. Иванов как-то заметил'),
    `${pickStatus} → «${spokenAfterPick.slice(0, 40)}»`
  );
  check('сокращение «проф.» не разрывает фразу', /^Проф\. Иванов.*работает\.$/.test(spokenAfterPick), spokenAfterPick);
  await page.evaluate(() => {
    window.pdfReaderApp.tts.stop();
    window.pdfReaderApp.tts.showBar(false);
  });

  // Кнопки «−» и «+» у скорости автопрокрутки
  await page.evaluate(() => window.pdfReaderApp.autoScroll.showPanel());
  const speedOf = () => page.evaluate(() => Number(document.getElementById('asSpeed').value));
  const speedBefore = await speedOf();
  await page.click('#asFaster');
  await page.waitForTimeout(200);
  const speedUp = await speedOf();
  await page.click('#asSlower');
  await page.click('#asSlower');
  await page.waitForTimeout(200);
  const speedDown = await speedOf();
  const speedLabel = await page.evaluate(() => document.getElementById('asSpeedValue').textContent);
  check(
    'кнопки − и + меняют скорость автопрокрутки',
    speedUp > speedBefore && speedDown < speedUp && speedLabel === `${speedDown} px/с`,
    `${speedBefore} → ${speedUp} → ${speedDown} (${speedLabel})`
  );

  // Закрепление вида: 200%, положение по горизонтали не уезжает
  await page.evaluate(() => window.pdfReaderApp.setZoom('2'));
  await page.waitForTimeout(700);
  await page.evaluate(() => {
    window.pdfReaderApp.container.scrollLeft = 150;
  });
  await page.keyboard.press('l');
  await page.waitForTimeout(300);
  await page.evaluate(() => {
    window.pdfReaderApp.container.scrollLeft = 0;
  });
  await page.waitForTimeout(200);
  await page.evaluate(() => window.pdfReaderApp.pdfViewer.scrollPageIntoView({ pageNumber: 4 }));
  await page.waitForTimeout(400);
  const zoomRefused = await page.evaluate(() => window.pdfReaderApp.setZoom('1', { fromUser: true }) === false);
  await page.waitForTimeout(300);
  const lockView = await page.evaluate(() => ({
    locked: window.pdfReaderApp.viewLock.locked,
    left: Math.round(window.pdfReaderApp.container.scrollLeft),
    scale: window.pdfReaderApp.pdfViewer.currentScale,
  }));
  check('закреплённый вид не уезжает вбок', lockView.locked && Math.abs(lockView.left - 150) <= 2, `scrollLeft ${lockView.left}`);
  check('закреплённый масштаб не меняется', zoomRefused && Math.abs(lockView.scale - 2) < 0.001, `масштаб ${lockView.scale}`);

  await page.waitForTimeout(1800); // даём сохраниться месту чтения
  await page.reload();
  await page.waitForFunction(() => window.pdfReaderApp?.pdfViewer?.pagesCount > 0, null, { timeout: 20000 });
  await page.waitForTimeout(2500);
  const lockRestored = await page.evaluate(() => ({
    locked: window.pdfReaderApp.viewLock.locked,
    left: Math.round(window.pdfReaderApp.container.scrollLeft),
    scale: window.pdfReaderApp.pdfViewer.currentScale,
  }));
  check(
    'закрепление запоминается для документа',
    lockRestored.locked && Math.abs(lockRestored.scale - 2) < 0.001 && Math.abs(lockRestored.left - 150) <= 2,
    JSON.stringify(lockRestored)
  );
  await page.evaluate(() => window.pdfReaderApp.viewLock.release());

  // Закладка из панели: появляется в списке и флажком на полях
  await page.evaluate(() => window.pdfReaderApp.bookmarks.openPopover());
  await page.click('#bmAdd');
  await page.waitForTimeout(700);
  const bookmarkView = await page.evaluate(() => ({
    items: document.querySelectorAll('#bookmarksList .bookmark-item').length,
    markers: document.querySelectorAll('.page .bookmark-marker').length,
    noteFocused: document.activeElement?.classList.contains('bookmark-note') ?? false,
  }));
  check(
    'закладка из панели видна в списке и флажком на странице',
    bookmarkView.items === 1 && bookmarkView.markers >= 1 && bookmarkView.noteFocused,
    JSON.stringify(bookmarkView)
  );
  await page.evaluate(() => window.pdfReaderApp.bookmarks.closePopover());

  // ── Выделения и заметки ──
  await page.evaluate(() => window.pdfReaderApp.tts.showBar(false));
  await page.evaluate(() => window.pdfReaderApp.pdfViewer.scrollPageIntoView({ pageNumber: 3 }));
  await page.waitForTimeout(900);
  const selected = await page.evaluate(async () => {
    const { textSpansOfPage } = await import('/src/visible-text.js');
    const spans = textSpansOfPage(window.pdfReaderApp, 3);
    const index = spans.findIndex((span, i) => span.textContent.length > 30 && spans[i + 1]?.textContent.length > 30);
    const range = document.createRange();
    range.setStart(spans[index].firstChild, 4);
    range.setEnd(spans[index + 1].firstChild, 10);
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    const first = range.getClientRects()[0];
    document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    return {
      index,
      left: first.left,
      top: first.top,
      head: spans[index].textContent.slice(4, 24).replace(/\s+/g, ' ').trim(),
      tail: spans[index + 1].textContent.slice(0, 10).trim(),
    };
  });
  await page.waitForTimeout(200);
  check('выделение мышью показывает панель маркера', await page.isVisible('#markToolbar'));
  await page.click('.mark-swatch[data-color="green"]');
  await page.waitForTimeout(500);
  const marked = await page.evaluate(() => {
    const [item] = window.pdfReaderApp.readingState.record.highlights;
    const boxes = [...document.querySelectorAll('.page[data-page-number="3"] .mark-box.mark-green')];
    const first = boxes[0]?.getBoundingClientRect();
    return { item, boxes: boxes.length, left: first?.left, top: first?.top, bottom: first?.bottom };
  });
  check(
    'маркер сохраняется в координатах спанов',
    marked.item?.color === 'green' &&
      marked.item.pieces.length === 1 &&
      marked.item.pieces[0].pageNumber === 3 &&
      marked.item.pieces[0].from.span === selected.index &&
      marked.item.pieces[0].from.offset === 4 &&
      marked.item.pieces[0].to.span === selected.index + 1 &&
      marked.item.pieces[0].to.offset === 10,
    JSON.stringify(marked.item?.pieces)
  );
  check(
    'маркер лёг полосами точно на выделенный текст',
    marked.boxes === 2 && Math.abs(marked.left - selected.left) <= 3 && selected.top >= marked.top - 1 && selected.top <= marked.bottom,
    `полос ${marked.boxes}, x ${Math.round(marked.left)} vs ${Math.round(selected.left)}`
  );
  check(
    'текст выделения — со склейкой строк через пробел',
    marked.item?.text.startsWith(selected.head) && marked.item.text.includes(` ${selected.tail}`),
    `«${marked.item?.text}»`
  );

  // Щелчок по маркеру — правка: заметка сохраняется и видна в боковой панели
  const box = await page.evaluate(() => {
    const rect = document.querySelector('.page[data-page-number="3"] .mark-box').getBoundingClientRect();
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  });
  await page.mouse.click(box.x, box.y);
  await page.waitForTimeout(250);
  const editing = await page.evaluate(() => ({
    toolbar: !document.getElementById('markToolbar').hidden,
    remove: !document.getElementById('markDelete').hidden,
    active: document.querySelector('.mark-swatch.active')?.dataset.color,
  }));
  check('щелчок по маркеру открывает правку', editing.toolbar && editing.remove && editing.active === 'green', JSON.stringify(editing));
  await page.click('#markNoteToggle');
  await page.keyboard.type('моя заметка');
  await page.keyboard.press('Escape');
  await page.waitForTimeout(400);
  await page.evaluate(() => {
    window.pdfReaderApp.toggleSidebar(true);
    document.querySelector('#sidebar [data-tab="bookmarks"]').click();
  });
  await page.waitForTimeout(300);
  const noted = await page.evaluate(() => ({
    note: window.pdfReaderApp.readingState.record.highlights[0].note,
    toolbar: !document.getElementById('markToolbar').hidden,
    listed: document.querySelector('#highlightsPanel .mark-item .mark-note')?.textContent,
    hasNoteMark: Boolean(document.querySelector('.page[data-page-number="3"] .mark-box.has-note')),
  }));
  check(
    'заметка сохраняется по Esc и видна во вкладке «Заметки»',
    noted.note === 'моя заметка' && !noted.toolbar && noted.listed === 'моя заметка' && noted.hasNoteMark,
    JSON.stringify(noted)
  );

  const [notesDownload] = await Promise.all([
    page.waitForEvent('download', { timeout: 5000 }),
    page.click('#exportNotes'),
  ]);
  const markdown = readFileSync(await notesDownload.path(), 'utf8');
  // Headless Chromium подменяет кириллические имена на «download», поэтому
  // имя сверяем по сообщению самой программы.
  const notesName = await page.evaluate(() => document.getElementById('hud').textContent);
  check(
    'конспект .md: глава, цитата со страницей, заметка, закладки',
    notesName.includes('«russian — конспект.md»') &&
      /^## Глава I/m.test(markdown) &&
      markdown.includes(`> ${marked.item.text}`) &&
      markdown.includes('> — с. 3') &&
      markdown.includes('моя заметка') &&
      markdown.includes('## Закладки'),
    `${notesName}\n${markdown.slice(0, 300)}`
  );
  await page.evaluate(() => window.pdfReaderApp.toggleSidebar(false));
  await page.waitForTimeout(300);

  // ── Статистика чтения ──
  await page.waitForFunction(() => !document.getElementById('readingEta').hidden, null, { timeout: 10000 });
  const eta = await page.evaluate(() => ({
    text: document.getElementById('readingEtaText').textContent,
    title: document.getElementById('readingEta').title,
  }));
  check('в тулбаре оценка «до конца главы · книги»', /^\d+ (мин|ч)( \d+ мин)? · \d+ (мин|ч)/.test(eta.text) && eta.title.includes('До конца главы'), eta.text);

  const stats = () => page.evaluate(() => ({ ...window.pdfReaderApp.stats.today, docs: undefined }));
  await page.evaluate(() => window.pdfReaderApp.pdfViewer.scrollPageIntoView({ pageNumber: 2 }));
  await page.waitForTimeout(400);
  await page.evaluate(() => window.pdfReaderApp.stats.tick()); // точка отсчёта
  const statsStart = await stats();
  await page.mouse.move(640, 400);
  for (let i = 0; i < 6; i += 1) {
    await page.mouse.wheel(0, 0); // читатель жив, но не листает
    await page.waitForTimeout(1000);
  }
  await page.evaluate(() => window.pdfReaderApp.container.scrollBy(0, 150));
  await page.waitForTimeout(300);
  await page.evaluate(() => window.pdfReaderApp.stats.tick());
  const afterRead = await stats();
  check(
    'чтение засчитывается: время и пройденный текст',
    afterRead.readMs - statsStart.readMs >= 5000 && afterRead.readChars > statsStart.readChars,
    `+${Math.round((afterRead.readMs - statsStart.readMs) / 1000)} с, +${Math.round(afterRead.readChars - statsStart.readChars)} знаков`
  );

  await page.evaluate(() => window.pdfReaderApp.pdfViewer.scrollPageIntoView({ pageNumber: 6 }));
  await page.waitForTimeout(400);
  await page.evaluate(() => window.pdfReaderApp.stats.tick());
  const afterJump = await stats();
  check('переход на несколько страниц вперёд не считается прочитанным', afterJump.readChars === afterRead.readChars, `${Math.round(afterJump.readChars - afterRead.readChars)} знаков`);

  await page.evaluate(() => window.pdfReaderApp.stats.markIdle());
  await page.waitForTimeout(1200);
  await page.evaluate(() => window.pdfReaderApp.stats.tick());
  const afterIdle = await stats();
  check('простой дольше двух минут не считается', afterIdle.readMs === afterJump.readMs, `+${afterIdle.readMs - afterJump.readMs} мс`);
  check('озвучка учтена как прослушанный текст', afterIdle.listenChars > 0, `${afterIdle.listenChars} знаков`);

  await page.click('#readingEta');
  await page.waitForTimeout(400);
  const statsView = await page.evaluate(() => ({
    open: document.getElementById('statsDialog').open,
    tiles: document.querySelectorAll('.stats-tile').length,
    columns: document.querySelectorAll('.stats-column').length,
    todayCap: document.querySelector('.stats-column.today .stats-cap')?.textContent,
    book: document.querySelector('.stats-book h3')?.textContent,
  }));
  check(
    'окно статистики: плитки, неделя столбиками, книга',
    statsView.open && statsView.tiles === 4 && statsView.columns === 7 && /мин/.test(statsView.todayCap || '') && Boolean(statsView.book),
    JSON.stringify(statsView)
  );
  await page.hover('.stats-column.today');
  await page.waitForTimeout(150);
  const tip = await page.evaluate(() => {
    const tooltip = document.querySelector('.stats-tooltip');
    const dialog = document.getElementById('statsDialog').getBoundingClientRect();
    const rect = tooltip.getBoundingClientRect();
    return { hidden: tooltip.hidden, text: tooltip.textContent, inside: rect.left >= dialog.left && rect.right <= dialog.right };
  });
  check('подсказка у столбца — с разбивкой и в пределах окна', !tip.hidden && tip.text.includes('чтение') && tip.inside, JSON.stringify(tip));
  await page.keyboard.press('Escape');
  await page.waitForTimeout(200);
  check('Esc закрывает статистику', !(await page.evaluate(() => document.getElementById('statsDialog').open)));

  await page.evaluate(() => window.pdfReaderApp.stats.flush());
  await page.evaluate(() => window.pdfReaderApp.pdfViewer.scrollPageIntoView({ pageNumber: 3 }));
  await page.waitForTimeout(300);

  // ── Нейроголос Piper (тестовая модель вместо настоящего голоса) ──
  await page.evaluate(() => window.pdfReaderApp.settingsDialog.open());
  await page.waitForSelector('.piper-actions input[type=file]', { state: 'attached' });
  await page.setInputFiles('.piper-actions input[type=file]', [
    join(root, 'tests', 'fixtures', 'piper-dummy.onnx'),
    join(root, 'tests', 'fixtures', 'piper-dummy.onnx.json'),
  ]);
  await page.waitForFunction(() => document.querySelector('.piper-status')?.textContent.includes('загружен'), null, { timeout: 10000 });
  const piperListed = await page.evaluate(() => ({
    voice: document.getElementById('ttsVoice').value,
    option: [...document.querySelectorAll('#ttsVoice optgroup')].map((group) => group.label + ': ' + [...group.children].map((o) => o.textContent).join(', ')),
    installed: [...document.querySelectorAll('.piper-list li')].some((li) => li.textContent.includes('скачан')),
  }));
  check(
    'нейроголос загружается из файлов и выбирается',
    piperListed.voice === 'piper:piper-dummy' && piperListed.installed && piperListed.option.some((label) => label.startsWith('Нейроголоса')),
    JSON.stringify(piperListed)
  );
  await page.evaluate(() => window.pdfReaderApp.settingsDialog.close());

  await page.evaluate(() => window.pdfReaderApp.pdfViewer.scrollPageIntoView({ pageNumber: 2 }));
  await page.waitForTimeout(500);
  await page.click('#viewerContainer', { position: { x: 5, y: 5 } });
  await page.keyboard.press('s'); // настоящий жест: браузер разрешит звук
  await page.waitForFunction(() => window.pdfReaderApp.tts.engine === 'piper' && window.pdfReaderApp.tts.state === 'speaking', null, { timeout: 10000 });
  const piperStart = await page.evaluate(() => ({ ...window.pdfReaderApp.tts.position }));
  let piperWord = false;
  for (let i = 0; i < 40 && !piperWord; i += 1) {
    await page.waitForTimeout(100);
    piperWord = await page.evaluate(() => Boolean(document.querySelector('.tts-word-box')));
  }
  await page.waitForFunction(
    (start) => {
      const now = window.pdfReaderApp.tts.position;
      return now.pageNumber > start.pageNumber || now.sentenceIndex > start.sentenceIndex;
    },
    piperStart,
    { timeout: 15000 }
  );
  const piperRun = await page.evaluate(() => ({
    position: window.pdfReaderApp.tts.position,
    state: window.pdfReaderApp.tts.state,
    sentence: Boolean(document.querySelector('.tts-sentence-box')),
  }));
  check(
    'нейроголос читает фразу за фразой с подсветкой предложения и слов',
    piperRun.state === 'speaking' && piperRun.sentence && piperWord,
    `${JSON.stringify(piperStart)} → ${JSON.stringify(piperRun.position)}, слово: ${piperWord}`
  );
  await page.evaluate(() => window.pdfReaderApp.tts.stop());
  // Дальше тесты рассчитаны на подменённый системный синтез.
  await page.selectOption('#ttsVoice', 'mock-ru');
  await page.waitForTimeout(200);
  check('обратно на системный голос', (await page.evaluate(() => window.pdfReaderApp.tts.engine)) === 'web-speech');

  // Голос из каталога: спрашиваем, качаем; если сеть не пускает — понятная ошибка и откат выбора.
  let downloadQuestion = '';
  page.once('dialog', (dialog) => {
    downloadQuestion = dialog.message();
    dialog.accept();
  });
  await page.selectOption('#ttsVoice', 'piper:ru_RU-irina-medium');
  await page.waitForFunction(
    () => /не скачался|скачан/.test(document.getElementById('ttsStatus').textContent),
    null,
    { timeout: 30000 }
  );
  const downloadResult = await page.evaluate(() => ({
    status: document.getElementById('ttsStatus').textContent,
    voice: document.getElementById('ttsVoice').value,
  }));
  check(
    'скачивание голоса: вопрос с размером, при ошибке — подсказка и прежний голос',
    downloadQuestion.includes('≈61 МБ') &&
      (downloadResult.status.includes('скачан и работает') ||
        (downloadResult.status.includes('загрузить из файла') && downloadResult.voice === 'mock-ru')),
    JSON.stringify(downloadResult)
  );

  // ── Режим «только текст» ──
  await page.evaluate(() => window.pdfReaderApp.pdfViewer.scrollPageIntoView({ pageNumber: 3 }));
  await page.waitForTimeout(700);
  await page.click('#viewerContainer', { position: { x: 5, y: 5 } }); // фокус в документ, не в поле заметки
  await page.keyboard.press('t');
  await page.waitForTimeout(1500);
  const reflow = await page.evaluate(() => {
    const container = document.getElementById('reflowContainer');
    return {
      active: window.pdfReaderApp.reflow.active,
      position: window.pdfReaderApp.reflow.position(),
      overflowX: container.scrollWidth - container.clientWidth,
      header: [...document.querySelectorAll('.rf-page[data-page="3"] .rf-p')].some((p) => p.textContent.includes('Как читать с экрана')),
      footnote: document.getElementById('reflowArticle').textContent.includes('Микрофильм —'),
    };
  });
  check(
    'режим «только текст» открывается на том же месте',
    reflow.active && reflow.position.pageNumber === 3 && reflow.position.sentenceIndex === 0,
    JSON.stringify(reflow.position)
  );
  check(
    'текст без горизонтальной прокрутки, колонтитулов и сносок',
    reflow.overflowX <= 1 && !reflow.header && !reflow.footnote,
    JSON.stringify(reflow)
  );

  const reflowTop = () => page.evaluate(() => document.getElementById('reflowContainer').scrollTop);
  const beforeSpace = await reflowTop();
  await page.keyboard.press('Space');
  await page.waitForTimeout(500);
  check('пробел листает и в режиме текста', (await reflowTop()) - beforeSpace > 300, `сдвиг ${Math.round((await reflowTop()) - beforeSpace)} px`);

  const sizeBefore = await page.evaluate(() => getComputedStyle(document.getElementById('reflowArticle')).fontSize);
  await page.keyboard.press('Control+Equal');
  await page.waitForTimeout(400);
  const sizeAfter = await page.evaluate(() => getComputedStyle(document.getElementById('reflowArticle')).fontSize);
  check('Ctrl+= в режиме текста увеличивает шрифт', parseFloat(sizeAfter) > parseFloat(sizeBefore), `${sizeBefore} → ${sizeAfter}`);

  // Выделение из PDF видно и в режиме текста; новое выделение здесь — клавишей H
  await page.waitForTimeout(300);
  const reflowMarks = await page.evaluate(() => {
    const ranges = [...(globalThis.CSS?.highlights?.get('mark-green') || [])];
    return ranges.map((range) => range.toString()).join(' ');
  });
  check(
    'выделение из PDF подсвечено в режиме текста',
    reflowMarks.replace(/\s+/g, ' ').trim() === marked.item.text.replace(/\s+/g, ' '),
    `«${reflowMarks}»`
  );
  const reflowSelected = await page.evaluate(() => {
    const node = document.querySelector('.rf-page[data-page="3"] .rf-s[data-s="5"]').firstChild;
    const range = document.createRange();
    range.setStart(node, 0);
    range.setEnd(node, Math.min(node.length, 25));
    window.getSelection().removeAllRanges();
    window.getSelection().addRange(range);
    return range.toString();
  });
  await page.keyboard.press('h');
  await page.waitForTimeout(500);
  const reflowMarked = await page.evaluate(() => {
    const items = window.pdfReaderApp.readingState.record.highlights;
    const created = items.find((item) => item.color === 'green' && item.note === '');
    const ranges = [...(globalThis.CSS?.highlights?.get('mark-green') || [])].map((range) => range.toString());
    return { count: items.length, created, ranges };
  });
  check(
    'клавиша H выделяет в режиме текста последним цветом',
    reflowMarked.count === 2 && reflowMarked.created?.text === reflowSelected.trim() && reflowMarked.ranges.includes(reflowSelected),
    JSON.stringify({ text: reflowMarked.created?.text, ranges: reflowMarked.ranges })
  );

  // Озвучка в режиме текста подсвечивает само предложение и слово
  await page.evaluate(() => {
    window.pdfReaderApp.tts.start({ pageNumber: 3, sentenceIndex: 4 });
  });
  await page.waitForTimeout(600);
  const reflowTts = await page.evaluate(() => ({
    current: document.querySelector('.rf-s.rf-current')?.textContent ?? '',
    spoken: window.spokenSentences.at(-1),
    word: globalThis.CSS?.highlights?.has('rf-word') ?? false,
  }));
  check(
    'озвучка в режиме текста подсвечивает читаемое предложение',
    reflowTts.current && reflowTts.current === reflowTts.spoken && reflowTts.word,
    `«${reflowTts.current.slice(0, 40)}», слово: ${reflowTts.word}`
  );
  await page.evaluate(() => window.pdfReaderApp.tts.stop());

  // Место в режиме текста переживает перезагрузку
  await page.waitForTimeout(1800);
  await page.reload();
  await page.waitForFunction(() => window.pdfReaderApp?.pdfViewer?.pagesCount > 0, null, { timeout: 20000 });
  await page.waitForTimeout(3000);
  const reflowRestored = await page.evaluate(() => ({
    active: window.pdfReaderApp.reflow.active,
    page: window.pdfReaderApp.reflow.active ? window.pdfReaderApp.reflow.position().pageNumber : null,
  }));
  check('режим текста и место в нём восстанавливаются', reflowRestored.active && reflowRestored.page === 3, JSON.stringify(reflowRestored));

  await page.keyboard.press('t');
  await page.waitForTimeout(1200);
  const backInPdf = await page.evaluate(() => ({
    active: window.pdfReaderApp.reflow.active,
    page: window.pdfReaderApp.pdfViewer.currentPageNumber,
  }));
  check('выход из режима текста — на ту же страницу', !backInPdf.active && backInPdf.page === 3, JSON.stringify(backInPdf));
  await page.waitForTimeout(500);
  const roundTrip = await page.evaluate(async () => {
    const { textSpansOfPage } = await import('/src/visible-text.js');
    const app = window.pdfReaderApp;
    const created = app.readingState.record.highlights.find((item) => !item.note);
    const [piece] = created.pieces;
    const spans = textSpansOfPage(app, piece.pageNumber);
    const parts = [];
    for (let i = piece.from.span; i <= piece.to.span; i += 1) {
      const content = spans[i].textContent;
      parts.push(content.slice(i === piece.from.span ? piece.from.offset : 0, i === piece.to.span ? piece.to.offset : content.length));
    }
    return { created: created.text, text: parts.join(' '), boxes: document.querySelectorAll('.page[data-page-number="3"] .mark-box').length };
  });
  const letters = (text) => text.replace(/[\s-]/g, '');
  check(
    'выделение из режима текста ложится на те же слова в PDF',
    letters(roundTrip.text) === letters(roundTrip.created) && roundTrip.boxes >= 3,
    JSON.stringify(roundTrip)
  );

  // ── Распознавание скана ──
  await page.goto(`${BASE}/viewer.html?file=/fixtures/scan.pdf`);
  await page.waitForFunction(() => window.pdfReaderApp?.pdfViewer?.pagesCount > 0, null, { timeout: 20000 });
  await page.waitForSelector('.page[data-page-number="1"] .ocr-offer button.primary', { timeout: 15000 });
  check('на странице-скане предлагается распознать текст', true);
  await page.click('.page[data-page-number="1"] .ocr-offer button.primary');
  await page.waitForFunction(() => window.pdfReaderApp.ocr.has(1), null, { timeout: 90000 });
  await page.waitForFunction(
    () => document.querySelectorAll('.page[data-page-number="1"] .textLayer span:not(.markedContent)').length > 100,
    null,
    { timeout: 15000 }
  );
  const ocrLayer = await page.evaluate(() => {
    const spans = [...document.querySelectorAll('.page[data-page-number="1"] .textLayer span:not(.markedContent)')];
    return {
      count: spans.length,
      text: spans.map((span) => span.textContent).join(''),
      offer: Boolean(document.querySelector('.page[data-page-number="1"] .ocr-offer')),
    };
  });
  check(
    'распознанный текст лёг текстовым слоем на скан',
    ocrLayer.count > 100 && ocrLayer.text.includes('Красная нить любого длинного текста') && !ocrLayer.offer,
    `${ocrLayer.count} слов: «${ocrLayer.text.slice(0, 80)}…»`
  );

  await page.click('#viewerContainer', { position: { x: 5, y: 5 } });
  await page.keyboard.press('Control+f');
  await page.keyboard.type('непрерывность');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(1000);
  const scanFind = await page.evaluate(() => document.getElementById('findStatus').textContent);
  check('поиск находит распознанный текст', /[1-9]\d* из [1-9]/.test(scanFind), scanFind);
  await page.keyboard.press('Escape');

  await page.evaluate(() => {
    window.spokenSentences.length = 0;
    window.pdfReaderApp.tts.start({ pageNumber: 1, sentenceIndex: 0 });
  });
  await page.waitForFunction(() => window.spokenSentences.some((text) => text.includes('Красная нить любого длинного текста')), null, {
    timeout: 20000,
  });
  check('озвучка читает распознанный скан', true);
  // Следующая страница-скан распознаётся заранее, пока читается эта.
  await page.waitForFunction(() => window.pdfReaderApp.ocr.has(2), null, { timeout: 90000 });
  const scanText = await page.evaluate(async () => {
    const pages = [1, 2].map((n) => window.pdfReaderApp.loader.pdfDocument.getPage(n).then((p) => p.getTextContent()));
    return (await Promise.all(pages)).map((content) => content.items.map((item) => item.str).join('')).join(' ');
  });
  const latinWords = scanText.match(/\b[A-Za-z]{2,}\b/g) || [];
  check(
    'русский скан распознан русским языком — без латинских двойников',
    scanText.includes('силы на то, чтобы') && latinWords.length === 0,
    latinWords.join(', ') || 'латиницы нет'
  );
  await page.evaluate(() => window.pdfReaderApp.tts.stop());
  await page.evaluate(() => window.pdfReaderApp.tts.start({ pageNumber: 2, sentenceIndex: 0 }));
  await page.waitForTimeout(1200);
  const scanPage2 = await page.evaluate(() => ({ position: window.pdfReaderApp.tts.position, spoken: window.spokenSentences.at(-1) }));
  check(
    'следующая страница скана распознана заранее и читается',
    scanPage2.position.pageNumber === 2 && /[А-Яа-я]{3}/.test(scanPage2.spoken || ''),
    JSON.stringify(scanPage2)
  );
  await page.evaluate(() => window.pdfReaderApp.tts.stop());

  await page.reload();
  await page.waitForFunction(() => window.pdfReaderApp?.pdfViewer?.pagesCount > 0, null, { timeout: 20000 });
  await page.waitForFunction(() => window.pdfReaderApp.ocr.has(1) && window.pdfReaderApp.ocr.has(2), null, { timeout: 8000 });
  await page.waitForTimeout(800);
  const restoredOcr = await page.evaluate(
    () => document.querySelectorAll('.page[data-page-number="1"] .textLayer span:not(.markedContent)').length
  );
  check('распознанное сохраняется — второй раз не распознаётся', restoredOcr > 100, `${restoredOcr} слов`);

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
