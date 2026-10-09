//! Vault (spec v6) against temp dirs only: the one-time migration (resume,
//! verify-before-delete), moves, vault jobs that never write plaintext, the
//! `vault://` scheme, and a SQLite file that holds nothing about vault items.

use app_lib::db::{Db, ImageRecord, RunpodTimes, KIND_IMAGE, KIND_VIDEO};
use app_lib::jobs::{self, Destination, GenerateRequest, Job, JobState, VideoRequest};
use app_lib::registry::Registry;
use app_lib::settings::{MemoryStore, SecretStore, Settings, ACCOUNT_RUNPOD, ENV_RUNPOD_ENDPOINT};
use app_lib::state::{Core, CoreConfig, EventSink};
use app_lib::status::StatusView;
use app_lib::tasks::Task;
use app_lib::vault::{BlobRef, KdfParams, VaultStatus};
use app_lib::vault_migrate::{self, MigrateOptions, MigrationProgress};
use base64::Engine;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use wiremock::matchers::{method, path, path_regex};
use wiremock::{Mock, MockServer, Request, Respond, ResponseTemplate};

const PW: &[u8] = b"a long enough password";
const PROMPT: &str = "PRIVATE-PROMPT-MARKER-7f3a lighthouse at blue hour";

#[derive(Default)]
struct Collect {
    jobs: Mutex<Vec<Job>>,
    vault: Mutex<Vec<VaultStatus>>,
    migration: Mutex<Vec<MigrationProgress>>,
}
impl EventSink for Collect {
    fn job_update(&self, j: &Job) {
        self.jobs.lock().unwrap().push(j.clone());
    }
    fn task_update(&self, _: &Task) {}
    fn status_update(&self, _: &StatusView) {}
    fn vault_update(&self, s: &VaultStatus) {
        self.vault.lock().unwrap().push(s.clone());
    }
    fn vault_migration(&self, p: &MigrationProgress) {
        self.migration.lock().unwrap().push(p.clone());
    }
}

struct Harness {
    core: Arc<Core>,
    sink: Arc<Collect>,
    dir: tempfile::TempDir,
}

fn harness(server_uri: &str) -> Harness {
    let dir = tempfile::tempdir().unwrap();
    let store = Arc::new(MemoryStore::default());
    store.set(ACCOUNT_RUNPOD, Some("test-key")).unwrap();
    let env: HashMap<String, String> = [(ENV_RUNPOD_ENDPOINT.to_string(), "ep1".to_string())].into();
    std::fs::write(dir.path().join("settings.json"), r#"{"backend":"serverless"}"#).unwrap();
    let settings = Settings::new(store, env, dir.path().join("settings.json"));
    let sink = Arc::new(Collect::default());
    let cfg = CoreConfig {
        data_dir: dir.path().to_path_buf(),
        runpod_root: server_uri.to_string(),
        civitai_root: server_uri.to_string(),
        hf_root: server_uri.to_string(),
        poll_interval: Duration::from_millis(10),
        ..CoreConfig::production(dir.path().to_path_buf())
    };
    // A real database file, so its bytes can be inspected.
    let db = Db::open(&dir.path().join("studio.db")).unwrap();
    let core = Core::new(Registry::embedded(), db, settings, sink.clone(), cfg).unwrap();
    Harness { core, sink, dir }
}

fn png(seed: u8, w: u32, h: u32) -> Vec<u8> {
    let img = image::RgbImage::from_fn(w, h, |x, y| image::Rgb([seed, (x % 256) as u8, (y % 256) as u8]));
    let mut buf = Vec::new();
    image::DynamicImage::ImageRgb8(img)
        .write_to(&mut std::io::Cursor::new(&mut buf), image::ImageFormat::Png)
        .unwrap();
    buf
}

fn jpeg(seed: u8) -> Vec<u8> {
    let img = image::RgbImage::from_pixel(16, 16, image::Rgb([seed, 1, 2]));
    let mut buf = Vec::new();
    image::DynamicImage::ImageRgb8(img)
        .write_to(&mut std::io::Cursor::new(&mut buf), image::ImageFormat::Jpeg)
        .unwrap();
    buf
}

fn mp4(seed: u8) -> Vec<u8> {
    let mut v = b"\0\0\0\x18ftypisom\0\0\0\0isommp41".to_vec();
    v.extend((0..5000u32).map(|i| (i as u8).wrapping_mul(seed)));
    v
}

fn record(id: &str, kind: &str, path: &Path, created: &str) -> ImageRecord {
    ImageRecord {
        id: id.into(),
        path: path.to_string_lossy().into_owned(),
        model: if kind == KIND_VIDEO { "h3" } else { "chroma" }.into(),
        prompt: format!("{PROMPT} #{id}"),
        negative_prompt: "blurry".into(),
        aspect_ratio: "1:1".into(),
        width: 64,
        height: 48,
        seed: 7,
        steps: 4,
        cfg: 1.0,
        references: vec![],
        loras: vec![],
        created_at: created.into(),
        duration_ms: Some(10),
        runpod: RunpodTimes::default(),
        init_image: None,
        denoise: None,
        kind: kind.into(),
        duration_s: None,
        fps: None,
        has_audio: None,
        poster_path: None,
        vault: false,
        thumb_path: None,
    }
}

fn walk(dir: &Path) -> Vec<PathBuf> {
    let mut out = vec![];
    if let Ok(rd) = std::fs::read_dir(dir) {
        for e in rd.flatten() {
            let p = e.path();
            if p.is_dir() {
                out.extend(walk(&p));
            } else {
                out.push(p);
            }
        }
    }
    out
}

fn contains(hay: &[u8], needle: &[u8]) -> bool {
    !needle.is_empty() && hay.windows(needle.len()).any(|w| w == needle)
}

fn files_in(dir: &Path) -> usize {
    walk(dir).len()
}

/// Every byte of the data dir outside `vault/` plus the sqlite files.
fn plaintext_areas(h: &Harness) -> Vec<(PathBuf, Vec<u8>)> {
    walk(h.dir.path())
        .into_iter()
        .filter(|p| !p.starts_with(h.core.cfg.vault_dir()))
        .map(|p| {
            let b = std::fs::read(&p).unwrap();
            (p, b)
        })
        .collect()
}

fn db_rows(h: &Harness) -> Vec<ImageRecord> {
    h.core.db.lock().unwrap().list_images(500, None).unwrap().0
}

/// Seeds the general gallery: 4 images (two share reference A; #2 also has
/// reference B and a start image), 1 video with a poster, and a record whose
/// media file is missing. Returns every plaintext file keyed by its path.
fn seed_general(h: &Harness) -> HashMap<String, Vec<u8>> {
    let imgs = h.core.cfg.images_dir();
    let vids = h.core.cfg.videos_dir();
    let refs = h.core.cfg.references_dir();
    let mut files = HashMap::new();
    let mut put = |p: PathBuf, b: Vec<u8>| {
        std::fs::write(&p, &b).unwrap();
        files.insert(p.to_string_lossy().into_owned(), b);
        p.to_string_lossy().into_owned()
    };
    let ref_a = put(refs.join("aaaaaaaa-0000-0000-0000-000000000001.jpg"), jpeg(1));
    let ref_b = put(refs.join("bbbbbbbb-0000-0000-0000-000000000002.jpg"), jpeg(2));
    let start = put(refs.join("cccccccc-0000-0000-0000-000000000003.png"), png(3, 20, 10));
    let db = h.core.db.lock().unwrap();
    for i in 0..4u8 {
        let p = put(imgs.join(format!("img{i}.png")), png(10 + i, 64, 48));
        let mut r = record(&format!("img{i}"), KIND_IMAGE, Path::new(&p), &format!("2026-01-0{}T00:00:00Z", i + 1));
        if i < 2 {
            r.references = vec![ref_a.clone()];
        }
        if i == 2 {
            r.references = vec![ref_b.clone()];
            r.init_image = Some(start.clone());
            r.denoise = Some(0.4);
        }
        db.insert_image(&r).unwrap();
    }
    let v = put(vids.join("vid.mp4"), mp4(5));
    let poster = put(vids.join("vid.jpg"), jpeg(6));
    let mut r = record("vid", KIND_VIDEO, Path::new(&v), "2026-01-05T00:00:00Z");
    r.poster_path = Some(poster);
    r.duration_s = Some(5.0);
    r.fps = Some(24.0);
    r.has_audio = Some(true);
    db.insert_image(&r).unwrap();
    // A record whose file is gone: migration must skip it, not crash.
    let mut broken = record("broken", KIND_IMAGE, &imgs.join("missing.png"), "2026-01-06T00:00:00Z");
    broken.prompt = "a record whose file is gone".into();
    db.insert_image(&broken).unwrap();
    drop(db);
    files
}

#[test]
fn migration_moves_everything_resumes_after_interruption_and_verifies_before_deleting() {
    let h = harness("http://127.0.0.1:1");
    let originals = seed_general(&h);
    assert_eq!(db_rows(&h).len(), 6);
    let v = &h.core.vault;
    v.create(PW, KdfParams::fast()).unwrap();

    // Crash after two items (oldest first: img0, img1).
    let err = vault_migrate::migrate(&h.core, MigrateOptions { stop_after: Some(2) }).unwrap_err();
    assert!(err.contains("interrupted"));
    assert!(vault_migrate::migration_pending(&h.core));
    assert!(v.status().migration_pending);
    let rows = db_rows(&h);
    let ids: Vec<&str> = rows.iter().map(|r| r.id.as_str()).collect();
    assert_eq!(ids, ["broken", "vid", "img3", "img2"], "img0/img1 moved, rest untouched");
    let imgs = h.core.cfg.images_dir();
    assert!(!imgs.join("img0.png").exists() && !imgs.join("img1.png").exists());
    assert!(imgs.join("img2.png").exists() && imgs.join("img3.png").exists());
    let refs = h.core.cfg.references_dir();
    assert!(!refs.join("aaaaaaaa-0000-0000-0000-000000000001.jpg").exists(), "shared ref A deleted with its last user");
    assert!(refs.join("bbbbbbbb-0000-0000-0000-000000000002.jpg").exists());
    assert!(refs.join("cccccccc-0000-0000-0000-000000000003.png").exists());
    assert_eq!(v.items().unwrap().len(), 2);
    // The journal holds ids only.
    let journal = std::fs::read(v.journal_path()).unwrap();
    assert!(!contains(&journal, PROMPT.as_bytes()));

    // Lock + unlock: the migration is still pending and resumes.
    v.lock();
    assert!(vault_migrate::migrate(&h.core, MigrateOptions::default()).is_err(), "needs the key to verify");
    v.unlock(PW).unwrap();
    let report = vault_migrate::migrate(&h.core, MigrateOptions::default()).unwrap();
    assert_eq!(report.phase, "done");
    assert_eq!(report.errors, 1, "the broken record is skipped");
    assert_eq!((report.done, report.total), (6, 6), "every pending id is accounted for");
    assert_eq!((report.counts.images, report.counts.videos, report.counts.posters), (2, 1, 1));
    assert_eq!((report.counts.start_images, report.counts.references), (1, 1));
    assert!(!vault_migrate::migration_pending(&h.core));
    assert!(!v.journal_path().exists());
    let rows = db_rows(&h);
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0].id, "broken");
    assert_eq!(files_in(&imgs), 0);
    assert_eq!(files_in(&h.core.cfg.videos_dir()), 0);
    assert_eq!(files_in(&refs), 0);

    // Every item decrypts back to the original bytes, with the right shape.
    let items = v.items().unwrap();
    assert_eq!(items.len(), 5);
    let created: Vec<&str> = items.iter().map(|i| i.created_at.as_str()).collect();
    assert_eq!(created[0], "2026-01-05T00:00:00Z", "newest first");
    for item in &items {
        let src = item.source_id.clone().unwrap();
        let orig_path = if src == "vid" {
            h.core.cfg.videos_dir().join("vid.mp4")
        } else {
            imgs.join(format!("{src}.png"))
        };
        let orig = &originals[&orig_path.to_string_lossy().into_owned()];
        assert_eq!(v.open_blob(&item.media.id).unwrap().as_slice(), orig.as_slice());
        assert!(item.prompt.contains(PROMPT) && item.prompt.ends_with(&format!("#{src}")));
        if src == "vid" {
            assert_eq!(item.kind, KIND_VIDEO);
            assert_eq!(item.media.ext, "mp4");
            let poster = item.poster.as_ref().unwrap();
            assert_eq!(poster.ext, "jpg");
            assert!(v.open_blob(&poster.id).unwrap().as_slice() == originals[&h.core.cfg.videos_dir().join("vid.jpg").to_string_lossy().into_owned()].as_slice());
            assert!(item.thumb.is_none());
        } else {
            assert_eq!(item.kind, KIND_IMAGE);
            let thumb = item.thumb.as_ref().expect("images get a thumbnail");
            assert!(image::load_from_memory(&v.open_blob(&thumb.id).unwrap()).is_ok());
        }
        if src == "img2" {
            let init = item.init_image.as_ref().unwrap();
            assert_eq!(v.open_blob(&init.id).unwrap().as_slice(), png(3, 20, 10).as_slice());
            assert_eq!(item.references.len(), 1);
            assert_eq!(v.open_blob(&item.references[0].id).unwrap().as_slice(), jpeg(2).as_slice());
            assert_eq!(item.denoise, Some(0.4));
        }
        let rec = item.to_record();
        assert!(rec.vault);
        assert!(BlobRef::parse(&rec.path).is_some());
        assert!(rec.thumb_path.is_some());
    }
    // Progress events: running → interrupted, then running → done.
    let phases: Vec<String> = h.sink.migration.lock().unwrap().iter().map(|p| p.phase.clone()).collect();
    assert!(phases.contains(&"error".to_string()) && phases.contains(&"encrypting".to_string()) && phases.contains(&"cleaning".to_string()));
    assert_eq!(phases.last().unwrap(), "done");
    assert_eq!(h.sink.vault.lock().unwrap().last().unwrap().item_count, Some(5));

    // Nothing readable about the items remains outside the vault (plaintext
    // areas + sqlite), and the vault dir has no plaintext either.
    for (p, bytes) in plaintext_areas(&h) {
        assert!(!contains(&bytes, PROMPT.as_bytes()), "{}", p.display());
        for item in &items {
            assert!(!contains(&bytes, item.id.as_bytes()), "{} leaks item id", p.display());
            assert!(!contains(&bytes, item.media.id.as_bytes()), "{} leaks blob id", p.display());
        }
    }
    for p in walk(&h.core.cfg.vault_dir()) {
        let bytes = std::fs::read(&p).unwrap();
        assert!(!contains(&bytes, PROMPT.as_bytes()), "{}", p.display());
        for orig in originals.values() {
            assert!(!contains(&bytes, &orig[..orig.len().min(64)]), "{} holds plaintext media", p.display());
        }
    }
}

#[test]
fn migration_keeps_originals_when_the_encrypted_record_cannot_be_written() {
    use std::os::unix::fs::PermissionsExt;
    let h = harness("http://127.0.0.1:1");
    seed_general(&h);
    let v = &h.core.vault;
    v.create(PW, KdfParams::fast()).unwrap();
    let items_dir = v.dir().join("items");
    std::fs::set_permissions(&items_dir, std::fs::Permissions::from_mode(0o500)).unwrap();
    let report = vault_migrate::migrate(&h.core, MigrateOptions::default()).unwrap();
    std::fs::set_permissions(&items_dir, std::fs::Permissions::from_mode(0o700)).unwrap();
    assert_eq!(report.errors, 6, "every item failed to record");
    assert_eq!(db_rows(&h).len(), 6, "no row deleted");
    assert_eq!(files_in(&h.core.cfg.images_dir()), 4);
    assert_eq!(files_in(&h.core.cfg.videos_dir()), 2);
    assert_eq!(files_in(&h.core.cfg.references_dir()), 3);
    assert!(v.items().unwrap().is_empty());
    // Writable again → a plain re-run migrates them.
    let report = vault_migrate::migrate(&h.core, MigrateOptions::default()).unwrap();
    assert_eq!((report.done, report.errors), (6, 1));
    assert_eq!(v.items().unwrap().len(), 5);
}

#[test]
fn move_to_vault_and_back_to_general() {
    let h = harness("http://127.0.0.1:1");
    let originals = seed_general(&h);
    let v = &h.core.vault;
    assert!(vault_migrate::move_to_vault(&h.core, "img2").is_err(), "no vault yet");
    v.create(PW, KdfParams::fast()).unwrap();
    v.lock();
    assert!(vault_migrate::move_to_vault(&h.core, "img2").unwrap_err().starts_with("VAULT_LOCKED"));
    v.unlock(PW).unwrap();

    let rec = vault_migrate::move_to_vault(&h.core, "img2").unwrap();
    assert!(rec.vault && rec.init_image.as_deref().unwrap().starts_with("vault://localhost/"));
    assert!(h.core.db.lock().unwrap().get_image("img2").unwrap().is_none());
    assert!(!h.core.cfg.images_dir().join("img2.png").exists());
    let refs = h.core.cfg.references_dir();
    assert!(!refs.join("bbbbbbbb-0000-0000-0000-000000000002.jpg").exists(), "only img2 used B");
    assert!(!refs.join("cccccccc-0000-0000-0000-000000000003.png").exists());
    // img0 → ref A is still used by img1, so A stays.
    vault_migrate::move_to_vault(&h.core, "img0").unwrap();
    assert!(refs.join("aaaaaaaa-0000-0000-0000-000000000001.jpg").exists());
    assert_eq!(v.items().unwrap().len(), 2);
    assert_eq!(db_rows(&h).len(), 4);

    assert!(vault_migrate::move_to_general(&h.core, "nope").is_err());
    let back = vault_migrate::move_to_general(&h.core, &rec.id).unwrap();
    assert!(!back.vault && back.thumb_path.is_none());
    assert_eq!(back.id, rec.id);
    assert_eq!(back.prompt, format!("{PROMPT} #img2"));
    assert_eq!(std::fs::read(&back.path).unwrap(), originals[&h.core.cfg.images_dir().join("img2.png").to_string_lossy().into_owned()]);
    assert!(Path::new(&back.path).starts_with(h.core.cfg.images_dir()));
    let init = back.init_image.clone().unwrap();
    assert!(Path::new(&init).starts_with(&refs));
    assert_eq!(std::fs::read(&init).unwrap(), png(3, 20, 10));
    assert_eq!(back.references.len(), 1);
    assert_eq!(std::fs::read(&back.references[0]).unwrap(), jpeg(2));
    assert_eq!(h.core.db.lock().unwrap().get_image(&back.id).unwrap(), Some(back.clone()));
    assert!(v.item(&rec.id).is_err(), "item removed");
    assert_eq!(v.items().unwrap().len(), 1);
    let media = BlobRef::parse(&rec.path).unwrap();
    assert!(v.open_blob(&media.id).is_err(), "blobs removed");
    // export decrypts into a user-chosen file
    let remaining = v.items().unwrap()[0].clone();
    let dest = h.dir.path().join("export.png");
    vault_migrate::export_item(&h.core, &remaining.id, &dest).unwrap();
    assert_eq!(std::fs::read(&dest).unwrap(), originals[&h.core.cfg.images_dir().join("img0.png").to_string_lossy().into_owned()]);
    v.lock();
    assert!(vault_migrate::export_item(&h.core, &remaining.id, &dest).is_err());
}

// ----- vault jobs against a mocked RunPod -----

/// Answers every status poll with a completed job whose output depends on the action sent to /run.
struct Completed {
    image: Vec<u8>,
    video: Vec<u8>,
    poster: Vec<u8>,
}
impl Respond for Completed {
    fn respond(&self, req: &Request) -> ResponseTemplate {
        let b64 = |b: &[u8]| base64::engine::general_purpose::STANDARD.encode(b);
        let video = req.url.path().ends_with("/rp-video");
        let out = if video {
            json!({"video": {"base64": b64(&self.video), "width": 64, "height": 32, "fps": 24, "durationS": 2.0, "hasAudio": true},
                   "poster": {"base64": b64(&self.poster)}, "timings": {"totalMs": 900}})
        } else {
            json!({"image": {"base64": b64(&self.image), "seed": 5, "width": 64, "height": 48}, "timings": {"totalMs": 300}})
        };
        ResponseTemplate::new(200).set_body_json(json!({"status": "COMPLETED", "delayTime": 1, "executionTime": 2, "output": out}))
    }
}

/// /run answers with an id that encodes the action, so /status can pick the output.
struct RunByAction;
impl Respond for RunByAction {
    fn respond(&self, req: &Request) -> ResponseTemplate {
        let body: Value = req.body_json().unwrap();
        let id = if body["input"]["action"] == "generate_video" { "rp-video" } else { "rp-image" };
        ResponseTemplate::new(200).set_body_json(json!({"id": id, "status": "IN_QUEUE"}))
    }
}

async fn wait_job(sink: &Collect, job_id: &str) -> Job {
    for _ in 0..500 {
        if let Some(j) = sink
            .jobs
            .lock()
            .unwrap()
            .iter()
            .rev()
            .find(|j| j.job_id == job_id && matches!(j.status, JobState::Completed | JobState::Failed | JobState::Cancelled))
        {
            return j.clone();
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    panic!("job did not finish");
}

async fn mock_server(image: Vec<u8>, video: Vec<u8>, poster: Vec<u8>) -> MockServer {
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/v2/ep1/run"))
        .respond_with(RunByAction)
        .mount(&server)
        .await;
    Mock::given(method("GET"))
        .and(path_regex("/v2/ep1/status/.*"))
        .respond_with(Completed { image, video, poster })
        .mount(&server)
        .await;
    server
}

#[tokio::test]
async fn vault_jobs_never_write_plaintext_and_seal_while_locked() {
    let out_png = png(200, 64, 48);
    let server = mock_server(out_png.clone(), mp4(9), jpeg(9)).await;
    let h = harness(&server.uri());
    let v = &h.core.vault;

    // No vault yet: a vault job is refused before anything is queued.
    let mut r = GenerateRequest {
        model: "chroma".into(),
        prompt: PROMPT.into(),
        aspect_ratio: "1:1".into(),
        count: 1,
        seed: Some(5),
        destination: Destination::Vault,
        ..Default::default()
    };
    assert!(jobs::generate(&h.core, r.clone()).unwrap_err().starts_with("NO_VAULT"));
    v.create(PW, KdfParams::fast()).unwrap();

    // A plain imported start image is moved into the vault for a vault job.
    let start_png = png(1, 30, 20);
    let start = app_lib::references::import_bytes(&h.core.cfg.references_dir(), &start_png).unwrap();
    assert_eq!(files_in(&h.core.cfg.references_dir()), 1);
    r.init_image_id = Some(start.ref_id.clone());
    r.denoise = Some(0.5);
    let id = jobs::generate(&h.core, r.clone()).unwrap();
    let job = wait_job(&h.sink, &id).await;
    assert_eq!(job.status, JobState::Completed, "{:?}", job.error);
    assert_eq!(job.destination, Destination::Vault);
    let rec = &job.images[0];
    assert!(rec.vault, "{rec:?}");
    assert!(rec.path.starts_with("vault://localhost/") && rec.path.ends_with(".png"));
    assert!(rec.thumb_path.as_deref().unwrap().starts_with("vault://localhost/"));
    assert!(rec.init_image.as_deref().unwrap().starts_with("vault://localhost/"));
    assert_eq!(rec.denoise, Some(0.5));
    assert_eq!(rec.seed, 5);
    assert_eq!(files_in(&h.core.cfg.images_dir()), 0, "no plaintext output");
    assert_eq!(files_in(&h.core.cfg.references_dir()), 0, "the plain start image moved into the vault");
    assert!(db_rows(&h).is_empty(), "nothing in SQLite");
    let items = v.items().unwrap();
    assert_eq!(items.len(), 1);
    assert_eq!(items[0].prompt, PROMPT);
    assert_eq!(v.open_blob(&items[0].media.id).unwrap().as_slice(), out_png.as_slice());
    let init = items[0].init_image.as_ref().unwrap();
    assert_eq!(v.open_blob(&init.id).unwrap().as_slice(), app_lib::references::process(&start_png).unwrap().0.as_slice());
    // The worker received the processed start image.
    let run: Value = server.received_requests().await.unwrap().iter().find(|q| q.url.path().ends_with("/run")).unwrap().body_json().unwrap();
    assert_eq!(run["input"]["denoise"], json!(0.5));
    assert!(run["input"]["initImage"]["base64"].as_str().unwrap().len() > 100);

    // A vault reference may not feed a general job.
    let mut bad = r.clone();
    bad.destination = Destination::General;
    bad.init_image_id = rec.init_image.clone();
    assert!(jobs::generate(&h.core, bad).unwrap_err().contains("vault"));

    // Locked: a vault job still finishes, sealed with the public key only.
    v.lock();
    h.sink.jobs.lock().unwrap().clear();
    let mut locked_req = r.clone();
    locked_req.init_image_id = None;
    locked_req.prompt = format!("{PROMPT} while locked");
    let id = jobs::generate(&h.core, locked_req).unwrap();
    let job = wait_job(&h.sink, &id).await;
    assert_eq!(job.status, JobState::Completed, "{:?}", job.error);
    assert_eq!((job.completed, job.images.len()), (1, 0), "counted, but nothing of it leaves the vault while locked");
    for j in h.sink.jobs.lock().unwrap().iter() {
        assert!(j.images.is_empty());
        assert!(!serde_json::to_string(j).unwrap().contains(PROMPT));
    }
    assert!(v.items().is_err(), "still locked");
    assert_eq!(files_in(&h.core.cfg.images_dir()), 0);
    assert!(db_rows(&h).is_empty());
    v.unlock(PW).unwrap();
    let items = v.items().unwrap();
    assert_eq!(items.len(), 2);
    assert!(items.iter().any(|i| i.prompt.ends_with("while locked")));

    // The vault image as the start image of another vault job (img2img, so it
    // runs on the mocked serverless worker): decrypted in memory, sent
    // downscaled, and referenced in place.
    let mut from_vault = r.clone();
    from_vault.init_image_id = None;
    from_vault.init_image_vault_id = Some(rec.id.clone());
    from_vault.prompt = format!("{PROMPT} from vault");
    let mut general = from_vault.clone();
    general.destination = Destination::General;
    assert!(jobs::generate(&h.core, general).unwrap_err().contains("vault"));
    let id = jobs::generate(&h.core, from_vault).unwrap();
    let job = wait_job(&h.sink, &id).await;
    assert_eq!(job.status, JobState::Completed, "{:?}", job.error);
    let rec3 = &job.images[0];
    assert_eq!(rec3.init_image.as_deref(), Some(rec.path.as_str()), "the vault image is referenced in place");
    let runs: Vec<Value> = server.received_requests().await.unwrap().iter().filter(|q| q.url.path().ends_with("/run")).map(|q| q.body_json().unwrap()).collect();
    let last = runs.last().unwrap();
    let sent = base64::engine::general_purpose::STANDARD.decode(last["input"]["initImage"]["base64"].as_str().unwrap()).unwrap();
    assert_eq!(sent, app_lib::references::process(&out_png).unwrap().0);
    assert_eq!(files_in(&h.core.cfg.images_dir()), 0);
    assert!(db_rows(&h).is_empty());

    // Video jobs run on the pod profile (not mockable here): the vault start
    // image rules are checked before any pod call, and the output sealing is
    // exercised through the same `seal_output` the job manager uses.
    let vreq = VideoRequest {
        model: "h3".into(),
        prompt: format!("{PROMPT} video"),
        init_image_vault_id: Some(rec.id.clone()),
        duration_s: 2.0,
        fps: 24.0,
        resolution: "864x480".into(),
        seed: Some(3),
        audio: true,
        destination: Destination::General,
        ..Default::default()
    };
    assert!(jobs::generate_video(&h.core, vreq).unwrap_err().contains("vault"));
    let mut vtemplate = record("", KIND_VIDEO, Path::new(""), "2026-02-01T00:00:00Z");
    vtemplate.init_image = Some(rec.path.clone());
    vtemplate.duration_s = Some(2.0);
    let vrec = vault_migrate::seal_output(&h.core, &vtemplate, &mp4(9), Some(&jpeg(9))).unwrap();
    assert!(vrec.vault && vrec.kind == KIND_VIDEO);
    assert!(vrec.path.ends_with(".mp4") && vrec.poster_path.as_deref().unwrap().starts_with("vault://localhost/"));
    assert_eq!(vrec.thumb_path, vrec.poster_path, "videos use the poster as thumbnail");
    assert_eq!(vrec.init_image.as_deref(), Some(rec.path.as_str()));
    assert_eq!(files_in(&h.core.cfg.videos_dir()), 0);
    assert!(db_rows(&h).is_empty());
    let vitem = v.item(&vrec.id).unwrap();
    assert_eq!(v.open_blob(&vitem.media.id).unwrap().as_slice(), mp4(9).as_slice());
    assert_eq!(v.open_blob(&vitem.poster.as_ref().unwrap().id).unwrap().as_slice(), jpeg(9).as_slice());

    // vault:// serves the video with ranges and refuses when locked.
    let media = BlobRef::parse(&vrec.path).unwrap();
    let served = v.serve(&format!("/{}.mp4", media.id), Some("bytes=100-199"));
    assert_eq!(served.status, 206);
    assert_eq!(served.body, &mp4(9)[100..200]);
    assert!(served.headers.contains(&("Content-Type", "video/mp4".to_string())));
    v.lock();
    assert_eq!(v.serve(&format!("/{}.mp4", media.id), None).status, 403);

    // Nothing outside vault/ holds plaintext: no output bytes, prompt, item or blob ids.
    v.unlock(PW).unwrap();
    let items = v.items().unwrap();
    assert_eq!(items.len(), 4);
    for (p, bytes) in plaintext_areas(&h) {
        assert!(!contains(&bytes, PROMPT.as_bytes()), "{}", p.display());
        assert!(!contains(&bytes, &out_png[..64]), "{}", p.display());
        assert!(!contains(&bytes, &mp4(9)[..64]), "{}", p.display());
        assert!(!contains(&bytes, b"vault"), "{} mentions the vault", p.display());
        for i in &items {
            assert!(!contains(&bytes, i.id.as_bytes()), "{}", p.display());
            for b in i.blobs() {
                assert!(!contains(&bytes, b.id.as_bytes()), "{}", p.display());
            }
        }
    }
    for p in walk(&h.core.cfg.vault_dir()) {
        let bytes = std::fs::read(&p).unwrap();
        assert!(!contains(&bytes, PROMPT.as_bytes()), "{}", p.display());
        assert!(!contains(&bytes, &out_png[..64]), "{}", p.display());
        assert!(!contains(&bytes, &mp4(9)[..64]), "{}", p.display());
    }
    // The sqlite file exists and has only the known tables (no vault table).
    h.core.db.lock().unwrap().scrub().unwrap();
    let db_bytes = std::fs::read(h.dir.path().join("studio.db")).unwrap();
    assert!(contains(&db_bytes, b"CREATE TABLE images"));
    assert!(!contains(&db_bytes, b"vault"));
}

#[test]
fn locked_vault_hides_items_from_every_query_and_touch_resets_auto_lock() {
    let h = harness("http://127.0.0.1:1");
    seed_general(&h);
    let v = &h.core.vault;
    v.create(PW, KdfParams::fast()).unwrap();
    vault_migrate::migrate(&h.core, MigrateOptions::default()).unwrap();
    let item = v.items().unwrap()[0].clone();
    v.set_auto_lock(1);
    assert!(v.lock_if_idle(std::time::Instant::now() + Duration::from_secs(61)));
    let s = v.status();
    assert!(!s.unlocked && s.exists && s.item_count.is_none() && !s.migration_pending);
    assert!(v.items().is_err() && v.item(&item.id).is_err());
    assert!(vault_migrate::move_to_general(&h.core, &item.id).is_err());
    assert!(vault_migrate::export_item(&h.core, &item.id, &h.dir.path().join("x.png")).is_err());
    assert!(!h.dir.path().join("x.png").exists());
    assert_eq!(v.serve(&format!("/{}", item.media.id), None).status, 403);
    // A job's gallery start image from the vault needs the key.
    let err = jobs::generate_video(
        &h.core,
        VideoRequest {
            model: "h3".into(),
            prompt: "p".into(),
            init_image_vault_id: Some(item.id.clone()),
            duration_s: 2.0,
            fps: 24.0,
            resolution: "864x480".into(),
            destination: Destination::Vault,
            ..Default::default()
        },
    )
    .unwrap_err();
    assert!(err.starts_with("VAULT_LOCKED"), "{err}");
}
