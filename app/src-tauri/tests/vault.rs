//! Vault (spec v6) against temp dirs only: the one-time migration (resume,
//! verify-before-delete), moves, vault jobs that never write plaintext, the
//! `vault://` scheme, and a SQLite file that holds nothing about vault items.

use app_lib::db::{Db, ImageRecord, RunpodTimes, KIND_IMAGE, KIND_VIDEO};
use app_lib::jobs::{self, Destination, GenerateRequest, Job, JobState, VideoRequest};
use app_lib::registry::Registry;
use app_lib::pod::{self, GpuStatus};
use app_lib::settings::{MemoryStore, SecretStore, Settings, ACCOUNT_POD_TOKEN, ACCOUNT_RUNPOD};
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
    store.set(ACCOUNT_POD_TOKEN, Some("podtok")).unwrap();
    let settings = Settings::new(store, HashMap::new(), dir.path().join("settings.json"));
    let sink = Arc::new(Collect::default());
    let cfg = CoreConfig {
        data_dir: dir.path().to_path_buf(),
        runpod_root: server_uri.to_string(),
        civitai_root: server_uri.to_string(),
        hf_root: server_uri.to_string(),
        poll_interval: Duration::from_millis(10),
        // Never the real RunPod API: REST and the pod's worker API are mocked.
        rest_root: server_uri.to_string(),
        pod_proxy_template: format!("{server_uri}/proxy/{{podId}}"),
        pod_poll_interval: Duration::from_millis(10),
        pod_start_timeout: Duration::from_secs(5),
        gpu_wait_timeout: Duration::from_millis(300),
        pod_stop_timeout: Duration::from_secs(2),
        rest_timeout: Duration::from_secs(2),
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
        story_id: None,
        shot_id: None,
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

/// Every byte of the data dir outside the vault's sealed folders (`vault/blobs`,
/// `vault/items`, `vault/stories`, `vault/characters`) plus the sqlite files.
fn plaintext_areas(h: &Harness) -> Vec<(PathBuf, Vec<u8>)> {
    let vault = h.core.cfg.vault_dir();
    let sealed = ["blobs", "items", "stories", "characters"].map(|d| vault.join(d));
    walk(h.dir.path())
        .into_iter()
        .filter(|p| !sealed.iter().any(|d| p.starts_with(d)))
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

/// The RunPod REST API with a running image pod `pod1`, and that pod's worker.
async fn mock_server(image: Vec<u8>, video: Vec<u8>, poster: Vec<u8>) -> MockServer {
    let server = MockServer::start().await;
    let pod = json!({"id": "pod1", "name": "image-studio-gpu", "status": "RUNNING", "cost": 2.39,
        "gpu": {"id": "NVIDIA RTX PRO 6000 Blackwell Server Edition", "count": 1},
        "startedAt": "2026-10-09T10:00:05Z"});
    Mock::given(method("GET"))
        .and(path("/v2/pods"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({"pods": [pod.clone()], "pagination": {"hasNextPage": false}})))
        .mount(&server)
        .await;
    Mock::given(method("GET"))
        .and(path("/v2/pods/pod1"))
        .respond_with(ResponseTemplate::new(200).set_body_json(pod))
        .mount(&server)
        .await;
    Mock::given(method("GET"))
        .and(path("/proxy/pod1/ping"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({"status": "ok"})))
        .mount(&server)
        .await;
    Mock::given(method("GET"))
        .and(path("/proxy/pod1/health"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({"jobs": {"inQueue": 0, "inProgress": 0},
            "workers": {"idle": 1, "running": 0}, "ready": true})))
        .mount(&server)
        .await;
    Mock::given(method("POST"))
        .and(path("/proxy/pod1/run"))
        .respond_with(RunByAction)
        .mount(&server)
        .await;
    Mock::given(method("GET"))
        .and(path_regex("/proxy/pod1/status/.*"))
        .respond_with(Completed { image, video, poster })
        .mount(&server)
        .await;
    server
}

/// Adopts the mocked running image pod.
async fn adopt_running_pod(h: &Harness) {
    pod::adopt(&h.core).await.unwrap();
    for _ in 0..500 {
        if pod::state(&h.core).status == GpuStatus::Running {
            return;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    panic!("the mocked pod never became ready");
}

#[tokio::test]
async fn vault_jobs_never_write_plaintext_and_seal_while_locked() {
    let out_png = png(200, 64, 48);
    let server = mock_server(out_png.clone(), mp4(9), jpeg(9)).await;
    let h = harness(&server.uri());
    adopt_running_pod(&h).await;
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
    // runs on the mocked pod worker): decrypted in memory, sent
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

/// Regression (seen on real data): a video made image→video from a gallery
/// image keeps that image's file as its start image. The image migrates
/// first and its file is deleted; the video must still move, with its start
/// image taken from the image's vault copy. A start image that is gone
/// entirely must not keep the video out of the vault either.
#[test]
fn migration_moves_a_video_whose_start_image_was_a_migrated_gallery_image() {
    let h = harness("http://127.0.0.1:1");
    let imgs = h.core.cfg.images_dir();
    let vids = h.core.cfg.videos_dir();
    let src_png = png(42, 64, 48);
    let src_path = imgs.join("src-image.png");
    std::fs::write(&src_path, &src_png).unwrap();
    let v1 = vids.join("v1.mp4");
    let v2 = vids.join("v2.mp4");
    std::fs::write(&v1, mp4(1)).unwrap();
    std::fs::write(&v2, mp4(2)).unwrap();
    {
        let db = h.core.db.lock().unwrap();
        db.insert_image(&record("src-image", KIND_IMAGE, &src_path, "2026-01-01T00:00:00Z")).unwrap();
        let mut a = record("v1", KIND_VIDEO, &v1, "2026-01-02T00:00:00Z");
        a.init_image = Some(src_path.to_string_lossy().into_owned());
        db.insert_image(&a).unwrap();
        let mut b = record("v2", KIND_VIDEO, &v2, "2026-01-03T00:00:00Z");
        b.init_image = Some(imgs.join("gone.png").to_string_lossy().into_owned());
        db.insert_image(&b).unwrap();
    }
    let v = &h.core.vault;
    v.create(PW, KdfParams::fast()).unwrap();
    let report = vault_migrate::migrate(&h.core, MigrateOptions::default()).unwrap();
    assert_eq!(report.errors, 0, "{report:?}");
    assert!(db_rows(&h).is_empty(), "every record moved");
    assert_eq!(files_in(&imgs) + files_in(&vids), 0, "no plaintext left");

    let v1_item = v.find_by_source("v1").unwrap().expect("v1 in the vault");
    let start = v1_item.init_image.expect("start image kept");
    assert_eq!(&*v.open_blob(&start.id).unwrap(), &src_png[..]);
    let src_item = v.find_by_source("src-image").unwrap().unwrap();
    assert_ne!(start.id, src_item.media.id, "a copy, so deleting one item never breaks the other");

    let v2_item = v.find_by_source("v2").unwrap().expect("v2 in the vault");
    assert!(v2_item.init_image.is_none());
    assert_eq!(&*v.open_blob(&v2_item.media.id).unwrap(), &mp4(2)[..]);
}

#[test]
fn auto_lock_can_only_change_while_unlocked() {
    let h = harness("http://127.0.0.1:1");
    // No vault: refused.
    assert!(h.core.set_vault_auto_lock(20).unwrap_err().starts_with("VAULT_LOCKED"));
    h.core.vault.create(PW, KdfParams::fast()).unwrap();
    let st = h.core.set_vault_auto_lock(20).unwrap();
    assert_eq!(st.auto_lock_minutes, 20);
    assert_eq!(h.core.settings.vault_auto_lock_minutes(), 20);
    h.core.vault.lock();
    // Locked: refused, and nothing changes (memory or settings file).
    assert!(h.core.set_vault_auto_lock(240).unwrap_err().starts_with("VAULT_LOCKED"));
    assert_eq!(h.core.settings.vault_auto_lock_minutes(), 20);
    assert_eq!(h.core.vault.status().auto_lock_minutes, 20);
    h.core.vault.unlock(PW).unwrap();
    assert!(h.core.set_vault_auto_lock(0).is_err(), "range still checked");
    assert_eq!(h.core.set_vault_auto_lock(30).unwrap().auto_lock_minutes, 30);
}

#[test]
fn changing_the_password_to_the_same_one_is_refused() {
    let h = harness("http://127.0.0.1:1");
    let v = &h.core.vault;
    v.create(PW, KdfParams::fast()).unwrap();
    let e = v.change_password(PW, PW, KdfParams::fast()).unwrap_err();
    assert!(e.starts_with("SAME_PASSWORD"), "{e}");
    // The password still works.
    v.lock();
    v.unlock(PW).unwrap();
}

/// Stories v1: a plain image plus story media (a take and an assembled result).
fn seed_story_media(h: &Harness) {
    let imgs = h.core.cfg.images_dir();
    let vids = h.core.cfg.videos_dir();
    std::fs::create_dir_all(&imgs).unwrap();
    std::fs::create_dir_all(&vids).unwrap();
    let db = h.core.db.lock().unwrap();
    let p = imgs.join("plain.png");
    std::fs::write(&p, png(1, 8, 8)).unwrap();
    db.insert_image(&record("plain", KIND_IMAGE, &p, "2026-01-01T00:00:00Z")).unwrap();
    let t = vids.join("take.mp4");
    std::fs::write(&t, mp4(2)).unwrap();
    let mut take = record("take", KIND_VIDEO, &t, "2026-01-02T00:00:00Z");
    take.story_id = Some("s1".into());
    take.shot_id = Some("sh1".into());
    db.insert_image(&take).unwrap();
    let r = vids.join("result.mp4");
    std::fs::write(&r, mp4(3)).unwrap();
    let mut result = record("result", KIND_VIDEO, &r, "2026-01-03T00:00:00Z");
    result.story_id = Some("s1".into());
    db.insert_image(&result).unwrap();
}

#[test]
fn migration_leaves_story_media_in_general() {
    let h = harness("http://127.0.0.1:1");
    seed_story_media(&h);
    h.core.vault.create(PW, KdfParams::fast()).unwrap();
    let report = vault_migrate::migrate(&h.core, MigrateOptions::default()).unwrap();
    assert_eq!(report.phase, "done");
    assert_eq!((report.done, report.total, report.errors), (1, 1, 0));
    assert_eq!((report.counts.images, report.counts.videos), (1, 0));
    assert!(!vault_migrate::migration_pending(&h.core));
    let items = h.core.vault.items().unwrap();
    assert_eq!(items.len(), 1);
    assert_eq!(items[0].source_id.as_deref(), Some("plain"));
    let db = h.core.db.lock().unwrap();
    assert!(db.get_image("plain").unwrap().is_none());
    assert!(db.get_image("take").unwrap().is_some());
    assert!(db.get_image("result").unwrap().is_some());
    assert!(h.core.cfg.videos_dir().join("take.mp4").exists());
    assert!(h.core.cfg.videos_dir().join("result.mp4").exists());
}

#[test]
fn unlock_loads_story_docs_and_lock_wipes_them() {
    use app_lib::stories::{Story, StoryDoc};
    let h = harness("http://127.0.0.1:1");
    let v = &h.core.vault;
    v.create(PW, KdfParams::fast()).unwrap();
    let story = Story {
        id: uuid::Uuid::new_v4().to_string(),
        title: "Light Packing".into(),
        logline: String::new(),
        brief: "two partners decide to run tonight".into(),
        target_s: 60,
        aspect: "16:9".into(),
        style: String::new(),
        cast: vec![],
        voices: vec![],
        status: "draft".into(),
        result_image_id: None,
        vault: true,
        created_at: "t".into(),
        updated_at: "t".into(),
    };
    let doc = StoryDoc { story: story.clone(), shots: vec![], sidecar: Some(json!({"planner": "x"})) };
    v.put_story_doc(&doc).unwrap();
    // A take of that story is an item, counted by the workspace, not the gallery.
    let mut take = record("", KIND_VIDEO, Path::new(""), "2026-02-01T00:00:00Z");
    take.story_id = Some(story.id.clone());
    take.shot_id = Some("sh1".into());
    vault_migrate::seal_output(&h.core, &take, &mp4(4), Some(&jpeg(4))).unwrap();
    v.lock();
    assert!(v.story_doc(&story.id).unwrap_err().starts_with("VAULT_LOCKED"));
    assert!(v.story_file_exists(&story.id));

    // A fresh Vault over the same directory loads the doc back on unlock.
    let fresh = app_lib::vault::Vault::new(v.dir().to_path_buf(), 10);
    assert!(fresh.story_doc(&story.id).unwrap_err().starts_with("VAULT_LOCKED"));
    fresh.unlock(PW).unwrap();
    assert_eq!(fresh.story_doc(&story.id).unwrap(), doc);
    assert_eq!(fresh.items_for_story(&story.id).unwrap().len(), 1);
    assert_eq!(fresh.status().item_count, Some(0), "story items are not gallery items");
    fresh.lock();
    assert!(fresh.story_docs().is_err());
    assert_eq!(fresh.status().item_count, None);
    for p in walk(v.dir()) {
        let bytes = std::fs::read(&p).unwrap();
        for needle in [b"Light Packing".as_slice(), b"run tonight", b"planner"] {
            assert!(!contains(&bytes, needle), "{}", p.display());
        }
    }
}

#[test]
fn move_to_vault_refuses_story_media() {
    let h = harness("http://127.0.0.1:1");
    seed_story_media(&h);
    h.core.vault.create(PW, KdfParams::fast()).unwrap();
    for id in ["take", "result"] {
        assert_eq!(
            vault_migrate::move_to_vault(&h.core, id).unwrap_err(),
            "Story videos are managed from the Stories tab"
        );
        assert!(h.core.db.lock().unwrap().get_image(id).unwrap().is_some());
    }
    assert!(h.core.vault.items().unwrap().is_empty());
}

// ----- vault stories: render, approve, assemble, export, delete -----

use app_lib::pod::Profile;
use app_lib::stories::{render, repo, Character, Shot, Story, StoryDoc};

/// The worker's take fixture: a tiny moov-first MP4 with audio (ffmpeg), or a
/// header-only stand-in when ffmpeg is missing (nothing decodes it then).
fn worker_clip() -> Vec<u8> {
    let Ok(ff) = app_lib::stories::ffmpeg::find_ffmpeg() else {
        return mp4(7);
    };
    let dir = tempfile::tempdir().unwrap();
    let p = dir.path().join("clip.mp4");
    let st = std::process::Command::new(&ff)
        .args([
            "-hide_banner", "-loglevel", "error",
            "-f", "lavfi", "-i", "color=c=blue:s=320x180:d=1:r=24",
            "-f", "lavfi", "-i", "sine=frequency=440:duration=1",
            "-shortest", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-movflags", "+faststart", "-y",
        ])
        .arg(&p)
        .status()
        .unwrap();
    assert!(st.success());
    std::fs::read(&p).unwrap()
}

fn offset_of(hay: &[u8], needle: &[u8]) -> Option<usize> {
    hay.windows(needle.len()).position(|w| w == needle)
}

fn has_ffmpeg() -> bool {
    let ok = app_lib::stories::ffmpeg::find_ffmpeg().is_ok();
    if !ok {
        eprintln!("ffmpeg not installed; skipping the assembly part");
    }
    ok
}

/// Every video job completes with `video` (reported at its real size) and `poster`.
struct VideoDone {
    video: Vec<u8>,
    poster: Vec<u8>,
    width: u32,
    height: u32,
}
impl Respond for VideoDone {
    fn respond(&self, _: &Request) -> ResponseTemplate {
        let b64 = |b: &[u8]| base64::engine::general_purpose::STANDARD.encode(b);
        let out = json!({"video": {"base64": b64(&self.video), "width": self.width, "height": self.height, "fps": 24,
                "durationS": 1.0, "hasAudio": true}, "poster": {"base64": b64(&self.poster)}, "timings": {"totalMs": 900}});
        ResponseTemplate::new(200).set_body_json(json!({"status": "COMPLETED", "delayTime": 1, "executionTime": 2, "output": out}))
    }
}

/// The RunPod REST API with a running video pod `vid1`, and that pod's worker.
async fn video_pod_server(video: Vec<u8>, poster: Vec<u8>, width: u32, height: u32) -> MockServer {
    let server = MockServer::start().await;
    let pod = json!({"id": "vid1", "name": "image-studio-video-gpu", "status": "RUNNING", "cost": 2.39,
        "gpu": {"id": "NVIDIA H200", "count": 1}, "dataCenterId": "CA-MTL-3",
        "createdAt": "2026-10-09T10:00:00Z", "startedAt": "2026-10-09T10:00:05Z", "env": {}});
    Mock::given(method("GET"))
        .and(path("/v2/pods"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({"pods": [pod.clone()], "pagination": {"hasNextPage": false}})))
        .mount(&server)
        .await;
    Mock::given(method("GET"))
        .and(path("/v2/pods/vid1"))
        .respond_with(ResponseTemplate::new(200).set_body_json(pod))
        .mount(&server)
        .await;
    Mock::given(method("GET"))
        .and(path("/v2/network-volumes"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({"networkVolumes": [
            {"id": "v7hzxkm304", "name": "image-studio-video", "size": 150, "dataCenter": "CA-MTL-3"}]})))
        .mount(&server)
        .await;
    Mock::given(method("GET"))
        .and(path("/proxy/vid1/ping"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({"status": "ok"})))
        .mount(&server)
        .await;
    Mock::given(method("GET"))
        .and(path("/proxy/vid1/health"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({"jobs": {"inQueue": 0, "inProgress": 0},
            "workers": {"idle": 1, "running": 0}, "ready": true})))
        .mount(&server)
        .await;
    Mock::given(method("POST"))
        .and(path("/proxy/vid1/run"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({"id": "rp-video", "status": "IN_QUEUE"})))
        .mount(&server)
        .await;
    Mock::given(method("GET"))
        .and(path_regex("/proxy/vid1/status/.*"))
        .respond_with(VideoDone { video, poster, width, height })
        .mount(&server)
        .await;
    server
}

/// Adopts the mocked running video pod.
async fn adopt_video_pod(h: &Harness) {
    pod::adopt_for(&h.core, Profile::Video).await.unwrap();
    for _ in 0..500 {
        if pod::state_for(&h.core, Profile::Video).status == GpuStatus::Running {
            return;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    panic!("the mocked video pod never became ready");
}

/// `input` of the last `/run` the pod received.
async fn last_run_input(server: &MockServer) -> Value {
    let reqs = server.received_requests().await.unwrap();
    let run = reqs.iter().rev().find(|r| r.url.path() == "/proxy/vid1/run").expect("no /run");
    run.body_json::<Value>().unwrap()["input"].clone()
}

fn character(name: &str) -> Character {
    Character {
        id: uuid::Uuid::new_v4().to_string(), name: name.into(), description: "woman in her 30s, short black hair".into(),
        source: "generated".into(), consent: false, adult: true, ref_ids: vec![], ref_paths: vec![], vault: false,
        created_at: "t".into(), updated_at: "t".into(),
    }
}

fn story_draft(title: &str, brief: &str) -> Story {
    Story {
        id: uuid::Uuid::new_v4().to_string(), title: title.into(), logline: String::new(), brief: brief.into(), target_s: 8,
        aspect: "16:9".into(), style: String::new(), cast: vec![], voices: vec![], status: "planned".into(),
        result_image_id: None, vault: false, created_at: "t".into(), updated_at: "t".into(),
    }
}

fn shot(story_id: &str, position: u32, character: &str, action: &str) -> Shot {
    Shot {
        id: uuid::Uuid::new_v4().to_string(), story_id: story_id.into(), position, duration_s: 8,
        characters: vec![character.into()], setting: "rooftop at night".into(), camera: "wide".into(), action: action.into(),
        dialogue: vec![], sound: String::new(), continuity: "cut".into(), approved_take_id: None,
    }
}

/// A vault character "Mara" (one sealed reference) cast in a vault story with the given shots.
/// Returns (face ref id, character, story, shot ids).
fn seed_vault_story(h: &Harness, title: &str, brief: &str, shots: &[(&str, &str)]) -> (String, Character, Story, Vec<String>) {
    let face = vault_migrate::import_reference_to_vault(&h.core, &png(3, 64, 64)).unwrap();
    let mara = repo::save_character(&h.core, &Character { ref_ids: vec![face.ref_id.clone()], vault: true, ..character("Mara") }).unwrap();
    let story = repo::save_story(
        &h.core,
        &Story { cast: vec![mara.id.clone()], vault: true, target_s: 8 * shots.len() as u32, ..story_draft(title, brief) },
    )
    .unwrap();
    let list: Vec<Shot> = shots
        .iter()
        .enumerate()
        .map(|(i, (cont, action))| Shot { continuity: cont.to_string(), ..shot(&story.id, i as u32 + 1, &mara.id, action) })
        .collect();
    render::store_shots(&h.core, &story.id, &list).unwrap();
    let ids = repo::list_shots(&h.core, &story.id).unwrap().into_iter().map(|s| s.id).collect();
    (face.ref_id, mara, story, ids)
}

/// Not one byte of the story (text, reference pixels, take video) outside the sealed folders.
fn assert_no_plaintext(h: &Harness, needles: &[&[u8]]) {
    for (path, bytes) in plaintext_areas(h) {
        for needle in needles {
            assert!(!contains(&bytes, needle), "{} holds story plaintext", path.display());
        }
    }
    assert!(!h.dir.path().join("stories-tmp").exists());
    assert_eq!(files_in(&h.core.cfg.references_dir()), 0, "no plain reference for a vault character");
    assert_eq!(files_in(&h.core.cfg.videos_dir()), 0, "no plain take or film of a vault story");
}

#[tokio::test]
async fn vault_story_renders_sealed_even_when_locked_meanwhile_and_leaves_no_plaintext() {
    let clip = worker_clip();
    assert_eq!(&clip[4..8], b"ftyp");
    if let (Some(moov), Some(mdat)) = (offset_of(&clip, b"moov"), offset_of(&clip, b"mdat")) {
        assert!(moov < mdat, "the worker's takes are moov-first");
    }
    let server = video_pod_server(clip.clone(), jpeg(2), 320, 180).await;
    let h = harness(&server.uri());
    h.core.vault.create(PW, KdfParams::fast()).unwrap();
    adopt_video_pod(&h).await;
    let (face, _mara, story, shot_ids) =
        seed_vault_story(&h, "Light Packing", "two partners decide to run tonight", &[("cut", "Mara runs to the edge of the roof.")]);
    let shot_id = shot_ids[0].clone();
    let job = render::render_shot(&h.core, &shot_id).unwrap();
    h.core.vault.lock(); // locks while the pod works
    // Locked: every verb on the story answers the spec's copy and changes nothing.
    assert_eq!(render::approve_take(&h.core, &shot_id, "t").unwrap_err(), "VAULT_LOCKED: Unlock the vault to approve takes");
    assert_eq!(render::assemble_story(&h.core, &story.id).unwrap_err(), "VAULT_LOCKED: Unlock the vault to assemble the story");
    assert_eq!(render::plan_story(&h.core, &story.id).await.unwrap_err(), "VAULT_LOCKED: Unlock the vault to plan the story");
    assert_eq!(render::render_shot(&h.core, &shot_id).unwrap_err(), "VAULT_LOCKED: Unlock the vault to open this story");
    assert_eq!(render::render_story(&h.core, &story.id).unwrap_err(), "VAULT_LOCKED: Unlock the vault to open this story");
    assert_eq!(render::delete_story(&h.core, &story.id).unwrap_err(), "VAULT_LOCKED: Unlock the vault to open this story");
    let done = wait_job(&h.sink, &job).await;
    assert_eq!(done.status, JobState::Completed, "{:?}", done.error);
    assert!(done.images.is_empty() && done.completed == 1, "redacted while locked");
    assert_eq!(done.label.as_deref(), Some("Vault story · shot 1"));
    for j in h.sink.jobs.lock().unwrap().iter() {
        let s = serde_json::to_string(j).unwrap();
        assert!(!s.contains("Light Packing") && !s.contains("run tonight") && !s.contains("edge of the roof"), "{s}");
    }
    // The pod got the character's reference decrypted in memory, like every vault job.
    let run = last_run_input(&server).await;
    let sent = base64::engine::general_purpose::STANDARD.decode(run["references"][0]["base64"].as_str().unwrap()).unwrap();
    assert_eq!(sent, app_lib::references::process(&png(3, 64, 64)).unwrap().0);
    h.core.vault.unlock(PW).unwrap();
    let view = render::story_view(&h.core, &story.id).unwrap();
    assert_eq!(view.takes.len(), 1);
    assert!(view.takes[0].vault && view.takes[0].path.starts_with("vault://localhost/"));
    assert_eq!(view.takes[0].shot_id.as_deref(), Some(shot_id.as_str()));
    assert!(view.takes[0].references.iter().all(|r| r.starts_with("vault://localhost/")));
    assert!(h.core.vault.gallery_items().unwrap().is_empty(), "takes are not gallery items");
    // Approve and assemble (needs ffmpeg; skipped otherwise).
    if has_ffmpeg() {
        render::approve_take(&h.core, &shot_id, &view.takes[0].id).unwrap();
        let film = render::assemble_story(&h.core, &story.id).unwrap();
        assert!(film.vault && film.story_id.as_deref() == Some(story.id.as_str()) && film.shot_id.is_none());
        assert!(film.path.starts_with("vault://localhost/") && film.path.ends_with(".mp4"), "{}", film.path);
        assert!(film.poster_path.as_deref().unwrap_or_default().starts_with("vault://localhost/"));
        let s = repo::get_story(&h.core, &story.id).unwrap().unwrap();
        assert_eq!((s.status.as_str(), s.result_image_id.as_deref()), ("assembled", Some(film.id.as_str())));
        assert!(h.core.vault.gallery_items().unwrap().is_empty());
        assert_eq!(h.core.vault.status().item_count, Some(0));
        assert!(h.core.db.lock().unwrap().get_image(&film.id).unwrap().is_none(), "nothing in SQLite");
        let view = render::story_view(&h.core, &story.id).unwrap();
        assert_eq!(view.result.as_ref().map(|r| r.id.as_str()), Some(film.id.as_str()));
        assert_eq!(view.takes.len(), 1, "the film is not a take");
        let dest = h.dir.path().join("export.mp4");
        vault_migrate::export_item(&h.core, &film.id, &dest).unwrap();
        assert_eq!(&std::fs::read(&dest).unwrap()[4..8], b"ftyp");
        std::fs::remove_file(&dest).unwrap();
        // Re-assembling replaces the previous film.
        let again = render::assemble_story(&h.core, &story.id).unwrap();
        assert!(h.core.vault.item(&film.id).is_err(), "the old film is gone");
        assert_eq!(h.core.vault.items_for_story(&story.id).unwrap().len(), 2, "one take, one film");
        assert_eq!(repo::get_story(&h.core, &story.id).unwrap().unwrap().result_image_id.as_deref(), Some(again.id.as_str()));
    }
    // Nothing readable anywhere in the data dir: the brief, the action, the reference pixels, the take's video.
    let mid = clip.len() / 2;
    assert_no_plaintext(&h, &[
        b"run tonight", b"edge of the roof", b"Light Packing", &png(3, 64, 64)[16..48], &clip[..32], &clip[mid..mid + 32],
    ]);
    assert!(h.core.db.lock().unwrap().list_takes(&story.id).unwrap().is_empty());
    // Delete the story: takes, film and doc go; the character's reference blob stays.
    render::delete_story(&h.core, &story.id).unwrap();
    assert!(h.core.vault.items().unwrap().is_empty());
    assert!(repo::get_story(&h.core, &story.id).unwrap().is_none());
    assert!(h.core.vault.open_blob(&BlobRef::parse(&face).unwrap().id).is_ok());
    assert_eq!(files_in(&h.core.cfg.vault_dir().join("blobs")), 1, "only the character's face is left");
}

/// A continues shot of a vault story: the previous take's last frame is sealed
/// (never a `references/` file), fed to the pod from memory and recorded as a
/// vault path on the take; assembly and export touch no plaintext file.
#[tokio::test]
async fn vault_story_leaves_no_plaintext_on_disk() {
    if !has_ffmpeg() {
        return;
    }
    let clip = worker_clip();
    let server = video_pod_server(clip.clone(), jpeg(2), 320, 180).await;
    let h = harness(&server.uri());
    h.core.vault.create(PW, KdfParams::fast()).unwrap();
    adopt_video_pod(&h).await;
    let (_face, _mara, story, shot_ids) = seed_vault_story(
        &h,
        "Light Packing",
        "two partners decide to run tonight",
        &[("cut", "Mara runs to the edge of the roof."), ("continues", "Mara looks down at the street.")],
    );
    let job = render::render_shot(&h.core, &shot_ids[0]).unwrap();
    let done = wait_job(&h.sink, &job).await;
    assert_eq!(done.status, JobState::Completed, "{:?}", done.error);
    let take1 = done.images[0].clone();
    assert!(take1.vault && take1.shot_id.as_deref() == Some(shot_ids[0].as_str()));
    // Approving shot 1 renders the continuing shot 2 from shot 1's last frame.
    let queued = render::approve_take(&h.core, &shot_ids[0], &take1.id).unwrap().unwrap();
    assert_eq!(queued.0, shot_ids[1]);
    assert_eq!(files_in(&h.core.cfg.references_dir()), 0, "the first frame is a sealed blob, not a references/ file");
    let done = wait_job(&h.sink, &queued.1).await;
    assert_eq!(done.status, JobState::Completed, "{:?}", done.error);
    let take2 = done.images[0].clone();
    assert!(take2.init_image.as_deref().unwrap_or_default().starts_with("vault://localhost/"), "{:?}", take2.init_image);
    assert_eq!(take2.references.len(), 2);
    assert_eq!(take2.references[1].as_str(), take2.init_image.as_deref().unwrap(), "the frame is the last reference");
    let run = last_run_input(&server).await;
    let frame = base64::engine::general_purpose::STANDARD.decode(run["initImage"]["base64"].as_str().unwrap()).unwrap();
    assert_eq!(run["references"][1]["base64"], run["initImage"]["base64"]);
    let img = image::load_from_memory(&frame).unwrap().to_rgb8();
    let p = img.get_pixel(160, 90).0;
    assert!(p[2] > 200 && p[0] < 40 && p[1] < 40, "the last frame of the blue clip: {p:?}");
    let sealed = h.core.vault.open_blob(&BlobRef::parse(take2.init_image.as_deref().unwrap()).unwrap().id).unwrap();
    assert_eq!(sealed.as_slice(), frame.as_slice(), "the sealed frame is what the pod got");
    render::approve_take(&h.core, &shot_ids[1], &take2.id).unwrap();
    let film = render::assemble_story(&h.core, &story.id).unwrap();
    assert!(film.vault && film.story_id.as_deref() == Some(story.id.as_str()));
    let dest = h.dir.path().join("export.mp4");
    vault_migrate::export_item(&h.core, &film.id, &dest).unwrap();
    assert_eq!(&std::fs::read(&dest).unwrap()[4..8], b"ftyp");
    std::fs::remove_file(&dest).unwrap();
    let mid = clip.len() / 2;
    assert_no_plaintext(&h, &[
        b"run tonight", b"edge of the roof", b"down at the street", b"Light Packing",
        &png(3, 64, 64)[16..48], &frame[16..48], &clip[..32], &clip[mid..mid + 32],
    ]);
    assert_eq!(h.core.vault.items_for_story(&story.id).unwrap().len(), 3, "two takes and the film");
    assert!(h.core.vault.gallery_items().unwrap().is_empty());
    // Dropping shot 2 discards its sealed take; shot 1's stays.
    let shots = repo::list_shots(&h.core, &story.id).unwrap();
    render::save_shots(&h.core, &story.id, vec![shots[0].clone()]).unwrap();
    assert!(h.core.vault.item(&take2.id).is_err());
    assert!(h.core.vault.item(&take1.id).is_ok());
}

#[tokio::test]
async fn a_vault_take_for_a_shot_that_is_gone_is_discarded() {
    let server = video_pod_server(worker_clip(), jpeg(2), 320, 180).await;
    let h = harness(&server.uri());
    h.core.vault.create(PW, KdfParams::fast()).unwrap();
    adopt_video_pod(&h).await;
    let (_face, _mara, story, shot_ids) =
        seed_vault_story(&h, "Light Packing", "two partners decide to run tonight", &[("cut", "Mara runs to the edge of the roof.")]);
    let job = render::render_shot(&h.core, &shot_ids[0]).unwrap();
    // Removed behind the app's back (the commands refuse this while it renders).
    let doc = h.core.vault.story_doc(&story.id).unwrap();
    h.core.vault.put_story_doc(&StoryDoc { shots: vec![], ..doc }).unwrap();
    let j = wait_job(&h.sink, &job).await;
    assert_eq!(j.status, JobState::Failed, "{:?}", j.error);
    assert!(j.error.as_deref().unwrap_or_default().contains("The shot was removed while it rendered"), "{:?}", j.error);
    assert!(j.images.is_empty());
    assert!(h.core.vault.items_for_story(&story.id).unwrap().is_empty());
    assert_eq!(files_in(&h.core.cfg.vault_dir().join("blobs")), 1, "the take's blobs went; the face stays");
    assert_eq!(files_in(&h.core.cfg.videos_dir()), 0);
}
