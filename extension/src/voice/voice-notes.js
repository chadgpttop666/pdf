// Голосовые заметки к выделениям: запись, прослушивание и расшифровка.
//
// Запись лежит в библиотеке (IndexedDB, хранилище recordings), у выделения —
// только её описание: voice = { id, seconds, transcribed, empty } (empty —
// расшифровали, а слов не нашлось: тишина или шум). Расшифровка
// дописывается в обычную заметку выделения — её можно поправить руками, она
// попадает в поиск по заметкам и в конспект.

import * as library from '../library.js';
import { describeMicError, formatSeconds, startRecording } from './recorder.js';
import { WHISPER_MODEL, describeReason, installModel, transcribe, transcriberStatus } from './whisper.js';

/**
 * @param app контекст читалки (hud, readingState, tts)
 * @param highlights { find(id), update(id, patch) } — доступ к выделениям
 */
export function createVoiceNotes(app, highlights) {
  let recording = null; // { highlightId, session }
  let playing = null; // { id, audio, url }
  const busy = new Set(); // id записей, которые сейчас расшифровываются
  const listeners = new Set();
  const changed = () => {
    for (const listener of listeners) listener();
  };

  // ── Запись ───────────────────────────────────────────────────────────

  async function start(highlightId, { onLimit } = {}) {
    if (recording) return false;
    stopPlaying();
    // Озвучка на паузу: иначе микрофон запишет и её.
    if (app.tts?.isSpeaking) app.tts.pause();
    try {
      recording = { highlightId, session: null };
      recording.session = await startRecording({ onLimit });
    } catch (error) {
      recording = null;
      app.hud.show(describeMicError(error), { duration: 7000 });
      return false;
    }
    changed();
    return true;
  }

  /** Закончить запись и сохранить её. */
  async function finish() {
    const current = recording;
    if (!current?.session) return null;
    recording = null;
    changed();
    let result;
    try {
      result = await current.session.stop();
    } catch (error) {
      app.hud.show(`Запись не сохранилась: ${error.message}`, { duration: 5000 });
      return null;
    }
    if (result.seconds < 0.6 || !result.blob.size) {
      app.hud.show('Запись слишком короткая — не сохранил');
      return null;
    }
    return save(current.highlightId, result);
  }

  function cancel() {
    const current = recording;
    if (!current?.session) return;
    recording = null;
    current.session.cancel();
    changed();
  }

  async function save(highlightId, { blob, seconds }) {
    const item = highlights.find(highlightId);
    if (!item) return null;
    const id = `${highlightId}-${Date.now().toString(36)}`;
    await library.putRecording({ id, docId: app.readingState.documentId, highlightId, blob, seconds, createdAt: Date.now() });
    // Новая запись заменяет прежнюю; текст прежней остаётся в заметке.
    if (item.voice?.id) await library.deleteRecording(item.voice.id).catch(() => {});
    const voice = { id, seconds: Math.round(seconds * 10) / 10, transcribed: false, empty: false };
    await highlights.update(highlightId, { voice });
    toText(highlightId, { quiet: false });
    return voice;
  }

  // ── Расшифровка ──────────────────────────────────────────────────────

  function askForModel() {
    return window.confirm(
      `Скачать модель распознавания речи Whisper (${WHISPER_MODEL.label}) с HuggingFace?\n\n` +
        'Это нужно один раз: модель сохранится в ускорителе, и дальше голосовые заметки будут превращаться в текст ' +
        'прямо на этом компьютере, без интернета. Записи никуда не отправляются.'
    );
  }

  /** Превратить запись выделения в текст заметки. */
  async function toText(highlightId, { quiet = false } = {}) {
    const item = highlights.find(highlightId);
    const voice = item?.voice;
    if (!voice || busy.has(voice.id)) return;
    busy.add(voice.id);
    changed();
    const progress = (text) => app.hud.show(text, { duration: 120000 });
    let client = null;
    try {
      const record = await library.getRecording(voice.id);
      if (!record) throw new Error('запись не найдена');
      progress('Готовлю расшифровку…');
      const status = await transcriberStatus();
      client = status.connection?.client ?? null;
      if (!status.ready && status.reason === 'no-model') {
        if (quiet || !askForModel()) {
          app.hud.show(describeReason('no-model'), { duration: 6000 });
          return;
        }
        await installModel(client, (loaded, total) => progress(`Скачиваю модель распознавания: ${Math.round((loaded / total) * 100)} %`));
      } else if (!status.ready) {
        if (!quiet) app.hud.show(describeReason(status.reason), { duration: 9000 });
        return;
      }
      progress('Расшифровываю заметку…');
      const text = await transcribe(client, record.blob);
      const current = highlights.find(highlightId);
      if (current?.voice?.id !== voice.id) return; // запись удалили или переписали
      const note = [current.note, text].filter(Boolean).join('\n');
      await highlights.update(highlightId, { note, voice: { ...current.voice, transcribed: true, empty: !text } });
      app.hud.show(text ? 'Заметка расшифрована' : 'Слов в записи не разобрал', { duration: 3000 });
    } catch (error) {
      console.warn('Голосовая заметка не расшифровалась', error);
      app.hud.show(`Запись сохранена, а текст не получился: ${error.message}`, { duration: 7000 });
    } finally {
      client?.close();
      busy.delete(voice.id);
      changed();
    }
  }

  // ── Прослушивание ────────────────────────────────────────────────────

  function stopPlaying() {
    if (!playing) return;
    playing.audio.pause();
    URL.revokeObjectURL(playing.url);
    playing = null;
    changed();
  }

  async function play(highlightId) {
    const voice = highlights.find(highlightId)?.voice;
    if (!voice) return;
    if (playing?.id === voice.id) {
      stopPlaying();
      return;
    }
    stopPlaying();
    const record = await library.getRecording(voice.id);
    if (!record) {
      app.hud.show('Запись не найдена');
      return;
    }
    if (app.tts?.isSpeaking) app.tts.pause();
    const url = URL.createObjectURL(record.blob);
    const audio = new Audio(url);
    playing = { id: voice.id, audio, url };
    audio.onended = stopPlaying;
    changed();
    try {
      await audio.play();
    } catch (error) {
      stopPlaying();
      app.hud.show(`Не проигрывается: ${error.message}`);
    }
  }

  /** Убрать запись; текст в заметке остаётся. */
  async function removeVoice(highlightId) {
    const voice = highlights.find(highlightId)?.voice;
    if (!voice) return;
    if (playing?.id === voice.id) stopPlaying();
    await library.deleteRecording(voice.id).catch(() => {});
    await highlights.update(highlightId, { voice: null });
  }

  /** Выделение удалили — запись больше не нужна. */
  function forget(item) {
    if (!item?.voice?.id) return;
    if (playing?.id === item.voice.id) stopPlaying();
    library.deleteRecording(item.voice.id).catch(() => {});
  }

  return {
    start,
    finish,
    cancel,
    /** Прикрепить готовую запись ({ blob, seconds }) — как будто её только что записали. */
    attach: save,
    toText,
    play,
    stopPlaying,
    removeVoice,
    forget,
    /** Что идёт запись — и для какого выделения. */
    get recording() {
      return recording && { highlightId: recording.highlightId, session: recording.session };
    },
    isPlaying: (voice) => Boolean(voice && playing?.id === voice.id),
    isBusy: (voice) => Boolean(voice && busy.has(voice.id)),
    /** Подпись: «0:12 · текст в заметке» */
    describe(voice) {
      if (!voice) return '';
      const state = busy.has(voice.id)
        ? 'расшифровываю…'
        : !voice.transcribed
          ? 'без текста'
          : voice.empty
            ? 'слов не разобрал'
            : 'текст в заметке';
      return `${formatSeconds(voice.seconds)} · ${state}`;
    },
    onChange(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
