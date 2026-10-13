//! Dev driver for the Stories backend without the GUI (quit the app first).
//!
//! `cargo run --release --example story_run -- <portraits|plan|render|all> [--dry-run [--fake-portraits]]`
//!
//! - `portraits`: one zimage portrait per character, imported as its reference; characters saved.
//! - `plan`: creates (or reuses, matched by brief) the story and plans it with the local LLM.
//! - `render`: renders every shot, auto-approves the first take of each, re-renders a failed
//!   shot once, then assembles the story. 90 min hard timeout.
//! - `all`: portraits, plan, render.
//!
//! Real runs use the app's own data dir and Keychain and start PAID RunPod GPU pods; every
//! profile's pod is stopped on exit (success, error or Ctrl-C).
//! `plan --dry-run` works on a temporary copy (no GPU, no RunPod, real DB untouched); with
//! `--fake-portraits` it uses two generated placeholder references instead of the real cast.
use app_lib::db::Db;
use app_lib::jobs::{self, Destination, GenerateRequest, Job, JobState};
use app_lib::pod::{self, GpuState, GpuStatus, Profile, StopReason};
use app_lib::registry::Registry;
use app_lib::settings::{self, CachedStore, KeychainStore, MemoryStore, Settings};
use app_lib::state::{self, Core, CoreConfig, EventSink};
use app_lib::status::StatusView;
use app_lib::stories::{compile, ffmpeg, render, store, Character, Story, StoryPatch, StoryView};
use app_lib::tasks::Task;
use app_lib::{applog, references};
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

const IDENTIFIER: &str = "com.naren.imagestudio";
const PORTRAIT_MODEL: &str = "zimage";
const PORTRAIT_ASPECT: &str = "1:1"; // 1024x1024 in the registry
const PORTRAIT_SEED: u64 = 424_242;
const RENDER_TIMEOUT: Duration = Duration::from_secs(90 * 60);
const PORTRAIT_TIMEOUT: Duration = Duration::from_secs(45 * 60);

struct Spec {
    name: &'static str,
    description: &'static str,
    prompt: &'static str,
}

const CAST: [Spec; 2] = [
    Spec {
        name: "Mara",
        description: "woman in her early 30s, short black bob haircut, green raincoat over a cream sweater",
        prompt: "Photorealistic waist-up portrait of a woman in her early 30s with a short black bob haircut, wearing a green raincoat over a cream sweater, facing the camera with a calm expression, soft even studio light, plain light-grey background, 35 mm photo, sharp focus",
    },
    Spec {
        name: "Theo",
        description: "man in his late 30s, curly brown hair, short beard, grey wool coat over a dark shirt",
        prompt: "Photorealistic waist-up portrait of a man in his late 30s with curly brown hair and a short beard, wearing a grey wool coat over a dark shirt, facing the camera with a calm expression, soft even studio light, plain light-grey background, 35 mm photo, sharp focus",
    },
];

const BRIEF: &str = "Two former projectionists, Mara and Theo, meet on a rainy night outside the boarded-up cinema where they used to work. Mara has secretly bought the building and wants Theo to reopen it with her. He is reluctant and hurt that she left years ago, but she wins him over. They end up inside, laughing beside the old projector as it flickers to life.";
const STYLE: &str = "35 mm film, warm practical lights, light rain";
const TARGET_S: u32 = 60;
const ASPECT: &str = "16:9";

fn ts() -> String {
    chrono::Local::now().format("%H:%M:%S").to_string()
}

fn short(id: &str) -> &str {
    &id[..id.len().min(8)]
}

// ----- event sink -----

/// Prints job and GPU changes (deduplicated) and keeps every finished job.
#[derive(Default)]
struct LogSink {
    finished: Mutex<HashMap<String, Job>>,
    last_job: Mutex<HashMap<String, String>>,
    last_gpu: Mutex<HashMap<&'static str, String>>,
}

impl LogSink {
    fn finished(&self, job_id: &str) -> Option<Job> {
        self.finished.lock().unwrap().get(job_id).cloned()
    }
}

impl EventSink for LogSink {
    fn job_update(&self, job: &Job) {
        let p = job.progress.as_ref();
        let mut line = format!("{:?}", job.status).to_lowercase();
        if let Some(ph) = p.and_then(|p| p.phase.as_deref()) {
            line += &format!(" · {ph}");
        }
        if let Some(st) = p.and_then(|p| p.stage.as_deref()) {
            line += &format!(" · {st}");
        }
        if let (Some(s), Some(t)) = (p.and_then(|p| p.step), p.and_then(|p| p.total_steps)) {
            line += &format!(" · step {s}/{t}");
        }
        if let Some(c) = p.and_then(|p| p.copy_percent) {
            line += &format!(" · copy {c:.0}%");
        }
        if let Some(e) = &job.error {
            line += &format!(" · ERROR: {e}");
        }
        let changed = self.last_job.lock().unwrap().insert(job.job_id.clone(), line.clone()).as_ref() != Some(&line);
        if changed {
            let label = job.label.clone().unwrap_or_else(|| format!("{:?} job", job.kind));
            println!("{} [job {}] {label}: {line}", ts(), short(&job.job_id));
        }
        if matches!(job.status, JobState::Completed | JobState::Failed | JobState::Cancelled) {
            self.finished.lock().unwrap().insert(job.job_id.clone(), job.clone());
        }
    }
    fn task_update(&self, _: &Task) {}
    fn status_update(&self, _: &StatusView) {}
    fn gpu_update(&self, s: &GpuState) {
        let mut line = format!("{:?}", s.status).to_lowercase();
        for (k, v) in [("pod", &s.pod_id), ("gpu", &s.gpu_type), ("phase", &s.phase), ("error", &s.error)] {
            if let Some(v) = v {
                line += &format!(" {k}={v}");
            }
        }
        if let Some(c) = s.cost_per_hr {
            line += &format!(" ${c:.2}/hr");
        }
        if let Some(r) = s.stop_reason {
            line += &format!(" stopReason={r:?}");
        }
        let changed = self.last_gpu.lock().unwrap().insert(s.profile.as_str(), line.clone()).as_ref() != Some(&line);
        if changed {
            println!("{} [gpu {}] {line}", ts(), s.profile.as_str());
        }
    }
}

// ----- core -----

/// The app's data dir (Tauri `app_data_dir` on macOS for the bundle identifier).
fn app_data_dir() -> Result<PathBuf, String> {
    let home = std::env::var_os("HOME").ok_or("HOME is not set")?;
    Ok(PathBuf::from(home).join("Library/Application Support").join(IDENTIFIER))
}

/// Like `lib.rs::build_core`. Real: Keychain secrets + the repo `.env` fallback the installed
/// (debug) app reads. Dry: in-memory secrets and no env, so no RunPod call can succeed.
fn build_core(data_dir: &Path, sink: Arc<LogSink>, real: bool) -> Result<Arc<Core>, String> {
    std::fs::create_dir_all(data_dir).map_err(|e| e.to_string())?;
    let db = Db::open(&data_dir.join("studio.db"))?;
    let settings = if real {
        let env = std::fs::read_to_string(settings::repo_dotenv_path())
            .map(|b| settings::parse_dotenv(&b))
            .unwrap_or_default();
        Settings::new(Arc::new(CachedStore::new(KeychainStore)), env, data_dir.join("settings.json"))
    } else {
        Settings::new(Arc::new(MemoryStore::default()), HashMap::new(), data_dir.join("settings.json"))
    };
    Core::new(Registry::embedded(), db, settings, sink, CoreConfig::production(data_dir.to_path_buf()))
}

/// The app's startup GPU work: the pod monitor (idle/error auto-stop), then per profile the
/// volume lookup and re-adopting a pod left running (adopting never creates a pod).
async fn start_background(core: &Arc<Core>) -> Result<(), String> {
    let mon = core.clone();
    tokio::spawn(async move { pod::run_monitor(mon, Duration::from_secs(30)).await });
    let rest = pod::rest(core)?;
    for p in Profile::ALL {
        if let Err(e) = pod::lookup_volume_for(core, &rest, p).await {
            println!("{} {} volume lookup failed: {e}", ts(), p.as_str());
        }
        match pod::adopt_for(core, p).await {
            Ok(s) => println!("{} [gpu {}] after adopt: {:?}", ts(), p.as_str(), s.status),
            Err(e) => println!("{} {} pod adopt failed: {e}", ts(), p.as_str()),
        }
    }
    for p in Profile::ALL {
        let mut rx = pod::subscribe_for(core, p);
        let _ = tokio::time::timeout(Duration::from_secs(20), async {
            while pod::state_for(core, p).status == GpuStatus::Starting {
                if rx.changed().await.is_err() {
                    break;
                }
            }
        })
        .await;
    }
    Ok(())
}

/// Printed before anything that may start a paid pod for `p`.
fn announce_start(core: &Core, p: Profile) {
    if matches!(pod::state_for(core, p).status, GpuStatus::Stopped | GpuStatus::Error) {
        println!("{} Starting {} GPU pod (paid)", ts(), p.as_str());
    }
}

/// Stops every profile's pod (the app's stop-before-quit path) and reports the result.
async fn stop_all_pods(core: &Arc<Core>) -> bool {
    println!("{} Stopping GPU pods ...", ts());
    match pod::stop_for_quit(core).await {
        Ok(states) => {
            for s in states {
                println!("{} [gpu {}] final: {:?}", ts(), s.profile.as_str(), s.status);
            }
            true
        }
        Err(e) => {
            eprintln!("{} WARNING: could not confirm every GPU pod stopped: {e}", ts());
            eprintln!("WARNING: a pod may still be billing; check https://www.runpod.io/console/pods");
            false
        }
    }
}

// ----- characters -----

/// Creates or updates the character named `name` (case-insensitive) with one reference.
fn upsert_character(core: &Core, spec: &Spec, ref_id: String) -> Result<Character, String> {
    let db = core.db.lock().unwrap();
    let old = store::list_characters(&db)?.into_iter().find(|c| c.name.eq_ignore_ascii_case(spec.name));
    let now = state::now_rfc3339();
    let c = Character {
        id: old.as_ref().map(|c| c.id.clone()).unwrap_or_else(|| uuid::Uuid::new_v4().to_string()),
        name: spec.name.into(),
        description: spec.description.into(),
        source: "generated".into(),
        consent: false,
        adult: true,
        ref_ids: vec![ref_id],
        created_at: old.map(|c| c.created_at).unwrap_or_else(|| now.clone()),
        updated_at: now,
    };
    store::check_character(&c)?;
    store::save_character(&db, &c)?;
    Ok(c)
}

fn find_cast(core: &Core) -> Result<Vec<Character>, String> {
    let all = store::list_characters(&core.db.lock().unwrap())?;
    CAST.iter()
        .map(|s| {
            all.iter()
                .find(|c| c.name.eq_ignore_ascii_case(s.name))
                .cloned()
                .ok_or_else(|| format!("No character named {}; run `portraits` first", s.name))
        })
        .collect()
}

async fn wait_job(sink: &LogSink, job_id: &str, timeout: Duration) -> Result<Job, String> {
    let deadline = Instant::now() + timeout;
    loop {
        if let Some(j) = sink.finished(job_id) {
            return Ok(j);
        }
        if Instant::now() > deadline {
            return Err(format!("Job {} timed out", short(job_id)));
        }
        tokio::time::sleep(Duration::from_secs(2)).await;
    }
}

async fn portraits(core: &Arc<Core>, sink: &LogSink) -> Result<Vec<Character>, String> {
    announce_start(core, Profile::Image);
    let mut queued = Vec::new();
    for spec in &CAST {
        let req = GenerateRequest {
            model: PORTRAIT_MODEL.into(),
            prompt: spec.prompt.into(),
            aspect_ratio: PORTRAIT_ASPECT.into(),
            count: 1,
            seed: Some(PORTRAIT_SEED),
            destination: Destination::General,
            ..Default::default()
        };
        let id = jobs::generate(core, req)?;
        println!("{} queued portrait of {} (job {})", ts(), spec.name, short(&id));
        queued.push((spec, id));
    }
    let mut out = Vec::new();
    for (spec, id) in queued {
        let job = wait_job(sink, &id, PORTRAIT_TIMEOUT).await?;
        let img = match (job.status, job.images.first()) {
            (JobState::Completed, Some(img)) => img.clone(),
            _ => return Err(format!("Portrait of {} failed: {}", spec.name, job.error.unwrap_or_default())),
        };
        let bytes = std::fs::read(&img.path).map_err(|e| format!("Could not read {}: {e}", img.path))?;
        let r = references::import_bytes(&core.cfg.references_dir(), &bytes)?;
        let c = upsert_character(core, spec, r.ref_id)?;
        println!("{} {} portrait {} -> character {} (ref {})", ts(), c.name, img.path, c.id, c.ref_ids[0]);
        out.push(c);
    }
    Ok(out)
}

/// Two small placeholder references (dry runs only: never reach a GPU).
fn fake_portraits(core: &Core) -> Result<Vec<Character>, String> {
    let mut out = Vec::new();
    for (k, spec) in CAST.iter().enumerate() {
        let img = image::RgbImage::from_fn(256, 256, |x, y| {
            image::Rgb([(x as u8).wrapping_mul(k as u8 + 1), y as u8, 120 + 60 * k as u8])
        });
        let mut png = Vec::new();
        image::DynamicImage::ImageRgb8(img)
            .write_to(&mut std::io::Cursor::new(&mut png), image::ImageFormat::Png)
            .map_err(|e| e.to_string())?;
        let r = references::import_bytes(&core.cfg.references_dir(), &png)?;
        out.push(upsert_character(core, spec, r.ref_id)?);
    }
    Ok(out)
}

// ----- plan -----

fn names(view: &StoryView, ids: &[String]) -> String {
    ids.iter()
        .map(|id| view.cast.iter().find(|c| &c.id == id).map(|c| c.name.as_str()).unwrap_or(id))
        .collect::<Vec<_>>()
        .join(", ")
}

fn print_view(view: &StoryView) {
    let s = &view.story;
    println!("\n=== {} ({}) ===", if s.title.is_empty() { "(untitled)" } else { &s.title }, s.id);
    println!("logline: {}", s.logline);
    for v in &s.voices {
        println!("voice {}: {}", names(view, std::slice::from_ref(&v.character_id)), v.voice);
    }
    let total: u32 = view.shots.iter().map(|s| s.duration_s).sum();
    println!("{} shots, {total} s total (target {} s)", view.shots.len(), s.target_s);
    for sh in &view.shots {
        println!(
            "  #{} {:>2}s {:<9} [{}] {} | {} | {} line(s){}",
            sh.position,
            sh.duration_s,
            sh.continuity,
            names(view, &sh.characters),
            sh.setting,
            sh.action,
            sh.dialogue.len(),
            sh.approved_take_id.as_deref().map(|t| format!(" | approved {}", short(t))).unwrap_or_default()
        );
        for d in &sh.dialogue {
            println!("        {}: \"{}\"", names(view, std::slice::from_ref(&d.speaker)), d.line);
        }
    }
    if view.issues.is_empty() {
        println!("issues: none");
    } else {
        for i in &view.issues {
            println!("ISSUE{}: {}", i.shot.map(|n| format!(" shot {n}")).unwrap_or_default(), i.message);
        }
    }
}

/// Creates the story, or reuses the one with this brief (the planner rewrites the title).
fn ensure_story(core: &Core, cast: &[Character]) -> Result<String, String> {
    let ids: Vec<String> = cast.iter().map(|c| c.id.clone()).collect();
    let existing = store::list_stories(&core.db.lock().unwrap())?.into_iter().find(|s| s.brief == BRIEF);
    if let Some(s) = existing {
        println!("{} reusing story {} \"{}\"", ts(), s.id, s.title);
        let patch = StoryPatch {
            target_s: Some(TARGET_S),
            aspect: (s.aspect != ASPECT).then(|| ASPECT.to_string()),
            style: Some(STYLE.into()),
            cast: Some(ids),
            ..Default::default()
        };
        render::update_story(core, &s.id, patch)?;
        return Ok(s.id);
    }
    let now = state::now_rfc3339();
    let story = Story {
        id: uuid::Uuid::new_v4().to_string(),
        title: String::new(),
        logline: String::new(),
        brief: BRIEF.into(),
        target_s: TARGET_S,
        aspect: ASPECT.into(),
        style: STYLE.into(),
        cast: ids,
        voices: vec![],
        status: "draft".into(),
        result_image_id: None,
        created_at: now.clone(),
        updated_at: now,
    };
    render::check_story(&story)?;
    render::check_cast_exists(core, &story.cast)?;
    store::save_story(&core.db.lock().unwrap(), &story)?;
    println!("{} created story {}", ts(), story.id);
    Ok(story.id)
}

fn find_story(core: &Core) -> Result<String, String> {
    store::list_stories(&core.db.lock().unwrap())?
        .into_iter()
        .find(|s| s.brief == BRIEF)
        .map(|s| s.id)
        .ok_or_else(|| "No story with the projectionists brief; run `plan` first".into())
}

async fn plan(core: &Arc<Core>, dry: bool) -> Result<String, String> {
    let cast = find_cast(core)?;
    let id = ensure_story(core, &cast)?;
    println!("{} planning with {} (model {}) ...", ts(), core.settings.llm_base_url(), core.settings.llm_model());
    let t = Instant::now();
    let view = render::plan_story(core, &id).await?;
    println!("{} planned in {:.1} s", ts(), t.elapsed().as_secs_f64());
    print_view(&view);
    if dry {
        let shots = &view.shots;
        let picks = shots.first().map(|s| (s, false)).into_iter().chain(
            shots.iter().find(|s| s.continuity == "continues").map(|s| (s, true)),
        );
        for (s, first_frame) in picks {
            println!("\n--- compiled H3 prompt, shot {} (first frame: {first_frame}) ---", s.position);
            match compile::compile_shot(&view.story, s, &view.cast, first_frame) {
                Ok(c) => println!("refs: {:?}\n{}", c.ref_ids, c.prompt),
                Err(e) => println!("COMPILE ERROR: {e}"),
            }
        }
        if !shots.iter().any(|s| s.continuity == "continues") {
            println!("\n(no `continues` shot in this plan)");
        }
    }
    if !view.issues.is_empty() {
        return Err(format!("{} issue(s) remain after planning", view.issues.len()));
    }
    Ok(id)
}

// ----- render -----

async fn render(core: &Arc<Core>, sink: &LogSink, story_id: &str) -> Result<(), String> {
    ffmpeg::find_ffmpeg()?; // fail before paying for a GPU
    let deadline = Instant::now() + RENDER_TIMEOUT;
    let mut attempts: HashMap<String, u32> = HashMap::new();
    let mut job_of: HashMap<String, String> = HashMap::new();
    let mut reported: HashSet<String> = HashSet::new();

    let view = render::story_view(core, story_id)?;
    if view.shots.is_empty() {
        return Err("The story has no shots; run `plan` first".into());
    }
    if let Some(i) = view.issues.first() {
        return Err(format!("The story has issues; re-plan first: {}", i.message));
    }
    announce_start(core, Profile::Video);
    let all = render::render_story(core, story_id)?;
    for (shot, job) in all.queued {
        println!("{} queued shot {} (job {})", ts(), short(&shot), short(&job));
        attempts.insert(shot.clone(), 1);
        job_of.insert(shot, job);
    }
    if let Some(e) = all.error {
        println!("{} render all: {e}", ts());
    }

    let mut last_beat = Instant::now();
    'outer: loop {
        if Instant::now() > deadline {
            return Err("Render timed out after 90 min".into());
        }
        let view = render::story_view(core, story_id)?;
        let n = view.shots.len();
        let approved = view.shots.iter().filter(|s| s.approved_take_id.is_some()).count();
        if approved == n {
            println!("{} all {n} shots approved", ts());
            break;
        }
        for s in &view.shots {
            if s.approved_take_id.is_some() {
                continue;
            }
            // Takes are newest first: the shot's first take is its last one.
            if let Some(take) = view.takes.iter().rev().find(|t| t.shot_id.as_deref() == Some(s.id.as_str())) {
                println!("{} shot {}: approving take {} ({})", ts(), s.position, short(&take.id), take.path);
                if let Some((next, job)) = render::approve_take(core, &s.id, &take.id)? {
                    println!("{} queued continuing shot {} (job {})", ts(), short(&next), short(&job));
                    *attempts.entry(next.clone()).or_default() += 1;
                    job_of.insert(next, job);
                }
                continue 'outer; // re-read the view
            }
            if render::is_rendering(core, &s.id) {
                continue;
            }
            let prev_ok = s.continuity == "cut"
                || view.shots.iter().any(|p| p.position + 1 == s.position && p.approved_take_id.is_some());
            if !prev_ok {
                continue;
            }
            if let Some(job) = job_of.get(&s.id) {
                match sink.finished(job) {
                    // Left the job table but not reported yet: look again next round.
                    None => continue,
                    Some(j) if reported.insert(job.clone()) => println!(
                        "{} shot {} render {:?}: {}",
                        ts(),
                        s.position,
                        j.status,
                        j.error.unwrap_or_else(|| "no take was saved".into())
                    ),
                    Some(_) => {}
                }
            }
            let tries = attempts.get(&s.id).copied().unwrap_or(0);
            if tries >= 2 {
                return Err(format!("Shot {} failed twice; giving up", s.position));
            }
            announce_start(core, Profile::Video);
            let job = render::render_shot(core, &s.id)?;
            println!(
                "{} {} shot {} (job {})",
                ts(),
                if tries == 0 { "rendering" } else { "re-rendering" },
                s.position,
                short(&job)
            );
            attempts.insert(s.id.clone(), tries + 1);
            job_of.insert(s.id.clone(), job);
            continue 'outer;
        }
        if last_beat.elapsed() >= Duration::from_secs(60) {
            last_beat = Instant::now();
            let active: Vec<String> = jobs::active_jobs(core)
                .iter()
                .map(|j| format!("{} {:?}", j.label.as_deref().unwrap_or("job"), j.status))
                .collect();
            let left = deadline.saturating_duration_since(Instant::now()).as_secs() / 60;
            println!("{} approved {approved}/{n}; active: [{}]; {left} min left", ts(), active.join(", "));
        }
        tokio::time::sleep(Duration::from_secs(5)).await;
    }

    println!("{} assembling ...", ts());
    let c = core.clone();
    let id = story_id.to_string();
    let rec = tokio::task::spawn_blocking(move || render::assemble_story(&c, &id))
        .await
        .map_err(|e| e.to_string())??;
    println!("{} RESULT VIDEO: {}", ts(), rec.path);
    Ok(())
}

// ----- main -----

#[derive(Clone, Copy, PartialEq)]
enum Cmd {
    Portraits,
    Plan,
    Render,
    All,
}

fn usage() -> ! {
    eprintln!("usage: story_run <portraits|plan|render|all> [--dry-run [--fake-portraits]]  (--dry-run: plan only)");
    std::process::exit(2);
}

/// Dry runs work on a temp dir: the real settings.json (LLM URL/model) and, unless
/// `fake`, a copy of the real database (for the real cast). Nothing real is written.
fn dry_dir(fake: bool) -> Result<tempfile::TempDir, String> {
    let tmp = tempfile::tempdir().map_err(|e| e.to_string())?;
    let real = app_data_dir()?;
    let mut files = vec!["settings.json"];
    if !fake {
        files.extend(["studio.db", "studio.db-wal", "studio.db-shm"]);
    }
    for f in files {
        if real.join(f).is_file() {
            std::fs::copy(real.join(f), tmp.path().join(f)).map_err(|e| format!("copy {f}: {e}"))?;
        }
    }
    Ok(tmp)
}

async fn run(cmd: Cmd, core: &Arc<Core>, sink: &LogSink, dry: bool, fake: bool) -> Result<(), String> {
    if fake {
        for c in fake_portraits(core)? {
            println!("{} fake character {} {} (ref {})", ts(), c.name, c.id, c.ref_ids[0]);
        }
    }
    if matches!(cmd, Cmd::Portraits | Cmd::All) {
        portraits(core, sink).await?;
        if cmd == Cmd::All {
            // The image pod is done; don't keep it billing through planning and rendering.
            pod::stop_for(core, Profile::Image, StopReason::Finished).await?;
        }
    }
    let story_id = if matches!(cmd, Cmd::Plan | Cmd::All) {
        Some(plan(core, dry).await?)
    } else {
        None
    };
    if matches!(cmd, Cmd::Render | Cmd::All) {
        let id = match story_id {
            Some(id) => id,
            None => find_story(core)?,
        };
        render(core, sink, &id).await?;
    }
    Ok(())
}

#[tokio::main]
async fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let cmd = match args.first().map(String::as_str) {
        Some("portraits") => Cmd::Portraits,
        Some("plan") => Cmd::Plan,
        Some("render") => Cmd::Render,
        Some("all") => Cmd::All,
        _ => usage(),
    };
    let (mut dry, mut fake) = (false, false);
    for a in &args[1..] {
        match a.as_str() {
            "--dry-run" => dry = true,
            "--fake-portraits" => fake = true,
            _ => usage(),
        }
    }
    if (dry && cmd != Cmd::Plan) || (fake && !dry) {
        usage();
    }

    let sink = Arc::new(LogSink::default());
    let tmp = if dry { Some(dry_dir(fake).unwrap_or_else(|e| fail(&e))) } else { None };
    let data_dir = match &tmp {
        Some(t) => t.path().to_path_buf(),
        None => app_data_dir().unwrap_or_else(|e| fail(&e)),
    };
    if !dry {
        if let Some(dir) = applog::default_dir() {
            applog::init(&dir);
        }
    }
    println!("{} data dir: {}{}", ts(), data_dir.display(), if dry { " (temporary, dry run)" } else { "" });
    let core = build_core(&data_dir, sink.clone(), !dry).unwrap_or_else(|e| fail(&e));
    // Only real runs touch RunPod (re-adopt pods left running; start the monitor).
    let needs_gpu = !dry && cmd != Cmd::Plan;
    if needs_gpu {
        if let Err(e) = start_background(&core).await {
            fail(&format!("GPU setup failed: {e}"));
        }
    }

    let result = tokio::select! {
        r = run(cmd, &core, &sink, dry, fake) => r,
        _ = tokio::signal::ctrl_c() => Err("Interrupted (Ctrl-C)".to_string()),
    };
    let stopped = !needs_gpu || stop_all_pods(&core).await;
    core.vault.lock();
    drop(tmp);
    match result {
        Ok(()) if stopped => println!("{} done", ts()),
        Ok(()) => std::process::exit(3),
        Err(e) => fail(&e),
    }
}

fn fail(e: &str) -> ! {
    eprintln!("{} ERROR: {e}", ts());
    std::process::exit(1);
}
