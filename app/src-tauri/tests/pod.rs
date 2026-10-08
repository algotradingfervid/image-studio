//! GPU pod lifecycle and pod-routed worker calls against a mocked RunPod
//! REST API v2 and a mocked pod server (wiremock). No real resources.

use app_lib::db::Db;
use app_lib::jobs::{self, GenerateRequest, Job, JobEntry, JobState};
use app_lib::pod::{self, GpuState, GpuStatus, StopReason};
use app_lib::registry::Registry;
use app_lib::settings::{MemoryStore, SecretStore, Settings, ACCOUNT_POD_TOKEN, ACCOUNT_RUNPOD};
use app_lib::state::{Clock, Core, CoreConfig, EventSink};
use app_lib::status::{self, StatusView};
use app_lib::tasks::Task;
use base64::Engine;
use chrono::{DateTime, Utc};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use wiremock::matchers::{header, method, path};
use wiremock::{Mock, MockServer, Request, Respond, ResponseTemplate};

const GIB: u64 = 1024 * 1024 * 1024;

#[derive(Default)]
struct Collect {
    jobs: Mutex<Vec<Job>>,
    gpu: Mutex<Vec<GpuState>>,
}
impl EventSink for Collect {
    fn job_update(&self, j: &Job) {
        self.jobs.lock().unwrap().push(j.clone());
    }
    fn task_update(&self, _: &Task) {}
    fn status_update(&self, _: &StatusView) {}
    fn gpu_update(&self, g: &GpuState) {
        self.gpu.lock().unwrap().push(g.clone());
    }
}

struct Harness {
    core: Arc<Core>,
    sink: Arc<Collect>,
    now: Arc<Mutex<DateTime<Utc>>>,
    _dir: tempfile::TempDir,
}

fn harness(server: &MockServer, pod_token: Option<&str>, start_timeout: Duration) -> Harness {
    let dir = tempfile::tempdir().unwrap();
    let store = Arc::new(MemoryStore::default());
    store.set(ACCOUNT_RUNPOD, Some("test-key")).unwrap();
    if let Some(t) = pod_token {
        store.set(ACCOUNT_POD_TOKEN, Some(t)).unwrap();
    }
    let settings = Settings::new(store, HashMap::new(), dir.path().join("settings.json"));
    let sink = Arc::new(Collect::default());
    let now = Arc::new(Mutex::new(Utc::now()));
    let n2 = now.clone();
    let clock: Clock = Arc::new(move || *n2.lock().unwrap());
    let cfg = CoreConfig {
        data_dir: dir.path().to_path_buf(),
        runpod_root: server.uri(),
        civitai_root: server.uri(),
        hf_root: server.uri(),
        poll_interval: Duration::from_millis(10),
        rest_root: server.uri(),
        pod_proxy_template: format!("{}/proxy/{{podId}}", server.uri()),
        pod_poll_interval: Duration::from_millis(10),
        pod_start_timeout: start_timeout,
        pod_stop_timeout: Duration::from_secs(2),
        clock,
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
        now,
        _dir: dir,
    }
}

/// Returns each response in turn, repeating the last one.
struct Seq(Vec<ResponseTemplate>, AtomicUsize);
impl Respond for Seq {
    fn respond(&self, _: &Request) -> ResponseTemplate {
        let i = self.1.fetch_add(1, Ordering::SeqCst).min(self.0.len() - 1);
        self.0[i].clone()
    }
}
fn seq(v: Vec<ResponseTemplate>) -> Seq {
    Seq(v, AtomicUsize::new(0))
}
fn ok(v: Value) -> ResponseTemplate {
    ResponseTemplate::new(200).set_body_json(v)
}

fn pod_json(id: &str, status: &str) -> Value {
    json!({"id": id, "name": "image-studio-gpu", "status": status, "cost": 2.39,
           "gpu": {"id": "NVIDIA RTX PRO 6000 Blackwell Server Edition", "count": 1},
           "dataCenterId": "EU-RO-1", "createdAt": "2026-10-09T10:00:00Z",
           "startedAt": "2026-10-09T10:00:05Z", "env": {}})
}

async fn mount_volumes(server: &MockServer) {
    Mock::given(method("GET"))
        .and(path("/v2/network-volumes"))
        .and(header("authorization", "Bearer test-key"))
        .respond_with(ok(json!({"networkVolumes": [
            {"id": "p6b2e0kjhk", "name": "image-studio-models-us", "size": 100, "dataCenter": "US-NE-1", "type": "STANDARD"},
            {"id": "xzrw5sl5ho", "name": "image-studio-models", "size": 100, "dataCenter": "EU-RO-1", "type": "STANDARD"},
            {"id": "other", "name": "unrelated", "size": 10, "dataCenter": "US-TX-3", "type": "STANDARD"}
        ]})))
        .mount(server)
        .await;
}

async fn mount_create(server: &MockServer, id: &str) {
    Mock::given(method("POST"))
        .and(path("/v2/pods"))
        .respond_with(ResponseTemplate::new(201).set_body_json(pod_json(id, "PROVISIONING")))
        .mount(server)
        .await;
}

/// Pod server that is ready immediately.
async fn mount_ready_pod_server(server: &MockServer, id: &str) {
    Mock::given(method("GET"))
        .and(path(format!("/proxy/{id}/ping")))
        .respond_with(ok(json!({"status": "ok"})))
        .mount(server)
        .await;
    Mock::given(method("GET"))
        .and(path(format!("/proxy/{id}/health")))
        .respond_with(ok(json!({"jobs": {"inQueue": 0, "inProgress": 0, "completed": 0, "failed": 0},
            "workers": {"idle": 1, "running": 0}, "ready": true,
            "gpu": "NVIDIA RTX PRO 6000 Blackwell Server Edition", "comfyui": "0.3.x"})))
        .mount(server)
        .await;
}

async fn wait_for(core: &Core, want: GpuStatus) -> GpuState {
    for _ in 0..500 {
        let s = pod::state(core);
        if s.status == want {
            return s;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    panic!("GPU never reached {want:?}; now {:?}", pod::state(core));
}

fn stored_pod_id(core: &Core) -> Option<String> {
    core.db
        .lock()
        .unwrap()
        .get_setting(pod::DB_POD_ID)
        .unwrap()
        .filter(|s| !s.is_empty())
}

#[tokio::test]
async fn create_payload_matches_spec() {
    let server = MockServer::start().await;
    mount_volumes(&server).await;
    mount_create(&server, "pod1").await;
    Mock::given(method("GET"))
        .and(path("/v2/pods/pod1"))
        .respond_with(ok(pod_json("pod1", "RUNNING")))
        .mount(&server)
        .await;
    mount_ready_pod_server(&server, "pod1").await;
    let h = harness(&server, None, Duration::from_secs(5));
    pod::start(&h.core).unwrap();
    wait_for(&h.core, GpuStatus::Running).await;

    let reqs = server.received_requests().await.unwrap();
    let create = reqs
        .iter()
        .find(|r| r.method.as_str() == "POST" && r.url.path() == "/v2/pods")
        .unwrap();
    assert_eq!(
        create.headers.get("authorization").unwrap().to_str().unwrap(),
        "Bearer test-key"
    );
    let body: Value = create.body_json().unwrap();
    let token = body["env"]["API_TOKEN"].as_str().unwrap().to_string();
    assert_eq!(token.len(), 64, "32 random bytes, hex");
    assert!(token.chars().all(|c| c.is_ascii_hexdigit()));
    assert_eq!(
        body,
        json!({
            "name": "image-studio-gpu",
            "image": "ghcr.io/algotradingfervid/image-studio-worker:latest",
            "cloud": "SECURE",
            "gpu": {"id": "NVIDIA RTX PRO 6000 Blackwell Server Edition", "count": 1},
            // First volume name in priority order that exists wins.
            "dataCenterIds": ["EU-RO-1"],
            "disk": 20,
            "mounts": {"network": [{"volumeId": "xzrw5sl5ho", "path": "/runpod-volume"}]},
            "ports": ["8000/http"],
            "env": {
                "MODE": "pod",
                "API_TOKEN": token,
                "IDLE_MINUTES": "30",
                "HF_TOKEN": "{{ RUNPOD_SECRET_image-studio-hf-token }}",
                "CIVITAI_API_KEY": "{{ RUNPOD_SECRET_image-studio-civitai-key }}",
                "RUNPOD_TERMINATE_API_KEY": "test-key"
            }
        })
    );
    // The token was generated once and is what the app sends to the pod.
    let health = reqs
        .iter()
        .find(|r| r.url.path() == "/proxy/pod1/health")
        .unwrap();
    assert_eq!(
        health.headers.get("authorization").unwrap().to_str().unwrap(),
        format!("Bearer {token}")
    );
}

#[tokio::test]
async fn start_walks_phases_to_running() {
    let server = MockServer::start().await;
    mount_volumes(&server).await;
    mount_create(&server, "pod1").await;
    Mock::given(method("GET"))
        .and(path("/v2/pods/pod1"))
        .respond_with(seq(vec![
            ok(pod_json("pod1", "PROVISIONING")),
            ok(pod_json("pod1", "STARTING")),
            ok(pod_json("pod1", "RUNNING")),
        ]))
        .mount(&server)
        .await;
    Mock::given(method("GET"))
        .and(path("/proxy/pod1/ping"))
        .respond_with(seq(vec![ResponseTemplate::new(502), ok(json!({"status": "ok"}))]))
        .mount(&server)
        .await;
    Mock::given(method("GET"))
        .and(path("/proxy/pod1/health"))
        .and(header("authorization", "Bearer podtok"))
        .respond_with(seq(vec![
            ok(json!({"ready": false, "jobs": {}, "workers": {}})),
            ok(json!({"ready": true, "jobs": {}, "workers": {"idle": 1, "running": 0}, "gpu": "x"})),
        ]))
        .mount(&server)
        .await;
    let h = harness(&server, Some("podtok"), Duration::from_secs(5));
    let first = pod::start(&h.core).unwrap();
    assert_eq!(first.status, GpuStatus::Starting);
    let s = wait_for(&h.core, GpuStatus::Running).await;
    assert_eq!(s.pod_id.as_deref(), Some("pod1"));
    assert_eq!(s.cost_per_hr, Some(2.39), "cost from the pod response");
    assert_eq!(
        s.gpu_type.as_deref(),
        Some("NVIDIA RTX PRO 6000 Blackwell Server Edition")
    );
    assert_eq!(s.started_at.as_deref(), Some("2026-10-09T10:00:05Z"));
    assert!(!s.left_running);
    assert_eq!(stored_pod_id(&h.core).as_deref(), Some("pod1"));

    let mut phases: Vec<String> = h
        .sink
        .gpu
        .lock()
        .unwrap()
        .iter()
        .filter_map(|g| g.phase.clone())
        .collect();
    phases.dedup();
    assert_eq!(
        phases,
        vec![
            "Creating pod",
            "Waiting for machine",
            "Pulling image",
            "Booting ComfyUI"
        ]
    );
    // Starting again while running is a no-op (one create only).
    pod::start(&h.core).unwrap();
    let creates = server
        .received_requests()
        .await
        .unwrap()
        .iter()
        .filter(|r| r.method.as_str() == "POST")
        .count();
    assert_eq!(creates, 1);
}

#[tokio::test]
async fn start_falls_back_to_next_gpu_on_capacity_error() {
    let server = MockServer::start().await;
    mount_volumes(&server).await;
    let created = {
        let mut p = pod_json("pod2", "PROVISIONING");
        p["gpu"]["id"] = json!("NVIDIA RTX PRO 4500 Blackwell");
        p
    };
    Mock::given(method("POST"))
        .and(path("/v2/pods"))
        .respond_with(seq(vec![
            ResponseTemplate::new(400).set_body_json(json!({"title": "Bad Request", "status": 400,
                "detail": "There are no longer any instances available with the requested specifications."})),
            ResponseTemplate::new(201).set_body_json(created.clone()),
        ]))
        .expect(2)
        .mount(&server)
        .await;
    let mut running = created.clone();
    running["status"] = json!("RUNNING");
    Mock::given(method("GET"))
        .and(path("/v2/pods/pod2"))
        .respond_with(ok(running))
        .mount(&server)
        .await;
    mount_ready_pod_server(&server, "pod2").await;
    let h = harness(&server, Some("t"), Duration::from_secs(5));
    pod::start(&h.core).unwrap();
    let s = wait_for(&h.core, GpuStatus::Running).await;
    assert_eq!(s.gpu_type.as_deref(), Some("NVIDIA RTX PRO 4500 Blackwell"));
    let gpus: Vec<String> = server
        .received_requests()
        .await
        .unwrap()
        .iter()
        .filter(|r| r.method.as_str() == "POST")
        .map(|r| r.body_json::<Value>().unwrap()["gpu"]["id"].as_str().unwrap().to_string())
        .collect();
    assert_eq!(
        gpus,
        vec![
            "NVIDIA RTX PRO 6000 Blackwell Server Edition",
            "NVIDIA RTX PRO 4500 Blackwell"
        ]
    );
    server.verify().await;
}

#[tokio::test]
async fn start_timeout_errors_and_terminates() {
    let server = MockServer::start().await;
    mount_volumes(&server).await;
    mount_create(&server, "pod1").await;
    Mock::given(method("GET"))
        .and(path("/v2/pods/pod1"))
        .respond_with(ok(pod_json("pod1", "PROVISIONING")))
        .mount(&server)
        .await;
    Mock::given(method("DELETE"))
        .and(path("/v2/pods/pod1"))
        .respond_with(ResponseTemplate::new(204))
        .expect(1)
        .mount(&server)
        .await;
    let h = harness(&server, Some("t"), Duration::from_millis(150));
    pod::start(&h.core).unwrap();
    let s = wait_for(&h.core, GpuStatus::Error).await;
    let e = s.error.unwrap();
    assert!(e.contains("did not become ready"), "{e}");
    assert!(e.contains("Waiting for machine"), "{e}");
    assert_eq!(stored_pod_id(&h.core), None);
    server.verify().await;
}

/// Start → running, used by several tests.
async fn running_harness(server: &MockServer, id: &str) -> Harness {
    mount_volumes(server).await;
    mount_create(server, id).await;
    mount_ready_pod_server(server, id).await;
    let h = harness(server, Some("podtok"), Duration::from_secs(5));
    pod::start(&h.core).unwrap();
    wait_for(&h.core, GpuStatus::Running).await;
    h
}

#[tokio::test]
async fn stop_terminates_and_waits_until_gone() {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/v2/pods/pod1"))
        .respond_with(seq(vec![
            ok(pod_json("pod1", "RUNNING")), // start
            ok(pod_json("pod1", "RUNNING")), // still listed after DELETE
            ResponseTemplate::new(404).set_body_json(json!({"title": "Not Found", "status": 404, "detail": "pod not found"})),
        ]))
        .mount(&server)
        .await;
    Mock::given(method("DELETE"))
        .and(path("/v2/pods/pod1"))
        .and(header("authorization", "Bearer test-key"))
        .respond_with(ResponseTemplate::new(204))
        .expect(1)
        .mount(&server)
        .await;
    let h = running_harness(&server, "pod1").await;
    let s = pod::stop(&h.core, StopReason::User).await.unwrap();
    assert_eq!(s.status, GpuStatus::Stopped);
    assert_eq!(s.stop_reason, Some(StopReason::User));
    assert_eq!(s.pod_id, None);
    assert_eq!(stored_pod_id(&h.core), None);
    let statuses: Vec<GpuStatus> = h.sink.gpu.lock().unwrap().iter().map(|g| g.status).collect();
    let tail = &statuses[statuses.len() - 2..];
    assert_eq!(tail, [GpuStatus::Stopping, GpuStatus::Stopped]);
    server.verify().await;
}

#[tokio::test]
async fn adopts_existing_pod_on_launch() {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/v2/pods"))
        .respond_with(ok(json!({"pods": [
            {"id": "cpu1", "name": "image-studio-fill-us", "status": "RUNNING", "cost": 0.48},
            pod_json("old9", "RUNNING")
        ], "pagination": {"hasNextPage": false, "nextCursor": null}})))
        .mount(&server)
        .await;
    Mock::given(method("GET"))
        .and(path("/v2/pods/old9"))
        .respond_with(ok(pod_json("old9", "RUNNING")))
        .mount(&server)
        .await;
    mount_ready_pod_server(&server, "old9").await;
    let h = harness(&server, Some("t"), Duration::from_secs(5));
    pod::adopt(&h.core).await.unwrap();
    let s = wait_for(&h.core, GpuStatus::Running).await;
    assert_eq!(s.pod_id.as_deref(), Some("old9"));
    assert!(s.left_running, "banner flag");
    assert_eq!(s.cost_per_hr, Some(2.39));
    assert_eq!(stored_pod_id(&h.core).as_deref(), Some("old9"));
    // No pod is created when one is adopted.
    assert!(!server
        .received_requests()
        .await
        .unwrap()
        .iter()
        .any(|r| r.method.as_str() == "POST"));
}

#[tokio::test]
async fn adopt_with_no_pod_stays_stopped() {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/v2/pods"))
        .respond_with(ok(json!({"pods": [], "pagination": {"hasNextPage": false}})))
        .mount(&server)
        .await;
    let h = harness(&server, Some("t"), Duration::from_secs(5));
    let s = pod::adopt(&h.core).await.unwrap();
    assert_eq!(s.status, GpuStatus::Stopped);
    assert!(!s.left_running);
}

#[tokio::test]
async fn auto_stops_after_idle_minutes() {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/v2/pods/pod1"))
        .respond_with(seq(vec![
            ok(pod_json("pod1", "RUNNING")),
            ResponseTemplate::new(404),
        ]))
        .mount(&server)
        .await;
    Mock::given(method("DELETE"))
        .and(path("/v2/pods/pod1"))
        .respond_with(ResponseTemplate::new(204))
        .expect(1)
        .mount(&server)
        .await;
    let h = running_harness(&server, "pod1").await;
    let advance = |mins: i64| {
        let mut n = h.now.lock().unwrap();
        *n += chrono::Duration::minutes(mins);
    };

    advance(29);
    assert!(pod::idle_check(&h.core).await.is_none(), "not idle long enough");

    // An active job keeps the GPU alive (and counts as activity).
    let job = Job {
        job_id: "j".into(),
        status: JobState::Running,
        total: 1,
        completed: 0,
        progress: None,
        images: vec![],
        error: None,
    };
    h.core
        .jobs
        .lock()
        .unwrap()
        .insert("j".into(), JobEntry { job, cancel: false });
    advance(60);
    assert!(pod::idle_check(&h.core).await.is_none(), "busy");
    h.core.jobs.lock().unwrap().clear();

    advance(29);
    assert!(pod::idle_check(&h.core).await.is_none());
    advance(2);
    let s = pod::idle_check(&h.core).await.expect("auto-stopped");
    assert_eq!(s.status, GpuStatus::Stopped);
    assert_eq!(s.stop_reason, Some(StopReason::Idle));
    let last = h.sink.gpu.lock().unwrap().last().cloned().unwrap();
    assert_eq!(last.stop_reason, Some(StopReason::Idle));
    server.verify().await;
}

fn png_b64() -> String {
    let img = image::RgbImage::from_pixel(8, 8, image::Rgb([10, 200, 10]));
    let mut buf = Vec::new();
    image::DynamicImage::ImageRgb8(img)
        .write_to(&mut std::io::Cursor::new(&mut buf), image::ImageFormat::Png)
        .unwrap();
    base64::engine::general_purpose::STANDARD.encode(buf)
}

#[tokio::test]
async fn generate_while_stopped_starts_pod_then_runs_on_it() {
    let server = MockServer::start().await;
    mount_volumes(&server).await;
    mount_create(&server, "pod1").await;
    Mock::given(method("GET"))
        .and(path("/v2/pods/pod1"))
        .respond_with(seq(vec![
            ok(pod_json("pod1", "PROVISIONING")),
            ok(pod_json("pod1", "RUNNING")),
        ]))
        .mount(&server)
        .await;
    mount_ready_pod_server(&server, "pod1").await;
    Mock::given(method("POST"))
        .and(path("/proxy/pod1/run"))
        .and(header("authorization", "Bearer podtok"))
        .respond_with(ok(json!({"id": "pod-123", "status": "IN_QUEUE"})))
        .expect(1)
        .mount(&server)
        .await;
    Mock::given(method("GET"))
        .and(path("/proxy/pod1/status/pod-123"))
        .and(header("authorization", "Bearer podtok"))
        .respond_with(seq(vec![
            ok(json!({"id": "pod-123", "status": "IN_PROGRESS", "output": {"phase": "sampling", "step": 2, "totalSteps": 8}})),
            ok(json!({"id": "pod-123", "status": "COMPLETED", "delayTime": 10, "executionTime": 2000,
                "output": {"image": {"base64": png_b64(), "seed": 7, "width": 1024, "height": 1024},
                           "timings": {"totalMs": 1900}}})),
        ]))
        .mount(&server)
        .await;
    let h = harness(&server, Some("podtok"), Duration::from_secs(5));
    assert_eq!(pod::state(&h.core).status, GpuStatus::Stopped);
    jobs::generate(
        &h.core,
        GenerateRequest {
            model: "zimage".into(),
            prompt: "a green cube".into(),
            aspect_ratio: "1:1".into(),
            count: 1,
            seed: Some(7),
            ..Default::default()
        },
    )
    .unwrap();
    let mut job = None;
    for _ in 0..500 {
        if let Some(j) = h.sink.jobs.lock().unwrap().last() {
            if matches!(j.status, JobState::Completed | JobState::Failed) {
                job = Some(j.clone());
                break;
            }
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    let job = job.expect("job finished");
    assert_eq!(job.status, JobState::Completed, "{:?}", job.error);
    assert_eq!(job.images[0].seed, 7);
    // While the pod booted, the job was "starting" with the pod phase.
    let boot_phases: Vec<String> = h
        .sink
        .jobs
        .lock()
        .unwrap()
        .iter()
        .filter(|j| j.status == JobState::Starting)
        .filter_map(|j| j.progress.as_ref().and_then(|p| p.phase.clone()))
        .collect();
    assert!(
        boot_phases.iter().any(|p| p == "Creating pod" || p == "Waiting for machine"),
        "{boot_phases:?}"
    );
    assert_eq!(pod::state(&h.core).status, GpuStatus::Running);
    // The worker request went to the pod base URL, never the serverless endpoint.
    let reqs = server.received_requests().await.unwrap();
    assert!(reqs.iter().all(|r| !r.url.path().starts_with("/v2/ep")));
    let run: Value = reqs
        .iter()
        .find(|r| r.url.path() == "/proxy/pod1/run")
        .unwrap()
        .body_json()
        .unwrap();
    assert_eq!(run["input"]["action"], "generate");
    assert_eq!(run["policy"]["executionTimeout"], 600_000);
    server.verify().await;
}

#[tokio::test]
async fn refresh_on_pod_uses_volume_size_not_worker_disk_usage() {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/v2/pods/pod1"))
        .respond_with(ok(pod_json("pod1", "RUNNING")))
        .mount(&server)
        .await;
    Mock::given(method("POST"))
        .and(path("/proxy/pod1/run"))
        .respond_with(ok(json!({"id": "pod-s", "status": "IN_QUEUE"})))
        .mount(&server)
        .await;
    Mock::given(method("GET"))
        .and(path("/proxy/pod1/status/pod-s"))
        .respond_with(ok(json!({"id": "pod-s", "status": "COMPLETED", "delayTime": 1, "executionTime": 1,
            "output": {"files": [
                {"folder": "unet", "filename": "a.safetensors", "sizeBytes": 12 * GIB},
                {"folder": "vae", "filename": "ae.safetensors", "sizeBytes": GIB}
            ], "volume": {"totalBytes": 900_000 * GIB, "freeBytes": 1}, "comfyuiVersion": "0.39.0"}})))
        .mount(&server)
        .await;
    let h = running_harness(&server, "pod1").await;
    let view = status::refresh_status(&h.core).await.unwrap();
    let v = view.volume.unwrap();
    assert_eq!(v.total_bytes, 100 * GIB);
    assert_eq!(v.free_bytes, 100 * GIB - 13 * GIB);
}

#[tokio::test]
async fn task_finish_does_not_start_gpu_for_refresh() {
    // With the pod stopped, a refresh that may not start the GPU just returns the cache.
    let server = MockServer::start().await;
    let h = harness(&server, Some("t"), Duration::from_secs(5));
    let v = status::refresh_status_opts(&h.core, false).await.unwrap();
    assert!(v.checked_at.is_none());
    assert_eq!(pod::state(&h.core).status, GpuStatus::Stopped);
    assert!(server.received_requests().await.unwrap().is_empty());
}
