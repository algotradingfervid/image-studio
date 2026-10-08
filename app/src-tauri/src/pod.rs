//! Dedicated GPU pod lifecycle (spec v3) via the RunPod REST API v2
//! (`https://api.runpod.io/v2`, schema: `GET /v2/openapi.json`):
//!
//! - start: `POST /v2/pods` (CreatePodRequest), then poll `GET /v2/pods/{id}`
//!   and the pod server (`/ping`, `/health`) until ComfyUI is ready
//! - stop: `DELETE /v2/pods/{id}` (terminate), then poll until it is gone
//! - adopt: on launch, `GET /v2/pods` and re-adopt a pod named after the
//!   profile (`image-studio-gpu` / `image-studio-video-gpu`)
//! - idle: app-side auto-stop after `idleMinutes` without jobs or tasks, and
//!   from the Error state (after 2 min when a start or stop failed)
//!
//! Billing safety: a pod id is only forgotten once RunPod confirms the pod is
//! gone. Every cleanup is a checked terminate (delete + confirm); when it
//! fails the GPU shows Error with the pod id kept, so Stop / auto-stop retry.
//! Before creating, and after an ambiguous create error, pods are looked up
//! by name so a pod that was created anyway is adopted, never duplicated.
//!
//! Profiles (spec v5): `image` and `video` are independent pods, each with its
//! own state, epoch, idle timer, stored pod id, volume list and GPU list, and
//! the full safety logic above. Pods are matched by EXACT name, so one
//! profile never adopts, stops or terminates the other's pod. The video
//! profile refuses to start in `US-*` / `EU-*` datacenters (licence).
//!
//! State changes are emitted as `gpu-update` (with `profile`). Secrets are
//! never logged.

use crate::runpod::RunpodClient;
use crate::state::Core;
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::sync::watch;

pub const DEFAULT_REST_ROOT: &str = "https://api.runpod.io";
pub const DEFAULT_PROXY_TEMPLATE: &str = "https://{podId}-8000.proxy.runpod.net";
pub const POD_NAME: &str = "image-studio-gpu";
/// The video profile's pod (spec v5).
pub const VIDEO_POD_NAME: &str = "image-studio-video-gpu";
/// Datacenter id prefixes the video profile must never run in (MiniMax H3
/// licence: excluded territories EU/UK/KR/US).
pub const VIDEO_EXCLUDED_DC_PREFIXES: [&str; 2] = ["US-", "EU-"];
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
pub const VIDEO_GPU_TYPE: &str = crate::settings::DEFAULT_VIDEO_GPU_TYPES[0];
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

/// SQLite `settings` keys (image profile; the video profile has its own).
pub const DB_POD_ID: &str = "gpu_pod_id";
pub const DB_VOLUME_SIZE_GB: &str = "gpu_volume_size_gb";
pub const DB_VIDEO_POD_ID: &str = "video_gpu_pod_id";
pub const DB_VIDEO_VOLUME_SIZE_GB: &str = "video_gpu_volume_size_gb";

/// A GPU pod profile (spec v5).
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Hash, Default)]
#[serde(rename_all = "lowercase")]
pub enum Profile {
    #[default]
    Image,
    Video,
}

impl Profile {
    pub const ALL: [Profile; 2] = [Profile::Image, Profile::Video];

    /// Pod name; pods are matched by this exact name.
    pub fn pod_name(self) -> &'static str {
        match self {
            Profile::Image => POD_NAME,
            Profile::Video => VIDEO_POD_NAME,
        }
    }

    pub fn db_pod_id(self) -> &'static str {
        match self {
            Profile::Image => DB_POD_ID,
            Profile::Video => DB_VIDEO_POD_ID,
        }
    }

    pub fn db_volume_size(self) -> &'static str {
        match self {
            Profile::Image => DB_VOLUME_SIZE_GB,
            Profile::Video => DB_VIDEO_VOLUME_SIZE_GB,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Profile::Image => "image",
            Profile::Video => "video",
        }
    }

    fn default_gpu(self) -> &'static str {
        match self {
            Profile::Image => GPU_TYPE,
            Profile::Video => VIDEO_GPU_TYPE,
        }
    }

    fn index(self) -> usize {
        match self {
            Profile::Image => 0,
            Profile::Video => 1,
        }
    }

    /// Command argument: absent → `image` (backward compatible).
    pub fn parse(s: Option<&str>) -> Result<Profile, String> {
        match s.map(str::trim) {
            None | Some("") | Some("image") => Ok(Profile::Image),
            Some("video") => Ok(Profile::Video),
            Some(o) => Err(format!("Unknown GPU profile \"{o}\" (use image or video)")),
        }
    }
}

/// The video profile must not run where the H3 licence excludes it.
pub fn check_datacenter(p: Profile, data_center: &str) -> Result<(), String> {
    if p == Profile::Video
        && VIDEO_EXCLUDED_DC_PREFIXES
            .iter()
            .any(|x| data_center.to_ascii_uppercase().starts_with(x))
    {
        return Err(format!(
            "The video GPU can't run in {data_center}: the MiniMax H3 licence excludes the EU, UK, South Korea and the USA. Use the Canada volume (image-studio-video in CA-MTL-3) — check videoVolumeNames in the settings file."
        ));
    }
    Ok(())
}

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
    pub profile: Profile,
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
        GpuState::stopped_for(Profile::Image, idle_minutes)
    }

    pub fn stopped_for(profile: Profile, idle_minutes: u32) -> GpuState {
        GpuState {
            profile,
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
    /// The startup adopt has listed RunPod's pods at least once this session.
    /// Until it has, the monitor retries it so a pod left running by a
    /// previous session is never forgotten after a failed first lookup.
    adopted: bool,
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

/// One profile's pod state.
struct Slot {
    inner: Mutex<Inner>,
    tx: watch::Sender<GpuState>,
}

/// GPU pod state held by `Core`: one independent slot per profile.
pub struct Gpu {
    slots: [Slot; 2],
}

impl Gpu {
    pub fn new(idle_minutes: u32, now: DateTime<Utc>) -> Gpu {
        let slot = |p: Profile| {
            let s = GpuState::stopped_for(p, idle_minutes);
            let (tx, _) = watch::channel(s.clone());
            Slot {
                inner: Mutex::new(Inner {
                    state: s,
                    epoch: 0,
                    last_active: now,
                    error_since: None,
                    urgent: false,
                    adopted: false,
                }),
                tx,
            }
        };
        Gpu {
            slots: [slot(Profile::Image), slot(Profile::Video)],
        }
    }

    fn slot(&self, p: Profile) -> &Slot {
        &self.slots[p.index()]
    }
}

fn inner(core: &Core, p: Profile) -> std::sync::MutexGuard<'_, Inner> {
    core.gpu.slot(p).inner.lock().unwrap()
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

    /// Pods named exactly `name` that are not TERMINATED.
    pub async fn find_named_pods(&self, name: &str) -> Result<Vec<Value>, RestError> {
        Ok(self
            .list_pods()
            .await?
            .into_iter()
            .filter(|p| pod_str(p, "name") == Some(name))
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
#[allow(clippy::too_many_arguments)]
pub fn create_payload_for(
    p: Profile,
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
        "name": p.pod_name(),
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

/// Image-profile payload (see `create_payload_for`).
pub fn create_payload(
    vol: &VolumeInfo,
    gpu_type: &str,
    token: &str,
    idle_minutes: u32,
    api_key: Option<&str>,
    image: &str,
    worker_ref: &str,
) -> Value {
    create_payload_for(
        Profile::Image,
        vol,
        gpu_type,
        token,
        idle_minutes,
        api_key,
        image,
        worker_ref,
    )
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

/// Pods named exactly after profile `p` that are not TERMINATED (`GET /v2/pods`).
pub async fn find_named_pods(rest: &RestClient, p: Profile) -> Result<Vec<Value>, RestError> {
    rest.find_named_pods(p.pod_name()).await
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

/// Image-profile state (backward compatible).
pub fn state(core: &Core) -> GpuState {
    state_for(core, Profile::Image)
}

pub fn state_for(core: &Core, p: Profile) -> GpuState {
    let mut s = inner(core, p).state.clone();
    s.idle_minutes = core.settings.idle_minutes();
    s.profile = p;
    s
}

/// Every profile's state, in `Profile::ALL` order.
pub fn states(core: &Core) -> Vec<GpuState> {
    Profile::ALL.iter().map(|p| state_for(core, *p)).collect()
}

pub fn subscribe(core: &Core) -> watch::Receiver<GpuState> {
    subscribe_for(core, Profile::Image)
}

pub fn subscribe_for(core: &Core, p: Profile) -> watch::Receiver<GpuState> {
    core.gpu.slot(p).tx.subscribe()
}

fn emit(core: &Core, p: Profile, s: &GpuState) {
    core.gpu.slot(p).tx.send_replace(s.clone());
    core.sink.gpu_update(s);
}

/// Apply `f` to the state (only while `epoch` is current, if given) and emit
/// on change. Returns false when the epoch is stale.
fn set_state(core: &Core, p: Profile, epoch: Option<u64>, f: impl FnOnce(&mut GpuState)) -> bool {
    let now = (core.cfg.clock)();
    let changed = {
        let mut g = inner(core, p);
        if epoch.is_some_and(|e| e != g.epoch) {
            return false;
        }
        let before = g.state.clone();
        f(&mut g.state);
        g.state.idle_minutes = core.settings.idle_minutes();
        g.state.profile = p;
        g.track_error(before.status, now);
        (g.state != before).then(|| g.state.clone())
    };
    if let Some(s) = changed {
        emit(core, p, &s);
    }
    true
}

fn is_current(core: &Core, p: Profile, epoch: u64) -> bool {
    inner(core, p).epoch == epoch
}

/// Record image-GPU activity (resets the idle timer).
pub fn touch(core: &Core) {
    touch_for(core, Profile::Image)
}

/// Record GPU activity for profile `p` (resets its idle timer).
pub fn touch_for(core: &Core, p: Profile) {
    let now = (core.cfg.clock)();
    inner(core, p).last_active = now;
}

fn persist_pod_id(core: &Core, p: Profile, id: Option<&str>) {
    let db = core.db.lock().unwrap();
    let r = db.set_setting(p.db_pod_id(), id.unwrap_or(""));
    if let Err(e) = r {
        eprintln!("[pod:{}] could not persist the pod id: {e}", p.as_str());
    }
}

fn stored_pod_id(core: &Core, p: Profile) -> Option<String> {
    core.db
        .lock()
        .unwrap()
        .get_setting(p.db_pod_id())
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

/// Looks up the image volume and caches its size (for the Models screen usage).
pub async fn lookup_volume(core: &Core, rest: &RestClient) -> Result<VolumeInfo, String> {
    lookup_volume_for(core, rest, Profile::Image).await
}

/// Looks up profile `p`'s volume (its own name list) and caches its size.
pub async fn lookup_volume_for(core: &Core, rest: &RestClient, p: Profile) -> Result<VolumeInfo, String> {
    let vol = rest.find_volume(&core.settings.volume_names_for(p)).await?;
    if vol.size_gb > 0 {
        let _ = core
            .db
            .lock()
            .unwrap()
            .set_setting(p.db_volume_size(), &vol.size_gb.to_string());
    }
    Ok(vol)
}

pub fn cached_volume_size_gb(core: &Core) -> Option<u64> {
    cached_volume_size_gb_for(core, Profile::Image)
}

pub fn cached_volume_size_gb_for(core: &Core, p: Profile) -> Option<u64> {
    core.db
        .lock()
        .unwrap()
        .get_setting(p.db_volume_size())
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
fn mark_urgent(core: &Core, p: Profile) {
    let mut g = inner(core, p);
    if g.state.status == GpuStatus::Error {
        g.urgent = true;
    }
}

/// A pod may still be billing: show Error with `id` tracked and persisted.
/// Applied regardless of the epoch, so a concurrent Stop can never hide it.
fn fail_with_pod(core: &Core, p: Profile, id: &str, msg: &str) {
    persist_pod_id(core, p, Some(id));
    set_state(core, p, None, |s| {
        s.status = GpuStatus::Error;
        s.phase = None;
        s.pod_id = Some(id.to_string());
        s.error = Some(msg.to_string());
    });
    mark_urgent(core, p);
}

/// A start (or adopt) loop failed: Error for this epoch.
fn fail_start(core: &Core, p: Profile, epoch: u64, msg: String) {
    eprintln!("[pod:{}] start failed: {msg}", p.as_str());
    let applied = set_state(core, p, Some(epoch), |s| {
        s.status = GpuStatus::Error;
        s.phase = None;
        s.error = Some(msg);
    });
    if applied {
        mark_urgent(core, p);
    }
}

/// `id` is confirmed gone: stop tracking it.
fn forget_pod(core: &Core, p: Profile, epoch: Option<u64>, id: &str) {
    if stored_pod_id(core, p).as_deref() == Some(id) {
        persist_pod_id(core, p, None);
    }
    set_state(core, p, epoch, |s| {
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
    start_for(core, Profile::Image)
}

/// `start` for profile `p`.
pub fn start_for(core: &Arc<Core>, p: Profile) -> Result<GpuState, String> {
    rest(core)?; // fail fast without an API key
    let (epoch, prev_pod) = {
        let mut g = inner(core, p);
        match g.state.status {
            GpuStatus::Running | GpuStatus::Starting => {
                drop(g);
                return Ok(state_for(core, p));
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
    let prev_pod = prev_pod.or_else(|| stored_pod_id(core, p));
    set_state(core, p, Some(epoch), |s| {
        *s = GpuState {
            status: GpuStatus::Starting,
            pod_id: prev_pod.clone(),
            phase: Some(PHASE_CREATING.into()),
            ..GpuState::stopped_for(p, 0)
        };
    });
    let core2 = core.clone();
    tokio::spawn(async move {
        if let Err(e) = start_inner(&core2, p, epoch, prev_pod).await {
            fail_start(&core2, p, epoch, e);
        }
    });
    Ok(state_for(core, p))
}

async fn start_inner(
    core: &Arc<Core>,
    p: Profile,
    epoch: u64,
    prev_pod: Option<String>,
) -> Result<(), String> {
    let rest = rest(core)?;
    if p == Profile::Video {
        // Licence guard before touching any pod: never place video in an
        // excluded territory.
        let vol = lookup_volume_for(core, &rest, p).await?;
        check_datacenter(p, &vol.data_center)?;
    }
    // A pod left from an earlier error: reuse it if it is still coming up,
    // otherwise terminate it (confirmed) before creating a fresh one.
    let mut pod_id = None;
    if let Some(id) = prev_pod {
        match rest.get_pod(&id).await {
            Ok(pod) if is_live(&pod) => pod_id = Some(id),
            Ok(_) => {
                if let Err(e) = terminate(core, &id).await {
                    let msg = cleanup_failed_msg(&e);
                    fail_with_pod(core, p, &id, &msg);
                    return Err(msg);
                }
                forget_pod(core, p, Some(epoch), &id);
            }
            Err(e) if e.not_found() => forget_pod(core, p, Some(epoch), &id),
            Err(e) => return Err(e.message),
        }
    }
    // A pod with this profile's name may exist that the app lost track of
    // (e.g. an ambiguous create): adopt it instead of creating a duplicate.
    if pod_id.is_none() {
        pod_id = claim_named_pod(core, p, &rest, epoch).await?;
    }
    let pod_id = match pod_id {
        Some(id) => id,
        None => create_pod(core, p, &rest, epoch).await?,
    };
    if !is_current(core, p, epoch) {
        return Ok(());
    }
    wait_ready(core, p, &rest, epoch, &pod_id).await
}

/// Before creating: terminates (confirmed) every named pod that is not
/// coming up, plus extra live duplicates, and adopts one live named pod
/// (the stored id first). Returns the adopted id.
async fn claim_named_pod(
    core: &Arc<Core>,
    p: Profile,
    rest: &RestClient,
    epoch: u64,
) -> Result<Option<String>, String> {
    let name = p.pod_name();
    let pods = find_named_pods(rest, p)
        .await
        .map_err(|e| format!("Could not check for an existing GPU pod: {}", e.message))?;
    let stored = stored_pod_id(core, p);
    let (mut live, dead): (Vec<&Value>, Vec<&Value>) = pods.iter().partition(|x| is_live(x));
    live.sort_by_key(|x| pod_str(x, "id") != stored.as_deref()); // stored id first
    let keep = live.first().copied();
    let extra = live.iter().skip(1).copied();
    for x in dead.into_iter().chain(extra) {
        let Some(id) = pod_str(x, "id") else { continue };
        eprintln!(
            "[pod] terminating leftover {name} pod {id} ({})",
            pod_str(x, "status").unwrap_or("unknown")
        );
        if let Err(e) = terminate(core, id).await {
            let msg = cleanup_failed_msg(&e);
            fail_with_pod(core, p, id, &msg);
            return Err(msg);
        }
        forget_pod(core, p, Some(epoch), id);
    }
    let Some(pod) = keep else { return Ok(None) };
    let Some(id) = pod_str(pod, "id") else {
        return Ok(None);
    };
    eprintln!("[pod] adopting existing {name} pod {id} instead of creating one");
    track_pod(core, p, epoch, pod, None);
    Ok(Some(id.to_string()))
}

/// Records `pod` as the current pod (persisted id, cost, GPU, start time).
fn track_pod(core: &Core, p: Profile, epoch: u64, pod: &Value, placed_gpu: Option<&str>) {
    let id = pod_str(pod, "id").unwrap_or("").to_string();
    persist_pod_id(core, p, Some(&id));
    set_state(core, p, Some(epoch), |s| {
        s.pod_id = Some(id.clone());
        s.cost_per_hr = pod_cost(pod).or(Some(FALLBACK_COST_PER_HR));
        s.gpu_type = pod_gpu(pod)
            .or(placed_gpu.map(str::to_string))
            .or(Some(p.default_gpu().into()));
        s.started_at = pod_started(pod).or_else(|| Some(now_str(core)));
        s.phase = Some(PHASE_MACHINE.into());
    });
}

/// Creates the pod (GPU fallback). After an ambiguous error the pod may
/// exist anyway, so the pods are re-listed by name and a new one adopted.
async fn create_pod(core: &Arc<Core>, p: Profile, rest: &RestClient, epoch: u64) -> Result<String, String> {
    let vol = lookup_volume_for(core, rest, p).await?;
    check_datacenter(p, &vol.data_center)?; // never create where the licence forbids
    let token = core.settings.pod_token()?;
    let key = core.settings.runpod_api_key();
    let key = key.as_deref().filter(|_| core.settings.pass_api_key_to_pod());
    let (pod, placed_gpu) = match create_with_fallback(core, p, rest, &vol, &token, key).await {
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
            match find_created_pod(core, p, rest).await {
                Some(pod) => (pod, gpu),
                None if !is_current(core, p, epoch) => {
                    // Stopped meanwhile: don't let a pod that shows up later
                    // go unnoticed behind "Stopped" — Error (urgent) makes the
                    // monitor look for it by name and stop it.
                    let msg = format!(
                        "RunPod didn't confirm whether the GPU pod was created ({message}). If one appears, the app stops it automatically; you can also press Stop."
                    );
                    set_state(core, p, None, |s| {
                        s.status = GpuStatus::Error;
                        s.phase = None;
                        s.error = Some(msg.clone());
                    });
                    mark_urgent(core, p);
                    return Err(msg);
                }
                None => return Err(message),
            }
        }
    };
    let id = pod_str(&pod, "id").unwrap_or("").to_string();
    if !is_current(core, p, epoch) {
        // Stopped (or restarted) while the create was in flight: clean up,
        // unless a newer start already adopted this very pod.
        if state_for(core, p).pod_id.as_deref() != Some(id.as_str()) {
            if let Err(e) = terminate(core, &id).await {
                let msg = cleanup_failed_msg(&e);
                fail_with_pod(core, p, &id, &msg);
                return Err(msg);
            }
            forget_pod(core, p, None, &id);
        }
        return Err("superseded by a newer start/stop".into()); // not shown: the epoch moved on
    }
    track_pod(core, p, epoch, &pod, Some(&placed_gpu));
    Ok(id)
}

/// After an ambiguous create: lists the pods up to 3 times,
/// `pod_poll_interval` apart (3 s in production), for a live named pod.
async fn find_created_pod(core: &Core, p: Profile, rest: &RestClient) -> Option<Value> {
    for attempt in 1..=3 {
        tokio::time::sleep(core.cfg.pod_poll_interval).await;
        match find_named_pods(rest, p).await {
            Ok(pods) => {
                if let Some(x) = pods.into_iter().find(|x| is_live(x) && pod_str(x, "id").is_some()) {
                    eprintln!(
                        "[pod] the pod was created despite the error; adopting {}",
                        pod_str(&x, "id").unwrap_or("")
                    );
                    return Some(x);
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
    p: Profile,
    rest: &RestClient,
    vol: &VolumeInfo,
    token: &str,
    api_key: Option<&str>,
) -> Result<(Value, String), CreateError> {
    let gpus = core.settings.gpu_types_for(p);
    let image = core.settings.pod_image();
    let worker_ref = core.settings.worker_ref();
    eprintln!("[pod] image {image}, WORKER_REF {worker_ref}");
    let mut last = String::new();
    for gpu in &gpus {
        let body = create_payload_for(
            p,
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
async fn wait_ready(
    core: &Arc<Core>,
    p: Profile,
    rest: &RestClient,
    epoch: u64,
    id: &str,
) -> Result<(), String> {
    let deadline = tokio::time::Instant::now() + core.cfg.pod_start_timeout;
    let client = pod_client(core, id)?;
    let http = reqwest::Client::builder()
        .timeout(Duration::from_secs(10))
        .build()
        .map_err(|e| e.to_string())?;
    let mut api_errors = 0;
    let mut phase = PHASE_MACHINE.to_string();
    loop {
        if !is_current(core, p, epoch) {
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
                                    touch_for(core, p);
                                    let armed = h.watchdog.as_ref().and_then(|w| w.armed);
                                    set_state(core, p, Some(epoch), |s| {
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
                            fail_with_pod(core, p, id, &msg);
                            return Err(msg);
                        }
                        forget_pod(core, p, Some(epoch), id);
                        return Err(format!(
                            "{what} It was terminated; check the worker image, then try again."
                        ));
                    }
                };
                set_state(core, p, Some(epoch), |s| {
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
                forget_pod(core, p, Some(epoch), id);
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
                fail_with_pod(core, p, id, &msg);
                return Err(msg);
            }
            forget_pod(core, p, Some(epoch), id);
            return Err(format!(
                "{what} The pod was terminated so it doesn't keep billing; try Start again."
            ));
        }
        tokio::time::sleep(core.cfg.pod_poll_interval).await;
    }
}

// ---------------------------------------------------------------------------
// Stop

/// Stops the image profile (see `stop_for`).
pub async fn stop(core: &Arc<Core>, reason: StopReason) -> Result<GpuState, String> {
    stop_for(core, Profile::Image, reason).await
}

/// Terminates every pod named exactly after profile `p` plus that profile's
/// tracked/stored pod (even if named differently) and confirms each is gone.
/// On any failure the GPU shows Error and keeps a remaining pod id. The
/// other profile's pod is never touched.
pub async fn stop_for(core: &Arc<Core>, p: Profile, reason: StopReason) -> Result<GpuState, String> {
    // Bump the epoch and show Stopping atomically, so a start that slips in
    // between can never see the old status with the new epoch.
    let now = (core.cfg.clock)();
    let (tracked, stopping) = {
        let mut g = inner(core, p);
        match g.state.status {
            GpuStatus::Stopped | GpuStatus::Stopping => {
                drop(g);
                return Ok(state_for(core, p));
            }
            _ => {}
        }
        g.epoch += 1;
        let before = g.state.status;
        g.state.status = GpuStatus::Stopping;
        g.state.phase = None;
        g.state.error = None;
        g.state.idle_minutes = core.settings.idle_minutes();
        g.track_error(before, now);
        (g.state.pod_id.clone(), g.state.clone())
    };
    emit(core, p, &stopping);
    let mut ids: Vec<String> = tracked.into_iter().chain(stored_pod_id(core, p)).collect();
    let mut problems: Vec<String> = Vec::new();
    match rest(core) {
        Err(e) => problems.push(e),
        Ok(rest) => match find_named_pods(&rest, p).await {
            Ok(pods) => ids.extend(pods.iter().filter_map(|x| pod_str(x, "id")).map(str::to_string)),
            Err(e) => problems.push(format!(
                "couldn't list the pods to find every {} pod: {}",
                p.pod_name(),
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
        persist_pod_id(core, p, keep.as_deref());
        let msg = format!(
            "Couldn't stop the GPU pod{} — it may still be billing. Press Stop to try again. ({})",
            if remaining.len() > 1 { "s" } else { "" },
            problems.join("; ")
        );
        set_state(core, p, None, |s| {
            s.status = GpuStatus::Error;
            s.phase = None;
            s.pod_id = keep.clone();
            s.error = Some(msg.clone());
        });
        mark_urgent(core, p);
        return Err(msg);
    }
    persist_pod_id(core, p, None);
    set_state(core, p, None, |s| {
        *s = GpuState {
            stop_reason: Some(reason),
            ..GpuState::stopped_for(p, 0)
        };
    });
    Ok(state_for(core, p))
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
    adopt_for(core, Profile::Image).await
}

/// Finds an existing pod named exactly after profile `p` and re-adopts it.
pub async fn adopt_for(core: &Arc<Core>, p: Profile) -> Result<GpuState, String> {
    let name = p.pod_name();
    let rest = rest(core)?;
    let pods = find_named_pods(&rest, p).await?;
    inner(core, p).adopted = true;
    let stored = stored_pod_id(core, p);
    let mut ours: Vec<&Value> = pods.iter().collect();
    // Live pods first (an EXITED stored pod must not hide a billing one),
    // then the stored id.
    ours.sort_by_key(|x| (!is_live(x), pod_str(x, "id") != stored.as_deref()));
    let Some(pod) = ours.first().cloned().cloned() else {
        persist_pod_id(core, p, None);
        return Ok(state_for(core, p));
    };
    if ours.len() > 1 {
        eprintln!(
            "[pod] {} pods named {name} exist; adopting one (Stop terminates all)",
            ours.len()
        );
    }
    let id = pod_str(&pod, "id").unwrap_or("").to_string();
    persist_pod_id(core, p, Some(&id));
    let epoch = {
        let mut g = inner(core, p);
        g.epoch += 1;
        g.epoch
    };
    let status = pod_str(&pod, "status").unwrap_or("");
    let base = GpuState {
        pod_id: Some(id.clone()),
        gpu_type: pod_gpu(&pod).or(Some(p.default_gpu().into())),
        started_at: pod_started(&pod),
        cost_per_hr: pod_cost(&pod).or(Some(FALLBACK_COST_PER_HR)),
        left_running: true,
        ..GpuState::stopped_for(p, 0)
    };
    if is_live(&pod) {
        set_state(core, p, Some(epoch), |s| {
            *s = GpuState {
                status: GpuStatus::Starting,
                phase: Some(PHASE_MACHINE.into()),
                ..base
            };
        });
        // An already-ready pod turns Running on the first poll.
        let core2 = core.clone();
        tokio::spawn(async move {
            if let Err(e) = wait_ready(&core2, p, &rest, epoch, &id).await {
                fail_start(&core2, p, epoch, e);
            }
        });
    } else {
        set_state(core, p, Some(epoch), |s| {
            *s = GpuState {
                status: GpuStatus::Error,
                error: Some(format!(
                    "A GPU pod named {name} exists but is {}. Stop it, then Start again.",
                    status.to_lowercase()
                )),
                ..base
            };
        });
    }
    Ok(state_for(core, p))
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
    ensure_running_for(core, Profile::Image, on_phase, cancelled).await
}

/// `ensure_running` for profile `p`.
pub async fn ensure_running_for(
    core: &Arc<Core>,
    p: Profile,
    on_phase: &mut (dyn FnMut(&str) + Send),
    cancelled: &(dyn Fn() -> bool + Send + Sync),
) -> Result<String, String> {
    let mut rx = subscribe_for(core, p);
    if state_for(core, p).status != GpuStatus::Running {
        start_for(core, p)?;
    }
    let mut last_phase: Option<String> = None;
    loop {
        let s = state_for(core, p);
        match s.status {
            GpuStatus::Running => {
                touch_for(core, p);
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

/// Any job or task runs on profile `p` (its pod is in use).
pub fn is_busy(core: &Core, p: Profile) -> bool {
    core.jobs
        .lock()
        .unwrap()
        .values()
        .any(|e| e.job.kind.profile() == p)
        || core.tasks.lock().unwrap().values().any(|e| e.profile == p)
}

/// True when quitting now could leave a billed pod behind (the UI asks),
/// for ANY profile.
pub fn needs_quit_confirm(core: &Core) -> bool {
    Profile::ALL.iter().any(|p| needs_quit_confirm_for(core, *p))
}

pub fn needs_quit_confirm_for(core: &Core, p: Profile) -> bool {
    let s = state_for(core, p);
    match s.status {
        GpuStatus::Starting | GpuStatus::Running | GpuStatus::Stopping => true,
        // Always: an ambiguous create leaves Error with no id while RunPod may
        // still bring a pod up; `stop_for_quit` checks by name.
        GpuStatus::Error => true,
        GpuStatus::Stopped => false,
    }
}

/// Stop before quitting, for EVERY profile (in parallel): each is stopped
/// like `stop_for`, waiting out a stop already in progress. Fails unless
/// every profile ends Stopped (pods confirmed gone); a failure on one
/// profile never skips the other.
pub async fn stop_for_quit(core: &Arc<Core>) -> Result<Vec<GpuState>, String> {
    let (a, b) = tokio::join!(
        stop_profile_for_quit(core, Profile::Image),
        stop_profile_for_quit(core, Profile::Video)
    );
    match (a, b) {
        (Ok(a), Ok(b)) => Ok(vec![a, b]),
        (Err(e), Ok(_)) | (Ok(_), Err(e)) => Err(e),
        (Err(a), Err(b)) => Err(format!("{a} {b}")),
    }
}

async fn stop_profile_for_quit(core: &Arc<Core>, p: Profile) -> Result<GpuState, String> {
    let mut rx = subscribe_for(core, p);
    let label = p.as_str();
    stop_for(core, p, StopReason::User)
        .await
        .map_err(|e| format!("({label} GPU) {e}"))?;
    let wait = core.cfg.pod_stop_timeout + Duration::from_secs(30);
    let _ = tokio::time::timeout(wait, async {
        while state_for(core, p).status == GpuStatus::Stopping {
            if rx.changed().await.is_err() {
                break;
            }
        }
    })
    .await;
    let s = state_for(core, p);
    match s.status {
        GpuStatus::Stopped => Ok(s),
        GpuStatus::Stopping => Err(format!(
            "The {label} GPU pod is still stopping; it may still be billing"
        )),
        _ => Err(s.error.unwrap_or_else(|| {
            format!("The {label} GPU pod could not be stopped; it may still be billing")
        })),
    }
}

/// App-side auto-stop. Running: stops after `idleMinutes` with no jobs or
/// tasks. Error with a pod (tracked, stored or found by name): stops after
/// `ERROR_AUTO_STOP_SECS` when a start/stop failed, else after
/// `idleMinutes`. Returns the new state when it stopped the pod.
pub async fn idle_check(core: &Arc<Core>) -> Option<GpuState> {
    idle_check_for(core, Profile::Image).await
}

/// `idle_check` for profile `p` (its own idle timer and busy jobs/tasks).
pub async fn idle_check_for(core: &Arc<Core>, p: Profile) -> Option<GpuState> {
    let s = state_for(core, p);
    match s.status {
        GpuStatus::Running => {}
        GpuStatus::Error => return error_auto_stop(core, p, &s).await,
        _ => return None,
    }
    if is_busy(core, p) {
        touch_for(core, p);
        return None;
    }
    let idle_for = (core.cfg.clock)() - inner(core, p).last_active;
    let limit = chrono::Duration::minutes(core.settings.idle_minutes() as i64);
    if idle_for < limit {
        return None;
    }
    eprintln!(
        "[pod:{}] auto-stop after {} idle minutes",
        p.as_str(),
        core.settings.idle_minutes()
    );
    stop_for(core, p, StopReason::Idle).await.ok()
}

async fn error_auto_stop(core: &Arc<Core>, p: Profile, s: &GpuState) -> Option<GpuState> {
    let now = (core.cfg.clock)();
    let (since, urgent, last_active) = {
        let g = inner(core, p);
        (g.error_since.unwrap_or(now), g.urgent, g.last_active)
    };
    let due = if urgent {
        // Nothing useful runs on a pod whose start/stop failed.
        now - since >= chrono::Duration::seconds(ERROR_AUTO_STOP_SECS)
    } else {
        if is_busy(core, p) {
            touch_for(core, p);
            return None;
        }
        now - since.max(last_active) >= chrono::Duration::minutes(core.settings.idle_minutes() as i64)
    };
    if !due {
        return None;
    }
    let has_pod = s.pod_id.is_some()
        || stored_pod_id(core, p).is_some()
        || match rest(core) {
            Ok(r) => find_named_pods(&r, p).await.is_ok_and(|x| !x.is_empty()),
            Err(_) => false,
        };
    if !has_pod {
        return None;
    }
    eprintln!("[pod:{}] auto-stop from the error state", p.as_str());
    stop_for(core, p, StopReason::Idle).await.ok()
}

/// Detects a pod that vanished (e.g. its own idle watchdog terminated it,
/// or the RunPod console) while Starting, Running or Error, and terminates
/// an EXITED pod (it still holds resources). Never creates pods.
pub async fn liveness_check(core: &Arc<Core>) {
    liveness_check_for(core, Profile::Image).await
}

/// `liveness_check` for profile `p` (only ever looks at that profile's pod id).
pub async fn liveness_check_for(core: &Arc<Core>, p: Profile) {
    let (s, epoch) = {
        let g = inner(core, p);
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
        "TERMINATED" => mark_external(core, p, epoch, &id),
        // While Starting, wait_ready handles (and terminates) an EXITED pod.
        "EXITED" if s.status != GpuStatus::Starting => {
            if !is_current(core, p, epoch) {
                return;
            }
            eprintln!("[pod:{}] pod {id} exited; terminating it", p.as_str());
            match terminate(core, &id).await {
                Ok(()) => mark_external(core, p, epoch, &id),
                Err(e) => {
                    if is_current(core, p, epoch) {
                        fail_with_pod(
                            core,
                            p,
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
fn mark_external(core: &Core, p: Profile, epoch: u64, id: &str) {
    let now = (core.cfg.clock)();
    let s = {
        let mut g = inner(core, p);
        if g.epoch != epoch || g.state.pod_id.as_deref() != Some(id) {
            return;
        }
        g.epoch += 1;
        let before = g.state.status;
        g.state = GpuState {
            stop_reason: Some(StopReason::External),
            ..GpuState::stopped_for(p, core.settings.idle_minutes())
        };
        g.track_error(before, now);
        g.state.clone()
    };
    if stored_pod_id(core, p).as_deref() == Some(id) {
        persist_pod_id(core, p, None);
    }
    emit(core, p, &s);
}

/// One monitor tick for every profile: idle/error auto-stop, else liveness.
/// Profiles tick in parallel so a slow stop on one never delays the other.
pub async fn monitor_tick(core: &Arc<Core>) {
    tokio::join!(tick_for(core, Profile::Image), tick_for(core, Profile::Video));
}

async fn tick_for(core: &Arc<Core>, p: Profile) {
    let retry_adopt = {
        let g = inner(core, p);
        !g.adopted && g.state.status == GpuStatus::Stopped
    };
    if retry_adopt && rest(core).is_ok() {
        if let Err(e) = adopt_for(core, p).await {
            eprintln!("[pod] {} adopt retry failed: {e}", p.as_str());
        }
        return;
    }
    if idle_check_for(core, p).await.is_none() {
        liveness_check_for(core, p).await;
    }
}

/// Background loop, every `period`: `monitor_tick`.
pub async fn run_monitor(core: Arc<Core>, period: Duration) {
    loop {
        tokio::time::sleep(period).await;
        monitor_tick(&core).await;
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
            json!({"profile": "image", "status": "stopped", "idleMinutes": 30, "leftRunning": false, "stopReason": "idle"})
        );
    }
}
