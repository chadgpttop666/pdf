// Начальный шум сэмплера TeraTTS. Повторяемый: одна и та же фраза звучит
// одинаково при каждом синтезе — и в браузере, и в ускорителе (native/src/noise.rs
// повторяет его до бита).

export const NOISE_SEED = 1234;

export function noise(count, seed = NOISE_SEED) {
  let state = seed >>> 0;
  const uniform = () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const out = new Float32Array(count);
  for (let i = 0; i < count; i += 2) {
    const radius = Math.sqrt(-2 * Math.log(uniform() || 1e-12));
    const angle = 2 * Math.PI * uniform();
    out[i] = radius * Math.cos(angle);
    if (i + 1 < count) out[i + 1] = radius * Math.sin(angle);
  }
  return out;
}
