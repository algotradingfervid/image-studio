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

use commands::QuitGuard;
use std::sync::Arc;
use tauri::menu::{Menu, MenuItem};
use tauri::{AppHandle, Emitter, Manager, RunEvent, Runtime, WindowEvent};

/// Asks the UI to confirm quitting while a GPU pod may be billing.
pub const EVENT_QUIT_REQUESTED: &str = "quit-requested";
const QUIT_MENU_ID: &str = "image-studio-quit";

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
        Arc::new(settings::CachedStore::new(settings::KeychainStore)),
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

/// True when quitting now must be confirmed: not yet confirmed, and a GPU
/// pod is starting, running, stopping, or in error with a pod.
fn must_confirm_quit<R: Runtime>(app: &AppHandle<R>) -> bool {
    if app.state::<QuitGuard>().confirmed() {
        return false;
    }
    app.try_state::<Arc<state::Core>>()
        .is_some_and(|core| pod::needs_quit_confirm(&core))
}

/// Shows the in-app quit dialog (window raised), or — with no window left
/// to ask in — stops the GPU (confirmed) and then exits.
fn ask_quit<R: Runtime>(app: &AppHandle<R>) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
        let core = app.state::<Arc<state::Core>>();
        let _ = app.emit(EVENT_QUIT_REQUESTED, pod::state(&core));
        return;
    }
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let core = app.state::<Arc<state::Core>>().inner().clone();
        if let Err(e) = pod::stop_for_quit(&core).await {
            eprintln!("[quit] could not stop the GPU pod before quitting: {e}");
        }
        app.state::<QuitGuard>().0.store(true, std::sync::atomic::Ordering::SeqCst);
        app.exit(0);
    });
}

/// The quit menu item (⌘Q): confirm first when a pod may be billing.
fn request_quit<R: Runtime>(app: &AppHandle<R>) {
    if must_confirm_quit(app) {
        ask_quit(app);
    } else {
        app.state::<QuitGuard>().0.store(true, std::sync::atomic::Ordering::SeqCst);
        app.exit(0);
    }
}

/// The default menu, with the macOS "Quit" item replaced by one the app
/// handles: the predefined item sends `terminate:`, which quits without an
/// `ExitRequested` event and so could not be intercepted.
fn app_menu<R: Runtime>(h: &AppHandle<R>) -> tauri::Result<Menu<R>> {
    let menu = Menu::default(h)?;
    if cfg!(target_os = "macos") {
        for sub in menu.items()?.iter().filter_map(|i| i.as_submenu().cloned()) {
            let items = sub.items()?;
            let quit = items.iter().enumerate().find_map(|(pos, i)| {
                let text = i.as_predefined_menuitem()?.text().ok()?;
                text.starts_with("Quit").then_some((pos, text))
            });
            if let Some((pos, text)) = quit {
                sub.remove_at(pos)?;
                let item = MenuItem::with_id(h, QUIT_MENU_ID, text, true, Some("CmdOrCtrl+Q"))?;
                sub.insert(&item, pos)?;
            }
        }
    }
    Ok(menu)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .manage(QuitGuard::default())
        .menu(app_menu)
        .on_menu_event(|app, event| {
            if event.id() == QUIT_MENU_ID {
                request_quit(app);
            }
        })
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                let app = window.app_handle();
                if must_confirm_quit(app) {
                    api.prevent_close();
                    ask_quit(app);
                }
            }
        })
        .setup(|app| {
            let core = build_core(app)?;
            app.manage(core.clone());
            // GPU pod: re-adopt a pod left running, cache the volume size,
            // and run the idle/error auto-stop and liveness monitor (it
            // never creates pods).
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
            commands::confirm_quit,
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
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| {
            // Last window closed or a programmatic exit: confirm first while
            // a pod may be billing (`QuitGuard` lets a confirmed exit through).
            if let RunEvent::ExitRequested { api, .. } = event {
                if must_confirm_quit(app) {
                    api.prevent_exit();
                    ask_quit(app);
                }
            }
        });
}
