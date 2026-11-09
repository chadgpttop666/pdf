// Кнопки наушников через ускоритель (Windows). До браузера кнопка «громче»
// не доходит — её забирает система, — а «следующий трек» доходит не всегда.
// Ускоритель (1.6.0+) на время примечания занимает обе клавиши и следит за
// громкостью системы (у Bluetooth-наушников кнопка меняет её напрямую) — и
// сообщает о нажатии; громкость при этом не меняется. Вне примечаний кнопки
// работают как обычно.
//
// Подключение своё: ускоритель для синтеза может быть и не нужен (голос
// системы, Piper), а кнопки — нужны. Открывается, когда пошло чтение, и
// закрывается, когда его остановили.

import { compareVersions, connectHelper } from './tera-native.js';

/** С какой версии ускоритель ловит кнопки. */
export const KEYS_SINCE = '1.6.0';

/**
 * @param onKey (key) => во время примечания нажали 'volume-up' или 'next'
 * @param enabled () => включено в настройках
 * @param connect подключение к ускорителю (connectHelper; в проверках — своё)
 */
export function createHelperKeys({ onKey, enabled = () => true, connect = connectHelper }) {
  let connection = null; // Promise<клиент | null>
  let wanted = false; // звучит примечание — перехват нужен
  let applied = false; // что последним сказали ускорителю
  let queue = Promise.resolve();

  function client() {
    connection ??= connect()
      .then((result) => {
        if (!result) return null;
        // Ускоритель старше 1.6.0 или не Windows — кнопки ловит только браузер.
        if (!result.hello.features?.includes('media-keys')) {
          result.client.close();
          // Старый вот-вот обновится сам (это делает TeraTTS) — к следующему примечанию спросим снова.
          if (compareVersions(result.hello.version, KEYS_SINCE) < 0) connection = null;
          return null;
        }
        result.client.onEvent((event) => {
          if (event.event === 'media-key' && wanted) onKey(event.key);
        });
        const mine = connection;
        result.client.onClose(() => {
          if (connection !== mine) return;
          connection = null;
          applied = false;
        });
        return result.client;
      })
      .catch(() => null);
    return connection;
  }

  /** Сказать ускорителю, что нужно сейчас, — по очереди: быстрые вкл/выкл не перепутаются. */
  function sync() {
    queue = queue.then(async () => {
      const target = wanted && enabled();
      if (target === applied) return;
      const helper = target ? await client() : await connection;
      if (!helper) return;
      const reply = await helper.watchMediaKeys(target).catch(() => null);
      applied = Boolean(reply?.on);
    });
    return queue;
  }

  return {
    /** Чтение пошло: подключиться заранее, чтобы первое примечание не ждало. */
    prepare() {
      if (enabled()) client();
    },
    /** Звучит примечание (true) или уже нет. */
    note(on) {
      wanted = Boolean(on);
      return sync();
    },
    /** Чтение остановлено: отпустить кнопки и закрыть подключение (ускоритель выйдет). */
    close() {
      wanted = false;
      const closing = connection;
      connection = null;
      queue = queue.then(async () => {
        const helper = await closing;
        if (helper && applied) await helper.watchMediaKeys(false).catch(() => {});
        applied = false;
        helper?.close();
      });
      return queue;
    },
    /** Перехват сейчас включён (для проверок). */
    get active() {
      return applied;
    },
  };
}
