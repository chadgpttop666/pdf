// Проверка ускорителя озвучки (native/) без браузера: говорит с ним тем же
// клиентом, что и расширение (tera-native.js), — передаёт модели, синтезирует
// фразы, мерит скорость; с --compare сверяет звук с синтезом в WebAssembly
// (onnxruntime-web — тем же, что в расширении).
//
//   node scripts/helper-check.mjs --helper native/target/release/pdf-reader-tts \
//     --models <папка> [--download] [--hoist] [--compare] [--wav out.wav]
//
// Папка моделей — как в репозитории TeraTTSv2 на HuggingFace (models/,
// styles/, unicode_indexer.json); --download скачает недостающее.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { quantizeModel } from '../extension/src/tts/onnx-quantize.js';
import { PACK_URLS } from '../extension/src/tts/tera-pack.js';
import { createHelperClient, syncModels } from '../extension/src/tts/tera-native.js';
import { noise } from '../extension/src/tts/tera-noise.js';
import { encodeText, keepSupported, maxSecondsFor, modelText, parseNpy, voicedRange } from '../extension/src/tts/tera-text.js';

const { values: args } = parseArgs({
  options: {
    helper: { type: 'string' },
    models: { type: 'string' },
    download: { type: 'boolean', default: false },
    compare: { type: 'boolean', default: false },
    wav: { type: 'string' },
    voice: { type: 'string', default: 'ru_m5' },
    // Сэмплер не из папки моделей — например, с вынесенными весами (onnx-quantize.js, hoist).
    sampler: { type: 'string' },
    // Вынести веса сэмплера из цикла здесь же — как это делает расширение перед передачей.
    hoist: { type: 'boolean', default: false },
  },
});

const EXTENSION_ID = 'pdf-reader@chadgpttop666.github.io';
const FILES = {
  textEncoder: 'models/text_encoder.onnx',
  duration: 'models/duration_predictor.onnx',
  sampler: 'models/sampler_distilled_cfg3_8step.onnx',
  vocoder: 'models/vocoder.onnx',
};
// Текст уже с ударениями: ударения расставляет расширение, здесь проверяется синтез.
const TEXTS = [
  'Прив+ет! Это пр+оверка ускор+ителя озв+учки.',
  'С+егодня мы чит+аем кн+игу о т+ом, как раб+отает с+интез р+ечи, и сл+ушаем, как зв+учит г+олос.',
  'В тр+идцать вт+ором г+оду он п+еревёл дв+е т+ысячи стран+иц.',
];

function fail(message) {
  console.error(`✗ ${message}`);
  process.exit(1);
}

if (!args.helper || !args.models) fail('нужны --helper и --models');
const dir = path.resolve(args.models);
const local = (relative) => path.join(dir, relative);

async function download() {
  const wanted = [...Object.values(FILES), 'unicode_indexer.json', `styles/${args.voice}/style_ttl.npy`, `styles/${args.voice}/style_dp.npy`];
  for (const relative of wanted) {
    if (fs.existsSync(local(relative))) continue;
    const url = PACK_URLS.find((item) => item.endsWith(`/${relative}`));
    console.log(`скачиваю ${relative}`);
    const response = await fetch(url);
    if (!response.ok) fail(`${url}: ${response.status}`);
    fs.mkdirSync(path.dirname(local(relative)), { recursive: true });
    fs.writeFileSync(local(relative), Buffer.from(await response.arrayBuffer()));
  }
}

/** Порт как у runtime.connectNative, но поверх stdin/stdout процесса. */
function stdioPort(child) {
  const onMessage = [];
  const onDisconnect = [];
  let buffer = Buffer.alloc(0);
  const port = {
    error: null,
    onMessage: { addListener: (listener) => onMessage.push(listener) },
    onDisconnect: { addListener: (listener) => onDisconnect.push(listener) },
    postMessage(message) {
      const body = Buffer.from(JSON.stringify(message));
      const head = Buffer.alloc(4);
      head.writeUInt32LE(body.length);
      child.stdin.write(Buffer.concat([head, body]));
    },
    disconnect() {
      child.stdin.end();
    },
  };
  child.stdout.on('data', (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    while (buffer.length >= 4) {
      const length = buffer.readUInt32LE(0);
      if (length > 1024 * 1024) fail(`сообщение помощника больше 1 МБ: ${length}`);
      if (buffer.length < 4 + length) break;
      const message = JSON.parse(buffer.subarray(4, 4 + length).toString('utf8'));
      buffer = buffer.subarray(4 + length);
      for (const listener of onMessage) listener(message);
    }
  });
  child.on('exit', (code) => {
    port.error = code ? { message: `помощник завершился с кодом ${code}` } : null;
    for (const listener of onDisconnect) listener(port);
  });
  return port;
}

const style = () => {
  const read = (name) => {
    const bytes = fs.readFileSync(local(`styles/${args.voice}/${name}`));
    return parseNpy(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length)).data;
  };
  return { ttl: read('style_ttl.npy'), dp: read('style_dp.npy') };
};

/** Тот же синтез в WebAssembly — как в tera-worker.js. */
async function wasmSynth(table, { ttl, dp }) {
  const ort = await import('onnxruntime-web');
  ort.env.wasm.numThreads = 1;
  const options = { executionProviders: ['wasm'], graphOptimizationLevel: 'all' };
  const sessions = {};
  for (const [name, relative] of Object.entries(FILES)) sessions[name] = await ort.InferenceSession.create(fs.readFileSync(local(relative)), options);
  const tensor = (type, data, dims) => new ort.Tensor(type, data, dims);
  const ones = (count) => new Float32Array(count).fill(1);
  const first = (result) => Object.values(result)[0];
  return async (text) => {
    const { withStress, plain } = encodeText(modelText('ru', keepSupported(text, table)), table);
    const styleTtl = tensor('float32', ttl, [1, 50, 256]);
    const textMask = tensor('float32', ones(withStress.length), [1, 1, withStress.length]);
    const textEmb = first(await sessions.textEncoder.run({ text_ids: tensor('int64', withStress, [1, withStress.length]), style_ttl: styleTtl, text_mask: textMask }));
    const duration = first(
      await sessions.duration.run({
        text_ids: tensor('int64', plain, [1, plain.length]),
        style_dp: tensor('float32', dp, [1, 8, 16]),
        text_mask: tensor('float32', ones(plain.length), [1, 1, plain.length]),
      })
    );
    const limit = maxSecondsFor(text);
    const seconds = limit ? Math.min(duration.data[0] / 1.05, limit) : duration.data[0] / 1.05;
    const frames = Math.max(1, Math.ceil((seconds * 44100) / 3072));
    const latent = first(
      await sessions.sampler.run({
        initial_latent: tensor('float32', noise(144 * frames), [1, 144, frames]),
        text_emb: textEmb,
        style_ttl: styleTtl,
        latent_mask: tensor('float32', ones(frames), [1, 1, frames]),
        text_mask: textMask,
        guidance: tensor('float32', Float32Array.of(3), [1]),
      })
    );
    const wav = first(await sessions.vocoder.run({ latent: tensor('float32', latent.data, [1, 144, frames]) }));
    return wav.data.slice(0, Math.min(Math.round(seconds * 44100), wav.data.length));
  };
}

const rms = (pcm) => Math.sqrt(pcm.reduce((sum, v) => sum + v * v, 0) / Math.max(1, pcm.length));
const snr = (reference, test) => {
  const n = Math.min(reference.length, test.length);
  let signal = 0;
  let noise = 0;
  for (let i = 0; i < n; i += 1) {
    signal += reference[i] ** 2;
    noise += (reference[i] - test[i]) ** 2;
  }
  return 10 * Math.log10(signal / Math.max(noise, 1e-20));
};

function writeWav(file, pcm, sampleRate) {
  const data = Buffer.alloc(pcm.length * 2);
  pcm.forEach((v, i) => data.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(v * 32767))), i * 2));
  const head = Buffer.alloc(44);
  head.write('RIFF', 0);
  head.writeUInt32LE(36 + data.length, 4);
  head.write('WAVEfmt ', 8);
  head.writeUInt32LE(16, 16);
  head.writeUInt16LE(1, 20);
  head.writeUInt16LE(1, 22);
  head.writeUInt32LE(sampleRate, 24);
  head.writeUInt32LE(sampleRate * 2, 28);
  head.writeUInt16LE(2, 32);
  head.writeUInt16LE(16, 34);
  head.write('data', 36);
  head.writeUInt32LE(data.length, 40);
  fs.writeFileSync(file, Buffer.concat([head, data]));
}

if (args.download) await download();
const table = Int32Array.from(JSON.parse(fs.readFileSync(local('unicode_indexer.json'), 'utf8')));
const voice = style();

// Так помощника запускает Firefox: путь к манифесту и id расширения.
const child = spawn(path.resolve(args.helper), [path.join(dir, 'pdf_reader_tts.json'), EXTENSION_ID], { stdio: ['pipe', 'pipe', 'inherit'] });
const client = createHelperClient(stdioPort(child));
const hello = await client.hello();
console.log(`помощник ${hello.version}, протокол ${hello.protocol}, ядер ${hello.cores}`);
if (hello.ortError) fail(hello.ortError);

let started = performance.now();
const blobs = Object.fromEntries(await Promise.all(Object.entries(FILES).map(async ([name, relative]) => [name, await fs.openAsBlob(local(relative))])));
if (args.sampler) blobs.sampler = await fs.openAsBlob(path.resolve(args.sampler));
if (args.hoist) blobs.sampler = new Blob([quantizeModel(new Uint8Array(await blobs.sampler.arrayBuffer()), { hoist: true, dynamic: false }).model]);
const sent = await syncModels(client, hello.files, blobs);
console.log(sent.length ? `передал модели (${sent.join(', ')}) за ${((performance.now() - started) / 1000).toFixed(1)} с` : 'модели уже у помощника');

started = performance.now();
await client.load();
console.log(`модели загружены за ${((performance.now() - started) / 1000).toFixed(1)} с`);

const compare = args.compare ? await wasmSynth(table, voice) : null;
const all = [];
let totalSynth = 0;
let totalAudio = 0;
for (const text of TEXTS) {
  const { withStress, plain } = encodeText(modelText('ru', keepSupported(text, table)), table);
  started = performance.now();
  const { pcm, sampleRate } = await client.synth({ ids: withStress, plain, ...voice, maxSeconds: maxSecondsFor(text) });
  const elapsed = (performance.now() - started) / 1000;
  const [from, to] = voicedRange(pcm, sampleRate);
  const voiced = pcm.subarray(from, to);
  const seconds = pcm.length / sampleRate;
  totalSynth += elapsed;
  totalAudio += seconds;
  const chars = text.replaceAll('+', '').length;
  let line = `«${text.slice(0, 30)}…»: ${seconds.toFixed(2)} с звука за ${elapsed.toFixed(2)} с (RTF ${(elapsed / seconds).toFixed(2)}), громкость ${rms(voiced).toFixed(3)}`;
  if (rms(voiced) < 0.02) fail(`${line} — почти тишина`);
  if (seconds < chars * 0.03 || seconds > chars * 0.2) fail(`${line} — странная длительность`);
  if (compare) {
    started = performance.now();
    const reference = await compare(text);
    const wasmSeconds = (performance.now() - started) / 1000;
    const db = snr(reference, pcm);
    line += ` | WASM: ${wasmSeconds.toFixed(2)} с, совпадение ${db.toFixed(1)} дБ`;
    if (db < 25) fail(`${line} — звук отличается от браузерного`);
  }
  console.log(line);
  all.push(pcm, new Float32Array(Math.round(sampleRate * 0.3)));
}
console.log(`итого RTF ${(totalSynth / totalAudio).toFixed(2)}`);

if (args.wav) {
  const joined = new Float32Array(all.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of all) {
    joined.set(part, offset);
    offset += part.length;
  }
  writeWav(args.wav, joined, 44100);
  console.log(`записал ${args.wav}`);
}

client.close();
console.log('✓ ускоритель работает');
