//! Tauri commands. Arguments are flat camelCase keys, e.g.
//! `invoke("generate", { model, prompt, aspectRatio, count, referenceIds, loras,
//! initImageId?, denoise? })`.
//! Errors are user-readable strings.

use crate::db::ImageRecord;
use crate::jobs::{self, Destination, GenerateRequest, Job, LoraChoice, VideoRequest};
use crate::links::ResolvedLora;
use crate::pod::{self, GpuState, Profile};
use crate::references::{self, ImportedReference};
use crate::runpod::Health;
use crate::settings::{Backend, SavePodSettings, SaveSettings, SettingsView};
use crate::state::Core;
use crate::status::{self, LoraView, StatusView};
use crate::stories::{self, render, Character, Shot, Story, StoryPatch, StoryView};
use crate::tasks::{self, DeletePreview, DeleteResult, Task};
use crate::vault::{KdfParams, VaultStatus};
use crate::vault_migrate::{self, MigrateOptions};
use crate::worker::WorkerTarget;
use base64::Engine;
use serde::Serialize;
use serde_json::Value;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use tauri::State;
use zeroize::Zeroizing;

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
    /// Vault auto-lock after this many idle minutes (spec v6; default 10).
    pub vault_auto_lock_minutes: u32,
    /// Additive: the settings file (hand-edited keys such as workerRef).
    pub settings_path: String,
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
        vault_auto_lock_minutes: core.settings.vault_auto_lock_minutes(),
        settings_path: core.settings.config_path().to_string_lossy().into_owned(),
    }
}

/// Shows the settings file in Finder (created first if it doesn't exist yet).
#[tauri::command]
pub fn reveal_settings_file(core: CoreState<'_>) -> Res<String> {
    let path = core.settings.ensure_config_file()?;
    tauri_plugin_opener::reveal_item_in_dir(&path)
        .map_err(|e| format!("Couldn't show the settings file: {e}"))?;
    Ok(path.to_string_lossy().into_owned())
}

/// Shows the diagnostics log (`~/Library/Logs/Image Studio/app.log`) in Finder.
#[tauri::command]
pub fn reveal_logs() -> Res<String> {
    let dir = crate::applog::default_dir().ok_or("No home folder")?;
    let path = dir.join("app.log");
    let target = if path.exists() { path } else { dir };
    tauri_plugin_opener::reveal_item_in_dir(&target).map_err(|e| format!("Couldn't show the logs: {e}"))?;
    Ok(target.to_string_lossy().into_owned())
}

/// A UI error or warning for the diagnostics log (from window.onerror and
/// error toasts). Capped; the UI never sends prompts here.
#[tauri::command]
pub fn log_ui(level: String, message: String) {
    let level: String = level.chars().filter(|c| c.is_ascii_alphabetic()).take(8).collect();
    let mut msg: String = message.chars().take(2000).collect();
    if message.chars().count() > 2000 {
        msg.push('…');
    }
    crate::alog!("ui", "{level}: {msg}");
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
    vault_auto_lock_minutes: Option<u32>,
) -> Res<SettingsResponse> {
    if let Some(m) = vault_auto_lock_minutes {
        // Only while unlocked (refused otherwise, before anything is saved).
        core.set_vault_auto_lock(m)?;
    }
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
    core.vault.lock();
    guard.0.store(true, Ordering::SeqCst);
    app.exit(0);
    Ok(())
}

#[tauri::command]
pub async fn test_connection(core: CoreState<'_>) -> Res<Health> {
    Ok(test_pod_connection(&core).await)
}

/// One key's check (UX-017).
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct KeyCheck {
    pub ok: bool,
    /// "typed" (the unsaved value given) or "saved" (the stored key).
    pub source: &'static str,
    pub message: String,
    /// The check couldn't reach the service (the key may still be fine).
    pub network: bool,
}

/// `test_api_keys`: `null` for a key that was neither given nor saved.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct KeyTestReport {
    pub runpod: Option<KeyCheck>,
    pub civitai: Option<KeyCheck>,
}

/// Checks the given (unsaved) keys — or, for a key not given, the saved one —
/// without storing anything: RunPod with `GET /v2/pods` (never starts a pod),
/// Civitai with `GET /api/v1/me` (401 without a valid token). Keys are never
/// logged or returned.
pub async fn check_api_keys(
    core: &Core,
    api_key: Option<String>,
    civitai_key: Option<String>,
) -> KeyTestReport {
    let pick = |typed: Option<String>, saved: Option<String>| {
        match typed.map(|k| k.trim().to_string()).filter(|k| !k.is_empty()) {
            Some(k) => Some((k, "typed")),
            None => saved.map(|k| (k, "saved")),
        }
    };
    let runpod = match pick(api_key, core.settings.runpod_api_key()) {
        None => None,
        Some((key, source)) => {
            let rest = pod::RestClient::with_timeout(&core.cfg.rest_root, &key, core.cfg.rest_timeout);
            Some(match rest.list_pods().await {
                Ok(_) => KeyCheck {
                    ok: true,
                    source,
                    message: "Key OK".into(),
                    network: false,
                },
                Err(e) => KeyCheck {
                    ok: false,
                    source,
                    message: match e.status {
                        Some(401) => "RunPod rejected this key — check RunPod → Settings → API Keys".into(),
                        Some(403) => "This key can't manage pods — give it read/write access in RunPod → Settings → API Keys".into(),
                        _ => e.message,
                    },
                    network: e.status.is_none(),
                },
            })
        }
    };
    let civitai = match pick(civitai_key, core.settings.civitai_api_key()) {
        None => None,
        Some((key, source)) => Some(check_civitai_key(&core.cfg.civitai_root, &key, source).await),
    };
    KeyTestReport { runpod, civitai }
}

async fn check_civitai_key(root: &str, key: &str, source: &'static str) -> KeyCheck {
    let fail = |message: String, network: bool| KeyCheck {
        ok: false,
        source,
        message,
        network,
    };
    let http = match reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(20))
        .build()
    {
        Ok(h) => h,
        Err(e) => return fail(e.to_string(), true),
    };
    let url = format!("{}/api/v1/me", root.trim_end_matches('/'));
    match http.get(url).bearer_auth(key).send().await {
        Err(e) => fail(format!("Couldn't reach Civitai: {}", e.without_url()), true),
        Ok(r) if r.status().is_success() => {
            let user = r
                .json::<Value>()
                .await
                .ok()
                .and_then(|v| v.get("username").and_then(Value::as_str).map(str::to_string));
            KeyCheck {
                ok: true,
                source,
                message: match user {
                    Some(u) => format!("Key OK (signed in as {u})"),
                    None => "Key OK".into(),
                },
                network: false,
            }
        }
        Ok(r) if matches!(r.status().as_u16(), 401 | 403) => fail(
            "Civitai rejected this key — check civitai.com → Account settings → API keys".into(),
            false,
        ),
        Ok(r) => fail(format!("Civitai answered {} — try again later", r.status().as_u16()), true),
    }
}

/// UX-017: test keys before saving them (nothing is stored).
#[tauri::command]
pub async fn test_api_keys(
    core: CoreState<'_>,
    api_key: Option<String>,
    civitai_key: Option<String>,
) -> Res<KeyTestReport> {
    Ok(check_api_keys(&core, api_key, civitai_key).await)
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

/// `destination` (spec v6): "vault" seals the downscaled copy into the vault
/// instead of writing it to `references/`; a `vault:` source always does.
#[tauri::command]
pub async fn import_reference(
    core: CoreState<'_>,
    path: String,
    destination: Option<String>,
) -> Res<ImportedReference> {
    let dest = Destination::parse(destination.as_deref())?;
    let c = core.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        if crate::vault::is_vault_path(&path) {
            let bytes = vault_migrate::read_source(&c, &path)?;
            return vault_migrate::import_reference_to_vault(&c, &bytes);
        }
        match dest {
            Destination::Vault => {
                let bytes = std::fs::read(&path)
                    .map_err(|e| format!("Could not open {}: {e}", PathBuf::from(&path).display()))?;
                vault_migrate::import_reference_to_vault(&c, &bytes)
            }
            Destination::General => references::import_path(&c.cfg.references_dir(), &PathBuf::from(path)),
        }
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn import_reference_bytes(
    core: CoreState<'_>,
    base64: String,
    mime: Option<String>,
    destination: Option<String>,
) -> Res<ImportedReference> {
    let _ = mime; // format is detected from the bytes
    let dest = Destination::parse(destination.as_deref())?;
    let data = base64
        .split_once(";base64,")
        .map(|(_, d)| d)
        .unwrap_or(&base64);
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(data.trim())
        .map_err(|_| "The pasted image data is not valid base64".to_string())?;
    let c = core.inner().clone();
    tauri::async_runtime::spawn_blocking(move || match dest {
        Destination::Vault => vault_migrate::import_reference_to_vault(&c, &bytes),
        Destination::General => references::import_bytes(&c.cfg.references_dir(), &bytes),
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Moves an imported reference into the vault (for a vault job): the returned
/// id replaces the old one. Already-vault ids are returned unchanged.
#[tauri::command]
pub async fn seal_reference(core: CoreState<'_>, ref_id: String) -> Res<ImportedReference> {
    let c = core.inner().clone();
    tauri::async_runtime::spawn_blocking(move || vault_migrate::seal_plain_reference(&c, &ref_id))
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
    init_image_gallery_id: Option<String>,
    init_image_vault_id: Option<String>,
    destination: Option<String>,
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
        init_image_gallery_id,
        init_image_vault_id,
        destination: Destination::parse(destination.as_deref())?,
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
    init_image_vault_id: Option<String>,
    reference_ids: Option<Vec<String>>,
    duration_s: f64,
    fps: f64,
    resolution: String,
    seed: Option<u64>,
    steps: Option<u32>,
    cfg: Option<f64>,
    audio: Option<bool>,
    destination: Option<String>,
) -> Res<JobStarted> {
    let req = VideoRequest {
        model,
        prompt,
        negative_prompt,
        init_image_id,
        init_image_gallery_id,
        init_image_vault_id,
        reference_ids: reference_ids.unwrap_or_default(),
        duration_s,
        fps,
        resolution,
        seed,
        steps,
        cfg,
        audio: audio.unwrap_or(false),
        destination: Destination::parse(destination.as_deref())?,
        story_take: None,
        label: None,
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

/// Deletes a general record (and its files) — or, when `id` is a vault item
/// and the vault is unlocked, that item.
#[tauri::command]
pub fn delete_image(core: CoreState<'_>, id: String) -> Res<()> {
    let db = core.db.lock().unwrap();
    let Some(rec) = db.get_image(&id)? else {
        drop(db);
        return delete_vault_item(core, id);
    };
    // Only files the app wrote (images/, videos/) are removed.
    core.cfg.delete_record(&db, &rec)
}

/// Additive: copy an image (or a video's .mp4) to a path chosen with the
/// dialog plugin's save dialog.
#[tauri::command]
pub fn export_image(core: CoreState<'_>, id: String, dest_path: String) -> Res<()> {
    let rec = core.db.lock().unwrap().get_image(&id)?;
    let Some(rec) = rec else {
        return export_vault_item(core, id, dest_path);
    };
    std::fs::copy(&rec.path, &dest_path)
        .map(|_| ())
        .map_err(|e| {
            let what = if rec.kind == crate::db::KIND_VIDEO { "video" } else { "image" };
            format!("Could not save the {what}: {e}")
        })
}

/// Shows a General record's file in Finder. Vault items are exported instead.
#[tauri::command]
pub fn reveal_image(core: CoreState<'_>, id: String) -> Res<()> {
    let rec = core.db.lock().unwrap().get_image(&id)?;
    let Some(rec) = rec else {
        return Err("Vault films are exported, not shown in Finder".into());
    };
    tauri_plugin_opener::reveal_item_in_dir(&rec.path).map_err(|e| format!("Couldn't show the file: {e}"))
}

// ----- vault (spec v6) -----

fn spawn_migration(core: &Arc<Core>) {
    let c = core.clone();
    tauri::async_runtime::spawn_blocking(move || {
        if let Err(e) = vault_migrate::migrate(&c, MigrateOptions::default()) {
            crate::alog!("vault", "migration stopped: {e}");
        }
    });
}

#[tauri::command]
pub fn vault_status(core: CoreState<'_>) -> VaultStatus {
    core.vault.status()
}

/// Creates the vault (Argon2id at the spec cost runs off the main thread) and
/// starts the one-time migration of every existing gallery item in the background.
#[tauri::command]
pub async fn vault_create(core: CoreState<'_>, password: String) -> Res<VaultStatus> {
    let password = Zeroizing::new(password);
    let c = core.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        c.vault.create(password.as_bytes(), KdfParams::PRODUCTION)?;
        c.emit_vault();
        spawn_migration(&c);
        Ok::<_, String>(c.vault.status())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Unlocks; an unfinished migration resumes in the background.
#[tauri::command]
pub async fn vault_unlock(core: CoreState<'_>, password: String) -> Res<VaultStatus> {
    let password = Zeroizing::new(password);
    let c = core.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        c.vault.unlock(password.as_bytes())?;
        c.emit_vault();
        if vault_migrate::migration_pending(&c) {
            spawn_migration(&c);
        }
        Ok::<_, String>(c.vault.status())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub fn vault_lock(core: CoreState<'_>) -> VaultStatus {
    core.vault.lock();
    core.emit_vault();
    core.vault.status()
}

#[tauri::command]
pub async fn vault_change_password(
    core: CoreState<'_>,
    old_password: String,
    new_password: String,
) -> Res<VaultStatus> {
    let current = Zeroizing::new(old_password);
    let new = Zeroizing::new(new_password);
    let c = core.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        c.vault
            .change_password(current.as_bytes(), new.as_bytes(), KdfParams::PRODUCTION)?;
        c.emit_vault();
        Ok::<_, String>(c.vault.status())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Erases the vault for good (UI-059, the way out of a forgotten password):
/// every item, blob, the key material and the vault itself. Works locked or
/// unlocked, needs no password and reveals nothing. `confirm` is the word the
/// user typed and must be "erase".
#[tauri::command]
pub async fn vault_erase(core: CoreState<'_>, confirm: String) -> Res<VaultStatus> {
    let c = core.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        c.vault.erase(&confirm)?;
        crate::alog!("vault", "vault erased");
        c.emit_vault();
        Ok::<_, String>(c.vault.status())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Auto-lock after `minutes` without interaction (1–240); persisted in
/// settings.json. Only while the vault is unlocked.
#[tauri::command]
pub fn vault_set_auto_lock(core: CoreState<'_>, minutes: u32) -> Res<VaultStatus> {
    // Refused while locked (or with no vault).
    core.set_vault_auto_lock(minutes)
}

/// Decrypted vault items, newest first (error while locked).
#[tauri::command]
pub fn list_vault_items(core: CoreState<'_>) -> Res<Vec<ImageRecord>> {
    core.vault.touch();
    Ok(core.vault.gallery_items()?.iter().map(|i| i.to_record()).collect())
}

#[tauri::command]
pub async fn move_to_vault(core: CoreState<'_>, id: String) -> Res<ImageRecord> {
    let c = core.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let r = vault_migrate::move_to_vault(&c, &id)?;
        c.emit_vault();
        Ok::<_, String>(r)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn move_to_general(core: CoreState<'_>, id: String) -> Res<ImageRecord> {
    let c = core.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let r = vault_migrate::move_to_general(&c, &id)?;
        c.emit_vault();
        Ok::<_, String>(r)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Writes an unencrypted copy of a vault item's media to a user-chosen path.
#[tauri::command]
pub fn export_vault_item(core: CoreState<'_>, id: String, dest: String) -> Res<()> {
    core.vault.touch();
    vault_migrate::export_item(&core, &id, &PathBuf::from(dest))
}

#[tauri::command]
pub fn delete_vault_item(core: CoreState<'_>, id: String) -> Res<()> {
    core.vault.touch();
    core.vault.delete_item(&id)?;
    core.emit_vault();
    Ok(())
}

/// User interaction: resets the auto-lock timer.
#[tauri::command]
pub fn vault_touch(core: CoreState<'_>) {
    core.vault.touch();
}

// ----- stories -----

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RenderedShot {
    pub shot_id: String,
    pub job_id: String,
}

/// "Render all": the shots queued, and why the others couldn't start.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RenderAllResult {
    pub queued: Vec<RenderedShot>,
    pub error: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ApproveResult {
    pub view: StoryView,
    pub queued: Option<RenderedShot>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LlmStatus {
    pub base_url: String,
    pub model: String,
    pub reachable: bool,
    pub models: Vec<String>,
    pub error: Option<String>,
}

fn rendered((shot_id, job_id): (String, String)) -> RenderedShot {
    RenderedShot { shot_id, job_id }
}

#[tauri::command]
pub fn list_characters(core: CoreState<'_>) -> Res<Vec<Character>> {
    let cs = stories::store::list_characters(&core.db.lock().unwrap())?;
    Ok(render::with_ref_paths(&core.cfg.references_dir(), cs))
}

/// New when `id` is empty (id and timestamps assigned); else an update.
#[tauri::command]
pub fn save_character(core: CoreState<'_>, character: Character) -> Res<Character> {
    let mut c = character;
    c.name = c.name.trim().to_string();
    c.description = c.description.trim().to_string();
    c.ref_paths = Vec::new(); // display only: not stored
    stories::store::check_character(&c)?;
    let now = crate::state::now_rfc3339();
    let db = core.db.lock().unwrap();
    if c.id.is_empty() {
        c.id = uuid::Uuid::new_v4().to_string();
        c.created_at = now.clone();
    } else if let Some(old) = stories::store::get_character(&db, &c.id)? {
        c.created_at = old.created_at;
    } else if c.created_at.is_empty() {
        c.created_at = now.clone();
    }
    c.updated_at = now;
    stories::store::save_character(&db, &c)?;
    drop(db);
    Ok(render::with_ref_paths(&core.cfg.references_dir(), vec![c]).remove(0))
}

#[tauri::command]
pub fn delete_character(core: CoreState<'_>, id: String) -> Res<()> {
    stories::store::delete_character(&core.db.lock().unwrap(), &id)
}

#[tauri::command]
pub fn list_stories(core: CoreState<'_>) -> Res<Vec<Story>> {
    stories::store::list_stories(&core.db.lock().unwrap())
}

#[tauri::command]
pub fn create_story(
    core: CoreState<'_>,
    brief: String,
    target_s: u32,
    aspect: String,
    style: String,
    cast: Vec<String>,
) -> Res<StoryView> {
    let now = crate::state::now_rfc3339();
    let story = Story {
        id: uuid::Uuid::new_v4().to_string(),
        title: String::new(),
        logline: String::new(),
        brief: brief.trim().to_string(),
        target_s,
        aspect,
        style: style.trim().to_string(),
        cast,
        voices: vec![],
        status: "draft".into(),
        result_image_id: None,
        vault: false,
        created_at: now.clone(),
        updated_at: now,
    };
    render::check_story(&story)?;
    render::check_cast_exists(&core, &story.cast)?;
    stories::store::save_story(&core.db.lock().unwrap(), &story)?;
    render::story_view(&core, &story.id)
}

/// Saves only the fields the patch sets (title, brief, target, aspect, style, cast, voices).
#[tauri::command]
pub fn update_story(core: CoreState<'_>, id: String, patch: StoryPatch) -> Res<StoryView> {
    render::update_story(&core, &id, patch)
}

/// Deletes the story, its shots, its takes and its assembled video (not while a shot renders).
#[tauri::command]
pub fn delete_story(core: CoreState<'_>, id: String) -> Res<()> {
    render::delete_story(&core, &id)
}

#[tauri::command]
pub fn get_story(core: CoreState<'_>, id: String) -> Res<StoryView> {
    render::story_view(&core, &id)
}

/// Plans the shots with the local LLM (replaces the shot list).
#[tauri::command]
pub async fn plan_story(core: CoreState<'_>, id: String) -> Res<StoryView> {
    render::plan_story(&core, &id).await
}

/// Saves the edited shot list in the given order (see `store::merge_shots`).
#[tauri::command]
pub fn save_shots(core: CoreState<'_>, story_id: String, shots: Vec<Shot>) -> Res<StoryView> {
    render::save_shots(&core, &story_id, shots)
}

#[tauri::command]
pub async fn render_shot(core: CoreState<'_>, shot_id: String) -> Res<JobStarted> {
    let job_id = render::render_shot(&core, &shot_id)?;
    Ok(JobStarted { job_id })
}

#[tauri::command]
pub async fn render_story(core: CoreState<'_>, story_id: String) -> Res<RenderAllResult> {
    let all = render::render_story(&core, &story_id)?;
    Ok(RenderAllResult { queued: all.queued.into_iter().map(rendered).collect(), error: all.error })
}

#[tauri::command]
pub async fn approve_take(core: CoreState<'_>, shot_id: String, take_id: String) -> Res<ApproveResult> {
    let queued = render::approve_take(&core, &shot_id, &take_id)?.map(rendered);
    let story_id = stories::store::get_shot(&core.db.lock().unwrap(), &shot_id)?
        .ok_or("That shot no longer exists")?
        .story_id;
    Ok(ApproveResult { view: render::story_view(&core, &story_id)?, queued })
}

/// ffmpeg concat of the approved takes (off the async runtime).
#[tauri::command]
pub async fn assemble_story(core: CoreState<'_>, story_id: String) -> Res<StoryView> {
    let c = core.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        render::assemble_story(&c, &story_id)?;
        render::story_view(&c, &story_id)
    })
    .await
    .map_err(|e| format!("Assembling stopped: {e}"))?
}

async fn llm_status_of(core: &Core) -> LlmStatus {
    let base_url = core.settings.llm_base_url();
    let model = core.settings.llm_model();
    let (reachable, models, error) = match stories::planner::list_models(&base_url).await {
        Ok(models) if models.is_empty() => (true, models, Some("Load a model in LM Studio first".to_string())),
        Ok(models) => (true, models, None),
        Err(e) => (false, vec![], Some(e)),
    };
    LlmStatus { base_url, model, reachable, models, error }
}

#[tauri::command]
pub async fn llm_status(core: CoreState<'_>) -> Res<LlmStatus> {
    Ok(llm_status_of(&core).await)
}

#[tauri::command]
pub async fn save_llm_settings(
    core: CoreState<'_>,
    base_url: Option<String>,
    model: Option<String>,
) -> Res<LlmStatus> {
    core.settings.save_llm(base_url, model)?;
    Ok(llm_status_of(&core).await)
}
