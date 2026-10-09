//! Generation job manager: one RunPod job per image (seeds seed..seed+n-1),
//! polled every `poll_interval`, images decoded into `images/`, `job-update` emitted.
//!
//! Video jobs (spec v5, `generate_video`): one pod job per video on the
//! `video` GPU profile; the MP4 and its JPEG poster are decoded into `videos/`
//! and recorded in the same `images` table with `kind = "video"`.

use crate::db::{ImageRecord, LoraRef, RunpodTimes, KIND_IMAGE, KIND_VIDEO};
use crate::pod::Profile;
use crate::runpod::{
    failure_message, parse_progress, Progress, RunStatus, RunpodClient, GENERATE_TIMEOUT_MS,
};
use crate::state::{now_rfc3339, Core};
use crate::status::{has_cache, has_cache_for, lora_folder, present_set, present_set_for};
use crate::vault::{BlobRef, ERR_LOCKED, ERR_NO_VAULT};
use crate::vault_migrate;
use base64::Engine;
use rand::Rng;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::BTreeMap;
use std::sync::Arc;

/// ComfyUI accepts seeds up to 2^64-1, but JS numbers are only exact up to
/// 2^53-1, so seeds are limited to that. Random seeds use the u32 range.
pub const MAX_SEED: u64 = (1u64 << 53) - 1;
pub const MAX_COUNT: u32 = 4;
pub const MAX_LORAS: usize = 3;
/// img2img strength (worker `denoise`): range and default.
pub const MIN_DENOISE: f64 = 0.05;
pub const MAX_DENOISE: f64 = 1.0;
pub const DEFAULT_DENOISE: f64 = 0.6;
/// Execution timeout for one video job (video sampling takes minutes).
pub const VIDEO_TIMEOUT_MS: u64 = 1_800_000;

/// What a job produces; decides the GPU profile it runs on.
#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq, Default)]
#[serde(rename_all = "lowercase")]
pub enum JobKind {
    #[default]
    Image,
    Video,
}

impl JobKind {
    pub fn profile(self) -> Profile {
        match self {
            JobKind::Image => Profile::Image,
            JobKind::Video => Profile::Video,
        }
    }
}

/// Where a job's outputs are saved (spec v6): the general gallery (plaintext
/// files + SQLite) or the encrypted vault.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "lowercase")]
pub enum Destination {
    #[default]
    General,
    Vault,
}

impl Destination {
    pub fn parse(s: Option<&str>) -> Result<Destination, String> {
        match s.map(str::trim) {
            None | Some("") | Some("general") => Ok(Destination::General),
            Some("vault") => Ok(Destination::Vault),
            Some(other) => Err(format!("Unknown destination \"{other}\" (use general or vault)")),
        }
    }
}

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
    /// Worker v2 stage fields, passed through unchanged (absent from v1 workers
    /// and from the pod start phases).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub stage: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub stages: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub elapsed_ms: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub stage_elapsed_ms: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cached: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cached_stages: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub stage_times: Option<BTreeMap<String, u64>>,
    /// Stage `copying_models`: the model files' copy to the pod's local disk.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub copy_percent: Option<f64>,
}

impl JobProgress {
    /// A pod start phase ("Creating pod", ...) shown while the job is starting.
    pub fn pod_phase(phase: &str) -> Self {
        JobProgress {
            phase: Some(phase.to_string()),
            step: None,
            total_steps: None,
            stage: None,
            stages: None,
            elapsed_ms: None,
            stage_elapsed_ms: None,
            cached: None,
            cached_stages: None,
            stage_times: None,
            copy_percent: None,
        }
    }
}

impl From<Progress> for JobProgress {
    fn from(p: Progress) -> Self {
        JobProgress {
            phase: p.phase,
            step: p.step,
            total_steps: p.total_steps,
            stage: p.stage,
            stages: p.stages,
            elapsed_ms: p.elapsed_ms,
            stage_elapsed_ms: p.stage_elapsed_ms,
            cached: p.cached,
            cached_stages: p.cached_stages,
            stage_times: p.stage_times,
            copy_percent: p.copy_percent,
        }
    }
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Job {
    pub job_id: String,
    /// "image" or "video" (additive, spec v5).
    pub kind: JobKind,
    /// "general" or "vault" (spec v6).
    pub destination: Destination,
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
    /// img2img start image: an id from `import_reference(_bytes)`.
    #[serde(default)]
    pub init_image_id: Option<String>,
    /// img2img strength, clamped to 0.05..=1.0 (default 0.6); ignored without a start image.
    #[serde(default)]
    pub denoise: Option<f64>,
    /// img2img start image picked from the general gallery (a record id,
    /// kind "image"); exclusive with the other start-image fields.
    #[serde(default)]
    pub init_image_gallery_id: Option<String>,
    /// img2img start image that is a vault item (needs the unlocked vault and
    /// `destination: vault`).
    #[serde(default)]
    pub init_image_vault_id: Option<String>,
    /// Where the outputs go (spec v6); default general.
    #[serde(default)]
    pub destination: Destination,
}

/// The strength sent with a start image: clamped, default when absent or not finite.
pub fn resolve_denoise(denoise: Option<f64>) -> f64 {
    denoise
        .filter(|d| d.is_finite())
        .unwrap_or(DEFAULT_DENOISE)
        .clamp(MIN_DENOISE, MAX_DENOISE)
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
    kind: JobKind,
    destination: Destination,
    template: Value,
    seeds: Vec<u64>,
    record: ImageRecord, // template record; id/path/seed/times filled per image
    timeout_ms: u64,
}

/// `generate_video` request (spec v5).
#[derive(Debug, Clone, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct VideoRequest {
    pub model: String,
    pub prompt: String,
    #[serde(default)]
    pub negative_prompt: Option<String>,
    /// i2v start image: an id from `import_reference(_bytes)`.
    #[serde(default)]
    pub init_image_id: Option<String>,
    /// i2v start image picked from the gallery: an image record id (kind
    /// "image"). Its file is read in place (not copied); exclusive with
    /// `init_image_id`.
    #[serde(default)]
    pub init_image_gallery_id: Option<String>,
    /// i2v start image that is a vault item (needs the unlocked vault).
    #[serde(default)]
    pub init_image_vault_id: Option<String>,
    pub duration_s: f64,
    pub fps: f64,
    pub resolution: String,
    #[serde(default)]
    pub seed: Option<u64>,
    #[serde(default)]
    pub steps: Option<u32>,
    #[serde(default)]
    pub cfg: Option<f64>,
    #[serde(default)]
    pub audio: bool,
    /// Where the output goes (spec v6); default general.
    #[serde(default)]
    pub destination: Destination,
}

/// A whole number as an integer JSON value, else a float.
fn num(x: f64) -> Value {
    if x.fract() == 0.0 && x.abs() < 1e15 {
        json!(x as i64)
    } else {
        json!(x)
    }
}

/// "1280x720" → (1280, 720).
fn parse_wh(s: &str) -> Option<(u32, u32)> {
    let (w, h) = s.split_once(['x', 'X', '×'])?;
    Some((w.trim().parse().ok()?, h.trim().parse().ok()?))
}

fn b64(bytes: &[u8]) -> String {
    base64::engine::general_purpose::STANDARD.encode(bytes)
}

/// Vault jobs need a vault to seal into (not necessarily unlocked).
fn check_destination(core: &Core, dest: Destination) -> Result<(), String> {
    if dest == Destination::Vault && !core.vault.exists() {
        return Err(format!("{ERR_NO_VAULT}: Create the vault first (Gallery → Vault)"));
    }
    Ok(())
}

/// Worker payload + the path recorded for one imported reference or start
/// image. `vault:` ids need the unlocked vault and a vault job; plain ids are
/// read from `references/` and, for a vault job, moved into the vault.
fn load_reference(
    core: &Core,
    id: &str,
    dest: Destination,
    what: &str,
) -> Result<(Value, String), String> {
    if let Some(b) = BlobRef::parse(id) {
        if dest != Destination::Vault {
            return Err(format!(
                "A {what} from the vault can only be used when saving to the vault"
            ));
        }
        let bytes = core
            .vault
            .open_blob(&b.id)
            .map_err(|_| format!("{ERR_LOCKED}: Unlock the vault to use that {what}"))?;
        let payload = json!({
            "name": format!("{}.{}", b.id, b.ext),
            "base64": b64(&bytes),
        });
        return Ok((payload, b.path()));
    }
    let p = crate::references::find(&core.cfg.references_dir(), id)
        .map_err(|_| format!("The {what} is missing; please add it again"))?;
    let bytes = std::fs::read(&p).map_err(|e| format!("Could not read the {what}: {e}"))?;
    let payload = json!({
        "name": p.file_name().unwrap().to_string_lossy(),
        "base64": b64(&bytes),
    });
    let path = if dest == Destination::Vault {
        vault_migrate::seal_plain_reference(core, id)?.ref_id
    } else {
        p.to_string_lossy().into_owned()
    };
    Ok((payload, path))
}

/// A gallery image (general or vault) as the start image: read in place,
/// downscaled in memory to ≤1 MP like imported references. For a vault job a
/// general image is also sealed into the vault so the item is self-contained.
fn gallery_start_image(
    core: &Core,
    image_id: &str,
    dest: Destination,
) -> Result<(Value, String), String> {
    let general = core.db.lock().unwrap().get_image(image_id)?;
    if let Some(rec) = general {
        if rec.kind != KIND_IMAGE {
            return Err("Pick an image (not a video) as the start image".into());
        }
        let bytes = std::fs::read(&rec.path)
            .map_err(|e| format!("Could not read the gallery image: {e}"))?;
        let (out, ext) = crate::references::process(&bytes)?;
        let payload = json!({"name": format!("{}.{ext}", rec.id), "base64": b64(&out)});
        let path = if dest == Destination::Vault {
            vault_migrate::seal_verified(core, &out, ext)?.path()
        } else {
            rec.path
        };
        return Ok((payload, path));
    }
    vault_start_image(core, image_id, dest)
}

/// A vault item as the start image: decrypted in memory, downscaled, and
/// referenced in place by the new vault item.
fn vault_start_image(core: &Core, item_id: &str, dest: Destination) -> Result<(Value, String), String> {
    if !core.vault.is_unlocked() {
        return Err(if core.vault.exists() {
            format!("{ERR_LOCKED}: Unlock the vault to use that start image")
        } else {
            "That gallery image no longer exists".into()
        });
    }
    let item = core
        .vault
        .item(item_id)
        .map_err(|_| "That gallery image no longer exists".to_string())?;
    if dest != Destination::Vault {
        return Err("A start image from the vault can only be used when saving to the vault".into());
    }
    if item.kind != KIND_IMAGE {
        return Err("Pick an image (not a video) as the start image".into());
    }
    let bytes = core.vault.open_blob(&item.media.id)?;
    let (out, ext) = crate::references::process(&bytes)?;
    let payload = json!({"name": format!("{}.{ext}", item.id), "base64": b64(&out)});
    Ok((payload, item.media.path()))
}

/// The start image of a request: an imported id, a general gallery record
/// id, or a vault item id (at most one of them).
fn load_start_image(
    core: &Core,
    init_image_id: Option<&str>,
    gallery_id: Option<&str>,
    vault_id: Option<&str>,
    dest: Destination,
) -> Result<Option<(Value, String)>, String> {
    let given = [init_image_id, gallery_id, vault_id].iter().flatten().count();
    if given > 1 {
        return Err("Choose one start image".into());
    }
    match (init_image_id, gallery_id, vault_id) {
        (Some(id), _, _) => load_reference(core, id, dest, "start image").map(Some),
        (_, Some(gid), _) => gallery_start_image(core, gid, dest).map(Some),
        (_, _, Some(vid)) => vault_start_image(core, vid, dest).map(Some),
        _ => Ok(None),
    }
}

fn build_video_plan(core: &Core, req: &VideoRequest) -> Result<Plan, String> {
    let model = core.registry.require_video_model(&req.model)?;
    let prompt = req.prompt.trim();
    if prompt.is_empty() {
        return Err("Enter a prompt first".into());
    }
    check_destination(core, req.destination)?;
    let has_init = req.init_image_id.is_some()
        || req.init_image_gallery_id.is_some()
        || req.init_image_vault_id.is_some();
    let mode = if has_init { "i2v" } else { "t2v" };
    if !model.has_mode(mode) {
        return Err(if mode == "i2v" {
            format!("{} does not take a start image", model.name)
        } else {
            format!("{} needs a start image", model.name)
        });
    }
    let limits = model.limits.clone();
    if !(req.duration_s.is_finite() && req.duration_s > 0.0) {
        return Err("Choose a duration".into());
    }
    if let Some(max) = limits.as_ref().and_then(|l| l.max_duration_s) {
        if req.duration_s > max + 1e-9 {
            return Err(format!("{} makes at most {max} s per video", model.name));
        }
    }
    if let Some(min) = limits.as_ref().and_then(|l| l.min_duration_s) {
        if req.duration_s < min - 1e-9 {
            return Err(format!("{} makes at least {min} s per video", model.name));
        }
    }
    if !(req.fps.is_finite() && req.fps > 0.0) {
        return Err("Choose a frame rate".into());
    }
    if let Some(l) = limits.as_ref().filter(|l| !l.fps_options.is_empty()) {
        if !l.fps_options.iter().any(|f| (f - req.fps).abs() < 1e-6) {
            return Err(format!("{} does not support {} fps", model.name, req.fps));
        }
    }
    let resolution = req.resolution.trim().to_string();
    if resolution.is_empty() {
        return Err("Choose a resolution".into());
    }
    if let Some(l) = limits.as_ref().filter(|l| !l.resolutions.is_empty()) {
        let ids: Vec<String> = l
            .resolutions
            .iter()
            .filter_map(crate::registry::resolution_id)
            .collect();
        if !ids.contains(&resolution) {
            return Err(format!(
                "{} does not support the resolution {resolution} (choose {})",
                model.name,
                ids.join(", ")
            ));
        }
    }
    if req.audio && model.audio != Some(true) {
        return Err(format!("{} does not generate audio", model.name));
    }
    let steps = req
        .steps
        .or(Some(model.defaults.steps).filter(|s| *s > 0));
    if let Some(s) = steps {
        if s == 0 || s > 200 {
            return Err("Set the number of steps (1–200) in Advanced".into());
        }
    }
    let cfg = req.cfg.or(Some(model.defaults.cfg).filter(|c| *c > 0.0));
    if let Some(c) = cfg {
        if !(c > 0.0 && c <= 30.0) {
            return Err("Set CFG (greater than 0, at most 30) in Advanced".into());
        }
    }
    let negative = req
        .negative_prompt
        .clone()
        .unwrap_or_else(|| model.defaults.negative_prompt.clone());

    let profile = Profile::Video;
    if has_cache_for(core, profile) {
        let present = present_set_for(core, profile);
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

    let init = load_start_image(
        core,
        req.init_image_id.as_deref(),
        req.init_image_gallery_id.as_deref(),
        req.init_image_vault_id.as_deref(),
        req.destination,
    )?;

    let seeds = expand_seeds(req.seed, 1)?;
    let mut template = json!({
        "action": "generate_video",
        "model": model.id,
        "prompt": prompt,
        "durationS": num(req.duration_s),
        "fps": num(req.fps),
        "resolution": resolution,
        "seed": 0,
        "audio": req.audio,
    });
    if !negative.trim().is_empty() {
        template["negativePrompt"] = json!(negative);
    }
    if let Some(s) = steps {
        template["steps"] = json!(s);
    }
    if let Some(c) = cfg {
        template["cfg"] = json!(c);
    }
    if let Some((payload, _)) = &init {
        template["initImage"] = payload.clone();
    }
    let (width, height) = parse_wh(&resolution).unwrap_or((0, 0));
    let record = ImageRecord {
        id: String::new(),
        path: String::new(),
        model: model.id.clone(),
        prompt: prompt.to_string(),
        negative_prompt: negative,
        aspect_ratio: resolution,
        width,
        height,
        seed: 0,
        steps: steps.unwrap_or(0),
        cfg: cfg.unwrap_or(0.0),
        references: vec![],
        loras: vec![],
        created_at: String::new(),
        duration_ms: None,
        runpod: RunpodTimes::default(),
        init_image: init.map(|(_, path)| path),
        denoise: None,
        kind: KIND_VIDEO.into(),
        duration_s: Some(req.duration_s),
        fps: Some(req.fps),
        has_audio: Some(req.audio),
        poster_path: None,
        vault: false,
        thumb_path: None,
    };
    Ok(Plan {
        kind: JobKind::Video,
        destination: req.destination,
        template,
        seeds,
        record,
        timeout_ms: VIDEO_TIMEOUT_MS,
    })
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
    if (req.init_image_id.is_some()
        || req.init_image_gallery_id.is_some()
        || req.init_image_vault_id.is_some())
        && !model.supports_img2img
    {
        return Err(format!("{} does not take a start image", model.name));
    }
    check_destination(core, req.destination)?;

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
        let (payload, path) = load_reference(core, rid, req.destination, "reference image")?;
        refs_payload.push(payload);
        ref_paths.push(path);
    }

    // img2img: the start image goes through the same import pipeline as references.
    let init = load_start_image(
        core,
        req.init_image_id.as_deref(),
        req.init_image_gallery_id.as_deref(),
        req.init_image_vault_id.as_deref(),
        req.destination,
    )?
    .map(|(payload, path)| (payload, path, resolve_denoise(req.denoise)));

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
    let mut template = json!({
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
    if let Some((payload, _, denoise)) = &init {
        // The worker sizes the output from the start image (width/height ignored).
        template["initImage"] = payload.clone();
        template["denoise"] = json!(denoise);
    }
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
        init_image: init.as_ref().map(|(_, path, _)| path.clone()),
        denoise: init.as_ref().map(|(_, _, d)| *d),
        kind: KIND_IMAGE.into(),
        duration_s: None,
        fps: None,
        has_audio: None,
        poster_path: None,
        vault: false,
        thumb_path: None,
    };
    Ok(Plan {
        kind: JobKind::Image,
        destination: req.destination,
        template,
        seeds,
        record,
        timeout_ms: GENERATE_TIMEOUT_MS,
    })
}

pub fn generate(core: &Arc<Core>, req: GenerateRequest) -> Result<String, String> {
    let plan = build_plan(core, &req)?;
    start_job(core, plan)
}

/// Queues one video job on the `video` GPU profile (started when stopped).
pub fn generate_video(core: &Arc<Core>, req: VideoRequest) -> Result<String, String> {
    let plan = build_video_plan(core, &req)?;
    start_job(core, plan)
}

fn start_job(core: &Arc<Core>, plan: Plan) -> Result<String, String> {
    let profile = plan.kind.profile();
    crate::worker::precheck_for(core, profile)?;
    // Before any pod start: the next pod prefetches this model to local disk.
    crate::pod::record_last_model(core, profile, &plan.record.model);
    let job = Job {
        job_id: uuid::Uuid::new_v4().to_string(),
        kind: plan.kind,
        destination: plan.destination,
        status: JobState::Queued,
        total: plan.seeds.len() as u32,
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
    tokio::spawn(async move {
        // With the pod backend this starts the GPU when stopped; the job shows
        // "starting" with the pod phase as progress.phase meanwhile.
        let client = {
            let (c, i) = (core2.clone(), id2.clone());
            let mut on_phase = move |phase: &str| {
                update(&c, &i, |j| {
                    j.status = JobState::Starting;
                    j.progress = Some(JobProgress::pod_phase(phase));
                })
            };
            let (c, i) = (core2.clone(), id2.clone());
            let cancelled = move || cancel_requested(&c, &i);
            crate::worker::client_for(&core2, profile, &mut on_phase, &cancelled).await
        };
        match client {
            Ok(client) => run_job(core2, id2, client, plan).await,
            Err(_) if cancel_requested(&core2, &id2) => {
                finish(&core2, &id2, JobState::Cancelled, None)
            }
            Err(e) => finish(&core2, &id2, JobState::Failed, Some(e)),
        }
    });
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
    let kind = core.jobs.lock().unwrap().get(id).map(|e| e.job.kind);
    crate::pod::touch_for(core, kind.unwrap_or_default().profile());
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

fn decode_b64(b64: &str) -> Option<Vec<u8>> {
    let b64 = b64.split_once(";base64,").map(|(_, d)| d).unwrap_or(b64);
    base64::engine::general_purpose::STANDARD.decode(b64.trim()).ok()
}

/// An ISO-BMFF (MP4) file starts with a box whose type is `ftyp`.
fn looks_like_mp4(bytes: &[u8]) -> bool {
    bytes.len() > 12 && &bytes[4..8] == b"ftyp"
}

/// Decode the `generate_video` output: the MP4 into `videos/<id>.mp4`, the
/// poster into `videos/<id>.jpg`, and a `kind = "video"` record — or, for a
/// vault job, sealed into the vault straight from memory.
fn save_video(
    core: &Core,
    plan: &Plan,
    sub: &Sub,
    s: &crate::runpod::JobStatus,
) -> Result<ImageRecord, String> {
    let out = s.output.as_ref().ok_or("The worker returned no output")?;
    let video = out.get("video").ok_or("The worker returned no video")?;
    let bytes = video
        .get("base64")
        .and_then(Value::as_str)
        .and_then(decode_b64)
        .ok_or("The worker returned invalid video data")?;
    if !looks_like_mp4(&bytes) {
        return Err("The worker returned a file that is not an MP4 video".into());
    }
    let poster = out
        .pointer("/poster/base64")
        .and_then(Value::as_str)
        .and_then(decode_b64);
    let mut rec = plan.record.clone();
    rec.seed = video
        .get("seed")
        .or_else(|| out.get("seed"))
        .and_then(Value::as_u64)
        .unwrap_or(sub.seed);
    if let Some(w) = video.get("width").and_then(Value::as_u64) {
        rec.width = w as u32;
    }
    if let Some(h) = video.get("height").and_then(Value::as_u64) {
        rec.height = h as u32;
    }
    if let Some(f) = video.get("fps").and_then(Value::as_f64) {
        rec.fps = Some(f);
    }
    if let Some(d) = video.get("durationS").and_then(Value::as_f64) {
        rec.duration_s = Some(d);
    }
    if let Some(a) = video.get("hasAudio").and_then(Value::as_bool) {
        rec.has_audio = Some(a);
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
    if plan.destination == Destination::Vault {
        // Encrypted the moment it arrives; the plaintext never touches disk.
        return vault_migrate::seal_output(core, &rec, &bytes, poster.as_deref());
    }
    let id = uuid::Uuid::new_v4().to_string();
    let dir = core.cfg.videos_dir();
    std::fs::create_dir_all(&dir).map_err(|e| format!("Could not save the video: {e}"))?;
    let path = dir.join(format!("{id}.mp4"));
    std::fs::write(&path, &bytes).map_err(|e| format!("Could not save the video: {e}"))?;
    let poster_path = poster.and_then(|b| {
        let ext = match image::guess_format(&b) {
            Ok(image::ImageFormat::Png) => "png",
            Ok(image::ImageFormat::WebP) => "webp",
            _ => "jpg",
        };
        let p = dir.join(format!("{id}.{ext}"));
        match std::fs::write(&p, &b) {
            Ok(()) => Some(p.to_string_lossy().into_owned()),
            Err(e) => {
                eprintln!("[jobs] could not save the video poster: {e}");
                None
            }
        }
    });
    rec.id = id;
    rec.path = path.to_string_lossy().into_owned();
    rec.poster_path = poster_path;
    core.db.lock().unwrap().insert_image(&rec)?;
    Ok(rec)
}

fn save_output(
    core: &Core,
    plan: &Plan,
    sub: &Sub,
    s: &crate::runpod::JobStatus,
) -> Result<ImageRecord, String> {
    match plan.kind {
        JobKind::Image => save_image(core, plan, sub, s),
        JobKind::Video => save_video(core, plan, sub, s),
    }
}

/// Decode the `generate` output into a PNG file and an ImageRecord — or, for
/// a vault job, seal it into the vault straight from memory.
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
    let mut rec = plan.record.clone();
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
    if plan.destination == Destination::Vault {
        return vault_migrate::seal_output(core, &rec, &bytes, None);
    }
    let id = uuid::Uuid::new_v4().to_string();
    let ext = match image::guess_format(&bytes) {
        Ok(image::ImageFormat::Jpeg) => "jpg",
        Ok(image::ImageFormat::WebP) => "webp",
        _ => "png",
    };
    let path = core.cfg.images_dir().join(format!("{id}.{ext}"));
    std::fs::write(&path, &bytes).map_err(|e| format!("Could not save the image: {e}"))?;
    rec.id = id;
    rec.path = path.to_string_lossy().into_owned();
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
        match client.run(input, plan.timeout_ms).await {
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
                        sub.progress = Some(JobProgress::from(p));
                    }
                }
                RunStatus::InQueue => sub.state = RunStatus::InQueue,
                RunStatus::Completed => {
                    sub.progress = None;
                    match save_output(&core, &plan, sub, &s) {
                        Ok(rec) => {
                            sub.state = RunStatus::Completed;
                            // A vault output sealed while the vault is locked is
                            // only counted: no path, prompt or id leaves the vault
                            // until `list_vault_items` after an unlock.
                            let redact = plan.destination == Destination::Vault
                                && !core.vault.is_unlocked();
                            update(&core, &id, |j| {
                                j.completed += 1;
                                if !redact {
                                    j.images.push(rec);
                                }
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

    #[test]
    fn destination_parsing() {
        assert_eq!(Destination::parse(None).unwrap(), Destination::General);
        assert_eq!(Destination::parse(Some("")).unwrap(), Destination::General);
        assert_eq!(Destination::parse(Some("general")).unwrap(), Destination::General);
        assert_eq!(Destination::parse(Some(" vault ")).unwrap(), Destination::Vault);
        assert!(Destination::parse(Some("cloud")).is_err());
        assert_eq!(serde_json::to_value(Destination::Vault).unwrap(), "vault");
    }

    #[test]
    fn denoise_resolution() {
        assert_eq!(resolve_denoise(None), DEFAULT_DENOISE);
        assert_eq!(resolve_denoise(Some(0.35)), 0.35);
        assert_eq!(resolve_denoise(Some(0.0)), MIN_DENOISE);
        assert_eq!(resolve_denoise(Some(-3.0)), MIN_DENOISE);
        assert_eq!(resolve_denoise(Some(1.7)), MAX_DENOISE);
        assert_eq!(resolve_denoise(Some(f64::NAN)), DEFAULT_DENOISE);
    }
}
