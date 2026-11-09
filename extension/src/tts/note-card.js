// Окошко примечания: пока голос читает примечание к сноске, видно, что в нём
// написано, где сейчас голос, сколько оно звучит и сколько ещё осталось, — и
// его можно пропустить: кнопкой или клавишей «.» (следующее предложение).
// «Не читать это» выключает примечание насовсем (у этой книги), «Какие
// примечания читать…» открывает список всех (note-picker.js).

import { $ } from '../dom.js';

// Как в buffer.js: 900 знаков в минуту на обычной скорости.
const CHARS_PER_SECOND = 15;
// Долю прочитанного по словам берём за основу, когда её уже видно.
const TRUST_PROGRESS = 0.15;

const clock = (seconds) => `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, '0')}`;

/**
 * @param onSkip нажали «Пропустить»
 * @param onMute нажали «Не читать это» — (примечание { key, text })
 * @param onPick нажали «Какие примечания читать…»
 * @param wordLength (text, index) => длина слова с этого места — когда голос её не сообщил
 */
export function createNoteCard({ onSkip, onMute = () => {}, onPick = () => {}, wordLength = () => 1 }) {
  const card = $('ttsNote');
  const title = card.querySelector('.tts-note-title');
  const body = card.querySelector('.tts-note-text');
  const time = card.querySelector('.tts-note-time');
  const fill = card.querySelector('.tts-note-fill');
  card.querySelector('.tts-note-skip').addEventListener('click', () => onSkip());
  card.querySelector('.tts-note-mute')?.addEventListener('click', () => note && onMute(note));
  card.querySelector('.tts-note-pick')?.addEventListener('click', () => onPick());

  let note = null; // { key, text, prefix, map } — prefix: длина «Примечание: » в произносимом тексте; map — в text, если голос пропустил ссылки
  let rate = 1;
  let started = false;
  let elapsed = 0; // секунды звучания до последней паузы
  let since = 0; // performance.now(), когда звук пошёл; 0 — на паузе или ещё не начался
  let progress = 0; // доля прочитанных букв
  let timer = 0;

  const seconds = () => elapsed + (since ? (performance.now() - since) / 1000 : 0);

  function render() {
    if (!note) return;
    const spent = seconds();
    const estimate = note.text.length / (CHARS_PER_SECOND * rate);
    const total = progress >= TRUST_PROGRESS && spent > 1 ? Math.max(spent, spent / progress) : Math.max(estimate, spent);
    time.textContent = started ? `${clock(spent)} из ≈ ${clock(total)}` : `≈ ${clock(total)}`;
    fill.style.width = `${Math.min(100, (spent / total) * 100 || 0)}%`;
  }

  /** Окошко — над нижними панелями, чтобы не закрывать кнопки озвучки. */
  function place() {
    const app = $('app').getBoundingClientRect();
    const bars = [...document.querySelectorAll('#app > .bar')].filter((bar) => !bar.hidden && bar.offsetHeight);
    const top = bars.length ? Math.min(...bars.map((bar) => bar.getBoundingClientRect().top)) : app.bottom;
    card.style.bottom = `${Math.max(12, app.bottom - top + 10)}px`;
  }

  /** Подсветить слово, которое звучит, и держать его на виду в окошке. */
  function highlight(start, length) {
    const end = Math.min(note.text.length, start + Math.max(1, length));
    const mark = document.createElement('mark');
    mark.textContent = note.text.slice(start, end);
    body.replaceChildren(note.text.slice(0, start), mark, note.text.slice(end));
    const above = mark.offsetTop < body.scrollTop;
    const below = mark.offsetTop + mark.offsetHeight > body.scrollTop + body.clientHeight;
    if (above || below) body.scrollTop = mark.offsetTop - body.clientHeight / 3;
  }

  window.addEventListener('resize', () => note && place());

  return {
    /**
     * @param next { key, text, prefix }
     * @param options.number, options.count — какое примечание фразы по счёту и сколько их
     * @param options.rate скорость речи — для оценки длительности
     */
    show(next, { number = 1, count = 1, rate: speechRate = 1 } = {}) {
      note = next;
      rate = Number(speechRate) || 1;
      started = false;
      elapsed = 0;
      since = 0;
      progress = 0;
      title.textContent = `Примечание${next.key ? ` ${next.key}` : ''}${count > 1 ? ` · ${number} из ${count}` : ''}`;
      body.textContent = next.text;
      body.scrollTop = 0;
      card.hidden = false;
      place();
      render();
      clearInterval(timer);
      timer = setInterval(render, 250);
    },
    /** Звук примечания пошёл. */
    started() {
      if (!note) return;
      started = true;
      since = performance.now();
      render();
    },
    paused() {
      if (!since) return;
      elapsed += (performance.now() - since) / 1000;
      since = 0;
      render();
    },
    resumed() {
      if (note && started && !since) since = performance.now();
    },
    /** Голос дошёл до слова: charIndex — в произносимом тексте, со словом «Примечание». */
    boundary({ charIndex, charLength }) {
      if (!note) return;
      const spokenAt = charIndex - note.prefix;
      if (spokenAt < 0) return;
      // Голос пропустил ссылки — позиция в тексте окошка по карте.
      const at = note.map ? note.map[spokenAt] : spokenAt;
      if (at === undefined || at >= note.text.length) return;
      progress = Math.max(progress, at / note.text.length);
      highlight(at, charLength || wordLength(note.text, at));
      render();
    },
    hide() {
      note = null;
      card.hidden = true;
      clearInterval(timer);
    },
    get visible() {
      return !card.hidden;
    },
  };
}
