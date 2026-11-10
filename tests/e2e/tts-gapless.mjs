// Озвучка нейроголосом без заиканий — в Chromium, с пакетом-пустышкой TeraTTS
// и тестовым голосом Piper.
//
// Следующая фраза встаёт в звук встык, пока звучит текущая (audio-player.js).
// Здесь это проверяется так, как ломалось у читателя:
// - страницу нарочно подвешивают на 0,7 с каждые 0,9 с — как перерисовка,
//   сборка мусора или переключение окон;
// - «прячут»: document.hidden и не идущие кадры, как у свёрнутого окна, —
//   новые страницы не рисуются;
// - дёргают скорость и ставят паузу посреди очереди.
// Дыры в звуке считаются по часам AudioContext: каждый кусок, поставленный в
// звук (AudioBufferSourceNode.start), — отрезок на шкале. До переделки под
// подвисаниями было 2,7 с дыр за 20 с, в фоне — по 1,5 с на фразу.
//
// И окошко примечания: примечание звучит встык за своей фразой, «Пропустить» —
// и следующая фраза идёт сразу, без нового синтеза.

import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { dummyTeraFiles } from '../../scripts/make-dummy-tera.mjs';

const root = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const PORT = Number(process.env.PORT || 8132);
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

/** Каждый кусок звука — отрезок на часах AudioContext. */
const recordAudio = () => {
  window.audioLog = [];
  const start = AudioBufferSourceNode.prototype.start;
  AudioBufferSourceNode.prototype.start = function (when = 0, ...rest) {
    // У каждого провайдера свой AudioContext — свои часы: куски помечаем, чьи они.
    this.context.clockId ||= (window.clocks = (window.clocks || 0) + 1);
    window.audioClock = this.context;
    const now = this.context.currentTime;
    const entry = { clock: this.context.clockId, when: when || now, now, dur: this.buffer?.duration ?? 0, stoppedAt: null, t: performance.now() };
    window.audioLog.push(entry);
    const stop = this.stop;
    this.stop = function (at = 0) {
      entry.stoppedAt = Math.max(at || this.context.currentTime, this.context.currentTime);
      return stop.call(this, at);
    };
    return start.call(this, when, ...rest);
  };
};

/**
 * Тишина и наложения в окне [from, to] часов AudioContext: какая часть окна
 * не покрыта звуком (и в конце тоже — звук не должен кончиться раньше).
 */
function analyse({ log, clock, from, to }) {
  const spans = log
    .filter((entry) => entry.clock === clock)
    .map((entry) => {
      const start = Math.max(entry.when, entry.now);
      return { start, end: Math.min(start + entry.dur, entry.stoppedAt ?? Infinity), late: entry.now - entry.when };
    })
    .filter((span) => span.end > span.start && span.end > from && span.start < to)
    .sort((a, b) => a.start - b.start);
  const gaps = [];
  const overlaps = [];
  let reach = from;
  for (const span of spans) {
    const gap = span.start - reach;
    if (gap > 0.005) gaps.push(Math.round(gap * 1000));
    // Смена скорости посреди фразы — перекрёстное затухание на 12 мс, это не наложение.
    if (gap < -0.02 && span.start > from) overlaps.push(Math.round(-gap * 1000));
    reach = Math.max(reach, span.end);
  }
  if (to - reach > 0.005) gaps.push(Math.round((to - reach) * 1000));
  return {
    seconds: Number((to - from).toFixed(1)),
    pieces: spans.length,
    gaps,
    gapMs: gaps.reduce((sum, gap) => sum + gap, 0),
    late: spans.filter((span) => span.start > from && span.late > 0.005).length,
    overlaps,
  };
}

const server = spawn(process.execPath, [join(root, 'scripts', 'dev-server.mjs')], { env: { ...process.env, PORT: String(PORT) }, stdio: 'ignore' });
let browser;
const errors = [];
try {
  if (!(await waitForServer(`${BASE}/viewer.html`))) throw new Error('dev-сервер не поднялся');
  browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
  const page = await browser.newPage({ viewport: { width: 1280, height: 860 } });
  page.on('pageerror', (error) => errors.push(error.message));
  await page.addInitScript(recordAudio);
  // Кнопки гарнитуры приходят через Media Session — запоминаем обработчики, чтобы «нажать» их.
  await page.addInitScript(() => {
    window.mediaHandlers = {};
    const session = navigator.mediaSession;
    const original = session.setActionHandler.bind(session);
    session.setActionHandler = (action, handler) => {
      window.mediaHandlers[action] = handler;
      try {
        original(action, handler);
      } catch {
        /* действие неизвестно браузеру */
      }
    };
  });
  const teraFiles = dummyTeraFiles();
  await page.route('https://huggingface.co/**', async (route) => {
    const url = route.request().url();
    const name = Object.keys(teraFiles).find((suffix) => url.endsWith(suffix));
    if (!name) return route.fallback();
    // Не мгновенно — чтобы увидеть полосу скачивания и значок в углу.
    await new Promise((resolve) => setTimeout(resolve, 120));
    return route.fulfill({ status: 200, body: teraFiles[name], headers: { 'content-type': 'application/octet-stream', 'access-control-allow-origin': '*' } });
  });
  await page.goto(`${BASE}/viewer.html?file=/fixtures/russian.pdf`);
  await page.waitForFunction(() => window.pdfReaderApp?.pdfViewer?.pagesCount > 0, null, { timeout: 20000 });

  /** Слушать seconds секунд; jank — подвешивать страницу на столько мс каждые 0,9 с. */
  const listen = async (seconds, { jank = 0, during = null } = {}) => {
    const from = await page.evaluate(
      ({ jank, during }) => {
        if (jank) {
          window.jankTimer = setInterval(() => {
            const until = performance.now() + jank;
            while (performance.now() < until);
          }, 900);
        }
        if (during === 'rate') {
          let faster = true;
          window.duringTimer = setInterval(() => {
            window.pdfReaderApp.tts.adjustRate(faster ? 0.5 : -0.5);
            faster = !faster;
          }, 1700);
        }
        return { clock: window.audioClock.clockId, time: window.audioClock.currentTime };
      },
      { jank, during }
    );
    if (during === 'pause') {
      await page.waitForTimeout(seconds * 500);
      await page.evaluate(() => window.pdfReaderApp.tts.pause());
      await page.waitForTimeout(1200);
      await page.evaluate(() => window.pdfReaderApp.tts.resume());
      await page.waitForTimeout(seconds * 500);
    } else await page.waitForTimeout(seconds * 1000);
    const { log, to } = await page.evaluate(() => {
      clearInterval(window.jankTimer);
      clearInterval(window.duringTimer);
      return { log: window.audioLog.slice(), to: window.audioClock.currentTime };
    });
    return analyse({ log, clock: from.clock, from: from.time, to });
  };
  const startReading = async (engine) => {
    const known = await page.evaluate(() => window.audioLog.length);
    await page.click('#viewerContainer', { position: { x: 5, y: 5 } });
    await page.keyboard.press('s');
    await page.waitForFunction((engine) => window.pdfReaderApp.tts.engine === engine && window.pdfReaderApp.tts.state === 'speaking', engine, { timeout: 30000 });
    await page.waitForFunction((known) => window.audioLog.length > known + 2, known, { timeout: 30000 });
  };

  // ── Piper ──
  await page.evaluate(() => window.pdfReaderApp.settingsDialog.open());
  await page.waitForSelector('.piper-actions input[type=file]', { state: 'attached' });
  await page.setInputFiles('.piper-actions input[type=file]', [join(root, 'tests', 'fixtures', 'piper-dummy.onnx'), join(root, 'tests', 'fixtures', 'piper-dummy.onnx.json')]);
  await page.waitForFunction(() => document.querySelector('.piper-status')?.textContent.includes('загружен'), null, { timeout: 10000 });
  await page.evaluate(() => window.pdfReaderApp.settingsDialog.close());
  await startReading('piper');
  const piper = await listen(12, { jank: 700 });
  check('Piper: страница подвисает по 0,7 с — фразы всё равно встык', piper.pieces >= 4 && piper.gapMs <= 30 && !piper.late, JSON.stringify(piper));
  await page.evaluate(() => window.pdfReaderApp.tts.stop());

  // ── TeraTTS ──
  await page.evaluate(() => window.pdfReaderApp.settingsDialog.open());
  await page.waitForSelector('.tera-voices button');
  await page.click('.tera-voices button');
  // Пока качается — полоса с процентами, объёмом и скоростью; окно закрыли — значок в углу.
  await page.waitForFunction(() => /\d+ % · .+ из .+/.test(document.querySelector('.tera-voices .dl-text')?.textContent || ''), null, { timeout: 30000 });
  const downloading = await page.evaluate(() => ({
    text: document.querySelector('.tera-voices .dl-text').textContent,
    bar: document.querySelector('.tera-voices .dl-bar')?.getAttribute('aria-valuenow'),
  }));
  await page.evaluate(() => window.pdfReaderApp.settingsDialog.close());
  await page.waitForTimeout(300);
  const chipWhile = await page.evaluate(() => ({ hidden: document.getElementById('downloadChip').hidden, text: document.getElementById('downloadChip').textContent }));
  await page.waitForFunction(() => /^✓ Голоса TeraTTS скачаны/.test(document.getElementById('downloadChip')?.textContent || ''), null, { timeout: 60000 });
  await page.evaluate(() => window.pdfReaderApp.settingsDialog.open());
  await page.waitForFunction(() => /скачаны/.test(document.querySelector('.tera-status')?.textContent || ''), null, { timeout: 30000 });
  const settled = await page.evaluate(() => ({ text: document.querySelector('.tera-status').textContent, badge: document.querySelector('.tera-voices .badge')?.textContent }));
  await page.evaluate(() => window.pdfReaderApp.settingsDialog.close());
  check(
    'скачивание голосов: полоса с процентом, объёмом и скоростью; окно закрыли — значок в углу; в конце — «скачаны»',
    /^\d+ % · .+ из .+ МБ/.test(downloading.text) && downloading.bar !== null && !chipWhile.hidden && /^⬇ Голоса TeraTTS: /.test(chipWhile.text) && /скачаны/.test(settled.text) && settled.badge === 'скачаны',
    JSON.stringify({ downloading, chipWhile, settled })
  );
  await page.selectOption('#ttsVoice', 'tera:ru_m5');
  await page.waitForFunction(() => window.pdfReaderApp.tts.engine === 'tera', null, { timeout: 10000 });
  await page.evaluate(() => window.pdfReaderApp.pdfViewer.scrollPageIntoView({ pageNumber: 1 }));
  await startReading('tera');

  const calm = await listen(8);
  check('TeraTTS: фразы и куски фраз встык', calm.pieces >= 5 && calm.gapMs <= 30 && !calm.overlaps.length, JSON.stringify(calm));
  const janky = await listen(15, { jank: 700 });
  check(
    'TeraTTS: страница подвисает по 0,7 с каждые 0,9 с — ни дыр, ни обрывов посреди фразы',
    janky.pieces >= 8 && janky.gapMs <= 30 && !janky.late,
    JSON.stringify(janky)
  );
  const rate = await listen(12, { during: 'rate' });
  check('TeraTTS: скорость скачет 1,0 ↔ 1,5 — фразы в очереди пересчитываются: без дыр и наложений', rate.pieces >= 8 && rate.gapMs <= 30 && !rate.overlaps.length, JSON.stringify(rate));
  const paused = await listen(6, { during: 'pause' });
  const afterPause = await page.evaluate(() => window.pdfReaderApp.tts.state);
  check('TeraTTS: пауза посреди очереди — после неё звук идёт дальше без дыр и наложений', afterPause === 'speaking' && paused.gapMs <= 30 && !paused.overlaps.length, JSON.stringify({ afterPause, ...paused }));

  // ── Примечание: встык за фразой, окошко, «Пропустить» ──
  await page.evaluate(() => window.pdfReaderApp.pdfViewer.scrollPageIntoView({ pageNumber: 3 }));
  await page.waitForTimeout(800);
  const note = await page.evaluate(async () => {
    const reader = window.pdfReaderApp.tts;
    const page3 = await reader.textIndex.page(3);
    const sentenceIndex = page3.sentences.findIndex((sentence) => page3.text.slice(sentence.start, sentence.end).includes('микрофильмов'));
    reader.start({ pageNumber: 3, sentenceIndex });
    // Окно — с первого звука фразы: она, а за ней примечание.
    const known = window.audioLog.length;
    for (let i = 0; i < 600 && window.audioLog.length === known; i += 1) await new Promise((r) => setTimeout(r, 5));
    window.noteFrom = window.audioLog[known] ? Math.max(window.audioLog[known].when, window.audioLog[known].now) : window.audioClock.currentTime;
    const card = document.getElementById('ttsNote');
    for (let i = 0; i < 600 && card.hidden; i += 1) await new Promise((r) => setTimeout(r, 10));
    // Звук примечания пошёл — окошко знает, сколько оно звучит.
    for (let i = 0; i < 300 && !/из/.test(card.querySelector('.tts-note-time').textContent); i += 1) await new Promise((r) => setTimeout(r, 10));
    await new Promise((r) => setTimeout(r, 1500));
    const shown = {
      visible: !card.hidden,
      text: card.querySelector('.tts-note-text').textContent,
      time: card.querySelector('.tts-note-time').textContent,
      word: card.querySelector('.tts-note-text mark')?.textContent ?? null,
    };
    const beforeSkip = { log: window.audioLog.slice(), clock: window.audioClock.clockId, from: window.noteFrom, to: window.audioClock.currentTime };
    const skippedAt = performance.now();
    card.querySelector('.tts-note-skip').click();
    for (let i = 0; i < 300 && !window.audioLog.some((entry) => entry.t > skippedAt); i += 1) await new Promise((r) => setTimeout(r, 5));
    const next = window.audioLog.find((entry) => entry.t > skippedAt);
    const result = { shown, beforeSkip, nextAfterMs: next ? Math.round(next.t - skippedAt) : null, hiddenAfter: card.hidden, state: reader.state };
    reader.stop();
    return result;
  });
  const noteAudio = analyse(note.beforeSkip);
  check(
    'TeraTTS: примечание встык за своей фразой; окошко — текст, звучащее слово, время; «Пропустить» — следующая фраза сразу',
    note.shown.visible &&
      note.shown.text.startsWith('Микрофильм') &&
      Boolean(note.shown.word) &&
      /^\d:\d\d из ≈ \d:\d\d$/.test(note.shown.time) &&
      noteAudio.gapMs <= 30 &&
      note.nextAfterMs !== null &&
      note.nextAfterMs < 300 &&
      note.hiddenAfter &&
      note.state === 'speaking',
    JSON.stringify({ ...note, beforeSkip: undefined, noteAudio })
  );

  // Кнопки гарнитуры: «следующий трек» и клавиша «громче» во время примечания пропускают его.
  const skipBy = async (how) => {
    await page.evaluate(() => window.pdfReaderApp.pdfViewer.scrollPageIntoView({ pageNumber: 3 }));
    await page.waitForTimeout(300);
    await page.evaluate(async () => {
      const reader = window.pdfReaderApp.tts;
      const page3 = await reader.textIndex.page(3);
      reader.start({ pageNumber: 3, sentenceIndex: page3.sentences.findIndex((sentence) => page3.text.slice(sentence.start, sentence.end).includes('микрофильмов')) });
    });
    await page.waitForFunction(() => window.pdfReaderApp.tts.noteSpeaking && !document.getElementById('ttsNote').hidden, null, { timeout: 15000 });
    const handlers = await page.evaluate(() => Object.keys(window.mediaHandlers).filter((action) => window.mediaHandlers[action]));
    const known = await page.evaluate(() => window.audioLog.length);
    if (how === 'nexttrack') await page.evaluate(() => window.mediaHandlers.nexttrack());
    else {
      await page.focus('#viewerContainer');
      await page.keyboard.press('AudioVolumeUp');
    }
    await page.waitForFunction((known) => window.audioLog.length > known && !window.pdfReaderApp.tts.noteSpeaking, known, { timeout: 5000 }).catch(() => {});
    const result = await page.evaluate(() => ({ note: window.pdfReaderApp.tts.noteSpeaking, card: document.getElementById('ttsNote').hidden, state: window.pdfReaderApp.tts.state }));
    await page.evaluate(() => window.pdfReaderApp.tts.stop());
    return { handlers, ...result };
  };
  const byHeadset = await skipBy('nexttrack');
  const byVolume = await skipBy('volume');
  check(
    'кнопки гарнитуры: во время чтения есть «пауза», «следующий», «предыдущий»; «следующий трек» и клавиша «громче» пропускают примечание',
    ['play', 'pause', 'nexttrack', 'previoustrack'].every((action) => byHeadset.handlers.includes(action)) &&
      [byHeadset, byVolume].every((run) => !run.note && run.card && run.state === 'speaking'),
    JSON.stringify({ byHeadset, byVolume })
  );
  const afterStop = await page.evaluate(() => Object.values(window.mediaHandlers).filter(Boolean).length);
  check('чтение остановлено — кнопки гарнитуры отданы обратно системе', afterStop === 0, `обработчиков: ${afterStop}`);

  // Переозвучить фразу (R): другая выборка шума — и выбор запоминается.
  await page.evaluate(() => window.pdfReaderApp.pdfViewer.scrollPageIntoView({ pageNumber: 2 }));
  await startReading('tera');
  await page.focus('#viewerContainer');
  await page.keyboard.press('r');
  await page.waitForTimeout(400);
  const revoiced = await page.evaluate(() => ({
    count: window.pdfReaderApp.tts.tera.revoiced,
    stored: Object.keys(JSON.parse(localStorage.getItem('teraSeeds') || '{}')).length,
    state: window.pdfReaderApp.tts.state,
    button: !document.getElementById('ttsRevoice').hidden,
  }));
  await page.waitForFunction(() => window.pdfReaderApp.tts.state === 'speaking', null, { timeout: 10000 });
  check('«Переозвучить фразу» (R): фраза звучит заново с другим шумом, выбор запомнен', revoiced.count === 1 && revoiced.stored === 1 && revoiced.button, JSON.stringify(revoiced));
  await page.evaluate(() => window.pdfReaderApp.tts.stop());

  // Остановили — звук не выбрасывается: недоделанные фразы доделываются,
  // прозвучавшие держатся. Снова «Читать» с того же места или на пару фраз
  // раньше (с начала экрана) — звук уже готов, синтезировать заново не нужно.
  await page.waitForTimeout(300);
  await page.evaluate(() => window.pdfReaderApp.pdfViewer.scrollPageIntoView({ pageNumber: 2 }));
  await startReading('tera');
  const kept = await page.evaluate(async () => {
    const reader = window.pdfReaderApp.tts;
    const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    const from = reader.position;
    for (let i = 0; i < 600 && !(reader.position.pageNumber === from.pageNumber && reader.position.sentenceIndex >= from.sentenceIndex + 4); i += 1) await wait(25);
    const at = reader.position;
    reader.stop();
    await wait(2500); // недоделанное доделывается
    const prepared = async (sentenceIndex) => reader.preparedAt({ pageNumber: at.pageNumber, sentenceIndex });
    // Две прозвучавшие фразы перед текущей — со словами («* * *» голос не произносит).
    const page = await reader.textIndex.page(at.pageNumber);
    const spokenBefore = page.sentences
      .map((sentence, i) => ({ i, words: /[\p{L}\p{N}]/u.test(page.text.slice(sentence.start, sentence.end)) }))
      .filter((item) => item.words && item.i < at.sentenceIndex && item.i >= from.sentenceIndex)
      .slice(-2)
      .map((item) => item.i);
    const result = { at, spokenBefore, before: await Promise.all(spokenBefore.map(prepared)), current: await prepared(at.sentenceIndex), next: await prepared(at.sentenceIndex + 1) };
    // Снова «Читать» с того же места — звук идёт сразу.
    const known = window.audioLog.length;
    const startedAt = performance.now();
    reader.start(at);
    for (let i = 0; i < 400 && window.audioLog.length === known; i += 1) await wait(5);
    result.firstSoundMs = Math.round(performance.now() - startedAt);
    reader.stop();
    return result;
  });
  check(
    'остановили чтение — звук не выбрасывается: прозвучавшие фразы, текущая и следующая готовы; снова «Читать» — звук сразу',
    kept.spokenBefore.length === 2 && kept.before.every(Boolean) && kept.current && kept.next && kept.firstSoundMs < 400,
    JSON.stringify(kept)
  );

  // Окно в фоне: страницы не рисуются — раньше голос ждал их по 1,5 с на фразу.
  await page.evaluate(() => window.pdfReaderApp.tts.stop());
  await page.waitForTimeout(300);
  const lastOfPage1 = await page.evaluate(async () => (await window.pdfReaderApp.tts.textIndex.page(1)).sentences.length - 2);
  await page.evaluate(() => {
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
    window.realRequestAnimationFrame = window.requestAnimationFrame;
    window.requestAnimationFrame = () => 0;
    document.dispatchEvent(new Event('visibilitychange'));
    for (const div of document.querySelectorAll('.page')) if (Number(div.dataset.pageNumber) > 1) div.querySelector('.textLayer')?.replaceChildren();
  });
  await page.evaluate((sentenceIndex) => {
    window.pdfReaderApp.tts.start({ pageNumber: 1, sentenceIndex: Math.max(0, sentenceIndex) });
  }, lastOfPage1);
  await page.waitForFunction(() => window.pdfReaderApp.tts.state === 'speaking');
  const hidden = await listen(12);
  const hiddenPage = await page.evaluate(() => window.pdfReaderApp.tts.position.pageNumber);
  check('окно в фоне: на новой странице голос не ждёт её отрисовки', hiddenPage >= 2 && hidden.gapMs <= 30, JSON.stringify({ page: hiddenPage, ...hidden }));
  await page.evaluate(() => {
    window.pdfReaderApp.tts.stop();
    delete document.hidden;
    delete document.visibilityState;
    window.requestAnimationFrame = window.realRequestAnimationFrame;
    document.dispatchEvent(new Event('visibilitychange'));
  });

  check('без ошибок на странице', errors.length === 0, errors.slice(0, 3).join(' | '));
} catch (error) {
  results.push(false);
  console.error('✗ проверка прервана:', error);
} finally {
  await browser?.close();
  server.kill();
}

const passed = results.filter(Boolean).length;
console.log(`\nпройдено ${passed} из ${results.length}`);
process.exit(passed === results.length ? 0 : 1);
