//! ffmpeg helpers for stitching approved takes into the final story video.
//!
//! ffmpeg never gets a path to a take: every input is fed through an anonymous
//! pipe (`pipe:3`, `pipe:4`, …) and the output comes back on stdout, so no
//! plaintext of a vault story touches disk (spec §3.2). The same code path
//! serves General stories.

use std::io::{Read, Write};
use std::os::fd::{AsRawFd, FromRawFd, OwnedFd};
use std::os::unix::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{ChildStdout, Command, Stdio};

use image::ImageEncoder;

pub const FFMPEG_MISSING: &str = "Install ffmpeg (brew install ffmpeg)";

pub fn find_ffmpeg() -> Result<PathBuf, String> {
    for p in ["/opt/homebrew/bin/ffmpeg", "/usr/local/bin/ffmpeg"] {
        if Path::new(p).is_file() {
            return Ok(p.into());
        }
    }
    // GUI apps get a minimal PATH; still try it.
    Command::new("ffmpeg")
        .arg("-version")
        .output()
        .ok()
        .filter(|o| o.status.success())
        .map(|_| PathBuf::from("ffmpeg"))
        .ok_or_else(|| FFMPEG_MISSING.to_string())
}

const BASE: [&str; 4] = ["-nostdin", "-hide_banner", "-loglevel", "error"];

fn args<const N: usize>(a: [&str; N]) -> Vec<String> {
    a.iter().map(|s| s.to_string()).collect()
}

/// One anonymous pipe: the child reads `reader` (as `pipe:3+i`), a writer
/// thread feeds `writer`. Both ends are CLOEXEC so no other child spawned
/// meanwhile keeps the write end open (which would deny ffmpeg its EOF).
fn input_pipe() -> Result<(OwnedFd, OwnedFd), String> {
    let mut fds = [0i32; 2];
    // SAFETY: pipe(2) with a valid 2-int buffer; on success both fds are ours
    // and are owned by the `OwnedFd`s below (closed on every exit path).
    unsafe {
        if libc::pipe(fds.as_mut_ptr()) != 0 {
            return Err("pipe".into());
        }
        let (read, write) = (OwnedFd::from_raw_fd(fds[0]), OwnedFd::from_raw_fd(fds[1]));
        if libc::fcntl(fds[1], libc::F_SETFD, libc::FD_CLOEXEC) < 0 {
            return Err("fcntl".into());
        }
        // The read end moves to a high number so the child's dup2 targets
        // (3, 4, …) can never be one of our own fds.
        let high = libc::fcntl(fds[0], libc::F_DUPFD_CLOEXEC, 100);
        drop(read);
        if high < 0 {
            return Err("fcntl".into());
        }
        Ok((OwnedFd::from_raw_fd(high), write))
    }
}

/// Runs ffmpeg with `inputs[i]` readable as `pipe:{3+i}`; `read_out` consumes
/// its stdout and returns what to keep. Nothing touches the filesystem:
/// anonymous pipes, one writer thread per input, stderr captured for the error.
fn run_piped_with<F>(ffmpeg: &Path, args: &[String], inputs: &[&[u8]], read_out: F) -> Result<Vec<u8>, String>
where
    F: FnOnce(ChildStdout) -> Vec<u8>,
{
    let err = |what: &str| format!("Could not run ffmpeg: {what}");
    let mut readers = Vec::with_capacity(inputs.len());
    let mut writers = Vec::with_capacity(inputs.len());
    for _ in inputs {
        let (r, w) = input_pipe().map_err(|e| err(&e))?;
        readers.push(r);
        writers.push(w);
    }
    let mut cmd = Command::new(ffmpeg);
    cmd.args(BASE).args(args).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
    let targets: Vec<i32> = readers.iter().map(AsRawFd::as_raw_fd).collect();
    // SAFETY: only async-signal-safe dup2 calls between fork and exec; dup2
    // clears CLOEXEC on the target, so the child sees pipe:3, pipe:4, …
    unsafe {
        cmd.pre_exec(move || {
            for (i, fd) in targets.iter().enumerate() {
                if libc::dup2(*fd, 3 + i as i32) < 0 {
                    return Err(std::io::Error::last_os_error());
                }
            }
            Ok(())
        });
    }
    let mut child = cmd.spawn().map_err(|e| err(&e.to_string()))?;
    drop(readers); // the child has its copies
    let stdout = child.stdout.take().expect("piped");
    let mut stderr = child.stderr.take().expect("piped");
    // Every pipe is served concurrently (ffmpeg interleaves reads of its
    // inputs with writes of its output), so none of them can block the others.
    let (out, log) = std::thread::scope(|s| {
        for (fd, bytes) in writers.into_iter().zip(inputs) {
            s.spawn(move || {
                let mut f = std::fs::File::from(fd);
                // EPIPE when ffmpeg stops reading early (e.g. after `-frames:v 1`
                // or on an error); its exit status says which. Dropping the
                // file closes the write end: EOF for ffmpeg.
                let _ = f.write_all(bytes);
            });
        }
        let log = s.spawn(move || {
            let mut e = String::new();
            let _ = stderr.read_to_string(&mut e);
            e
        });
        let out = read_out(stdout);
        (out, log.join().unwrap_or_default())
    });
    // Reaped on every path: the threads above only return once ffmpeg has
    // closed its stdout and stderr.
    let status = child.wait().map_err(|e| err(&e.to_string()))?;
    if !status.success() {
        let tail: Vec<&str> = log.lines().rev().take(3).collect();
        return Err(format!("ffmpeg failed: {}", tail.into_iter().rev().collect::<Vec<_>>().join(" / ")));
    }
    Ok(out)
}

/// `run_piped_with` keeping all of stdout.
fn run_piped(ffmpeg: &Path, args: &[String], inputs: &[&[u8]]) -> Result<Vec<u8>, String> {
    run_piped_with(ffmpeg, args, inputs, |mut stdout| {
        let mut out = Vec::new();
        let _ = stdout.read_to_end(&mut out);
        out
    })
}

const UNEXPECTED_FRAME_SIZE: &str = "Could not read the last frame (unexpected frame size)";

/// Last frame as PNG: every frame streams out raw and only the last one is kept
/// (an input-side seek is impossible on a pipe). `width`/`height` come from the take record.
pub fn last_frame_png(ffmpeg: &Path, video: &[u8], width: u32, height: u32) -> Result<Vec<u8>, String> {
    let frame = (width as usize) * (height as usize) * 3;
    if frame == 0 {
        return Err(UNEXPECTED_FRAME_SIZE.into());
    }
    let a = args(["-i", "pipe:3", "-an", "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1"]);
    // (total bytes streamed, the tail of the stream ending on a frame boundary)
    let mut total = 0usize;
    let raw = run_piped_with(ffmpeg, &a, &[video], |mut stdout| {
        let mut buf = Vec::with_capacity(2 * frame);
        let mut chunk = vec![0u8; 1 << 16];
        loop {
            let n = match stdout.read(&mut chunk) {
                Ok(0) | Err(_) => break,
                Ok(n) => n,
            };
            total += n;
            buf.extend_from_slice(&chunk[..n]);
            // Keep the last complete frame plus whatever follows it.
            if buf.len() >= 2 * frame {
                let keep = frame + buf.len() % frame;
                buf.drain(..buf.len() - keep);
            }
        }
        buf
    })?;
    if total < frame || !total.is_multiple_of(frame) {
        return Err(UNEXPECTED_FRAME_SIZE.into());
    }
    let last = &raw[raw.len() - frame..];
    let mut png = Vec::new();
    image::codecs::png::PngEncoder::new(&mut png)
        .write_image(last, width, height, image::ExtendedColorType::Rgb8)
        .map_err(|e| format!("Could not encode the last frame: {e}"))?;
    Ok(png)
}

pub fn first_frame_jpg(ffmpeg: &Path, video: &[u8]) -> Result<Vec<u8>, String> {
    run_piped(
        ffmpeg,
        &args(["-i", "pipe:3", "-frames:v", "1", "-q:v", "3", "-f", "image2pipe", "-c:v", "mjpeg", "pipe:1"]),
        &[video],
    )
}

/// Everything after the base flags (which `run_piped` adds).
pub fn assemble_args(n: usize) -> Vec<String> {
    let mut a: Vec<String> = Vec::new();
    for i in 0..n {
        a.push("-i".into());
        a.push(format!("pipe:{}", 3 + i));
    }
    let streams: String = (0..n).map(|i| format!("[{i}:v][{i}:a]")).collect();
    let filter = format!("{streams}concat=n={n}:v=1:a=1[v][a0];[a0]loudnorm=I=-14:TP=-1.5:LRA=11,aresample=48000[a]");
    for x in [
        "-filter_complex", &filter, "-map", "[v]", "-map", "[a]", "-c:v", "libx264", "-crf", "18",
        "-pix_fmt", "yuv420p", "-c:a", "aac", "-ar", "48000", "-ac", "2", "-metadata", "comment=AI-generated",
        "-f", "mp4", "-movflags", "frag_keyframe+empty_moov+default_base_moof", "pipe:1",
    ] {
        a.push(x.to_string());
    }
    a
}

/// Approved takes (shot order) → one fragmented MP4, in memory.
pub fn assemble(ffmpeg: &Path, inputs: &[&[u8]]) -> Result<Vec<u8>, String> {
    if inputs.is_empty() {
        return Err("Nothing to assemble".into());
    }
    run_piped(ffmpeg, &assemble_args(inputs.len()), inputs)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn assemble_args_pipes_and_fragmented_output() {
        let s = assemble_args(2).join(" ");
        assert!(s.starts_with("-i pipe:3 -i pipe:4 "), "run_piped adds -nostdin/-hide_banner/-loglevel itself");
        assert!(s.contains("[0:v][0:a][1:v][1:a]concat=n=2:v=1:a=1[v][a0];[a0]loudnorm=I=-14:TP=-1.5:LRA=11,aresample=48000[a]"));
        assert!(s.contains("-c:v libx264 -crf 18 -pix_fmt yuv420p -c:a aac -ar 48000 -ac 2 -metadata comment=AI-generated"));
        assert!(s.ends_with("-f mp4 -movflags frag_keyframe+empty_moov+default_base_moof pipe:1"));
    }

    /// Synthetic clips are written by ffmpeg into the temp dir (test fixtures); the
    /// functions under test get bytes and must create no file anywhere.
    #[test]
    fn real_ffmpeg_bytes_in_bytes_out_writes_no_files() {
        let Ok(ff) = find_ffmpeg() else {
            eprintln!("ffmpeg not installed; skipping");
            return;
        };
        let dir = tempfile::tempdir().unwrap();
        let mk = |name: &str, color: &str| -> Vec<u8> {
            let p = dir.path().join(name);
            let st = std::process::Command::new(&ff)
                .args([
                    "-f", "lavfi", "-i", &format!("color=c={color}:s=320x180:d=1:r=24"),
                    "-f", "lavfi", "-i", "sine=frequency=440:duration=1",
                    "-shortest", "-c:v", "libx264", "-pix_fmt", "yuv420p",
                    "-c:a", "aac", "-movflags", "+faststart", "-y",
                ])
                .arg(&p)
                .status()
                .unwrap();
            assert!(st.success());
            std::fs::read(&p).unwrap()
        };
        let (a, b) = (mk("a.mp4", "red"), mk("b.mp4", "blue"));
        let listing = || {
            let mut v: Vec<_> = std::fs::read_dir(dir.path()).unwrap().map(|e| e.unwrap().file_name()).collect();
            v.sort();
            v
        };
        let before = listing();
        let film = assemble(&ff, &[&a, &b]).unwrap();
        assert!(film.len() > 1000 && &film[4..8] == b"ftyp");
        let png = last_frame_png(&ff, &b, 320, 180).unwrap();
        let img = image::load_from_memory(&png).unwrap().to_rgb8();
        let p = img.get_pixel(160, 90).0;
        assert!(p[2] > 200 && p[0] < 40 && p[1] < 40, "last frame of the blue clip: {p:?}");
        let jpg = first_frame_jpg(&ff, &film).unwrap();
        assert!(jpg.starts_with(&[0xFF, 0xD8]));
        assert_eq!(listing(), before, "no file was created");
        assert_eq!(
            last_frame_png(&ff, &b, 321, 180).unwrap_err(),
            "Could not read the last frame (unexpected frame size)"
        );
    }

    /// The worker's takes are moov-first; a moov-at-end file cannot be read from a pipe.
    #[test]
    fn moov_at_end_input_is_a_clear_error() {
        let Ok(ff) = find_ffmpeg() else { return };
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("late.mp4");
        std::process::Command::new(&ff)
            .args([
                "-f", "lavfi", "-i", "testsrc2=s=640x360:d=3:r=24", "-f", "lavfi", "-i", "sine=duration=3",
                "-shortest", "-c:v", "libx264", "-c:a", "aac", "-y",
            ])
            .arg(&p)
            .status()
            .unwrap();
        let bytes = std::fs::read(&p).unwrap();
        assert!(bytes.len() > 64 * 1024, "must exceed ffmpeg's probe buffer for the test to mean anything");
        let e = first_frame_jpg(&ff, &bytes).unwrap_err();
        assert!(e.starts_with("ffmpeg failed:"), "{e}");
    }
}
