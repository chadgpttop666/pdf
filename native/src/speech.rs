//! Расшифровка голосовых заметок: whisper.cpp, модель small (q5_1, 190 МБ).
//! Модель расширение скачивает с согласия человека и передаёт помощнику
//! так же, как модели речи; звук — 16 кГц, моно.
//!
//! Перед Whisper — детектор речи Silero VAD (меньше мегабайта): на тишине,
//! шуме и гуле Whisper сочиняет фразы («Субтитры…», «Спасибо за просмотр»),
//! поэтому слушает он только куски с речью, а без речи не запускается вовсе.

use std::borrow::Cow;
use std::path::Path;
use std::time::Instant;
use whisper_rs::{FullParams, SamplingStrategy, WhisperContext, WhisperContextParameters, WhisperVadContext, WhisperVadContextParams, WhisperVadParams};

/// Имена файлов моделей в папке моделей.
pub const MODEL_FILE: &str = "whisper.bin";
pub const VAD_FILE: &str = "whisper-vad.bin";
pub const SAMPLE_RATE: usize = 16_000;
/// Заметка длиннее пяти минут — это уже не заметка; ограничиваем и память.
pub const MAX_SECONDS: usize = 5 * 60;

/// Сборка рассчитана на процессоры с AVX2 и FMA (с 2013 года): без них
/// whisper.cpp упал бы с «недопустимой инструкцией» — проверяем заранее.
pub fn supported() -> Result<(), String> {
    #[cfg(target_arch = "x86_64")]
    {
        let ready = is_x86_feature_detected!("avx2") && is_x86_feature_detected!("fma") && is_x86_feature_detected!("f16c") && is_x86_feature_detected!("bmi2");
        if !ready {
            return Err("Процессор без AVX2 — расшифровка на нём не работает".into());
        }
    }
    Ok(())
}

/// Субтитры и пометки, которые Whisper выдумывает на тишине и шуме.
fn invented(segment: &str) -> bool {
    let lower = segment.to_lowercase();
    ["субтитры", "dimatorzok", "редактор субтитров", "продолжение следует", "спасибо за просмотр"]
        .iter()
        .any(|phrase| lower.contains(phrase))
}

/// Убрать «[Музыка]», «[Аплодисменты]» и подобное, лишние пробелы.
pub fn clean(segments: &[String]) -> String {
    let mut text = String::new();
    for segment in segments.iter().filter(|segment| !invented(segment)) {
        let mut depth = 0usize;
        for ch in segment.chars() {
            match ch {
                '[' => depth += 1,
                ']' if depth > 0 => depth -= 1,
                _ if depth == 0 => text.push(ch),
                _ => {}
            }
        }
        text.push(' ');
    }
    text.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// Потоки для расшифровки: все ядра, кроме одного — синтез и браузер не встанут.
pub fn threads() -> usize {
    let cores = std::thread::available_parallelism().map(|n| n.get()).unwrap_or(4);
    cores.saturating_sub(1).clamp(1, 8)
}

/// Куски с речью, склеенные через короткую паузу; пусто — речи нет.
fn speech_only(vad: &Path, samples: &[f32]) -> Result<Vec<f32>, String> {
    let path = vad.to_str().ok_or("путь к модели не в UTF-8")?;
    let mut context_params = WhisperVadContextParams::default();
    context_params.set_n_threads(1);
    let mut context = WhisperVadContext::new(path, context_params).map_err(|error| format!("детектор речи: {error}"))?;
    let segments = context
        .segments_from_samples(WhisperVadParams::default(), samples)
        .map_err(|error| format!("детектор речи: {error}"))?;
    let mut speech = Vec::new();
    for segment in segments {
        // Время — в сотых долях секунды.
        let from = ((segment.start.max(0.0) * (SAMPLE_RATE / 100) as f32) as usize).min(samples.len());
        let to = ((segment.end.max(0.0) * (SAMPLE_RATE / 100) as f32) as usize).min(samples.len());
        if to > from {
            speech.extend_from_slice(&samples[from..to]);
            speech.extend(std::iter::repeat_n(0.0, SAMPLE_RATE / 10));
        }
    }
    Ok(speech)
}

/// Текст заметки и сколько заняли части работы (мс) — для замеров.
#[derive(Debug, Default)]
pub struct Transcript {
    pub text: String,
    pub vad_ms: u128,
    pub load_ms: u128,
    pub decode_ms: u128,
}

/// Текст заметки. Модели грузятся на время расшифровки (около полсекунды) и
/// сразу освобождают память.
/// `vad` — детектор речи; без него Whisper слушает всю запись.
pub fn transcribe(model: &Path, vad: Option<&Path>, samples: &[f32], language: &str) -> Result<Transcript, String> {
    supported()?;
    if samples.len() > MAX_SECONDS * SAMPLE_RATE {
        return Err("Заметка длиннее пяти минут".into());
    }
    whisper_rs::install_logging_hooks(); // журнал whisper.cpp — не в stdout, там сообщения Firefox
    let mut result = Transcript::default();
    let mut clock = Instant::now();
    let speech;
    let samples = match vad {
        Some(vad) => {
            speech = speech_only(vad, samples)?;
            result.vad_ms = clock.elapsed().as_millis();
            if speech.is_empty() {
                return Ok(result);
            }
            &speech[..]
        }
        None => samples,
    };
    clock = Instant::now();
    let path = model.to_str().ok_or("путь к модели не в UTF-8")?;
    let context = WhisperContext::new_with_params(path, WhisperContextParameters::default()).map_err(|error| format!("модель Whisper: {error}"))?;
    let mut state = context.create_state().map_err(|error| format!("Whisper: {error}"))?;
    let mut params = FullParams::new(SamplingStrategy::Greedy { best_of: 1 });
    params.set_language(Some(language));
    params.set_n_threads(threads() as i32);
    params.set_no_context(true);
    params.set_suppress_nst(true);
    params.set_print_special(false);
    params.set_print_progress(false);
    params.set_print_realtime(false);
    params.set_print_timestamps(false);
    // Короче секунды Whisper не слушает — дополняем тишиной.
    let shortest = SAMPLE_RATE + SAMPLE_RATE / 10;
    let audio: Cow<[f32]> = if samples.len() < shortest {
        let mut padded = samples.to_vec();
        padded.resize(shortest, 0.0);
        Cow::Owned(padded)
    } else {
        Cow::Borrowed(samples)
    };
    result.load_ms = clock.elapsed().as_millis();
    clock = Instant::now();
    state.full(params, &audio).map_err(|error| format!("Whisper: {error}"))?;
    result.decode_ms = clock.elapsed().as_millis();
    let segments: Vec<String> = (0..state.full_n_segments())
        .filter_map(|index| state.get_segment(index))
        .filter_map(|segment| segment.to_str_lossy().ok().map(|text| text.into_owned()))
        .collect();
    result.text = clean(&segments);
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn removes_tags_and_invented_subtitles() {
        let segments = vec![
            " Глава вторая — про темп. [Музыка]".to_string(),
            " Субтитры сделал DimaTorzok".to_string(),
            "  [Аплодисменты] Вернуться к ней завтра.".to_string(),
        ];
        assert_eq!(clean(&segments), "Глава вторая — про темп. Вернуться к ней завтра.");
    }

    #[test]
    fn keeps_ordinary_brackets_text() {
        assert_eq!(clean(&[" См. главу (вторую)".to_string()]), "См. главу (вторую)");
    }
}
