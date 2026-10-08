//! Dedicated GPU pod lifecycle (spec v3) via the RunPod REST API v2
//! (`https://api.runpod.io/v2`, schema: `GET /v2/openapi.json`):
//!
//! - start: `POST /v2/pods` (CreatePodRequest), then poll `GET /v2/pods/{id}`
//!   and the pod server (`/ping`, `/health`) until ComfyUI is ready
//! - stop: `DELETE /v2/pods/{id}` (terminate), then poll until it is gone
//! - adopt: on launch, `GET /v2/pods` and re-adopt a pod named `image-studio-gpu`
//! - idle: app-side auto-stop after `idleMinutes` without jobs or tasks
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
pub const POD_IMAGE: &str = "ghcr.io/algotradingfervid/image-studio-worker:latest";
pub const VOLUME_PATH: &str = "/runpod-volume";
/// Display fallback before a pod reports its GPU (first default priority).
pub const GPU_TYPE: &str = crate::settings::DEFAULT_GPU_TYPES[0];
pub const CONTAINER_DISK_GB: u32 = 20;
pub const FALLBACK_COST_PER_HR: f64 = 2.49;
pub const HF_SECRET_REF: &str = "{{ RUNPOD_SECRET_image-studio-hf-token }}";
pub const CIVITAI_SECRET_REF: &str = "{{ RUNPOD_SECRET_image-studio-civitai-key }}";

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
        }
    }
}

struct Inner {
    state: GpuState,
    /// Bumped by every start/stop/adopt; a background start loop exits when
    /// the epoch it was started with is no longer current.
    epoch: u64,
    last_active: DateTime<Utc>,
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
        RestClient {
            http: reqwest::Client::builder()
                .timeout(Duration::from_secs(60))
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
pub fn create_payload(
    vol: &VolumeInfo,
    gpu_type: &str,
    token: &str,
    idle_minutes: u32,
    api_key: Option<&str>,
) -> Value {
    let mut env = Map::new();
    env.insert("MODE".into(), json!("pod"));
    env.insert("API_TOKEN".into(), json!(token));
    env.insert("IDLE_MINUTES".into(), json!(idle_minutes.to_string()));
    env.insert("HF_TOKEN".into(), json!(HF_SECRET_REF));
    env.insert("CIVITAI_API_KEY".into(), json!(CIVITAI_SECRET_REF));
    if let Some(k) = api_key {
        env.insert("RUNPOD_TERMINATE_API_KEY".into(), json!(k));
    }
    json!({
        "name": POD_NAME,
        "image": POD_IMAGE,
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
    let changed = {
        let mut g = core.gpu.inner.lock().unwrap();
        if epoch.is_some_and(|e| e != g.epoch) {
            return false;
        }
        let before = g.state.clone();
        f(&mut g.state);
        g.state.idle_minutes = core.settings.idle_minutes();
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
    Ok(RestClient::new(&core.cfg.rest_root, &key))
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
            eprintln!("[pod] start failed: {e}");
            set_state(&core2, Some(epoch), |s| {
                s.status = GpuStatus::Error;
                s.phase = None;
                s.error = Some(e);
            });
        }
    });
    Ok(state(core))
}

async fn start_inner(core: &Arc<Core>, epoch: u64, prev_pod: Option<String>) -> Result<(), String> {
    let rest = rest(core)?;
    // A pod left from an earlier error: reuse it if it is still coming up,
    // otherwise terminate it before creating a fresh one.
    let mut pod_id = None;
    if let Some(id) = prev_pod {
        match rest.get_pod(&id).await {
            Ok(p) if matches!(pod_str(&p, "status"), Some("PROVISIONING" | "STARTING" | "RUNNING")) => {
                pod_id = Some(id)
            }
            Ok(_) => {
                let _ = rest.delete_pod(&id).await;
                persist_pod_id(core, None);
            }
            Err(e) if e.not_found() => persist_pod_id(core, None),
            Err(e) => return Err(e.message),
        }
    }
    let pod_id = match pod_id {
        Some(id) => id,
        None => {
            let vol = lookup_volume(core, &rest).await?;
            let token = core.settings.pod_token()?;
            let key = core.settings.runpod_api_key();
            let key = key.as_deref().filter(|_| core.settings.pass_api_key_to_pod());
            let (pod, placed_gpu) = create_with_fallback(core, &rest, &vol, &token, key).await?;
            let id = pod_str(&pod, "id")
                .ok_or("RunPod did not return a pod id")?
                .to_string();
            persist_pod_id(core, Some(&id));
            if !is_current(core, epoch) {
                // Stopped while the create was in flight: clean up.
                let _ = rest.delete_pod(&id).await;
                persist_pod_id(core, None);
                return Ok(());
            }
            set_state(core, Some(epoch), |s| {
                s.pod_id = Some(id.clone());
                s.cost_per_hr = pod_cost(&pod).or(Some(FALLBACK_COST_PER_HR));
                s.gpu_type = pod_gpu(&pod).or(Some(placed_gpu.clone()));
                s.started_at = pod_started(&pod).or_else(|| Some(now_str(core)));
                s.phase = Some(PHASE_MACHINE.into());
            });
            id
        }
    };
    wait_ready(core, &rest, epoch, &pod_id).await
}

/// Tries each GPU type in priority order. Per the createPod docs, `400`
/// (cross-field rule or no capacity) and `403` (pool not accessible) mean
/// "try the next candidate"; anything else stops.
async fn create_with_fallback(
    core: &Core,
    rest: &RestClient,
    vol: &VolumeInfo,
    token: &str,
    api_key: Option<&str>,
) -> Result<(Value, String), String> {
    let gpus = core.settings.gpu_types();
    let mut last = String::new();
    for gpu in &gpus {
        let body = create_payload(vol, gpu, token, core.settings.idle_minutes(), api_key);
        match rest.create_pod(&body).await {
            Ok(pod) => return Ok((pod, gpu.clone())),
            Err(e) if matches!(e.status, Some(400 | 403)) => {
                eprintln!("[pod] {gpu} not placeable in {}: {}", vol.data_center, e.message);
                last = e.message;
            }
            Err(e) => return Err(e.message),
        }
    }
    Err(format!(
        "No GPU is available in {} right now (tried {}). Last error: {last}. Try again in a few minutes.",
        vol.data_center,
        gpus.join(", ")
    ))
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
                                    set_state(core, Some(epoch), |s| {
                                        s.status = GpuStatus::Running;
                                        s.phase = None;
                                        s.error = None;
                                        s.pod_id = Some(id.to_string());
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
                        persist_pod_id(core, None);
                        let _ = rest.delete_pod(id).await;
                        return Err(format!(
                            "The GPU pod stopped unexpectedly while starting (status {}). It was terminated; check the worker image, then try again.",
                            if other.is_empty() { "unknown" } else { other }
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
                persist_pod_id(core, None);
                return Err("The GPU pod disappeared while starting (terminated outside the app?)".into());
            }
            Err(e) => {
                api_errors += 1;
                if api_errors >= 20 {
                    return Err(e.message);
                }
            }
        }
        if tokio::time::Instant::now() >= deadline {
            let mins = core.cfg.pod_start_timeout.as_secs().div_ceil(60);
            let _ = rest.delete_pod(id).await;
            persist_pod_id(core, None);
            return Err(format!(
                "The GPU did not become ready within {mins} min (last phase: {phase}). The pod was terminated so it doesn't keep billing; try Start again."
            ));
        }
        tokio::time::sleep(core.cfg.pod_poll_interval).await;
    }
}

// ---------------------------------------------------------------------------
// Stop

/// Terminates the pod and waits until it is gone.
pub async fn stop(core: &Arc<Core>, reason: StopReason) -> Result<GpuState, String> {
    let pod_id = {
        let mut g = core.gpu.inner.lock().unwrap();
        match g.state.status {
            GpuStatus::Stopped => {
                drop(g);
                return Ok(state(core));
            }
            GpuStatus::Stopping => {
                drop(g);
                return Ok(state(core));
            }
            _ => {}
        }
        g.epoch += 1;
        g.state.pod_id.clone()
    }
    .or_else(|| stored_pod_id(core));
    set_state(core, None, |s| {
        s.status = GpuStatus::Stopping;
        s.phase = None;
        s.error = None;
    });
    if let Some(id) = pod_id.as_deref() {
        if let Err(e) = terminate(core, id).await {
            set_state(core, None, |s| {
                s.status = GpuStatus::Error;
                s.pod_id = Some(id.to_string());
                s.error = Some(format!("Could not stop the GPU pod: {e}"));
            });
            return Err(format!("Could not stop the GPU pod: {e}"));
        }
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
    let pods = rest.list_pods().await?;
    let stored = stored_pod_id(core);
    let mut ours: Vec<&Value> = pods
        .iter()
        .filter(|p| pod_str(p, "name") == Some(POD_NAME))
        .filter(|p| pod_str(p, "status") != Some("TERMINATED"))
        .collect();
    ours.sort_by_key(|p| pod_str(p, "id") != stored.as_deref()); // stored id first
    let Some(pod) = ours.first().cloned().cloned() else {
        persist_pod_id(core, None);
        return Ok(state(core));
    };
    if ours.len() > 1 {
        eprintln!(
            "[pod] {} pods named {POD_NAME} exist; adopting one",
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
    if matches!(status, "PROVISIONING" | "STARTING" | "RUNNING") {
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
                set_state(&core2, Some(epoch), |s| {
                    s.status = GpuStatus::Error;
                    s.phase = None;
                    s.error = Some(e);
                });
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

/// App-side auto-stop: stops a running pod after `idleMinutes` with no jobs
/// or tasks. Returns the new state when it stopped the pod.
pub async fn idle_check(core: &Arc<Core>) -> Option<GpuState> {
    if state(core).status != GpuStatus::Running {
        return None;
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

/// Detects a pod that vanished (e.g. its own idle watchdog terminated it).
pub async fn liveness_check(core: &Arc<Core>) {
    let s = state(core);
    if s.status != GpuStatus::Running {
        return;
    }
    let Some(id) = s.pod_id else { return };
    let Ok(rest) = rest(core) else { return };
    let gone = match rest.get_pod(&id).await {
        Err(e) => e.not_found(),
        Ok(p) => matches!(pod_str(&p, "status"), Some("TERMINATED" | "EXITED")),
    };
    if gone {
        let epoch = core.gpu.inner.lock().unwrap().epoch;
        persist_pod_id(core, None);
        set_state(core, Some(epoch), |s| {
            *s = GpuState {
                stop_reason: Some(StopReason::External),
                ..GpuState::stopped(0)
            };
        });
    }
}

/// Background loop: idle auto-stop and liveness, every `period`.
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
        let p = create_payload(&vol, "G", "tok", 30, None);
        assert_eq!(p["gpu"], json!({"id": "G", "count": 1}));
        assert_eq!(p["env"]["IDLE_MINUTES"], "30");
        assert!(p["env"].get("RUNPOD_TERMINATE_API_KEY").is_none());
        let p = create_payload(&vol, "G", "tok", 30, Some("k"));
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
