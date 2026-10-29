//! Начальный шум сэмплера — тот же, что у tera-noise.js (mulberry32 и
//! преобразование Бокса — Мюллера с тем же зерном): фраза звучит так же, как
//! при синтезе в браузере.

pub const SEED: u32 = 1234;

pub fn noise(count: usize, seed: u32) -> Vec<f32> {
    let mut state = seed;
    let mut uniform = || {
        state = state.wrapping_add(0x6d2b_79f5);
        let mut t = state;
        t = (t ^ (t >> 15)).wrapping_mul(t | 1);
        t ^= t.wrapping_add((t ^ (t >> 7)).wrapping_mul(t | 61));
        f64::from(t ^ (t >> 14)) / 4_294_967_296.0
    };
    let mut out = vec![0f32; count];
    let mut i = 0;
    while i < count {
        let u = uniform();
        let radius = (-2.0 * (if u == 0.0 { 1e-12 } else { u }).ln()).sqrt();
        let angle = 2.0 * std::f64::consts::PI * uniform();
        out[i] = (radius * angle.cos()) as f32;
        if i + 1 < count {
            out[i + 1] = (radius * angle.sin()) as f32;
        }
        i += 2;
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Значения из tera-noise.js (Node) для того же зерна.
    #[test]
    #[allow(clippy::excessive_precision)]
    fn same_as_browser() {
        let expected = [
            -0.659_691_15_f32,
            -2.188_911_6,
            0.444_370_93,
            -0.083_179_645,
            1.866_875_9,
            1.704_376_3,
            0.621_162_77,
        ];
        assert_eq!(noise(7, SEED), expected);
        let big = noise(144 * 300, SEED);
        let sum: f64 = big.iter().map(|&v| f64::from(v)).sum();
        assert!((sum - -32.678_438_175_797_055).abs() < 1e-6, "{sum}");
        assert_eq!(big[43199], -0.968_051_14);
    }
}
