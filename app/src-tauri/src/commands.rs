//! Tauri commands. Arguments are flat camelCase keys, e.g.
//! `invoke("generate", { model, prompt, aspectRatio, count, referenceIds, loras,
//! initImageId?, denoise? })`.
//! Errors are user-readable strings.

use crate::db::ImageRecord;
use crate::jobs::{self, GenerateRequest, Job, LoraChoice, VideoRequest};
use crate::links::ResolvedLora;
use crate::pod::{self, GpuState, Profile};
use crate::references::{self, ImportedReference};
use crate::runpod::Health;
use crate::settings::{Backend, SavePodSettings, SaveSettings, SettingsView};
use crate::state::Core;
use crate::status::{self, LoraView, StatusView};
use crate::tasks::{self, DeletePreview, DeleteResult, Task};
use crate::worker::WorkerTarget;
use base64::Engine;
use serde::Serialize;
use serde_json::Value;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use tauri::State;

type Res<T> = Result<T, String>;
type CoreState<'a> = State<'a, Arc<Core>>;

// ----- settings & status -----

/// `SettingsView` plus the v3 pod settings.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SettingsResponse {
    #[serde(flatten)]
    pub base: SettingsView,
    pub idle_minutes: u32,
    pub backend: Backend,
    pub gpu_type: String,
    pub gpu_types: Vec<String>,
    pub volume_names: Vec<String>,
    pub pass_api_key_to_pod: bool,
    pub fallback_cost_per_hr: f64,
    /// `WORKER_REF` the pod fetches worker code at (config file only).
    pub worker_ref: String,
    /// Pod container image (config file only).
    pub pod_image: String,
    /// Video profile GPU list / volumes (config file only; spec v5).
    pub video_gpu_types: Vec<String>,
    pub video_volume_names: Vec<String>,
}

fn settings_response(core: &Core) -> SettingsResponse {
    SettingsResponse {
        base: core.settings.view(),
        idle_minutes: core.settings.idle_minutes(),
        backend: core.settings.backend(),
        gpu_type: core.settings.gpu_types()[0].clone(),
        gpu_types: core.settings.gpu_types(),
        volume_names: core.settings.volume_names(),
        pass_api_key_to_pod: core.settings.pass_api_key_to_pod(),
        fallback_cost_per_hr: pod::FALLBACK_COST_PER_HR,
        worker_ref: core.settings.worker_ref(),
        pod_image: core.settings.pod_image(),
        video_gpu_types: core.settings.gpu_types_for(Profile::Video),
        video_volume_names: core.settings.volume_names_for(Profile::Video),
    }
}

#[tauri::command]
pub fn get_settings(core: CoreState<'_>) -> SettingsResponse {
    settings_response(&core)
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub fn save_settings(
    core: CoreState<'_>,
    api_key: Option<String>,
    endpoint_id: Option<String>,
    civitai_key: Option<String>,
    idle_minutes: Option<u32>,
    backend: Option<Backend>,
    pass_api_key_to_pod: Option<bool>,
) -> Res<SettingsResponse> {
    core.settings.save_pod(SavePodSettings {
        backend,
        idle_minutes,
        pass_api_key_to_pod,
        ..Default::default()
    })?;
    core.settings.save(SaveSettings {
        api_key,
        endpoint_id,
        civitai_key,
    })?;
    if idle_minutes.is_some() {
        // Re-emit so the UI's GpuState.idleMinutes is current.
        for s in pod::states(&core) {
            core.sink.gpu_update(&s);
        }
    }
    Ok(settings_response(&core))
}

// ----- GPU pod -----

/// `profile`: "image" (default) or "video".
#[tauri::command]
pub fn get_gpu_state(core: CoreState<'_>, profile: Option<String>) -> Res<GpuState> {
    Ok(pod::state_for(&core, Profile::parse(profile.as_deref())?))
}

/// Every profile's state: `[image, video]`.
#[tauri::command]
pub fn list_gpu_states(core: CoreState<'_>) -> Vec<GpuState> {
    pod::states(&core)
}

#[tauri::command]
pub async fn start_gpu(core: CoreState<'_>, profile: Option<String>) -> Res<GpuState> {
    let p = Profile::parse(profile.as_deref())?;
    if p == Profile::Image && core.settings.backend() != Backend::Pod {
        return Err("The app is set to use the serverless endpoint (Settings)".into());
    }
    pod::start_for(&core, p)
}

#[tauri::command]
pub async fn stop_gpu(core: CoreState<'_>, profile: Option<String>) -> Res<GpuState> {
    let p = Profile::parse(profile.as_deref())?;
    pod::stop_for(&core, p, pod::StopReason::User).await
}

/// Set once quitting is confirmed, so the exit isn't intercepted again.
#[derive(Default)]
pub struct QuitGuard(pub AtomicBool);

impl QuitGuard {
    pub fn confirmed(&self) -> bool {
        self.0.load(Ordering::SeqCst)
    }
}

/// Answer to the `quit-requested` dialog. `stop_gpu`: stop EVERY profile's
/// pod (and confirm each is gone) first; on failure nothing quits and the error is
/// returned so the UI can offer "Try again" / "Quit anyway".
#[tauri::command]
pub async fn confirm_quit(
    app: tauri::AppHandle,
    core: CoreState<'_>,
    guard: State<'_, QuitGuard>,
    stop_gpu: bool,
) -> Res<()> {
    if stop_gpu {
        pod::stop_for_quit(&core).await?;
    }
    guard.0.store(true, Ordering::SeqCst);
    app.exit(0);
    Ok(())
}

#[tauri::command]
pub async fn test_connection(core: CoreState<'_>) -> Res<Health> {
    if core.settings.backend() == Backend::Pod {
        return Ok(test_pod_connection(&core).await);
    }
    let client = match core.runpod() {
        Ok(c) => c,
        Err(e) => {
            return Ok(Health {
                error: Some(e),
                ..Default::default()
            })
        }
    };
    Ok(client.health().await.unwrap_or_else(|e| Health {
        error: Some(e),
        ..Default::default()
    }))
}

/// Pod running → the pod's `/health`; otherwise verify the API key with
/// `GET /v2/pods`.
pub async fn test_pod_connection(core: &Arc<Core>) -> Health {
    let fail = |target: &str, e: String| Health {
        target: Some(target.into()),
        error: Some(e),
        ..Default::default()
    };
    if let WorkerTarget::Pod { pod_id: Some(id) } = WorkerTarget::current(core) {
        return match pod::pod_client(core, &id) {
            Ok(c) => match c.health().await {
                Ok(mut h) => {
                    h.message = Some(match h.ready {
                        Some(false) => "GPU pod reachable; ComfyUI is not ready yet".into(),
                        _ => "GPU pod is running and ready".into(),
                    });
                    h
                }
                Err(e) => fail("pod", e),
            },
            Err(e) => fail("pod", e),
        };
    }
    let rest = match pod::rest(core) {
        Ok(r) => r,
        Err(e) => return fail("api", e),
    };
    match rest.list_pods().await {
        Ok(_) => Health {
            ok: true,
            target: Some("api".into()),
            message: Some("API key OK — the GPU is stopped".into()),
            ..Default::default()
        },
        Err(e) => fail("api", e.message),
    }
}

#[tauri::command]
pub fn list_models(core: CoreState<'_>) -> Vec<Value> {
    status::model_views(&core)
}

/// `profile`: whose volume to check ("image" default, or "video").
#[tauri::command]
pub async fn refresh_status(core: CoreState<'_>, profile: Option<String>) -> Res<StatusView> {
    let p = Profile::parse(profile.as_deref())?;
    status::refresh_status_opts_for(&core, p, true).await
}

/// Additive: cached status (volume/checkedAt may be null) without a GPU call.
#[tauri::command]
pub fn get_status(core: CoreState<'_>, profile: Option<String>) -> Res<StatusView> {
    status::cached_view_for(&core, Profile::parse(profile.as_deref())?)
}

// ----- models -----

#[tauri::command]
pub async fn download_model(core: CoreState<'_>, id: String) -> Res<Task> {
    tasks::download_model(&core, &id)
}

#[tauri::command]
pub fn cancel_task(core: CoreState<'_>, task_id: String) -> Res<()> {
    tasks::cancel_task(&core, &task_id)
}

#[tauri::command]
pub fn delete_preview(core: CoreState<'_>, id: String) -> Res<DeletePreview> {
    tasks::delete_preview(&core, &id)
}

#[tauri::command]
pub async fn delete_model(core: CoreState<'_>, id: String) -> Res<DeleteResult> {
    tasks::delete_model(&core, &id)
}

// ----- LoRAs -----

#[tauri::command]
pub async fn resolve_lora_link(core: CoreState<'_>, url: String) -> Res<ResolvedLora> {
    let resolver = core.resolver();
    resolver.resolve(&url, &core.registry).await
}

#[tauri::command]
pub async fn add_lora(
    core: CoreState<'_>,
    url: String,
    model_id: String,
    name: Option<String>,
    trigger_words: Option<Vec<String>>,
) -> Res<LoraView> {
    tasks::add_lora(&core, &url, &model_id, name, trigger_words).await
}

#[tauri::command]
pub fn list_loras(core: CoreState<'_>) -> Res<Vec<LoraView>> {
    status::lora_views(&core)
}

#[tauri::command]
pub async fn delete_lora(core: CoreState<'_>, id: String) -> Res<Option<Task>> {
    tasks::delete_lora(&core, &id)
}

// ----- references -----

#[tauri::command]
pub async fn import_reference(core: CoreState<'_>, path: String) -> Res<ImportedReference> {
    let dir = core.cfg.references_dir();
    tauri::async_runtime::spawn_blocking(move || {
        references::import_path(&dir, &PathBuf::from(path))
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn import_reference_bytes(
    core: CoreState<'_>,
    base64: String,
    mime: Option<String>,
) -> Res<ImportedReference> {
    let _ = mime; // format is detected from the bytes
    let data = base64
        .split_once(";base64,")
        .map(|(_, d)| d)
        .unwrap_or(&base64);
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(data.trim())
        .map_err(|_| "The pasted image data is not valid base64".to_string())?;
    let dir = core.cfg.references_dir();
    tauri::async_runtime::spawn_blocking(move || references::import_bytes(&dir, &bytes))
        .await
        .map_err(|e| e.to_string())?
}

// ----- generation & gallery -----

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct JobStarted {
    pub job_id: String,
}

#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn generate(
    core: CoreState<'_>,
    model: String,
    prompt: String,
    negative_prompt: Option<String>,
    aspect_ratio: String,
    count: Option<u32>,
    seed: Option<u64>,
    steps: Option<u32>,
    cfg: Option<f64>,
    reference_ids: Option<Vec<String>>,
    loras: Option<Vec<LoraChoice>>,
    init_image_id: Option<String>,
    denoise: Option<f64>,
) -> Res<JobStarted> {
    let req = GenerateRequest {
        model,
        prompt,
        negative_prompt,
        aspect_ratio,
        count: count.unwrap_or(1),
        seed,
        steps,
        cfg,
        reference_ids: reference_ids.unwrap_or_default(),
        loras: loras.unwrap_or_default(),
        init_image_id,
        denoise,
    };
    // References are ≤1 MP files, so reading them inline is cheap.
    let job_id = jobs::generate(&core, req)?;
    Ok(JobStarted { job_id })
}

/// Video generation (spec v5): one pod job on the video GPU profile.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn generate_video(
    core: CoreState<'_>,
    model: String,
    prompt: String,
    negative_prompt: Option<String>,
    init_image_id: Option<String>,
    init_image_gallery_id: Option<String>,
    duration_s: f64,
    fps: f64,
    resolution: String,
    seed: Option<u64>,
    steps: Option<u32>,
    cfg: Option<f64>,
    audio: Option<bool>,
) -> Res<JobStarted> {
    let req = VideoRequest {
        model,
        prompt,
        negative_prompt,
        init_image_id,
        init_image_gallery_id,
        duration_s,
        fps,
        resolution,
        seed,
        steps,
        cfg,
        audio: audio.unwrap_or(false),
    };
    let job_id = jobs::generate_video(&core, req)?;
    Ok(JobStarted { job_id })
}

#[tauri::command]
pub fn cancel_job(core: CoreState<'_>, job_id: String) -> Res<()> {
    jobs::cancel_job(&core, &job_id)
}

/// Additive: jobs still running (for a UI that remounts).
#[tauri::command]
pub fn list_jobs(core: CoreState<'_>) -> Vec<Job> {
    jobs::active_jobs(&core)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImagePage {
    pub items: Vec<ImageRecord>,
    pub next_before: Option<i64>,
}

#[tauri::command]
pub fn list_images(core: CoreState<'_>, limit: Option<u32>, before: Option<i64>) -> Res<ImagePage> {
    let (items, next_before) = core
        .db
        .lock()
        .unwrap()
        .list_images(limit.unwrap_or(50), before)?;
    Ok(ImagePage { items, next_before })
}

#[tauri::command]
pub fn delete_image(core: CoreState<'_>, id: String) -> Res<()> {
    let db = core.db.lock().unwrap();
    let rec = db.get_image(&id)?.ok_or("Image not found")?;
    db.delete_image(&id)?;
    // Only files the app wrote (images/, videos/) are removed.
    let owned = [core.cfg.images_dir(), core.cfg.videos_dir()];
    for f in std::iter::once(&rec.path).chain(rec.poster_path.as_ref()) {
        let p = PathBuf::from(f);
        if owned.iter().any(|d| p.starts_with(d)) {
            let _ = std::fs::remove_file(p);
        }
    }
    Ok(())
}

/// Additive: copy an image (or a video's .mp4) to a path chosen with the
/// dialog plugin's save dialog.
#[tauri::command]
pub fn export_image(core: CoreState<'_>, id: String, dest_path: String) -> Res<()> {
    let rec = core
        .db
        .lock()
        .unwrap()
        .get_image(&id)?
        .ok_or("Image not found")?;
    std::fs::copy(&rec.path, &dest_path)
        .map(|_| ())
        .map_err(|e| {
            let what = if rec.kind == crate::db::KIND_VIDEO { "video" } else { "image" };
            format!("Could not save the {what}: {e}")
        })
}
