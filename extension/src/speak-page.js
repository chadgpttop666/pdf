// Окно озвучки текста, выделенного на любом сайте. Фоновая страница
// кладёт выделение в storage.session и открывает это окно с номером записи
// в адресе (#id); новое выделение приходит сюда же сменой адреса. Для
// проверок текст можно передать прямо в адресе: speak.html?text=…
//
// Голоса, скорость, громкость и запас подготовки — общие с читалкой PDF.

import { $, isTypingTarget, on, wireSteppers } from './dom.js';
import { get as getSetting, loadSettings, updateSettings } from './settings.js';
import { paragraphsFromSelection, sentencesOf } from './speak-text.js';
import { detectLanguage } from './text-index.js';
import { formatClock, formatSpoken } from './tts/buffer.js';
import { createEngines, downloadWithConsent, fillVoiceSelect } from './tts/engines.js';
import { createTextReader } from './tts/text-reader.js';
import { hydrateIcons, setIcon } from './ui/icons.js';

const app = $('app');
const textBox = $('speakText');
let paragraphs = [];
let spans = [];
let language = 'ru';
let current = null;

const engines = createEngines();
const reader = createTextReader(engines, {
  onSentence(index) {
    current?.classList.remove('current');
    current = spans[index];
    current?.classList.add('current');
    clearWord();
    if (current && !isVisible(current)) current.scrollIntoView({ block: 'center', behavior: 'smooth' });
  },
  onWord(index, start, length) {
    const node = spans[index]?.firstChild;
    if (!node || typeof Highlight === 'undefined' || !CSS.highlights) return;
    const end = Math.min(node.length, start + (length || 1));
    if (start >= end) return;
    const range = new Range();
    range.setStart(node, start);
    range.setEnd(node, end);
    CSS.highlights.set('speak-word', new Highlight(range));
  },
  onState(state) {
    setIcon($('speakPlay'), state === 'speaking' ? 'pause' : 'play');
    if (state === 'idle') {
      clearWord();
      showBuffer();
    }
  },
  onStatus: setStatus,
});

function setStatus(text, { busy = false } = {}) {
  $('speakStatus').textContent = text;
  app.classList.toggle('busy', busy);
}

function clearWord() {
  CSS.highlights?.delete('speak-word');
}

function isVisible(node) {
  const box = textBox.getBoundingClientRect();
  const rect = node.getBoundingClientRect();
  return rect.top >= box.top && rect.bottom <= box.bottom;
}

// ── Текст ─────────────────────────────────────────────────────────────

/** Абзацы с предложениями-спанами: по ним щёлкают и в них подсвечивается слово. */
function render() {
  textBox.replaceChildren();
  spans = [];
  current = null;
  const sentences = sentencesOf(paragraphs, language);
  const byParagraph = paragraphs.map(() => []);
  for (const [index, sentence] of sentences.entries()) byParagraph[sentence.paragraph].push({ ...sentence, index });
  paragraphs.forEach((paragraph, i) => {
    const p = document.createElement('p');
    let cursor = 0;
    for (const sentence of byParagraph[i]) {
      if (sentence.start > cursor) p.append(paragraph.slice(cursor, sentence.start));
      const span = document.createElement('span');
      span.className = 'speak-sentence';
      span.dataset.index = String(sentence.index);
      span.textContent = sentence.text;
      spans[sentence.index] = span;
      p.append(span);
      cursor = sentence.end;
    }
    if (cursor < paragraph.length) p.append(paragraph.slice(cursor));
    textBox.append(p);
  });
  reader.load(sentences.map((sentence) => sentence.text));
}

function showText({ text, title, url }) {
  paragraphs = paragraphsFromSelection(text);
  language = detectLanguage(paragraphs.join(' '));
  $('speakTitle').textContent = title || 'Озвучка текста';
  document.title = title ? `Озвучка — ${title}` : 'Озвучка текста';
  const source = $('speakSource');
  let host = '';
  try {
    host = url ? new URL(url).host : '';
  } catch {
    /* адрес без хоста */
  }
  source.hidden = !host;
  if (host) {
    source.href = url;
    source.textContent = host;
  }
  render();
}

async function loadEntry() {
  const params = new URLSearchParams(location.search);
  if (params.has('text')) return { text: params.get('text'), title: params.get('title') || '' };
  const id = location.hash.slice(1);
  const session = globalThis.browser?.storage?.session;
  if (!id || !session) return null;
  const key = `speak:${id}`;
  return (await session.get(key))[key] ?? null;
}

/** Начать читать сразу. Если браузер не дал звуку начаться без нажатия — попросить нажать. */
function autostart() {
  if (!spans.length) return;
  reader.start(0);
  setTimeout(() => {
    if (!reader.audioBlocked) return;
    reader.stop();
    setStatus('Нажмите ▶ или пробел — браузер ждёт нажатия, чтобы включить звук');
    $('speakPlay').focus();
  }, 1500);
}

async function openEntry() {
  const entry = await loadEntry();
  if (!entry?.text?.trim()) {
    setStatus('Текст не передан — выделите его на странице и выберите «Озвучить выделенное»');
    return;
  }
  showText(entry);
  autostart();
}

// ── Чтение: выделенный кусок или с выбранного предложения ─────────────

/** Предложения, задетые выделением в окне: [первое, последнее] или null. */
function selectedRange() {
  const selection = window.getSelection();
  if (!selection || selection.isCollapsed) return null;
  const touched = spans.filter((span) => selection.containsNode(span, true)).map((span) => Number(span.dataset.index));
  if (!touched.length) return null;
  selection.removeAllRanges();
  return [Math.min(...touched), Math.max(...touched)];
}

function play() {
  const range = selectedRange();
  if (range) reader.start(range[0], range[1]);
  else reader.toggle();
}

on(textBox, 'click', (event) => {
  const span = event.target.closest?.('.speak-sentence');
  if (!span || window.getSelection()?.toString()) return;
  reader.start(Number(span.dataset.index));
});
on($('speakPlay'), 'click', play);
on($('speakStop'), 'click', () => reader.stop());
on($('speakNext'), 'click', () => reader.next());
on($('speakPrev'), 'click', () => reader.previous());

on(document, 'keydown', (event) => {
  if (event.ctrlKey || event.metaKey || event.altKey || isTypingTarget(event.target) || !$('speakEditor').hidden) return;
  const actions = {
    Space: play,
    KeyS: play,
    Escape: () => reader.stop(),
    ArrowRight: () => reader.next(),
    ArrowLeft: () => reader.previous(),
  };
  const action = actions[event.code];
  if (!action) return;
  event.preventDefault();
  action();
});

// ── Правка текста: убрать мусор или вставить свой ─────────────────────

on($('speakEdit'), 'click', () => {
  reader.stop();
  $('speakEditorText').value = paragraphs.join('\n\n');
  textBox.hidden = true;
  $('speakEditor').hidden = false;
  $('speakEditorText').focus();
});
function closeEditor() {
  $('speakEditor').hidden = true;
  textBox.hidden = false;
}
on($('speakEditCancel'), 'click', closeEditor);
on($('speakEditDone'), 'click', () => {
  paragraphs = paragraphsFromSelection($('speakEditorText').value);
  closeEditor();
  render();
  setStatus(spans.length ? 'Текст обновлён — нажмите ▶' : 'Текста нет');
});

// ── Голос, скорость, громкость, запас ─────────────────────────────────

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
});
on($('ttsRate'), 'change', () => reader.rateChanged());
on($('ttsVolume'), 'input', async () => {
  const volume = Number($('ttsVolume').value);
  await updateSettings({ ttsVolume: volume });
  syncControls();
  if (reader.state !== 'idle' && !reader.setVolume(volume)) setStatus(`Громкость ${Math.round(volume * 100)} % — со следующей фразы`);
});

/** Запас подготовленной речи — как подгрузка видео; на паузе — и в статусе. */
function showBuffer() {
  const badge = $('speakBuffer');
  const visible = reader.state !== 'idle' && reader.provider.neural && Boolean(reader.provider.prepare);
  badge.hidden = !visible;
  if (!visible) return;
  const seconds = reader.bufferedSeconds();
  badge.textContent = `запас ${formatClock(seconds)}`;
  if (reader.state === 'paused') setStatus(`Пауза · вперёд готово ≈ ${formatSpoken(seconds)}`);
}

async function main() {
  await loadSettings();
  app.dataset.uiTheme = getSetting('uiTheme');
  hydrateIcons();
  wireSteppers();
  syncControls();
  setInterval(showBuffer, 1000);
  await fillVoices();
  await openEntry();
  on(window, 'hashchange', openEntry);
  // Для проверок.
  window.speakPage = { reader, engines };
}

main();
