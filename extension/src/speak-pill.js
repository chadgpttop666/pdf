// Плашка озвучки в углу сайта (speak-pill.html в iframe). Текст и место
// для подсветки ей передаёт скрипт страницы (content/speak-overlay.js)
// через MessageChannel: канал принимается, только если в сообщении тот же
// секрет, что в адресе плашки. Обратно уходят места читаемой фразы и слова
// — подсвечивает их сама страница, — размер плашки и её перетаскивание.
//
// Куски выделенного текста приходят очередью: каждый следующий дописывается
// в конец, чтение не прерывается.
//
// Голоса, скорость, громкость и запас подготовки — общие с читалкой PDF.

import { $, isTypingTarget, on, wireSteppers } from './dom.js';
import { get as getSetting, loadSettings, updateSettings } from './settings.js';
import { sentencesInText } from './speak-text.js';
import { detectLanguage } from './text-index.js';
import { formatClock } from './tts/buffer.js';
import { createEngines, downloadWithConsent, fillVoiceSelect } from './tts/engines.js';
import { createTextReader } from './tts/text-reader.js';
import { hydrateIcons, setIcon } from './ui/icons.js';

const app = $('app');
let port = null;
let ready = false;
let pending = []; // куски, пришедшие раньше, чем загрузились настройки
let sentences = [];
let language = 'ru';
// Обычный ход чтения видно по счётчику на плашке — в строке состояния он лишний.
const ROUTINE_STATUS = /^(Предложение \d+ из \d+|Пауза)?$/;

const send = (message) => port?.postMessage(message);

const engines = createEngines();
const reader = createTextReader(engines, {
  onSentence(index) {
    const sentence = sentences[index];
    if (sentence) send({ type: 'sentence', start: sentence.start, end: sentence.end });
    showCount(index);
  },
  onWord(index, start, length) {
    const sentence = sentences[index];
    if (!sentence) return;
    const from = sentence.start + start;
    send({ type: 'word', start: from, end: Math.min(sentence.end, from + (length || 1)) });
  },
  onState(state) {
    setIcon($('speakPlay'), state === 'speaking' ? 'pause' : 'play');
    if (state !== 'idle') app.classList.remove('waiting');
    if (state === 'idle') send({ type: 'clear' });
    showBuffer();
  },
  onStatus: setStatus,
});

function setStatus(text, { busy = false } = {}) {
  const status = $('pillStatus');
  status.textContent = text;
  status.hidden = ROUTINE_STATUS.test(text);
  app.classList.toggle('busy', busy);
}

// ── Связь со страницей ────────────────────────────────────────────────

addEventListener('message', (event) => {
  const { data } = event;
  if (port || data?.type !== 'pdf-reader-speak-connect' || data.token !== location.hash.slice(1) || !event.ports[0]) return;
  port = event.ports[0];
  port.onmessage = ({ data: message }) => fromPage(message);
  reportSize();
});

function fromPage(message) {
  if (message?.type === 'append') {
    if (ready) add(message.text, message.offset);
    else pending.push(message);
  } else if (message?.type === 'selection') {
    $('pillAdd').hidden = !message.available;
  } else if (message?.type === 'toggle') {
    if (reader.state === 'idle') reader.start(reader.index);
    else reader.toggle();
  }
}

const showCount = (index = reader.index) => {
  $('pillCount').textContent = sentences.length ? `${Math.min(index + 1, sentences.length)} / ${sentences.length}` : '';
};

/** Кусок выделенного — в конец очереди; offset — его место в тексте страницы. */
function add(text, offset) {
  const lang = detectLanguage(text);
  if (!sentences.length) language = lang;
  const added = sentencesInText(text, lang).map((sentence) => ({ ...sentence, start: sentence.start + offset, end: sentence.end + offset }));
  if (!added.length) {
    if (!sentences.length) setStatus('В выделении нет текста для чтения');
    return;
  }
  const first = sentences.length;
  sentences = sentences.concat(added);
  reader.append(added.map((sentence) => sentence.text));
  // Чтение уже кончилось или ещё не начиналось — начинаем с нового куска.
  if (reader.state === 'idle') start(first);
  else showCount();
}

function start(from) {
  reader.start(from);
  showCount(from);
  // Браузер может не дать звуку начаться без нажатия в самой плашке.
  setTimeout(() => {
    if (!reader.audioBlocked) return;
    reader.stop();
    app.classList.add('waiting');
    setStatus('Нажмите ▶ — браузер ждёт нажатия, чтобы включить звук');
  }, 1500);
}

/** Плашка сообщает странице свой размер: iframe ровно по ней, остальной сайт кликается. */
function reportSize() {
  const rect = app.getBoundingClientRect();
  send({ type: 'size', width: rect.width, height: rect.height });
}
new ResizeObserver(reportSize).observe(app);

// ── Кнопки и клавиши ──────────────────────────────────────────────────

function play() {
  app.classList.remove('waiting');
  if (reader.state === 'idle') reader.start(reader.index);
  else reader.toggle();
}

function close() {
  reader.stop();
  send({ type: 'close' });
}

on($('speakPlay'), 'click', play);
on($('pillAdd'), 'click', () => send({ type: 'add-selection' }));
on($('speakPrev'), 'click', () => reader.previous());
on($('speakNext'), 'click', () => reader.next());
on($('pillClose'), 'click', close);
on($('pillMore'), 'click', () => {
  const panel = $('pillPanel');
  panel.hidden = !panel.hidden;
  $('pillMore').setAttribute('aria-expanded', String(!panel.hidden));
  showBuffer();
});

on(document, 'keydown', (event) => {
  if (event.ctrlKey || event.metaKey || event.altKey || isTypingTarget(event.target)) return;
  const actions = { Space: play, ArrowRight: () => reader.next(), ArrowLeft: () => reader.previous(), Escape: close };
  const action = actions[event.code];
  if (!action || (event.code === 'Space' && event.target.closest?.('button'))) return;
  event.preventDefault();
  action();
});

// Перетаскивание за «ручку»: курсор захвачен, движения доходят и за краем плашки.
let drag = null;
on($('pillGrip'), 'pointerdown', (event) => {
  drag = { x: event.screenX, y: event.screenY };
  $('pillGrip').setPointerCapture(event.pointerId);
});
on($('pillGrip'), 'pointermove', (event) => {
  if (!drag) return;
  send({ type: 'move', dx: event.screenX - drag.x, dy: event.screenY - drag.y });
  drag = { x: event.screenX, y: event.screenY };
});
for (const type of ['pointerup', 'pointercancel']) on($('pillGrip'), type, () => (drag = null));

// ── Голос, скорость, громкость ────────────────────────────────────────

async function fillVoices() {
  const stored = getSetting('ttsVoiceUri');
  const { chosen } = fillVoiceSelect($('ttsVoice'), await engines.voices(), { documentLang: language, stored });
  if (chosen && chosen.id !== stored) await updateSettings({ ttsVoiceUri: chosen.id });
  reader.switchProvider();
}

on($('ttsVoice'), 'change', async () => {
  const select = $('ttsVoice');
  const voiceId = select.value;
  const engine = engines.neuralFor(voiceId);
  engine?.unlock();
  if (engine && !(await engine.isInstalled(voiceId)) && !(await downloadWithConsent(engines, voiceId, setStatus))) {
    select.value = getSetting('ttsVoiceUri');
    return;
  }
  await updateSettings({ ttsVoiceUri: voiceId });
  await fillVoices();
});

function syncControls() {
  $('ttsRate').value = String(getSetting('ttsRate'));
  $('ttsRateValue').textContent = `${Number(getSetting('ttsRate')).toFixed(1)}×`;
  $('ttsVolume').value = String(getSetting('ttsVolume'));
  $('ttsVolumeValue').textContent = `${Math.round(Number(getSetting('ttsVolume')) * 100)} %`;
}

on($('ttsRate'), 'input', async () => {
  await updateSettings({ ttsRate: Number($('ttsRate').value) });
  syncControls();
  reader.previewRate();
});
on($('ttsRate'), 'change', () => reader.rateChanged());
on($('ttsVolume'), 'input', async () => {
  const volume = Number($('ttsVolume').value);
  await updateSettings({ ttsVolume: volume });
  syncControls();
  if (reader.state !== 'idle' && !reader.setVolume(volume)) setStatus(`Громкость ${Math.round(volume * 100)} % — со следующей фразы`);
});

/** Запас подготовленной речи — в меню плашки. */
function showBuffer() {
  const badge = $('pillBuffer');
  const visible = !$('pillPanel').hidden && reader.state !== 'idle' && reader.provider.neural && Boolean(reader.provider.prepare);
  badge.hidden = !visible;
  if (visible) badge.textContent = `Готово вперёд: ${formatClock(reader.bufferedSeconds() / (getSetting('ttsRate') || 1))}`;
}

async function main() {
  await loadSettings();
  app.dataset.uiTheme = getSetting('uiTheme');
  syncControls();
  setInterval(showBuffer, 1000);
  await fillVoices();
  ready = true;
  for (const message of pending.splice(0)) add(message.text, message.offset);
  // Для проверок.
  window.speakPill = {
    reader,
    engines,
    get sentences() {
      return sentences;
    },
  };
}

hydrateIcons();
wireSteppers();
main();
