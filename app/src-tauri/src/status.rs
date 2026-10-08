//! Model status cache (worker `status` action), and the Model/LoRA views
//! built from the registry + cache + active tasks.

use crate::db::{LoraRow, StatusSnapshot, Volume};
use crate::delete_rule::FileKey;
use crate::registry::Model;
use crate::runpod::{failure_message, RunStatus, RunpodClient, GENERATE_TIMEOUT_MS};
use crate::state::{now_rfc3339, Core};
use crate::tasks::{TargetType, Task};
use serde::Serialize;
use serde_json::{json, Value};
use std::collections::HashSet;
use std::sync::Arc;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StatusView {
    pub models: Vec<Value>,
    pub volume: Option<Volume>,
    pub checked_at: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LoraView {
    pub id: String,
    pub name: String,
    pub model_id: String,
    pub source: String,
    pub source_url: String,
    pub filename: String,
    pub size_bytes: Option<u64>,
    pub trigger_words: Vec<String>,
    pub present: bool,
    pub task: Option<Task>,
}

pub fn lora_folder(model_id: &str) -> String {
    format!("loras/{model_id}")
}

/// Files on the volume according to the cache (empty if never checked).
pub fn present_set(core: &Core) -> HashSet<FileKey> {
    core.db
        .lock()
        .unwrap()
        .load_status()
        .ok()
        .flatten()
        .map(|(s, _)| {
            s.files
                .into_iter()
                .map(|f| (f.folder, f.filename))
                .collect()
        })
        .unwrap_or_default()
}

pub fn has_cache(core: &Core) -> bool {
    matches!(core.db.lock().unwrap().load_status(), Ok(Some(_)))
}

pub fn model_view(core: &Core, m: &Model, present: &HashSet<FileKey>) -> Value {
    let mut v = serde_json::to_value(m).expect("model serialises");
    let files: Vec<Value> = m
        .files
        .iter()
        .map(|f| {
            let mut fv = serde_json::to_value(f).unwrap();
            let is_present = present.contains(&(f.folder.clone(), f.filename.clone()));
            fv["present"] = json!(is_present);
            fv["sharedWith"] = json!(core.registry.shared_with(&m.id, &f.folder, &f.filename));
            fv
        })
        .collect();
    let present_bytes: u64 = m
        .files
        .iter()
        .filter(|f| present.contains(&(f.folder.clone(), f.filename.clone())))
        .filter_map(|f| f.size_bytes)
        .sum();
    let installed = m
        .files
        .iter()
        .all(|f| present.contains(&(f.folder.clone(), f.filename.clone())));
    v["files"] = json!(files);
    v["installed"] = json!(installed);
    v["presentBytes"] = json!(present_bytes);
    v["totalBytes"] = json!(m.total_bytes());
    v["task"] = json!(crate::tasks::active_task_for(
        core,
        TargetType::Model,
        &m.id
    ));
    v
}

pub fn model_views(core: &Core) -> Vec<Value> {
    let present = present_set(core);
    core.registry
        .models
        .iter()
        .map(|m| model_view(core, m, &present))
        .collect()
}

pub fn lora_view(core: &Core, l: &LoraRow, present: &HashSet<FileKey>) -> LoraView {
    LoraView {
        id: l.id.clone(),
        name: l.name.clone(),
        model_id: l.model_id.clone(),
        source: l.source.clone(),
        source_url: l.source_url.clone(),
        filename: l.filename.clone(),
        size_bytes: l.size_bytes,
        trigger_words: l.trigger_words.clone(),
        present: present.contains(&(lora_folder(&l.model_id), l.filename.clone())),
        task: crate::tasks::active_task_for(core, TargetType::Lora, &l.id),
    }
}

pub fn lora_views(core: &Core) -> Result<Vec<LoraView>, String> {
    let present = present_set(core);
    let rows = core.db.lock().unwrap().list_loras()?;
    Ok(rows.iter().map(|l| lora_view(core, l, &present)).collect())
}

/// Current cached status without contacting RunPod.
pub fn cached_view(core: &Core) -> Result<StatusView, String> {
    let cache = core.db.lock().unwrap().load_status()?;
    Ok(StatusView {
        models: model_views(core),
        volume: cache.as_ref().map(|(s, _)| s.volume.clone()),
        checked_at: cache.map(|(_, at)| at),
    })
}

/// True when the cache is missing or older than 24 h.
pub fn is_stale(checked_at: Option<&str>, now: chrono::DateTime<chrono::Utc>) -> bool {
    match checked_at.and_then(|s| chrono::DateTime::parse_from_rfc3339(s).ok()) {
        Some(t) => now.signed_duration_since(t) > chrono::Duration::hours(24),
        None => true,
    }
}

/// Submit a job and poll it to completion, returning its output.
pub async fn run_to_completion(
    core: &Core,
    client: &RunpodClient,
    input: Value,
    timeout_ms: u64,
) -> Result<Value, String> {
    let id = client.run(input, timeout_ms).await?;
    let mut errors = 0;
    loop {
        tokio::time::sleep(core.cfg.poll_interval).await;
        match client.status(&id).await {
            Ok(s) if s.status == RunStatus::Completed => {
                return s
                    .output
                    .ok_or_else(|| "The worker returned no output".into())
            }
            Ok(s) if s.status.is_terminal() => return Err(failure_message(&s)),
            Ok(_) => errors = 0,
            Err(e) => {
                errors += 1;
                if errors >= 30 {
                    return Err(e);
                }
            }
        }
    }
}

/// Run the worker `status` action and update the cache. Concurrent callers
/// share one request: a caller that waited for an in-flight refresh gets its result.
pub async fn refresh_status(core: &Arc<Core>) -> Result<StatusView, String> {
    let requested_at = now_rfc3339();
    let _guard = core.refresh_lock.lock().await;
    if let Some((_, at)) = core.db.lock().unwrap().load_status()? {
        if at >= requested_at {
            drop(_guard);
            return cached_view(core);
        }
    }
    let client = core.runpod()?;
    let output = run_to_completion(
        core,
        &client,
        json!({"action": "status"}),
        GENERATE_TIMEOUT_MS,
    )
    .await?;
    let snap: StatusSnapshot = serde_json::from_value(output)
        .map_err(|e| format!("The worker returned an unexpected status: {e}"))?;
    let at = now_rfc3339();
    core.db.lock().unwrap().save_status(&snap, &at)?;
    let view = cached_view(core)?;
    core.sink.status_update(&view);
    Ok(view)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn staleness() {
        let now = chrono::Utc::now();
        assert!(is_stale(None, now));
        assert!(is_stale(Some("garbage"), now));
        let recent = (now - chrono::Duration::hours(1)).to_rfc3339();
        assert!(!is_stale(Some(&recent), now));
        let old = (now - chrono::Duration::hours(25)).to_rfc3339();
        assert!(is_stale(Some(&old), now));
    }
}
