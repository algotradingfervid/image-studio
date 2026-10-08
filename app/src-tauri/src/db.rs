//! SQLite storage (`studio.db`): images, loras, model status cache, settings.

use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use std::path::Path;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct LoraRef {
    pub name: String,
    pub strength: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct RunpodTimes {
    pub delay_ms: Option<u64>,
    pub execution_ms: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ImageRecord {
    pub id: String,
    pub path: String,
    pub model: String,
    pub prompt: String,
    pub negative_prompt: String,
    pub aspect_ratio: String,
    pub width: u32,
    pub height: u32,
    pub seed: u64,
    pub steps: u32,
    pub cfg: f64,
    pub references: Vec<String>,
    pub loras: Vec<LoraRef>,
    pub created_at: String,
    pub duration_ms: Option<u64>,
    pub runpod: RunpodTimes,
    /// img2img start image (path of the imported reference file), if any.
    #[serde(default)]
    pub init_image: Option<String>,
    /// img2img strength (denoise, 0.05–1.0); None for text-to-image.
    #[serde(default)]
    pub denoise: Option<f64>,
    /// "image" or "video" (spec v5). For videos `path` is the .mp4,
    /// `aspect_ratio` holds the resolution id and `init_image` the i2v start image.
    #[serde(default = "image_kind")]
    pub kind: String,
    #[serde(default)]
    pub duration_s: Option<f64>,
    #[serde(default)]
    pub fps: Option<f64>,
    #[serde(default)]
    pub has_audio: Option<bool>,
    /// Video poster frame (JPEG).
    #[serde(default)]
    pub poster_path: Option<String>,
}

pub const KIND_IMAGE: &str = "image";
pub const KIND_VIDEO: &str = "video";

fn image_kind() -> String {
    KIND_IMAGE.to_string()
}

#[derive(Debug, Clone, PartialEq)]
pub struct LoraRow {
    pub id: String,
    pub name: String,
    pub model_id: String,
    pub source: String,
    pub source_url: String,
    pub download_url: String,
    pub filename: String,
    pub size_bytes: Option<u64>,
    pub sha256: Option<String>,
    pub trigger_words: Vec<String>,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct VolumeFile {
    pub folder: String,
    pub filename: String,
    #[serde(default)]
    pub size_bytes: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct Volume {
    #[serde(default)]
    pub total_bytes: u64,
    #[serde(default)]
    pub free_bytes: u64,
}

/// Output of the worker `status` action, as cached.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct StatusSnapshot {
    #[serde(default)]
    pub files: Vec<VolumeFile>,
    #[serde(default)]
    pub volume: Volume,
    #[serde(default)]
    pub comfyui_version: Option<String>,
}

const MIGRATIONS: &[&str] = &[
    r#"
CREATE TABLE images (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  path TEXT NOT NULL,
  model TEXT NOT NULL,
  prompt TEXT NOT NULL,
  negative_prompt TEXT NOT NULL,
  aspect_ratio TEXT NOT NULL,
  width INTEGER NOT NULL,
  height INTEGER NOT NULL,
  seed TEXT NOT NULL,
  steps INTEGER NOT NULL,
  cfg REAL NOT NULL,
  references_json TEXT NOT NULL,
  loras_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  duration_ms INTEGER,
  delay_ms INTEGER,
  execution_ms INTEGER
);
CREATE TABLE loras (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  model_id TEXT NOT NULL,
  source TEXT NOT NULL,
  source_url TEXT NOT NULL,
  download_url TEXT NOT NULL,
  filename TEXT NOT NULL,
  size_bytes INTEGER,
  sha256 TEXT,
  trigger_words_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(model_id, filename)
);
CREATE TABLE model_status (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  json TEXT NOT NULL,
  checked_at TEXT NOT NULL
);
CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
"#,
    // 2: img2img (start image + strength); NULL for existing rows.
    r#"
ALTER TABLE images ADD COLUMN init_image TEXT;
ALTER TABLE images ADD COLUMN denoise REAL;
"#,
    // 3: video records (spec v5) and a status cache per volume/profile.
    r#"
ALTER TABLE images ADD COLUMN kind TEXT NOT NULL DEFAULT 'image';
ALTER TABLE images ADD COLUMN duration_s REAL;
ALTER TABLE images ADD COLUMN fps REAL;
ALTER TABLE images ADD COLUMN has_audio INTEGER;
ALTER TABLE images ADD COLUMN poster_path TEXT;
CREATE TABLE volume_status (
  profile TEXT PRIMARY KEY,
  json TEXT NOT NULL,
  checked_at TEXT NOT NULL
);
"#,
];

/// `profile` key whose status lives in the original `model_status` table.
pub const IMAGE_STATUS_KEY: &str = "image";

pub struct Db {
    conn: Connection,
}

fn e(err: rusqlite::Error) -> String {
    format!("Database error: {err}")
}

fn opt_u64(v: Option<i64>) -> Option<u64> {
    v.map(|x| x.max(0) as u64)
}

impl Db {
    pub fn open(path: &Path) -> Result<Db, String> {
        let conn = Connection::open(path).map_err(e)?;
        Self::init(conn)
    }

    pub fn open_in_memory() -> Result<Db, String> {
        Self::init(Connection::open_in_memory().map_err(e)?)
    }

    fn init(conn: Connection) -> Result<Db, String> {
        conn.pragma_update(None, "journal_mode", "WAL").ok();
        let version: i64 = conn
            .query_row("PRAGMA user_version", [], |r| r.get(0))
            .map_err(e)?;
        for (i, sql) in MIGRATIONS.iter().enumerate().skip(version as usize) {
            conn.execute_batch(&format!(
                "BEGIN; {sql} PRAGMA user_version = {}; COMMIT;",
                i + 1
            ))
            .map_err(e)?;
        }
        Ok(Db { conn })
    }

    // ----- images -----

    pub fn insert_image(&self, r: &ImageRecord) -> Result<(), String> {
        self.conn
            .execute(
                "INSERT INTO images (id, path, model, prompt, negative_prompt, aspect_ratio, width, height, seed, steps, cfg, references_json, loras_json, created_at, duration_ms, delay_ms, execution_ms, init_image, denoise, kind, duration_s, fps, has_audio, poster_path)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20, ?21, ?22, ?23, ?24)",
                params![
                    r.id,
                    r.path,
                    r.model,
                    r.prompt,
                    r.negative_prompt,
                    r.aspect_ratio,
                    r.width,
                    r.height,
                    r.seed.to_string(),
                    r.steps,
                    r.cfg,
                    serde_json::to_string(&r.references).unwrap(),
                    serde_json::to_string(&r.loras).unwrap(),
                    r.created_at,
                    r.duration_ms.map(|x| x as i64),
                    r.runpod.delay_ms.map(|x| x as i64),
                    r.runpod.execution_ms.map(|x| x as i64),
                    r.init_image,
                    r.denoise,
                    r.kind,
                    r.duration_s,
                    r.fps,
                    r.has_audio,
                    r.poster_path,
                ],
            )
            .map_err(e)?;
        Ok(())
    }

    fn row_to_image(row: &rusqlite::Row) -> rusqlite::Result<(i64, ImageRecord)> {
        let refs: String = row.get("references_json")?;
        let loras: String = row.get("loras_json")?;
        let seed: String = row.get("seed")?;
        Ok((
            row.get("seq")?,
            ImageRecord {
                id: row.get("id")?,
                path: row.get("path")?,
                model: row.get("model")?,
                prompt: row.get("prompt")?,
                negative_prompt: row.get("negative_prompt")?,
                aspect_ratio: row.get("aspect_ratio")?,
                width: row.get("width")?,
                height: row.get("height")?,
                seed: seed.parse().unwrap_or(0),
                steps: row.get("steps")?,
                cfg: row.get("cfg")?,
                references: serde_json::from_str(&refs).unwrap_or_default(),
                loras: serde_json::from_str(&loras).unwrap_or_default(),
                created_at: row.get("created_at")?,
                duration_ms: opt_u64(row.get("duration_ms")?),
                runpod: RunpodTimes {
                    delay_ms: opt_u64(row.get("delay_ms")?),
                    execution_ms: opt_u64(row.get("execution_ms")?),
                },
                init_image: row.get("init_image")?,
                denoise: row.get("denoise")?,
                kind: row.get("kind")?,
                duration_s: row.get("duration_s")?,
                fps: row.get("fps")?,
                has_audio: row.get("has_audio")?,
                poster_path: row.get("poster_path")?,
            },
        ))
    }

    /// Newest first. `before` is an opaque cursor (the `seq` of the last item seen).
    pub fn list_images(
        &self,
        limit: u32,
        before: Option<i64>,
    ) -> Result<(Vec<ImageRecord>, Option<i64>), String> {
        let limit = limit.clamp(1, 500);
        let mut stmt = self
            .conn
            .prepare("SELECT * FROM images WHERE seq < ?1 ORDER BY seq DESC LIMIT ?2")
            .map_err(e)?;
        let rows: Vec<(i64, ImageRecord)> = stmt
            .query_map(
                params![before.unwrap_or(i64::MAX), limit + 1],
                Self::row_to_image,
            )
            .map_err(e)?
            .collect::<Result<_, _>>()
            .map_err(e)?;
        let more = rows.len() > limit as usize;
        let rows: Vec<_> = rows.into_iter().take(limit as usize).collect();
        let next = if more {
            rows.last().map(|(s, _)| *s)
        } else {
            None
        };
        Ok((rows.into_iter().map(|(_, r)| r).collect(), next))
    }

    pub fn get_image(&self, id: &str) -> Result<Option<ImageRecord>, String> {
        self.conn
            .query_row(
                "SELECT * FROM images WHERE id = ?1",
                [id],
                Self::row_to_image,
            )
            .optional()
            .map(|o| o.map(|(_, r)| r))
            .map_err(e)
    }

    pub fn delete_image(&self, id: &str) -> Result<(), String> {
        self.conn
            .execute("DELETE FROM images WHERE id = ?1", [id])
            .map_err(e)?;
        Ok(())
    }

    // ----- loras -----

    pub fn insert_lora(&self, l: &LoraRow) -> Result<(), String> {
        self.conn
            .execute(
                "INSERT INTO loras (id, name, model_id, source, source_url, download_url, filename, size_bytes, sha256, trigger_words_json, created_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)",
                params![
                    l.id,
                    l.name,
                    l.model_id,
                    l.source,
                    l.source_url,
                    l.download_url,
                    l.filename,
                    l.size_bytes.map(|x| x as i64),
                    l.sha256,
                    serde_json::to_string(&l.trigger_words).unwrap(),
                    l.created_at
                ],
            )
            .map_err(|err| match err {
                rusqlite::Error::SqliteFailure(f, _)
                    if f.code == rusqlite::ErrorCode::ConstraintViolation =>
                {
                    format!("A LoRA named {} already exists for this model", l.filename)
                }
                other => e(other),
            })?;
        Ok(())
    }

    fn row_to_lora(row: &rusqlite::Row) -> rusqlite::Result<LoraRow> {
        let tw: String = row.get("trigger_words_json")?;
        Ok(LoraRow {
            id: row.get("id")?,
            name: row.get("name")?,
            model_id: row.get("model_id")?,
            source: row.get("source")?,
            source_url: row.get("source_url")?,
            download_url: row.get("download_url")?,
            filename: row.get("filename")?,
            size_bytes: opt_u64(row.get("size_bytes")?),
            sha256: row.get("sha256")?,
            trigger_words: serde_json::from_str(&tw).unwrap_or_default(),
            created_at: row.get("created_at")?,
        })
    }

    pub fn list_loras(&self) -> Result<Vec<LoraRow>, String> {
        let mut stmt = self
            .conn
            .prepare("SELECT * FROM loras ORDER BY created_at DESC, name")
            .map_err(e)?;
        let rows = stmt
            .query_map([], Self::row_to_lora)
            .map_err(e)?
            .collect::<Result<_, _>>()
            .map_err(e)?;
        Ok(rows)
    }

    pub fn get_lora(&self, id: &str) -> Result<Option<LoraRow>, String> {
        self.conn
            .query_row("SELECT * FROM loras WHERE id = ?1", [id], Self::row_to_lora)
            .optional()
            .map_err(e)
    }

    pub fn delete_lora(&self, id: &str) -> Result<(), String> {
        self.conn
            .execute("DELETE FROM loras WHERE id = ?1", [id])
            .map_err(e)?;
        Ok(())
    }

    // ----- status cache -----

    pub fn save_status(&self, s: &StatusSnapshot, checked_at: &str) -> Result<(), String> {
        self.conn
            .execute(
                "INSERT INTO model_status (id, json, checked_at) VALUES (1, ?1, ?2)
                 ON CONFLICT(id) DO UPDATE SET json = excluded.json, checked_at = excluded.checked_at",
                params![serde_json::to_string(s).unwrap(), checked_at],
            )
            .map_err(e)?;
        Ok(())
    }

    pub fn load_status(&self) -> Result<Option<(StatusSnapshot, String)>, String> {
        let row: Option<(String, String)> = self
            .conn
            .query_row(
                "SELECT json, checked_at FROM model_status WHERE id = 1",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .optional()
            .map_err(e)?;
        Ok(row.and_then(|(j, at)| serde_json::from_str(&j).ok().map(|s| (s, at))))
    }

    /// Status cache for a profile's volume: "image" uses `model_status`
    /// (unchanged), any other profile its own `volume_status` row.
    pub fn save_status_for(&self, profile: &str, s: &StatusSnapshot, checked_at: &str) -> Result<(), String> {
        if profile == IMAGE_STATUS_KEY {
            return self.save_status(s, checked_at);
        }
        self.conn
            .execute(
                "INSERT INTO volume_status (profile, json, checked_at) VALUES (?1, ?2, ?3)
                 ON CONFLICT(profile) DO UPDATE SET json = excluded.json, checked_at = excluded.checked_at",
                params![profile, serde_json::to_string(s).unwrap(), checked_at],
            )
            .map_err(e)?;
        Ok(())
    }

    pub fn load_status_for(&self, profile: &str) -> Result<Option<(StatusSnapshot, String)>, String> {
        if profile == IMAGE_STATUS_KEY {
            return self.load_status();
        }
        let row: Option<(String, String)> = self
            .conn
            .query_row(
                "SELECT json, checked_at FROM volume_status WHERE profile = ?1",
                [profile],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .optional()
            .map_err(e)?;
        Ok(row.and_then(|(j, at)| serde_json::from_str(&j).ok().map(|s| (s, at))))
    }

    // ----- settings (key/value) -----

    pub fn get_setting(&self, key: &str) -> Result<Option<String>, String> {
        self.conn
            .query_row("SELECT value FROM settings WHERE key = ?1", [key], |r| {
                r.get(0)
            })
            .optional()
            .map_err(e)
    }

    pub fn set_setting(&self, key: &str, value: &str) -> Result<(), String> {
        self.conn
            .execute(
                "INSERT INTO settings (key, value) VALUES (?1, ?2)
                 ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                params![key, value],
            )
            .map_err(e)?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn img(id: &str, seed: u64) -> ImageRecord {
        ImageRecord {
            id: id.into(),
            path: format!("/x/{id}.png"),
            model: "chroma".into(),
            prompt: "p".into(),
            negative_prompt: "".into(),
            aspect_ratio: "1:1".into(),
            width: 1024,
            height: 1024,
            seed,
            steps: 4,
            cfg: 1.0,
            references: vec!["/r/a.jpg".into()],
            loras: vec![LoraRef {
                name: "l".into(),
                strength: 0.8,
            }],
            created_at: "2026-10-08T00:00:00Z".into(),
            duration_ms: Some(10),
            runpod: RunpodTimes {
                delay_ms: Some(1),
                execution_ms: Some(2),
            },
            init_image: None,
            denoise: None,
            kind: KIND_IMAGE.into(),
            duration_s: None,
            fps: None,
            has_audio: None,
            poster_path: None,
        }
    }

    #[test]
    fn img2img_fields_roundtrip() {
        let db = Db::open_in_memory().unwrap();
        let mut r = img("a", 7);
        r.init_image = Some("/refs/0000.jpg".into());
        r.denoise = Some(0.45);
        db.insert_image(&r).unwrap();
        db.insert_image(&img("b", 8)).unwrap();
        assert_eq!(db.get_image("a").unwrap(), Some(r.clone()));
        assert_eq!(db.get_image("b").unwrap().unwrap().init_image, None);
        let v = serde_json::to_value(&r).unwrap();
        assert_eq!(v["initImage"], serde_json::json!("/refs/0000.jpg"));
        assert_eq!(v["denoise"], serde_json::json!(0.45));
        // records serialised before img2img still deserialise
        let mut old = serde_json::to_value(img("c", 9)).unwrap();
        old.as_object_mut().unwrap().remove("initImage");
        old.as_object_mut().unwrap().remove("denoise");
        let back: ImageRecord = serde_json::from_value(old).unwrap();
        assert_eq!(back, img("c", 9));
    }

    #[test]
    fn migrates_existing_v1_database() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("studio.db");
        {
            // A database written by the pre-img2img app (schema version 1).
            let conn = Connection::open(&path).unwrap();
            conn.execute_batch(&format!(
                "BEGIN; {} PRAGMA user_version = 1; COMMIT;",
                MIGRATIONS[0]
            ))
            .unwrap();
            conn.execute(
                "INSERT INTO images (id, path, model, prompt, negative_prompt, aspect_ratio, width, height, seed, steps, cfg, references_json, loras_json, created_at, duration_ms, delay_ms, execution_ms)
                 VALUES ('old', '/x/old.png', 'zimage', 'p', '', '1:1', 1024, 1024, '5', 8, 1.0, '[]', '[]', 't', 10, NULL, NULL)",
                [],
            )
            .unwrap();
        }
        let db = Db::open(&path).unwrap();
        let version: i64 = db
            .conn
            .query_row("PRAGMA user_version", [], |r| r.get(0))
            .unwrap();
        assert_eq!(version, MIGRATIONS.len() as i64);
        let old = db.get_image("old").unwrap().unwrap();
        assert_eq!((old.seed, old.init_image, old.denoise), (5, None, None));
        let mut r = img("new", 1);
        r.init_image = Some("/refs/s.png".into());
        r.denoise = Some(0.6);
        db.insert_image(&r).unwrap();
        drop(db);
        // reopening runs no migration twice
        let db = Db::open(&path).unwrap();
        assert_eq!(db.get_image("new").unwrap(), Some(r));
        assert_eq!(db.list_images(10, None).unwrap().0.len(), 2);
    }

    #[test]
    fn video_records_roundtrip_and_status_per_profile() {
        let db = Db::open_in_memory().unwrap();
        let mut v = img("v", 3);
        v.kind = KIND_VIDEO.into();
        v.path = "/x/videos/v.mp4".into();
        v.aspect_ratio = "1280x720".into();
        v.duration_s = Some(5.0);
        v.fps = Some(24.0);
        v.has_audio = Some(true);
        v.poster_path = Some("/x/videos/v.jpg".into());
        db.insert_image(&v).unwrap();
        db.insert_image(&img("i", 4)).unwrap();
        assert_eq!(db.get_image("v").unwrap(), Some(v.clone()));
        assert_eq!(db.get_image("i").unwrap().unwrap().kind, "image");
        let j = serde_json::to_value(&v).unwrap();
        assert_eq!(j["kind"], "video");
        assert_eq!(j["durationS"], serde_json::json!(5.0));
        assert_eq!(j["hasAudio"], serde_json::json!(true));
        assert_eq!(j["posterPath"], "/x/videos/v.jpg");
        // older serialised records (no kind) read as images
        let mut old = serde_json::to_value(img("c", 9)).unwrap();
        for k in ["kind", "durationS", "fps", "hasAudio", "posterPath"] {
            old.as_object_mut().unwrap().remove(k);
        }
        assert_eq!(serde_json::from_value::<ImageRecord>(old).unwrap(), img("c", 9));
        // separate status caches per profile
        let snap = |name: &str| StatusSnapshot {
            files: vec![VolumeFile {
                folder: "unet".into(),
                filename: name.into(),
                size_bytes: Some(1),
            }],
            ..Default::default()
        };
        db.save_status_for("image", &snap("img.safetensors"), "t1").unwrap();
        assert!(db.load_status_for("video").unwrap().is_none());
        db.save_status_for("video", &snap("vid.safetensors"), "t2").unwrap();
        db.save_status_for("video", &snap("vid2.safetensors"), "t3").unwrap();
        assert_eq!(db.load_status().unwrap(), Some((snap("img.safetensors"), "t1".into())));
        assert_eq!(
            db.load_status_for("video").unwrap(),
            Some((snap("vid2.safetensors"), "t3".into()))
        );
    }

    #[test]
    fn migrates_v2_database_to_video_columns() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("studio.db");
        {
            // A database written by the img2img app (schema version 2).
            let conn = Connection::open(&path).unwrap();
            conn.execute_batch(&format!(
                "BEGIN; {} {} PRAGMA user_version = 2; COMMIT;",
                MIGRATIONS[0], MIGRATIONS[1]
            ))
            .unwrap();
            conn.execute(
                "INSERT INTO images (id, path, model, prompt, negative_prompt, aspect_ratio, width, height, seed, steps, cfg, references_json, loras_json, created_at, duration_ms, delay_ms, execution_ms, init_image, denoise)
                 VALUES ('old', '/x/old.png', 'chroma', 'p', '', '1:1', 1024, 1024, '5', 8, 1.0, '[]', '[]', 't', 10, NULL, NULL, '/r/s.png', 0.5)",
                [],
            )
            .unwrap();
            conn.execute(
                "INSERT INTO model_status (id, json, checked_at) VALUES (1, '{\"files\": []}', 'tc')",
                [],
            )
            .unwrap();
        }
        let db = Db::open(&path).unwrap();
        let version: i64 = db
            .conn
            .query_row("PRAGMA user_version", [], |r| r.get(0))
            .unwrap();
        assert_eq!(version, MIGRATIONS.len() as i64);
        let old = db.get_image("old").unwrap().unwrap();
        assert_eq!(old.kind, "image");
        assert_eq!((old.duration_s, old.fps, old.has_audio, old.poster_path), (None, None, None, None));
        assert_eq!((old.init_image.as_deref(), old.denoise), (Some("/r/s.png"), Some(0.5)));
        assert_eq!(db.load_status().unwrap().unwrap().1, "tc", "image cache kept");
        assert!(db.load_status_for("video").unwrap().is_none());
        drop(db);
        assert!(Db::open(&path).is_ok(), "reopening runs no migration twice");
    }

    #[test]
    fn images_paginate_and_roundtrip() {
        let db = Db::open_in_memory().unwrap();
        for i in 0..5 {
            db.insert_image(&img(&format!("i{i}"), u64::MAX - i))
                .unwrap();
        }
        let (page, next) = db.list_images(2, None).unwrap();
        assert_eq!(
            page.iter().map(|r| r.id.as_str()).collect::<Vec<_>>(),
            ["i4", "i3"]
        );
        assert_eq!(page[0], img("i4", u64::MAX - 4));
        let (page2, next2) = db.list_images(2, next).unwrap();
        assert_eq!(page2[0].id, "i2");
        let (page3, next3) = db.list_images(2, next2).unwrap();
        assert_eq!(page3.len(), 1);
        assert_eq!(next3, None);
        db.delete_image("i0").unwrap();
        assert!(db.get_image("i0").unwrap().is_none());
    }

    #[test]
    fn status_and_settings() {
        let db = Db::open_in_memory().unwrap();
        assert!(db.load_status().unwrap().is_none());
        let s = StatusSnapshot {
            files: vec![VolumeFile {
                folder: "vae".into(),
                filename: "ae.safetensors".into(),
                size_bytes: Some(1),
            }],
            volume: Volume {
                total_bytes: 10,
                free_bytes: 5,
            },
            comfyui_version: Some("0.39.0".into()),
        };
        db.save_status(&s, "t1").unwrap();
        db.save_status(&s, "t2").unwrap();
        assert_eq!(db.load_status().unwrap(), Some((s, "t2".into())));
        db.set_setting("k", "v").unwrap();
        assert_eq!(db.get_setting("k").unwrap().as_deref(), Some("v"));
    }
}
