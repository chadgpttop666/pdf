// Ускорение и замедление речи без изменения высоты голоса — WSOLA:
// запись режется на перекрывающиеся окна, и каждое следующее окно берётся
// не ровно там, куда указывает скорость, а чуть сдвинутым — где звук
// лучше всего продолжает предыдущее окно. Так волны складываются в фазе,
// и голос не дребезжит.
//
// Зачем это нужно, а не скорость самой модели: если просить нейроголос
// говорить быстрее, он «зажёвывает» слова — при 1,8× Whisper не расслышал
// половины фразы, при 2,2× почти ничего. Та же фраза, синтезированная на
// 1× и ускоренная так, разбиралась целиком до 2,5×. И скорость можно
// менять посреди фразы, без нового синтеза.

const WINDOW_SECONDS = 0.03;
// Насколько можно сдвинуть окно ради совпадения фазы: больше полупериода
// самого низкого голоса (≈ 70 Гц).
const TOLERANCE_SECONDS = 0.008;
// Сходство окон сначала считается грубо (каждый N-й отсчёт — для речи
// хватает и ~11 кГц), потом уточняется рядом с лучшим сдвигом.
const COARSE_RATE = 11025;

const hannCache = new Map();
function hann(length) {
  if (!hannCache.has(length)) {
    const window = new Float32Array(length);
    // Периодическое окно: при шаге в полокна сумма окон ровно 1.
    for (let i = 0; i < length; i += 1) window[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / length);
    hannCache.set(length, window);
  }
  return hannCache.get(length);
}

function similarity(x, a, b, length, step) {
  let sum = 0;
  for (let i = 0; i < length; i += step) sum += x[a + i] * x[b + i];
  return sum;
}

/**
 * Ускоритель записи, отдающий звук кусками: первый кусок готов сразу, а
 * остальное считается, пока он звучит.
 * @param pcm Float32Array, моно
 * @param rate 2 — вдвое быстрее (и короче), 0,5 — вдвое медленнее
 * @returns {{ length: number, take(count): Float32Array|null }}
 *   length — длина ускоренной записи; take отдаёт следующие count
 *   отсчётов, null — запись кончилась
 */
export function createStretcher(pcm, sampleRate, rate) {
  const length = rate > 0 ? Math.ceil(pcm.length / rate) : pcm.length;
  let emitted = 0;
  // На обычной скорости — сама запись.
  if (!(rate > 0) || Math.abs(rate - 1) < 0.01) {
    return {
      length: pcm.length,
      take(count) {
        if (emitted >= pcm.length) return null;
        const block = pcm.subarray(emitted, Math.min(pcm.length, emitted + count));
        emitted += block.length;
        return block;
      },
    };
  }

  const frame = 2 * Math.round((WINDOW_SECONDS * sampleRate) / 2);
  const hop = frame / 2;
  const tolerance = Math.round(TOLERANCE_SECONDS * sampleRate);
  const coarse = Math.max(1, Math.round(sampleRate / COARSE_RATE));
  const window = hann(frame);

  // Тишина по краям — чтобы окна у начала и конца не выходили за запись.
  const pad = frame + tolerance + hop;
  const x = new Float32Array(pcm.length + 2 * pad);
  x.set(pcm, pad);
  const out = new Float32Array(length + frame);
  const weight = new Float32Array(length + frame);
  let at = 0; // где в ускоренной записи начинается следующее окно
  let previous = pad; // откуда в исходной взято предыдущее окно

  function addFrame() {
    const nominal = pad + Math.round(at * rate);
    let source = nominal;
    if (at > 0) {
      // Где запись естественно продолжает предыдущее окно — на это и равняемся.
      const natural = previous + hop;
      let best = -Infinity;
      for (let shift = -tolerance; shift <= tolerance; shift += coarse) {
        const score = similarity(x, nominal + shift, natural, hop, coarse);
        if (score > best) {
          best = score;
          source = nominal + shift;
        }
      }
      if (coarse > 1) {
        const from = Math.max(nominal - tolerance, source - coarse + 1);
        const to = Math.min(nominal + tolerance, source + coarse - 1);
        best = -Infinity;
        for (let candidate = from; candidate <= to; candidate += 1) {
          const score = similarity(x, candidate, natural, hop, 1);
          if (score > best) {
            best = score;
            source = candidate;
          }
        }
      }
    }
    for (let i = 0; i < frame; i += 1) {
      out[at + i] += window[i] * x[source + i];
      weight[at + i] += window[i];
    }
    previous = source;
    at += hop;
  }

  return {
    length,
    take(count) {
      if (emitted >= length) return null;
      const end = Math.min(length, emitted + count);
      // Всё, что раньше начала следующего окна, уже сложено окончательно.
      while (at < end) addFrame();
      const block = new Float32Array(end - emitted);
      // У краёв окна не перекрываются — делим на их сумму, чтобы не было затухания.
      for (let i = emitted; i < end; i += 1) block[i - emitted] = weight[i] > 1e-6 ? out[i] / weight[i] : 0;
      emitted = end;
      return block;
    },
  };
}

/** Вся запись на скорости rate, высота голоса та же. */
export function timeStretch(pcm, sampleRate, rate) {
  const stretcher = createStretcher(pcm, sampleRate, rate);
  return stretcher.take(stretcher.length) ?? new Float32Array(0);
}
