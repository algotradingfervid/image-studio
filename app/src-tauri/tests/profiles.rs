//! GPU pod profiles (spec v5): the `image` and `video` pods are isolated
//! (exact-name matching, separate state/ids/timers), the video profile's
//! licence guard, quitting stops both, worker routing per profile, and the
//! video job lifecycle. Mocked RunPod REST + pod servers (wiremock).

use app_lib::db::Db;
use app_lib::jobs::{self, Job, JobEntry, JobKind, JobState, VideoRequest};
use app_lib::pod::{self, GpuState, GpuStatus, Profile, StopReason};
use app_lib::registry::{Model, Registry};
use app_lib::settings::{MemoryStore, SecretStore, Settings, ACCOUNT_POD_TOKEN, ACCOUNT_RUNPOD};
use app_lib::state::{Clock, Core, CoreConfig, EventSink};
use app_lib::status::{self, StatusView};
use app_lib::tasks::{self, Task, TaskStatus};
use base64::Engine;
use chrono::{DateTime, Utc};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use wiremock::matchers::{method, path, path_regex};
use wiremock::{Mock, MockServer, Request, Respond, ResponseTemplate};

const IMG: &str = "image-studio-gpu";
const VID: &str = "image-studio-video-gpu";

#[derive(Default)]
struct Collect {
    jobs: Mutex<Vec<Job>>,
    tasks: Mutex<Vec<Task>>,
    gpu: Mutex<Vec<GpuState>>,
}
impl EventSink for Collect {
    fn job_update(&self, j: &Job) {
        self.jobs.lock().unwrap().push(j.clone());
    }
    fn task_update(&self, t: &Task) {
        self.tasks.lock().unwrap().push(t.clone());
    }
    fn status_update(&self, _: &StatusView) {}
    fn gpu_update(&self, g: &GpuState) {
        self.gpu.lock().unwrap().push(g.clone());
    }
}

struct Harness {
    core: Arc<Core>,
    sink: Arc<Collect>,
    now: Arc<Mutex<DateTime<Utc>>>,
    dir: tempfile::TempDir,
}

fn video_model() -> Model {
    serde_json::from_value(json!({
        "id": "h3", "name": "MiniMax H3", "license": "MiniMax H3 Community",
        "modes": ["t2v", "i2v"], "audio": true, "volume": "image-studio-video",
        "defaults": {"durationS": 5, "fps": 24, "resolution": "1280x720", "steps": 30, "cfg": 4.0},
        "limits": {"minDurationS": 2, "maxDurationS": 10, "resolutions": ["1280x720", "720x1280"], "fpsOptions": [24]},
        "files": [
            {"folder": "unet", "filename": "minimax_h3_fl2va_pruned_fp8_scaled.safetensors", "url": "https://x/u", "sizeBytes": 100},
            {"folder": "vae", "filename": "minimax_h3_video_vae_fp16.safetensors", "url": "https://x/v", "sizeBytes": 10}
        ]
    }))
    .unwrap()
}

/// `config`: settings.json body (None = defaults).
fn harness(server: &MockServer, config: Option<&str>) -> Harness {
    let dir = tempfile::tempdir().unwrap();
    let store = Arc::new(MemoryStore::default());
    store.set(ACCOUNT_RUNPOD, Some("test-key")).unwrap();
    store.set(ACCOUNT_POD_TOKEN, Some("podtok")).unwrap();
    if let Some(c) = config {
        std::fs::write(dir.path().join("settings.json"), c).unwrap();
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
        pod_start_timeout: Duration::from_secs(5),
        pod_stop_timeout: Duration::from_secs(2),
        rest_timeout: Duration::from_secs(1),
        clock,
    };
    let mut registry = Registry::embedded();
    // A fixed fixture (independent of the real `videoModels` in models.json).
    registry.video_models = vec![video_model()];
    let core = Core::new(registry, Db::open_in_memory().unwrap(), settings, sink.clone(), cfg).unwrap();
    Harness {
        core,
        sink,
        now,
        dir,
    }
}

fn ok(v: Value) -> ResponseTemplate {
    ResponseTemplate::new(200).set_body_json(v)
}

fn pod_json(id: &str, name: &str, status: &str, gpu: &str, dc: &str) -> Value {
    json!({"id": id, "name": name, "status": status, "cost": 2.39,
           "gpu": {"id": gpu, "count": 1}, "dataCenterId": dc,
           "createdAt": "2026-10-09T10:00:00Z", "startedAt": "2026-10-09T10:00:05Z", "env": {}})
}

/// Stateful fake of `/v2/pods[/{id}]` with pod names. A POST creates a pod
/// with the name, GPU and datacenter from the request body.
#[derive(Clone, Default)]
struct Sim(Arc<Mutex<SimState>>);

#[derive(Default)]
struct SimState {
    pods: Vec<Value>,
    next: usize,
    posts: Vec<Value>,
    deletes: Vec<String>,
    fail_delete: Vec<String>,
    /// The next N `GET /v2/pods` listings fail with 500.
    fail_list: usize,
}

impl Sim {
    fn add(&self, id: &str, name: &str, status: &str) {
        let (gpu, dc) = if name == VID {
            ("NVIDIA RTX PRO 6000 Blackwell Server Edition", "CA-MTL-3")
        } else {
            ("NVIDIA RTX PRO 4500 Blackwell", "EU-RO-1")
        };
        self.0.lock().unwrap().pods.push(pod_json(id, name, status, gpu, dc));
    }
    fn set_status(&self, id: &str, status: &str) {
        let mut s = self.0.lock().unwrap();
        s.pods.iter_mut().find(|p| p["id"] == id).unwrap()["status"] = json!(status);
    }
    fn ids(&self) -> Vec<String> {
        let mut v: Vec<String> = self
            .0
            .lock()
            .unwrap()
            .pods
            .iter()
            .map(|p| p["id"].as_str().unwrap().to_string())
            .collect();
        v.sort();
        v
    }
    fn deletes(&self) -> Vec<String> {
        let mut v = self.0.lock().unwrap().deletes.clone();
        v.sort();
        v
    }
    fn posts(&self) -> Vec<Value> {
        self.0.lock().unwrap().posts.clone()
    }
    async fn mount(&self, server: &MockServer) {
        Mock::given(path_regex(r"^/v2/pods(/[^/]+)?$"))
            .respond_with(self.clone())
            .mount(server)
            .await;
    }
}

impl Respond for Sim {
    fn respond(&self, r: &Request) -> ResponseTemplate {
        let mut s = self.0.lock().unwrap();
        let id = r.url.path().strip_prefix("/v2/pods/").map(str::to_string);
        match (r.method.as_str(), id) {
            ("GET", None) if s.fail_list > 0 => {
                s.fail_list -= 1;
                ResponseTemplate::new(500).set_body_json(json!({"status": 500, "detail": "boom"}))
            }
            ("GET", None) => ok(json!({"pods": s.pods, "pagination": {"hasNextPage": false}})),
            ("POST", None) => {
                let body: Value = r.body_json().unwrap();
                s.next += 1;
                let name = body["name"].as_str().unwrap();
                let id = format!("{}{}", if name == VID { "vpod" } else { "ipod" }, s.next);
                let pod = pod_json(
                    &id,
                    name,
                    "RUNNING",
                    body["gpu"]["id"].as_str().unwrap(),
                    body["dataCenterIds"][0].as_str().unwrap(),
                );
                s.posts.push(body);
                s.pods.push(pod.clone());
                ResponseTemplate::new(201).set_body_json(pod)
            }
            ("GET", Some(id)) => match s.pods.iter().find(|p| p["id"] == id.as_str()) {
                Some(p) => ok(p.clone()),
                None => ResponseTemplate::new(404).set_body_json(json!({"status": 404, "detail": "pod not found"})),
            },
            ("DELETE", Some(id)) => {
                s.deletes.push(id.clone());
                if s.fail_delete.contains(&id) {
                    return ResponseTemplate::new(500).set_body_json(json!({"status": 500, "detail": "boom"}));
                }
                s.pods.retain(|p| p["id"] != id.as_str());
                ResponseTemplate::new(204)
            }
            _ => ResponseTemplate::new(405),
        }
    }
}

async fn mount_volumes(server: &MockServer) {
    Mock::given(method("GET"))
        .and(path("/v2/network-volumes"))
        .respond_with(ok(json!({"networkVolumes": [
            {"id": "xzrw5sl5ho", "name": "image-studio-models", "size": 100, "dataCenter": "EU-RO-1"},
            {"id": "v7hzxkm304", "name": "image-studio-video", "size": 150, "dataCenter": "CA-MTL-3"},
            {"id": "badvol", "name": "video-eu", "size": 150, "dataCenter": "EU-RO-1"},
            {"id": "usvol", "name": "video-us", "size": 150, "dataCenter": "US-NE-1"}
        ]})))
        .mount(server)
        .await;
}

/// Any pod id is served as ready.
async fn mount_ready_pods(server: &MockServer) {
    Mock::given(method("GET"))
        .and(path_regex(r"^/proxy/[^/]+/ping$"))
        .respond_with(ok(json!({"status": "ok"})))
        .mount(server)
        .await;
    Mock::given(method("GET"))
        .and(path_regex(r"^/proxy/[^/]+/health$"))
        .respond_with(ok(json!({"ready": true, "jobs": {}, "workers": {"idle": 1, "running": 0}})))
        .mount(server)
        .await;
}

async fn wait_for(core: &Core, p: Profile, want: GpuStatus) -> GpuState {
    for _ in 0..500 {
        let s = pod::state_for(core, p);
        if s.status == want {
            return s;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    panic!("{p:?} GPU never reached {want:?}; now {:?}", pod::state_for(core, p));
}

fn stored(core: &Core, key: &str) -> Option<String> {
    core.db.lock().unwrap().get_setting(key).unwrap().filter(|s| !s.is_empty())
}

/// Both profiles adopted and Running. Look-alike names exist too and must
/// never be adopted or touched.
async fn both_running(server: &MockServer) -> (Harness, Sim) {
    let sim = Sim::default();
    sim.add("img1", IMG, "RUNNING");
    sim.add("vid1", VID, "RUNNING");
    sim.add("other1", "image-studio-gpu-old", "RUNNING");
    sim.add("other2", "image-studio-video", "RUNNING");
    sim.mount(server).await;
    mount_ready_pods(server).await;
    let h = harness(server, None);
    pod::adopt_for(&h.core, Profile::Image).await.unwrap();
    pod::adopt_for(&h.core, Profile::Video).await.unwrap();
    wait_for(&h.core, Profile::Image, GpuStatus::Running).await;
    wait_for(&h.core, Profile::Video, GpuStatus::Running).await;
    (h, sim)
}

#[tokio::test]
async fn adopt_picks_each_profiles_pod_by_exact_name() {
    let server = MockServer::start().await;
    let (h, _sim) = both_running(&server).await;
    let i = pod::state_for(&h.core, Profile::Image);
    let v = pod::state_for(&h.core, Profile::Video);
    assert_eq!((i.profile, i.pod_id.as_deref()), (Profile::Image, Some("img1")));
    assert_eq!((v.profile, v.pod_id.as_deref()), (Profile::Video, Some("vid1")));
    assert_eq!(stored(&h.core, pod::DB_POD_ID).as_deref(), Some("img1"));
    assert_eq!(stored(&h.core, pod::DB_VIDEO_POD_ID).as_deref(), Some("vid1"));
    assert!(i.left_running && v.left_running);
    assert_eq!(serde_json::to_value(&v).unwrap()["profile"], "video");
    // every gpu-update carries its profile; both profiles emitted
    let events = h.sink.gpu.lock().unwrap();
    assert!(events.iter().any(|g| g.profile == Profile::Image));
    assert!(events.iter().any(|g| g.profile == Profile::Video && g.pod_id.as_deref() == Some("vid1")));
    assert_eq!(pod::states(&h.core).iter().map(|s| s.profile).collect::<Vec<_>>(), Profile::ALL);
}

#[tokio::test]
async fn adopt_with_only_the_other_profiles_pod_stays_stopped() {
    let server = MockServer::start().await;
    let sim = Sim::default();
    sim.add("vid1", VID, "RUNNING");
    sim.mount(&server).await;
    let h = harness(&server, None);
    // "image-studio-gpu" must not match "image-studio-video-gpu".
    let s = pod::adopt_for(&h.core, Profile::Image).await.unwrap();
    assert_eq!(s.status, GpuStatus::Stopped);
    assert_eq!(s.pod_id, None);
    assert_eq!(stored(&h.core, pod::DB_POD_ID), None);
}

#[tokio::test]
async fn stopping_image_never_deletes_the_video_pod_and_vice_versa() {
    let server = MockServer::start().await;
    let (h, sim) = both_running(&server).await;
    let s = pod::stop_for(&h.core, Profile::Image, StopReason::User).await.unwrap();
    assert_eq!(s.status, GpuStatus::Stopped);
    assert_eq!(sim.deletes(), vec!["img1"]);
    assert_eq!(pod::state_for(&h.core, Profile::Video).status, GpuStatus::Running);
    assert_eq!(stored(&h.core, pod::DB_VIDEO_POD_ID).as_deref(), Some("vid1"));
    assert_eq!(sim.ids(), vec!["other1", "other2", "vid1"]);

    let s = pod::stop_for(&h.core, Profile::Video, StopReason::User).await.unwrap();
    assert_eq!((s.profile, s.status), (Profile::Video, GpuStatus::Stopped));
    assert_eq!(sim.deletes(), vec!["img1", "vid1"]);
    assert_eq!(sim.ids(), vec!["other1", "other2"], "look-alike names untouched");
    assert_eq!(stored(&h.core, pod::DB_VIDEO_POD_ID), None);
}

#[tokio::test]
async fn stop_video_first_leaves_the_image_pod_and_stops_every_named_video_pod() {
    let server = MockServer::start().await;
    let (h, sim) = both_running(&server).await;
    sim.add("vid2", VID, "RUNNING"); // a duplicate video pod
    pod::stop_for(&h.core, Profile::Video, StopReason::User).await.unwrap();
    assert_eq!(sim.deletes(), vec!["vid1", "vid2"]);
    assert_eq!(pod::state_for(&h.core, Profile::Image).status, GpuStatus::Running);
    assert_eq!(pod::state_for(&h.core, Profile::Image).pod_id.as_deref(), Some("img1"));
}

#[tokio::test]
async fn starting_video_creates_its_own_pod_even_while_the_image_pod_runs() {
    let server = MockServer::start().await;
    mount_volumes(&server).await;
    let sim = Sim::default();
    sim.add("img1", IMG, "RUNNING");
    sim.mount(&server).await;
    mount_ready_pods(&server).await;
    let h = harness(&server, None);
    pod::start_for(&h.core, Profile::Video).unwrap();
    let s = wait_for(&h.core, Profile::Video, GpuStatus::Running).await;
    assert_eq!(s.pod_id.as_deref(), Some("vpod1"), "never adopts the image pod");
    let posts = sim.posts();
    assert_eq!(posts.len(), 1);
    let body = &posts[0];
    assert_eq!(body["name"], VID);
    assert_eq!(body["gpu"]["id"], "NVIDIA RTX PRO 6000 Blackwell Server Edition");
    assert_eq!(body["dataCenterIds"], json!(["CA-MTL-3"]));
    assert_eq!(body["mounts"]["network"][0]["volumeId"], "v7hzxkm304");
    assert_eq!(stored(&h.core, pod::DB_VIDEO_POD_ID).as_deref(), Some("vpod1"));
    assert_eq!(stored(&h.core, pod::DB_POD_ID), None);
    assert_eq!(pod::state_for(&h.core, Profile::Image).status, GpuStatus::Stopped);
    assert!(sim.deletes().is_empty());
    // the video volume size is cached separately
    assert_eq!(pod::cached_volume_size_gb_for(&h.core, Profile::Video), Some(150));
    assert_eq!(pod::cached_volume_size_gb_for(&h.core, Profile::Image), None);
}

#[tokio::test]
async fn video_gpu_fallback_uses_the_video_gpu_list() {
    let server = MockServer::start().await;
    mount_volumes(&server).await;
    let sim = Sim::default();
    sim.mount(&server).await;
    // The first video GPU has no capacity (400): the next one is tried.
    Mock::given(method("POST"))
        .and(path("/v2/pods"))
        .and(wiremock::matchers::body_partial_json(
            json!({"gpu": {"id": "NVIDIA RTX PRO 6000 Blackwell Server Edition"}}),
        ))
        .respond_with(ResponseTemplate::new(400).set_body_json(json!({"status": 400, "detail": "no capacity"})))
        .with_priority(1)
        .mount(&server)
        .await;
    mount_ready_pods(&server).await;
    let h = harness(&server, None);
    pod::start_for(&h.core, Profile::Video).unwrap();
    let s = wait_for(&h.core, Profile::Video, GpuStatus::Running).await;
    assert_eq!(s.gpu_type.as_deref(), Some("NVIDIA H200"));
    assert_eq!(sim.posts()[0]["gpu"]["id"], "NVIDIA H200");
}

#[tokio::test]
async fn video_refuses_us_and_eu_datacenters() {
    for vol in ["video-eu", "video-us"] {
        let server = MockServer::start().await;
        mount_volumes(&server).await;
        let sim = Sim::default();
        sim.mount(&server).await;
        let cfg = format!(r#"{{"videoVolumeNames": ["{vol}"]}}"#);
        let h = harness(&server, Some(&cfg));
        pod::start_for(&h.core, Profile::Video).unwrap();
        let s = wait_for(&h.core, Profile::Video, GpuStatus::Error).await;
        let e = s.error.unwrap();
        assert!(e.contains("licence excludes"), "{e}");
        assert!(e.contains(if vol == "video-eu" { "EU-RO-1" } else { "US-NE-1" }), "{e}");
        assert!(sim.posts().is_empty(), "no pod created in {vol}");
        assert_eq!(s.pod_id, None);
    }
    // Pure guard: only the video profile, only US-/EU- prefixes.
    assert!(pod::check_datacenter(Profile::Video, "CA-MTL-3").is_ok());
    assert!(pod::check_datacenter(Profile::Video, "EU-SE-1").is_err());
    assert!(pod::check_datacenter(Profile::Video, "US-TX-3").is_err());
    assert!(pod::check_datacenter(Profile::Image, "EU-RO-1").is_ok());
}

#[tokio::test]
async fn quit_stops_both_profiles() {
    let server = MockServer::start().await;
    let (h, sim) = both_running(&server).await;
    assert!(pod::needs_quit_confirm(&h.core));
    let states = pod::stop_for_quit(&h.core).await.unwrap();
    assert!(states.iter().all(|s| s.status == GpuStatus::Stopped));
    assert_eq!(sim.deletes(), vec!["img1", "vid1"]);
    assert!(!pod::needs_quit_confirm(&h.core));
}

#[tokio::test]
async fn quit_needs_confirm_for_video_alone_and_a_failed_video_stop_keeps_asking() {
    let server = MockServer::start().await;
    let (h, sim) = both_running(&server).await;
    pod::stop_for(&h.core, Profile::Image, StopReason::User).await.unwrap();
    assert!(pod::needs_quit_confirm(&h.core), "the video pod still bills");
    sim.0.lock().unwrap().fail_delete.push("vid1".into());
    let e = pod::stop_for_quit(&h.core).await.unwrap_err();
    assert!(e.contains("video") && e.contains("may still be billing"), "{e}");
    assert!(pod::needs_quit_confirm(&h.core));
    assert_eq!(pod::state_for(&h.core, Profile::Video).pod_id.as_deref(), Some("vid1"));
    sim.0.lock().unwrap().fail_delete.clear();
    pod::stop_for_quit(&h.core).await.unwrap();
    assert!(!pod::needs_quit_confirm(&h.core));
}

#[tokio::test]
async fn quit_asks_when_a_start_failed_with_no_pod_id() {
    // Every video GPU is out of stock: the start ends in Error with no pod
    // id. Quitting must still ask (an ambiguous create looks the same).
    let server = MockServer::start().await;
    mount_volumes(&server).await;
    Sim::default().mount(&server).await;
    Mock::given(method("POST"))
        .and(path("/v2/pods"))
        .respond_with(ResponseTemplate::new(400).set_body_json(json!({"status": 400, "detail": "no capacity"})))
        .with_priority(1)
        .mount(&server)
        .await;
    let h = harness(&server, None);
    pod::start_for(&h.core, Profile::Video).unwrap();
    let s = wait_for(&h.core, Profile::Video, GpuStatus::Error).await;
    assert_eq!(s.pod_id, None);
    assert!(pod::needs_quit_confirm(&h.core));
    let states = pod::stop_for_quit(&h.core).await.unwrap();
    assert!(states.iter().all(|s| s.status == GpuStatus::Stopped));
    assert!(!pod::needs_quit_confirm(&h.core));
}

#[tokio::test]
async fn a_failed_startup_adopt_is_retried_by_the_monitor() {
    let server = MockServer::start().await;
    let sim = Sim::default();
    sim.add("vid1", VID, "RUNNING");
    sim.0.lock().unwrap().fail_list = 1;
    sim.mount(&server).await;
    mount_ready_pods(&server).await;
    let h = harness(&server, None);
    assert!(pod::adopt_for(&h.core, Profile::Video).await.is_err());
    assert_eq!(pod::state_for(&h.core, Profile::Video).status, GpuStatus::Stopped);
    pod::monitor_tick(&h.core).await;
    let v = wait_for(&h.core, Profile::Video, GpuStatus::Running).await;
    assert_eq!(v.pod_id.as_deref(), Some("vid1"));
    // Once a listing succeeded, a Stopped profile is not re-adopted each tick.
    pod::stop_for(&h.core, Profile::Video, StopReason::User).await.unwrap();
    sim.add("vid2", VID, "RUNNING");
    pod::monitor_tick(&h.core).await;
    assert_eq!(pod::state_for(&h.core, Profile::Video).status, GpuStatus::Stopped);
}

#[tokio::test]
async fn adopt_prefers_a_live_pod_over_an_exited_stored_one() {
    let server = MockServer::start().await;
    let sim = Sim::default();
    sim.add("vold", VID, "EXITED");
    sim.add("vnew", VID, "RUNNING");
    sim.mount(&server).await;
    mount_ready_pods(&server).await;
    let h = harness(&server, None);
    h.core.db.lock().unwrap().set_setting(pod::DB_VIDEO_POD_ID, "vold").unwrap();
    pod::adopt_for(&h.core, Profile::Video).await.unwrap();
    let v = wait_for(&h.core, Profile::Video, GpuStatus::Running).await;
    assert_eq!(v.pod_id.as_deref(), Some("vnew"));
}

#[tokio::test]
async fn idle_auto_stop_and_liveness_are_per_profile() {
    let server = MockServer::start().await;
    let (h, sim) = both_running(&server).await;
    // An image job keeps only the image pod busy.
    let job = Job {
        job_id: "j".into(),
        kind: JobKind::Image,
        destination: Default::default(),
        status: JobState::Running,
        total: 1,
        completed: 0,
        progress: None,
        images: vec![],
        error: None,
    };
    h.core.jobs.lock().unwrap().insert("j".into(), JobEntry { job, cancel: false });
    *h.now.lock().unwrap() += chrono::Duration::minutes(31);
    pod::monitor_tick(&h.core).await;
    assert_eq!(pod::state_for(&h.core, Profile::Image).status, GpuStatus::Running);
    let v = pod::state_for(&h.core, Profile::Video);
    assert_eq!((v.status, v.stop_reason), (GpuStatus::Stopped, Some(StopReason::Idle)));
    assert_eq!(sim.deletes(), vec!["vid1"]);

    // Liveness: the image pod exits; only the image profile reacts.
    h.core.jobs.lock().unwrap().clear();
    sim.set_status("img1", "EXITED");
    pod::liveness_check_for(&h.core, Profile::Video).await;
    assert_eq!(pod::state_for(&h.core, Profile::Image).status, GpuStatus::Running);
    pod::liveness_check_for(&h.core, Profile::Image).await;
    let i = pod::state_for(&h.core, Profile::Image);
    assert_eq!((i.status, i.stop_reason), (GpuStatus::Stopped, Some(StopReason::External)));
    assert_eq!(sim.deletes(), vec!["img1", "vid1"]);
}

// ---------------------------------------------------------------------------
// Worker routing and the video job lifecycle

fn mp4_bytes() -> Vec<u8> {
    let mut v = vec![0, 0, 0, 0x18];
    v.extend_from_slice(b"ftypisom\0\0\x02\0isomiso2");
    v.extend_from_slice(&[0u8; 64]);
    v
}

fn jpeg_b64() -> String {
    let img = image::RgbImage::from_pixel(16, 9, image::Rgb([20, 30, 200]));
    let mut buf = Vec::new();
    image::DynamicImage::ImageRgb8(img)
        .write_to(&mut std::io::Cursor::new(&mut buf), image::ImageFormat::Jpeg)
        .unwrap();
    base64::engine::general_purpose::STANDARD.encode(buf)
}

/// Pod-server `/run` + `/status` for `pod`: IN_PROGRESS then COMPLETED with `output`.
async fn mount_pod_job(server: &MockServer, pod_id: &str, output: Value) {
    Mock::given(method("POST"))
        .and(path(format!("/proxy/{pod_id}/run")))
        .respond_with(ok(json!({"id": "rj1", "status": "IN_QUEUE"})))
        .mount(server)
        .await;
    struct Two(Value, std::sync::atomic::AtomicUsize);
    impl Respond for Two {
        fn respond(&self, _: &Request) -> ResponseTemplate {
            if self.1.fetch_add(1, std::sync::atomic::Ordering::SeqCst) == 0 {
                ok(json!({"id": "rj1", "status": "IN_PROGRESS",
                    "output": {"phase": "sampling", "stage": "video_decoding",
                               "stages": ["loading_model", "sampling", "video_decoding", "audio_decoding", "encoding_video"]}}))
            } else {
                ok(json!({"id": "rj1", "status": "COMPLETED", "delayTime": 5, "executionTime": 90000, "output": self.0}))
            }
        }
    }
    Mock::given(method("GET"))
        .and(path(format!("/proxy/{pod_id}/status/rj1")))
        .respond_with(Two(output, Default::default()))
        .mount(server)
        .await;
}

async fn wait_job(h: &Harness) -> Job {
    for _ in 0..600 {
        if let Some(j) = h.sink.jobs.lock().unwrap().last() {
            if matches!(j.status, JobState::Completed | JobState::Failed | JobState::Cancelled) {
                return j.clone();
            }
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    panic!("job did not finish");
}

fn video_req() -> VideoRequest {
    VideoRequest {
        model: "h3".into(),
        prompt: "a fox running through snow".into(),
        duration_s: 5.0,
        fps: 24.0,
        resolution: "1280x720".into(),
        seed: Some(42),
        audio: true,
        ..Default::default()
    }
}

#[tokio::test]
async fn video_job_starts_the_video_gpu_and_saves_mp4_poster_and_record() {
    let server = MockServer::start().await;
    mount_volumes(&server).await;
    let sim = Sim::default();
    sim.add("img1", IMG, "RUNNING"); // must not be used for video
    sim.mount(&server).await;
    mount_ready_pods(&server).await;
    let mp4 = mp4_bytes();
    mount_pod_job(
        &server,
        "vpod1",
        json!({"video": {"base64": base64::engine::general_purpose::STANDARD.encode(&mp4), "mime": "video/mp4",
                         "width": 1280, "height": 720, "fps": 24, "frames": 121, "durationS": 5.04, "hasAudio": true},
               "poster": {"base64": jpeg_b64()},
               "timings": {"totalMs": 88000}}),
    )
    .await;
    let h = harness(&server, None);
    let id = jobs::generate_video(&h.core, video_req()).unwrap();
    let job = wait_job(&h).await;
    assert_eq!(job.job_id, id);
    assert_eq!(job.status, JobState::Completed, "{:?}", job.error);
    assert_eq!(job.kind, JobKind::Video);
    assert_eq!(serde_json::to_value(&job).unwrap()["kind"], "video");

    // The video GPU was started (not the image pod); the image profile untouched.
    assert_eq!(pod::state_for(&h.core, Profile::Video).status, GpuStatus::Running);
    assert_eq!(pod::state_for(&h.core, Profile::Image).status, GpuStatus::Stopped);
    assert_eq!(sim.posts().len(), 1);
    assert_eq!(sim.posts()[0]["name"], VID);
    let reqs = server.received_requests().await.unwrap();
    assert!(!reqs.iter().any(|r| r.url.path().starts_with("/proxy/img1/")));
    let run: Value = reqs
        .iter()
        .find(|r| r.url.path() == "/proxy/vpod1/run")
        .unwrap()
        .body_json()
        .unwrap();
    let input = &run["input"];
    assert_eq!(input["action"], "generate_video");
    assert_eq!(input["model"], "h3");
    assert_eq!(input["durationS"], json!(5));
    assert_eq!(input["fps"], json!(24));
    assert_eq!(input["resolution"], "1280x720");
    assert_eq!(input["seed"], json!(42));
    assert_eq!(input["audio"], json!(true));
    assert_eq!(input["steps"], json!(30), "model default");
    assert!(input.get("initImage").is_none(), "t2v");
    assert_eq!(run["policy"]["executionTimeout"], json!(jobs::VIDEO_TIMEOUT_MS));

    // Stage progress (video stages) was passed through while running.
    assert!(h.sink.jobs.lock().unwrap().iter().any(|j| j
        .progress
        .as_ref()
        .and_then(|p| p.stage.as_deref())
        == Some("video_decoding")));

    // Files and record.
    let rec = &job.images[0];
    assert_eq!(rec.kind, "video");
    assert!(rec.path.ends_with(".mp4"));
    assert!(rec.path.starts_with(h.dir.path().join("videos").to_str().unwrap()));
    assert_eq!(std::fs::read(&rec.path).unwrap(), mp4);
    let poster = rec.poster_path.clone().expect("poster saved");
    assert!(poster.ends_with(".jpg"));
    assert_eq!(image::open(&poster).unwrap().width(), 16);
    assert_eq!((rec.width, rec.height), (1280, 720));
    assert_eq!((rec.fps, rec.duration_s, rec.has_audio), (Some(24.0), Some(5.04), Some(true)));
    assert_eq!((rec.seed, rec.aspect_ratio.as_str()), (42, "1280x720"));
    assert_eq!(rec.duration_ms, Some(88000));
    let db_rec = h.core.db.lock().unwrap().get_image(&rec.id).unwrap().unwrap();
    assert_eq!(&db_rec, rec);
}

#[tokio::test]
async fn video_job_i2v_sends_the_start_image() {
    let server = MockServer::start().await;
    mount_volumes(&server).await;
    let sim = Sim::default();
    sim.add("vid1", VID, "RUNNING");
    sim.mount(&server).await;
    mount_ready_pods(&server).await;
    mount_pod_job(
        &server,
        "vid1",
        json!({"video": {"base64": base64::engine::general_purpose::STANDARD.encode(mp4_bytes())}}),
    )
    .await;
    let h = harness(&server, None);
    pod::adopt_for(&h.core, Profile::Video).await.unwrap();
    wait_for(&h.core, Profile::Video, GpuStatus::Running).await;
    let png = {
        let img = image::RgbImage::from_pixel(64, 36, image::Rgb([1, 2, 3]));
        let mut buf = Vec::new();
        image::DynamicImage::ImageRgb8(img)
            .write_to(&mut std::io::Cursor::new(&mut buf), image::ImageFormat::Png)
            .unwrap();
        buf
    };
    let r = app_lib::references::import_bytes(&h.core.cfg.references_dir(), &png).unwrap();
    let job_id = jobs::generate_video(
        &h.core,
        VideoRequest {
            init_image_id: Some(r.ref_id.clone()),
            audio: false,
            ..video_req()
        },
    )
    .unwrap();
    let job = wait_job(&h).await;
    assert_eq!((job.job_id.as_str(), job.status), (job_id.as_str(), JobState::Completed), "{:?}", job.error);
    let rec = &job.images[0];
    assert!(rec.init_image.is_some());
    assert_eq!(rec.poster_path, None, "no poster in the output");
    assert_eq!(rec.has_audio, Some(false));
    let reqs = server.received_requests().await.unwrap();
    let run: Value = reqs.iter().find(|r| r.url.path() == "/proxy/vid1/run").unwrap().body_json().unwrap();
    assert!(run["input"]["initImage"]["base64"].as_str().unwrap().len() > 10);
    assert!(sim.posts().is_empty(), "the adopted video pod was reused");
}

#[tokio::test]
async fn video_job_start_image_from_gallery_is_read_in_place() {
    let server = MockServer::start().await;
    let sim = Sim::default();
    sim.add("vid1", VID, "RUNNING");
    sim.mount(&server).await;
    mount_ready_pods(&server).await;
    mount_pod_job(
        &server,
        "vid1",
        json!({"video": {"base64": base64::engine::general_purpose::STANDARD.encode(mp4_bytes())}}),
    )
    .await;
    let h = harness(&server, None);
    pod::adopt_for(&h.core, Profile::Video).await.unwrap();
    wait_for(&h.core, Profile::Video, GpuStatus::Running).await;
    // A generated 2048x1024 image in the gallery (2 MP: downscaled in memory).
    let path = h.dir.path().join("images").join("g1.png");
    image::RgbImage::from_pixel(2048, 1024, image::Rgb([9, 9, 9])).save(&path).unwrap();
    let original = std::fs::read(&path).unwrap();
    let mut rec: app_lib::db::ImageRecord = serde_json::from_value(json!({
        "id": "g1", "path": path.to_str().unwrap(), "model": "zimage", "prompt": "p",
        "negativePrompt": "", "aspectRatio": "2:1", "width": 2048, "height": 1024, "seed": 1,
        "steps": 8, "cfg": 1.0, "references": [], "loras": [], "createdAt": "t",
        "durationMs": null, "runpod": {"delayMs": null, "executionMs": null}}))
    .unwrap();
    h.core.db.lock().unwrap().insert_image(&rec).unwrap();
    rec.id = "vrec".into();
    rec.kind = "video".into();
    h.core.db.lock().unwrap().insert_image(&rec).unwrap();
    let refs_before = std::fs::read_dir(h.core.cfg.references_dir()).unwrap().count();

    jobs::generate_video(
        &h.core,
        VideoRequest {
            init_image_gallery_id: Some("g1".into()),
            ..video_req()
        },
    )
    .unwrap();
    let job = wait_job(&h).await;
    assert_eq!(job.status, JobState::Completed, "{:?}", job.error);
    assert_eq!(job.images[0].init_image.as_deref(), path.to_str(), "points at the gallery file");
    assert_eq!(std::fs::read(&path).unwrap(), original, "gallery file unchanged");
    assert_eq!(
        std::fs::read_dir(h.core.cfg.references_dir()).unwrap().count(),
        refs_before,
        "nothing copied into references/"
    );
    let reqs = server.received_requests().await.unwrap();
    let run: Value = reqs.iter().find(|r| r.url.path() == "/proxy/vid1/run").unwrap().body_json().unwrap();
    let b = base64::engine::general_purpose::STANDARD
        .decode(run["input"]["initImage"]["base64"].as_str().unwrap())
        .unwrap();
    let sent = image::load_from_memory(&b).unwrap();
    assert!((sent.width() as u64 * sent.height() as u64) <= 1024 * 1024, "≤1 MP");

    let err = |r: VideoRequest| jobs::generate_video(&h.core, r).unwrap_err();
    assert!(err(VideoRequest { init_image_gallery_id: Some("vrec".into()), ..video_req() }).contains("not a video"));
    assert!(err(VideoRequest { init_image_gallery_id: Some("nope".into()), ..video_req() }).contains("no longer exists"));
    assert!(err(VideoRequest {
        init_image_gallery_id: Some("g1".into()),
        init_image_id: Some("x".into()),
        ..video_req()
    })
    .contains("one start image"));
}

#[tokio::test]
async fn video_job_rejects_non_mp4_output_and_bad_requests() {
    let server = MockServer::start().await;
    let sim = Sim::default();
    sim.add("vid1", VID, "RUNNING");
    sim.mount(&server).await;
    mount_ready_pods(&server).await;
    mount_pod_job(
        &server,
        "vid1",
        json!({"video": {"base64": base64::engine::general_purpose::STANDARD.encode(b"not a video at all")}}),
    )
    .await;
    let h = harness(&server, None);
    pod::adopt_for(&h.core, Profile::Video).await.unwrap();
    wait_for(&h.core, Profile::Video, GpuStatus::Running).await;
    jobs::generate_video(&h.core, video_req()).unwrap();
    let job = wait_job(&h).await;
    assert_eq!(job.status, JobState::Failed);
    assert!(job.error.unwrap().contains("not an MP4"));
    assert!(std::fs::read_dir(h.dir.path().join("videos")).unwrap().next().is_none());

    let bad = |f: fn(&mut VideoRequest)| {
        let mut r = video_req();
        f(&mut r);
        jobs::generate_video(&h.core, r).unwrap_err()
    };
    assert!(bad(|r| r.model = "chroma".into()).contains("Unknown video model"));
    assert!(bad(|r| r.duration_s = 11.0).contains("at most 10"));
    assert!(bad(|r| r.duration_s = 1.0).contains("at least 2"));
    assert!(bad(|r| r.fps = 30.0).contains("30 fps"));
    assert!(bad(|r| r.resolution = "640x480".into()).contains("resolution"));
    assert!(bad(|r| r.prompt = " ".into()).contains("prompt"));
}

#[tokio::test]
async fn video_model_tasks_and_status_use_the_video_pod_and_cache() {
    let server = MockServer::start().await;
    let (h, _sim) = both_running(&server).await;
    // The video pod's status lists the H3 files; the image pod is never asked.
    Mock::given(method("POST"))
        .and(path("/proxy/vid1/run"))
        .respond_with(ok(json!({"id": "t1", "status": "IN_QUEUE"})))
        .mount(&server)
        .await;
    Mock::given(method("GET"))
        .and(path("/proxy/vid1/status/t1"))
        .respond_with(ok(json!({"id": "t1", "status": "COMPLETED", "output": {
            "downloaded": ["x"], "skipped": [],
            "files": [
                {"folder": "unet", "filename": "minimax_h3_fl2va_pruned_fp8_scaled.safetensors", "sizeBytes": 100},
                {"folder": "vae", "filename": "minimax_h3_video_vae_fp16.safetensors", "sizeBytes": 10}
            ], "volume": {"totalBytes": 1, "freeBytes": 1}}})))
        .mount(&server)
        .await;
    let task = tasks::download_model(&h.core, "h3").unwrap();
    for _ in 0..500 {
        if h.sink.tasks.lock().unwrap().iter().any(|t| t.task_id == task.task_id && t.status == TaskStatus::Completed) {
            break;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    let reqs = server.received_requests().await.unwrap();
    let runs: Vec<&str> = reqs
        .iter()
        .filter(|r| r.method.as_str() == "POST" && r.url.path().starts_with("/proxy/"))
        .map(|r| r.url.path())
        .collect();
    assert!(!runs.is_empty() && runs.iter().all(|p| *p == "/proxy/vid1/run"), "{runs:?}");
    let download: Value = reqs.iter().find(|r| r.url.path() == "/proxy/vid1/run").unwrap().body_json().unwrap();
    assert_eq!(download["input"]["action"], "download");
    // The refresh after the task went into the video cache only.
    let v = status::cached_view_for(&h.core, Profile::Video).unwrap();
    assert!(v.checked_at.is_some());
    assert_eq!(v.profile, Profile::Video);
    assert!(status::cached_view_for(&h.core, Profile::Image).unwrap().checked_at.is_none());
    let views = status::model_views(&h.core);
    let h3 = views.iter().find(|m| m["id"] == "h3").unwrap();
    assert_eq!(h3["kind"], "video");
    assert_eq!(h3["installed"], json!(true));
    assert_eq!(h3["limits"]["maxDurationS"], json!(10.0));
    assert_eq!(views.iter().find(|m| m["id"] == "chroma").unwrap()["kind"], "image");
    assert_eq!(views.iter().filter(|m| m["kind"] == "video").count(), 1);
}
