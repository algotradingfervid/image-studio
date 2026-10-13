//! Shot and story rendering: queues video jobs and links takes to shots.

use super::{
    compile::compile_shot, ffmpeg, planner, resolution_for, resolve_llm_model, store,
    validate::{preflight, validate},
    Character, Issue, Shot, Story, StoryPatch, StoryView,
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
    let (story, shots, takes, result) = {
        let db = core.db.lock().unwrap();
        let story = store::get_story(&db, story_id)?.ok_or("That story no longer exists")?;
        let shots = store::list_shots(&db, story_id)?;
        let takes = db.list_takes(story_id)?;
        let result = match story.result_image_id.as_deref() {
            Some(id) => db.get_image(id)?,
            None => None,
        };
        (story, shots, takes, result)
    };
    let cast = cast_of(core, &story.cast)?;
    // A fresh draft has no shots yet; it only gets the story-level issues.
    let mut issues = if shots.is_empty() && story.status == "draft" {
        preflight(&story, &cast)
    } else {
        validate(&story, &shots, &cast)
    };
    for s in &shots {
        if let Err(e) = compile_shot(&story, s, &cast, s.continuity == "continues") {
            issues.push(Issue { shot: Some(s.position), message: e });
        }
    }
    Ok(StoryView { story, cast, shots, takes, result, issues })
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

/// Refuses while any of `shots` is rendering (its take would land on a shot
/// or story that is gone). Called with the `story_renders` lock held so no
/// render starts between this check and the change.
fn refuse_rendering(core: &Core, renders: &mut HashMap<String, String>, shots: &[Shot]) -> Result<(), String> {
    match shots.iter().find(|s| rendering(core, renders, &s.id)) {
        Some(s) => Err(format!("Wait for shot {} to finish rendering", s.position)),
        None => Ok(()),
    }
}

/// An issue as an error message ("Shot N: …" unless it already names its shot).
fn issue_text(i: &Issue) -> String {
    match i.shot {
        Some(n) if !i.message.starts_with(&format!("Shot {n} ")) => format!("Shot {n}: {}", i.message),
        _ => i.message.clone(),
    }
}

/// The job card label of a shot render: "Story: {title or brief start} · shot N".
fn job_label(story: &Story, position: u32) -> String {
    const MAX: usize = 40;
    let title = story.title.trim();
    let name = if !title.is_empty() {
        title.to_string()
    } else {
        let brief = story.brief.trim();
        if brief.chars().count() > MAX {
            let cut: String = brief.chars().take(MAX).collect();
            let cut = cut.rsplit_once(' ').map(|(a, _)| a).filter(|a| !a.is_empty()).unwrap_or(&cut);
            format!("{}…", cut.trim_end_matches([' ', ',', ';', ':', '.']))
        } else {
            brief.to_string()
        }
    };
    format!("Story: {name} · shot {position}")
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
    // Story-wide issues and this shot's own block it; another shot's don't.
    if let Some(i) = view.issues.iter().find(|i| i.shot.is_none() || i.shot == Some(shot.position)) {
        return Err(issue_text(i));
    }
    if compile_shot(&view.story, &shot, &view.cast, false)?.ref_ids.is_empty() {
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
    // A continuing shot's first frame is also the last reference (`<Picture M>` in the prompt)
    // and stays the worker's frame-0 guide (`initImage`).
    let compiled = compile_shot(&view.story, &shot, &view.cast, init_image_id.is_some())?;
    let mut reference_ids = compiled.ref_ids;
    reference_ids.extend(init_image_id.clone());
    let req = VideoRequest {
        model: VIDEO_MODEL.into(),
        prompt: compiled.prompt,
        reference_ids,
        init_image_id,
        duration_s: shot.duration_s as f64,
        fps: FPS,
        resolution: resolution_for(&view.story.aspect)?.into(),
        audio: true,
        destination: Destination::General,
        story_take: Some((shot.story_id.clone(), shot.id.clone())),
        label: Some(job_label(&view.story, shot.position)),
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
/// A shot that can't render doesn't stop the others; its reason is in `error`.
pub fn render_story(core: &Arc<Core>, story_id: &str) -> Result<RenderAll, String> {
    let view = story_view(core, story_id)?;
    let mut out = Vec::new();
    let mut errors: Vec<String> = Vec::new();
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
                Err(e) if e.starts_with("Shot ") => errors.push(e),
                Err(e) => errors.push(format!("Shot {}: {e}", s.position)),
            }
        }
    }
    let error = match (errors.is_empty(), out.len()) {
        (true, _) => None,
        (false, 0) => Some(errors.join("; ")),
        (false, n) => Some(format!("Queued {n} shot(s); {}", errors.join("; "))),
    };
    Ok(RenderAll { queued: out, error })
}

/// What "Render all" queued, and why the shots it couldn't render didn't start.
#[derive(Debug, Default)]
pub struct RenderAll {
    /// (shot_id, job_id)
    pub queued: Vec<(String, String)>,
    pub error: Option<String>,
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
/// Refused while a shot that would go is rendering.
pub fn store_shots(core: &Core, story_id: &str, shots: &[Shot]) -> Result<(), String> {
    let orphans: Vec<ImageRecord> = {
        let mut renders = core.story_renders.lock().unwrap();
        let gone: Vec<Shot> = store::list_shots(&core.db.lock().unwrap(), story_id)?
            .into_iter()
            .filter(|old| !shots.iter().any(|s| s.id == old.id))
            .collect();
        refuse_rendering(core, &mut renders, &gone)?;
        let db = core.db.lock().unwrap();
        store::replace_shots(&db, story_id, shots)?;
        db.list_takes(story_id)?
            .into_iter()
            .filter(|t| !shots.iter().any(|s| t.shot_id.as_deref() == Some(s.id.as_str())))
            .collect()
    };
    delete_records(core, &orphans)
}

/// Saves the edited shot list in the given order (see `store::merge_shots`).
pub fn save_shots(core: &Core, story_id: &str, shots: Vec<Shot>) -> Result<StoryView, String> {
    let existing = {
        let db = core.db.lock().unwrap();
        store::get_story(&db, story_id)?.ok_or("That story no longer exists")?;
        store::list_shots(&db, story_id)?
    };
    let merged = store::merge_shots(story_id, &existing, shots);
    store_shots(core, story_id, &merged)?;
    story_view(core, story_id)
}

/// Every cast id must be a saved character.
pub fn check_cast_exists(core: &Core, cast: &[String]) -> Result<(), String> {
    let db = core.db.lock().unwrap();
    for id in cast {
        if store::get_character(&db, id)?.is_none() {
            return Err("A cast character no longer exists".into());
        }
    }
    Ok(())
}

/// Writes only the fields `patch` sets (title, brief, target, aspect, style,
/// cast, voices), validated like a new story. The aspect can't change once
/// the story has takes (they would no longer assemble).
pub fn update_story(core: &Core, id: &str, patch: StoryPatch) -> Result<StoryView, String> {
    let (mut s, has_takes) = {
        let db = core.db.lock().unwrap();
        let s = store::get_story(&db, id)?.ok_or("That story no longer exists")?;
        let has_takes = !db.list_takes(id)?.is_empty();
        (s, has_takes)
    };
    if let Some(aspect) = patch.aspect {
        if aspect != s.aspect && has_takes {
            return Err("Change the aspect before rendering; this story already has takes".into());
        }
        s.aspect = aspect;
    }
    if let Some(t) = patch.title {
        s.title = t.trim().to_string();
    }
    if let Some(b) = patch.brief {
        s.brief = b.trim().to_string();
    }
    if let Some(t) = patch.target_s {
        s.target_s = t;
    }
    if let Some(st) = patch.style {
        s.style = st.trim().to_string();
    }
    if let Some(c) = patch.cast {
        s.cast = c;
    }
    // Also drops the voices of characters who left the cast.
    let voices = patch.voices.unwrap_or_else(|| std::mem::take(&mut s.voices));
    s.voices = super::cast_voices(&s.cast, voices);
    s.updated_at = crate::state::now_rfc3339();
    check_story(&s)?;
    check_cast_exists(core, &s.cast)?;
    store::save_story(&core.db.lock().unwrap(), &s)?;
    story_view(core, id)
}

/// Deletes the story, its shots, its takes and its assembled video. Refused
/// while one of its shots is rendering.
pub fn delete_story(core: &Core, id: &str) -> Result<(), String> {
    let mut renders = core.story_renders.lock().unwrap();
    let shots = store::list_shots(&core.db.lock().unwrap(), id)?;
    refuse_rendering(core, &mut renders, &shots)?;
    let recs: Vec<ImageRecord> = {
        let db = core.db.lock().unwrap();
        let story = store::get_story(&db, id)?;
        let mut recs = db.list_takes(id)?;
        if let Some(r) = story.and_then(|s| s.result_image_id) {
            recs.extend(db.get_image(&r)?);
        }
        recs
    };
    delete_records(core, &recs)?;
    store::delete_story(&core.db.lock().unwrap(), id)
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
    // A plan replaces every shot: not while one renders (checked again when storing).
    {
        let mut renders = core.story_renders.lock().unwrap();
        refuse_rendering(core, &mut renders, &view.shots)?;
    }
    let base = core.settings.llm_base_url();
    let model = resolve_llm_model(&base, &core.settings.llm_model()).await?;
    let out = planner::plan(&base, &model, &view.story, &view.cast).await?;
    // The shots first: refused, with nothing changed, if a render started meanwhile.
    store_shots(core, story_id, &out.shots)?;
    // Built on the story as stored now, not as it was when planning began.
    let mut story = store::get_story(&core.db.lock().unwrap(), story_id)?.ok_or("That story no longer exists")?;
    if !out.title.trim().is_empty() {
        story.title = out.title.trim().to_string();
    }
    story.logline = out.logline.trim().to_string();
    story.voices = out.voices;
    story.status = "planned".into();
    story.updated_at = crate::state::now_rfc3339();
    store::save_story(&core.db.lock().unwrap(), &story)?;
    story_view(core, story_id)
}
