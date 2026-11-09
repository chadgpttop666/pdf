// Проверка ускорителя озвучки (native/) без браузера: говорит с ним тем же
// клиентом, что и расширение (tera-native.js), — передаёт модели, синтезирует
// фразы, мерит скорость; с --compare сверяет звук с синтезом в WebAssembly
// (onnxruntime-web — тем же, что в расширении).
//
//   node scripts/helper-check.mjs --helper native/target/release/pdf-reader-tts \
//     --models <папка> [--download] [--hoist] [--compare] [--wav out.wav] [--transcribe]
//     [--voice ru_f1] [--text 'Н+о +это пошл+о на +убыль.']
//
// С --transcribe синтезированная фраза уходит обратно в помощник — на
// расшифровку Whisper (голосовые заметки): модель — <папка>/whisper/, с
// --download скачается.
//
// С --accent — сети ударений RUAccent (ruaccent/ в папке моделей): их
// ответы в помощнике сверяются с onnxruntime-web на одних и тех же фразах.
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
import { HELPER_ACCENT_MODELS, createRemoteOrt } from '../extension/src/tts/remote-ort.js';
import { createAccentModels } from '../extension/src/tts/ruaccent-models.js';
import { noise } from '../extension/src/tts/tera-noise.js';
import { encodeText, keepSupported, maxSecondsFor, modelText, parseNpy, voicedRange } from '../extension/src/tts/tera-text.js';
import { SPEECH_MODELS, WHISPER_MODEL, resample } from '../extension/src/voice/whisper.js';

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
    transcribe: { type: 'boolean', default: false },
    // Сети ударений RUAccent в помощнике — те же ответы, что в WebAssembly.
    accent: { type: 'boolean', default: false },
    // Свои фразы вместо проверочных — с ударениями через «+», как их размечает расширение.
    text: { type: 'string', multiple: true },
  },
});

const EXTENSION_ID = 'pdf-reader@chadgpttop666.github.io';
const FILES = {
  textEncoder: 'models/text_encoder.onnx',
  duration: 'models/duration_predictor.onnx',
  sampler: 'models/sampler_distilled_cfg3_8step.onnx',
  vocoder: 'models/vocoder.onnx',
};
/** Файлы RUAccent: где лежат в папке моделей и откуда скачать. */
const ACCENT_FILES = {
  yoModel: 'ruaccent/nn/nn_yo_homograph_resolver/model.onnx',
  yoTokenizer: 'ruaccent/nn/nn_yo_homograph_resolver/tokenizer.json',
  yoTokenizerConfig: 'ruaccent/nn/nn_yo_homograph_resolver/tokenizer_config.json',
  yoConfig: 'ruaccent/nn/nn_yo_homograph_resolver/config.json',
  accentModel: 'ruaccent/nn/nn_accent/model.onnx',
  accentVocab: 'ruaccent/nn/nn_accent/vocab.txt',
  accentConfig: 'ruaccent/nn/nn_accent/config.json',
  omographModel: 'omograph-int8/turbo3.1/model.onnx',
  omographTokenizer: 'omograph-int8/turbo3.1/tokenizer.json',
  omographTokenizerConfig: 'omograph-int8/turbo3.1/tokenizer_config.json',
};

// Текст уже с ударениями: ударения расставляет расширение, здесь проверяется синтез.
const TEXTS = args.text?.length ? args.text : [
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

if (args.transcribe) await checkTranscription();
if (args.accent) await checkAccent();

client.close();
console.log('✓ ускоритель работает');

/** Голосовые заметки: синтезированная фраза → Whisper → те же слова. */
async function checkTranscription() {
  if (!hello.features?.includes('transcribe')) fail('помощник не умеет расшифровывать');
  let started = performance.now();
  const { Readable } = await import('node:stream');
  for (const model of SPEECH_MODELS) {
    const file = local(`whisper/${model.url.split('/').pop()}`);
    if (!fs.existsSync(file)) {
      if (!args.download) fail(`нет ${file} (или --download)`);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const response = await fetch(model.url);
      if (!response.ok) fail(`${model.name}: ${response.status}`);
      fs.writeFileSync(file, Buffer.from(await response.arrayBuffer()));
    }
    // Как расширение: потоком, с проверкой SHA-256 в помощнике.
    await client.streamFile(model.name, Readable.toWeb(fs.createReadStream(file)), model);
  }
  console.log(`передал модели расшифровки за ${((performance.now() - started) / 1000).toFixed(1)} с`);

  // Повреждённый файл помощник не принимает.
  const broken = await client
    .streamFile(WHISPER_MODEL.name, new Blob([new Uint8Array(1000)]).stream(), { size: 1000, sha256: WHISPER_MODEL.sha256 })
    .then(() => null, (error) => error.message);
  if (!/SHA-256/.test(broken || '')) fail(`повреждённая модель принята: ${broken}`);
  const after = await client.hello();
  if (after.files.whisper !== WHISPER_MODEL.size) fail('после повреждённой передачи модель пропала');

  const phrase = 'С+егодня мы чит+аем кн+игу о т+ом, как раб+отает с+интез р+ечи, и сл+ушаем, как зв+учит г+олос.';
  const { withStress, plain } = encodeText(modelText('ru', keepSupported(phrase, table)), table);
  const { pcm, sampleRate } = await client.synth({ ids: withStress, plain, ...voice, maxSeconds: maxSecondsFor(phrase) });
  started = performance.now();
  const { text, timings, system, threads } = await client.transcribe(resample(pcm, sampleRate), 'ru');
  const elapsed = (performance.now() - started) / 1000;
  const words = ['книгу', 'синтез', 'голос'].filter((word) => text.toLowerCase().includes(word));
  console.log(`whisper.cpp: ${system}; потоков ${threads}; детектор речи ${timings?.vad} мс, загрузка ${timings?.load} мс, распознавание ${timings?.decode} мс`);
  const line = `расшифровка за ${elapsed.toFixed(1)} с: «${text}»`;
  if (words.length < 2) fail(`${line} — не те слова`);
  console.log(line);

  // Тишина с тихим шумом: детектор речи не пускает её к Whisper — текста нет.
  const hush = Float32Array.from({ length: 16000 * 3 }, () => (Math.random() - 0.5) * 0.004);
  const quiet = await client.transcribe(hush, 'ru');
  if (quiet.text) fail(`на тишине «расшифровано»: «${quiet.text}»`);
  console.log('на тишине — пусто, как и должно');
}


/** Сети ударений: помощник против onnxruntime-web — одни и те же ответы. */
async function checkAccent() {
  if (!hello.features?.includes('accent')) fail('помощник не умеет ударения');
  for (const relative of Object.values(ACCENT_FILES)) {
    if (fs.existsSync(local(relative))) continue;
    if (!args.download) fail(`нет ${local(relative)} (или --download)`);
    const tail = relative.replace(/^ruaccent\//, 'ruaccent/').replace(/^omograph-int8\//, '');
    const url = PACK_URLS.find((item) => item.endsWith(`/${tail}`));
    if (!url) fail(`не знаю, откуда скачать ${relative}`);
    console.log(`скачиваю ${relative}`);
    const response = await fetch(url);
    if (!response.ok) fail(`${url}: ${response.status}`);
    fs.mkdirSync(path.dirname(local(relative)), { recursive: true });
    fs.writeFileSync(local(relative), Buffer.from(await response.arrayBuffer()));
  }
  const read = (name) => fs.readFileSync(local(ACCENT_FILES[name]));
  const json = (name) => JSON.parse(read(name).toString('utf8'));
  // Модель омографов — облегчённая, как её собирает расширение (tera-pack.js, omographLight).
  const omograph = quantizeModel(new Uint8Array(read('omographModel')), { int8Weights: true, dynamic: true, exclude: (name) => name.includes('attention') }).model;
  const files = {
    yoTokenizer: json('yoTokenizer'),
    yoTokenizerConfig: json('yoTokenizerConfig'),
    yoLabels: json('yoConfig').id2label,
    omographTokenizer: json('omographTokenizer'),
    omographTokenizerConfig: json('omographTokenizerConfig'),
    accentVocab: read('accentVocab').toString('utf8'),
    accentLabels: json('accentConfig').id2label,
  };
  // Ускорителю — та же модель с весами uint8 (tera-pack.js, omographHelper): на AVX2 без VNNI
  // нативный uint8 × int8 переполняется, и омографы выбирались неверно.
  const omographHelper = quantizeModel(new Uint8Array(read('omographModel')), {
    int8Weights: true,
    unsignedWeights: true,
    dynamic: true,
    exclude: (name) => name.includes('attention'),
  }).model;
  // Сеть ударений — тоже с весами uint8 (tera-pack.js, accentHelper): авторы RUAccent
  // квантовали её uint8 × int8, и на AVX2 без VNNI логиты уходили на 0,13.
  const accentHelper = quantizeModel(new Uint8Array(read('accentModel')), { unsignedWeights: true, dynamic: false }).model;
  const blobs = { accentYo: new Blob([read('yoModel')]), accentOmograph: new Blob([omographHelper]), accentStress: new Blob([accentHelper]) };
  let started = performance.now();
  const sent = await syncModels(client, (await client.hello()).files, blobs, null, Object.keys(HELPER_ACCENT_MODELS));
  console.log(sent.length ? `передал модели ударений (${sent.join(', ')}) за ${((performance.now() - started) / 1000).toFixed(1)} с` : 'модели ударений уже у помощника');

  const ort = await import('onnxruntime-web');
  ort.env.wasm.numThreads = 1;
  const { Tokenizer } = await import('../extension/vendor/tokenizers/tokenizers.min.mjs');
  const wasm = await createAccentModels(ort, Tokenizer, { ...files, yoModel: read('yoModel'), omographModel: omograph, accentModel: read('accentModel') });
  let worst = 0;
  const times = [];
  const remoteOrt = createRemoteOrt(async (model, inputs) => {
    const begin = performance.now();
    const reply = await client.infer(model, inputs);
    times.push(performance.now() - begin);
    return reply;
  });
  const remote = await createAccentModels(remoteOrt, Tokenizer, { ...files, yoModel: 'accentYo', omographModel: 'accentOmograph', accentModel: 'accentStress' });

  const sentences = [
    'Все ещё ждали, когда он придёт, и все же она пришла первой.',
    'На берегу стоял старинный замок, а на двери висел тяжёлый замок.',
    'Мука была белой, а мука ожидания — невыносимой.',
    'Философ писал о свободе, справедливости и долге.',
  ];
  const omographCases = [
    ['На берегу стоял старинный <w>замок</w>.', ['з+амок', 'зам+ок']],
    ['На двери висел тяжёлый <w>замок</w>.', ['з+амок', 'зам+ок']],
    ['Он испытывал настоящую <w>муку</w> ожидания.', ['м+уку', 'мук+у']],
  ];
  const words = ['коммунитаризм', 'деконструкция', 'постмодернистский', 'нейросеть', 'квазиобъект'];
  const differences = [];
  for (const sentence of sentences) {
    const [a, b] = [await wasm.yoLabels(sentence), await remote.yoLabels(sentence)];
    if (JSON.stringify(a) !== JSON.stringify(b)) differences.push(`ё: ${sentence} ${a} ≠ ${b}`);
  }
  for (const [context, variants] of omographCases) {
    const [a, b] = [await wasm.chooseOmograph(context, variants), await remote.chooseOmograph(context, variants)];
    if (a !== b) differences.push(`омограф: ${context} ${a} ≠ ${b}`);
    console.log(`омограф «${context}» → ${b}`);
  }
  for (const word of words) {
    const [a, b] = [await wasm.accentWord(word), await remote.accentWord(word)];
    if (a !== b) differences.push(`ударение: ${a} ≠ ${b}`);
    console.log(`незнакомое слово → ${b}`);
  }
  // Сами логиты на одном входе. Обе сети квантуют входы слоёв на лету.
  // Сеть ударений маленькая: расхождение на уровне округления. В сети
  // омографов на другом процессоре float-часть считает в другом порядке, и
  // значение на границе ступени квантования уходит в соседнюю — логиты
  // сдвигаются на десятые (на серверах CI ≈ 0,13), решения при этом те же
  // (сверены выше).
  const sessions = { accentStress: read('accentModel'), accentOmograph: omograph };
  const tolerance = { accentStress: 1e-3, accentOmograph: 0.5 };
  const drift = {};
  for (const [model, bytes] of Object.entries(sessions)) {
    const session = await ort.InferenceSession.create(bytes, { executionProviders: ['wasm'], graphOptimizationLevel: 'all' });
    const ids = model === 'accentStress' ? [1, 5, 9, 12, 7, 2] : [1, 300, 4500, 222, 2];
    const tensor = (values) => new ort.Tensor('int64', BigInt64Array.from(values, BigInt), [1, values.length]);
    const feeds = { input_ids: tensor(ids), attention_mask: tensor(ids.map(() => 1)), token_type_ids: tensor(ids.map(() => 0)) };
    const local = (await session.run(Object.fromEntries(session.inputNames.map((name) => [name, feeds[name]])))).logits.data;
    const { data } = await client.infer(model, { input_ids: ids, attention_mask: ids.map(() => 1), token_type_ids: ids.map(() => 0) });
    drift[model] = 0;
    for (let i = 0; i < local.length; i += 1) drift[model] = Math.max(drift[model], Math.abs(local[i] - data[i]));
    worst = Math.max(worst, drift[model]);
  }
  const sorted = [...times].sort((a, b) => a - b);
  console.log(
    `сети ударений в помощнике: ${times.length} вопросов, первый (с загрузкой) ${times[0].toFixed(0)} мс, ` +
      `обычный ${sorted[Math.floor(sorted.length / 2)].toFixed(1)} мс; расхождение логитов: ` +
      Object.entries(drift)
        .map(([model, value]) => `${model} ${value.toExponential(1)}`)
        .join(', ')
  );
  if (differences.length) fail(`ответы помощника отличаются от WebAssembly:\n${differences.join('\n')}`);
  for (const [model, value] of Object.entries(drift)) if (value > tolerance[model]) fail(`логиты ${model} расходятся на ${value}`);
  const unknown = await client.infer('accentNothing', { input_ids: [1] }).then(() => null, (error) => error.message);
  if (!/незнакомая модель/.test(unknown || '')) fail(`незнакомая модель не отвергнута: ${unknown}`);
  console.log('✓ ударения в помощнике — как в браузере');
}
