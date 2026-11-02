// Окно «Аудиокнига»: что сохранить (эта глава, страницы, вся книга),
// прогресс и отмена. Синтез и кодирование — в tts/audiobook.js.

import { $, closeOnBackdropClick, on, saveBlob } from '../dom.js';
import { bookFileName } from '../notes-export.js';
import { renderAudiobook } from '../tts/audiobook.js';
import { chapterTime } from '../tts/ogg-opus.js';

/** «1 ч 05 мин», «12 мин», «40 с». */
export function formatDuration(seconds) {
  const total = Math.max(0, Math.round(seconds));
  if (total < 60) return `${total} с`;
  const minutes = Math.floor(total / 60) % 60;
  const hours = Math.floor(total / 3600);
  return hours ? `${hours} ч ${String(minutes).padStart(2, '0')} мин` : `${minutes} мин`;
}

export function createAudiobookDialog(app) {
  const dialog = $('audiobookDialog');
  closeOnBackdropClick(dialog);
  const fromInput = $('abFrom');
  const toInput = $('abTo');
  const startButton = $('abStart');
  const cancelButton = $('abCancel');
  const progressBox = $('abProgress');
  const bar = $('abBar');
  const status = $('abStatus');
  let running = null; // { controller, label }

  const numPages = () => app.pdfViewer.pagesCount || 0;
  const currentPage = () => app.pdfViewer.currentPageNumber || 1;
  const chosen = () => dialog.querySelector('input[name="abRange"]:checked')?.value ?? 'chapter';

  function chapter() {
    return app.outline?.chapterRange?.(currentPage(), numPages()) ?? { start: 1, end: numPages(), title: null };
  }

  /** Страницы и подпись для имени файла. */
  function range() {
    const kind = chosen();
    if (kind === 'book') return { from: 1, to: numPages(), label: 'аудиокнига', title: null };
    if (kind === 'pages') {
      const from = Math.min(Math.max(1, Number(fromInput.value) || 1), numPages());
      const to = Math.min(Math.max(from, Number(toInput.value) || from), numPages());
      return { from, to, label: from === to ? `с. ${from}` : `с. ${from}–${to}`, title: null };
    }
    const { start, end, title } = chapter();
    return { from: start, to: end, label: title ? `${title}` : `с. ${start}–${end}`, title };
  }

  function renderVoice() {
    const voice = app.tts.neuralVoice();
    $('abVoice').textContent = voice
      ? `Голос — ${voice.name}. Синтез идёт так же, как при чтении вслух, только в файл: на это нужно время, вкладку не закрывайте.`
      : 'Аудиокнигу записывает нейроголос — TeraTTS или Piper. Выберите его на панели озвучки: голоса системы в файл не записать.';
    startButton.disabled = !voice || Boolean(running);
  }

  function open() {
    if (!app.tts?.textIndex) return;
    const { start, end, title } = chapter();
    $('abChapter').textContent = title ? `«${title}», с. ${start}–${end}` : `с. ${start}–${end}`;
    $('abBook').textContent = `${numPages()} с.`;
    if (!running) {
      fromInput.value = String(currentPage());
      toInput.value = String(Math.min(numPages(), currentPage() + 9));
      fromInput.max = toInput.max = String(numPages());
    }
    renderVoice();
    if (!dialog.open) dialog.showModal();
  }

  function setRunning(active) {
    cancelButton.hidden = !active;
    progressBox.hidden = !active && !status.textContent;
    for (const input of dialog.querySelectorAll('fieldset input')) input.disabled = active;
    renderVoice();
  }

  async function start() {
    const voice = app.tts.neuralVoice();
    if (!voice || running) return;
    const { from, to, label, title } = range();
    const controller = new AbortController();
    running = { controller, label };
    if (app.tts.isSpeaking) app.tts.pause(); // одни и те же воркеры синтеза
    voice.engine.preload?.();
    const record = app.readingState.record ?? {};
    const pages = to - from + 1;
    const began = Date.now();
    bar.value = 0;
    status.textContent = 'Готовлю голос…';
    setRunning(true);
    try {
      const result = await renderAudiobook({
        render: (text) => voice.engine.render(text, { voiceId: voice.voiceId }),
        utterances: app.tts.utterancesOf(from, to),
        signal: controller.signal,
        meta: { title: title || record.title || record.name, album: record.title || record.name },
        onProgress({ pageNumber, seconds }) {
          const done = Math.min(1, (pageNumber - from + 0.5) / pages);
          bar.value = done;
          const elapsed = (Date.now() - began) / 1000;
          const left = done > 0.02 ? (elapsed / done) * (1 - done) : null;
          status.textContent = `Стр. ${pageNumber} из ${from}–${to} · готово ${chapterTime(seconds).replace(/\.\d+$/, '')} звука${left != null ? ` · осталось ≈${formatDuration(left)}` : ''}`;
          if (!dialog.open) app.hud.show(`Аудиокнига: ${Math.round(done * 100)} %`, { duration: 2500 });
        },
      });
      const filename = `${bookFileName(record)} — ${label}.${result.extension}`.replace(/[\\/:*?"<>|]/g, '_');
      saveBlob(result.blob, filename);
      bar.value = 1;
      const megabytes = (result.blob.size / 1048576).toFixed(1).replace('.', ',');
      status.textContent =
        `Сохраняю «${filename}» — ${formatDuration(result.seconds)} звука, ${megabytes} МБ` +
        (result.format === 'wav' ? ' (WAV: кодировщика Opus в браузере нет)' : '') +
        (result.failed ? `. Не синтезировались фраз: ${result.failed}` : '');
      app.hud.show(`Аудиокнига готова: «${filename}»`, { duration: 5000 });
    } catch (error) {
      status.textContent = error.name === 'AbortError' ? 'Отменено' : `Не получилось: ${error.message}`;
      if (error.name !== 'AbortError') console.warn('Аудиокнига не записалась', error);
    } finally {
      running = null;
      setRunning(false);
    }
  }

  on(startButton, 'click', () => start());
  on(cancelButton, 'click', () => running?.controller.abort());
  // Номер страницы вписали — значит, и выбрали «страницы».
  for (const input of [fromInput, toInput]) {
    on(input, 'focus', () => {
      dialog.querySelector('input[name="abRange"][value="pages"]').checked = true;
    });
  }
  on($('ttsExport'), 'click', open);
  app.eventBus.on('documentopened', () => running?.controller.abort());

  return {
    open,
    start,
    get running() {
      return Boolean(running);
    },
  };
}
