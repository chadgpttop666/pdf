// Установка ускорителя прямо из расширения. Браузер сам поставить программу
// не может — скачанный файл человек запускает один раз. Всё остальное делает
// сама программа (папка пользователя, регистрация для Firefox, без прав
// администратора) и расширение: разрешения, скачивание с проверкой хэша,
// ожидание установки, передача моделей, обновления.

import { HELPER_RELEASE, helperUrl } from './helper-release.js';
import { connectHelper } from './tera-native.js';

export const HELPER_PERMISSIONS = { permissions: ['nativeMessaging', 'downloads', 'downloads.open'] };
// Сколько ждать, пока человек запустит установщик и пройдёт SmartScreen.
const WAIT_INSTALL_MS = 10 * 60 * 1000;

const api = () => globalThis.browser;

export async function hasPermission() {
  try {
    return Boolean(await api()?.permissions?.contains(HELPER_PERMISSIONS));
  } catch {
    return false;
  }
}

/** Сборка для этой системы или null (ускоритель есть для Windows и Linux x86-64). */
export async function platformFile() {
  const info = await api()?.runtime?.getPlatformInfo?.().catch(() => null);
  const file = info?.arch === 'x86-64' ? HELPER_RELEASE.files[info.os] : null;
  return file?.sha256 ? file : null;
}

async function sha256Hex(blob) {
  const digest = await crypto.subtle.digest('SHA-256', await blob.arrayBuffer());
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** Сборка помощника с GitHub — ровно та, чей хэш записан в расширении. */
export async function fetchHelper() {
  const file = await platformFile();
  if (!file) throw new Error('Для этой системы ускорителя пока нет');
  const response = await fetch(helperUrl(file));
  if (!response.ok) throw new Error(`GitHub ответил ${response.status}`);
  const blob = await response.blob();
  if ((await sha256Hex(blob)) !== file.sha256) throw new Error('Скачанный файл не совпал с ожидаемым — попробуйте ещё раз');
  return { blob, sha256: file.sha256, name: file.name };
}

function downloadFinished(id) {
  const downloads = api().downloads;
  return new Promise((resolve, reject) => {
    const listener = (delta) => {
      if (delta.id !== id || !delta.state) return;
      if (delta.state.current === 'complete') done(resolve);
      else if (delta.state.current === 'interrupted') done(() => reject(new Error(`Загрузка прервалась: ${delta.error?.current || 'ошибка'}`)));
    };
    const done = (finish) => {
      downloads.onChanged.removeListener(listener);
      finish();
    };
    downloads.onChanged.addListener(listener);
    // Маленький файл мог докачаться раньше, чем мы начали слушать.
    downloads.search({ id }).then(([item]) => item?.state === 'complete' && done(resolve));
  });
}

/** Скачать установщик в «Загрузки». @returns id загрузки */
export async function downloadInstaller() {
  const { blob, name } = await fetchHelper();
  const url = URL.createObjectURL(blob);
  try {
    const id = await api().downloads.download({ url, filename: name, conflictAction: 'overwrite', saveAs: false });
    await downloadFinished(id);
    return id;
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 60 * 1000);
  }
}

/**
 * Запустить скачанный установщик. Вызывать прямо из обработчика нажатия:
 * Firefox открывает файлы только по действию человека.
 * @returns {Promise<boolean>} открылся; нет — показали его в папке
 */
export function runInstaller(id) {
  const downloads = api().downloads;
  return downloads.open(id).then(
    () => true,
    () => downloads.show(id).then(
      () => false,
      () => false
    )
  );
}

/** Ждать, пока установщик зарегистрирует помощника для Firefox. */
export async function waitForHelper({ timeoutMs = WAIT_INSTALL_MS, isCancelled = () => false } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline && !isCancelled()) {
    const connection = await connectHelper({ timeout: 4000 });
    if (connection) return connection;
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  return null;
}

/** Убрать скачанный установщик: программа уже скопировала себя на место. */
export async function forgetInstaller(id) {
  await api()
    .downloads.removeFile(id)
    .catch(() => {});
  await api()
    .downloads.erase({ id })
    .catch(() => {});
}

/**
 * Установка по шагам — общая для настроек читалки и плашки на сайте. Состояние
 * живёт, пока открыта страница: окно настроек можно закрыть и открыть.
 *   checking → unsupported | missing | syncing → working
 *   missing → (install) → downloading → ready → (run) → waiting → syncing → working
 * @param tera провайдер TeraTTS (tera-provider.js): helperStatus, prepareHelper, removeHelper
 */
export function createHelperFlow(tera) {
  let state = { step: 'checking' };
  let attempt = 0; // растёт при каждом новом действии: старые ожидания замолкают
  const listeners = new Set();
  const set = (next) => {
    state = next;
    for (const listener of listeners) listener(state);
  };
  const fail = (error) => set({ step: 'error', message: error?.message || String(error) });

  async function check() {
    if (!(await platformFile())) return set({ step: 'unsupported' });
    if (!(await hasPermission())) return set({ step: 'missing' });
    const status = await tera.helperStatus();
    if (!status.installed) return set({ step: 'missing' });
    if (status.packInstalled && !status.modelsReady) return sync();
    return set({ step: 'working', ...status });
  }

  async function sync() {
    set({ step: 'syncing', progress: 0 });
    try {
      await tera.prepareHelper((loaded, total) => set({ step: 'syncing', progress: total ? loaded / total : 1 }));
      const status = await tera.helperStatus();
      set(status.installed ? { step: 'working', ...status } : { step: 'missing' });
    } catch (error) {
      fail(error);
    }
  }

  return {
    get state() {
      return state;
    },
    onChange(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    /** Узнать, что сейчас с ускорителем (при открытии настроек). */
    refresh() {
      if (['downloading', 'ready', 'waiting', 'syncing'].includes(state.step)) return;
      check().catch(fail);
    },

    /** Нажали «Установить»: разрешение — первым делом, пока действует нажатие. */
    install() {
      const mine = (attempt += 1);
      const asked = api().permissions.request(HELPER_PERMISSIONS);
      (async () => {
        if (!(await asked)) return set({ step: 'missing', message: 'Без разрешения Firefox ускоритель не подключить' });
        if ((await tera.helperStatus()).installed) return check();
        set({ step: 'downloading' });
        const downloadId = await downloadInstaller();
        if (mine === attempt) set({ step: 'ready', downloadId });
      })().catch(fail);
    },

    /** Нажали «Запустить установку». */
    run() {
      const { downloadId } = state;
      const mine = (attempt += 1);
      const opened = runInstaller(downloadId);
      set({ step: 'waiting', downloadId, opened: true });
      opened.then((ok) => !ok && mine === attempt && set({ step: 'waiting', downloadId, opened: false }));
      (async () => {
        const connection = await waitForHelper({ isCancelled: () => mine !== attempt });
        if (mine !== attempt) return connection?.client.close();
        if (!connection) return set({ step: 'ready', downloadId, message: 'Установка не закончилась — запустите файл ещё раз' });
        connection.client.close();
        await forgetInstaller(downloadId);
        await check();
      })().catch(fail);
    },

    async remove() {
      attempt += 1;
      try {
        await tera.removeHelper();
        set({ step: 'missing', message: 'Ускоритель удалён' });
      } catch (error) {
        fail(error);
      }
    },
  };
}

/** Строка состояния для людей. */
export function describeHelper(state) {
  switch (state.step) {
    case 'checking':
      return 'Проверяю…';
    case 'unsupported':
      return 'Ускоритель есть для Windows и Linux (64 бита).';
    case 'missing':
      return state.message || 'Не установлен.';
    case 'downloading':
      return 'Скачиваю установщик (≈20 МБ)…';
    case 'ready':
      return state.message || 'Установщик скачан — запустите его.';
    case 'waiting':
      return state.opened
        ? 'Жду, пока закончится установка. Если Windows скажет «Система Windows защитила ваш компьютер» — нажмите «Подробнее» → «Выполнить в любом случае».'
        : 'Откройте скачанный файл pdf-reader-tts двойным щелчком (он показан в папке загрузок). Если Windows скажет «Система Windows защитила ваш компьютер» — «Подробнее» → «Выполнить в любом случае».';
    case 'syncing':
      return `Передаю ускорителю модели речи: ${Math.round((state.progress || 0) * 100)} %`;
    case 'working':
      return `Работает (версия ${state.version}).${state.packInstalled ? '' : ' Модели передадутся, когда голоса TeraTTS будут скачаны.'}`;
    case 'error':
      return `Не получилось: ${state.message}`;
    default:
      return '';
  }
}

/** Кнопка для состояния: { label, act } — act это метод createHelperFlow; null — без кнопки. */
export function helperButton(state) {
  switch (state.step) {
    case 'missing':
      return { label: 'Установить', act: 'install' };
    case 'ready':
      return { label: 'Запустить установку', act: 'run' };
    case 'waiting':
      return { label: 'Запустить ещё раз', act: 'run' };
    case 'working':
      return { label: 'Удалить', act: 'remove' };
    case 'error':
      return { label: 'Попробовать ещё раз', act: 'install' };
    default:
      return null;
  }
}
