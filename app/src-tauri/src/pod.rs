//! Dedicated GPU pod lifecycle (spec v3) via the RunPod REST API v2
//! (`https://api.runpod.io/v2`, schema: `GET /v2/openapi.json`):
//!
//! - start: `POST /v2/pods` (CreatePodRequest), then poll `GET /v2/pods/{id}`
//!   and the pod server (`/ping`, `/health`) until ComfyUI is ready
//! - stop: `DELETE /v2/pods/{id}` (terminate), then poll until it is gone
//! - adopt: on launch, `GET /v2/pods` and re-adopt a pod named `image-studio-gpu`
//! - idle: app-side auto-stop after `idleMinutes` without jobs or tasks, and
//!   from the Error state (after 2 min when a start or stop failed)
//!
//! Billing safety: a pod id is only forgotten once RunPod confirms the pod is
//! gone. Every cleanup is a checked terminate (delete + confirm); when it
//! fails the GPU shows Error with the pod id kept, so Stop / auto-stop retry.
//! Before creating, and after an ambiguous create error, pods are looked up
//! by name so a pod that was created anyway is adopted, never duplicated.
//!
//! State changes are emitted as `gpu-update`. Secrets are never logged.

use crate::runpod::RunpodClient;
use crate::state::Core;
use chrono::{DateTime, Utc};
use serde::Serialize;
use serde_json::{json, Map, Value};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::sync::watch;

pub const DEFAULT_REST_ROOT: &str = "https://api.runpod.io";
pub const DEFAULT_PROXY_TEMPLATE: &str = "https://{podId}-8000.proxy.runpod.net";
pub const POD_NAME: &str = "image-studio-gpu";
/// Default pod image (spec "v4"): the slim runtime image. Its boot script
/// fetches the worker code from GitHub at `WORKER_REF` on every start.
/// Overridable with the `podImage` config key (`Settings::pod_image`).
pub const POD_IMAGE: &str = "ghcr.io/algotradingfervid/image-studio-runtime:latest";
/// The pre-v4 all-in-one image (code baked in, ignores `WORKER_REF`). Set
/// `"podImage"` to this in the settings file to switch back without a rebuild.
pub const LEGACY_POD_IMAGE: &str = "ghcr.io/algotradingfervid/image-studio-worker:latest";
pub const VOLUME_PATH: &str = "/runpod-volume";
/// Display fallback before a pod reports its GPU (first default priority).
pub const GPU_TYPE: &str = crate::settings::DEFAULT_GPU_TYPES[0];
pub const CONTAINER_DISK_GB: u32 = 20;
pub const FALLBACK_COST_PER_HR: f64 = 2.49;
pub const HF_SECRET_REF: &str = "{{ RUNPOD_SECRET_image-studio-hf-token }}";
pub const CIVITAI_SECRET_REF: &str = "{{ RUNPOD_SECRET_image-studio-civitai-key }}";
/// Error with a pod after a failed start or stop: auto-stop after this long
/// without user action (instead of waiting `idleMinutes`).
pub const ERROR_AUTO_STOP_SECS: i64 = 120;
/// Shown when an automatic cleanup could not confirm the pod is gone.
pub const CLEANUP_FAILED: &str =
    "Couldn't stop the GPU pod automatically — press Stop (it may still be billing)";
/// Pod statuses that mean "coming up or up" (adoptable).
const LIVE_STATUSES: [&str; 3] = ["PROVISIONING", "STARTING", "RUNNING"];

pub const PHASE_CREATING: &str = "Creating pod";
pub const PHASE_MACHINE: &str = "Waiting for machine";
pub const PHASE_PULLING: &str = "Pulling image";
pub const PHASE_BOOTING: &str = "Booting ComfyUI";

/// SQLite `settings` keys.
pub const DB_POD_ID: &str = "gpu_pod_id";
pub const DB_VOLUME_SIZE_GB: &str = "gpu_volume_size_gb";

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum GpuStatus {
    Stopped,
    Starting,
    Running,
    Stopping,
    Error,
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum StopReason {
    /// The user pressed Stop.
    User,
    /// App-side auto-stop after `idleMinutes`.
    Idle,
    /// The pod vanished (its own idle watchdog, or the RunPod console).
    External,
}

/// `GpuState` from the spec, plus additive `leftRunning` and `stopReason`.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct GpuState {
    pub status: GpuStatus,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pod_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub gpu_type: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub started_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cost_per_hr: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub phase: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    pub idle_minutes: u32,
    pub left_running: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub stop_reason: Option<StopReason>,
    /// From the pod's `/health` `watchdog.armed`: whether the pod can
    /// terminate itself when idle. `None` when the pod doesn't report it.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub watchdog_armed: Option<bool>,
}

impl GpuState {
    pub fn stopped(idle_minutes: u32) -> GpuState {
        GpuState {
            status: GpuStatus::Stopped,
            pod_id: None,
            gpu_type: None,
            started_at: None,
            cost_per_hr: None,
            phase: None,
            error: None,
            idle_minutes,
            left_running: false,
            stop_reason: None,
            watchdog_armed: None,
        }
    }
}

struct Inner {
    state: GpuState,
    /// Bumped by every start/stop/adopt; a background start loop exits when
    /// the epoch it was started with is no longer current.
    epoch: u64,
    last_active: DateTime<Utc>,
    /// When the state last turned Error (cleared on leaving Error).
    error_since: Option<DateTime<Utc>>,
    /// The Error came from a failed start or stop: auto-stop any pod after
    /// `ERROR_AUTO_STOP_SECS` rather than `idleMinutes`.
    urgent: bool,
}

impl Inner {
    /// Keeps `error_since`/`urgent` in step with the status.
    fn track_error(&mut self, before: GpuStatus, now: DateTime<Utc>) {
        if self.state.status != GpuStatus::Error {
            self.error_since = None;
            self.urgent = false;
        } else if before != GpuStatus::Error {
            self.error_since = Some(now);
            self.urgent = false;
        }
    }
}

/// GPU pod state held by `Core`.
pub struct Gpu {
    inner: Mutex<Inner>,
    tx: watch::Sender<GpuState>,
}

impl Gpu {
    pub fn new(idle_minutes: u32, now: DateTime<Utc>) -> Gpu {
        let s = GpuState::stopped(idle_minutes);
        let (tx, _) = watch::channel(s.clone());
        Gpu {
            inner: Mutex::new(Inner {
                state: s,
                epoch: 0,
                last_active: now,
                error_since: None,
                urgent: false,
            }),
            tx,
        }
    }
}

// ---------------------------------------------------------------------------
// RunPod REST v2 client

#[derive(Debug)]
pub struct RestError {
    pub status: Option<u16>,
    pub message: String,
}

impl RestError {
    fn not_found(&self) -> bool {
        self.status == Some(404)
    }
}

impl From<RestError> for String {
    fn from(e: RestError) -> String {
        e.message
    }
}

#[derive(Clone)]
pub struct RestClient {
    http: reqwest::Client,
    root: String,
    key: String,
}

/// Network volume used by the pod.
#[derive(Debug, Clone, PartialEq)]
pub struct VolumeInfo {
    pub id: String,
    pub data_center: String,
    pub size_gb: u64,
}

impl RestClient {
    pub fn new(root: &str, key: &str) -> RestClient {
        RestClient::with_timeout(root, key, Duration::from_secs(60))
    }

    pub fn with_timeout(root: &str, key: &str, timeout: Duration) -> RestClient {
        RestClient {
            http: reqwest::Client::builder()
                .timeout(timeout)
                .build()
                .expect("http client"),
            root: root.trim_end_matches('/').to_string(),
            key: key.to_string(),
        }
    }

    async fn send(&self, req: reqwest::RequestBuilder) -> Result<Value, RestError> {
        let resp = req.bearer_auth(&self.key).send().await.map_err(|e| RestError {
            status: None,
            message: format!("Could not reach the RunPod API: {}", e.without_url()),
        })?;
        let status = resp.status().as_u16();
        let body = resp.text().await.unwrap_or_default();
        if (200..300).contains(&status) {
            if body.trim().is_empty() {
                return Ok(Value::Null);
            }
            return serde_json::from_str(&body).map_err(|_| RestError {
                status: Some(status),
                message: "The RunPod API returned an unreadable response".into(),
            });
        }
        // application/problem+json: {title, status, detail, errors?}
        let v: Value = serde_json::from_str(&body).unwrap_or(Value::Null);
        let mut detail = v
            .get("detail")
            .or_else(|| v.get("title"))
            .or_else(|| v.get("error"))
            .and_then(Value::as_str)
            .map(str::to_string)
            .unwrap_or_else(|| body.chars().take(300).collect());
        if let Some(errs) = v.get("errors").and_then(Value::as_array) {
            let list: Vec<&str> = errs.iter().filter_map(Value::as_str).collect();
            if !list.is_empty() {
                detail = format!("{detail} ({})", list.join("; "));
            }
        }
        let message = match status {
            401 => "RunPod rejected the API key (unauthorized). Check Settings.".to_string(),
            403 => format!("The RunPod API key is not allowed to do this: {detail}"),
            402 => "RunPod reports insufficient balance — add credit to start the GPU.".into(),
            _ => format!("RunPod API error {status}: {detail}"),
        };
        Err(RestError {
            status: Some(status),
            message,
        })
    }

    pub async fn list_pods(&self) -> Result<Vec<Value>, RestError> {
        let v = self
            .send(self.http.get(format!("{}/v2/pods", self.root)))
            .await?;
        Ok(v.get("pods")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default())
    }

    /// Pods named `POD_NAME` that are not TERMINATED.
    pub async fn find_named_pods(&self) -> Result<Vec<Value>, RestError> {
        Ok(self
            .list_pods()
            .await?
            .into_iter()
            .filter(|p| pod_str(p, "name") == Some(POD_NAME))
            .filter(|p| pod_str(p, "status") != Some("TERMINATED"))
            .collect())
    }

    pub async fn get_pod(&self, id: &str) -> Result<Value, RestError> {
        self.send(self.http.get(format!("{}/v2/pods/{id}", self.root)))
            .await
    }

    pub async fn create_pod(&self, body: &Value) -> Result<Value, RestError> {
        self.send(
            self.http
                .post(format!("{}/v2/pods", self.root))
                .json(body),
        )
        .await
    }

    pub async fn delete_pod(&self, id: &str) -> Result<(), RestError> {
        self.send(self.http.delete(format!("{}/v2/pods/{id}", self.root)))
            .await
            .map(|_| ())
    }

    /// The first volume in `names` (priority order) that exists
    /// (`GET /v2/network-volumes`).
    pub async fn find_volume(&self, names: &[String]) -> Result<VolumeInfo, String> {
        let v = self
            .send(self.http.get(format!("{}/v2/network-volumes", self.root)))
            .await?;
        let vols = v
            .get("networkVolumes")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        let vol = names
            .iter()
            .find_map(|n| {
                vols.iter()
                    .find(|x| x.get("name").and_then(Value::as_str) == Some(n.as_str()))
            })
            .ok_or_else(|| {
                format!(
                    "None of the network volumes [{}] exist in your RunPod account",
                    names.join(", ")
                )
            })?;
        let s = |k: &str| vol.get(k).and_then(Value::as_str).unwrap_or("").to_string();
        Ok(VolumeInfo {
            id: s("id"),
            data_center: s("dataCenter"),
            size_gb: vol.get("size").and_then(Value::as_u64).unwrap_or(0),
        })
    }
}

// ---------------------------------------------------------------------------
// Pure helpers

/// `CreatePodRequest` body for `POST /v2/pods` (one GPU type per request:
/// `BaseGpuConfig` takes a single `id`). `api_key` is passed to the pod as
/// `RUNPOD_TERMINATE_API_KEY` only when `pass_api_key_to_pod` is on, for its
/// self-terminate watchdog (RunPod injects its own `RUNPOD_API_KEY`).
/// `image` is `Settings::pod_image`; `worker_ref` (`WORKER_REF`) is the git
/// ref the runtime image's boot script fetches the worker code from.
pub fn create_payload(
    vol: &VolumeInfo,
    gpu_type: &str,
    token: &str,
    idle_minutes: u32,
    api_key: Option<&str>,
    image: &str,
    worker_ref: &str,
) -> Value {
    let mut env = Map::new();
    env.insert("MODE".into(), json!("pod"));
    env.insert("API_TOKEN".into(), json!(token));
    env.insert("IDLE_MINUTES".into(), json!(idle_minutes.to_string()));
    env.insert("WORKER_REF".into(), json!(worker_ref));
    env.insert("HF_TOKEN".into(), json!(HF_SECRET_REF));
    env.insert("CIVITAI_API_KEY".into(), json!(CIVITAI_SECRET_REF));
    if let Some(k) = api_key {
        env.insert("RUNPOD_TERMINATE_API_KEY".into(), json!(k));
    }
    json!({
        "name": POD_NAME,
        "image": image,
        "cloud": "SECURE",
        "gpu": {"id": gpu_type, "count": 1},
        "dataCenterIds": [vol.data_center],
        "disk": CONTAINER_DISK_GB,
        "mounts": {"network": [{"volumeId": vol.id, "path": VOLUME_PATH}]},
        "ports": ["8000/http"],
        "env": env,
    })
}

pub fn proxy_base(template: &str, pod_id: &str) -> String {
    template.replace("{podId}", pod_id)
}

fn pod_str<'a>(pod: &'a Value, k: &str) -> Option<&'a str> {
    pod.get(k).and_then(Value::as_str)
}

fn is_live(pod: &Value) -> bool {
    pod_str(pod, "status").is_some_and(|s| LIVE_STATUSES.contains(&s))
}

/// Pods named `POD_NAME` that are not TERMINATED (`GET /v2/pods`).
pub async fn find_named_pods(rest: &RestClient) -> Result<Vec<Value>, RestError> {
    rest.find_named_pods().await
}

fn pod_cost(pod: &Value) -> Option<f64> {
    pod.get("cost").and_then(Value::as_f64).filter(|c| *c > 0.0)
}

fn pod_gpu(pod: &Value) -> Option<String> {
    pod.pointer("/gpu/id")
        .and_then(Value::as_str)
        .map(str::to_string)
}

/// Cost-relevant start time: the pod's `startedAt`, else `createdAt`.
fn pod_started(pod: &Value) -> Option<String> {
    pod_str(pod, "startedAt")
        .or_else(|| pod_str(pod, "createdAt"))
        .map(str::to_string)
}

// ---------------------------------------------------------------------------
// State

pub fn state(core: &Core) -> GpuState {
    let mut s = core.gpu.inner.lock().unwrap().state.clone();
    s.idle_minutes = core.settings.idle_minutes();
    s
}

pub fn subscribe(core: &Core) -> watch::Receiver<GpuState> {
    core.gpu.tx.subscribe()
}

fn emit(core: &Core, s: &GpuState) {
    core.gpu.tx.send_replace(s.clone());
    core.sink.gpu_update(s);
}

/// Apply `f` to the state (only while `epoch` is current, if given) and emit
/// on change. Returns false when the epoch is stale.
fn set_state(core: &Core, epoch: Option<u64>, f: impl FnOnce(&mut GpuState)) -> bool {
    let now = (core.cfg.clock)();
    let changed = {
        let mut g = core.gpu.inner.lock().unwrap();
        if epoch.is_some_and(|e| e != g.epoch) {
            return false;
        }
        let before = g.state.clone();
        f(&mut g.state);
        g.state.idle_minutes = core.settings.idle_minutes();
        g.track_error(before.status, now);
        (g.state != before).then(|| g.state.clone())
    };
    if let Some(s) = changed {
        emit(core, &s);
    }
    true
}

fn is_current(core: &Core, epoch: u64) -> bool {
    core.gpu.inner.lock().unwrap().epoch == epoch
}

/// Record GPU activity (resets the idle timer).
pub fn touch(core: &Core) {
    let now = (core.cfg.clock)();
    core.gpu.inner.lock().unwrap().last_active = now;
}

fn persist_pod_id(core: &Core, id: Option<&str>) {
    let db = core.db.lock().unwrap();
    let r = db.set_setting(DB_POD_ID, id.unwrap_or(""));
    if let Err(e) = r {
        eprintln!("[pod] could not persist the pod id: {e}");
    }
}

fn stored_pod_id(core: &Core) -> Option<String> {
    core.db
        .lock()
        .unwrap()
        .get_setting(DB_POD_ID)
        .ok()
        .flatten()
        .filter(|s| !s.is_empty())
}

pub fn rest(core: &Core) -> Result<RestClient, String> {
    let key = core
        .settings
        .runpod_api_key()
        .ok_or("Add your RunPod API key in Settings first")?;
    Ok(RestClient::with_timeout(
        &core.cfg.rest_root,
        &key,
        core.cfg.rest_timeout,
    ))
}

/// Worker client for the running pod.
pub fn pod_client(core: &Core, pod_id: &str) -> Result<RunpodClient, String> {
    let token = core.settings.pod_token()?;
    Ok(RunpodClient::for_pod(
        &proxy_base(&core.cfg.pod_proxy_template, pod_id),
        &token,
    ))
}

/// Looks up the volume and caches its size (for the Models screen usage).
pub async fn lookup_volume(core: &Core, rest: &RestClient) -> Result<VolumeInfo, String> {
    let vol = rest.find_volume(&core.settings.volume_names()).await?;
    if vol.size_gb > 0 {
        let _ = core
            .db
            .lock()
            .unwrap()
            .set_setting(DB_VOLUME_SIZE_GB, &vol.size_gb.to_string());
    }
    Ok(vol)
}

pub fn cached_volume_size_gb(core: &Core) -> Option<u64> {
    core.db
        .lock()
        .unwrap()
        .get_setting(DB_VOLUME_SIZE_GB)
        .ok()
        .flatten()
        .and_then(|s| s.parse().ok())
        .filter(|n| *n > 0)
}

// ---------------------------------------------------------------------------
// Error helpers

fn cleanup_failed_msg(detail: &str) -> String {
    format!("{CLEANUP_FAILED}. Details: {detail}")
}

/// Marks the current Error as coming from a failed start/stop, so the
/// monitor stops any pod after `ERROR_AUTO_STOP_SECS`.
fn mark_urgent(core: &Core) {
    let mut g = core.gpu.inner.lock().unwrap();
    if g.state.status == GpuStatus::Error {
        g.urgent = true;
    }
}

/// A pod may still be billing: show Error with `id` tracked and persisted.
/// Applied regardless of the epoch, so a concurrent Stop can never hide it.
fn fail_with_pod(core: &Core, id: &str, msg: &str) {
    persist_pod_id(core, Some(id));
    set_state(core, None, |s| {
        s.status = GpuStatus::Error;
        s.phase = None;
        s.pod_id = Some(id.to_string());
        s.error = Some(msg.to_string());
    });
    mark_urgent(core);
}

/// A start (or adopt) loop failed: Error for this epoch.
fn fail_start(core: &Core, epoch: u64, msg: String) {
    eprintln!("[pod] start failed: {msg}");
    let applied = set_state(core, Some(epoch), |s| {
        s.status = GpuStatus::Error;
        s.phase = None;
        s.error = Some(msg);
    });
    if applied {
        mark_urgent(core);
    }
}

/// `id` is confirmed gone: stop tracking it.
fn forget_pod(core: &Core, epoch: Option<u64>, id: &str) {
    if stored_pod_id(core).as_deref() == Some(id) {
        persist_pod_id(core, None);
    }
    set_state(core, epoch, |s| {
        if s.pod_id.as_deref() == Some(id) {
            s.pod_id = None;
        }
    });
}

// ---------------------------------------------------------------------------
// Start

/// Starts the pod in the background (no-op when starting or running) and
/// returns the new state. Progress arrives as `gpu-update` events.
pub fn start(core: &Arc<Core>) -> Result<GpuState, String> {
    rest(core)?; // fail fast without an API key
    let (epoch, prev_pod) = {
        let mut g = core.gpu.inner.lock().unwrap();
        match g.state.status {
            GpuStatus::Running | GpuStatus::Starting => {
                drop(g);
                return Ok(state(core));
            }
            GpuStatus::Stopping => {
                return Err("The GPU is still stopping; try again in a moment".into())
            }
            GpuStatus::Stopped | GpuStatus::Error => {}
        }
        g.epoch += 1;
        let prev = g.state.pod_id.clone();
        (g.epoch, prev)
    };
    let prev_pod = prev_pod.or_else(|| stored_pod_id(core));
    set_state(core, Some(epoch), |s| {
        *s = GpuState {
            status: GpuStatus::Starting,
            pod_id: prev_pod.clone(),
            phase: Some(PHASE_CREATING.into()),
            ..GpuState::stopped(0)
        };
    });
    let core2 = core.clone();
    tokio::spawn(async move {
        if let Err(e) = start_inner(&core2, epoch, prev_pod).await {
            fail_start(&core2, epoch, e);
        }
    });
    Ok(state(core))
}

async fn start_inner(core: &Arc<Core>, epoch: u64, prev_pod: Option<String>) -> Result<(), String> {
    let rest = rest(core)?;
    // A pod left from an earlier error: reuse it if it is still coming up,
    // otherwise terminate it (confirmed) before creating a fresh one.
    let mut pod_id = None;
    if let Some(id) = prev_pod {
        match rest.get_pod(&id).await {
            Ok(p) if is_live(&p) => pod_id = Some(id),
            Ok(_) => {
                if let Err(e) = terminate(core, &id).await {
                    let msg = cleanup_failed_msg(&e);
                    fail_with_pod(core, &id, &msg);
                    return Err(msg);
                }
                forget_pod(core, Some(epoch), &id);
            }
            Err(e) if e.not_found() => forget_pod(core, Some(epoch), &id),
            Err(e) => return Err(e.message),
        }
    }
    // A pod named POD_NAME may exist that the app lost track of (e.g. an
    // ambiguous create): adopt it instead of creating a duplicate.
    if pod_id.is_none() {
        pod_id = claim_named_pod(core, &rest, epoch).await?;
    }
    let pod_id = match pod_id {
        Some(id) => id,
        None => create_pod(core, &rest, epoch).await?,
    };
    if !is_current(core, epoch) {
        return Ok(());
    }
    wait_ready(core, &rest, epoch, &pod_id).await
}

/// Before creating: terminates (confirmed) every named pod that is not
/// coming up, plus extra live duplicates, and adopts one live named pod
/// (the stored id first). Returns the adopted id.
async fn claim_named_pod(
    core: &Arc<Core>,
    rest: &RestClient,
    epoch: u64,
) -> Result<Option<String>, String> {
    let pods = find_named_pods(rest)
        .await
        .map_err(|e| format!("Could not check for an existing GPU pod: {}", e.message))?;
    let stored = stored_pod_id(core);
    let (mut live, dead): (Vec<&Value>, Vec<&Value>) = pods.iter().partition(|p| is_live(p));
    live.sort_by_key(|p| pod_str(p, "id") != stored.as_deref()); // stored id first
    let keep = live.first().copied();
    let extra = live.iter().skip(1).copied();
    for p in dead.into_iter().chain(extra) {
        let Some(id) = pod_str(p, "id") else { continue };
        eprintln!(
            "[pod] terminating leftover {POD_NAME} pod {id} ({})",
            pod_str(p, "status").unwrap_or("unknown")
        );
        if let Err(e) = terminate(core, id).await {
            let msg = cleanup_failed_msg(&e);
            fail_with_pod(core, id, &msg);
            return Err(msg);
        }
        forget_pod(core, Some(epoch), id);
    }
    let Some(pod) = keep else { return Ok(None) };
    let Some(id) = pod_str(pod, "id") else {
        return Ok(None);
    };
    eprintln!("[pod] adopting existing {POD_NAME} pod {id} instead of creating one");
    track_pod(core, epoch, pod, None);
    Ok(Some(id.to_string()))
}

/// Records `pod` as the current pod (persisted id, cost, GPU, start time).
fn track_pod(core: &Core, epoch: u64, pod: &Value, placed_gpu: Option<&str>) {
    let id = pod_str(pod, "id").unwrap_or("").to_string();
    persist_pod_id(core, Some(&id));
    set_state(core, Some(epoch), |s| {
        s.pod_id = Some(id.clone());
        s.cost_per_hr = pod_cost(pod).or(Some(FALLBACK_COST_PER_HR));
        s.gpu_type = pod_gpu(pod)
            .or(placed_gpu.map(str::to_string))
            .or(Some(GPU_TYPE.into()));
        s.started_at = pod_started(pod).or_else(|| Some(now_str(core)));
        s.phase = Some(PHASE_MACHINE.into());
    });
}

/// Creates the pod (GPU fallback). After an ambiguous error the pod may
/// exist anyway, so the pods are re-listed by name and a new one adopted.
async fn create_pod(core: &Arc<Core>, rest: &RestClient, epoch: u64) -> Result<String, String> {
    let vol = lookup_volume(core, rest).await?;
    let token = core.settings.pod_token()?;
    let key = core.settings.runpod_api_key();
    let key = key.as_deref().filter(|_| core.settings.pass_api_key_to_pod());
    let (pod, placed_gpu) = match create_with_fallback(core, rest, &vol, &token, key).await {
        Ok(x) => x,
        Err(CreateError {
            message,
            ambiguous: false,
            ..
        }) => return Err(message),
        Err(CreateError {
            message,
            ambiguous: true,
            gpu,
        }) => {
            eprintln!("[pod] create failed ambiguously; checking whether the pod exists: {message}");
            match find_created_pod(core, rest).await {
                Some(pod) => (pod, gpu),
                None if !is_current(core, epoch) => {
                    // Stopped meanwhile: don't let a pod that shows up later
                    // go unnoticed behind "Stopped" — Error (urgent) makes the
                    // monitor look for it by name and stop it.
                    let msg = format!(
                        "RunPod didn't confirm whether the GPU pod was created ({message}). If one appears, the app stops it automatically; you can also press Stop."
                    );
                    set_state(core, None, |s| {
                        s.status = GpuStatus::Error;
                        s.phase = None;
                        s.error = Some(msg.clone());
                    });
                    mark_urgent(core);
                    return Err(msg);
                }
                None => return Err(message),
            }
        }
    };
    let id = pod_str(&pod, "id").unwrap_or("").to_string();
    if !is_current(core, epoch) {
        // Stopped (or restarted) while the create was in flight: clean up,
        // unless a newer start already adopted this very pod.
        if state(core).pod_id.as_deref() != Some(id.as_str()) {
            if let Err(e) = terminate(core, &id).await {
                let msg = cleanup_failed_msg(&e);
                fail_with_pod(core, &id, &msg);
                return Err(msg);
            }
            forget_pod(core, None, &id);
        }
        return Err("superseded by a newer start/stop".into()); // not shown: the epoch moved on
    }
    track_pod(core, epoch, &pod, Some(&placed_gpu));
    Ok(id)
}

/// After an ambiguous create: lists the pods up to 3 times,
/// `pod_poll_interval` apart (3 s in production), for a live named pod.
async fn find_created_pod(core: &Core, rest: &RestClient) -> Option<Value> {
    for attempt in 1..=3 {
        tokio::time::sleep(core.cfg.pod_poll_interval).await;
        match find_named_pods(rest).await {
            Ok(pods) => {
                if let Some(p) = pods.into_iter().find(|p| is_live(p) && pod_str(p, "id").is_some()) {
                    eprintln!(
                        "[pod] the pod was created despite the error; adopting {}",
                        pod_str(&p, "id").unwrap_or("")
                    );
                    return Some(p);
                }
            }
            Err(e) => eprintln!("[pod] listing pods failed (attempt {attempt}/3): {}", e.message),
        }
    }
    None
}

struct CreateError {
    message: String,
    /// The pod may have been created anyway (network error, timeout, 5xx,
    /// 429, a 2xx without an id, ...).
    ambiguous: bool,
    gpu: String,
}

/// Tries each GPU type in priority order. Per the createPod docs, `400`
/// (cross-field rule or no capacity) and `403` (pool not accessible) mean
/// "try the next candidate" (no pod was created); anything else stops and
/// is ambiguous.
async fn create_with_fallback(
    core: &Core,
    rest: &RestClient,
    vol: &VolumeInfo,
    token: &str,
    api_key: Option<&str>,
) -> Result<(Value, String), CreateError> {
    let gpus = core.settings.gpu_types();
    let image = core.settings.pod_image();
    let worker_ref = core.settings.worker_ref();
    eprintln!("[pod] image {image}, WORKER_REF {worker_ref}");
    let mut last = String::new();
    for gpu in &gpus {
        let body = create_payload(
            vol,
            gpu,
            token,
            core.settings.idle_minutes(),
            api_key,
            &image,
            &worker_ref,
        );
        match rest.create_pod(&body).await {
            Ok(pod) if pod_str(&pod, "id").is_some() => return Ok((pod, gpu.clone())),
            Ok(_) => {
                return Err(CreateError {
                    message: "RunPod did not return a pod id".into(),
                    ambiguous: true,
                    gpu: gpu.clone(),
                })
            }
            Err(e) if matches!(e.status, Some(400 | 403)) => {
                eprintln!("[pod] {gpu} not placeable in {}: {}", vol.data_center, e.message);
                last = e.message;
            }
            Err(e) => {
                return Err(CreateError {
                    message: e.message,
                    ambiguous: true,
                    gpu: gpu.clone(),
                })
            }
        }
    }
    Err(CreateError {
        message: format!(
            "No GPU is available in {} right now (tried {}). Last error: {last}. Try again in a few minutes.",
            vol.data_center,
            gpus.join(", ")
        ),
        ambiguous: false,
        gpu: String::new(),
    })
}

fn now_str(core: &Core) -> String {
    (core.cfg.clock)().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

/// Poll the pod until ComfyUI is ready, updating the phase.
async fn wait_ready(core: &Arc<Core>, rest: &RestClient, epoch: u64, id: &str) -> Result<(), String> {
    let deadline = tokio::time::Instant::now() + core.cfg.pod_start_timeout;
    let client = pod_client(core, id)?;
    let http = reqwest::Client::builder()
        .timeout(Duration::from_secs(10))
        .build()
        .map_err(|e| e.to_string())?;
    let mut api_errors = 0;
    let mut phase = PHASE_MACHINE.to_string();
    loop {
        if !is_current(core, epoch) {
            return Ok(());
        }
        match rest.get_pod(id).await {
            Ok(pod) => {
                api_errors = 0;
                let status = pod_str(&pod, "status").unwrap_or("").to_string();
                phase = match status.as_str() {
                    "PROVISIONING" => PHASE_MACHINE.into(),
                    "STARTING" => PHASE_PULLING.into(),
                    "RUNNING" => {
                        let ping = http
                            .get(format!("{}/ping", client.base_url()))
                            .send()
                            .await
                            .is_ok_and(|r| r.status().is_success());
                        if !ping {
                            PHASE_PULLING.into()
                        } else {
                            match client.health().await {
                                Ok(h) if h.ready == Some(true) => {
                                    touch(core);
                                    let armed = h.watchdog.as_ref().and_then(|w| w.armed);
                                    set_state(core, Some(epoch), |s| {
                                        s.status = GpuStatus::Running;
                                        s.phase = None;
                                        s.error = None;
                                        s.pod_id = Some(id.to_string());
                                        s.watchdog_armed = armed;
                                        if let Some(c) = pod_cost(&pod) {
                                            s.cost_per_hr = Some(c);
                                        }
                                        s.cost_per_hr.get_or_insert(FALLBACK_COST_PER_HR);
                                        if let Some(g) = pod_gpu(&pod).or(h.gpu.clone()) {
                                            s.gpu_type = Some(g);
                                        }
                                        if let Some(t) = pod_started(&pod) {
                                            s.started_at = Some(t);
                                        }
                                        if s.started_at.is_none() {
                                            s.started_at = Some(now_str(core));
                                        }
                                    });
                                    return Ok(());
                                }
                                _ => PHASE_BOOTING.into(),
                            }
                        }
                    }
                    other => {
                        let other = if other.is_empty() { "unknown" } else { other };
                        let what = format!("The GPU pod stopped unexpectedly while starting (status {other}).");
                        if let Err(e) = terminate(core, id).await {
                            let msg = format!("{what} {}", cleanup_failed_msg(&e));
                            fail_with_pod(core, id, &msg);
                            return Err(msg);
                        }
                        forget_pod(core, Some(epoch), id);
                        return Err(format!(
                            "{what} It was terminated; check the worker image, then try again."
                        ));
                    }
                };
                set_state(core, Some(epoch), |s| {
                    s.phase = Some(phase.clone());
                    if let Some(c) = pod_cost(&pod) {
                        s.cost_per_hr = Some(c);
                    }
                    if let Some(t) = pod_started(&pod) {
                        s.started_at = Some(t);
                    }
                });
            }
            Err(e) if e.not_found() => {
                forget_pod(core, Some(epoch), id);
                return Err("The GPU pod disappeared while starting (terminated outside the app?)".into());
            }
            Err(e) => {
                api_errors += 1;
                if api_errors >= 20 {
                    // The pod id stays tracked: Stop / the auto-stop retry.
                    return Err(e.message);
                }
            }
        }
        if tokio::time::Instant::now() >= deadline {
            let mins = core.cfg.pod_start_timeout.as_secs().div_ceil(60);
            let what = format!("The GPU did not become ready within {mins} min (last phase: {phase}).");
            if let Err(e) = terminate(core, id).await {
                let msg = format!("{what} {}", cleanup_failed_msg(&e));
                fail_with_pod(core, id, &msg);
                return Err(msg);
            }
            forget_pod(core, Some(epoch), id);
            return Err(format!(
                "{what} The pod was terminated so it doesn't keep billing; try Start again."
            ));
        }
        tokio::time::sleep(core.cfg.pod_poll_interval).await;
    }
}

// ---------------------------------------------------------------------------
// Stop

/// Terminates every pod named `POD_NAME` plus the tracked/stored pod (even
/// if named differently) and confirms each is gone. On any failure the GPU
/// shows Error and keeps a remaining pod id.
pub async fn stop(core: &Arc<Core>, reason: StopReason) -> Result<GpuState, String> {
    let tracked = {
        let mut g = core.gpu.inner.lock().unwrap();
        match g.state.status {
            GpuStatus::Stopped | GpuStatus::Stopping => {
                drop(g);
                return Ok(state(core));
            }
            _ => {}
        }
        g.epoch += 1;
        g.state.pod_id.clone()
    };
    set_state(core, None, |s| {
        s.status = GpuStatus::Stopping;
        s.phase = None;
        s.error = None;
    });
    let mut ids: Vec<String> = tracked.into_iter().chain(stored_pod_id(core)).collect();
    let mut problems: Vec<String> = Vec::new();
    match rest(core) {
        Err(e) => problems.push(e),
        Ok(rest) => match find_named_pods(&rest).await {
            Ok(pods) => ids.extend(pods.iter().filter_map(|p| pod_str(p, "id")).map(str::to_string)),
            Err(e) => problems.push(format!(
                "couldn't list the pods to find every {POD_NAME} pod: {}",
                e.message
            )),
        },
    }
    let mut seen = std::collections::HashSet::new();
    ids.retain(|id| !id.is_empty() && seen.insert(id.clone()));

    // Terminate in parallel; each waits until its pod is gone.
    let handles: Vec<_> = ids
        .iter()
        .map(|id| {
            let (c, i) = (core.clone(), id.clone());
            (id.clone(), tokio::spawn(async move { terminate(&c, &i).await }))
        })
        .collect();
    let mut remaining: Vec<String> = Vec::new();
    for (id, h) in handles {
        let r = h.await.unwrap_or_else(|e| Err(format!("internal error: {e}")));
        if let Err(e) = r {
            problems.push(format!("pod {id}: {e}"));
            remaining.push(id);
        }
    }

    if !problems.is_empty() {
        let keep = remaining.first().cloned();
        persist_pod_id(core, keep.as_deref());
        let msg = format!(
            "Couldn't stop the GPU pod{} — it may still be billing. Press Stop to try again. ({})",
            if remaining.len() > 1 { "s" } else { "" },
            problems.join("; ")
        );
        set_state(core, None, |s| {
            s.status = GpuStatus::Error;
            s.phase = None;
            s.pod_id = keep.clone();
            s.error = Some(msg.clone());
        });
        mark_urgent(core);
        return Err(msg);
    }
    persist_pod_id(core, None);
    set_state(core, None, |s| {
        *s = GpuState {
            stop_reason: Some(reason),
            ..GpuState::stopped(0)
        };
    });
    Ok(state(core))
}

/// Deletes the pod and waits until RunPod reports it gone (404 or
/// TERMINATED). `Ok` only when that is confirmed.
async fn terminate(core: &Core, id: &str) -> Result<(), String> {
    let rest = rest(core)?;
    match rest.delete_pod(id).await {
        Ok(()) => {}
        Err(e) if e.not_found() => return Ok(()),
        Err(e) => return Err(e.message),
    }
    let deadline = tokio::time::Instant::now() + core.cfg.pod_stop_timeout;
    loop {
        match rest.get_pod(id).await {
            Err(e) if e.not_found() => return Ok(()),
            Ok(p) if pod_str(&p, "status") == Some("TERMINATED") => return Ok(()),
            _ => {}
        }
        if tokio::time::Instant::now() >= deadline {
            return Err("RunPod accepted the terminate request but the pod is still listed; check the RunPod console".into());
        }
        tokio::time::sleep(core.cfg.pod_poll_interval).await;
    }
}

// ---------------------------------------------------------------------------
// Adopt on launch

/// Finds an existing `image-studio-gpu` pod and re-adopts it.
pub async fn adopt(core: &Arc<Core>) -> Result<GpuState, String> {
    let rest = rest(core)?;
    let pods = find_named_pods(&rest).await?;
    let stored = stored_pod_id(core);
    let mut ours: Vec<&Value> = pods.iter().collect();
    ours.sort_by_key(|p| pod_str(p, "id") != stored.as_deref()); // stored id first
    let Some(pod) = ours.first().cloned().cloned() else {
        persist_pod_id(core, None);
        return Ok(state(core));
    };
    if ours.len() > 1 {
        eprintln!(
            "[pod] {} pods named {POD_NAME} exist; adopting one (Stop terminates all)",
            ours.len()
        );
    }
    let id = pod_str(&pod, "id").unwrap_or("").to_string();
    persist_pod_id(core, Some(&id));
    let epoch = {
        let mut g = core.gpu.inner.lock().unwrap();
        g.epoch += 1;
        g.epoch
    };
    let status = pod_str(&pod, "status").unwrap_or("");
    let base = GpuState {
        pod_id: Some(id.clone()),
        gpu_type: pod_gpu(&pod).or(Some(GPU_TYPE.into())),
        started_at: pod_started(&pod),
        cost_per_hr: pod_cost(&pod).or(Some(FALLBACK_COST_PER_HR)),
        left_running: true,
        ..GpuState::stopped(0)
    };
    if is_live(&pod) {
        set_state(core, Some(epoch), |s| {
            *s = GpuState {
                status: GpuStatus::Starting,
                phase: Some(PHASE_MACHINE.into()),
                ..base
            };
        });
        // An already-ready pod turns Running on the first poll.
        let core2 = core.clone();
        tokio::spawn(async move {
            if let Err(e) = wait_ready(&core2, &rest, epoch, &id).await {
                fail_start(&core2, epoch, e);
            }
        });
    } else {
        set_state(core, Some(epoch), |s| {
            *s = GpuState {
                status: GpuStatus::Error,
                error: Some(format!(
                    "A GPU pod named {POD_NAME} exists but is {}. Stop it, then Start again.",
                    status.to_lowercase()
                )),
                ..base
            };
        });
    }
    Ok(state(core))
}

// ---------------------------------------------------------------------------
// Ensure running (used by the worker target) and the idle/liveness tick

/// Starts the pod if needed and waits until it is running. `on_phase` gets
/// each startup phase; returns early with an error if `cancelled()`.
pub async fn ensure_running(
    core: &Arc<Core>,
    on_phase: &mut (dyn FnMut(&str) + Send),
    cancelled: &(dyn Fn() -> bool + Send + Sync),
) -> Result<String, String> {
    let mut rx = subscribe(core);
    if state(core).status != GpuStatus::Running {
        start(core)?;
    }
    let mut last_phase: Option<String> = None;
    loop {
        let s = state(core);
        match s.status {
            GpuStatus::Running => {
                touch(core);
                return s.pod_id.ok_or_else(|| "The GPU pod has no id".into());
            }
            GpuStatus::Starting => {
                let p = s.phase.unwrap_or_else(|| PHASE_CREATING.into());
                if last_phase.as_deref() != Some(&p) {
                    on_phase(&p);
                    last_phase = Some(p);
                }
            }
            GpuStatus::Error => {
                return Err(s.error.unwrap_or_else(|| "The GPU failed to start".into()))
            }
            GpuStatus::Stopped | GpuStatus::Stopping => {
                return Err("The GPU was stopped before it was ready".into())
            }
        }
        if cancelled() {
            return Err("cancelled".into());
        }
        tokio::select! {
            _ = rx.changed() => {}
            _ = tokio::time::sleep(Duration::from_millis(250)) => {}
        }
    }
}

pub fn is_busy(core: &Core) -> bool {
    !core.jobs.lock().unwrap().is_empty() || !core.tasks.lock().unwrap().is_empty()
}

/// True when quitting now could leave a billed pod behind (the UI asks).
pub fn needs_quit_confirm(core: &Core) -> bool {
    let s = state(core);
    match s.status {
        GpuStatus::Starting | GpuStatus::Running | GpuStatus::Stopping => true,
        GpuStatus::Error => s.pod_id.is_some() || stored_pod_id(core).is_some(),
        GpuStatus::Stopped => false,
    }
}

/// Stop before quitting: like `stop`, but also waits out a stop already in
/// progress, and fails unless the GPU ends Stopped (pods confirmed gone).
pub async fn stop_for_quit(core: &Arc<Core>) -> Result<GpuState, String> {
    let mut rx = subscribe(core);
    stop(core, StopReason::User).await?;
    let wait = core.cfg.pod_stop_timeout + Duration::from_secs(30);
    let _ = tokio::time::timeout(wait, async {
        while state(core).status == GpuStatus::Stopping {
            if rx.changed().await.is_err() {
                break;
            }
        }
    })
    .await;
    let s = state(core);
    match s.status {
        GpuStatus::Stopped => Ok(s),
        GpuStatus::Stopping => Err("The GPU pod is still stopping; it may still be billing".into()),
        _ => Err(s
            .error
            .unwrap_or_else(|| "The GPU pod could not be stopped; it may still be billing".into())),
    }
}

/// App-side auto-stop. Running: stops after `idleMinutes` with no jobs or
/// tasks. Error with a pod (tracked, stored or found by name): stops after
/// `ERROR_AUTO_STOP_SECS` when a start/stop failed, else after
/// `idleMinutes`. Returns the new state when it stopped the pod.
pub async fn idle_check(core: &Arc<Core>) -> Option<GpuState> {
    let s = state(core);
    match s.status {
        GpuStatus::Running => {}
        GpuStatus::Error => return error_auto_stop(core, &s).await,
        _ => return None,
    }
    if is_busy(core) {
        touch(core);
        return None;
    }
    let idle_for = (core.cfg.clock)() - core.gpu.inner.lock().unwrap().last_active;
    let limit = chrono::Duration::minutes(core.settings.idle_minutes() as i64);
    if idle_for < limit {
        return None;
    }
    eprintln!("[pod] auto-stop after {} idle minutes", core.settings.idle_minutes());
    stop(core, StopReason::Idle).await.ok()
}

async fn error_auto_stop(core: &Arc<Core>, s: &GpuState) -> Option<GpuState> {
    let now = (core.cfg.clock)();
    let (since, urgent, last_active) = {
        let g = core.gpu.inner.lock().unwrap();
        (g.error_since.unwrap_or(now), g.urgent, g.last_active)
    };
    let due = if urgent {
        // Nothing useful runs on a pod whose start/stop failed.
        now - since >= chrono::Duration::seconds(ERROR_AUTO_STOP_SECS)
    } else {
        if is_busy(core) {
            touch(core);
            return None;
        }
        now - since.max(last_active) >= chrono::Duration::minutes(core.settings.idle_minutes() as i64)
    };
    if !due {
        return None;
    }
    let has_pod = s.pod_id.is_some()
        || stored_pod_id(core).is_some()
        || match rest(core) {
            Ok(r) => find_named_pods(&r).await.is_ok_and(|p| !p.is_empty()),
            Err(_) => false,
        };
    if !has_pod {
        return None;
    }
    eprintln!("[pod] auto-stop from the error state");
    stop(core, StopReason::Idle).await.ok()
}

/// Detects a pod that vanished (e.g. its own idle watchdog terminated it,
/// or the RunPod console) while Starting, Running or Error, and terminates
/// an EXITED pod (it still holds resources). Never creates pods.
pub async fn liveness_check(core: &Arc<Core>) {
    let (s, epoch) = {
        let g = core.gpu.inner.lock().unwrap();
        (g.state.clone(), g.epoch)
    };
    if !matches!(
        s.status,
        GpuStatus::Running | GpuStatus::Starting | GpuStatus::Error
    ) {
        return;
    }
    let Some(id) = s.pod_id else { return };
    let Ok(rest) = rest(core) else { return };
    let status = match rest.get_pod(&id).await {
        Err(e) if e.not_found() => "TERMINATED".to_string(),
        Err(_) => return,
        Ok(p) => pod_str(&p, "status").unwrap_or("").to_string(),
    };
    match status.as_str() {
        "TERMINATED" => mark_external(core, epoch, &id),
        // While Starting, wait_ready handles (and terminates) an EXITED pod.
        "EXITED" if s.status != GpuStatus::Starting => {
            if !is_current(core, epoch) {
                return;
            }
            eprintln!("[pod] pod {id} exited; terminating it");
            match terminate(core, &id).await {
                Ok(()) => mark_external(core, epoch, &id),
                Err(e) => {
                    if is_current(core, epoch) {
                        fail_with_pod(
                            core,
                            &id,
                            &format!("The GPU pod exited. {}", cleanup_failed_msg(&e)),
                        );
                    }
                }
            }
        }
        _ => {}
    }
}

/// The pod is confirmed gone: Stopped (External), unless the user acted
/// meanwhile. Bumps the epoch so a start loop for it exits quietly.
fn mark_external(core: &Core, epoch: u64, id: &str) {
    let now = (core.cfg.clock)();
    let s = {
        let mut g = core.gpu.inner.lock().unwrap();
        if g.epoch != epoch || g.state.pod_id.as_deref() != Some(id) {
            return;
        }
        g.epoch += 1;
        let before = g.state.status;
        g.state = GpuState {
            stop_reason: Some(StopReason::External),
            ..GpuState::stopped(core.settings.idle_minutes())
        };
        g.track_error(before, now);
        g.state.clone()
    };
    if stored_pod_id(core).as_deref() == Some(id) {
        persist_pod_id(core, None);
    }
    emit(core, &s);
}

/// Background loop, every `period`: idle/error auto-stop, else liveness.
pub async fn run_monitor(core: Arc<Core>, period: Duration) {
    loop {
        tokio::time::sleep(period).await;
        if idle_check(&core).await.is_none() {
            liveness_check(&core).await;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn payload_shape() {
        let vol = VolumeInfo {
            id: "vol1".into(),
            data_center: "US-NE-1".into(),
            size_gb: 100,
        };
        let p = create_payload(&vol, "G", "tok", 30, None, POD_IMAGE, "main");
        assert_eq!(p["gpu"], json!({"id": "G", "count": 1}));
        assert_eq!(p["image"], POD_IMAGE);
        assert_eq!(p["env"]["IDLE_MINUTES"], "30");
        assert_eq!(p["env"]["WORKER_REF"], "main");
        assert_eq!(p["env"]["MODE"], "pod");
        assert!(p["env"].get("RUNPOD_TERMINATE_API_KEY").is_none());
        let p = create_payload(&vol, "G", "tok", 30, None, LEGACY_POD_IMAGE, "abc123");
        assert_eq!(p["image"], LEGACY_POD_IMAGE);
        assert_eq!(p["env"]["WORKER_REF"], "abc123");
        let p = create_payload(&vol, "G", "tok", 30, Some("k"), POD_IMAGE, "main");
        assert_eq!(p["env"]["RUNPOD_TERMINATE_API_KEY"], "k");
        assert!(p["env"].get("RUNPOD_API_KEY").is_none());
        assert_eq!(
            proxy_base(DEFAULT_PROXY_TEMPLATE, "abc"),
            "https://abc-8000.proxy.runpod.net"
        );
    }

    #[test]
    fn state_serialises_camel_case() {
        let mut s = GpuState::stopped(30);
        s.stop_reason = Some(StopReason::Idle);
        let v = serde_json::to_value(&s).unwrap();
        assert_eq!(
            v,
            json!({"status": "stopped", "idleMinutes": 30, "leftRunning": false, "stopReason": "idle"})
        );
    }
}
