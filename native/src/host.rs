//! Помощник, запущенный Firefox: сообщения из stdin, синтез двумя потоками
//! конвейером (как воркеры расширения: пока один готовит скрытое
//! представление следующей фразы, другой делает звук предыдущей), звук —
//! кусками меньше 1 МБ.

use crate::install;
use crate::protocol::{self, Outbox};
use crate::synth::{Latent, Latents, Request, Vocoder, SAMPLE_RATE};
use crate::{PROTOCOL, VERSION};
use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine;
use ort::environment::Environment;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::fs::{self, File, OpenOptions};
use std::io::{self, Write};
use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError, Sender};
use std::sync::{Arc, OnceLock};
use std::time::Duration;

/// Модели, которые расширение передаёт помощнику (имена — как в tera-pack.js).
pub const MODEL_NAMES: [&str; 4] = ["textEncoder", "duration", "sampler", "vocoder"];
// Модели занимают почти гигабайт — после простоя выгружаем, как и расширение.
const IDLE_UNLOAD: Duration = Duration::from_secs(10 * 60);
// Сэмплов в одном сообщении: 512 КБ, в base64 — около 700 КБ.
const AUDIO_CHUNK: usize = 128 * 1024;

struct Shared {
    out: Outbox<io::Stdout>,
    /// Растёт при отмене: фразы старше — уже не нужны.
    epoch: AtomicU64,
    /// Растёт, когда модель заменили: загруженные устарели.
    models: AtomicU64,
}

impl Shared {
    fn error(&self, id: &Value, message: &str, dropped: bool) {
        self.out.send(json!({ "type": "error", "id": id, "message": message, "dropped": dropped }));
    }

    fn stale(&self, epoch: u64) -> bool {
        epoch < self.epoch.load(Ordering::SeqCst)
    }
}

enum Job {
    Synth { id: Value, epoch: u64, request: Request },
    Load { id: Value },
    Unload,
}

enum Sound {
    Vocode { id: Value, epoch: u64, latent: Latent },
    Load { id: Value },
    Unload,
}

static ENVIRONMENT: OnceLock<Result<Environment, String>> = OnceLock::new();

fn environment() -> Result<Environment, String> {
    ENVIRONMENT
        .get_or_init(|| {
            let path = install::ort_library()?;
            ort::init_from(&path)
                .map_err(|error| format!("ONNX Runtime ({}): {error}", path.display()))?
                .with_name("pdf-reader-tts")
                // Без телеметрии Microsoft: помощник ничего никуда не отправляет.
                .with_telemetry(false)
                .build()
                .map_err(|error| format!("ONNX Runtime: {error}"))
        })
        .clone()
}

/// Потоки ONNX Runtime у сэмплера и вокодера: можно задать для замеров
/// (PDF_TTS_THREADS=2,1), иначе — по числу ядер. На четырёх ядрах — по
/// одному: второй поток сэмплера ускорял фразу на 15 %, а процессора брал на
/// 20 % больше, и одного хватает с запасом даже на 2,5×.
fn threads() -> (usize, usize) {
    if let Some((a, b)) = std::env::var("PDF_TTS_THREADS")
        .ok()
        .and_then(|v| v.split_once(',').map(|(a, b)| (a.parse().ok(), b.parse().ok())))
    {
        if let (Some(a), Some(b)) = (a, b) {
            return (a, b);
        }
    }
    let cores = std::thread::available_parallelism().map(|n| n.get()).unwrap_or(4);
    ((cores / 4).clamp(1, 4), 1)
}

fn model_files() -> serde_json::Map<String, Value> {
    let dir = install::models_dir();
    MODEL_NAMES
        .iter()
        .filter_map(|name| {
            fs::metadata(dir.join(format!("{name}.onnx")))
                .ok()
                .map(|meta| (name.to_string(), json!(meta.len())))
        })
        .collect()
}

/// Модели в памяти потока; загружаются при первой фразе и после замены файлов.
fn ensure<'a, T>(slot: &'a mut Option<(u64, T)>, shared: &Shared, load: impl FnOnce(&Environment, &Path) -> Result<T, String>) -> Result<&'a mut T, String> {
    let generation = shared.models.load(Ordering::SeqCst);
    if slot.as_ref().map(|(loaded, _)| *loaded) != Some(generation) {
        *slot = None; // старые — из памяти до загрузки новых
        if model_files().len() < MODEL_NAMES.len() {
            return Err("Модели ещё не переданы помощнику".into());
        }
        let value = load(&environment()?, &install::models_dir())?;
        *slot = Some((generation, value));
    }
    Ok(&mut slot.as_mut().expect("загружено выше").1)
}

fn latent_loop(shared: Arc<Shared>, jobs: Receiver<Job>, sound: Sender<Sound>) {
    let (threads, _) = threads();
    let mut models: Option<(u64, Latents)> = None;
    loop {
        let job = match jobs.recv_timeout(IDLE_UNLOAD) {
            Ok(job) => job,
            Err(RecvTimeoutError::Timeout) => {
                models = None;
                continue;
            }
            Err(RecvTimeoutError::Disconnected) => return,
        };
        match job {
            Job::Unload => {
                models = None;
                let _ = sound.send(Sound::Unload);
            }
            Job::Load { id } => match ensure(&mut models, &shared, |env, dir| Latents::load(env, dir, threads)) {
                Ok(_) => {
                    let _ = sound.send(Sound::Load { id });
                }
                Err(error) => shared.error(&id, &error, false),
            },
            Job::Synth { id, epoch, request } => {
                if shared.stale(epoch) {
                    shared.error(&id, "Фраза больше не нужна", true);
                    continue;
                }
                let result = ensure(&mut models, &shared, |env, dir| Latents::load(env, dir, threads)).and_then(|latents| latents.run(&request));
                match result {
                    Ok(latent) => {
                        let _ = sound.send(Sound::Vocode { id, epoch, latent });
                    }
                    Err(error) => shared.error(&id, &error, false),
                }
            }
        }
    }
}

fn vocoder_loop(shared: Arc<Shared>, jobs: Receiver<Sound>) {
    let (_, threads) = threads();
    let mut models: Option<(u64, Vocoder)> = None;
    loop {
        let job = match jobs.recv_timeout(IDLE_UNLOAD) {
            Ok(job) => job,
            Err(RecvTimeoutError::Timeout) => {
                models = None;
                continue;
            }
            Err(RecvTimeoutError::Disconnected) => return,
        };
        match job {
            Sound::Unload => models = None,
            Sound::Load { id } => match ensure(&mut models, &shared, |env, dir| Vocoder::load(env, dir, threads)) {
                Ok(_) => shared.out.send(json!({ "type": "loaded", "id": id })),
                Err(error) => shared.error(&id, &error, false),
            },
            Sound::Vocode { id, epoch, latent } => {
                if shared.stale(epoch) {
                    shared.error(&id, "Фраза больше не нужна", true);
                    continue;
                }
                match ensure(&mut models, &shared, |env, dir| Vocoder::load(env, dir, threads)).and_then(|vocoder| vocoder.run(latent)) {
                    Ok(pcm) => send_audio(&shared, &id, &pcm),
                    Err(error) => shared.error(&id, &error, false),
                }
            }
        }
    }
}

/// Звук фразы — float32 little-endian в base64, кусками.
fn send_audio(shared: &Shared, id: &Value, pcm: &[f32]) {
    let parts = pcm.len().div_ceil(AUDIO_CHUNK).max(1);
    for part in 0..parts {
        let chunk = &pcm[(part * AUDIO_CHUNK).min(pcm.len())..((part + 1) * AUDIO_CHUNK).min(pcm.len())];
        let bytes: Vec<u8> = chunk.iter().flat_map(|value| value.to_le_bytes()).collect();
        shared.out.send(json!({
            "type": "audio",
            "id": id,
            "part": part,
            "parts": parts,
            "samples": pcm.len(),
            "sampleRate": SAMPLE_RATE,
            "data": BASE64.encode(bytes),
            "last": part + 1 == parts,
        }));
    }
}

// ── Разбор сообщений ─────────────────────────────────────────────────────

fn text<'a>(message: &'a Value, key: &str) -> Result<&'a str, String> {
    message.get(key).and_then(Value::as_str).ok_or_else(|| format!("нет поля {key}"))
}

fn number(message: &Value, key: &str) -> Result<u64, String> {
    message.get(key).and_then(Value::as_u64).ok_or_else(|| format!("нет поля {key}"))
}

fn bytes(message: &Value, key: &str) -> Result<Vec<u8>, String> {
    BASE64.decode(text(message, key)?).map_err(|error| format!("{key}: {error}"))
}

fn floats(message: &Value, key: &str) -> Result<Vec<f32>, String> {
    let raw = bytes(message, key)?;
    if raw.len() % 4 != 0 {
        return Err(format!("{key}: не float32"));
    }
    Ok(raw.chunks_exact(4).map(|b| f32::from_le_bytes([b[0], b[1], b[2], b[3]])).collect())
}

fn integers(message: &Value, key: &str) -> Result<Vec<i64>, String> {
    message
        .get(key)
        .and_then(Value::as_array)
        .ok_or_else(|| format!("нет поля {key}"))?
        .iter()
        .map(|value| value.as_i64().ok_or_else(|| format!("{key}: не число")))
        .collect()
}

fn request(message: &Value) -> Result<Request, String> {
    Ok(Request {
        ids: integers(message, "ids")?,
        plain: integers(message, "plain")?,
        ttl: floats(message, "ttl")?,
        dp: floats(message, "dp")?,
        duration_scale: message.get("durationScale").and_then(Value::as_f64).unwrap_or(1.0),
        max_seconds: message.get("maxSeconds").and_then(Value::as_f64),
    })
}

/// Кусок файла: модели или новой версии программы. Пишется во временный
/// файл; последний кусок — проверка размера и переименование на место.
fn receive(message: &Value, partial: &Path) -> Result<Option<u64>, String> {
    let offset = number(message, "offset")?;
    let data = bytes(message, "data")?;
    let mut file = if offset == 0 {
        File::create(partial)
    } else {
        OpenOptions::new().append(true).open(partial)
    }
    .map_err(|error| format!("{}: {error}", partial.display()))?;
    let length = file.metadata().map(|meta| meta.len()).unwrap_or(0);
    if length != offset {
        return Err(format!("кусок не по порядку: ждали {length}, пришёл {offset}"));
    }
    file.write_all(&data).map_err(|error| format!("{}: {error}", partial.display()))?;
    let received = offset + data.len() as u64;
    if message.get("last").and_then(Value::as_bool) == Some(true) {
        let size = number(message, "size")?;
        if received != size {
            return Err(format!("файл неполный: {received} из {size} байт"));
        }
        return Ok(Some(received));
    }
    Ok(None)
}

fn handle(message: &Value, shared: &Shared, jobs: &Sender<Job>) -> Result<(), String> {
    let id = message.get("id").cloned().unwrap_or(Value::Null);
    match text(message, "type")? {
        "hello" => {
            let ort = environment().err();
            shared.out.send(json!({
                "type": "hello",
                "id": id,
                "version": VERSION,
                "protocol": PROTOCOL,
                "files": model_files(),
                "cores": std::thread::available_parallelism().map(|n| n.get()).unwrap_or(1),
                "ortError": ort,
            }));
        }
        "file" => {
            let name = text(message, "name")?;
            if !MODEL_NAMES.contains(&name) {
                return Err(format!("незнакомая модель {name}"));
            }
            let dir = install::models_dir();
            fs::create_dir_all(&dir).map_err(|error| format!("{}: {error}", dir.display()))?;
            // У каждой копии помощника (читалка и плашка на сайте — разные
            // процессы) свой временный файл: передачи не мешают друг другу.
            let partial = dir.join(format!("{name}.onnx.{}.part", std::process::id()));
            let done = receive(message, &partial)?;
            if done.is_some() {
                fs::rename(&partial, dir.join(format!("{name}.onnx"))).map_err(|error| format!("{name}: {error}"))?;
                shared.models.fetch_add(1, Ordering::SeqCst);
            }
            shared.out.send(json!({ "type": "file-ok", "id": id, "name": name, "done": done.is_some() }));
        }
        "load" => jobs.send(Job::Load { id }).map_err(|_| "синтез остановлен".to_string())?,
        "unload" => {
            let _ = jobs.send(Job::Unload);
            shared.out.send(json!({ "type": "unloaded", "id": id }));
        }
        "epoch" => {
            shared.epoch.fetch_max(number(message, "epoch")?, Ordering::SeqCst);
        }
        "synth" => {
            let epoch = message.get("epoch").and_then(Value::as_u64).unwrap_or(0);
            if shared.stale(epoch) {
                shared.error(&id, "Фраза больше не нужна", true);
                return Ok(());
            }
            jobs.send(Job::Synth {
                id,
                epoch,
                request: request(message)?,
            })
            .map_err(|_| "синтез остановлен".to_string())?;
        }
        "update" => {
            let partial = install::data_dir().join(format!("update.{}.part", std::process::id()));
            if receive(message, &partial)?.is_some() {
                let digest = Sha256::digest(fs::read(&partial).map_err(|error| error.to_string())?);
                let hex: String = digest.iter().map(|b| format!("{b:02x}")).collect();
                if !hex.eq_ignore_ascii_case(text(message, "sha256")?) {
                    let _ = fs::remove_file(&partial);
                    return Err("обновление повреждено: не сходится SHA-256".into());
                }
                install::replace_exe(&partial)?;
                let _ = fs::remove_file(&partial);
                shared.out.send(json!({ "type": "updated", "id": id }));
            } else {
                shared.out.send(json!({ "type": "update-ok", "id": id }));
            }
        }
        "uninstall" => {
            install::uninstall()?;
            shared.out.send(json!({ "type": "bye", "id": id }));
            std::process::exit(0);
        }
        other => return Err(format!("незнакомое сообщение {other}")),
    }
    Ok(())
}

pub fn run() -> i32 {
    install::clean_leftovers();
    install::refresh();
    let shared = Arc::new(Shared {
        out: Outbox::new(io::stdout()),
        epoch: AtomicU64::new(0),
        models: AtomicU64::new(0),
    });
    let (jobs, job_queue) = mpsc::channel();
    let (sounds, sound_queue) = mpsc::channel();
    {
        let shared = Arc::clone(&shared);
        std::thread::spawn(move || latent_loop(shared, job_queue, sounds));
    }
    {
        let shared = Arc::clone(&shared);
        std::thread::spawn(move || vocoder_loop(shared, sound_queue));
    }
    let mut input = io::stdin().lock();
    loop {
        let message = match protocol::read(&mut input) {
            Ok(Some(message)) => message,
            Ok(None) => return 0, // Firefox закрыл канал
            Err(error) => {
                eprintln!("pdf-reader-tts: {error}");
                return 1;
            }
        };
        if let Err(error) = handle(&message, &shared, &jobs) {
            shared.error(&message.get("id").cloned().unwrap_or(Value::Null), &error, false);
        }
    }
}
