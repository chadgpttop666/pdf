// Кнопки наушников во время примечания (Windows). До браузера кнопка
// «громче» не доходит вовсе — её забирает система, а «следующий трек» — не
// всегда. Ускоритель на время примечания:
//
// - занимает клавиши «громче» и «следующий трек» (RegisterHotKey): нажатие
//   приходит сюда, а не системе, — громкость не меняется;
// - следит за громкостью системы: у Bluetooth-наушников с «абсолютной
//   громкостью» кнопка меняет её напрямую, без клавиши. Прибавили — это
//   нажатие, и громкость возвращается как была. Убавлять можно.
//
// О нажатии расширение узнаёт сообщением { type: "event", event: "media-key",
// key: "volume-up" | "next" }. Вне примечаний ничего не перехватывается:
// расширение включает перехват на время примечания и сразу выключает.

use serde_json::Value;

/// Куда сообщать о нажатии: "volume-up" или "next".
pub type Emit = Box<dyn Fn(&'static str) + Send + 'static>;

/// Ловит ли ускоритель кнопки на этой системе.
pub fn supported() -> bool {
    cfg!(windows)
}

/// Включить или выключить перехват. emit — только при первом вызове.
/// Ответ: { type: "media-watch", on, hotkeys: [...], volume: bool } —
/// какие клавиши заняты и следит ли он за громкостью.
#[cfg(windows)]
pub fn watch(on: bool, emit: impl FnOnce() -> Emit) -> Result<Value, String> {
    imp::watch(on, emit)
}

#[cfg(not(windows))]
pub fn watch(_on: bool, _emit: impl FnOnce() -> Emit) -> Result<Value, String> {
    Err("Кнопки наушников ускоритель ловит только в Windows".into())
}

#[cfg(windows)]
mod imp {
    use super::Emit;
    use serde_json::{json, Value};
    use std::sync::mpsc::{self, Receiver, Sender};
    use std::sync::{Mutex, OnceLock};
    use std::time::{Duration, Instant};
    use windows::Win32::Foundation::{LPARAM, WPARAM};
    use windows::Win32::Media::Audio::Endpoints::IAudioEndpointVolume;
    use windows::Win32::Media::Audio::{eConsole, eRender, IMMDeviceEnumerator, MMDeviceEnumerator};
    use windows::Win32::System::Com::{CoCreateInstance, CoInitializeEx, CLSCTX_ALL, COINIT_APARTMENTTHREADED};
    use windows::Win32::System::Threading::GetCurrentThreadId;
    use windows::Win32::UI::Input::KeyboardAndMouse::{RegisterHotKey, UnregisterHotKey, MOD_NOREPEAT, VIRTUAL_KEY, VK_MEDIA_NEXT_TRACK, VK_VOLUME_UP};
    use windows::Win32::UI::WindowsAndMessaging::{
        GetMessageW, KillTimer, PeekMessageW, PostThreadMessageW, SetTimer, MSG, PM_NOREMOVE, WM_APP, WM_HOTKEY, WM_TIMER, WM_USER,
    };

    /// Номер клавиши для RegisterHotKey, клавиша и что сообщить.
    const HOTKEYS: [(i32, VIRTUAL_KEY, &str); 2] = [(1, VK_VOLUME_UP, "volume-up"), (2, VK_MEDIA_NEXT_TRACK, "next")];
    /// Как часто смотреть на громкость системы.
    const TICK_MS: u32 = 50;
    /// Одно нажатие — одно сообщение: клавиша и громкость могли сработать обе.
    const DEBOUNCE: Duration = Duration::from_millis(400);
    /// Прибавку меньше этой не считаем: округления драйвера.
    const VOLUME_STEP: f32 = 0.004;

    struct Command {
        on: bool,
        reply: Sender<Value>,
    }

    struct Worker {
        thread: u32,
        commands: Mutex<Sender<Command>>,
    }

    static WORKER: OnceLock<Result<Worker, String>> = OnceLock::new();

    pub fn watch(on: bool, emit: impl FnOnce() -> Emit) -> Result<Value, String> {
        let worker = WORKER.get_or_init(|| start(emit())).as_ref().map_err(Clone::clone)?;
        let (reply, answer) = mpsc::channel();
        worker
            .commands
            .lock()
            .map_err(|_| "поток кнопок упал".to_string())?
            .send(Command { on, reply })
            .map_err(|_| "поток кнопок остановился".to_string())?;
        // Разбудить поток: он ждёт сообщений Windows, а не канала.
        unsafe { PostThreadMessageW(worker.thread, WM_APP, WPARAM(0), LPARAM(0)) }.map_err(|error| error.to_string())?;
        answer.recv_timeout(Duration::from_secs(2)).map_err(|_| "поток кнопок не ответил".to_string())
    }

    fn start(emit: Emit) -> Result<Worker, String> {
        let (commands, inbox) = mpsc::channel();
        let (ready, started) = mpsc::channel();
        std::thread::spawn(move || run(inbox, emit, ready));
        let thread = started
            .recv_timeout(Duration::from_secs(2))
            .map_err(|_| "поток кнопок не запустился".to_string())?;
        Ok(Worker {
            thread,
            commands: Mutex::new(commands),
        })
    }

    #[derive(Default)]
    struct State {
        hotkeys: Vec<&'static str>,
        /// Громкость системы и сколько было, когда начали следить.
        volume: Option<(IAudioEndpointVolume, f32)>,
        timer: usize,
        last: Option<Instant>,
    }

    impl State {
        fn start(&mut self) -> Value {
            self.stop();
            for (id, key, name) in HOTKEYS {
                // Занята другой программой — остаётся громкость.
                if unsafe { RegisterHotKey(None, id, MOD_NOREPEAT, u32::from(key.0)) }.is_ok() {
                    self.hotkeys.push(name);
                }
            }
            // Устройство берём каждый раз заново: наушники могли подключить только что.
            self.volume = endpoint().and_then(|volume| {
                let level = unsafe { volume.GetMasterVolumeLevelScalar() }.ok()?;
                Some((volume, level))
            });
            if self.volume.is_some() {
                self.timer = unsafe { SetTimer(None, 0, TICK_MS, None) };
            }
            json!({ "type": "media-watch", "on": true, "hotkeys": self.hotkeys, "volume": self.volume.is_some() })
        }

        fn stop(&mut self) -> Value {
            for (id, ..) in HOTKEYS {
                let _ = unsafe { UnregisterHotKey(None, id) };
            }
            self.hotkeys.clear();
            if self.timer != 0 {
                let _ = unsafe { KillTimer(None, self.timer) };
                self.timer = 0;
            }
            self.volume = None;
            json!({ "type": "media-watch", "on": false })
        }

        /// Громкость прибавили — вернуть как было и сказать «да». Убавили — так и оставить.
        fn volume_rose(&mut self) -> bool {
            let Some((volume, base)) = &mut self.volume else { return false };
            let Ok(level) = (unsafe { volume.GetMasterVolumeLevelScalar() }) else {
                return false;
            };
            if level > *base + VOLUME_STEP {
                let _ = unsafe { volume.SetMasterVolumeLevelScalar(*base, std::ptr::null()) };
                return true;
            }
            *base = level;
            false
        }

        fn fire(&mut self, emit: &Emit, key: &'static str) {
            if self.last.is_some_and(|at| at.elapsed() < DEBOUNCE) {
                return;
            }
            self.last = Some(Instant::now());
            emit(key);
        }
    }

    /// Громкость устройства вывода по умолчанию.
    fn endpoint() -> Option<IAudioEndpointVolume> {
        unsafe {
            let devices: IMMDeviceEnumerator = CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL).ok()?;
            let device = devices.GetDefaultAudioEndpoint(eRender, eConsole).ok()?;
            device.Activate(CLSCTX_ALL, None).ok()
        }
    }

    fn run(inbox: Receiver<Command>, emit: Emit, ready: Sender<u32>) {
        let mut message = MSG::default();
        unsafe {
            // Очередь сообщений у потока появляется с первым обращением к ней.
            let _ = PeekMessageW(&mut message, None, WM_USER, WM_USER, PM_NOREMOVE);
            let _ = CoInitializeEx(None, COINIT_APARTMENTTHREADED);
            let _ = ready.send(GetCurrentThreadId());
        }
        let mut state = State::default();
        // 0 — поток закрывают, −1 — ошибка: в обоих случаях выходим.
        while unsafe { GetMessageW(&mut message, None, 0, 0) }.0 > 0 {
            match message.message {
                WM_APP => {
                    while let Ok(command) = inbox.try_recv() {
                        let reply = if command.on { state.start() } else { state.stop() };
                        let _ = command.reply.send(reply);
                    }
                }
                WM_HOTKEY => {
                    if let Some((.., name)) = HOTKEYS.iter().find(|(id, ..)| *id as usize == message.wParam.0) {
                        state.fire(&emit, name);
                    }
                }
                WM_TIMER if state.volume_rose() => state.fire(&emit, "volume-up"),
                _ => {}
            }
        }
    }
}
