//! Where worker jobs (generate, status, download, delete) run.
//!
//! - `Pod` (default): the dedicated GPU pod's server at
//!   `https://<podId>-8000.proxy.runpod.net`, authenticated with the pod token.
//!   It is started on demand when stopped.
//! - `Serverless` (legacy): the RunPod serverless endpoint.
//!
//! Both speak the same `/run` `/status` `/cancel` `/health` API, so callers
//! only receive a `RunpodClient`.
//!
//! Routing (spec v5): image generation and image-model/LoRA tasks use the
//! `image` pod profile; `generate_video` and video-model tasks use `video`.
//! The video profile always needs the pod backend.

use crate::pod::{self, GpuStatus, Profile};
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
        WorkerTarget::current_for(core, Profile::Image)
    }

    pub fn current_for(core: &Core, p: Profile) -> WorkerTarget {
        match (core.settings.backend(), p) {
            (Backend::Serverless, Profile::Image) => WorkerTarget::Serverless,
            _ => {
                let s = pod::state_for(core, p);
                WorkerTarget::Pod {
                    pod_id: (s.status == GpuStatus::Running).then_some(s.pod_id).flatten(),
                }
            }
        }
    }
}

/// Fails fast (before a job/task is queued) when the backend can't be used.
pub fn precheck(core: &Core) -> Result<(), String> {
    precheck_for(core, Profile::Image)
}

pub fn precheck_for(core: &Core, p: Profile) -> Result<(), String> {
    match (core.settings.backend(), p) {
        (Backend::Serverless, Profile::Image) => core.runpod().map(|_| ()),
        _ => pod::rest(core).map(|_| ()),
    }
}

/// Client for a worker that is ready now, without starting anything.
/// `None` when the pod is not running.
pub fn ready_client(core: &Core) -> Option<Result<RunpodClient, String>> {
    ready_client_for(core, Profile::Image)
}

pub fn ready_client_for(core: &Core, p: Profile) -> Option<Result<RunpodClient, String>> {
    match WorkerTarget::current_for(core, p) {
        WorkerTarget::Serverless => Some(core.runpod()),
        WorkerTarget::Pod { pod_id: Some(id) } => {
            pod::touch_for(core, p);
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
    client_for(core, Profile::Image, on_phase, cancelled).await
}

/// `client` for profile `p` (starts that profile's pod when needed).
pub async fn client_for(
    core: &Arc<Core>,
    p: Profile,
    on_phase: &mut (dyn FnMut(&str) + Send),
    cancelled: &(dyn Fn() -> bool + Send + Sync),
) -> Result<RunpodClient, String> {
    if let Some(c) = ready_client_for(core, p) {
        return c;
    }
    let id = pod::ensure_running_for(core, p, on_phase, cancelled).await?;
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
