// Точка входа вьюера: собирает ядро pdf.js, поднимает интерфейс и связывает
// между собой независимые модули (прокрутка, озвучка, библиотека и прочее).

import { $, formatBytes, on } from './dom.js';
import { createWakeLock, extensionApi } from './platform.js';
import { getSettings, get as getSetting, loadSettings, onSettingsChanged, updateSettings } from './settings.js';
import { DocumentLoader } from './document-loader.js';
import { createViewer } from './viewer-setup.js';
import { createScroller } from './scroll-engine.js';
import { createScreenNav } from './screen-nav.js';
import { createAutoScroll } from './autoscroll.js';
import { createAppearance } from './appearance.js';
import { createViewLock } from './view-lock.js';
import { createTts } from './tts/controller.js';
import { createFind } from './find-ui.js';
import { createOutline } from './outline.js';
import { createThumbnails } from './thumbnails.js';
import { createSidebar } from './ui/sidebar.js';
import { createReadingState } from './reading-state.js';
import { createBookmarks } from './bookmarks.js';
import { createRecent } from './ui/recent.js';
import { createSettingsDialog } from './ui/settings-dialog.js';
import { bindKeyboard } from './keyboard.js';
import { createHud } from './ui/hud.js';
import { createHelp } from './ui/help.js';
import { createToolbar } from './ui/toolbar.js';
import { hydrateIcons, setIcon } from './ui/icons.js';

const appEl = $('app');

/** Общий контекст: модули получают его и вешают на него свои интерфейсы. */
export const app = {
  el: appEl,
  eventBus: null,
  pdfViewer: null,
  linkService: null,
  findController: null,
  loader: null,
  hud: null,
  toolbar: null,
  scroller: null,
  screenNav: null,
  autoScroll: null,
  appearance: null,
  viewLock: null,
  tts: null,
  find: null,
  outline: null,
  thumbnails: null,
  sidebar: null,
  readingState: null,
  bookmarks: null,
  recent: null,
  help: null,
  zoomIntent: 'page-width',
  wakeLock: null,
};

function applyUiTheme() {
  appEl.dataset.uiTheme = getSetting('uiTheme');
}

/**
 * Единая точка смены масштаба. При закреплённом виде масштаб не меняется:
 * пользователю объясняем почему, остальные вызовы просто молча отклоняются.
 */
function setZoom(value, { announce = false, force = false, fromUser = false } = {}) {
  if (!value) return false;
  if (app.viewLock?.locked && !force) {
    if (fromUser) app.hud.show('Масштаб закреплён — L, чтобы открепить');
    return false;
  }
  app.zoomIntent = value;
  app.pdfViewer.currentScaleValue = value;
  if (announce) app.hud.show(`Масштаб ${Math.round(app.pdfViewer.currentScale * 100)}%`);
  return true;
}

/** Разрешаем открывать только то, что действительно похоже на адрес файла. */
function isSafeDocumentUrl(raw) {
  try {
    const url = new URL(raw, location.href);
    return ['http:', 'https:', 'blob:', 'file:'].includes(url.protocol) || url.origin === location.origin;
  } catch {
    return false;
  }
}

async function openSource(open, describe) {
  try {
    appEl.classList.add('loading');
    await open();
    appEl.classList.add('has-document');
    app.hud.hide();
  } catch (error) {
    console.error('Не удалось открыть документ', error);
    app.hud.show(`Не удалось открыть ${describe}: ${error?.message || error}`, { duration: 6000 });
  } finally {
    appEl.classList.remove('loading');
  }
}

export function openFile(file) {
  return openSource(() => app.loader.openFile(file), file.name);
}

export function openUrl(url, options) {
  // Расширения Firefox не имеют доступа к file:// — честно скажем об этом
  // вместо невнятной ошибки загрузки.
  if (/^file:/i.test(url) && extensionApi) {
    app.hud.show('Локальный файл нельзя открыть по ссылке — перетащите его в окно или нажмите «Открыть»', {
      duration: 8000,
    });
    return Promise.resolve();
  }
  return openSource(() => app.loader.openUrl(url, options), url);
}

/** Открытие документа из локальной библиотеки: ключ уже известен. */
export function openBytesFromLibrary(bytes, record) {
  return openSource(
    () => app.loader.openBytes(bytes, { name: record.name, size: record.size, id: record.id }),
    record.name
  );
}

function wireFileInputs() {
  const picker = $('filePicker');
  const pick = () => picker.click();
  on($('btnOpen'), 'click', pick);
  on($('welcomeOpen'), 'click', pick);
  on(picker, 'change', async () => {
    const [file] = picker.files || [];
    if (file) await openFile(file);
    picker.value = '';
  });
}

function wireDragAndDrop() {
  const overlay = $('dropOverlay');
  let depth = 0;

  on(document, 'dragenter', (event) => {
    if (![...(event.dataTransfer?.types || [])].includes('Files')) return;
    depth += 1;
    overlay.hidden = false;
  });
  on(document, 'dragover', (event) => event.preventDefault());
  on(document, 'dragleave', () => {
    depth = Math.max(0, depth - 1);
    if (!depth) overlay.hidden = true;
  });
  on(document, 'drop', async (event) => {
    event.preventDefault();
    depth = 0;
    overlay.hidden = true;
    const file = [...(event.dataTransfer?.files || [])].find(
      (candidate) => candidate.type === 'application/pdf' || /\.pdf$/i.test(candidate.name)
    );
    if (file) await openFile(file);
    else app.hud.show('Это не PDF-файл');
  });
}

function wireProgress() {
  app.eventBus.on('documentprogress', ({ loaded, total }) => {
    if (!total) return;
    const percent = Math.round((loaded / total) * 100);
    if (percent < 100) app.hud.show(`Загрузка ${percent}% (${formatBytes(loaded)})`, { duration: 3000 });
  });
}

/**
 * Режимы «по ширине» и «страница целиком» pdf.js считает один раз — при
 * изменении области (боковая панель, панели снизу, размер окна) их надо
 * применить заново, иначе страница вылезает за край.
 */
function wireAutoFit() {
  let timer = 0;
  const observer = new ResizeObserver(() => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      if (!app.pdfViewer.pdfDocument || app.viewLock?.locked) return;
      if (['page-width', 'page-fit', 'auto'].includes(app.zoomIntent)) {
        app.pdfViewer.currentScaleValue = app.zoomIntent;
      }
    }, 80);
  });
  observer.observe(app.container);
}

/**
 * Кнопки «−» и «+» у ползунков: сдвигают значение на шаг ползунка и
 * рассылают те же события, что и перетаскивание, — модули их уже слушают.
 */
function wireSteppers() {
  for (const button of document.querySelectorAll('[data-step-for]')) {
    on(button, 'click', () => {
      const input = $(button.dataset.stepFor);
      const step = Number(input.step) || 1;
      const next = Number(input.value) + Number(button.dataset.dir) * step;
      const clamped = Math.min(Number(input.max), Math.max(Number(input.min), next));
      input.value = String(Number(clamped.toFixed(4)));
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
    });
  }
}

function documentUrlFromQuery() {
  const params = new URLSearchParams(location.search);
  const file = params.get('file');
  return file && isSafeDocumentUrl(file) ? file : null;
}

async function main() {
  await loadSettings();
  applyUiTheme();
  hydrateIcons();
  app.icons = { setIcon };

  const core = createViewer({ container: $('viewerContainer'), viewerEl: $('viewer') });
  Object.assign(app, core);
  app.loader = new DocumentLoader(core);
  app.hud = createHud($('hud'));
  app.setZoom = setZoom;
  app.openFile = openFile;
  app.openUrl = openUrl;
  app.openBytesFromLibrary = openBytesFromLibrary;
  app.toolbar = createToolbar(app);
  app.wakeLock = createWakeLock();
  app.scroller = createScroller(app.container);
  app.screenNav = createScreenNav(app);
  app.autoScroll = createAutoScroll(app);
  app.help = createHelp();
  app.appearance = createAppearance(app);
  app.viewLock = createViewLock(app);
  app.tts = createTts(app);
  app.find = createFind(app);
  app.outline = createOutline(app);
  app.thumbnails = createThumbnails(app);
  app.sidebar = createSidebar(app);
  app.toggleSidebar = (open) => app.sidebar.toggle(open);
  app.sidebar.onTabChange((tab) => {
    if (tab === 'thumbs') app.thumbnails.refresh();
  });
  app.readingState = createReadingState(app);
  app.bookmarks = createBookmarks(app);
  app.recent = createRecent(app);
  app.settingsDialog = createSettingsDialog(app);
  await app.recent.render();

  app.toggleChrome = () => {
    const hidden = appEl.classList.toggle('chrome-hidden');
    app.hud.show(hidden ? 'Панели скрыты — F вернёт их' : 'Панели показаны');
    app.pdfViewer.update();
  };

  app.toggleAutoScrollMode = async () => {
    const next = getSetting('autoScrollMode') === 'step' ? 'continuous' : 'step';
    await updateSettings({ autoScrollMode: next });
    app.autoScroll.showPanel();
    app.hud.show(next === 'step' ? 'Автоскролл: шагами' : 'Автоскролл: плавный');
  };

  app.escape = () => {
    if (app.help.isOpen) {
      app.help.close();
      return;
    }
    if (app.settingsDialog?.isOpen) {
      app.settingsDialog.close();
      return;
    }
    app.autoScroll.stop();
    app.tts?.stop();
    app.find?.close();
    app.appearance?.closePanel();
    app.bookmarks?.closePopover();
    $('viewerContainer').focus();
  };

  bindKeyboard(app);
  on($('btnHelp'), 'click', () => app.help.toggle());
  on($('welcomeHelp'), 'click', () => app.help.open());

  onSettingsChanged((_all, changed) => {
    if ('uiTheme' in changed) applyUiTheme();
  });

  wireFileInputs();
  wireDragAndDrop();
  wireProgress();
  wireSteppers();
  wireAutoFit();

  const initial = documentUrlFromQuery();
  if (initial) await openUrl(initial);

  // Фоновая страница может попросить открыть документ уже после запуска.
  extensionApi?.runtime?.onMessage?.addListener((message) => {
    if (message?.type === 'open-url' && isSafeDocumentUrl(message.url)) openUrl(message.url);
  });

  document.dispatchEvent(new CustomEvent('viewer-ready'));
}

main().catch((error) => {
  console.error('Вьюер не запустился', error);
});

window.pdfReaderApp = app;
