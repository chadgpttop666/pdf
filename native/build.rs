// Сборка для выпуска вшивает в программу библиотеку ONNX Runtime и то, что
// ей нужно рядом: скачивать и запускать нужно один файл.
//   PDF_TTS_ORT_LIB      — путь к библиотеке ONNX Runtime;
//   PDF_TTS_ORT_VERSION  — её версия (для имени файла рядом с программой);
//   PDF_TTS_EXTRA_LIBS   — ещё файлы через «;» (на Windows — DLL Visual C++,
//                          без которых ONNX Runtime не загрузится), имена — как есть.
// Без них библиотека ищется по ORT_DYLIB_PATH или рядом с программой — так
// удобнее для разработки и тестов.

use std::fmt::Write;
use std::path::PathBuf;

fn main() {
    println!("cargo::rustc-check-cfg=cfg(embedded_ort)");
    for name in ["PDF_TTS_ORT_LIB", "PDF_TTS_ORT_VERSION", "PDF_TTS_EXTRA_LIBS"] {
        println!("cargo::rerun-if-env-changed={name}");
    }
    // Полный путь, на Windows — без префикса \\?\ (с ним не всё работает).
    let canonical = |path: &str| {
        let full = std::fs::canonicalize(path).unwrap_or_else(|error| panic!("{path}: {error}"));
        PathBuf::from(full.display().to_string().trim_start_matches(r"\\?\"))
    };
    let mut bundle = String::from("pub const EXTRA_LIBS: &[(&str, &[u8])] = &[\n");
    if let Ok(path) = std::env::var("PDF_TTS_ORT_LIB") {
        let path = canonical(&path);
        println!("cargo::rerun-if-changed={}", path.display());
        println!("cargo::rustc-cfg=embedded_ort");
        println!("cargo::rustc-env=PDF_TTS_ORT_FILE={}", path.display());
        let version = std::env::var("PDF_TTS_ORT_VERSION").unwrap_or_else(|_| "embedded".into());
        println!("cargo::rustc-env=PDF_TTS_ORT_TAG={version}");
        for extra in std::env::var("PDF_TTS_EXTRA_LIBS")
            .unwrap_or_default()
            .split(';')
            .filter(|item| !item.is_empty())
        {
            let path = canonical(extra);
            println!("cargo::rerun-if-changed={}", path.display());
            let name = path.file_name().unwrap().to_string_lossy().to_lowercase();
            writeln!(bundle, "    ({name:?}, include_bytes!({:?})),", path.display().to_string()).unwrap();
        }
    }
    bundle.push_str("];\n");
    let out = PathBuf::from(std::env::var("OUT_DIR").unwrap()).join("bundle.rs");
    std::fs::write(out, bundle).unwrap();
}
