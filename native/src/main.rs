// Ускоритель озвучки PDF-читалки: синтез TeraTTS вне браузера, в несколько
// раз быстрее, чем в WebAssembly.
//
// Firefox запускает программу сам (native messaging) и говорит с ней через
// stdin/stdout. Запущенная руками — двойным щелчком по скачанному файлу —
// она ставит себя: копирует в папку пользователя и регистрирует для Firefox.
// Без консоли: окно не мелькает, когда её запускает браузер.
#![cfg_attr(windows, windows_subsystem = "windows")]

mod host;
mod install;
mod noise;
mod protocol;
mod synth;

pub const EXTENSION_ID: &str = "pdf-reader@chadgpttop666.github.io";
pub const HOST_NAME: &str = "pdf_reader_tts";
pub const VERSION: &str = env!("CARGO_PKG_VERSION");
/// Версия протокола: расширение сверяет её, прежде чем говорить.
pub const PROTOCOL: u32 = 1;

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let has = |flag: &str| args.iter().any(|arg| arg == flag);
    // Firefox передаёт путь к манифесту и id расширения.
    if args.iter().any(|arg| arg == EXTENSION_ID || arg.ends_with(".json")) {
        std::process::exit(host::run());
    }
    if has("--version") {
        println!("{VERSION}");
        return;
    }
    let quiet = has("--quiet");
    let result = if has("--uninstall") {
        install::uninstall().map(|()| "Ускоритель озвучки удалён.".to_string())
    } else if has("--check") {
        // Для проверок после установки: зарегистрирован ли и грузится ли ONNX Runtime.
        let ort = install::ort_library().and_then(|path| ort::init_from(&path).map(|_| ()).map_err(|error| error.to_string()));
        match (install::registered(), ort) {
            (true, Ok(())) => Ok("Установлен, ONNX Runtime загружается".to_string()),
            (false, _) => Err("Не зарегистрирован для Firefox".to_string()),
            (_, Err(error)) => Err(format!("ONNX Runtime не загружается: {error}")),
        }
    } else {
        install::install().map(|_| "Ускоритель озвучки установлен.\n\nВернитесь в Firefox — читалка подключит его сама.".to_string())
    };
    match result {
        Ok(message) => {
            if !quiet {
                install::tell(&message, false);
            }
        }
        Err(error) => {
            if quiet {
                eprintln!("{error}");
            } else {
                install::tell(&format!("Не получилось: {error}"), true);
            }
            std::process::exit(1);
        }
    }
}
