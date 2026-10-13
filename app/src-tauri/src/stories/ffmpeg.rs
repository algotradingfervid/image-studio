//! ffmpeg helpers for stitching approved takes into the final story video.

use std::path::{Path, PathBuf};
use std::process::Command;

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

fn run(ffmpeg: &Path, args: &[String]) -> Result<(), String> {
    let out = Command::new(ffmpeg)
        .args(args)
        .output()
        .map_err(|e| format!("Could not run ffmpeg: {e}"))?;
    if out.status.success() {
        return Ok(());
    }
    let err = String::from_utf8_lossy(&out.stderr);
    let tail: Vec<&str> = err.lines().rev().take(3).collect();
    Err(format!(
        "ffmpeg failed: {}",
        tail.into_iter().rev().collect::<Vec<_>>().join(" / ")
    ))
}

fn s(p: &Path) -> String {
    p.to_string_lossy().into_owned()
}

pub fn last_frame_png(ffmpeg: &Path, video: &Path, out_png: &Path) -> Result<(), String> {
    run(
        ffmpeg,
        &[
            "-hide_banner".into(), "-loglevel".into(), "error".into(),
            "-sseof".into(), "-0.1".into(), "-i".into(), s(video),
            "-frames:v".into(), "1".into(), "-update".into(), "1".into(),
            "-y".into(), s(out_png),
        ],
    )
}

pub fn first_frame_jpg(ffmpeg: &Path, video: &Path, out_jpg: &Path) -> Result<(), String> {
    run(
        ffmpeg,
        &[
            "-hide_banner".into(), "-loglevel".into(), "error".into(),
            "-i".into(), s(video), "-frames:v".into(), "1".into(),
            "-q:v".into(), "3".into(), "-y".into(), s(out_jpg),
        ],
    )
}

pub fn assemble_args(inputs: &[PathBuf], out: &Path) -> Vec<String> {
    let mut a: Vec<String> = vec!["-hide_banner".into(), "-loglevel".into(), "error".into()];
    for i in inputs {
        a.push("-i".into());
        a.push(s(i));
    }
    let streams: String = (0..inputs.len()).map(|i| format!("[{i}:v][{i}:a]")).collect();
    let filter = format!(
        "{streams}concat=n={}:v=1:a=1[v][a0];[a0]loudnorm=I=-14:TP=-1.5:LRA=11,aresample=48000[a]",
        inputs.len()
    );
    for x in [
        "-filter_complex", &filter, "-map", "[v]", "-map", "[a]", "-c:v", "libx264", "-crf", "18",
        "-pix_fmt", "yuv420p", "-c:a", "aac", "-ar", "48000", "-ac", "2",
        "-metadata", "comment=AI-generated", "-movflags", "+faststart", "-y",
    ] {
        a.push(x.to_string());
    }
    a.push(s(out));
    a
}

pub fn assemble(ffmpeg: &Path, inputs: &[PathBuf], out: &Path) -> Result<(), String> {
    if inputs.is_empty() {
        return Err("Nothing to assemble".into());
    }
    run(ffmpeg, &assemble_args(inputs, out))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;

    #[test]
    fn assemble_args_concat_loudnorm_and_label() {
        let a = assemble_args(&["/a.mp4".into(), "/b.mp4".into()], Path::new("/o.mp4"));
        let s = a.join(" ");
        assert!(s.contains("-i /a.mp4 -i /b.mp4"));
        assert!(s.contains("[0:v][0:a][1:v][1:a]concat=n=2:v=1:a=1[v][a0]"));
        assert!(s.contains("[a0]loudnorm=I=-14:TP=-1.5:LRA=11,aresample=48000[a]"));
        assert!(s.contains("-c:v libx264 -crf 18 -pix_fmt yuv420p -c:a aac -ar 48000 -ac 2"));
        assert!(s.contains("-metadata comment=AI-generated"));
        assert!(s.ends_with("-movflags +faststart -y /o.mp4"));
    }

    #[test]
    fn real_ffmpeg_round_trip() {
        let Ok(ff) = find_ffmpeg() else {
            eprintln!("ffmpeg not installed; skipping");
            return;
        };
        let dir = tempfile::tempdir().unwrap();
        let mk = |name: &str, color: &str| {
            let p = dir.path().join(name);
            let st = std::process::Command::new(&ff)
                .args([
                    "-f", "lavfi", "-i", &format!("color=c={color}:s=320x180:d=1:r=24"),
                    "-f", "lavfi", "-i", "sine=frequency=440:duration=1",
                    "-shortest", "-c:v", "libx264", "-c:a", "aac", "-y",
                ])
                .arg(&p)
                .status()
                .unwrap();
            assert!(st.success());
            p
        };
        let (a, b) = (mk("a.mp4", "red"), mk("b.mp4", "blue"));
        let out = dir.path().join("out.mp4");
        assemble(&ff, &[a.clone(), b], &out).unwrap();
        assert!(std::fs::metadata(&out).unwrap().len() > 1000);
        let png = dir.path().join("last.png");
        last_frame_png(&ff, &a, &png).unwrap();
        assert!(std::fs::read(&png).unwrap().starts_with(&[0x89, b'P', b'N', b'G']));
        let jpg = dir.path().join("first.jpg");
        first_frame_jpg(&ff, &a, &jpg).unwrap();
        assert!(std::fs::read(&jpg).unwrap().starts_with(&[0xFF, 0xD8]));
    }
}
