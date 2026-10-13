//! Shared application core: registry, database, settings, event sink and the
//! in-memory job/task tables. Independent of Tauri so it can be tested.

use crate::db::{Db, ImageRecord};
use crate::jobs::{Job, JobEntry};
use crate::links::LinkResolver;
use crate::pod::{Gpu, GpuState};
use crate::registry::Registry;
use crate::runpod::DEFAULT_API_ROOT;
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
pub const EVENT_STORY_PLAN: &str = "story-plan-progress";

pub trait EventSink: Send + Sync {
    fn job_update(&self, job: &Job);
    fn task_update(&self, task: &Task);
    fn status_update(&self, status: &StatusView);
    fn gpu_update(&self, _gpu: &GpuState) {}
    fn vault_update(&self, _status: &VaultStatus) {}
    fn vault_migration(&self, _progress: &MigrationProgress) {}
    /// The local LLM is writing a story plan (streamed).
    fn story_plan_progress(&self, _story_id: &str, _progress: &crate::stories::planner::PlanProgress) {}
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
    /// How long a start keeps retrying when no GPU of the list has capacity
    /// (rounds over the list, see pod::create_with_fallback).
    pub gpu_wait_timeout: Duration,
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
            gpu_wait_timeout: Duration::from_secs(10 * 60),
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
    /// Stories: shot id → job id of its latest render. An entry counts only
    /// while that job is still in `jobs` (see `stories::render`).
    pub story_renders: Mutex<HashMap<String, String>>,
    /// Per-profile submission order of queued jobs (see `jobs::SubmitGate`).
    pub submit_gate: Arc<crate::jobs::SubmitGate>,
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
        // Story frames once went through here; ffmpeg is fed over pipes now (`stories::ffmpeg`).
        let _ = std::fs::remove_dir_all(cfg.data_dir.join("stories-tmp"));
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
            story_renders: Mutex::new(HashMap::new()),
            submit_gate: Arc::default(),
        }))
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
    /// Per-job stage and ComfyUI node timings, one JSON object per line
    /// (performance analysis; never prompts, seeds or file names).
    pub fn timings_log(&self) -> PathBuf {
        self.data_dir.join("timings.jsonl")
    }
    /// Encrypted vault files (spec v6).
    pub fn vault_dir(&self) -> PathBuf {
        self.data_dir.join("vault")
    }

    /// Removes a general record's files (media, poster, thumbnail). Only
    /// files the app wrote (under `images/` or `videos/`) are touched.
    pub fn remove_record_files(&self, rec: &ImageRecord) {
        let owned = [self.images_dir(), self.videos_dir()];
        let files = std::iter::once(&rec.path)
            .chain(rec.poster_path.as_ref())
            .chain(rec.thumb_path.as_ref());
        for f in files {
            let p = PathBuf::from(f);
            if owned.iter().any(|d| p.starts_with(d)) {
                let _ = std::fs::remove_file(p);
            }
        }
    }

    /// Deletes a general record's row, then its files. A story that approved
    /// it as a take, or assembled it, forgets it.
    pub fn delete_record(&self, db: &Db, rec: &ImageRecord) -> Result<(), String> {
        crate::stories::store::clear_image_refs(db, &rec.id)?;
        db.delete_image(&rec.id)?;
        self.remove_record_files(rec);
        Ok(())
    }
}

impl Core {
    /// Emits the current vault status to the UI.
    pub fn emit_vault(&self) {
        self.sink.vault_update(&self.vault.status());
    }

    /// Changes the vault auto-lock minutes (persisted). Only while the vault
    /// is unlocked (owner decision): locked or with no vault it is refused,
    /// so nobody can lengthen the auto-lock of a vault they can't open.
    pub fn set_vault_auto_lock(&self, minutes: u32) -> Result<VaultStatus, String> {
        if !self.vault.is_unlocked() {
            return Err(format!(
                "{}: Unlock the vault to change its auto-lock time",
                crate::vault::ERR_LOCKED
            ));
        }
        self.settings.save_vault_auto_lock(minutes)?;
        self.vault.set_auto_lock(minutes);
        self.vault.touch();
        self.emit_vault();
        Ok(self.vault.status())
    }
}

pub fn now_rfc3339() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}
