// Фоновая страница: перехватывает открытие PDF и уводит их в наш вьюер, а
// выделенный на любой странице текст читает вслух прямо там.
//
// Firefox сохранил блокирующий webRequest — им можно посмотреть на
// Content-Type ответа и подменить страницу до её отрисовки. В Chrome его нет:
// там то же делают правила declarativeNetRequest (src/pdf-rules.js). Если не
// вышло ни то ни другое, остаётся запасной путь по адресу страницы, а вручную
// документ всегда можно открыть из самого вьюера.
//
// В Chrome этот файл — service worker: он засыпает через полминуты простоя и
// просыпается на событие, поэтому слушатели регистрируются сразу при старте,
// а состояние читается заново из хранилища.

import './browser-shim.js';
import { filenameFromContentDisposition } from './src/file-name.js';
import { PDF_RULE_IDS, pdfRules } from './src/pdf-rules.js';

const VIEWER_URL = browser.runtime.getURL('viewer.html');
const SPEAK_URL = browser.runtime.getURL('speak.html');
const SETTINGS_KEY = 'settings.v1';

let interceptEnabled = true;

async function loadSettings() {
  try {
    const stored = await browser.storage.local.get(SETTINGS_KEY);
    interceptEnabled = stored?.[SETTINGS_KEY]?.interceptPdfLinks !== false;
  } catch {
    interceptEnabled = true;
  }
}

browser.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes[SETTINGS_KEY]) {
    const enabled = changes[SETTINGS_KEY].newValue?.interceptPdfLinks !== false;
    if (enabled === interceptEnabled) return;
    interceptEnabled = enabled;
    updatePdfRules();
  }
});

/** name — имя файла от сервера: по адресу вида /download?id=7 его не угадать. */
function viewerFor(url, name) {
  const query = `?file=${encodeURIComponent(url)}`;
  return `${VIEWER_URL}${query}${name ? `&name=${encodeURIComponent(name)}` : ''}`;
}

function looksLikePdfUrl(url) {
  try {
    return /\.pdf($|[?#])/i.test(new URL(url).pathname + new URL(url).search);
  } catch {
    return false;
  }
}

function headerValue(headers, name) {
  return headers?.find((header) => header.name.toLowerCase() === name)?.value || '';
}

/** Скачивание не перехватываем: пользователь просил файл, а не чтение. */
function isAttachment(headers) {
  return /^\s*attachment/i.test(headerValue(headers, 'content-disposition'));
}

function shouldIntercept(details) {
  if (!interceptEnabled) return false;
  if (details.type !== 'main_frame') return false;
  if (details.url.startsWith(VIEWER_URL)) return false;
  if (isAttachment(details.responseHeaders)) return false;

  const contentType = headerValue(details.responseHeaders, 'content-type').toLowerCase();
  if (contentType.includes('application/pdf')) return true;
  // Некоторые серверы отдают PDF как поток байтов — смотрим на адрес.
  return contentType.includes('application/octet-stream') && looksLikePdfUrl(details.url);
}

// Слушатели регистрируем синхронно при старте: иначе события не разбудят
// фоновую страницу, которая живёт не постоянно.
let blockingRegistered = false;
try {
  browser.webRequest.onHeadersReceived.addListener(
    (details) => {
      if (!shouldIntercept(details)) return {};
      const name = filenameFromContentDisposition(headerValue(details.responseHeaders, 'content-disposition'));
      return { redirectUrl: viewerFor(details.url, name) };
    },
    { urls: ['http://*/*', 'https://*/*'], types: ['main_frame'] },
    ['blocking', 'responseHeaders']
  );
  blockingRegistered = true;
} catch (error) {
  console.warn('Блокирующий webRequest недоступен, остаётся запасной перехват', error);
}

// Запасной путь на случай, если блокирующий webRequest в этой сборке Firefox
// не действует: судим только по адресу и подменяем вкладку уже в начале
// загрузки. Регистрация без исключения ещё не значит, что перехват работает,
// поэтому дополнительно спрашиваем само разрешение.
let blockingActive = blockingRegistered;
if (blockingRegistered) {
  browser.permissions
    ?.contains({ permissions: ['webRequestBlocking'] })
    .then((granted) => {
      blockingActive = granted;
      if (!blockingActive) console.info('PDF-читалка: перехват работает по адресу страницы');
    })
    .catch(() => {});
}

// Chrome: правила перехвата. Динамические — переживают перезапуск браузера,
// даже если service worker после него ещё не просыпался. Поэтому считаем их
// действующими сразу: иначе вкладка, разбудившая воркер ссылкой на .pdf, ушла
// бы во вьюер дважды — правилом и запасным путём.
let rulesActive = !blockingRegistered && typeof browser.declarativeNetRequest?.updateDynamicRules === 'function';

// Chrome умеет пускать расширения к локальным файлам (галочка «Разрешить
// доступ к URL файлов»): тогда и PDF, открытый двойным щелчком, — в читалку.
let fileAccess = false;
browser.extension
  ?.isAllowedFileSchemeAccess?.()
  .then((allowed) => {
    fileAccess = Boolean(allowed);
  })
  .catch(() => {});

async function syncPdfRules() {
  const dnr = browser.declarativeNetRequest;
  if (blockingRegistered || !dnr?.updateDynamicRules) return false;
  await dnr.updateDynamicRules({ removeRuleIds: PDF_RULE_IDS, addRules: interceptEnabled ? pdfRules(VIEWER_URL) : [] });
  return true;
}

function updatePdfRules() {
  syncPdfRules()
    .then((active) => {
      rulesActive = active;
    })
    .catch((error) => {
      rulesActive = false;
      console.warn('Правила перехвата PDF не встали — перехват по адресу страницы', error);
    });
}

function onTabUpdated(tabId, changeInfo) {
  const { url } = changeInfo;
  if (!interceptEnabled || changeInfo.status !== 'loading' || !url) return;
  if (url.startsWith(VIEWER_URL) || !looksLikePdfUrl(url)) return;
  // Локальный файл заголовков не имеет — его правила и webRequest не видят.
  const localFile = fileAccess && /^file:/i.test(url);
  if (!localFile && (blockingActive || rulesActive || !/^https?:/i.test(url))) return;
  browser.tabs.update(tabId, { url: viewerFor(url) });
}
try {
  // Фильтр событий есть только в Firefox; Chrome на второй аргумент ругается.
  browser.tabs.onUpdated.addListener(onTabUpdated, { properties: ['status'] });
} catch {
  browser.tabs.onUpdated.addListener(onTabUpdated);
}

browser.action.onClicked.addListener(() => {
  browser.tabs.create({ url: VIEWER_URL });
});

browser.runtime.onInstalled.addListener(() => {
  browser.contextMenus.create({
    id: 'open-link-in-reader',
    title: 'Открыть ссылку в PDF-читалке',
    contexts: ['link'],
    targetUrlPatterns: ['*://*/*.pdf*', '*://*/*.PDF*'],
  });
  browser.contextMenus.create({
    id: 'open-page-in-reader',
    title: 'Открыть эту страницу в PDF-читалке',
    contexts: ['page'],
    documentUrlPatterns: ['*://*/*'],
  });
  browser.contextMenus.create({
    id: 'speak-selection',
    title: 'Озвучить выделенное',
    contexts: ['selection'],
  });
  browser.contextMenus.create({
    id: 'open-reader',
    title: 'Открыть PDF-читалку',
    contexts: ['action'],
  });
});

browser.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === 'open-link-in-reader' && info.linkUrl) {
    browser.tabs.create({ url: viewerFor(info.linkUrl), index: tab ? tab.index + 1 : undefined });
  } else if (info.menuItemId === 'open-page-in-reader' && info.pageUrl) {
    browser.tabs.update(tab.id, { url: viewerFor(info.pageUrl) });
  } else if (info.menuItemId === 'open-reader') {
    browser.tabs.create({ url: VIEWER_URL });
  } else if (info.menuItemId === 'speak-selection' && tab) {
    speakSelection(tab, info);
  }
});

// ── Озвучка выделенного на любой странице ──────────────────────────────
//
// Читаем прямо на сайте: content/speak-overlay.js подсвечивает читаемую
// фразу и слово на самой странице и ставит в углу плашку управления
// (speak-pill.html). Следующее выделение встаёт в очередь за предыдущим.
// Сочетание клавиш без нового выделения ставит чтение на паузу и продолжает.
//
// Куда расширениям нельзя (about:, магазин дополнений, режим чтения), текст
// открывается в маленьком окне speak.html: он кладётся в storage.session
// (живёт до закрытия браузера), и если окно уже открыто — приходит туда же.

const SPEAK_KEY_PREFIX = 'speak:';
const SPEAK_CSS = `
::highlight(pdf-reader-speak-sentence) { background-color: rgb(255 214 0 / 0.32); }
::highlight(pdf-reader-speak-queue) { background-color: rgb(255 214 0 / 0.16); }
::highlight(pdf-reader-speak-word) { background-color: rgb(255 170 0 / 0.65); color: inherit; }
`;

/** Читать на самой странице. false — нельзя или нечего (тогда — окно). */
async function speakOnPage(tab, frameId) {
  const target = frameId === undefined ? { tabId: tab.id, allFrames: true } : { tabId: tab.id, frameIds: [frameId] };
  try {
    // В каком кадре выделение и где уже читается: сам скрипт ставим только туда.
    const probes = await browser.scripting.executeScript({
      target,
      func: () => ({
        selected: /[\p{L}\p{N}]/u.test(String(globalThis.getSelection?.() ?? '')),
        active: Boolean(globalThis.__pdfReaderSpeak?.active),
      }),
    });
    const withSelection = probes.find((probe) => probe.result?.selected);
    if (withSelection) {
      const frame = { tabId: tab.id, frameIds: [withSelection.frameId] };
      await browser.scripting.insertCSS({ target: frame, css: SPEAK_CSS });
      // Обёртка первой: в Chrome у скрипта на странице есть только chrome.*.
      await browser.scripting.executeScript({ target: frame, files: ['browser-shim.js', 'content/speak-overlay.js'] });
      const [started] = await browser.scripting.executeScript({ target: frame, func: () => globalThis.__pdfReaderSpeak.fromSelection() });
      return Boolean(started?.result);
    }
    const reading = probes.find((probe) => probe.result?.active);
    if (!reading) return false;
    await browser.scripting.executeScript({
      target: { tabId: tab.id, frameIds: [reading.frameId] },
      func: () => globalThis.__pdfReaderSpeak.toggle(),
    });
    return true;
  } catch {
    return false; // страница, куда расширениям нельзя (about:, магазин дополнений)
  }
}

async function selectionOf(tab, frameId) {
  try {
    const results = await browser.scripting.executeScript({
      target: frameId === undefined ? { tabId: tab.id, allFrames: true } : { tabId: tab.id, frameIds: [frameId] },
      func: () => String(globalThis.getSelection?.() ?? ''),
    });
    return results.map((result) => result?.result || '').find((text) => text.trim()) || '';
  } catch {
    return '';
  }
}

async function speakSelection(tab, info = {}) {
  // Вкладка самой читалки: читает она, очередью и с подсветкой в PDF.
  if (tab.url?.startsWith(VIEWER_URL)) {
    browser.runtime.sendMessage({ type: 'pdf-reader-speak-selection', tabId: tab.id }).catch(() => {});
    return;
  }
  if (await speakOnPage(tab, info.frameId)) return;
  let text = await selectionOf(tab, info.frameId);
  if (!text.trim()) text = info.selectionText || '';
  if (!text.trim()) return;

  const id = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const session = browser.storage.session;
  const stored = await session.get(null);
  const stale = Object.keys(stored).filter((key) => key.startsWith(SPEAK_KEY_PREFIX));
  if (stale.length) await session.remove(stale);
  await session.set({ [`${SPEAK_KEY_PREFIX}${id}`]: { text, title: tab.title || '', url: tab.url || '' } });

  const url = `${SPEAK_URL}#${id}`;
  if (stored.speakWindowId) {
    try {
      const window = await browser.windows.get(stored.speakWindowId, { populate: true });
      const speakTab = window.tabs?.find((candidate) => candidate.url?.startsWith(SPEAK_URL));
      if (speakTab) {
        await browser.tabs.update(speakTab.id, { url });
        await browser.windows.update(window.id, { focused: true });
        return;
      }
    } catch {
      /* окно уже закрыли */
    }
  }
  const window = await browser.windows.create({ url, type: 'popup', width: 580, height: 720 });
  await session.set({ speakWindowId: window.id });
}

// Для проверок: меню правой кнопки автотестом не нажать.
globalThis.pdfReaderBackground = { speakSelection };

browser.commands?.onCommand.addListener(async (command) => {
  if (command !== 'speak-selection') return;
  const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
  if (tab) speakSelection(tab);
});

loadSettings().then(updatePdfRules);
