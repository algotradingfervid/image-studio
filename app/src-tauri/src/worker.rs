//! Where worker jobs (generate, status, download, delete) run.
//!
//! - `Pod` (default): the dedicated GPU pod's server at
//!   `https://<podId>-8000.proxy.runpod.net`, authenticated with the pod token.
//!   It is started on demand when stopped.
//! - `Serverless` (legacy): the RunPod serverless endpoint.
//!
//! Both speak the same `/run` `/status` `/cancel` `/health` API, so callers
//! only receive a `RunpodClient`.

use crate::pod::{self, GpuStatus};
use crate::runpod::RunpodClient;
use crate::settings::Backend;
use crate::state::Core;
use std::sync::Arc;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum WorkerTarget {
    Serverless,
    /// The pod, with its id when it is running.
    Pod { pod_id: Option<String> },
}

impl WorkerTarget {
    pub fn current(core: &Core) -> WorkerTarget {
        match core.settings.backend() {
            Backend::Serverless => WorkerTarget::Serverless,
            Backend::Pod => {
                let s = pod::state(core);
                WorkerTarget::Pod {
                    pod_id: (s.status == GpuStatus::Running).then_some(s.pod_id).flatten(),
                }
            }
        }
    }
}

/// Fails fast (before a job/task is queued) when the backend can't be used.
pub fn precheck(core: &Core) -> Result<(), String> {
    match core.settings.backend() {
        Backend::Serverless => core.runpod().map(|_| ()),
        Backend::Pod => pod::rest(core).map(|_| ()),
    }
}

/// Client for a worker that is ready now, without starting anything.
/// `None` when the pod is not running.
pub fn ready_client(core: &Core) -> Option<Result<RunpodClient, String>> {
    match WorkerTarget::current(core) {
        WorkerTarget::Serverless => Some(core.runpod()),
        WorkerTarget::Pod { pod_id: Some(id) } => {
            pod::touch(core);
            Some(pod::pod_client(core, &id))
        }
        WorkerTarget::Pod { pod_id: None } => None,
    }
}

/// Client for the current backend; with the pod backend, starts the pod and
/// waits for it when it is not running (reporting each phase to `on_phase`).
pub async fn client(
    core: &Arc<Core>,
    on_phase: &mut (dyn FnMut(&str) + Send),
    cancelled: &(dyn Fn() -> bool + Send + Sync),
) -> Result<RunpodClient, String> {
    if let Some(c) = ready_client(core) {
        return c;
    }
    let id = pod::ensure_running(core, on_phase, cancelled).await?;
    pod::pod_client(core, &id)
}
