//! Pod create payload for the local model copies (worker/src/local_models.py):
//! container disk per profile, COMFY_LOG_LEVEL, PREFETCH_MODELS from the last
//! generated model, and the CUDA 13 host filter. Mocked RunPod only.

use app_lib::db::Db;
use app_lib::jobs::Job;
use app_lib::pod::{self, GpuState, GpuStatus, Profile, VolumeInfo};
use app_lib::registry::Registry;
use app_lib::settings::{MemoryStore, SecretStore, Settings, ACCOUNT_POD_TOKEN, ACCOUNT_RUNPOD};
use app_lib::state::{Clock, Core, CoreConfig, EventSink};
use app_lib::status::StatusView;
use app_lib::tasks::Task;
use chrono::Utc;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;
use wiremock::matchers::{method, path};
use wiremock::{Mock, MockServer, ResponseTemplate};

struct Quiet;
impl EventSink for Quiet {
    fn job_update(&self, _: &Job) {}
    fn task_update(&self, _: &Task) {}
    fn status_update(&self, _: &StatusView) {}
    fn gpu_update(&self, _: &GpuState) {}
}

fn core(server_uri: &str, dir: &tempfile::TempDir) -> Arc<Core> {
    let store = Arc::new(MemoryStore::default());
    store.set(ACCOUNT_RUNPOD, Some("test-key")).unwrap();
    store.set(ACCOUNT_POD_TOKEN, Some("tok")).unwrap();
    let settings = Settings::new(store, HashMap::new(), dir.path().join("settings.json"));
    let now = Utc::now();
    let clock: Clock = Arc::new(move || now);
    let cfg = CoreConfig {
        data_dir: dir.path().to_path_buf(),
        runpod_root: server_uri.to_string(),
        civitai_root: server_uri.to_string(),
        hf_root: server_uri.to_string(),
        poll_interval: Duration::from_millis(10),
        rest_root: server_uri.to_string(),
        pod_proxy_template: format!("{server_uri}/proxy/{{podId}}"),
        pod_poll_interval: Duration::from_millis(10),
        pod_start_timeout: Duration::from_secs(5),
        pod_stop_timeout: Duration::from_secs(2),
        rest_timeout: Duration::from_secs(1),
        clock,
    };
    Core::new(
        Registry::embedded(),
        Db::open_in_memory().unwrap(),
        settings,
        Arc::new(Quiet),
        cfg,
    )
    .unwrap()
}

fn vol() -> VolumeInfo {
    VolumeInfo {
        id: "vol1".into(),
        data_center: "CA-MTL-3".into(),
        size_gb: 200,
    }
}

#[test]
fn payload_disk_env_and_cuda_filter_per_profile() {
    for (p, disk) in [(Profile::Image, 100), (Profile::Video, 120)] {
        let body = pod::create_payload_for(p, &vol(), "G", "tok", 30, None, "img", "main", "flux2");
        assert_eq!(body["disk"], disk, "{p:?}");
        assert_eq!(p.container_disk_gb(), disk);
        assert_eq!(body["gpu"]["minCudaVersion"], "13.0", "{p:?}");
        assert_eq!(body["gpu"]["id"], "G");
        assert!(body["gpu"].get("allowedCudaVersions").is_none(), "mutually exclusive with the floor");
        assert_eq!(body["env"]["COMFY_LOG_LEVEL"], "INFO");
        assert_eq!(body["env"]["PREFETCH_MODELS"], "flux2");
        assert!(body["env"].get("COMFY_EXTRA_ARGS").is_none(), "no --fast-disk");
    }
    // Disk holds every model of the profile (registry sizes) plus headroom.
    let bytes = |models: Vec<Value>| -> u64 {
        let mut seen = std::collections::HashSet::new();
        models
            .iter()
            .flat_map(|m| m["files"].as_array().cloned().unwrap_or_default())
            .filter(|f| seen.insert(f["filename"].as_str().unwrap_or("").to_string()))
            .map(|f| f["sizeBytes"].as_u64().unwrap_or(0))
            .sum()
    };
    let raw: Value = serde_json::from_str(include_str!("../../../shared/models.json")).unwrap();
    let image = bytes(raw["models"].as_array().unwrap().clone());
    let video = bytes(raw["videoModels"].as_array().unwrap().clone());
    let gb = 1_000_000_000u64;
    assert!(image + 8 * gb < u64::from(pod::CONTAINER_DISK_GB_IMAGE) * gb, "image {image}");
    assert!(video + 8 * gb < u64::from(pod::CONTAINER_DISK_GB_VIDEO) * gb, "video {video}");
}

#[test]
fn record_last_model_feeds_prefetch_per_profile() {
    let dir = tempfile::tempdir().unwrap();
    let c = core("http://127.0.0.1:9", &dir);
    assert_eq!(pod::prefetch_models(&c, Profile::Image), "");
    assert_eq!(pod::prefetch_models(&c, Profile::Video), "");
    pod::record_last_model(&c, Profile::Image, "flux2");
    pod::record_last_model(&c, Profile::Video, " h3 ");
    assert_eq!(pod::prefetch_models(&c, Profile::Image), "flux2");
    assert_eq!(pod::prefetch_models(&c, Profile::Video), "h3");
    let stored = |k: &str| c.db.lock().unwrap().get_setting(k).unwrap();
    assert_eq!(stored("last_model_image").as_deref(), Some("flux2"));
    assert_eq!(stored("last_model_video").as_deref(), Some("h3"));
    // Later generates overwrite; invalid ids are ignored.
    pod::record_last_model(&c, Profile::Image, "qwen");
    for bad in ["", "a,b", "x y", "../etc", &"z".repeat(65)] {
        pod::record_last_model(&c, Profile::Image, bad);
    }
    assert_eq!(pod::prefetch_models(&c, Profile::Image), "qwen");
    // A tampered stored value is not passed on.
    c.db.lock().unwrap().set_setting("last_model_video", "h3,ltx25").unwrap();
    assert_eq!(pod::prefetch_models(&c, Profile::Video), "");
}

#[tokio::test]
async fn start_sends_prefetch_and_names_the_cuda_filter_when_no_host_fits() {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/v2/pods"))
        .respond_with(ResponseTemplate::new(200)
            .set_body_json(json!({"pods": [], "pagination": {"hasNextPage": false}})))
        .mount(&server)
        .await;
    Mock::given(method("GET"))
        .and(path("/v2/network-volumes"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({"networkVolumes": [
            {"id": "xzrw5sl5ho", "name": "image-studio-models", "size": 100,
             "dataCenter": "EU-RO-1", "type": "STANDARD"}]})))
        .mount(&server)
        .await;
    // Every GPU type: no host matches (e.g. none with CUDA >= 13.0).
    Mock::given(method("POST"))
        .and(path("/v2/pods"))
        .respond_with(ResponseTemplate::new(400).set_body_json(json!({"title": "Bad Request",
            "status": 400, "detail": "There are no longer any instances available with the requested specifications."})))
        .mount(&server)
        .await;
    let dir = tempfile::tempdir().unwrap();
    let c = core(&server.uri(), &dir);
    pod::record_last_model(&c, Profile::Image, "zimage");
    pod::start(&c).unwrap();
    let mut state = pod::state(&c);
    for _ in 0..500 {
        state = pod::state(&c);
        if state.status == GpuStatus::Error || (state.status == GpuStatus::Stopped && state.error.is_some()) {
            break;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    let err = state.error.clone().unwrap_or_default();
    assert!(err.contains("CUDA 13.0"), "{err}");
    assert!(err.contains("minCudaVersion"), "{err}");
    let posts: Vec<Value> = server
        .received_requests()
        .await
        .unwrap()
        .iter()
        .filter(|r| r.method.as_str() == "POST")
        .map(|r| r.body_json::<Value>().unwrap())
        .collect();
    assert!(!posts.is_empty());
    for b in &posts {
        assert_eq!(b["env"]["PREFETCH_MODELS"], "zimage");
        assert_eq!(b["gpu"]["minCudaVersion"], "13.0");
        assert_eq!(b["disk"], 100);
    }
}
