//! Синтез TeraTTSv2 — те же шаги, что в tera-worker.js: text_encoder →
//! длительность → sampler (скрытое представление речи) → vocoder (звук).
//! Текст в номера символов переводит расширение (tera-text.js), оно же
//! обрезает тишину по краям.

use crate::noise::{noise, SEED};
use ort::environment::Environment;
use ort::session::builder::GraphOptimizationLevel;
use ort::session::Session;
use ort::value::Tensor;
use std::path::Path;

pub const SAMPLE_RATE: u32 = 44_100;
const SAMPLES_PER_FRAME: usize = 3072;
const LATENT_CHANNELS: usize = 144;
// Множитель длительности, с которым модель обучена звучать естественно.
const SPEED: f64 = 1.05;
const GUIDANCE: f32 = 3.0;

pub type Result<T> = std::result::Result<T, String>;

trait Context<T> {
    fn context(self, what: &str) -> Result<T>;
}

impl<T, E: std::fmt::Display> Context<T> for std::result::Result<T, E> {
    fn context(self, what: &str) -> Result<T> {
        self.map_err(|error| format!("{what}: {error}"))
    }
}

/// Фраза, уже переведённая в номера символов (с ударениями и без).
pub struct Request {
    pub ids: Vec<i64>,
    pub plain: Vec<i64>,
    /// Стиль голоса: [1, 50, 256] и [1, 8, 16].
    pub ttl: Vec<f32>,
    pub dp: Vec<f32>,
    pub duration_scale: f64,
    pub max_seconds: Option<f64>,
}

pub struct Latent {
    pub data: Vec<f32>,
    pub frames: usize,
    pub samples: usize,
}

fn session(environment: &Environment, path: &Path, threads: usize) -> Result<Session> {
    let name = path.file_name().unwrap_or_default().to_string_lossy().into_owned();
    Session::builder(environment)
        .context(&name)?
        .with_optimization_level(GraphOptimizationLevel::All)
        .map_err(|error| format!("{name}: {error}"))?
        .with_intra_threads(threads)
        .map_err(|error| format!("{name}: {error}"))?
        // Потоки не крутятся вхолостую между запусками: помощник работает
        // фоном, и лишняя загрузка процессора здесь хуже лишней миллисекунды.
        .with_intra_op_spinning(false)
        .map_err(|error| format!("{name}: {error}"))?
        .commit_from_file(path)
        .context(&name)
}

fn first_f32(outputs: &ort::session::SessionOutputs, what: &str) -> Result<(Vec<i64>, Vec<f32>)> {
    let (shape, data) = outputs[0].try_extract_tensor::<f32>().context(what)?;
    Ok((shape.iter().copied().collect(), data.to_vec()))
}

fn tensor<T: ort::value::PrimitiveTensorElementType + Clone + std::fmt::Debug + 'static>(shape: Vec<i64>, data: Vec<T>) -> Result<Tensor<T>> {
    Tensor::from_array((shape, data)).context("тензор")
}

/// Первая половина: text_encoder, длительность и сэмплер.
pub struct Latents {
    text_encoder: Session,
    duration: Session,
    sampler: Session,
}

impl Latents {
    pub fn load(environment: &Environment, models: &Path, threads: usize) -> Result<Self> {
        Ok(Self {
            text_encoder: session(environment, &models.join("textEncoder.onnx"), threads)?,
            duration: session(environment, &models.join("duration.onnx"), 1)?,
            sampler: session(environment, &models.join("sampler.onnx"), threads)?,
        })
    }

    pub fn run(&mut self, request: &Request) -> Result<Latent> {
        if request.ids.is_empty() || request.plain.is_empty() {
            return Err("пустой текст".into());
        }
        if request.ttl.len() != 50 * 256 || request.dp.len() != 8 * 16 {
            return Err("неверный стиль голоса".into());
        }
        let n = request.ids.len() as i64;
        let m = request.plain.len() as i64;
        let (emb_shape, emb) = {
            let outputs = self
                .text_encoder
                .run(ort::inputs![
                    "text_ids" => tensor(vec![1, n], request.ids.clone())?,
                    "style_ttl" => tensor(vec![1, 50, 256], request.ttl.clone())?,
                    "text_mask" => tensor(vec![1, 1, n], vec![1f32; n as usize])?,
                ])
                .context("text_encoder")?;
            first_f32(&outputs, "text_encoder")?
        };
        let predicted = {
            let outputs = self
                .duration
                .run(ort::inputs![
                    "text_ids" => tensor(vec![1, m], request.plain.clone())?,
                    "style_dp" => tensor(vec![1, 8, 16], request.dp.clone())?,
                    "text_mask" => tensor(vec![1, 1, m], vec![1f32; m as usize])?,
                ])
                .context("duration")?;
            first_f32(&outputs, "duration")?.1.first().copied().unwrap_or(0.0)
        };
        let mut seconds = f64::from(predicted) * request.duration_scale / SPEED;
        if let Some(max) = request.max_seconds {
            seconds = seconds.min(max * request.duration_scale);
        }
        if seconds.is_nan() || seconds <= 0.0 {
            return Err("Модель не смогла оценить длительность фразы".into());
        }
        let frames = ((seconds * f64::from(SAMPLE_RATE)) / SAMPLES_PER_FRAME as f64).ceil().max(1.0) as usize;
        let data = {
            let outputs = self
                .sampler
                .run(ort::inputs![
                    "initial_latent" => tensor(vec![1, LATENT_CHANNELS as i64, frames as i64], noise(LATENT_CHANNELS * frames, SEED))?,
                    "text_emb" => tensor(emb_shape, emb)?,
                    "style_ttl" => tensor(vec![1, 50, 256], request.ttl.clone())?,
                    "latent_mask" => tensor(vec![1, 1, frames as i64], vec![1f32; frames])?,
                    "text_mask" => tensor(vec![1, 1, n], vec![1f32; n as usize])?,
                    "guidance" => tensor(vec![1], vec![GUIDANCE])?,
                ])
                .context("sampler")?;
            first_f32(&outputs, "sampler")?.1
        };
        Ok(Latent {
            data,
            frames,
            samples: (seconds * f64::from(SAMPLE_RATE)).round() as usize,
        })
    }
}

/// Вторая половина: скрытое представление → звук.
pub struct Vocoder {
    session: Session,
}

impl Vocoder {
    pub fn load(environment: &Environment, models: &Path, threads: usize) -> Result<Self> {
        Ok(Self {
            session: session(environment, &models.join("vocoder.onnx"), threads)?,
        })
    }

    pub fn run(&mut self, latent: Latent) -> Result<Vec<f32>> {
        let outputs = self
            .session
            .run(ort::inputs!["latent" => tensor(vec![1, LATENT_CHANNELS as i64, latent.frames as i64], latent.data)?])
            .context("vocoder")?;
        let (_, data) = outputs[0].try_extract_tensor::<f32>().context("vocoder")?;
        Ok(data[..latent.samples.min(data.len())].to_vec())
    }
}
