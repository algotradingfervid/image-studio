//! Persistent diagnostics log: `~/Library/Logs/Image Studio/app.log` (Console.app
//! shows it), rotated at 5 MB to `app.log.1` … `app.log.3`. Every line is also
//! echoed to stderr for `tauri dev`.
//!
//! Never log prompts, seeds, file names, keys, tokens or anything from the vault:
//! job ids, model ids, GPU types, stages, sizes and timings only.

use std::fs::{File, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

const MAX_BYTES: u64 = 5 << 20;
const KEEP: u32 = 3;

struct Sink {
    path: PathBuf,
    file: File,
    len: u64,
}

static SINK: Mutex<Option<Sink>> = Mutex::new(None);

fn open(path: &Path) -> std::io::Result<File> {
    let mut o = OpenOptions::new();
    o.create(true).append(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        o.mode(0o600);
    }
    o.open(path)
}

/// Starts logging to `dir/app.log` (later calls are ignored). Also records panics.
pub fn init(dir: &Path) {
    let path = dir.join("app.log");
    let opened = std::fs::create_dir_all(dir).and_then(|_| open(&path));
    match opened {
        Ok(file) => {
            let len = file.metadata().map(|m| m.len()).unwrap_or(0);
            let mut g = SINK.lock().unwrap();
            if g.is_none() {
                *g = Some(Sink { path, file, len });
            }
        }
        Err(e) => eprintln!("[log] couldn't open {}: {e}", path.display()),
    }
    let prev = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        write("panic", &info.to_string());
        prev(info);
    }));
}

/// The default log folder on macOS.
pub fn default_dir() -> Option<PathBuf> {
    std::env::var_os("HOME").map(|h| PathBuf::from(h).join("Library/Logs/Image Studio"))
}

fn rotate(s: &mut Sink) {
    for i in (1..KEEP).rev() {
        let _ = std::fs::rename(s.path.with_extension(format!("log.{i}")), s.path.with_extension(format!("log.{}", i + 1)));
    }
    let _ = std::fs::rename(&s.path, s.path.with_extension("log.1"));
    if let Ok(f) = open(&s.path) {
        s.file = f;
        s.len = 0;
    }
}

/// One line: `<UTC time> [area] message`.
pub fn write(area: &str, msg: &str) {
    let line = format!("{} [{area}] {}\n", crate::state::now_rfc3339(), msg.replace('\n', " ⏎ "));
    eprint!("{line}");
    let mut g = SINK.lock().unwrap_or_else(|e| e.into_inner());
    if let Some(s) = g.as_mut() {
        if s.len + line.len() as u64 > MAX_BYTES {
            rotate(s);
        }
        if s.file.write_all(line.as_bytes()).is_ok() {
            s.len += line.len() as u64;
        }
    }
}

/// `alog!("pod", "stopping {}", id)`.
#[macro_export]
macro_rules! alog {
    ($area:expr, $($arg:tt)*) => { $crate::applog::write($area, &format!($($arg)*)) };
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rotates_and_keeps_three() {
        let d = tempfile::tempdir().unwrap();
        let path = d.path().join("app.log");
        let mut s = Sink { path: path.clone(), file: open(&path).unwrap(), len: 0 };
        for i in 0..5 {
            s.file.write_all(format!("gen {i}\n").as_bytes()).unwrap();
            rotate(&mut s);
        }
        assert!(path.with_extension("log.1").exists());
        assert!(path.with_extension("log.3").exists());
        assert!(!path.with_extension("log.4").exists());
        assert_eq!(std::fs::read_to_string(path.with_extension("log.1")).unwrap(), "gen 4\n");
    }
}
