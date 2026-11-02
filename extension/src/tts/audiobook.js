// Аудиокнига: глава, страницы или вся книга — в звуковой файл. Синтез тот
// же, что при чтении вслух (нейроголос TeraTTS или Piper, с ударениями,
// примечаниями и склейкой переносов), только фразы не звучат, а
// складываются в файл.
//
// Формат — Opus в Ogg: кодирует браузер (WebCodecs), страницы Ogg
// собирает ogg-opus.js. Час речи — ≈14 МБ. Где кодировщика Opus нет, —
// WAV (16 бит): ≈170 МБ в час, поэтому для целой книги он не годится.

import { bookTags, createOggWriter, opusHead } from './ogg-opus.js';

const OPUS_BITRATE = 32000;
const OPUS_RATES = [8000, 12000, 16000, 24000, 48000];
// Столько кадров в очереди кодировщика — дальше ждём: память не растёт.
const MAX_ENCODE_QUEUE = 32;
// libopus заглядывает вперёд на 6,5 мс: столько отсчётов в начале — не звук.
const DEFAULT_PRE_SKIP = 312;

/** Пересчитать звук на другую частоту — средствами браузера (OfflineAudioContext). */
export async function resample(pcm, fromRate, toRate) {
  if (fromRate === toRate || !pcm.length) return pcm;
  const frames = Math.max(1, Math.round((pcm.length * toRate) / fromRate));
  const context = new OfflineAudioContext(1, frames, toRate);
  const buffer = context.createBuffer(1, pcm.length, fromRate);
  buffer.copyToChannel(pcm, 0);
  const source = context.createBufferSource();
  source.buffer = buffer;
  source.connect(context.destination);
  source.start();
  const rendered = await context.startRendering();
  return rendered.getChannelData(0).slice();
}

/** WAV, 16 бит, моно. */
export function wavBlob(chunks, sampleRate) {
  const frames = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const header = new DataView(new ArrayBuffer(44));
  const text = (at, value) => [...value].forEach((char, i) => header.setUint8(at + i, char.charCodeAt(0)));
  text(0, 'RIFF');
  header.setUint32(4, 36 + frames * 2, true);
  text(8, 'WAVE');
  text(12, 'fmt ');
  header.setUint32(16, 16, true);
  header.setUint16(20, 1, true); // PCM
  header.setUint16(22, 1, true); // моно
  header.setUint32(24, sampleRate, true);
  header.setUint32(28, sampleRate * 2, true);
  header.setUint16(32, 2, true);
  header.setUint16(34, 16, true);
  text(36, 'data');
  header.setUint32(40, frames * 2, true);
  const parts = chunks.map((chunk) => {
    const out = new Int16Array(chunk.length);
    for (let i = 0; i < chunk.length; i += 1) out[i] = Math.max(-1, Math.min(1, chunk[i])) * 0x7fff;
    return out;
  });
  return new Blob([header, ...parts], { type: 'audio/wav' });
}

function createWavEncoder(sampleRate) {
  const chunks = [];
  return {
    format: 'wav',
    extension: 'wav',
    async add(pcm) {
      chunks.push(pcm);
    },
    async finish() {
      return wavBlob(chunks, sampleRate);
    },
    close() {},
  };
}

/** Pre-skip из OpusHead, который кодировщик отдаёт в описании (если отдаёт). */
function preSkipOf(description) {
  if (!description) return null;
  const bytes = description instanceof ArrayBuffer ? new Uint8Array(description) : new Uint8Array(description.buffer, description.byteOffset, description.byteLength);
  if (bytes.length < 19 || new TextDecoder().decode(bytes.subarray(0, 8)) !== 'OpusHead') return null;
  return bytes[10] | (bytes[11] << 8);
}

async function createOpusEncoder(config, sourceRate) {
  const writer = createOggWriter();
  let failure = null;
  let preSkip = DEFAULT_PRE_SKIP;
  let timestamp = 0; // мкс
  let frames = 0; // отсчётов на частоте кодировщика
  const encoder = new AudioEncoder({
    output(chunk, metadata) {
      const skip = preSkipOf(metadata?.decoderConfig?.description);
      if (skip != null) preSkip = skip;
      const packet = new Uint8Array(chunk.byteLength);
      chunk.copyTo(packet);
      // Длительность пакета — в отсчётах 48 кГц: так считает Ogg Opus.
      writer.addPacket(packet, Math.round(((chunk.duration ?? 20000) * 48) / 1000));
    },
    error(error) {
      failure = error;
    },
  });
  encoder.configure(config);

  const waitForQueue = () =>
    new Promise((resolve) => {
      if (encoder.encodeQueueSize <= MAX_ENCODE_QUEUE) return resolve();
      encoder.addEventListener('dequeue', function check() {
        if (encoder.encodeQueueSize > MAX_ENCODE_QUEUE) return;
        encoder.removeEventListener('dequeue', check);
        resolve();
      });
    });

  return {
    format: 'opus',
    extension: 'ogg',
    async add(pcm) {
      if (failure) throw failure;
      const data = config.sampleRate === sourceRate ? pcm : await resample(pcm, sourceRate, config.sampleRate);
      if (!data.length) return;
      const audio = new AudioData({
        format: 'f32',
        sampleRate: config.sampleRate,
        numberOfFrames: data.length,
        numberOfChannels: 1,
        timestamp,
        data,
      });
      timestamp += Math.round((data.length * 1e6) / config.sampleRate);
      frames += data.length;
      encoder.encode(audio);
      audio.close();
      await waitForQueue();
    },
    async finish(meta = {}) {
      await encoder.flush();
      if (failure) throw failure;
      encoder.close();
      // Конец потока — ровно по последнему отсчёту речи, без добивки кадра.
      const total48 = preSkip + Math.round((frames * 48000) / config.sampleRate);
      return writer.finish({
        head: opusHead({ channels: 1, preSkip, inputSampleRate: sourceRate }),
        tags: bookTags(meta),
        endTrim: Math.max(0, writer.granule - total48),
      });
    },
    close() {
      if (encoder.state !== 'closed') encoder.close();
    },
  };
}

/**
 * Кодировщик для звука с частотой sampleRate: Opus, если браузер умеет, —
 * иначе WAV.
 */
export async function createAudioEncoder(sampleRate, { preferWav = false } = {}) {
  if (!preferWav && globalThis.AudioEncoder) {
    const rates = OPUS_RATES.includes(sampleRate) ? [sampleRate, 48000] : [48000];
    for (const rate of rates) {
      const config = { codec: 'opus', sampleRate: rate, numberOfChannels: 1, bitrate: OPUS_BITRATE };
      const support = await AudioEncoder.isConfigSupported(config).catch(() => null);
      if (support?.supported) {
        try {
          return await createOpusEncoder(config, sampleRate);
        } catch (error) {
          console.warn('Кодировщик Opus не запустился — сохраню в WAV', error);
        }
      }
    }
  }
  return createWavEncoder(sampleRate);
}

/**
 * Синтезировать фразы в файл.
 * @param render async (text) => { pcm, sampleRate } — синтез одной фразы
 * @param utterances асинхронный перечень { text, pageNumber, chapter }
 * @param onProgress ({ pageNumber, seconds, sentences, failed }) — после каждой фразы
 * @param signal AbortSignal — «Отмена»
 * @returns {Promise<{ blob, extension, seconds, sentences, failed }>}
 */
export async function renderAudiobook({ render, utterances, onProgress, signal, meta = {}, preferWav = false }) {
  let encoder = null;
  let seconds = 0;
  let sentences = 0;
  let failed = 0;
  const chapters = [];
  try {
    for await (const item of utterances) {
      if (signal?.aborted) throw new DOMException('Отменено', 'AbortError');
      let audio = null;
      // Фраза, которую синтез уронил (например, её отменило чтение вслух),
      // — ещё раз; вторая неудача — пропускаем, книга важнее одной фразы.
      for (let attempt = 0; attempt < 2 && !audio; attempt += 1) {
        audio = await render(item.text).catch((error) => {
          console.warn('Фраза аудиокниги не синтезировалась', item.text, error);
          return null;
        });
        if (signal?.aborted) throw new DOMException('Отменено', 'AbortError');
      }
      if (!audio?.pcm?.length) {
        failed += 1;
        continue;
      }
      encoder ??= await createAudioEncoder(audio.sampleRate, { preferWav });
      if (item.chapter && item.chapter !== chapters.at(-1)?.title) chapters.push({ title: item.chapter, start: seconds });
      await encoder.add(audio.pcm);
      seconds += audio.pcm.length / audio.sampleRate;
      sentences += 1;
      onProgress?.({ pageNumber: item.pageNumber, seconds, sentences, failed });
    }
    if (!encoder) throw new Error(failed ? 'ни одна фраза не синтезировалась' : 'в выбранных страницах нет текста');
    const blob = await encoder.finish({ ...meta, chapters });
    return { blob, extension: encoder.extension, format: encoder.format, seconds, sentences, failed, chapters };
  } catch (error) {
    encoder?.close();
    throw error;
  }
}
