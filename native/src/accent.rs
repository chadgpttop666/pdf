//! Нейросети ударений RUAccent («ё», омографы, ударение в незнакомом слове)
//! для воркера ударений расширения. Словари, токенизаторы и правила остаются
//! в браузере (ruaccent.js) — здесь только прогон сетей: номера токенов
//! на входе, логиты на выходе. Так в Firefox не нужен ONNX Runtime с тремя
//! моделями — это полгигабайта памяти вкладки.

use crate::synth::Result;
use ort::environment::Environment;
use ort::session::builder::GraphOptimizationLevel;
use ort::session::Session;
use ort::value::Tensor;
use std::collections::HashMap;
use std::path::Path;

/// Модели ударений, которые расширение передаёт помощнику.
pub const MODEL_NAMES: [&str; 3] = ["accentYo", "accentOmograph", "accentStress"];

/// Входы, которые знает воркер ударений: у разных сетей — разный их набор.
pub type Inputs = Vec<(String, Vec<i64>)>;

/// Логиты: форма и данные.
pub struct Logits {
    pub dims: Vec<i64>,
    pub data: Vec<f32>,
}

/// Сети ударений в памяти: грузятся при первом вопросе к каждой.
#[derive(Default)]
pub struct Accents {
    sessions: HashMap<String, Session>,
}

fn open(environment: &Environment, path: &Path) -> Result<Session> {
    let name = path.file_name().unwrap_or_default().to_string_lossy().into_owned();
    Session::builder(environment)
        .map_err(|error| format!("{name}: {error}"))?
        .with_optimization_level(GraphOptimizationLevel::All)
        .map_err(|error| format!("{name}: {error}"))?
        // Сети маленькие, фразы короткие: одного потока хватает, а синтезу
        // рядом нужны свободные ядра.
        .with_intra_threads(1)
        .map_err(|error| format!("{name}: {error}"))?
        .with_intra_op_spinning(false)
        .map_err(|error| format!("{name}: {error}"))?
        .commit_from_file(path)
        .map_err(|error| format!("{name}: {error}"))
}

impl Accents {
    pub fn clear(&mut self) {
        self.sessions.clear();
    }

    /// Прогнать сеть: только те входы, что объявлены в её графе; все — форма [1, n].
    pub fn run(&mut self, environment: &Environment, models: &Path, model: &str, inputs: &Inputs) -> Result<Logits> {
        if !MODEL_NAMES.contains(&model) {
            return Err(format!("незнакомая модель ударений {model}"));
        }
        if !self.sessions.contains_key(model) {
            let path = models.join(format!("{model}.onnx"));
            if !path.exists() {
                return Err(format!("Модель {model} ещё не передана помощнику"));
            }
            self.sessions.insert(model.to_string(), open(environment, &path)?);
        }
        let session = self.sessions.get_mut(model).expect("загружена выше");
        let declared: Vec<String> = session.inputs().iter().map(|input| input.name().to_string()).collect();
        let mut feeds: Vec<(String, Tensor<i64>)> = Vec::new();
        for name in &declared {
            let values = inputs
                .iter()
                .find(|(key, _)| key == name)
                .map(|(_, values)| values.clone())
                .ok_or_else(|| format!("{model}: нет входа {name}"))?;
            let length = values.len() as i64;
            let tensor = Tensor::from_array((vec![1, length], values)).map_err(|error| format!("{model}: {error}"))?;
            feeds.push((name.clone(), tensor));
        }
        let outputs = session.run(feeds).map_err(|error| format!("{model}: {error}"))?;
        let (shape, data) = outputs[0].try_extract_tensor::<f32>().map_err(|error| format!("{model}: {error}"))?;
        Ok(Logits {
            dims: shape.iter().copied().collect(),
            data: data.to_vec(),
        })
    }
}
