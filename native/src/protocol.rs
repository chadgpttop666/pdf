//! Протокол native messaging: каждое сообщение — длина (4 байта, порядок
//! байтов машины) и JSON. От программы к браузеру — не больше 1 МБ.

use serde_json::Value;
use std::io::{self, ErrorKind, Read, Write};
use std::sync::Mutex;

pub const MAX_OUTGOING: usize = 1024 * 1024;

/// Следующее сообщение; `None` — браузер закрыл канал.
pub fn read(input: &mut impl Read) -> io::Result<Option<Value>> {
    let mut length = [0u8; 4];
    match input.read_exact(&mut length) {
        Ok(()) => {}
        Err(error) if error.kind() == ErrorKind::UnexpectedEof => return Ok(None),
        Err(error) => return Err(error),
    }
    let mut buffer = vec![0u8; u32::from_ne_bytes(length) as usize];
    input.read_exact(&mut buffer)?;
    serde_json::from_slice(&buffer)
        .map(Some)
        .map_err(|error| io::Error::new(ErrorKind::InvalidData, error))
}

pub fn write(output: &mut impl Write, message: &Value) -> io::Result<()> {
    let bytes = serde_json::to_vec(message)?;
    if bytes.len() > MAX_OUTGOING {
        return Err(io::Error::new(ErrorKind::InvalidInput, "сообщение больше 1 МБ"));
    }
    output.write_all(&(bytes.len() as u32).to_ne_bytes())?;
    output.write_all(&bytes)?;
    output.flush()
}

/// Ответы из разных потоков — по одному, целиком.
pub struct Outbox<W: Write> {
    output: Mutex<W>,
}

impl<W: Write> Outbox<W> {
    pub fn new(output: W) -> Self {
        Self { output: Mutex::new(output) }
    }

    pub fn send(&self, message: Value) {
        let mut output = self.output.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        // Браузер закрыл канал — работать больше не для кого.
        if let Err(error) = write(&mut *output, &message) {
            if error.kind() == ErrorKind::InvalidInput {
                eprintln!("pdf-reader-tts: {error}");
            } else {
                std::process::exit(0);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn round_trip() {
        let mut bytes = Vec::new();
        write(&mut bytes, &json!({ "type": "hello", "text": "привет" })).unwrap();
        write(&mut bytes, &json!([1, 2, 3])).unwrap();
        assert_eq!(
            u32::from_ne_bytes(bytes[..4].try_into().unwrap()) as usize,
            r#"{"text":"привет","type":"hello"}"#.len()
        );
        let mut input = bytes.as_slice();
        assert_eq!(read(&mut input).unwrap(), Some(json!({ "type": "hello", "text": "привет" })));
        assert_eq!(read(&mut input).unwrap(), Some(json!([1, 2, 3])));
        assert_eq!(read(&mut input).unwrap(), None);
    }

    #[test]
    fn refuses_oversized() {
        let mut bytes = Vec::new();
        let big = "x".repeat(MAX_OUTGOING);
        assert!(write(&mut bytes, &json!({ "data": big })).is_err());
        assert!(bytes.is_empty());
    }
}
