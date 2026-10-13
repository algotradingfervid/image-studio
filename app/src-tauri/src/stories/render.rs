//! Shot and story rendering: queues video jobs and links takes to shots.

use super::{
    compile::compile_shot, ffmpeg, planner, resolution_for, resolve_llm_model, store,
    validate::{preflight, validate},
    Character, Issue, Shot, Story, StoryView,
};
use crate::db::{ImageRecord, KIND_VIDEO};
use crate::jobs::{self, Destination, VideoRequest};
use crate::state::Core;
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;

const VIDEO_MODEL: &str = "h3ref";
const FPS: f64 = 24.0;

fn cast_of(core: &Core, ids: &[String]) -> Result<Vec<Character>, String> {
    let db = core.db.lock().unwrap();
    ids.iter()
        .map(|id| store::get_character(&db, id)?.ok_or_else(|| "A cast character no longer exists".to_string()))
        .collect()
}

/// The story with its cast (cast order), shots, takes (newest first) and every
/// validation / compile issue.
pub fn story_view(core: &Core, story_id: &str) -> Result<StoryView, String> {
    let (story, shots, takes) = {
        let db = core.db.lock().unwrap();
        let story = store::get_story(&db, story_id)?.ok_or("That story no longer exists")?;
        let shots = store::list_shots(&db, story_id)?;
        let takes = db.list_takes(story_id)?;
        (story, shots, takes)
    };
    let cast = cast_of(core, &story.cast)?;
    // A fresh draft has no shots yet; it only gets the story-level issues.
    let mut issues = if shots.is_empty() && story.status == "draft" {
        preflight(&story, &cast)
    } else {
        validate(&story, &shots, &cast)
    };
    for s in &shots {
        if let Err(e) = compile_shot(&story, s, &cast) {
            issues.push(Issue { shot: Some(s.position), message: e });
        }
    }
    Ok(StoryView { story, cast, shots, takes, issues })
}

fn take_path(core: &Core, take_id: &str) -> Result<PathBuf, String> {
    let rec = core
        .db
        .lock()
        .unwrap()
        .get_image(take_id)?
        .ok_or("The approved take's video is missing")?;
    let p = PathBuf::from(&rec.path);
    if p.is_file() {
        Ok(p)
    } else {
        Err("The approved take's video file is missing".into())
    }
}

/// Whether a story render of `shot_id` is still running. Entries whose job has
/// finished (left `core.jobs`) don't count and are dropped.
fn rendering(core: &Core, renders: &mut HashMap<String, String>, shot_id: &str) -> bool {
    let active = core.jobs.lock().unwrap();
    renders.retain(|_, job| active.contains_key(job));
    renders.contains_key(shot_id)
}

pub fn is_rendering(core: &Core, shot_id: &str) -> bool {
    rendering(core, &mut core.story_renders.lock().unwrap(), shot_id)
}

/// Queues one H3 Character job for the shot; returns the job id. Refused
/// while an earlier render of the shot is still running.
pub fn render_shot(core: &Arc<Core>, shot_id: &str) -> Result<String, String> {
    let shot = {
        let db = core.db.lock().unwrap();
        store::get_shot(&db, shot_id)?.ok_or("That shot no longer exists")?
    };
    let busy = || format!("Shot {} is already rendering", shot.position);
    if is_rendering(core, shot_id) {
        return Err(busy());
    }
    let view = story_view(core, &shot.story_id)?;
    if let Some(i) = view.issues.first() {
        return Err(match i.shot {
            Some(n) => format!("Shot {n}: {}", i.message),
            None => i.message.clone(),
        });
    }
    let compiled = compile_shot(&view.story, &shot, &view.cast)?;
    if compiled.ref_ids.is_empty() {
        return Err(format!("Shot {} has no character with reference images", shot.position));
    }
    let mut init_image_id = None;
    if shot.continuity == "continues" {
        let prev = view
            .shots
            .iter()
            .find(|s| s.position + 1 == shot.position)
            .ok_or("The previous shot is missing")?;
        let take = prev
            .approved_take_id
            .as_deref()
            .ok_or_else(|| format!("Approve shot {} first", prev.position))?;
        let ff = ffmpeg::find_ffmpeg()?;
        let dir = core.cfg.data_dir.join("stories-tmp");
        std::fs::create_dir_all(&dir).map_err(|e| format!("Could not create a temporary folder: {e}"))?;
        let png = dir.join(format!("{}.png", uuid::Uuid::new_v4()));
        let frame = ffmpeg::last_frame_png(&ff, &take_path(core, take)?, &png)
            .and_then(|_| std::fs::read(&png).map_err(|e| format!("Could not read the last frame: {e}")));
        let _ = std::fs::remove_file(&png);
        init_image_id = Some(crate::references::import_bytes(&core.cfg.references_dir(), &frame?)?.ref_id);
    }
    let req = VideoRequest {
        model: VIDEO_MODEL.into(),
        prompt: compiled.prompt,
        reference_ids: compiled.ref_ids,
        init_image_id,
        duration_s: shot.duration_s as f64,
        fps: FPS,
        resolution: resolution_for(&view.story.aspect)?.into(),
        audio: true,
        destination: Destination::General,
        story_take: Some((shot.story_id.clone(), shot.id.clone())),
        ..Default::default()
    };
    // Checked again under the lock: another call may have queued it meanwhile.
    let mut renders = core.story_renders.lock().unwrap();
    if rendering(core, &mut renders, shot_id) {
        return Err(busy());
    }
    let job_id = jobs::generate_video(core, req)?;
    renders.insert(shot.id.clone(), job_id.clone());
    Ok(job_id)
}

/// Renders every shot that has no takes yet, isn't rendering and can start
/// now: `cut` shots, and `continues` shots whose previous shot is approved.
/// Returns (shot_id, job_id).
pub fn render_story(core: &Arc<Core>, story_id: &str) -> Result<Vec<(String, String)>, String> {
    let view = story_view(core, story_id)?;
    let mut out = Vec::new();
    for s in &view.shots {
        let has_takes = view.takes.iter().any(|t| t.shot_id.as_deref() == Some(s.id.as_str()))
            || is_rendering(core, &s.id);
        let prev_ok = s.continuity == "cut"
            || view
                .shots
                .iter()
                .any(|p| p.position + 1 == s.position && p.approved_take_id.is_some());
        if !has_takes && prev_ok {
            match render_shot(core, &s.id) {
                Ok(job) => out.push((s.id.clone(), job)),
                Err(e) if out.is_empty() => return Err(e),
                Err(e) => return Err(format!("Queued {} shot(s); shot {}: {e}", out.len(), s.position)),
            }
        }
    }
    Ok(out)
}

/// Approves `take_id` for the shot. When the next shot continues this one and
/// has no takes yet, it is rendered now; returns its (shot_id, job_id).
pub fn approve_take(core: &Arc<Core>, shot_id: &str, take_id: &str) -> Result<Option<(String, String)>, String> {
    let shot = {
        let db = core.db.lock().unwrap();
        let shot = store::get_shot(&db, shot_id)?.ok_or("That shot no longer exists")?;
        let take = db.get_image(take_id)?.ok_or("That take no longer exists")?;
        if take.shot_id.as_deref() != Some(shot_id) {
            return Err("That take belongs to another shot".into());
        }
        store::set_approved(&db, shot_id, Some(take_id))?;
        shot
    };
    let view = story_view(core, &shot.story_id)?;
    let Some(next) = view.shots.iter().find(|s| s.position == shot.position + 1) else {
        return Ok(None);
    };
    let next_has_takes = view.takes.iter().any(|t| t.shot_id.as_deref() == Some(next.id.as_str()))
        || is_rendering(core, &next.id);
    if next.continuity == "continues" && !next_has_takes {
        return Ok(Some((next.id.clone(), render_shot(core, &next.id)?)));
    }
    Ok(None)
}

/// Stitches the approved takes (shot order) into one gallery video, replacing
/// any earlier result of the story.
pub fn assemble_story(core: &Core, story_id: &str) -> Result<ImageRecord, String> {
    let view = story_view(core, story_id)?;
    if view.shots.is_empty() {
        return Err("The story has no shots".into());
    }
    let mut inputs = Vec::new();
    for s in &view.shots {
        let take = s
            .approved_take_id
            .as_deref()
            .ok_or_else(|| format!("Approve a take for shot {} first", s.position))?;
        inputs.push(take_path(core, take)?);
    }
    let ff = ffmpeg::find_ffmpeg()?;
    let dir = core.cfg.videos_dir();
    std::fs::create_dir_all(&dir).map_err(|e| format!("Could not create the videos folder: {e}"))?;
    let id = uuid::Uuid::new_v4().to_string();
    let out = dir.join(format!("{id}.mp4"));
    ffmpeg::assemble(&ff, &inputs, &out)?;
    let poster = dir.join(format!("{id}.jpg"));
    if let Err(e) = ffmpeg::first_frame_jpg(&ff, &out, &poster) {
        let _ = std::fs::remove_file(&out);
        return Err(e);
    }
    let first_take = view.shots[0].approved_take_id.as_deref().unwrap_or_default();
    let first = view
        .takes
        .iter()
        .find(|t| t.id == first_take)
        .ok_or("The approved take's video is missing")?;
    let name = if view.story.title.trim().is_empty() { &view.story.brief } else { &view.story.title };
    let rec = ImageRecord {
        id: id.clone(),
        path: out.to_string_lossy().into(),
        model: VIDEO_MODEL.into(),
        prompt: format!("Story: {name}"),
        negative_prompt: String::new(),
        aspect_ratio: first.aspect_ratio.clone(),
        width: first.width,
        height: first.height,
        seed: 0,
        steps: 0,
        cfg: 0.0,
        references: vec![],
        loras: vec![],
        created_at: crate::state::now_rfc3339(),
        duration_ms: None,
        runpod: Default::default(),
        init_image: None,
        denoise: None,
        kind: KIND_VIDEO.into(),
        duration_s: Some(view.shots.iter().map(|s| s.duration_s as f64).sum()),
        fps: Some(FPS),
        has_audio: Some(true),
        poster_path: Some(poster.to_string_lossy().into()),
        vault: false,
        thumb_path: None,
        story_id: Some(story_id.into()),
        shot_id: None,
    };
    let sidecar = serde_json::json!({
        "story": view.story,
        "shots": view.shots.iter().map(|s| {
            let t = view.takes.iter().find(|t| Some(t.id.as_str()) == s.approved_take_id.as_deref());
            serde_json::json!({"position": s.position, "takeId": s.approved_take_id,
                "seed": t.map(|t| t.seed), "prompt": t.map(|t| &t.prompt)})
        }).collect::<Vec<_>>(),
    });
    let db = core.db.lock().unwrap();
    if let Err(e) = db
        .insert_image(&rec)
        .and_then(|_| store::set_result(&db, story_id, &id, &sidecar.to_string()))
    {
        let _ = db.delete_image(&id);
        core.cfg.remove_record_files(&rec);
        return Err(e);
    }
    // The new result is recorded; now the previous one goes.
    if let Some(old) = view.story.result_image_id.as_deref() {
        if let Some(o) = db.get_image(old)? {
            core.cfg.delete_record(&db, &o)?;
        }
    }
    Ok(rec)
}

/// Deletes records and the files the app wrote for them.
pub fn delete_records(core: &Core, recs: &[crate::db::ImageRecord]) -> Result<(), String> {
    let db = core.db.lock().unwrap();
    for rec in recs {
        core.cfg.delete_record(&db, rec)?;
    }
    Ok(())
}

/// Replaces a story's shots and deletes the takes of shots that are gone.
pub fn store_shots(core: &Core, story_id: &str, shots: &[Shot]) -> Result<(), String> {
    let orphans: Vec<ImageRecord> = {
        let db = core.db.lock().unwrap();
        store::replace_shots(&db, story_id, shots)?;
        db.list_takes(story_id)?
            .into_iter()
            .filter(|t| !shots.iter().any(|s| t.shot_id.as_deref() == Some(s.id.as_str())))
            .collect()
    };
    delete_records(core, &orphans)
}

/// Brief, cast, target and aspect checks for saving a story.
pub fn check_story(story: &Story) -> Result<(), String> {
    if story.brief.trim().is_empty() {
        return Err("Write a brief first".into());
    }
    if story.cast.is_empty() {
        return Err("Add at least one character to the cast first".into());
    }
    if story.target_s == 0 {
        return Err("Choose a target length".into());
    }
    resolution_for(&story.aspect)?;
    Ok(())
}

/// Plans the shots with the local LLM (replaces the shot list). The
/// story-level safety checks run first; nothing is sent to the LLM when they fail.
pub async fn plan_story(core: &Arc<Core>, story_id: &str) -> Result<StoryView, String> {
    let view = story_view(core, story_id)?;
    if let Some(i) = preflight(&view.story, &view.cast).first() {
        return Err(i.message.clone());
    }
    check_story(&view.story)?;
    let base = core.settings.llm_base_url();
    let model = resolve_llm_model(&base, &core.settings.llm_model()).await?;
    let out = planner::plan(&base, &model, &view.story, &view.cast).await?;
    let mut story = view.story;
    if !out.title.trim().is_empty() {
        story.title = out.title.trim().to_string();
    }
    story.logline = out.logline.trim().to_string();
    story.status = "planned".into();
    story.updated_at = crate::state::now_rfc3339();
    store::save_story(&core.db.lock().unwrap(), &story)?;
    store_shots(core, story_id, &out.shots)?;
    story_view(core, story_id)
}
