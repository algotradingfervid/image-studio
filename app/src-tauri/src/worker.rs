//! Where worker jobs (generate, status, download, delete) run: the dedicated
//! GPU pod's server at `https://<podId>-8000.proxy.runpod.net`, authenticated
//! with the pod token. It is started on demand when stopped. (The legacy
//! serverless backend was removed; a stored `backend: serverless` loads as
//! the pod backend.)
//!
//! Routing (spec v5): image generation and image-model/LoRA tasks use the
//! `image` pod profile; `generate_video` and video-model tasks use `video`.

use crate::pod::{self, GpuStatus, Profile, StartOrigin};
use crate::runpod::RunpodClient;
use crate::state::Core;
use std::sync::Arc;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum WorkerTarget {
    /// The pod, with its id when it is running.
    Pod { pod_id: Option<String> },
}

impl WorkerTarget {
    pub fn current(core: &Core) -> WorkerTarget {
        WorkerTarget::current_for(core, Profile::Image)
    }

    pub fn current_for(core: &Core, p: Profile) -> WorkerTarget {
        let s = pod::state_for(core, p);
        WorkerTarget::Pod {
            pod_id: (s.status == GpuStatus::Running).then_some(s.pod_id).flatten(),
        }
    }
}

/// Fails fast (before a job/task is queued) when the pod can't be used.
pub fn precheck(core: &Core) -> Result<(), String> {
    precheck_for(core, Profile::Image)
}

pub fn precheck_for(core: &Core, _p: Profile) -> Result<(), String> {
    pod::rest(core).map(|_| ())
}

/// Client for a worker that is ready now, without starting anything.
/// `None` when the pod is not running.
pub fn ready_client(core: &Core) -> Option<Result<RunpodClient, String>> {
    ready_client_for(core, Profile::Image)
}

pub fn ready_client_for(core: &Core, p: Profile) -> Option<Result<RunpodClient, String>> {
    match WorkerTarget::current_for(core, p) {
        WorkerTarget::Pod { pod_id: Some(id) } => {
            pod::touch_for(core, p);
            Some(pod::pod_client(core, &id))
        }
        WorkerTarget::Pod { pod_id: None } => None,
    }
}

/// Client for the image pod; starts the pod and waits for it when it is not
/// running (reporting each phase to `on_phase`).
pub async fn client(
    core: &Arc<Core>,
    on_phase: &mut (dyn FnMut(&str) + Send),
    cancelled: &(dyn Fn() -> bool + Send + Sync),
) -> Result<RunpodClient, String> {
    client_for(core, Profile::Image, on_phase, cancelled).await
}

/// `client` for profile `p` (starts that profile's pod for a generation job
/// when needed).
pub async fn client_for(
    core: &Arc<Core>,
    p: Profile,
    on_phase: &mut (dyn FnMut(&str) + Send),
    cancelled: &(dyn Fn() -> bool + Send + Sync),
) -> Result<RunpodClient, String> {
    client_as(core, p, StartOrigin::Job, on_phase, cancelled).await
}

/// `client_for`, recording why the pod is started when it has to be.
pub async fn client_as(
    core: &Arc<Core>,
    p: Profile,
    origin: StartOrigin,
    on_phase: &mut (dyn FnMut(&str) + Send),
    cancelled: &(dyn Fn() -> bool + Send + Sync),
) -> Result<RunpodClient, String> {
    if let Some(c) = ready_client_for(core, p) {
        return c;
    }
    let id = pod::ensure_running_as(core, p, origin, on_phase, cancelled).await?;
    pod::pod_client(core, &id)
}

/// The profile whose volume holds model `model_id` (video models → video).
pub fn profile_for_model(core: &Core, model_id: &str) -> Profile {
    if core.registry.is_video_model(model_id) {
        Profile::Video
    } else {
        Profile::Image
    }
}
