//! Браузеры на Chromium: Chrome, Edge, Яндекс Браузер, Brave, Vivaldi, Chromium.
//!
//! 1. Регистрация ускорителя (native messaging): манифест с allowed_origins
//!    и, на Windows, ключ в HKCU у каждого браузера.
//! 2. Обновление распакованного расширения. Chrome ставит обновления только
//!    из своего магазина, а расширение, загруженное из папки, при перезапуске
//!    перечитывает с диска. Ускоритель находит эту папку в настройках
//!    браузера и пишет туда новую версию. Пишет только в папку, где лежит
//!    наше расширение (тот же ключ в manifest.json), и удаляет только файлы
//!    прошлой версии по её списку (files.json) — ничего чужого.

use crate::install::{data_dir, Result};
use crate::HOST_NAME;
use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::fs;
use std::path::{Path, PathBuf};

/// Открытый ключ расширения для Chrome (scripts/make-chrome-key.mjs): по нему ID.
const CHROME_KEY_FILE: &str = include_str!("../../chrome/key.txt");
/// Список файлов версии расширения (scripts/build-chrome.mjs).
const FILE_LIST: &str = "files.json";

pub fn chrome_key() -> &'static str {
    CHROME_KEY_FILE.trim()
}

/// ID расширения так, как его считает Chrome: SHA-256 ключа, 32 знака a–p.
pub fn chrome_extension_id() -> String {
    let der = BASE64.decode(chrome_key()).unwrap_or_default();
    Sha256::digest(der)
        .iter()
        .take(16)
        .flat_map(|byte| [byte >> 4, byte & 0x0f])
        .map(|nibble| char::from(b'a' + nibble))
        .collect()
}

pub fn chrome_origin() -> String {
    format!("chrome-extension://{}/", chrome_extension_id())
}

/// Манифест native messaging для браузеров на Chromium.
pub fn manifest(exe: &Path) -> String {
    serde_json::to_string_pretty(&json!({
        "name": HOST_NAME,
        "description": "Ускоритель озвучки PDF-читалки (TeraTTS)",
        "path": exe,
        "type": "stdio",
        "allowed_origins": [chrome_origin()],
    }))
    .unwrap_or_default()
}

fn env_dir(name: &str) -> Option<PathBuf> {
    std::env::var_os(name).map(PathBuf::from).filter(|path| path.is_absolute())
}

#[cfg(windows)]
const VENDORS: [&str; 6] = [
    r"Google\Chrome",
    "Chromium",
    r"Microsoft\Edge",
    r"Yandex\YandexBrowser",
    r"BraveSoftware\Brave-Browser",
    "Vivaldi",
];

#[cfg(windows)]
fn host_key(vendor: &str) -> String {
    format!(r"Software\{vendor}\NativeMessagingHosts\{HOST_NAME}")
}

#[cfg(all(unix, not(target_os = "macos")))]
const CONFIG_DIRS: [&str; 8] = [
    "google-chrome",
    "google-chrome-beta",
    "google-chrome-unstable",
    "chromium",
    "microsoft-edge",
    "BraveSoftware/Brave-Browser",
    "yandex-browser",
    "vivaldi",
];

/// Папки данных браузеров (User Data): в них профили, а на Linux — и манифесты.
/// PDF_TTS_BROWSER_DIRS — свои папки через разделитель путей (для проверок).
pub fn user_data_dirs() -> Vec<PathBuf> {
    let mut dirs = Vec::new();
    #[cfg(windows)]
    {
        if let Some(local) = env_dir("LOCALAPPDATA") {
            dirs.extend(VENDORS.iter().map(|vendor| local.join(vendor).join("User Data")));
        }
        if let Some(roaming) = env_dir("APPDATA") {
            dirs.push(roaming.join("Opera Software").join("Opera Stable"));
        }
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        let config = env_dir("XDG_CONFIG_HOME").or_else(|| env_dir("HOME").map(|home| home.join(".config")));
        if let Some(config) = config {
            dirs.extend(CONFIG_DIRS.iter().map(|dir| config.join(dir)));
        }
    }
    if let Some(extra) = std::env::var_os("PDF_TTS_BROWSER_DIRS") {
        dirs.extend(std::env::split_paths(&extra).filter(|path| path.is_absolute()));
    }
    dirs
}

/// Куда кладётся манифест на Windows (путь к нему — в реестре).
#[cfg(windows)]
fn manifest_file() -> PathBuf {
    data_dir().join(format!("{HOST_NAME}.chrome.json"))
}

/// Манифесты на Linux: в папке каждого установленного браузера.
#[cfg(not(windows))]
fn manifest_files() -> Vec<PathBuf> {
    user_data_dirs()
        .into_iter()
        .filter(|dir| dir.is_dir())
        .map(|dir| dir.join("NativeMessagingHosts").join(format!("{HOST_NAME}.json")))
        .collect()
}

fn write(path: &Path, text: &str) -> Result<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| format!("{}: {error}", parent.display()))?;
    }
    if fs::read_to_string(path).is_ok_and(|current| current == text) {
        return Ok(());
    }
    fs::write(path, text).map_err(|error| format!("{}: {error}", path.display()))
}

/// Зарегистрировать ускоритель для браузеров на Chromium.
pub fn register(exe: &Path) -> Result<()> {
    let text = manifest(exe);
    #[cfg(windows)]
    {
        use winreg::enums::HKEY_CURRENT_USER;
        let file = manifest_file();
        write(&file, &text)?;
        let user = winreg::RegKey::predef(HKEY_CURRENT_USER);
        for vendor in VENDORS {
            let key = host_key(vendor);
            let (host, _) = user.create_subkey(&key).map_err(|error| format!("{key}: {error}"))?;
            host.set_value("", &file.as_os_str()).map_err(|error| format!("{key}: {error}"))?;
        }
    }
    #[cfg(not(windows))]
    for file in manifest_files() {
        write(&file, &text)?;
    }
    Ok(())
}

/// Зарегистрирован ли (во всех браузерах, где должен).
pub fn registered(exe: &Path) -> bool {
    let text = manifest(exe);
    #[cfg(windows)]
    {
        use winreg::enums::HKEY_CURRENT_USER;
        let user = winreg::RegKey::predef(HKEY_CURRENT_USER);
        fs::read_to_string(manifest_file()).is_ok_and(|current| current == text) && VENDORS.iter().all(|vendor| user.open_subkey(host_key(vendor)).is_ok())
    }
    #[cfg(not(windows))]
    {
        manifest_files()
            .iter()
            .all(|file| fs::read_to_string(file).is_ok_and(|current| current == text))
    }
}

pub fn unregister() {
    #[cfg(windows)]
    {
        use winreg::enums::HKEY_CURRENT_USER;
        let user = winreg::RegKey::predef(HKEY_CURRENT_USER);
        for vendor in VENDORS {
            let _ = user.delete_subkey_all(host_key(vendor));
        }
        let _ = fs::remove_file(manifest_file());
    }
    #[cfg(not(windows))]
    for file in manifest_files() {
        let _ = fs::remove_file(file);
    }
}

// ── Обновление распакованного расширения ─────────────────────────────────

fn read_json(path: &Path) -> Option<Value> {
    serde_json::from_slice(&fs::read(path).ok()?).ok()
}

/// Файлы настроек профилей: «Default», «Profile 1»… и сама папка (Opera).
fn profile_prefs(root: &Path) -> Vec<PathBuf> {
    let mut dirs = vec![root.to_path_buf()];
    dirs.extend(
        fs::read_dir(root)
            .into_iter()
            .flatten()
            .flatten()
            .map(|entry| entry.path())
            .filter(|path| path.is_dir()),
    );
    dirs.iter()
        .flat_map(|dir| ["Secure Preferences", "Preferences"].map(|name| dir.join(name)))
        .filter(|file| file.is_file())
        .collect()
}

/// Папка распакованного расширения из настроек профиля (у установленного из
/// магазина путь не полный — такое обновляет сам магазин).
pub fn unpacked_path(prefs: &Value, id: &str) -> Option<PathBuf> {
    let path = PathBuf::from(prefs.pointer(&format!("/extensions/settings/{id}/path"))?.as_str()?);
    path.is_absolute().then_some(path)
}

/// В папке — наше расширение: тот же ключ в manifest.json.
pub fn is_our_extension(dir: &Path) -> bool {
    read_json(&dir.join("manifest.json"))
        .and_then(|manifest| manifest.get("key").and_then(Value::as_str).map(|key| key.trim() == chrome_key()))
        .unwrap_or(false)
}

pub fn extension_version(dir: &Path) -> Option<String> {
    read_json(&dir.join("manifest.json"))?.get("version")?.as_str().map(str::to_string)
}

/// Папки, откуда браузеры загрузили наше распакованное расширение.
pub fn extension_dirs() -> Vec<PathBuf> {
    let id = chrome_extension_id();
    let mut found: Vec<PathBuf> = Vec::new();
    for root in user_data_dirs().into_iter().filter(|root| root.is_dir()) {
        for prefs in profile_prefs(&root) {
            let Some(path) = read_json(&prefs).and_then(|value| unpacked_path(&value, &id)) else {
                continue;
            };
            if is_our_extension(&path) && !found.contains(&path) {
                found.push(path);
            }
        }
    }
    found
}

/// Имя файла из обновления — путь внутри папки расширения, без выходов наружу.
pub fn safe_relative(name: &str) -> Option<PathBuf> {
    if name.is_empty() || name.starts_with('/') || name.contains(['\\', ':', '\0']) {
        return None;
    }
    let mut path = PathBuf::new();
    for part in name.split('/') {
        if part.is_empty() || part == "." || part == ".." {
            return None;
        }
        path.push(part);
    }
    Some(path)
}

/// Папка, куда собирается новая версия до установки.
pub fn staging_dir(version: &str) -> Result<PathBuf> {
    if version.is_empty() || !version.chars().all(|char| char.is_ascii_digit() || char == '.') {
        return Err(format!("странная версия {version}"));
    }
    Ok(data_dir().join("chrome-update").join(version))
}

pub fn clean_staging() {
    let _ = fs::remove_dir_all(data_dir().join("chrome-update"));
}

/// Поставить собранную версию в папку расширения. manifest.json — последним:
/// если запись оборвётся, версия в нём старая, и обновление повторится.
/// Поставить файл на место. На Windows файл бывает ненадолго занят
/// (браузер читает его, антивирус проверяет) — тогда несколько попыток.
fn replace(temporary: &Path, to: &Path) -> Result<()> {
    let mut attempt = 0;
    loop {
        match fs::rename(temporary, to) {
            Ok(()) => return Ok(()),
            Err(_) if attempt < 20 => {
                attempt += 1;
                std::thread::sleep(std::time::Duration::from_millis(150));
            }
            Err(error) => {
                let _ = fs::remove_file(temporary);
                return Err(format!("{}: {error}", to.display()));
            }
        }
    }
}

pub fn apply(staging: &Path, target: &Path, files: &[String]) -> Result<()> {
    if !is_our_extension(target) {
        return Err(format!("{}: здесь не PDF-читалка", target.display()));
    }
    let mut new = files
        .iter()
        .map(|name| safe_relative(name).ok_or_else(|| format!("недопустимое имя файла {name}")))
        .collect::<Result<Vec<_>>>()?;
    if let Some(missing) = new.iter().find(|file| !staging.join(file).is_file()) {
        return Err(format!("в обновлении нет файла {}", missing.display()));
    }
    let last = |file: &PathBuf| [Path::new("manifest.json"), Path::new(FILE_LIST)].contains(&file.as_path());
    new.sort_by_key(|file| (last(file), file.clone()));
    let old: Vec<PathBuf> = read_json(&target.join(FILE_LIST))
        .and_then(|list| list.get("files")?.as_array().cloned())
        .unwrap_or_default()
        .iter()
        .filter_map(Value::as_str)
        .filter_map(safe_relative)
        .collect();
    for file in &new {
        let to = target.join(file);
        if let Some(parent) = to.parent() {
            fs::create_dir_all(parent).map_err(|error| format!("{}: {error}", parent.display()))?;
        }
        let temporary = to.with_file_name(format!("{}.pdf-reader-update", to.file_name().unwrap_or_default().to_string_lossy()));
        fs::copy(staging.join(file), &temporary).map_err(|error| format!("{}: {error}", temporary.display()))?;
        replace(&temporary, &to)?;
    }
    for file in old.iter().filter(|file| !new.contains(file)) {
        let _ = fs::remove_file(target.join(file));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn id_from_key_is_32_letters_a_to_p() {
        let id = chrome_extension_id();
        assert_eq!(id.len(), 32);
        assert!(id.chars().all(|char| ('a'..='p').contains(&char)));
        assert!(manifest(Path::new("/x/pdf-reader-tts")).contains(&format!("chrome-extension://{id}/")));
    }

    #[test]
    fn names_stay_inside_the_folder() {
        assert_eq!(safe_relative("src/tts/a.js"), Some(PathBuf::from("src").join("tts").join("a.js")));
        for bad in ["", "/etc/passwd", "../x", "a/../../x", "a\\b", "C:/x", "a//b", "./a"] {
            assert_eq!(safe_relative(bad), None, "{bad}");
        }
    }

    #[test]
    fn unpacked_path_only_absolute() {
        let id = "abc";
        // Абсолютный путь на этой системе: на Windows — с буквой диска.
        let absolute = std::env::temp_dir().join("PDF");
        let prefs = json!({ "extensions": { "settings": { "abc": { "path": absolute }, "def": { "path": "def/1.0_0" } } } });
        assert_eq!(unpacked_path(&prefs, id), Some(absolute));
        assert_eq!(unpacked_path(&prefs, "def"), None);
        assert_eq!(unpacked_path(&prefs, "nope"), None);
    }

    fn folder(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("pdf-reader-browsers-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn apply_replaces_our_files_and_keeps_foreign_ones() {
        let target = folder("target");
        let staging = folder("staging");
        let manifest = |version: &str| json!({ "version": version, "key": chrome_key() }).to_string();
        fs::write(target.join("manifest.json"), manifest("1.0")).unwrap();
        fs::write(target.join("old.js"), "старый").unwrap();
        fs::write(target.join("same.js"), "1").unwrap();
        fs::write(target.join("чужой.txt"), "не трогать").unwrap();
        fs::write(
            target.join(FILE_LIST),
            json!({ "files": ["manifest.json", "old.js", "same.js", FILE_LIST] }).to_string(),
        )
        .unwrap();
        fs::create_dir_all(staging.join("src")).unwrap();
        fs::write(staging.join("manifest.json"), manifest("2.0")).unwrap();
        fs::write(staging.join("same.js"), "2").unwrap();
        fs::write(staging.join("src").join("new.js"), "новый").unwrap();
        fs::write(
            staging.join(FILE_LIST),
            json!({ "files": ["manifest.json", "same.js", "src/new.js", FILE_LIST] }).to_string(),
        )
        .unwrap();
        let files: Vec<String> = ["manifest.json", "same.js", "src/new.js", FILE_LIST].map(String::from).to_vec();
        apply(&staging, &target, &files).unwrap();
        assert_eq!(extension_version(&target).as_deref(), Some("2.0"));
        assert_eq!(fs::read_to_string(target.join("same.js")).unwrap(), "2");
        assert_eq!(fs::read_to_string(target.join("src").join("new.js")).unwrap(), "новый");
        assert!(!target.join("old.js").exists(), "файл прошлой версии убран");
        assert_eq!(fs::read_to_string(target.join("чужой.txt")).unwrap(), "не трогать");

        // Чужая папка (другой ключ) — не трогаем.
        fs::write(target.join("manifest.json"), json!({ "version": "3", "key": "другой" }).to_string()).unwrap();
        assert!(apply(&staging, &target, &files).is_err());
        let _ = fs::remove_dir_all(&target);
        let _ = fs::remove_dir_all(&staging);
    }
}
