//! Job/task state machines against a mocked RunPod (wiremock).

use app_lib::db::Db;
use app_lib::jobs::{self, GenerateRequest, Job, JobState};
use app_lib::registry::Registry;
use app_lib::settings::{MemoryStore, SecretStore, Settings, ACCOUNT_RUNPOD, ENV_RUNPOD_ENDPOINT};
use app_lib::state::{Core, CoreConfig, EventSink};
use app_lib::status::StatusView;
use app_lib::tasks::{self, Task, TaskStatus};
use base64::Engine;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use wiremock::matchers::{header, method, path, path_regex};
use wiremock::{Mock, MockServer, Request, Respond, ResponseTemplate};

#[derive(Default)]
struct Collect {
    jobs: Mutex<Vec<Job>>,
    tasks: Mutex<Vec<Task>>,
    statuses: Mutex<Vec<StatusView>>,
}
impl EventSink for Collect {
    fn job_update(&self, j: &Job) {
        self.jobs.lock().unwrap().push(j.clone());
    }
    fn task_update(&self, t: &Task) {
        self.tasks.lock().unwrap().push(t.clone());
    }
    fn status_update(&self, s: &StatusView) {
        self.statuses.lock().unwrap().push(s.clone());
    }
}

struct Harness {
    core: Arc<Core>,
    sink: Arc<Collect>,
    _dir: tempfile::TempDir,
}

fn harness(server: &MockServer) -> Harness {
    let dir = tempfile::tempdir().unwrap();
    let store = Arc::new(MemoryStore::default());
    store.set(ACCOUNT_RUNPOD, Some("test-key")).unwrap();
    let env: HashMap<String, String> =
        [(ENV_RUNPOD_ENDPOINT.to_string(), "ep1".to_string())].into();
    // These tests exercise the legacy serverless path (the pod path is in tests/pod.rs).
    std::fs::write(dir.path().join("settings.json"), r#"{"backend":"serverless"}"#).unwrap();
    let settings = Settings::new(store, env, dir.path().join("settings.json"));
    let sink = Arc::new(Collect::default());
    let cfg = CoreConfig {
        data_dir: dir.path().to_path_buf(),
        runpod_root: server.uri(),
        civitai_root: server.uri(),
        hf_root: server.uri(),
        poll_interval: Duration::from_millis(10),
        ..CoreConfig::production(dir.path().to_path_buf())
    };
    let core = Core::new(
        Registry::embedded(),
        Db::open_in_memory().unwrap(),
        settings,
        sink.clone(),
        cfg,
    )
    .unwrap();
    Harness {
        core,
        sink,
        _dir: dir,
    }
}

fn png_b64() -> String {
    let img = image::RgbImage::from_pixel(8, 8, image::Rgb([200, 10, 10]));
    let mut buf = Vec::new();
    image::DynamicImage::ImageRgb8(img)
        .write_to(&mut std::io::Cursor::new(&mut buf), image::ImageFormat::Png)
        .unwrap();
    base64::engine::general_purpose::STANDARD.encode(buf)
}

/// Returns each body in turn, repeating the last one.
struct Seq(Vec<Value>, AtomicUsize);
impl Respond for Seq {
    fn respond(&self, _: &Request) -> ResponseTemplate {
        let i = self.1.fetch_add(1, Ordering::SeqCst).min(self.0.len() - 1);
        ResponseTemplate::new(200).set_body_json(&self.0[i])
    }
}
fn seq(v: Vec<Value>) -> Seq {
    Seq(v, AtomicUsize::new(0))
}

/// /run returns rp-0, rp-1, … in order.
struct RunIds(AtomicUsize);
impl Respond for RunIds {
    fn respond(&self, _: &Request) -> ResponseTemplate {
        let i = self.0.fetch_add(1, Ordering::SeqCst);
        ResponseTemplate::new(200)
            .set_body_json(json!({"id": format!("rp-{i}"), "status": "IN_QUEUE"}))
    }
}

fn completed(seed: u64) -> Value {
    json!({"id": "x", "status": "COMPLETED", "delayTime": 1500, "executionTime": 4200,
           "output": {"image": {"base64": png_b64(), "seed": seed, "width": 1024, "height": 1024},
                      "timings": {"loadMs": 1, "sampleMs": 2, "totalMs": 3000}}})
}

fn req(count: u32, seed: Option<u64>) -> GenerateRequest {
    GenerateRequest {
        model: "zimage".into(),
        prompt: "a red cube".into(),
        aspect_ratio: "1:1".into(),
        count,
        seed,
        ..Default::default()
    }
}

async fn wait_job(sink: &Collect) -> Job {
    for _ in 0..500 {
        if let Some(j) = sink.jobs.lock().unwrap().last() {
            if matches!(
                j.status,
                JobState::Completed | JobState::Failed | JobState::Cancelled
            ) {
                return j.clone();
            }
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    panic!("job did not finish");
}

fn statuses(sink: &Collect) -> Vec<JobState> {
    let mut v: Vec<JobState> = sink.jobs.lock().unwrap().iter().map(|j| j.status).collect();
    v.dedup();
    v
}

#[tokio::test]
async fn generate_happy_path() {
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/v2/ep1/run"))
        .and(header("authorization", "Bearer test-key"))
        .respond_with(RunIds(AtomicUsize::new(0)))
        .mount(&server)
        .await;
    Mock::given(method("GET"))
        .and(path("/v2/ep1/status/rp-0"))
        .respond_with(seq(vec![
            json!({"id": "rp-0", "status": "IN_QUEUE"}),
            json!({"id": "rp-0", "status": "IN_PROGRESS", "output": {"phase": "sampling", "step": 3, "totalSteps": 8}}),
            completed(42),
        ]))
        .mount(&server)
        .await;
    let h = harness(&server);
    jobs::generate(&h.core, req(1, Some(42))).unwrap();
    let job = wait_job(&h.sink).await;

    assert_eq!(
        statuses(&h.sink),
        vec![
            JobState::Queued,
            JobState::Starting,
            JobState::Running,
            JobState::Completed
        ]
    );
    let running = h
        .sink
        .jobs
        .lock()
        .unwrap()
        .iter()
        .find(|j| j.status == JobState::Running)
        .cloned()
        .unwrap();
    let p = running.progress.unwrap();
    assert_eq!(
        (p.phase.as_deref(), p.step, p.total_steps),
        (Some("sampling"), Some(3), Some(8))
    );
    assert_eq!(job.completed, 1);
    assert_eq!(job.images.len(), 1);
    let img = &job.images[0];
    assert_eq!(img.seed, 42);
    assert_eq!(
        img.steps,
        Registry::embedded().model("zimage").unwrap().defaults.steps
    );
    assert_eq!(img.runpod.delay_ms, Some(1500));
    assert_eq!(img.runpod.execution_ms, Some(4200));
    assert_eq!(img.duration_ms, Some(3000));
    assert!(img
        .path
        .starts_with(h.core.cfg.images_dir().to_str().unwrap()));
    assert!(image::open(&img.path).is_ok());
    let (list, _) = h.core.db.lock().unwrap().list_images(10, None).unwrap();
    assert_eq!(list, job.images);

    // Request body follows the protocol.
    let reqs = server.received_requests().await.unwrap();
    let run: Value = reqs
        .iter()
        .find(|r| r.url.path().ends_with("/run"))
        .unwrap()
        .body_json()
        .unwrap();
    assert_eq!(run["policy"]["executionTimeout"], 600_000);
    assert_eq!(run["input"]["action"], "generate");
    assert_eq!(run["input"]["model"], "zimage");
    assert_eq!(run["input"]["seed"], 42);
    assert_eq!(run["input"]["width"], 1024);
    assert_eq!(run["input"]["references"], json!([]));
    assert_eq!(run["input"]["loras"], json!([]));
    // zimage has no negative prompt support.
    assert_eq!(run["input"]["negativePrompt"], "");
}

#[tokio::test]
async fn generate_failure() {
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/v2/ep1/run"))
        .respond_with(RunIds(AtomicUsize::new(0)))
        .mount(&server)
        .await;
    Mock::given(method("GET"))
        .and(path("/v2/ep1/status/rp-0"))
        .respond_with(seq(vec![json!({"id": "rp-0", "status": "FAILED",
            "error": "{\"error_type\":\"RuntimeError\",\"error_message\":\"MODEL_NOT_INSTALLED: unet/z_image_turbo_bf16.safetensors\"}"})]))
        .mount(&server)
        .await;
    let h = harness(&server);
    jobs::generate(&h.core, req(1, Some(1))).unwrap();
    let job = wait_job(&h.sink).await;
    assert_eq!(job.status, JobState::Failed);
    let err = job.error.unwrap();
    assert!(err.contains("z_image_turbo_bf16.safetensors"), "{err}");
    assert!(job.images.is_empty());
}

#[tokio::test]
async fn generate_cancel() {
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/v2/ep1/run"))
        .respond_with(RunIds(AtomicUsize::new(0)))
        .mount(&server)
        .await;
    Mock::given(method("GET"))
        .and(path_regex("/v2/ep1/status/.*"))
        .respond_with(seq(vec![json!({"status": "IN_QUEUE"})]))
        .mount(&server)
        .await;
    Mock::given(method("POST"))
        .and(path_regex("/v2/ep1/cancel/rp-.*"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({"status": "CANCELLED"})))
        .expect(2)
        .mount(&server)
        .await;
    let h = harness(&server);
    let id = jobs::generate(&h.core, req(2, Some(5))).unwrap();
    // Wait until it is "starting" (IN_QUEUE), then cancel.
    for _ in 0..200 {
        if statuses(&h.sink).contains(&JobState::Starting) {
            break;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    jobs::cancel_job(&h.core, &id).unwrap();
    let job = wait_job(&h.sink).await;
    assert_eq!(job.status, JobState::Cancelled);
    assert!(jobs::cancel_job(&h.core, &id).is_err());
    server.verify().await;
}

#[tokio::test]
async fn generate_count_three_uses_consecutive_seeds() {
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/v2/ep1/run"))
        .respond_with(RunIds(AtomicUsize::new(0)))
        .expect(3)
        .mount(&server)
        .await;
    for (i, seed) in [100u64, 101, 102].iter().enumerate() {
        Mock::given(method("GET"))
            .and(path(format!("/v2/ep1/status/rp-{i}")))
            .respond_with(seq(vec![
                json!({"status": "IN_PROGRESS"}),
                completed(*seed),
            ]))
            .mount(&server)
            .await;
    }
    let h = harness(&server);
    jobs::generate(&h.core, req(3, Some(100))).unwrap();
    let job = wait_job(&h.sink).await;
    assert_eq!(job.status, JobState::Completed);
    assert_eq!(job.total, 3);
    assert_eq!(job.completed, 3);
    let mut seeds: Vec<u64> = job.images.iter().map(|i| i.seed).collect();
    seeds.sort();
    assert_eq!(seeds, vec![100, 101, 102]);
    let sent: Vec<u64> = server
        .received_requests()
        .await
        .unwrap()
        .iter()
        .filter(|r| r.url.path().ends_with("/run"))
        .map(|r| {
            r.body_json::<Value>().unwrap()["input"]["seed"]
                .as_u64()
                .unwrap()
        })
        .collect();
    assert_eq!(sent, vec![100, 101, 102]);
    server.verify().await;
}

#[tokio::test]
async fn generate_validation() {
    let server = MockServer::start().await;
    let h = harness(&server);
    let mut r = req(1, None);
    r.reference_ids = vec!["00000000-0000-0000-0000-000000000000".into()];
    assert!(jobs::generate(&h.core, r)
        .unwrap_err()
        .contains("reference"));
    assert!(jobs::generate(&h.core, req(5, None))
        .unwrap_err()
        .contains("Count"));
    let mut r = req(1, None);
    r.aspect_ratio = "7:7".into();
    assert!(jobs::generate(&h.core, r).is_err());
    // Not installed according to the cache.
    h.core
        .db
        .lock()
        .unwrap()
        .save_status(&Default::default(), "2026-01-01T00:00:00Z")
        .unwrap();
    assert!(jobs::generate(&h.core, req(1, None))
        .unwrap_err()
        .contains("not installed"));
}

#[tokio::test]
async fn download_task_refreshes_status() {
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/v2/ep1/run"))
        .respond_with(RunIds(AtomicUsize::new(0)))
        .mount(&server)
        .await;
    // rp-0: the download; rp-1: the status refresh afterwards.
    Mock::given(method("GET"))
        .and(path("/v2/ep1/status/rp-0"))
        .respond_with(seq(vec![
            json!({"status": "IN_QUEUE"}),
            json!({"status": "IN_PROGRESS", "output": {"phase": "downloading", "file": "ae.safetensors", "bytes": 50, "totalBytes": 100}}),
            json!({"status": "COMPLETED", "output": {"downloaded": ["ae.safetensors"], "skipped": []}}),
        ]))
        .mount(&server)
        .await;
    let files: Vec<Value> = Registry::embedded()
        .model("chroma")
        .unwrap()
        .files
        .iter()
        .map(|f| json!({"folder": f.folder, "filename": f.filename, "sizeBytes": f.size_bytes}))
        .collect();
    Mock::given(method("GET"))
        .and(path("/v2/ep1/status/rp-1"))
        .respond_with(seq(vec![
            json!({"status": "COMPLETED", "output": {"files": files,
            "volume": {"totalBytes": 100, "freeBytes": 40}, "comfyuiVersion": "0.39.0"}}),
        ]))
        .mount(&server)
        .await;
    let h = harness(&server);
    let t = tasks::download_model(&h.core, "chroma").unwrap();
    assert!(
        tasks::download_model(&h.core, "chroma").is_err(),
        "duplicate download rejected"
    );
    for _ in 0..500 {
        if h.sink
            .tasks
            .lock()
            .unwrap()
            .last()
            .is_some_and(|t| t.status == TaskStatus::Completed)
        {
            break;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    let evs = h.sink.tasks.lock().unwrap().clone();
    assert!(evs.iter().all(|e| e.task_id == t.task_id));
    let mut st: Vec<TaskStatus> = evs.iter().map(|e| e.status).collect();
    st.dedup();
    assert_eq!(
        st,
        vec![
            TaskStatus::Queued,
            TaskStatus::Running,
            TaskStatus::Completed
        ]
    );
    assert!(evs.iter().any(|e| e.bytes == 50
        && e.total_bytes == 100
        && e.file.as_deref() == Some("ae.safetensors")));
    // Cache refreshed and the model shows as installed with no active task.
    let views = app_lib::status::model_views(&h.core);
    let chroma = views.iter().find(|v| v["id"] == "chroma").unwrap();
    assert_eq!(chroma["installed"], true);
    assert_eq!(chroma["task"], Value::Null);
    assert_eq!(chroma["files"][2]["sharedWith"], json!(["zimage"]));
    assert_eq!(h.sink.statuses.lock().unwrap().len(), 1);
    let run: Value = server.received_requests().await.unwrap()[0]
        .body_json()
        .unwrap();
    assert_eq!(run["input"]["action"], "download");
    assert_eq!(run["policy"]["executionTimeout"], 3_600_000);
    assert_eq!(run["input"]["files"].as_array().unwrap().len(), 3);
    // Delete preview: zimage not installed, so the shared VAE goes too.
    let p = tasks::delete_preview(&h.core, "chroma").unwrap();
    assert_eq!(p.delete_files.len(), 3);
    assert!(p.kept_files.is_empty());
}

#[tokio::test]
async fn generate_passes_stage_progress_through() {
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/v2/ep1/run"))
        .respond_with(RunIds(AtomicUsize::new(0)))
        .mount(&server)
        .await;
    let progress = json!({
        "phase": "loading", "stage": "loading_model",
        "stages": ["loading_text_encoder", "encoding_prompt", "loading_model", "sampling", "decoding", "saving"],
        "step": 0, "totalSteps": 8, "elapsedMs": 12500, "stageElapsedMs": 4100,
        "cached": true, "cachedStages": ["loading_text_encoder"],
        "stageTimes": {"loading_text_encoder": 0, "encoding_prompt": 1800}
    });
    Mock::given(method("GET"))
        .and(path("/v2/ep1/status/rp-0"))
        .respond_with(seq(vec![
            json!({"id": "rp-0", "status": "IN_PROGRESS", "output": progress.clone()}),
            completed(42),
        ]))
        .mount(&server)
        .await;
    let h = harness(&server);
    jobs::generate(&h.core, req(1, Some(42))).unwrap();
    let job = wait_job(&h.sink).await;
    assert_eq!(job.status, JobState::Completed);
    let running = h
        .sink
        .jobs
        .lock()
        .unwrap()
        .iter()
        .find(|j| j.status == JobState::Running)
        .cloned()
        .unwrap();
    // The UI sees the worker payload verbatim (camelCase, same keys).
    let sent = serde_json::to_value(running.progress.unwrap()).unwrap();
    assert_eq!(sent, progress);
}
