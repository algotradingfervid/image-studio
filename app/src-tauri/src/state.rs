//! Shared application core: registry, database, settings, event sink and the
//! in-memory job/task tables. Independent of Tauri so it can be tested.

use crate::db::Db;
use crate::jobs::{Job, JobEntry};
use crate::links::LinkResolver;
use crate::pod::{Gpu, GpuState};
use crate::registry::Registry;
use crate::runpod::{RunpodClient, DEFAULT_API_ROOT};
use crate::settings::Settings;
use crate::status::StatusView;
use crate::tasks::{Task, TaskEntry};
use crate::vault::{Vault, VaultStatus};
use crate::vault_migrate::MigrationProgress;
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Duration;

pub const EVENT_JOB: &str = "job-update";
pub const EVENT_TASK: &str = "task-update";
pub const EVENT_STATUS: &str = "status-update";
pub const EVENT_GPU: &str = "gpu-update";
pub const EVENT_VAULT: &str = "vault-update";
pub const EVENT_VAULT_MIGRATION: &str = "vault-migration";

pub trait EventSink: Send + Sync {
    fn job_update(&self, job: &Job);
    fn task_update(&self, task: &Task);
    fn status_update(&self, status: &StatusView);
    fn gpu_update(&self, _gpu: &GpuState) {}
    fn vault_update(&self, _status: &VaultStatus) {}
    fn vault_migration(&self, _progress: &MigrationProgress) {}
}

/// Injectable wall clock (tests drive the idle auto-stop with it).
pub type Clock = Arc<dyn Fn() -> chrono::DateTime<chrono::Utc> + Send + Sync>;

pub fn system_clock() -> Clock {
    Arc::new(chrono::Utc::now)
}

/// Sink that drops events (useful in tests that don't inspect them).
pub struct NullSink;
impl EventSink for NullSink {
    fn job_update(&self, _: &Job) {}
    fn task_update(&self, _: &Task) {}
    fn status_update(&self, _: &StatusView) {}
}

#[derive(Clone)]
pub struct CoreConfig {
    pub data_dir: PathBuf,
    pub runpod_root: String,
    pub civitai_root: String,
    pub hf_root: String,
    pub poll_interval: Duration,
    /// RunPod REST API root (`https://api.runpod.io`, v2 paths).
    pub rest_root: String,
    /// Pod server URL; `{podId}` is replaced.
    pub pod_proxy_template: String,
    pub pod_poll_interval: Duration,
    pub pod_start_timeout: Duration,
    pub pod_stop_timeout: Duration,
    /// Per-request timeout for the RunPod REST API.
    pub rest_timeout: Duration,
    pub clock: Clock,
}

impl CoreConfig {
    pub fn production(data_dir: PathBuf) -> CoreConfig {
        CoreConfig {
            data_dir,
            runpod_root: DEFAULT_API_ROOT.into(),
            civitai_root: crate::links::CIVITAI_ROOT.into(),
            hf_root: crate::links::HF_ROOT.into(),
            poll_interval: Duration::from_secs(1),
            rest_root: crate::pod::DEFAULT_REST_ROOT.into(),
            pod_proxy_template: crate::pod::DEFAULT_PROXY_TEMPLATE.into(),
            pod_poll_interval: Duration::from_secs(3),
            pod_start_timeout: Duration::from_secs(15 * 60),
            pod_stop_timeout: Duration::from_secs(3 * 60),
            rest_timeout: Duration::from_secs(60),
            clock: system_clock(),
        }
    }
}

pub struct Core {
    pub registry: Registry,
    pub db: Mutex<Db>,
    pub settings: Settings,
    pub sink: Arc<dyn EventSink>,
    pub cfg: CoreConfig,
    pub jobs: Mutex<HashMap<String, JobEntry>>,
    pub tasks: Mutex<HashMap<String, TaskEntry>>,
    pub refresh_lock: tokio::sync::Mutex<()>,
    /// The video volume's refresh lock (a video refresh may wait for the
    /// video GPU to start; it must not block image refreshes).
    pub video_refresh_lock: tokio::sync::Mutex<()>,
    pub gpu: Gpu,
    /// Encrypted vault (spec v6), at `<data_dir>/vault/`.
    pub vault: Vault,
}

impl Core {
    pub fn new(
        registry: Registry,
        db: Db,
        settings: Settings,
        sink: Arc<dyn EventSink>,
        cfg: CoreConfig,
    ) -> Result<Arc<Core>, String> {
        for d in [cfg.images_dir(), cfg.references_dir(), cfg.videos_dir()] {
            std::fs::create_dir_all(&d)
                .map_err(|e| format!("Could not create {}: {e}", d.display()))?;
        }
        let gpu = Gpu::new(settings.idle_minutes(), (cfg.clock)());
        let vault = Vault::new(cfg.vault_dir(), settings.vault_auto_lock_minutes());
        Ok(Arc::new(Core {
            gpu,
            vault,
            registry,
            db: Mutex::new(db),
            settings,
            sink,
            cfg,
            jobs: Mutex::new(HashMap::new()),
            tasks: Mutex::new(HashMap::new()),
            refresh_lock: tokio::sync::Mutex::new(()),
            video_refresh_lock: tokio::sync::Mutex::new(()),
        }))
    }

    pub fn runpod(&self) -> Result<RunpodClient, String> {
        let key = self
            .settings
            .runpod_api_key()
            .ok_or("Add your RunPod API key in Settings first")?;
        let endpoint = self
            .settings
            .endpoint_id()
            .ok_or("Add your RunPod endpoint ID in Settings first")?;
        Ok(RunpodClient::new(&self.cfg.runpod_root, &endpoint, &key))
    }

    pub fn resolver(&self) -> LinkResolver {
        LinkResolver::new(
            &self.cfg.civitai_root,
            &self.cfg.hf_root,
            self.settings.civitai_api_key(),
        )
    }
}

impl CoreConfig {
    pub fn images_dir(&self) -> PathBuf {
        self.data_dir.join("images")
    }
    pub fn references_dir(&self) -> PathBuf {
        self.data_dir.join("references")
    }
    /// Video files (.mp4) and their posters (spec v5).
    pub fn videos_dir(&self) -> PathBuf {
        self.data_dir.join("videos")
    }
    /// Encrypted vault files (spec v6).
    pub fn vault_dir(&self) -> PathBuf {
        self.data_dir.join("vault")
    }
}

impl Core {
    /// Emits the current vault status to the UI.
    pub fn emit_vault(&self) {
        self.sink.vault_update(&self.vault.status());
    }
}

pub fn now_rfc3339() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}
