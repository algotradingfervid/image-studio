//! Generation job manager: one RunPod job per image (seeds seed..seed+n-1),
//! polled every `poll_interval`, images decoded into `images/`, `job-update` emitted.

use crate::db::{ImageRecord, LoraRef, RunpodTimes};
use crate::runpod::{
    failure_message, parse_progress, RunStatus, RunpodClient, GENERATE_TIMEOUT_MS,
};
use crate::state::{now_rfc3339, Core};
use crate::status::{has_cache, lora_folder, present_set};
use base64::Engine;
use rand::Rng;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::sync::Arc;

/// ComfyUI accepts seeds up to 2^64-1, but JS numbers are only exact up to
/// 2^53-1, so seeds are limited to that. Random seeds use the u32 range.
pub const MAX_SEED: u64 = (1u64 << 53) - 1;
pub const MAX_COUNT: u32 = 4;
pub const MAX_LORAS: usize = 3;

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum JobState {
    Queued,
    Starting,
    Running,
    Completed,
    Failed,
    Cancelled,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct JobProgress {
    pub phase: Option<String>,
    pub step: Option<u64>,
    pub total_steps: Option<u64>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Job {
    pub job_id: String,
    pub status: JobState,
    pub total: u32,
    pub completed: u32,
    pub progress: Option<JobProgress>,
    pub images: Vec<ImageRecord>,
    pub error: Option<String>,
}

pub struct JobEntry {
    pub job: Job,
    pub cancel: bool,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LoraChoice {
    pub lora_id: String,
    pub strength: f64,
}

#[derive(Debug, Clone, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct GenerateRequest {
    pub model: String,
    pub prompt: String,
    pub negative_prompt: Option<String>,
    pub aspect_ratio: String,
    pub count: u32,
    pub seed: Option<u64>,
    pub steps: Option<u32>,
    pub cfg: Option<f64>,
    #[serde(default)]
    pub reference_ids: Vec<String>,
    #[serde(default)]
    pub loras: Vec<LoraChoice>,
}

/// Seeds for `count` images: `seed, seed+1, …`; random u32-range seed when None.
pub fn expand_seeds(seed: Option<u64>, count: u32) -> Result<Vec<u64>, String> {
    let base = seed.unwrap_or_else(|| rand::thread_rng().gen_range(0..=u32::MAX as u64));
    if base > MAX_SEED || base + count.saturating_sub(1) as u64 > MAX_SEED {
        return Err(format!("Seed must be between 0 and {MAX_SEED}"));
    }
    Ok((0..count as u64).map(|i| base + i).collect())
}

/// Everything resolved for the per-image `generate` inputs.
struct Plan {
    template: Value,
    seeds: Vec<u64>,
    record: ImageRecord, // template record; id/path/seed/times filled per image
}

fn build_plan(core: &Core, req: &GenerateRequest) -> Result<Plan, String> {
    let model = core.registry.require_model(&req.model)?;
    let prompt = req.prompt.trim();
    if prompt.is_empty() {
        return Err("Enter a prompt first".into());
    }
    let (width, height) = core.registry.aspect(&req.aspect_ratio)?;
    if req.count == 0 || req.count > MAX_COUNT {
        return Err(format!("Count must be between 1 and {MAX_COUNT}"));
    }
    let steps = req.steps.unwrap_or(model.defaults.steps);
    if steps == 0 || steps > 200 {
        return Err("Set the number of steps (1–200) in Advanced".into());
    }
    let cfg = req.cfg.unwrap_or(model.defaults.cfg);
    if !(cfg > 0.0 && cfg <= 30.0) {
        return Err("Set CFG (greater than 0, at most 30) in Advanced".into());
    }
    let negative = if model.supports_negative_prompt {
        req.negative_prompt
            .clone()
            .unwrap_or_else(|| model.defaults.negative_prompt.clone())
    } else {
        String::new()
    };
    if req.reference_ids.len() > model.max_references as usize {
        return Err(if model.max_references == 0 {
            format!("{} does not take reference images", model.name)
        } else {
            format!(
                "{} takes at most {} reference images",
                model.name, model.max_references
            )
        });
    }
    if req.loras.len() > MAX_LORAS {
        return Err(format!("At most {MAX_LORAS} LoRAs per generation"));
    }

    let present = present_set(core);
    if has_cache(core) {
        let missing: Vec<&str> = model
            .files
            .iter()
            .filter(|f| !present.contains(&(f.folder.clone(), f.filename.clone())))
            .map(|f| f.filename.as_str())
            .collect();
        if !missing.is_empty() {
            return Err(format!(
                "{} is not installed (missing {}). Download it on the Models tab, or Refresh if it was just installed.",
                model.name,
                missing.join(", ")
            ));
        }
    }

    let mut refs_payload = Vec::new();
    let mut ref_paths = Vec::new();
    for rid in &req.reference_ids {
        let p = crate::references::find(&core.cfg.references_dir(), rid)?;
        let bytes =
            std::fs::read(&p).map_err(|e| format!("Could not read a reference image: {e}"))?;
        refs_payload.push(json!({
            "name": p.file_name().unwrap().to_string_lossy(),
            "base64": base64::engine::general_purpose::STANDARD.encode(bytes),
        }));
        ref_paths.push(p.to_string_lossy().into_owned());
    }

    let mut loras_payload = Vec::new();
    let mut lora_refs = Vec::new();
    {
        let db = core.db.lock().unwrap();
        for c in &req.loras {
            let l = db
                .get_lora(&c.lora_id)?
                .ok_or("A selected LoRA no longer exists")?;
            if l.model_id != model.id {
                return Err(format!("LoRA \"{}\" is for a different model", l.name));
            }
            if !(0.0..=2.0).contains(&c.strength) {
                return Err("LoRA strength must be between 0 and 2".into());
            }
            if !present.contains(&(lora_folder(&l.model_id), l.filename.clone())) {
                return Err(format!("LoRA \"{}\" is not downloaded yet", l.name));
            }
            loras_payload.push(json!({"filename": l.filename, "strength": c.strength}));
            lora_refs.push(LoraRef {
                name: l.name.clone(),
                strength: c.strength,
            });
        }
    }

    let seeds = expand_seeds(req.seed, req.count)?;
    let template = json!({
        "action": "generate",
        "model": model.id,
        "prompt": prompt,
        "negativePrompt": negative,
        "width": width,
        "height": height,
        "seed": 0,
        "steps": steps,
        "cfg": cfg,
        "references": refs_payload,
        "loras": loras_payload,
    });
    let record = ImageRecord {
        id: String::new(),
        path: String::new(),
        model: model.id.clone(),
        prompt: prompt.to_string(),
        negative_prompt: negative,
        aspect_ratio: req.aspect_ratio.clone(),
        width,
        height,
        seed: 0,
        steps,
        cfg,
        references: ref_paths,
        loras: lora_refs,
        created_at: String::new(),
        duration_ms: None,
        runpod: RunpodTimes::default(),
    };
    Ok(Plan {
        template,
        seeds,
        record,
    })
}

pub fn generate(core: &Arc<Core>, req: GenerateRequest) -> Result<String, String> {
    let plan = build_plan(core, &req)?;
    let client = core.runpod()?;
    let job = Job {
        job_id: uuid::Uuid::new_v4().to_string(),
        status: JobState::Queued,
        total: req.count,
        completed: 0,
        progress: None,
        images: vec![],
        error: None,
    };
    let id = job.job_id.clone();
    core.jobs.lock().unwrap().insert(
        id.clone(),
        JobEntry {
            job: job.clone(),
            cancel: false,
        },
    );
    core.sink.job_update(&job);
    let core2 = core.clone();
    let id2 = id.clone();
    tokio::spawn(async move { run_job(core2, id2, client, plan).await });
    Ok(id)
}

pub fn cancel_job(core: &Core, job_id: &str) -> Result<(), String> {
    let mut jobs = core.jobs.lock().unwrap();
    let e = jobs
        .get_mut(job_id)
        .ok_or("That job has already finished")?;
    e.cancel = true;
    Ok(())
}

/// Active (unfinished) jobs, e.g. for a UI that remounts.
pub fn active_jobs(core: &Core) -> Vec<Job> {
    core.jobs
        .lock()
        .unwrap()
        .values()
        .map(|e| e.job.clone())
        .collect()
}

struct Sub {
    seed: u64,
    rp_id: Option<String>,
    state: RunStatus,
    progress: Option<JobProgress>,
    errors: u32,
    error: Option<String>,
}

fn update(core: &Core, id: &str, f: impl FnOnce(&mut Job)) {
    let snapshot = {
        let mut jobs = core.jobs.lock().unwrap();
        let Some(e) = jobs.get_mut(id) else { return };
        let before = e.job.clone();
        f(&mut e.job);
        (e.job != before).then(|| e.job.clone())
    };
    if let Some(j) = snapshot {
        core.sink.job_update(&j);
    }
}

fn finish(core: &Core, id: &str, status: JobState, error: Option<String>) {
    let done = core.jobs.lock().unwrap().remove(id).map(|mut e| {
        e.job.status = status;
        e.job.error = error;
        e.job.progress = None;
        e.job
    });
    if let Some(j) = done {
        core.sink.job_update(&j);
    }
}

fn cancel_requested(core: &Core, id: &str) -> bool {
    core.jobs.lock().unwrap().get(id).is_some_and(|e| e.cancel)
}

/// Decode the `generate` output into a PNG file and an ImageRecord.
fn save_image(
    core: &Core,
    plan: &Plan,
    sub: &Sub,
    s: &crate::runpod::JobStatus,
) -> Result<ImageRecord, String> {
    let out = s.output.as_ref().ok_or("The worker returned no output")?;
    let img = out.get("image").ok_or("The worker returned no image")?;
    let b64 = img
        .get("base64")
        .and_then(Value::as_str)
        .ok_or("The worker returned no image data")?;
    let b64 = b64.split_once(";base64,").map(|(_, d)| d).unwrap_or(b64);
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(b64.trim())
        .map_err(|_| "The worker returned invalid image data".to_string())?;
    let id = uuid::Uuid::new_v4().to_string();
    let ext = match image::guess_format(&bytes) {
        Ok(image::ImageFormat::Jpeg) => "jpg",
        Ok(image::ImageFormat::WebP) => "webp",
        _ => "png",
    };
    let path = core.cfg.images_dir().join(format!("{id}.{ext}"));
    std::fs::write(&path, &bytes).map_err(|e| format!("Could not save the image: {e}"))?;
    let mut rec = plan.record.clone();
    rec.id = id;
    rec.path = path.to_string_lossy().into_owned();
    rec.seed = img.get("seed").and_then(Value::as_u64).unwrap_or(sub.seed);
    if let Some(w) = img.get("width").and_then(Value::as_u64) {
        rec.width = w as u32;
    }
    if let Some(h) = img.get("height").and_then(Value::as_u64) {
        rec.height = h as u32;
    }
    rec.created_at = now_rfc3339();
    rec.duration_ms = out
        .pointer("/timings/totalMs")
        .and_then(Value::as_u64)
        .or(s.execution_time_ms);
    rec.runpod = RunpodTimes {
        delay_ms: s.delay_time_ms,
        execution_ms: s.execution_time_ms,
    };
    core.db.lock().unwrap().insert_image(&rec)?;
    Ok(rec)
}

async fn cancel_all(client: &RunpodClient, subs: &[Sub]) {
    for s in subs.iter().filter(|s| !s.state.is_terminal()) {
        if let Some(id) = &s.rp_id {
            let _ = client.cancel(id).await;
        }
    }
}

async fn run_job(core: Arc<Core>, id: String, client: RunpodClient, plan: Plan) {
    let mut subs: Vec<Sub> = plan
        .seeds
        .iter()
        .map(|&seed| Sub {
            seed,
            rp_id: None,
            state: RunStatus::InQueue,
            progress: None,
            errors: 0,
            error: None,
        })
        .collect();

    // Submit one RunPod job per image.
    for i in 0..subs.len() {
        if cancel_requested(&core, &id) {
            cancel_all(&client, &subs).await;
            finish(&core, &id, JobState::Cancelled, None);
            return;
        }
        let mut input = plan.template.clone();
        input["seed"] = json!(subs[i].seed);
        match client.run(input, GENERATE_TIMEOUT_MS).await {
            Ok(rp) => subs[i].rp_id = Some(rp),
            Err(e) => {
                if i == 0 {
                    finish(&core, &id, JobState::Failed, Some(e));
                    return;
                }
                subs[i].state = RunStatus::Failed;
                subs[i].error = Some(e);
            }
        }
    }

    loop {
        tokio::time::sleep(core.cfg.poll_interval).await;
        if cancel_requested(&core, &id) {
            cancel_all(&client, &subs).await;
            finish(&core, &id, JobState::Cancelled, None);
            return;
        }
        for sub in subs.iter_mut() {
            if sub.state.is_terminal() {
                continue;
            }
            let Some(rp) = sub.rp_id.clone() else {
                continue;
            };
            let s = match client.status(&rp).await {
                Ok(s) => {
                    sub.errors = 0;
                    s
                }
                Err(e) => {
                    sub.errors += 1;
                    if sub.errors >= 30 {
                        sub.state = RunStatus::Failed;
                        sub.error = Some(e);
                    }
                    continue;
                }
            };
            match s.status {
                RunStatus::InProgress | RunStatus::Unknown => {
                    sub.state = RunStatus::InProgress;
                    if let Some(p) = s.output.as_ref().and_then(parse_progress) {
                        sub.progress = Some(JobProgress {
                            phase: p.phase,
                            step: p.step,
                            total_steps: p.total_steps,
                        });
                    }
                }
                RunStatus::InQueue => sub.state = RunStatus::InQueue,
                RunStatus::Completed => {
                    sub.progress = None;
                    match save_image(&core, &plan, sub, &s) {
                        Ok(rec) => {
                            sub.state = RunStatus::Completed;
                            update(&core, &id, |j| {
                                j.completed += 1;
                                j.images.push(rec);
                            });
                        }
                        Err(e) => {
                            sub.state = RunStatus::Failed;
                            sub.error = Some(e);
                        }
                    }
                }
                other => {
                    sub.state = other;
                    sub.progress = None;
                    if other != RunStatus::Cancelled {
                        sub.error = Some(failure_message(&s));
                    }
                }
            }
        }

        if subs.iter().all(|s| s.state.is_terminal()) {
            let failed: Vec<&Sub> = subs.iter().filter(|s| s.error.is_some()).collect();
            if let Some(first) = failed.first() {
                let msg = first.error.clone().unwrap_or_default();
                let msg = if subs.len() > 1 {
                    format!("{} of {} images failed: {msg}", failed.len(), subs.len())
                } else {
                    msg
                };
                finish(&core, &id, JobState::Failed, Some(msg));
            } else if subs.iter().any(|s| s.state == RunStatus::Cancelled) {
                finish(&core, &id, JobState::Cancelled, None);
            } else {
                finish(&core, &id, JobState::Completed, None);
            }
            return;
        }

        let running = subs.iter().find(|s| s.state == RunStatus::InProgress);
        let (state, progress) = match running {
            Some(s) => (JobState::Running, s.progress.clone()),
            None => (JobState::Starting, None),
        };
        update(&core, &id, |j| {
            j.status = state;
            j.progress = progress;
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn seed_expansion() {
        assert_eq!(expand_seeds(Some(10), 3).unwrap(), vec![10, 11, 12]);
        assert_eq!(expand_seeds(Some(0), 1).unwrap(), vec![0]);
        let r = expand_seeds(None, 4).unwrap();
        assert!(r[0] <= u32::MAX as u64);
        assert_eq!(r, vec![r[0], r[0] + 1, r[0] + 2, r[0] + 3]);
        assert!(expand_seeds(Some(MAX_SEED), 2).is_err());
        assert!(expand_seeds(Some(MAX_SEED), 1).is_ok());
        assert!(expand_seeds(Some(u64::MAX), 1).is_err());
    }
}
