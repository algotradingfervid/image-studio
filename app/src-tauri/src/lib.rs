pub mod commands;
pub mod db;
pub mod delete_rule;
pub mod jobs;
pub mod links;
pub mod pod;
pub mod references;
pub mod registry;
pub mod runpod;
pub mod settings;
pub mod state;
pub mod status;
pub mod tasks;
pub mod worker;

use std::sync::Arc;
use tauri::{Emitter, Manager};

/// Forwards core events to the webview.
struct TauriSink(tauri::AppHandle);

impl state::EventSink for TauriSink {
    fn job_update(&self, job: &jobs::Job) {
        let _ = self.0.emit(state::EVENT_JOB, job);
    }
    fn task_update(&self, task: &tasks::Task) {
        let _ = self.0.emit(state::EVENT_TASK, task);
    }
    fn status_update(&self, s: &status::StatusView) {
        let _ = self.0.emit(state::EVENT_STATUS, s);
    }
    fn gpu_update(&self, s: &pod::GpuState) {
        let _ = self.0.emit(state::EVENT_GPU, s);
    }
}

fn build_core(app: &tauri::App) -> Result<Arc<state::Core>, String> {
    let data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("No app data dir: {e}"))?;
    std::fs::create_dir_all(&data_dir).map_err(|e| e.to_string())?;
    let db = db::Db::open(&data_dir.join("studio.db"))?;
    let settings = settings::Settings::new(
        Arc::new(settings::KeychainStore),
        settings::load_env_fallback(),
        data_dir.join("settings.json"),
    );
    state::Core::new(
        registry::Registry::embedded(),
        db,
        settings,
        Arc::new(TauriSink(app.handle().clone())),
        state::CoreConfig::production(data_dir),
    )
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .setup(|app| {
            let core = build_core(app)?;
            app.manage(core.clone());
            // GPU pod: re-adopt a pod left running, cache the volume size,
            // and run the idle auto-stop / liveness monitor.
            let pod_core = core.clone();
            tauri::async_runtime::spawn(async move {
                pod::run_monitor(pod_core, std::time::Duration::from_secs(30)).await
            });
            tauri::async_runtime::spawn(async move {
                if core.settings.backend() == settings::Backend::Pod {
                    if let Ok(rest) = pod::rest(&core) {
                        if let Err(e) = pod::lookup_volume(&core, &rest).await {
                            eprintln!("[startup] volume lookup failed: {e}");
                        }
                        if let Err(e) = pod::adopt(&core).await {
                            eprintln!("[startup] pod adopt failed: {e}");
                        }
                        // Let an adopted pod finish its readiness check.
                        let mut rx = pod::subscribe(&core);
                        let _ = tokio::time::timeout(std::time::Duration::from_secs(20), async {
                            while pod::state(&core).status == pod::GpuStatus::Starting {
                                if rx.changed().await.is_err() {
                                    break;
                                }
                            }
                        })
                        .await;
                    }
                }
                // Refresh the status cache on start only if it is older than
                // 24 h — and never start the GPU just for that.
                let checked = core
                    .db
                    .lock()
                    .unwrap()
                    .load_status()
                    .ok()
                    .flatten()
                    .map(|(_, at)| at);
                if worker::ready_client(&core).is_some_and(|c| c.is_ok())
                    && status::is_stale(checked.as_deref(), chrono::Utc::now())
                {
                    if let Err(e) = status::refresh_status_opts(&core, false).await {
                        eprintln!("[startup] status refresh failed: {e}");
                    }
                }
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::get_settings,
            commands::save_settings,
            commands::test_connection,
            commands::get_gpu_state,
            commands::start_gpu,
            commands::stop_gpu,
            commands::list_models,
            commands::refresh_status,
            commands::get_status,
            commands::download_model,
            commands::cancel_task,
            commands::delete_preview,
            commands::delete_model,
            commands::resolve_lora_link,
            commands::add_lora,
            commands::list_loras,
            commands::delete_lora,
            commands::import_reference,
            commands::import_reference_bytes,
            commands::generate,
            commands::cancel_job,
            commands::list_jobs,
            commands::list_images,
            commands::delete_image,
            commands::export_image,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
