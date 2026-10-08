//! Download/delete tasks for models and LoRAs (worker actions `download` and
//! `delete`). Emits `task-update`; refreshes the status cache when a task ends.

use crate::db::LoraRow;
use crate::delete_rule::{plan_delete, KeptFile};
use crate::links::sanitize_filename;
use crate::registry::ModelFile;
use crate::runpod::{
    failure_message, parse_progress, RunStatus, RunpodClient, DOWNLOAD_TIMEOUT_MS,
    GENERATE_TIMEOUT_MS,
};
use crate::state::{now_rfc3339, Core};
use crate::status::{lora_folder, lora_view, present_set, refresh_status, LoraView};
use serde::Serialize;
use serde_json::{json, Map, Value};
use std::collections::HashSet;
use std::sync::Arc;

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum TargetType {
    Model,
    Lora,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct TaskTarget {
    #[serde(rename = "type")]
    pub kind: TargetType,
    pub id: String,
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum TaskKind {
    Download,
    Delete,
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum TaskStatus {
    Queued,
    Running,
    Completed,
    Failed,
    Cancelled,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Task {
    pub task_id: String,
    pub kind: TaskKind,
    pub target: TaskTarget,
    pub status: TaskStatus,
    pub bytes: u64,
    pub total_bytes: u64,
    pub file: Option<String>,
    pub error: Option<String>,
}

pub struct TaskEntry {
    pub task: Task,
    pub cancel: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeletePreview {
    pub delete_files: Vec<String>,
    pub freed_bytes: u64,
    pub kept_files: Vec<KeptFile>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeleteResult {
    pub freed_bytes: u64,
    pub kept_files: Vec<KeptFile>,
    /// Additive: the delete task started (null when nothing needed deleting).
    pub task: Option<Task>,
}

enum OnDone {
    Nothing,
    RemoveLora(String),
}

pub fn active_task_for(core: &Core, kind: TargetType, id: &str) -> Option<Task> {
    core.tasks
        .lock()
        .unwrap()
        .values()
        .find(|e| e.task.target.kind == kind && e.task.target.id == id)
        .map(|e| e.task.clone())
}

/// Models that are downloading or queued for download.
pub fn busy_models(core: &Core) -> HashSet<String> {
    core.tasks
        .lock()
        .unwrap()
        .values()
        .filter(|e| e.task.target.kind == TargetType::Model && e.task.kind == TaskKind::Download)
        .map(|e| e.task.target.id.clone())
        .collect()
}

fn download_entry(
    folder: &str,
    filename: &str,
    url: &str,
    size: Option<u64>,
    sha: Option<&str>,
) -> Value {
    let mut m = Map::new();
    m.insert("folder".into(), json!(folder));
    m.insert("filename".into(), json!(filename));
    m.insert("url".into(), json!(url));
    if let Some(s) = size {
        m.insert("sizeBytes".into(), json!(s));
    }
    if let Some(h) = sha {
        m.insert("sha256".into(), json!(h));
    }
    Value::Object(m)
}

fn ensure_idle(core: &Core, kind: TargetType, id: &str) -> Result<(), String> {
    if active_task_for(core, kind, id).is_some() {
        return Err(
            "A download or delete is already running for this item; wait for it or cancel it"
                .into(),
        );
    }
    Ok(())
}

pub fn download_model(core: &Arc<Core>, id: &str) -> Result<Task, String> {
    let model = core.registry.require_model(id)?.clone();
    ensure_idle(core, TargetType::Model, id)?;
    let client = core.runpod()?;
    let present = present_set(core);
    // Send every file: the worker skips files already present with the right size.
    let files: Vec<Value> = model
        .files
        .iter()
        .map(|f| {
            download_entry(
                &f.folder,
                &f.filename,
                &f.url,
                f.size_bytes,
                f.sha256.as_deref(),
            )
        })
        .collect();
    let total: u64 = model
        .files
        .iter()
        .filter(|f| !present.contains(&(f.folder.clone(), f.filename.clone())))
        .filter_map(|f| f.size_bytes)
        .sum();
    Ok(start_task(
        core,
        client,
        TaskKind::Download,
        TaskTarget {
            kind: TargetType::Model,
            id: id.into(),
        },
        json!({"action": "download", "files": files}),
        DOWNLOAD_TIMEOUT_MS,
        total,
        OnDone::Nothing,
    ))
}

fn plan(core: &Core, id: &str) -> Result<(crate::delete_rule::DeletePlan, Vec<ModelFile>), String> {
    let model = core.registry.require_model(id)?;
    let p = plan_delete(
        model,
        &core.registry.models,
        &present_set(core),
        &busy_models(core),
    );
    let files = p.delete_files.clone();
    Ok((p, files))
}

pub fn delete_preview(core: &Core, id: &str) -> Result<DeletePreview, String> {
    let (p, _) = plan(core, id)?;
    Ok(DeletePreview {
        delete_files: p.delete_files.iter().map(|f| f.filename.clone()).collect(),
        freed_bytes: p.freed_bytes,
        kept_files: p.kept_files,
    })
}

pub fn delete_model(core: &Arc<Core>, id: &str) -> Result<DeleteResult, String> {
    ensure_idle(core, TargetType::Model, id)?;
    let (p, files) = plan(core, id)?;
    if files.is_empty() {
        return Ok(DeleteResult {
            freed_bytes: 0,
            kept_files: p.kept_files,
            task: None,
        });
    }
    let client = core.runpod()?;
    let payload: Vec<Value> = files
        .iter()
        .map(|f| json!({"folder": f.folder, "filename": f.filename}))
        .collect();
    let task = start_task(
        core,
        client,
        TaskKind::Delete,
        TaskTarget {
            kind: TargetType::Model,
            id: id.into(),
        },
        json!({"action": "delete", "files": payload}),
        GENERATE_TIMEOUT_MS,
        p.freed_bytes,
        OnDone::Nothing,
    );
    Ok(DeleteResult {
        freed_bytes: p.freed_bytes,
        kept_files: p.kept_files,
        task: Some(task),
    })
}

pub async fn add_lora(
    core: &Arc<Core>,
    url: &str,
    model_id: &str,
    name: Option<String>,
    trigger_words: Option<Vec<String>>,
) -> Result<LoraView, String> {
    core.registry.require_model(model_id)?;
    let client = core.runpod()?;
    let r = core.resolver().resolve(url, &core.registry).await?;
    let filename = sanitize_filename(&r.filename)?;
    let row = LoraRow {
        id: uuid::Uuid::new_v4().to_string(),
        name: name
            .filter(|n| !n.trim().is_empty())
            .map(|n| n.trim().to_string())
            .unwrap_or(r.name.clone()),
        model_id: model_id.into(),
        source: r.source.clone(),
        source_url: url.trim().into(),
        download_url: r.download_url.clone(),
        filename: filename.clone(),
        size_bytes: r.size_bytes,
        sha256: r.sha256.clone(),
        trigger_words: trigger_words.unwrap_or(r.trigger_words.clone()),
        created_at: now_rfc3339(),
    };
    core.db.lock().unwrap().insert_lora(&row)?;
    let folder = lora_folder(model_id);
    let size_for_worker = if r.size_exact { r.size_bytes } else { None };
    let file = download_entry(
        &folder,
        &filename,
        &r.download_url,
        size_for_worker,
        r.sha256.as_deref(),
    );
    start_task(
        core,
        client,
        TaskKind::Download,
        TaskTarget {
            kind: TargetType::Lora,
            id: row.id.clone(),
        },
        json!({"action": "download", "files": [file]}),
        DOWNLOAD_TIMEOUT_MS,
        r.size_bytes.unwrap_or(0),
        OnDone::Nothing,
    );
    Ok(lora_view(core, &row, &present_set(core)))
}

/// Deletes the LoRA file from the volume (when present) and then the record.
/// Returns the delete task, or null when the record was removed immediately.
pub fn delete_lora(core: &Arc<Core>, id: &str) -> Result<Option<Task>, String> {
    let row = core
        .db
        .lock()
        .unwrap()
        .get_lora(id)?
        .ok_or("LoRA not found")?;
    ensure_idle(core, TargetType::Lora, id)?;
    let folder = lora_folder(&row.model_id);
    if !present_set(core).contains(&(folder.clone(), row.filename.clone())) {
        core.db.lock().unwrap().delete_lora(id)?;
        return Ok(None);
    }
    let client = core.runpod()?;
    Ok(Some(start_task(
        core,
        client,
        TaskKind::Delete,
        TaskTarget {
            kind: TargetType::Lora,
            id: id.into(),
        },
        json!({"action": "delete", "files": [{"folder": folder, "filename": row.filename}]}),
        GENERATE_TIMEOUT_MS,
        row.size_bytes.unwrap_or(0),
        OnDone::RemoveLora(id.into()),
    )))
}

pub fn cancel_task(core: &Core, task_id: &str) -> Result<(), String> {
    let mut tasks = core.tasks.lock().unwrap();
    let e = tasks
        .get_mut(task_id)
        .ok_or("That task has already finished")?;
    e.cancel = true;
    Ok(())
}

#[allow(clippy::too_many_arguments)]
fn start_task(
    core: &Arc<Core>,
    client: RunpodClient,
    kind: TaskKind,
    target: TaskTarget,
    input: Value,
    timeout_ms: u64,
    total_bytes: u64,
    on_done: OnDone,
) -> Task {
    let task = Task {
        task_id: uuid::Uuid::new_v4().to_string(),
        kind,
        target,
        status: TaskStatus::Queued,
        bytes: 0,
        total_bytes,
        file: None,
        error: None,
    };
    core.tasks.lock().unwrap().insert(
        task.task_id.clone(),
        TaskEntry {
            task: task.clone(),
            cancel: false,
        },
    );
    core.sink.task_update(&task);
    let core2 = core.clone();
    let id = task.task_id.clone();
    tokio::spawn(async move { run_task(core2, id, client, input, timeout_ms, on_done).await });
    task
}

fn update(core: &Core, id: &str, f: impl FnOnce(&mut Task)) {
    let snapshot = {
        let mut tasks = core.tasks.lock().unwrap();
        let Some(e) = tasks.get_mut(id) else { return };
        let before = e.task.clone();
        f(&mut e.task);
        (e.task != before).then(|| e.task.clone())
    };
    if let Some(t) = snapshot {
        core.sink.task_update(&t);
    }
}

fn cancel_requested(core: &Core, id: &str) -> bool {
    core.tasks.lock().unwrap().get(id).is_some_and(|e| e.cancel)
}

async fn finish(core: &Arc<Core>, id: &str, status: TaskStatus, error: Option<String>) {
    // Refresh the cache before reporting the end so list_models is current.
    if let Err(e) = refresh_status(core).await {
        eprintln!("[tasks] status refresh after task failed: {e}");
    }
    let done = {
        let mut tasks = core.tasks.lock().unwrap();
        tasks.remove(id).map(|mut e| {
            e.task.status = status;
            e.task.error = error;
            e.task
        })
    };
    if let Some(t) = done {
        core.sink.task_update(&t);
    }
}

async fn run_task(
    core: Arc<Core>,
    id: String,
    client: RunpodClient,
    input: Value,
    timeout_ms: u64,
    on_done: OnDone,
) {
    let rp_id = match client.run(input, timeout_ms).await {
        Ok(r) => r,
        Err(e) => {
            let t = core.tasks.lock().unwrap().remove(&id).map(|mut x| {
                x.task.status = TaskStatus::Failed;
                x.task.error = Some(e);
                x.task
            });
            if let Some(t) = t {
                core.sink.task_update(&t);
            }
            return;
        }
    };
    let mut errors = 0;
    loop {
        tokio::time::sleep(core.cfg.poll_interval).await;
        if cancel_requested(&core, &id) {
            let _ = client.cancel(&rp_id).await;
            finish(&core, &id, TaskStatus::Cancelled, None).await;
            return;
        }
        let s = match client.status(&rp_id).await {
            Ok(s) => {
                errors = 0;
                s
            }
            Err(e) => {
                errors += 1;
                if errors >= 30 {
                    finish(&core, &id, TaskStatus::Failed, Some(e)).await;
                    return;
                }
                continue;
            }
        };
        match s.status {
            RunStatus::InQueue => update(&core, &id, |t| t.status = TaskStatus::Queued),
            RunStatus::InProgress | RunStatus::Unknown => {
                let p = s.output.as_ref().and_then(parse_progress);
                update(&core, &id, |t| {
                    t.status = TaskStatus::Running;
                    if let Some(p) = p {
                        if let Some(b) = p.bytes {
                            t.bytes = b;
                        }
                        if let Some(tb) = p.total_bytes {
                            t.total_bytes = tb;
                        }
                        if p.file.is_some() {
                            t.file = p.file;
                        }
                    }
                });
            }
            RunStatus::Completed => {
                if let OnDone::RemoveLora(lid) = &on_done {
                    if let Err(e) = core.db.lock().unwrap().delete_lora(lid) {
                        eprintln!("[tasks] could not remove LoRA record: {e}");
                    }
                }
                update(&core, &id, |t| t.bytes = t.total_bytes);
                finish(&core, &id, TaskStatus::Completed, None).await;
                return;
            }
            RunStatus::Cancelled => {
                finish(&core, &id, TaskStatus::Cancelled, None).await;
                return;
            }
            RunStatus::Failed | RunStatus::TimedOut => {
                finish(&core, &id, TaskStatus::Failed, Some(failure_message(&s))).await;
                return;
            }
        }
    }
}
