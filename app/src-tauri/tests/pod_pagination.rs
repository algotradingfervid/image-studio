//! `GET /v2/pods` cursor pagination (RunPod REST v2 `listPods`): every page is
//! followed, a failed page fails the listing, and a page cap stops runaway
//! cursors. Mocked RunPod API (wiremock); no real resources.

use app_lib::db::Db;
use app_lib::jobs::Job;
use app_lib::pod::{self, GpuState, GpuStatus, RestClient, StopReason, LIST_PODS_MAX_PAGES};
use app_lib::registry::Registry;
use app_lib::settings::{MemoryStore, SecretStore, Settings, ACCOUNT_POD_TOKEN, ACCOUNT_RUNPOD};
use app_lib::state::{Clock, Core, CoreConfig, EventSink};
use app_lib::status::StatusView;
use app_lib::tasks::Task;
use chrono::Utc;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use wiremock::matchers::{method, path, path_regex};
use wiremock::{Mock, MockServer, Request, Respond, ResponseTemplate};

struct Quiet;
impl EventSink for Quiet {
    fn job_update(&self, _: &Job) {}
    fn task_update(&self, _: &Task) {}
    fn status_update(&self, _: &StatusView) {}
    fn gpu_update(&self, _: &GpuState) {}
}

struct Harness {
    core: Arc<Core>,
    _dir: tempfile::TempDir,
}

fn harness(server: &MockServer) -> Harness {
    let dir = tempfile::tempdir().unwrap();
    let store = Arc::new(MemoryStore::default());
    store.set(ACCOUNT_RUNPOD, Some("test-key")).unwrap();
    store.set(ACCOUNT_POD_TOKEN, Some("t")).unwrap();
    let settings = Settings::new(store, HashMap::new(), dir.path().join("settings.json"));
    let now = Utc::now();
    let clock: Clock = Arc::new(move || now);
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
        rest_timeout: Duration::from_secs(2),
        clock,
    };
    let core = Core::new(
        Registry::embedded(),
        Db::open_in_memory().unwrap(),
        settings,
        Arc::new(Quiet),
        cfg,
    )
    .unwrap();
    Harness { core, _dir: dir }
}

fn ok(v: Value) -> ResponseTemplate {
    ResponseTemplate::new(200).set_body_json(v)
}

fn named(id: &str) -> Value {
    json!({"id": id, "name": "image-studio-gpu", "status": "RUNNING", "cost": 2.39,
           "gpu": {"id": "NVIDIA RTX PRO 6000 Blackwell Server Edition", "count": 1},
           "dataCenterId": "EU-RO-1", "createdAt": "2026-10-09T10:00:00Z",
           "startedAt": "2026-10-09T10:00:05Z", "env": {}})
}

fn other(id: &str) -> Value {
    json!({"id": id, "name": "someone-elses-pod", "status": "RUNNING", "cost": 0.44})
}

/// Opaque cursor for page `i` (chars that need URL encoding on purpose).
fn cursor(i: usize) -> String {
    format!("Y3Jl+/={i}&x")
}

/// RunPod pods API with the pod list cut into fixed pages. `GET /v2/pods`
/// honours the `cursor` query parameter; `fail_page` answers 500 for that
/// page index. Pod GET/DELETE work against the full set.
#[derive(Clone)]
struct Paged(Arc<Mutex<PagedState>>);
struct PagedState {
    pages: Vec<Vec<Value>>,
    fail_page: Option<usize>,
    list_cursors: Vec<Option<String>>,
    deletes: Vec<String>,
}

impl Paged {
    fn new(pages: Vec<Vec<Value>>) -> Paged {
        Paged(Arc::new(Mutex::new(PagedState {
            pages,
            fail_page: None,
            list_cursors: vec![],
            deletes: vec![],
        })))
    }
    async fn mount(&self, server: &MockServer) {
        Mock::given(path_regex(r"^/v2/pods(/[^/]+)?$"))
            .respond_with(self.clone())
            .mount(server)
            .await;
    }
    fn deletes(&self) -> Vec<String> {
        let mut d = self.0.lock().unwrap().deletes.clone();
        d.sort();
        d
    }
    fn list_cursors(&self) -> Vec<Option<String>> {
        self.0.lock().unwrap().list_cursors.clone()
    }
}

impl Respond for Paged {
    fn respond(&self, r: &Request) -> ResponseTemplate {
        let mut s = self.0.lock().unwrap();
        let id = r.url.path().strip_prefix("/v2/pods/").map(str::to_string);
        match (r.method.as_str(), id) {
            ("GET", None) => {
                let c = r
                    .url
                    .query_pairs()
                    .find(|(k, _)| k == "cursor")
                    .map(|(_, v)| v.into_owned());
                s.list_cursors.push(c.clone());
                let i = match c {
                    None => 0,
                    Some(c) => match (0..s.pages.len()).find(|&i| cursor(i) == c) {
                        Some(i) => i,
                        None => {
                            return ResponseTemplate::new(422)
                                .set_body_json(json!({"title": "Unprocessable", "status": 422, "detail": "bad cursor"}))
                        }
                    },
                };
                if s.fail_page == Some(i) {
                    return ResponseTemplate::new(500)
                        .set_body_json(json!({"title": "Internal Server Error", "status": 500, "detail": "boom"}));
                }
                let more = i + 1 < s.pages.len();
                ok(json!({"pods": s.pages[i], "pagination": {
                    "hasNextPage": more,
                    "nextCursor": if more { Value::from(cursor(i + 1)) } else { Value::Null }
                }}))
            }
            ("GET", Some(id)) => match s.pages.iter().flatten().find(|p| p["id"] == id.as_str()) {
                Some(p) => ok(p.clone()),
                None => ResponseTemplate::new(404)
                    .set_body_json(json!({"title": "Not Found", "status": 404, "detail": "pod not found"})),
            },
            ("DELETE", Some(id)) => {
                s.deletes.push(id.clone());
                for page in s.pages.iter_mut() {
                    page.retain(|p| p["id"] != id.as_str());
                }
                ResponseTemplate::new(204)
            }
            _ => ResponseTemplate::new(405),
        }
    }
}

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

#[tokio::test]
async fn list_pods_follows_every_page_with_the_cursor() {
    let server = MockServer::start().await;
    let api = Paged::new(vec![
        vec![other("a1"), other("a2")],
        vec![other("b1")],
        vec![named("c1")],
    ]);
    api.mount(&server).await;
    let rest = RestClient::new(&server.uri(), "test-key");
    let ids: Vec<String> = rest
        .list_pods()
        .await
        .unwrap()
        .iter()
        .map(|p| p["id"].as_str().unwrap().to_string())
        .collect();
    assert_eq!(ids, ["a1", "a2", "b1", "c1"]);
    // First request has no cursor; later ones pass nextCursor verbatim.
    assert_eq!(api.list_cursors(), vec![None, Some(cursor(1)), Some(cursor(2))]);
}

#[tokio::test]
async fn named_pod_only_on_page_two_is_adopted() {
    let server = MockServer::start().await;
    let api = Paged::new(vec![vec![other("x1"), other("x2")], vec![named("late")]]);
    api.mount(&server).await;
    mount_ready_pod_server(&server, "late").await;
    let h = harness(&server);
    pod::adopt(&h.core).await.unwrap();
    let s = wait_for(&h.core, GpuStatus::Running).await;
    assert_eq!(s.pod_id.as_deref(), Some("late"));
    assert!(s.left_running);
}

#[tokio::test]
async fn stop_by_name_terminates_a_named_pod_on_page_two() {
    let server = MockServer::start().await;
    let api = Paged::new(vec![
        vec![named("first"), other("x1")],
        vec![other("x2"), named("second")],
    ]);
    api.mount(&server).await;
    mount_ready_pod_server(&server, "first").await;
    let h = harness(&server);
    h.core.db.lock().unwrap().set_setting(pod::DB_POD_ID, "first").unwrap();
    pod::adopt(&h.core).await.unwrap();
    let s = wait_for(&h.core, GpuStatus::Running).await;
    assert_eq!(s.pod_id.as_deref(), Some("first"));

    let s = pod::stop(&h.core, StopReason::User).await.unwrap();
    assert_eq!(s.status, GpuStatus::Stopped);
    // The untracked pod on page 2 is stopped too; other pods are untouched.
    assert_eq!(api.deletes(), vec!["first", "second"]);
}

#[tokio::test]
async fn an_error_on_page_two_fails_the_listing() {
    let server = MockServer::start().await;
    let api = Paged::new(vec![vec![other("x1")], vec![named("late")]]);
    api.0.lock().unwrap().fail_page = Some(1);
    api.mount(&server).await;

    let rest = RestClient::new(&server.uri(), "test-key");
    let e = rest.list_pods().await.unwrap_err();
    assert_eq!(e.status, Some(500), "{}", e.message);
    assert!(rest.find_named_pods("image-studio-gpu").await.is_err());

    // Adopt reports the failure instead of treating it as "no pod".
    let h = harness(&server);
    assert!(pod::adopt(&h.core).await.is_err());
}

#[tokio::test]
async fn has_next_page_without_a_cursor_fails_the_listing() {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/v2/pods"))
        .respond_with(ok(json!({"pods": [other("x1")],
            "pagination": {"hasNextPage": true, "nextCursor": null}})))
        .expect(1)
        .mount(&server)
        .await;
    let rest = RestClient::new(&server.uri(), "test-key");
    let e = rest.list_pods().await.unwrap_err();
    assert!(e.message.contains("no cursor"), "{}", e.message);
    server.verify().await;
}

/// Always says there is another page.
struct Endless(std::sync::atomic::AtomicUsize);
impl Respond for Endless {
    fn respond(&self, _: &Request) -> ResponseTemplate {
        let n = self.0.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        ok(json!({"pods": [other(&format!("p{n}"))],
            "pagination": {"hasNextPage": true, "nextCursor": format!("c{}", n + 1)}}))
    }
}

#[tokio::test]
async fn page_cap_fails_instead_of_truncating() {
    let server = MockServer::start().await;
    Mock::given(method("GET"))
        .and(path("/v2/pods"))
        .respond_with(Endless(Default::default()))
        .expect(LIST_PODS_MAX_PAGES as u64)
        .mount(&server)
        .await;
    let rest = RestClient::new(&server.uri(), "test-key");
    let e = rest.list_pods().await.unwrap_err();
    assert!(e.message.contains("partial list"), "{}", e.message);
    server.verify().await;
}
