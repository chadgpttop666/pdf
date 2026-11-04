// Обновления читалки: проверка, скачивание, установка — и галочка
// «Обновлять автоматически» в настройках (autoUpdate, по умолчанию включена).
// С галочкой всё идёт само, без участия человека; новая версия ставится,
// когда вкладки читалки закрыты (или при запуске браузера), — чтение не
// прерывается. Без галочки читалка только сообщает о новой версии, а ставит
// её кнопка «Обновить сейчас».
//
// Firefox скачивает обновления сам (update_url в манифесте). Пока читалка
// слушает runtime.onUpdateAvailable, Firefox не ставит скачанную версию
// посреди работы: ставит при перезапуске расширения или браузера — здесь
// решаем, когда.
//
// Chrome ставит обновления только из Chrome Web Store, а распакованное
// расширение (загруженное из папки) при перезапуске перечитывает с диска.
// Писать в свою папку расширение не может — может ускоритель, обычная
// программа на компьютере (native/src/browsers.rs). Поэтому:
// 1. раз в 6 часов service worker смотрит на GitHub, есть ли версия новее
//    (updates-chrome.json рядом с релизом: версия, адрес zip, SHA-256);
// 2. скачивает архив, сверяет SHA-256, раскладывает на файлы и передаёт их
//    ускорителю — тот собирает версию в своей папке;
// 3. ускоритель пишет версию в папку расширения, расширение
//    перезапускается. Закладки, заметки и голоса остаются: ID расширения
//    постоянный (key в манифесте). Открытые вкладки читалки открываются снова.

import { compareVersions, connectHelper } from './tts/tera-native.js';
import { readZip } from './unzip.js';

export const UPDATE_URL = 'https://github.com/chadgpttop666/pdf/releases/latest/download/updates-chrome.json';
export const STATE_KEY = 'updateState';
const SETTINGS_KEY = 'settings.v1';
// Свой адрес описания релиза — только для проверок (tests/e2e/chrome.mjs).
const URL_OVERRIDE_KEY = 'chromeUpdateUrl';
const REOPEN_KEY = 'updateReopen';
const CHECK_EVERY_MS = 6 * 60 * 60 * 1000;

const api = () => globalThis.browser;

export function isChromeExtension() {
  return globalThis.location?.protocol === 'chrome-extension:';
}

export async function readState() {
  return (await api().storage.local.get(STATE_KEY))[STATE_KEY] ?? {};
}

async function writeState(patch) {
  const next = { ...(await readState()), ...patch };
  await api().storage.local.set({ [STATE_KEY]: next });
  return next;
}

/** Галочка «Обновлять автоматически». */
export async function autoUpdateEnabled() {
  const settings = (await api().storage.local.get(SETTINGS_KEY))[SETTINGS_KEY];
  return settings?.autoUpdate !== false;
}

async function sha256Hex(bytes) {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

const currentVersion = () => api().runtime.getManifest().version;

let running = null;

/**
 * Проверить обновления — одна проверка за раз.
 * @param force не смотреть, когда проверяли в последний раз
 * @param install поставить, даже если галочка выключена (кнопка «Обновить сейчас»)
 */
export function checkForUpdate(options = {}) {
  running ??= (isChromeExtension() ? checkChrome(options) : checkFirefox(options)).finally(() => {
    running = null;
  });
  return running;
}

// ── Firefox ─────────────────────────────────────────────────────────────

async function checkFirefox({ force = false } = {}) {
  const state = await readState();
  if (state.staged && compareVersions(state.staged, currentVersion()) > 0) return state;
  if (!force) return state; // Firefox проверяет сам, примерно раз в сутки
  const result = await api().runtime.requestUpdateCheck?.().catch((error) => ({ status: 'error', message: error.message }));
  // Firefox отвечает { status, details: { version } }, Chrome — { status, version }.
  const status = Array.isArray(result) ? result[0] : result?.status;
  const version = result?.details?.version ?? result?.version ?? (Array.isArray(result) ? result[1]?.version : null);
  if (status === 'update_available') return writeState({ checkedAt: Date.now(), status: 'downloading', latest: version ?? null });
  if (status === 'throttled') return writeState({ checkedAt: Date.now(), status: 'error', message: 'Firefox просит подождать с проверкой — попробуйте позже' });
  if (status === 'error') return writeState({ checkedAt: Date.now(), status: 'error', message: result.message });
  return writeState({ checkedAt: Date.now(), status: 'current', latest: currentVersion(), staged: null });
}

/** Firefox скачал новую версию: ставим сейчас, когда вкладки закрыты, или позже. */
export async function onFirefoxUpdateAvailable(details) {
  await writeState({ status: 'staged', staged: details?.version ?? 'новая', message: null });
  await applyWhenIdle();
}

// ── Chrome ──────────────────────────────────────────────────────────────

async function checkChrome({ force = false, install = false } = {}) {
  const state = await readState();
  const current = currentVersion();
  if (state.staged && compareVersions(state.staged, current) > 0) {
    if (install) await applyWhenIdle({ now: true });
    else await applyWhenIdle();
    return readState();
  }
  if (!force && !install && Date.now() - (state.checkedAt || 0) < CHECK_EVERY_MS) return state;

  const stamp = { checkedAt: Date.now() };
  let info;
  try {
    const source = (await api().storage.local.get(URL_OVERRIDE_KEY))[URL_OVERRIDE_KEY] || UPDATE_URL;
    const response = await fetch(source, { cache: 'no-store' });
    if (!response.ok) throw new Error(`GitHub ответил ${response.status}`);
    info = await response.json();
  } catch (error) {
    return writeState({ ...stamp, status: 'error', message: `не проверил обновления: ${error.message}` });
  }
  if (!info?.version || compareVersions(info.version, current) <= 0) {
    return writeState({ ...stamp, status: 'current', latest: info?.version ?? current, staged: null, files: null, message: null });
  }
  // Без галочки — только сказать о новой версии; скачает кнопка «Обновить сейчас».
  if (!install && !(await autoUpdateEnabled())) return writeState({ ...stamp, status: 'available', latest: info.version, message: null });

  const connection = await connectHelper();
  if (!connection) return writeState({ ...stamp, status: 'no-helper', latest: info.version });
  const { client, hello } = connection;
  try {
    if (!hello.features?.includes('ext-update')) return writeState({ ...stamp, status: 'no-helper', latest: info.version });
    const paths = await client.extensionPaths();
    if (!paths.length) return writeState({ ...stamp, status: 'no-folder', latest: info.version });
    await writeState({ ...stamp, status: 'downloading', latest: info.version, message: null });
    const response = await fetch(info.url, { cache: 'no-store' });
    if (!response.ok) throw new Error(`GitHub ответил ${response.status}`);
    const zip = new Uint8Array(await response.arrayBuffer());
    if ((await sha256Hex(zip)) !== String(info.sha256).toLowerCase()) throw new Error('скачанный архив не совпал с ожидаемым');
    const files = await readZip(zip);
    const manifest = files.find((file) => file.name === 'manifest.json');
    if (!manifest || JSON.parse(new TextDecoder().decode(manifest.data)).version !== info.version) throw new Error('в архиве не та версия');
    for (const file of files) await client.stageExtensionFile(info.version, file.name, new Blob([file.data]));
    await writeState({ status: 'staged', staged: info.version, files: files.map((file) => file.name), message: null });
  } catch (error) {
    return writeState({ status: 'error', message: error.message });
  } finally {
    client.close();
  }
  await applyWhenIdle({ now: install });
  return readState();
}

// ── Установка ───────────────────────────────────────────────────────────

/** Открыты ли страницы читалки: вкладки, окна, плашки озвучки на сайтах. */
async function extensionPagesOpen() {
  const views = api().extension?.getViews?.();
  if (views) return views.some((view) => view !== globalThis);
  const contexts = await api()
    .runtime.getContexts?.({ contextTypes: ['TAB', 'POPUP', 'SIDE_PANEL'] })
    .catch(() => []);
  return Boolean(contexts?.length);
}

/**
 * Поставить готовую версию и перезапустить расширение.
 * @param now сейчас, даже если открыты вкладки: они откроются заново после перезапуска
 */
export async function applyWhenIdle({ now = false } = {}) {
  const state = await readState();
  if (!state.staged) return false;
  if (!now) {
    if (!(await autoUpdateEnabled())) {
      if (state.status !== 'available') await writeState({ status: 'available', latest: state.staged });
      return false;
    }
    if (await extensionPagesOpen()) {
      if (state.status !== 'waiting') await writeState({ status: 'waiting' });
      return false;
    }
  }
  const prefix = api().runtime.getURL('');
  const tabs = (await api().tabs.query({})).filter((tab) => tab.url?.startsWith(prefix));
  await api().storage.local.set({ [REOPEN_KEY]: tabs.map(({ url, active, windowId, index }) => ({ url, active, windowId, index })) });
  if (isChromeExtension()) {
    if (!state.files?.length) return false;
    const connection = await connectHelper();
    if (!connection) return false;
    try {
      await connection.client.applyExtension(state.staged, state.files);
    } catch (error) {
      await api().storage.local.remove(REOPEN_KEY);
      await writeState({ status: 'error', message: error.message });
      return false;
    } finally {
      connection.client.close();
    }
  }
  await writeState({ status: 'applied', applied: state.staged, staged: null, files: null, message: null });
  api().runtime.reload();
  return true;
}

/**
 * После обновления: отметить, что версия стоит (Firefox мог поставить её сам
 * при перезапуске), и вернуть вкладки читалки, которые были открыты.
 */
export async function reopenAfterUpdate() {
  const state = await readState();
  if (state.staged && compareVersions(state.staged, currentVersion()) <= 0) {
    await writeState({ status: 'applied', applied: currentVersion(), staged: null, files: null, message: null });
  }
  const saved = (await api().storage.local.get(REOPEN_KEY))[REOPEN_KEY];
  await api().storage.local.remove(REOPEN_KEY);
  const prefix = api().runtime.getURL('');
  const open = new Set((await api().tabs.query({})).map((tab) => tab.url));
  for (const tab of saved ?? []) {
    if (!tab.url?.startsWith(prefix) || open.has(tab.url)) continue;
    await api()
      .tabs.create({ url: tab.url, active: tab.active, windowId: tab.windowId, index: tab.index })
      .catch(() => api().tabs.create({ url: tab.url }));
  }
}

/** Есть ли что ставить кнопкой «Обновить сейчас». */
export function canInstall(state) {
  return ['available', 'staged', 'waiting'].includes(state?.status);
}

/** Строка состояния для настроек. */
export function describeUpdate(state, current, { auto = true, chrome = isChromeExtension() } = {}) {
  switch (state?.status) {
    case 'current':
      return `Стоит последняя версия.${auto ? ` Новые ставятся сами${chrome ? ' — проверяю раз в 6 часов' : ''}.` : ''}`;
    case 'available':
      return `Вышла версия ${state.latest ?? state.staged}${chrome ? '' : ' — Firefox поставит её и сам, при следующем запуске'}.`;
    case 'no-helper':
      return `Вышла версия ${state.latest}. Обновляться сама читалка в Chrome будет через ускоритель — поставьте его выше; или скачайте архив вручную.`;
    case 'no-folder':
      return `Вышла версия ${state.latest}, но ускоритель не нашёл папку расширения в настройках браузера — обновите вручную (README).`;
    case 'downloading':
      return `Скачиваю версию ${state.latest ?? ''}…`;
    case 'staged':
    case 'waiting':
      return `Версия ${state.staged} готова — поставится сама, когда закроете вкладки читалки${chrome ? '' : ' или перезапустите Firefox'}.`;
    case 'applied':
      return `Обновлено до ${state.applied}.`;
    case 'error':
      return `Не получилось: ${state.message}`;
    default:
      return chrome ? 'Проверяю обновления…' : 'Firefox проверяет обновления сам, примерно раз в сутки.';
  }
}
