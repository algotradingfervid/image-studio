//! Shared application core: registry, database, settings, event sink and the
//! in-memory job/task tables. Independent of Tauri so it can be tested.

use crate::db::Db;
use crate::jobs::{Job, JobEntry};
use crate::links::LinkResolver;
use crate::registry::Registry;
use crate::runpod::{RunpodClient, DEFAULT_API_ROOT};
use crate::settings::Settings;
use crate::status::StatusView;
use crate::tasks::{Task, TaskEntry};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Duration;

pub const EVENT_JOB: &str = "job-update";
pub const EVENT_TASK: &str = "task-update";
pub const EVENT_STATUS: &str = "status-update";

pub trait EventSink: Send + Sync {
    fn job_update(&self, job: &Job);
    fn task_update(&self, task: &Task);
    fn status_update(&self, status: &StatusView);
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
}

impl CoreConfig {
    pub fn production(data_dir: PathBuf) -> CoreConfig {
        CoreConfig {
            data_dir,
            runpod_root: DEFAULT_API_ROOT.into(),
            civitai_root: crate::links::CIVITAI_ROOT.into(),
            hf_root: crate::links::HF_ROOT.into(),
            poll_interval: Duration::from_secs(1),
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
}

impl Core {
    pub fn new(
        registry: Registry,
        db: Db,
        settings: Settings,
        sink: Arc<dyn EventSink>,
        cfg: CoreConfig,
    ) -> Result<Arc<Core>, String> {
        for d in [cfg.images_dir(), cfg.references_dir()] {
            std::fs::create_dir_all(&d)
                .map_err(|e| format!("Could not create {}: {e}", d.display()))?;
        }
        Ok(Arc::new(Core {
            registry,
            db: Mutex::new(db),
            settings,
            sink,
            cfg,
            jobs: Mutex::new(HashMap::new()),
            tasks: Mutex::new(HashMap::new()),
            refresh_lock: tokio::sync::Mutex::new(()),
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
}

pub fn now_rfc3339() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}
