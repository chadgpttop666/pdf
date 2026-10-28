// Фоновая страница: перехватывает открытие PDF и уводит их в наш вьюер.
//
// Firefox, в отличие от Chrome, сохранил блокирующий webRequest — им можно
// посмотреть на Content-Type ответа и подменить страницу до её отрисовки.
// Если разрешение почему-то недоступно, остаётся запасной путь по адресу
// страницы, а вручную документ всегда можно открыть из самого вьюера.

import { filenameFromContentDisposition } from './src/file-name.js';

const VIEWER_URL = browser.runtime.getURL('viewer.html');
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
    interceptEnabled = changes[SETTINGS_KEY].newValue?.interceptPdfLinks !== false;
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
browser.permissions
  ?.contains({ permissions: ['webRequestBlocking'] })
  .then((granted) => {
    blockingActive = blockingRegistered && granted;
    if (!blockingActive) console.info('PDF-читалка: перехват работает по адресу страницы');
  })
  .catch(() => {
    blockingActive = blockingRegistered;
  });

browser.tabs.onUpdated.addListener(
  (tabId, changeInfo) => {
    if (blockingActive || !interceptEnabled) return;
    if (changeInfo.status !== 'loading' || !changeInfo.url) return;
    if (changeInfo.url.startsWith(VIEWER_URL)) return;
    if (!/^https?:/i.test(changeInfo.url) || !looksLikePdfUrl(changeInfo.url)) return;
    browser.tabs.update(tabId, { url: viewerFor(changeInfo.url) });
  },
  { properties: ['status'] }
);

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
    id: 'open-reader',
    title: 'Открыть PDF-читалку',
    contexts: ['browser_action', 'action'],
  });
});

browser.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === 'open-link-in-reader' && info.linkUrl) {
    browser.tabs.create({ url: viewerFor(info.linkUrl), index: tab ? tab.index + 1 : undefined });
  } else if (info.menuItemId === 'open-page-in-reader' && info.pageUrl) {
    browser.tabs.update(tab.id, { url: viewerFor(info.pageUrl) });
  } else if (info.menuItemId === 'open-reader') {
    browser.tabs.create({ url: VIEWER_URL });
  }
});

loadSettings();
