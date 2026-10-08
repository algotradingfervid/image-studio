//! Tauri commands. Arguments are flat camelCase keys, e.g.
//! `invoke("generate", { model, prompt, aspectRatio, count, referenceIds, loras })`.
//! Errors are user-readable strings.

use crate::db::ImageRecord;
use crate::jobs::{self, GenerateRequest, Job, LoraChoice};
use crate::links::ResolvedLora;
use crate::references::{self, ImportedReference};
use crate::runpod::Health;
use crate::settings::{SaveSettings, SettingsView};
use crate::state::Core;
use crate::status::{self, LoraView, StatusView};
use crate::tasks::{self, DeletePreview, DeleteResult, Task};
use base64::Engine;
use serde::Serialize;
use serde_json::Value;
use std::path::PathBuf;
use std::sync::Arc;
use tauri::State;

type Res<T> = Result<T, String>;
type CoreState<'a> = State<'a, Arc<Core>>;

// ----- settings & status -----

#[tauri::command]
pub fn get_settings(core: CoreState<'_>) -> SettingsView {
    core.settings.view()
}

#[tauri::command]
pub fn save_settings(
    core: CoreState<'_>,
    api_key: Option<String>,
    endpoint_id: Option<String>,
    civitai_key: Option<String>,
) -> Res<SettingsView> {
    core.settings.save(SaveSettings {
        api_key,
        endpoint_id,
        civitai_key,
    })
}

#[tauri::command]
pub async fn test_connection(core: CoreState<'_>) -> Res<Health> {
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

#[tauri::command]
pub fn list_models(core: CoreState<'_>) -> Vec<Value> {
    status::model_views(&core)
}

#[tauri::command]
pub async fn refresh_status(core: CoreState<'_>) -> Res<StatusView> {
    status::refresh_status(&core).await
}

/// Additive: cached status (volume/checkedAt may be null) without a GPU call.
#[tauri::command]
pub fn get_status(core: CoreState<'_>) -> Res<StatusView> {
    status::cached_view(&core)
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
    };
    // References are ≤1 MP files, so reading them inline is cheap.
    let job_id = jobs::generate(&core, req)?;
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
    let images_dir = core.cfg.images_dir();
    let p = PathBuf::from(&rec.path);
    if p.starts_with(&images_dir) {
        let _ = std::fs::remove_file(p);
    }
    Ok(())
}

/// Additive: copy an image to a path chosen with the dialog plugin's save dialog.
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
        .map_err(|e| format!("Could not save the image: {e}"))
}
