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
import { createTts } from './tts/controller.js';
import { bindKeyboard } from './keyboard.js';
import { createHud } from './ui/hud.js';
import { createHelp } from './ui/help.js';
import { createToolbar } from './ui/toolbar.js';

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
  tts: null,
  help: null,
  zoomIntent: 'page-width',
  wakeLock: null,
};

function applyUiTheme() {
  appEl.dataset.uiTheme = getSetting('uiTheme');
}

function setZoom(value, { announce = false } = {}) {
  if (!value) return;
  app.zoomIntent = value;
  app.pdfViewer.currentScaleValue = value;
  if (announce) app.hud.show(`Масштаб ${Math.round(app.pdfViewer.currentScale * 100)}%`);
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
  return openSource(() => app.loader.openUrl(url, options), url);
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

function wireSidebarToggle() {
  const sidebar = $('sidebar');
  const body = $('body');

  function apply(open) {
    sidebar.hidden = !open;
    body.style.setProperty('--sidebar-offset', open ? `${sidebar.offsetWidth || 260}px` : '0px');
    $('btnSidebar').setAttribute('aria-pressed', String(open));
    // Ширина области изменилась — масштабы вида «по ширине» надо пересчитать.
    if (app.pdfViewer?.pdfDocument) app.pdfViewer.update();
  }

  on($('btnSidebar'), 'click', () => {
    const open = sidebar.hidden;
    updateSettings({ sidebarOpen: open });
    apply(open);
  });

  app.toggleSidebar = (open) => {
    const next = open ?? sidebar.hidden;
    updateSettings({ sidebarOpen: next });
    apply(next);
  };

  apply(getSetting('sidebarOpen'));
}

function documentUrlFromQuery() {
  const params = new URLSearchParams(location.search);
  const file = params.get('file');
  return file && isSafeDocumentUrl(file) ? file : null;
}

async function main() {
  await loadSettings();
  applyUiTheme();

  const core = createViewer({ container: $('viewerContainer'), viewerEl: $('viewer') });
  Object.assign(app, core);
  app.loader = new DocumentLoader(core);
  app.hud = createHud($('hud'));
  app.setZoom = setZoom;
  app.openFile = openFile;
  app.openUrl = openUrl;
  app.toolbar = createToolbar(app);
  app.wakeLock = createWakeLock();
  app.scroller = createScroller(app.container);
  app.screenNav = createScreenNav(app);
  app.autoScroll = createAutoScroll(app);
  app.help = createHelp();
  app.appearance = createAppearance(app);
  app.tts = createTts(app);

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
    app.autoScroll.stop();
    app.tts?.stop();
    app.find?.close();
    app.appearance?.closePanel();
    $('viewerContainer').focus();
  };

  bindKeyboard(app);
  on($('btnHelp'), 'click', () => app.help.toggle());
  on($('welcomeHelp'), 'click', () => app.help.open());

  app.eventBus.on('pagesinit', () => {
    if (!app.restoredZoom) setZoom(getSetting('defaultZoom'));
  });

  onSettingsChanged((_all, changed) => {
    if ('uiTheme' in changed) applyUiTheme();
  });

  wireFileInputs();
  wireDragAndDrop();
  wireProgress();
  wireSidebarToggle();

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
