//! Performance log: one JSON line per finished job at `<data_dir>/timings.jsonl`,
//! with the worker's stage times and per-ComfyUI-node wall times, so slow steps
//! can be found and improved. Holds only the model, GPU, output size and
//! timings: never the prompt, seed, file names or which gallery (vault or
//! general) the result went to.

use std::io::Write;

use serde_json::{json, Value};

use crate::db::ImageRecord;
use crate::state::Core;

/// The log line for a finished job (`out` is the worker's output object).
pub fn entry(rec: &ImageRecord, gpu: Option<&str>, out: &Value, at: &str) -> Value {
    let mut t = out.get("timings").cloned().unwrap_or_else(|| json!({}));
    if let Some(m) = t.as_object_mut() {
        m.retain(|k, _| matches!(k.as_str(), "loadMs" | "sampleMs" | "encodeMs" | "totalMs" | "nodes" | "stages"));
    }
    let mut e = json!({
        "at": at,
        "kind": rec.kind,
        "model": rec.model,
        "gpu": gpu,
        "width": rec.width,
        "height": rec.height,
        "steps": rec.steps,
        "timings": t,
    });
    if rec.kind == crate::db::KIND_VIDEO {
        e["durationS"] = json!(rec.duration_s);
        e["fps"] = json!(rec.fps);
        e["audio"] = json!(rec.has_audio);
        e["frames"] = out.pointer("/video/frames").cloned().unwrap_or(Value::Null);
    }
    e
}

/// Appends `entry` to the log (created private). Best effort: a failure here
/// never fails the job.
pub fn append(core: &Core, entry: &Value) {
    let path = core.cfg.timings_log();
    let res = (|| -> std::io::Result<()> {
        let mut o = std::fs::OpenOptions::new();
        o.create(true).append(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            o.mode(0o600);
        }
        let mut f = o.open(&path)?;
        writeln!(f, "{entry}")
    })();
    if let Err(e) = res {
        crate::alog!("timings", "couldn't write {}: {e}", path.display());
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::RunpodTimes;

    fn rec() -> ImageRecord {
        ImageRecord {
            id: "rec-id".into(),
            path: "/videos/secret-file.mp4".into(),
            model: "h3".into(),
            prompt: "secret prompt words".into(),
            negative_prompt: "secret negative".into(),
            aspect_ratio: "1344x768".into(),
            width: 1344,
            height: 768,
            seed: 424242,
            steps: 30,
            cfg: 1.0,
            references: vec!["/refs/secret-ref.png".into()],
            loras: vec![],
            created_at: "2026-10-09T08:00:00Z".into(),
            duration_ms: Some(1),
            runpod: RunpodTimes::default(),
            init_image: Some("/refs/secret-start.png".into()),
            denoise: None,
            kind: crate::db::KIND_VIDEO.into(),
            duration_s: Some(15.0),
            fps: Some(24.0),
            has_audio: Some(true),
            poster_path: None,
            vault: true,
            thumb_path: None,
        }
    }

    #[test]
    fn entry_keeps_timings_and_drops_everything_private() {
        let out = json!({
            "video": {"base64": "AAAA", "frames": 362},
            "seed": 424242,
            "timings": {"loadMs": 1, "sampleMs": 2, "encodeMs": 3, "totalMs": 6,
                        "nodes": [["12", "SaveVideo", 180000]], "stages": {"sampling": 2},
                        "unexpected": "secret"},
        });
        let e = entry(&rec(), Some("NVIDIA H200"), &out, "2026-10-09T08:00:00Z");
        assert_eq!(e["timings"]["nodes"][0][1], "SaveVideo");
        assert_eq!(e["frames"], 362);
        assert_eq!(e["gpu"], "NVIDIA H200");
        assert!(e["timings"].get("unexpected").is_none());
        let s = e.to_string();
        for leak in ["secret", "424242", "rec-id", "vault", "AAAA"] {
            assert!(!s.contains(leak), "{leak} leaked into {s}");
        }
    }
}
