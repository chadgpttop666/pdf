//! Установка без прав администратора: программа копирует себя в папку
//! пользователя, кладёт рядом ONNX Runtime и регистрируется для Firefox
//! (манифест native messaging и, на Windows, ключ в HKCU). Удаление — всё
//! обратно.

#[cfg(windows)]
use crate::VERSION;
use crate::{EXTENSION_ID, HOST_NAME};
use std::fs;
use std::io;
use std::path::{Path, PathBuf};

#[cfg(windows)]
const EXE_NAME: &str = "pdf-reader-tts.exe";
#[cfg(not(windows))]
const EXE_NAME: &str = "pdf-reader-tts";

#[cfg(windows)]
const UNINSTALL_KEY: &str = r"Software\Microsoft\Windows\CurrentVersion\Uninstall\PdfReaderTTS";
#[cfg(windows)]
const HOST_KEY: &str = r"Software\Mozilla\NativeMessagingHosts\pdf_reader_tts";

pub type Result<T> = std::result::Result<T, String>;

fn context<T>(result: io::Result<T>, what: impl std::fmt::Display) -> Result<T> {
    result.map_err(|error| format!("{what}: {error}"))
}

/// Папка из переменной окружения — если она задана и путь полный.
fn env_dir(name: &str) -> Option<PathBuf> {
    std::env::var_os(name).map(PathBuf::from).filter(|path| path.is_absolute())
}

fn home() -> PathBuf {
    env_dir("HOME").or_else(|| env_dir("USERPROFILE")).unwrap_or_else(|| PathBuf::from("."))
}

/// Папка помощника: программа, ONNX Runtime, модели.
pub fn data_dir() -> PathBuf {
    #[cfg(windows)]
    {
        let base = env_dir("LOCALAPPDATA").unwrap_or_else(|| home().join("AppData").join("Local"));
        base.join("PdfReaderTTS")
    }
    #[cfg(target_os = "macos")]
    {
        home().join("Library/Application Support/PdfReaderTTS")
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        let base = env_dir("XDG_DATA_HOME").unwrap_or_else(|| home().join(".local/share"));
        base.join("pdf-reader-tts")
    }
}

pub fn models_dir() -> PathBuf {
    data_dir().join("models")
}

pub fn installed_exe() -> PathBuf {
    data_dir().join(EXE_NAME)
}

/// Куда Firefox смотрит за манифестом (на Windows — путь из реестра).
fn manifest_path() -> PathBuf {
    #[cfg(windows)]
    {
        data_dir().join(format!("{HOST_NAME}.json"))
    }
    #[cfg(target_os = "macos")]
    {
        home().join(format!("Library/Application Support/Mozilla/NativeMessagingHosts/{HOST_NAME}.json"))
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        home().join(format!(".mozilla/native-messaging-hosts/{HOST_NAME}.json"))
    }
}

// ── ONNX Runtime ─────────────────────────────────────────────────────────

#[cfg(embedded_ort)]
const ORT_BYTES: &[u8] = include_bytes!(env!("PDF_TTS_ORT_FILE"));
// Файлы, которые ONNX Runtime ищет рядом с программой (build.rs, PDF_TTS_EXTRA_LIBS).
#[cfg(embedded_ort)]
include!(concat!(env!("OUT_DIR"), "/bundle.rs"));

#[cfg(all(embedded_ort, windows))]
fn ort_file_name() -> String {
    format!("onnxruntime-{}.dll", env!("PDF_TTS_ORT_TAG"))
}
#[cfg(all(embedded_ort, target_os = "macos"))]
fn ort_file_name() -> String {
    format!("libonnxruntime-{}.dylib", env!("PDF_TTS_ORT_TAG"))
}
#[cfg(all(embedded_ort, unix, not(target_os = "macos")))]
fn ort_file_name() -> String {
    format!("libonnxruntime-{}.so", env!("PDF_TTS_ORT_TAG"))
}

/// Библиотека ONNX Runtime: ORT_DYLIB_PATH, вшитая (кладётся в папку
/// помощника, если её там ещё нет) или лежащая рядом с программой.
pub fn ort_library() -> Result<PathBuf> {
    if let Some(path) = std::env::var_os("ORT_DYLIB_PATH") {
        return Ok(PathBuf::from(path));
    }
    #[cfg(embedded_ort)]
    {
        let dir = data_dir();
        context(fs::create_dir_all(&dir), dir.display())?;
        for (name, bytes) in EXTRA_LIBS {
            // Занят другой копией помощника — значит, уже на месте.
            let _ = write_if_changed(&dir.join(name), bytes);
        }
        let path = dir.join(ort_file_name());
        write_if_changed(&path, ORT_BYTES)?;
        Ok(path)
    }
    #[cfg(not(embedded_ort))]
    {
        let dir = std::env::current_exe()
            .ok()
            .and_then(|exe| exe.parent().map(Path::to_path_buf))
            .unwrap_or_default();
        let name = if cfg!(windows) {
            "onnxruntime.dll"
        } else if cfg!(target_os = "macos") {
            "libonnxruntime.dylib"
        } else {
            "libonnxruntime.so"
        };
        Ok(dir.join(name))
    }
}

/// Остатки прошлых версий (программа до обновления, старые библиотеки) и
/// прерванных передач.
pub fn clean_leftovers() {
    let dir = data_dir();
    let _ = fs::remove_file(dir.join(format!("{EXE_NAME}.old")));
    let day = std::time::Duration::from_secs(24 * 60 * 60);
    for folder in [dir.clone(), models_dir()] {
        for entry in fs::read_dir(folder).into_iter().flatten().flatten() {
            let stale = entry
                .metadata()
                .and_then(|meta| meta.modified())
                .ok()
                .and_then(|time| time.elapsed().ok())
                .is_some_and(|age| age > day);
            if stale && entry.file_name().to_string_lossy().ends_with(".part") {
                let _ = fs::remove_file(entry.path());
            }
        }
    }
    #[cfg(embedded_ort)]
    if let Ok(entries) = fs::read_dir(&dir) {
        let current = ort_file_name();
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().into_owned();
            if name.contains("onnxruntime-") && name != current {
                // Занята другой копией помощника — уберётся в другой раз.
                let _ = fs::remove_file(entry.path());
            }
        }
    }
}

#[cfg(embedded_ort)]
fn write_if_changed(path: &Path, bytes: &[u8]) -> Result<()> {
    if fs::metadata(path).map(|meta| meta.len() as usize).ok() == Some(bytes.len()) {
        return Ok(());
    }
    write_atomically(path, bytes)
}

fn write_atomically(path: &Path, bytes: &[u8]) -> Result<()> {
    let temporary = path.with_extension("tmp");
    context(fs::write(&temporary, bytes), temporary.display())?;
    context(fs::rename(&temporary, path), path.display())
}

// ── Установка ────────────────────────────────────────────────────────────

/// Поставить на место `installed_exe()` новую программу. Работающую на
/// Windows удалить нельзя, но можно переименовать — её место освобождается,
/// а сама она убирается при следующем запуске (`clean_leftovers`).
pub fn replace_exe(source: &Path) -> Result<()> {
    let target = installed_exe();
    if same_file(source, &target) {
        return Ok(());
    }
    let staged = target.with_extension("new");
    context(fs::copy(source, &staged), staged.display())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        context(fs::set_permissions(&staged, fs::Permissions::from_mode(0o755)), staged.display())?;
    }
    #[cfg(windows)]
    if target.exists() && fs::remove_file(&target).is_err() {
        let old = PathBuf::from(format!("{}.old", target.display()));
        let _ = fs::remove_file(&old);
        context(fs::rename(&target, &old), target.display())?;
    }
    context(fs::rename(&staged, &target), target.display())
}

fn same_file(a: &Path, b: &Path) -> bool {
    match (fs::canonicalize(a), fs::canonicalize(b)) {
        (Ok(a), Ok(b)) => a == b,
        _ => false,
    }
}

fn manifest(exe: &Path) -> String {
    serde_json::to_string_pretty(&serde_json::json!({
        "name": HOST_NAME,
        "description": "Ускоритель озвучки PDF-читалки (TeraTTS)",
        "path": exe,
        "type": "stdio",
        "allowed_extensions": [EXTENSION_ID],
    }))
    .unwrap_or_default()
}

/// Установить себя. Повторная установка — то же самое (обновление на месте).
pub fn install() -> Result<PathBuf> {
    let dir = data_dir();
    context(fs::create_dir_all(&dir), dir.display())?;
    let current = context(std::env::current_exe(), "путь к программе")?;
    replace_exe(&current)?;
    let exe = installed_exe();
    ort_library()?;
    clean_leftovers();
    let manifest_file = manifest_path();
    if let Some(parent) = manifest_file.parent() {
        context(fs::create_dir_all(parent), parent.display())?;
    }
    write_atomically(&manifest_file, manifest(&exe).as_bytes())?;
    register(&manifest_file, &exe)?;
    Ok(dir)
}

#[cfg(windows)]
fn register(manifest_file: &Path, exe: &Path) -> Result<()> {
    use winreg::enums::HKEY_CURRENT_USER;
    use winreg::RegKey;
    let user = RegKey::predef(HKEY_CURRENT_USER);
    let (host, _) = context(user.create_subkey(HOST_KEY), HOST_KEY)?;
    context(host.set_value("", &manifest_file.as_os_str()), HOST_KEY)?;
    // Запись в «Приложения и возможности»: удалить можно и оттуда.
    let (entry, _) = context(user.create_subkey(UNINSTALL_KEY), UNINSTALL_KEY)?;
    let size_kb = fs::read_dir(data_dir())
        .map(|entries| entries.flatten().filter_map(|entry| entry.metadata().ok()).map(|meta| meta.len()).sum::<u64>() / 1024)
        .unwrap_or(0) as u32;
    let quoted = format!("\"{}\"", exe.display());
    for (name, value) in [
        ("DisplayName", "Ускоритель озвучки PDF-читалки".to_string()),
        ("DisplayVersion", VERSION.to_string()),
        ("Publisher", "PDF-читалка".to_string()),
        ("InstallLocation", data_dir().display().to_string()),
        ("DisplayIcon", exe.display().to_string()),
        ("UninstallString", format!("{quoted} --uninstall")),
        ("QuietUninstallString", format!("{quoted} --uninstall --quiet")),
    ] {
        context(entry.set_value(name, &value), name)?;
    }
    for (name, value) in [("NoModify", 1u32), ("NoRepair", 1u32), ("EstimatedSize", size_kb)] {
        context(entry.set_value(name, &value), name)?;
    }
    Ok(())
}

#[cfg(not(windows))]
fn register(_manifest_file: &Path, _exe: &Path) -> Result<()> {
    Ok(())
}

/// После самообновления — новая версия и в «Приложениях и возможностях».
pub fn refresh() {
    #[cfg(windows)]
    {
        use winreg::enums::HKEY_CURRENT_USER;
        let user = winreg::RegKey::predef(HKEY_CURRENT_USER);
        let shown: Option<String> = user.open_subkey(UNINSTALL_KEY).ok().and_then(|key| key.get_value("DisplayVersion").ok());
        if shown.is_some_and(|version| version != VERSION) {
            let _ = register(&manifest_path(), &installed_exe());
        }
    }
}

/// Установлен ли помощник (для проверок).
pub fn registered() -> bool {
    #[cfg(windows)]
    {
        use winreg::enums::HKEY_CURRENT_USER;
        winreg::RegKey::predef(HKEY_CURRENT_USER).open_subkey(HOST_KEY).is_ok()
    }
    #[cfg(not(windows))]
    {
        manifest_path().exists()
    }
}

/// Удалить всё: регистрацию, модели, программу.
pub fn uninstall() -> Result<()> {
    #[cfg(windows)]
    {
        use winreg::enums::HKEY_CURRENT_USER;
        let user = winreg::RegKey::predef(HKEY_CURRENT_USER);
        let _ = user.delete_subkey_all(HOST_KEY);
        let _ = user.delete_subkey_all(UNINSTALL_KEY);
    }
    let _ = fs::remove_file(manifest_path());
    let dir = data_dir();
    let _ = fs::remove_dir_all(dir.join("models"));
    if fs::remove_dir_all(&dir).is_err() && dir.exists() {
        remove_later(&dir);
    }
    Ok(())
}

/// Работающую программу (и загруженную ею библиотеку) Windows удалить не
/// даёт — папку уберёт отдельный процесс, когда эта программа завершится.
#[cfg(windows)]
fn remove_later(dir: &Path) {
    use std::os::windows::process::CommandExt;
    use std::process::{Command, Stdio};
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    const DETACHED_PROCESS: u32 = 0x0000_0008;
    const CREATE_BREAKAWAY_FROM_JOB: u32 = 0x0100_0000;
    let script = format!("ping -n 4 127.0.0.1 >nul & rmdir /s /q \"{}\"", dir.display());
    let spawn = |flags: u32| {
        Command::new("cmd")
            .args(["/d", "/c"])
            .raw_arg(&script)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .creation_flags(flags)
            .spawn()
    };
    // Firefox держит помощника в задании (job), которое может не отпускать
    // дочерние процессы, — тогда без выхода из него.
    if spawn(CREATE_NO_WINDOW | DETACHED_PROCESS | CREATE_BREAKAWAY_FROM_JOB).is_err() {
        let _ = spawn(CREATE_NO_WINDOW | DETACHED_PROCESS);
    }
}

#[cfg(not(windows))]
fn remove_later(_dir: &Path) {}

// ── Сообщения человеку ───────────────────────────────────────────────────

/// Окно с сообщением (на Windows программа без консоли) или строка в терминал.
pub fn tell(text: &str, error: bool) {
    #[cfg(windows)]
    {
        use windows_sys::Win32::UI::WindowsAndMessaging::{MessageBoxW, MB_ICONERROR, MB_ICONINFORMATION, MB_OK, MB_SETFOREGROUND};
        let wide = |s: &str| s.encode_utf16().chain(std::iter::once(0)).collect::<Vec<u16>>();
        let title = wide("PDF-читалка");
        let body = wide(text);
        let icon = if error { MB_ICONERROR } else { MB_ICONINFORMATION };
        unsafe {
            MessageBoxW(std::ptr::null_mut(), body.as_ptr(), title.as_ptr(), MB_OK | icon | MB_SETFOREGROUND);
        }
    }
    #[cfg(not(windows))]
    {
        if error {
            eprintln!("{text}");
        } else {
            println!("{text}");
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn manifest_names_extension_and_program() {
        let text = manifest(Path::new("/x/pdf-reader-tts"));
        let value: serde_json::Value = serde_json::from_str(&text).unwrap();
        assert_eq!(value["name"], HOST_NAME);
        assert_eq!(value["type"], "stdio");
        assert_eq!(value["path"], "/x/pdf-reader-tts");
        assert_eq!(value["allowed_extensions"][0], EXTENSION_ID);
    }
}
