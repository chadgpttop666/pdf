// Расшифровка голосовых заметок: Whisper (whisper.cpp) в ускорителе. В
// браузере он был бы в разы медленнее и съел бы ещё гигабайт памяти, поэтому
// без ускорителя заметка остаётся записью, без текста.
//
// Модель распознавания (small, сжатая до 190 МБ) и детектор речи к ней
// (Silero VAD, меньше мегабайта: без него Whisper сочиняет фразы на тишине и
// шуме) скачиваются один раз, с согласия человека, сразу в ускоритель — в
// браузере они не хранятся. Помощник сверяет SHA-256 и только тогда кладёт
// файл на место.

import { updateIfOld } from '../tts/helper-install.js';
import { compareVersions, connectHelper } from '../tts/tera-native.js';

export const WHISPER_MODEL = {
  name: 'whisper',
  url: 'https://huggingface.co/ggerganov/whisper.cpp/resolve/5359861c739e955e79d9a303bcbc70fb988958b1/ggml-small-q5_1.bin',
  size: 190085487,
  sha256: 'ae85e4a935d7a567bd102fe55afc16bb595bdb618e11b2fc7591bc08120411bb',
  label: '190 МБ',
};
export const VAD_MODEL = {
  name: 'vad',
  url: 'https://huggingface.co/ggml-org/whisper-vad/resolve/9ffd54a1e1ee413ddf265af9913beaf518d1639b/ggml-silero-v5.1.2.bin',
  size: 885098,
  sha256: '29940d98d42b91fbd05ce489f3ecf7c72f0a42f027e4875919a28fb4c04ea2cf',
};
/** Всё, что нужно ускорителю для расшифровки. */
export const SPEECH_MODELS = [WHISPER_MODEL, VAD_MODEL];

/** Каких файлов расшифровки у помощника нет — по размерам из hello. */
export const missingSpeechModels = (files) => SPEECH_MODELS.filter((model) => files?.[model.name] !== model.size);
/** Первая версия ускорителя, которая умеет расшифровывать. */
export const TRANSCRIBE_SINCE = '1.2.0';
export const SAMPLE_RATE = 16000;

/**
 * Простая передискретизация: усреднение по окну и линейная интерполяция.
 * Для распознавания речи этого хватает (в браузере звук переводит сам
 * OfflineAudioContext, это — для проверок вне браузера).
 */
export function resample(samples, fromRate, toRate = SAMPLE_RATE) {
  if (fromRate === toRate) return Float32Array.from(samples);
  const ratio = fromRate / toRate;
  const out = new Float32Array(Math.floor(samples.length / ratio));
  const half = Math.max(0, Math.floor(ratio / 2));
  for (let i = 0; i < out.length; i += 1) {
    const center = i * ratio;
    const from = Math.max(0, Math.floor(center) - half);
    const to = Math.min(samples.length - 1, Math.floor(center) + half);
    let sum = 0;
    for (let j = from; j <= to; j += 1) sum += samples[j];
    out[i] = sum / (to - from + 1);
  }
  return out;
}

/** Запись (webm/ogg) → 16 кГц моно: так её ждёт Whisper. */
export async function decodeTo16k(blob) {
  const bytes = await blob.arrayBuffer();
  // Длину заранее не знаем — декодируем в обычном контексте, потом переводим.
  const probe = new OfflineAudioContext(1, 1, SAMPLE_RATE);
  const decoded = await probe.decodeAudioData(bytes);
  const length = Math.ceil(decoded.duration * SAMPLE_RATE);
  const context = new OfflineAudioContext(1, Math.max(1, length), SAMPLE_RATE);
  const source = context.createBufferSource();
  source.buffer = decoded;
  source.connect(context.destination);
  source.start();
  const rendered = await context.startRendering();
  return rendered.getChannelData(0);
}

/**
 * Что с расшифровкой сейчас:
 *   { ready: true, connection } — можно расшифровывать (connection закрыть после);
 *   { ready: false, reason: 'no-helper' | 'old-helper' | 'cpu' | 'no-model', connection? }
 */
export async function transcriberStatus() {
  let connection = await connectHelper({ timeout: 15000 });
  if (!connection) return { ready: false, reason: 'no-helper' };
  // Старый ускоритель расшифровывать не умеет — ставим новый (сам, без вопросов).
  connection = await updateIfOld(connection).catch(() => connection);
  const { hello } = connection;
  const close = () => connection.client.close();
  if (compareVersions(hello.version, TRANSCRIBE_SINCE) < 0) {
    close();
    return { ready: false, reason: 'old-helper', version: hello.version };
  }
  if (!hello.features?.includes('transcribe')) {
    close();
    return { ready: false, reason: 'cpu' };
  }
  if (missingSpeechModels(hello.files).length) return { ready: false, reason: 'no-model', connection };
  return { ready: true, connection };
}

/** Скачать недостающие модели расшифровки прямо в ускоритель. */
export async function installModel(client, onProgress) {
  const missing = missingSpeechModels((await client.hello()).files);
  const total = missing.reduce((sum, model) => sum + model.size, 0);
  let done = 0;
  for (const model of missing) {
    const response = await fetch(model.url);
    if (!response.ok || !response.body) throw new Error(`Модель не скачалась: ${response.status}`);
    await client.streamFile(model.name, response.body, model, (loaded) => onProgress?.(done + loaded, total));
    done += model.size;
  }
}

/** Текст записи. @returns {Promise<string>} */
export async function transcribe(client, blob) {
  const samples = await decodeTo16k(blob);
  const { text } = await client.transcribe(samples, 'ru');
  return text;
}

/** Почему расшифровки нет — для подсказки. */
export function describeReason(reason) {
  switch (reason) {
    case 'no-helper':
      return 'Запись сохранена. Чтобы она сама превращалась в текст, поставьте ускоритель: Настройки → Озвучка → Ускоритель TeraTTS.';
    case 'old-helper':
      return 'Запись сохранена. Расшифровку умеет ускоритель новее, а обновить его не вышло — проверьте связь и попробуйте ещё раз.';
    case 'cpu':
      return 'Запись сохранена. Расшифровка на этом процессоре недоступна (нужен AVX2).';
    case 'no-model':
      return 'Запись сохранена. Для расшифровки нужна модель распознавания речи.';
    default:
      return 'Запись сохранена.';
  }
}
