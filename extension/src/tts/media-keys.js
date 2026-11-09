// Кнопки гарнитуры и медиаклавиши (Media Session): пауза и продолжить,
// следующее и предыдущее предложение. Во время примечания «следующий трек»
// (у большинства гарнитур — двойное нажатие) пропускает его.
//
// Браузер отдаёт эти кнопки странице, только пока она играет звук через
// медиаэлемент (<audio>), а озвучка звучит через AudioContext. Поэтому на
// время чтения играет почти беззвучная запись (шум на уровне −90 дБ): её не
// слышно, а Windows видит в читалке плеер и шлёт ей кнопки, даже когда окно
// свёрнуто.
//
// Кнопки громкости до браузера обычно не доходят: их забирает система или
// сама гарнитура. Если же клавиша «громче» пришла в окно читалки (key
// AudioVolumeUp — окно активно), во время примечания она тоже его пропускает.

// Короче 5 с браузер не считает запись «медиа» и кнопки ей не отдаёт.
const SECONDS = 6;
const RATE = 4000;

let silentUrl = null;

/** WAV: шум ±1 из 32768 — для системы звук есть, для уха — нет. */
function silentWav() {
  if (silentUrl) return silentUrl;
  const count = SECONDS * RATE;
  const buffer = new ArrayBuffer(44 + count * 2);
  const view = new DataView(buffer);
  const text = (at, value) => [...value].forEach((char, i) => view.setUint8(at + i, char.charCodeAt(0)));
  text(0, 'RIFF');
  view.setUint32(4, 36 + count * 2, true);
  text(8, 'WAVE');
  text(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, RATE, true);
  view.setUint32(28, RATE * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  text(36, 'data');
  view.setUint32(40, count * 2, true);
  for (let i = 0; i < count; i += 1) view.setInt16(44 + i * 2, i % 2 ? 1 : -1, true);
  silentUrl = URL.createObjectURL(new Blob([buffer], { type: 'audio/wav' }));
  return silentUrl;
}

/**
 * @param actions { playPause, next, previous, stop } — что делать по кнопкам
 * @param isNote () => звучит примечание (клавиша «громче» пропускает его)
 * @param enabled () => включено в настройках
 */
export function createMediaKeys({ actions, isNote, enabled = () => true }) {
  const session = globalThis.navigator?.mediaSession;
  let audio = null;
  let active = false;

  function element() {
    if (!audio) {
      audio = new Audio(silentWav());
      audio.loop = true;
      audio.preload = 'auto';
    }
    return audio;
  }

  function handlers(on) {
    if (!session) return;
    const map = {
      play: actions.playPause,
      pause: actions.playPause,
      nexttrack: actions.next,
      previoustrack: actions.previous,
      // Некоторые гарнитуры шлют перемотку вместо «следующего трека».
      seekforward: actions.next,
      seekbackward: actions.previous,
      stop: actions.stop,
    };
    for (const [action, handler] of Object.entries(map)) {
      try {
        session.setActionHandler(action, on ? () => handler() : null);
      } catch {
        /* браузер не знает такого действия */
      }
    }
  }

  // Клавиша «громче» в окне читалки — во время примечания пропускает его.
  globalThis.document?.addEventListener('keydown', (event) => {
    if (active && event.key === 'AudioVolumeUp' && isNote()) actions.next();
  });

  return {
    /** Чтение пошло (или продолжилось после паузы). @param title — название книги для системного плеера */
    playing(title = '') {
      if (!enabled() || !session) return;
      active = true;
      handlers(true);
      try {
        session.metadata = new MediaMetadata({ title: title || 'Озвучка', artist: 'PDF-читалка' });
      } catch {
        /* MediaMetadata нет — без подписи */
      }
      session.playbackState = 'playing';
      element()
        .play()
        .catch(() => {});
    },
    paused() {
      if (!active) return;
      session.playbackState = 'paused';
      audio?.pause();
    },
    /** Чтение остановлено — кнопки отдаём обратно системе. */
    stopped() {
      if (!active) return;
      active = false;
      audio?.pause();
      handlers(false);
      session.playbackState = 'none';
    },
    get active() {
      return active;
    },
  };
}
