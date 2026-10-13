use app_lib::stories::{planner, Character, Story};
use serde_json::json;
use wiremock::matchers::{method, path};
use wiremock::{Mock, MockServer, ResponseTemplate, Request, Respond};
use std::sync::atomic::{AtomicUsize, Ordering};

fn mara() -> Character { Character { id: "c1".into(), name: "Mara".into(), description: "woman in her 30s".into(),
    source: "generated".into(), consent: false, adult: true, ref_ids: vec!["r1".into()], created_at: "t".into(), updated_at: "t".into() } }
fn st(target: u32) -> Story { Story { id: "s1".into(), title: String::new(), logline: String::new(), brief: "A heist on a rooftop".into(),
    target_s: target, aspect: "16:9".into(), style: String::new(), cast: vec!["c1".into()], voices: vec![], status: "draft".into(),
    result_image_id: None, created_at: "t".into(), updated_at: "t".into() } }
#[test]
fn partial_voices_are_accepted_and_stale_entries_dropped() {
    use app_lib::stories::{cast_voices, compile::compile_shot, DialogueLine, Shot, Voice};
    let v = |id: &str, voice: &str| Voice { character_id: id.into(), voice: voice.into() };
    let cast = vec!["c1".to_string(), "c2".to_string()];
    // c2 has no entry (fine); c9 left the cast; empty phrases and duplicates go.
    let kept = cast_voices(&cast, vec![v("c1", " a calm voice "), v("c9", "gone"), v("c2", "  "), v("c1", "second")]);
    assert_eq!(kept, vec![v("c1", "a calm voice")]);

    let ivo = Character { id: "c2".into(), name: "Ivo".into(), ..mara() };
    let story = Story { cast: cast.clone(), voices: kept, ..st(10) };
    let shot = Shot {
        id: "a".into(), story_id: "s1".into(), position: 1, duration_s: 10, characters: cast,
        setting: "A roof".into(), camera: "Wide".into(), action: "They wait.".into(),
        dialogue: vec![
            DialogueLine { speaker: "c1".into(), line: "Go.".into(), delivery: String::new() },
            DialogueLine { speaker: "c2".into(), line: "No.".into(), delivery: String::new() },
        ],
        sound: String::new(), continuity: "cut".into(), approved_take_id: None,
    };
    let p = compile_shot(&story, &shot, &[mara(), ivo], false).unwrap().prompt;
    assert!(p.contains("<Subject 1> (S1), in a calm voice, says: <d>[English] Go.</d> <Subject 2> (S2) says: <d>[English] No.</d>"), "{p}");
}

fn reply(content: &str) -> ResponseTemplate {
    ResponseTemplate::new(200).set_body_json(json!({"choices": [{"message": {"role": "assistant", "content": content}}]}))
}
fn good_plan(dur: u32) -> String {
    json!({"title": "Rooftop", "logline": "Mara escapes.",
        "voices": [{"name": "mara", "voice": "a low, steady female voice with a calm pace"}],
        "shots": [
        {"duration_s": dur, "characters": ["Mara"], "setting": "rooftop", "camera": "wide", "continuity": "cut",
         "action": "Mara runs to the edge.", "dialogue": [{"speaker": "mara", "delivery": "glances back and says", "line": "Now."}],
         "sound": "Wind gusts across the roof."}]}).to_string()
}
struct Seq(Vec<ResponseTemplate>, AtomicUsize);
impl Respond for Seq { fn respond(&self, _: &Request) -> ResponseTemplate {
    let i = self.1.fetch_add(1, Ordering::SeqCst).min(self.0.len() - 1); self.0[i].clone() } }

#[tokio::test]
async fn plan_succeeds_and_maps_names_to_ids() {
    let s = MockServer::start().await;
    Mock::given(method("POST")).and(path("/v1/chat/completions")).respond_with(reply(&good_plan(10))).mount(&s).await;
    let out = planner::plan(&format!("{}/v1", s.uri()), "m", &st(10), &[mara()]).await.unwrap();
    assert!(out.issues.is_empty(), "{:?}", out.issues);
    assert_eq!(out.attempts, 1);
    assert_eq!(out.shots[0].characters, vec!["c1"]);
    assert_eq!(out.shots[0].dialogue[0].speaker, "c1");
    assert_eq!(out.shots[0].dialogue[0].delivery, "glances back and says");
    assert_eq!(out.shots[0].sound, "Wind gusts across the roof.");
    assert_eq!(out.voices, vec![app_lib::stories::Voice { character_id: "c1".into(), voice: "a low, steady female voice with a calm pace".into() }]);
    let body: serde_json::Value = s.received_requests().await.unwrap()[0].body_json().unwrap();
    assert_eq!(body["response_format"]["type"], "json_schema");
    let schema = &body["response_format"]["json_schema"]["schema"];
    assert_eq!(schema["properties"]["voices"]["items"]["required"], json!(["name", "voice"]));
    assert!(schema["properties"]["shots"]["items"]["required"].as_array().unwrap().contains(&json!("sound")));
    let system = body["messages"][0]["content"].as_str().unwrap();
    assert!(system.contains("the last line must end at least 1 second before\n  the shot ends."), "{system}");
    assert!(system.contains("- Mara: woman in her 30s"), "{system}");
    assert!(system.contains("\"voices\": [{\"name\": \"Mara\""), "{system}");
    assert!(!system.contains("Ivo"), "one-character cast gets the one-character example: {system}");
    assert_eq!(body["chat_template_kwargs"]["enable_thinking"], false);
}

#[tokio::test]
async fn repair_loop_sends_errors_back_then_succeeds() {
    let s = MockServer::start().await;
    Mock::given(method("POST")).and(path("/v1/chat/completions"))
        .respond_with(Seq(vec![reply(&good_plan(3)), reply(&good_plan(10))], AtomicUsize::new(0))).mount(&s).await;
    let out = planner::plan(&format!("{}/v1", s.uri()), "m", &st(10), &[mara()]).await.unwrap();
    assert_eq!(out.attempts, 2);
    assert!(out.issues.is_empty());
    let second: serde_json::Value = s.received_requests().await.unwrap()[1].body_json().unwrap();
    let last = second["messages"].as_array().unwrap().last().unwrap()["content"].as_str().unwrap().to_string();
    assert!(last.contains("5–15"), "{last}");
}

#[tokio::test]
async fn three_failures_return_best_attempt_with_issues() {
    let s = MockServer::start().await;
    Mock::given(method("POST")).and(path("/v1/chat/completions")).respond_with(reply(&good_plan(3))).mount(&s).await;
    let out = planner::plan(&format!("{}/v1", s.uri()), "m", &st(10), &[mara()]).await.unwrap();
    assert_eq!(out.attempts, 3);
    assert!(!out.issues.is_empty());
    assert_eq!(out.shots.len(), 1);
}

#[tokio::test]
async fn falls_back_when_json_schema_is_rejected() {
    let s = MockServer::start().await;
    Mock::given(method("POST")).and(path("/v1/chat/completions"))
        .respond_with(Seq(vec![ResponseTemplate::new(400).set_body_json(json!({"error": "response_format json_schema not supported"})),
            reply(&good_plan(10))], AtomicUsize::new(0))).mount(&s).await;
    let out = planner::plan(&format!("{}/v1", s.uri()), "m", &st(10), &[mara()]).await.unwrap();
    assert!(out.issues.is_empty());
    assert_eq!(out.attempts, 1);
    let second: serde_json::Value = s.received_requests().await.unwrap()[1].body_json().unwrap();
    assert!(second.get("response_format").is_none());
}

#[test]
fn parses_fenced_and_think_wrapped_json() {
    let v = planner::parse_reply("<think>hmm</think>\nHere you go:\n```json\n{\"title\": \"A\", \"shots\": []}\n```").unwrap();
    assert_eq!(v["title"], "A");
}

#[tokio::test]
async fn unknown_character_name_becomes_issue() {
    let s = MockServer::start().await;
    let bad = good_plan(10).replace("[\"Mara\"]", "[\"Zed\"]");
    Mock::given(method("POST")).and(path("/v1/chat/completions")).respond_with(reply(&bad)).mount(&s).await;
    let out = planner::plan(&format!("{}/v1", s.uri()), "m", &st(10), &[mara()]).await.unwrap();
    assert!(out.issues.iter().any(|i| i.message.contains("Zed")), "{:?}", out.issues);
}

#[tokio::test]
async fn unknown_voice_name_becomes_issue() {
    let s = MockServer::start().await;
    let bad = good_plan(10).replace("{\"name\":\"mara\"", "{\"name\":\"Zed\"");
    assert!(bad.contains("Zed"), "{bad}");
    Mock::given(method("POST")).and(path("/v1/chat/completions")).respond_with(reply(&bad)).mount(&s).await;
    let out = planner::plan(&format!("{}/v1", s.uri()), "m", &st(10), &[mara()]).await.unwrap();
    assert!(out.issues.iter().any(|i| i.shot.is_none() && i.message == "Zed is not in the cast"), "{:?}", out.issues);
    assert!(out.voices.is_empty());
}

#[tokio::test]
async fn planned_minor_voice_becomes_issue() {
    let s = MockServer::start().await;
    let bad = good_plan(10).replace("a low, steady female voice with a calm pace", "a young girl's voice");
    Mock::given(method("POST")).and(path("/v1/chat/completions")).respond_with(reply(&bad)).mount(&s).await;
    let out = planner::plan(&format!("{}/v1", s.uri()), "m", &st(10), &[mara()]).await.unwrap();
    assert!(out.issues.iter().any(|i| i.message == "Mara's voice must describe an adult; stories use adults only"), "{:?}", out.issues);
    let system = planner::system_prompt(&st(10), &[mara()]);
    assert!(system.contains("Example: \"A medium shot frames Mara in the center;"), "{system}");
    assert!(!system.contains("the other character"), "{system}");
}

#[test]
fn two_character_cast_gets_the_research_example_with_its_names() {
    let ivo = Character { id: "c2".into(), name: "Ivo".into(), ..mara() };
    let p = planner::system_prompt(&st(10), &[mara(), ivo]);
    assert!(p.contains("\"delivery\": \"turns her head toward Ivo and says quietly\", \"line\": \"We leave tonight.\""), "{p}");
    assert!(p.contains("Example: \"A medium two-shot frames Mara on the left and Ivo on the right;"), "{p}");
    assert!(p.contains("The first sentence of action is the opening\n  state before anyone speaks."), "{p}");
}

#[tokio::test]
async fn unreachable_server_gives_lm_studio_hint() {
    let e = planner::plan("http://127.0.0.1:9/v1", "m", &st(10), &[mara()]).await.unwrap_err();
    assert!(e.contains("LM Studio"), "{e}");
}

#[tokio::test]
async fn unusable_first_attempt_does_not_beat_later_plan_with_shots() {
    let s = MockServer::start().await;
    Mock::given(method("POST")).and(path("/v1/chat/completions"))
        .respond_with(Seq(vec![reply("sorry, no json here"), reply(&good_plan(3))], AtomicUsize::new(0))).mount(&s).await;
    let out = planner::plan(&format!("{}/v1", s.uri()), "m", &st(10), &[mara()]).await.unwrap();
    assert_eq!(out.attempts, 3);
    assert_eq!(out.shots.len(), 1);
    assert!(!out.issues.is_empty());
}

#[tokio::test]
async fn all_unparseable_replies_error() {
    let s = MockServer::start().await;
    Mock::given(method("POST")).and(path("/v1/chat/completions")).respond_with(reply("no json")).mount(&s).await;
    let e = planner::plan(&format!("{}/v1", s.uri()), "m", &st(10), &[mara()]).await.unwrap_err();
    assert!(e.contains("nothing usable"), "{e}");
}

// ----- command-layer helpers -----

#[test]
fn check_character_names_each_problem() {
    use app_lib::stories::store::check_character;
    let good = Character { ref_ids: vec!["r1".into(), "r2".into()], ..mara() };
    check_character(&good).unwrap();
    let err = |f: fn(&mut Character)| {
        let mut c = good.clone();
        f(&mut c);
        check_character(&c).unwrap_err()
    };
    assert!(err(|c| c.name = "  ".into()).contains("name"));
    assert!(err(|c| c.name = "x".repeat(41)).contains("40 characters"));
    assert!(err(|c| c.description = "x".repeat(201)).contains("200 characters"));
    assert!(err(|c| c.ref_ids = vec![]).contains("reference image"));
    assert!(err(|c| c.ref_ids = vec!["a".into(), "b".into(), "c".into(), "d".into()]).contains("at most 3 reference images"));
    assert_eq!(err(|c| c.adult = false), "Mara is not confirmed as an adult (18+)");
    assert_eq!(err(|c| c.source = "real_person".into()), "Mara is a real person without a consent tick");
    assert!(err(|c| c.description = "a teen".into()).contains("adult"));
    assert!(err(|c| c.source = "robot".into()).contains("source"));
    let real = Character { source: "real_person".into(), consent: true, ..good.clone() };
    check_character(&real).unwrap();
}

#[test]
fn merge_shots_renumbers_keeps_ids_and_clears_edited_approvals() {
    use app_lib::stories::{store::merge_shots, Shot};
    let shot = |id: &str, pos: u32, approved: Option<&str>| Shot {
        id: id.into(), story_id: "s1".into(), position: pos, duration_s: 8, characters: vec!["c1".into()],
        setting: "roof".into(), camera: "wide".into(), action: "walks".into(), dialogue: vec![],
        sound: String::new(), continuity: "cut".into(), approved_take_id: approved.map(String::from),
    };
    let existing = vec![shot("a", 1, Some("ta")), shot("b", 2, Some("tb"))];
    let mut edited_b = shot("b", 9, Some("tb"));
    edited_b.action = "runs".into();
    // Incoming approvals are ignored; the stored ones are kept unless the text changed.
    let incoming = vec![edited_b, shot("", 0, Some("bogus")), shot("a", 5, None)];
    let out = merge_shots("s1", &existing, incoming);
    assert_eq!(out.iter().map(|s| s.position).collect::<Vec<_>>(), vec![1, 2, 3]);
    assert_eq!(out[0].id, "b");
    assert_eq!(out[0].approved_take_id, None, "edited text clears the approval");
    assert!(!out[1].id.is_empty());
    assert_eq!(out[1].approved_take_id, None);
    assert_eq!(out[2].id, "a");
    assert_eq!(out[2].approved_take_id.as_deref(), Some("ta"), "moved but unchanged keeps it");
    assert!(out.iter().all(|s| s.story_id == "s1"));
}

#[tokio::test]
async fn llm_model_resolution() {
    use app_lib::stories::resolve_llm_model;
    let s = MockServer::start().await;
    Mock::given(method("GET")).and(path("/v1/models"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({"data": [{"id": "qwen3-27b"}, {"id": "gemma"}]})))
        .mount(&s).await;
    let base = format!("{}/v1", s.uri());
    assert_eq!(resolve_llm_model(&base, "gemma").await.unwrap(), "gemma");
    assert_eq!(resolve_llm_model(&base, "not-loaded").await.unwrap(), "qwen3-27b");

    let empty = MockServer::start().await;
    Mock::given(method("GET")).and(path("/v1/models"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({"data": []}))).mount(&empty).await;
    let e = resolve_llm_model(&format!("{}/v1", empty.uri()), "m").await.unwrap_err();
    assert_eq!(e, "Load a model in LM Studio first");

    let e = resolve_llm_model("http://127.0.0.1:9/v1", "m").await.unwrap_err();
    assert_eq!(e, planner::LM_STUDIO_HINT);
}

// ----- render orchestration (mocked video pod) -----

mod render_harness {
    use app_lib::db::{Db, ImageRecord};
    use app_lib::jobs::{Job, JobState};
    use app_lib::pod::{self, GpuStatus, Profile};
    use app_lib::registry::Registry;
    use app_lib::settings::{MemoryStore, SecretStore, Settings, ACCOUNT_POD_TOKEN, ACCOUNT_RUNPOD};
    use app_lib::state::{Clock, Core, CoreConfig, EventSink};
    use app_lib::status::StatusView;
    use app_lib::stories::{ffmpeg, store, Character, DialogueLine, Shot, Story};
    use app_lib::tasks::Task;
    use base64::Engine;
    use serde_json::{json, Value};
    use std::collections::HashMap;
    use std::sync::{Arc, Mutex};
    use std::time::Duration;
    use wiremock::matchers::{method, path, path_regex};
    use wiremock::{Mock, MockServer, Request, Respond, ResponseTemplate};

    const VID: &str = "image-studio-video-gpu";

    #[derive(Default)]
    pub struct Collect {
        pub jobs: Mutex<Vec<Job>>,
    }
    impl EventSink for Collect {
        fn job_update(&self, j: &Job) {
            self.jobs.lock().unwrap().push(j.clone());
        }
        fn task_update(&self, _: &Task) {}
        fn status_update(&self, _: &StatusView) {}
    }

    pub struct Harness {
        pub core: Arc<Core>,
        pub sink: Arc<Collect>,
        pub _dir: tempfile::TempDir,
    }

    fn ok(v: Value) -> ResponseTemplate {
        ResponseTemplate::new(200).set_body_json(v)
    }

    /// A tiny decodable MP4 with audio (ffmpeg), or a header-only stand-in when ffmpeg is missing.
    fn clip_bytes() -> Vec<u8> {
        if let Ok(ff) = ffmpeg::find_ffmpeg() {
            let dir = tempfile::tempdir().unwrap();
            let p = dir.path().join("clip.mp4");
            let st = std::process::Command::new(&ff)
                .args([
                    "-hide_banner", "-loglevel", "error",
                    "-f", "lavfi", "-i", "color=c=red:s=320x180:d=1:r=24",
                    "-f", "lavfi", "-i", "sine=frequency=440:duration=1",
                    "-shortest", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-y",
                ])
                .arg(&p)
                .status()
                .unwrap();
            assert!(st.success());
            return std::fs::read(&p).unwrap();
        }
        let mut v = vec![0, 0, 0, 0x18];
        v.extend_from_slice(b"ftypisom\0\0\x02\0isomiso2");
        v.extend_from_slice(&[0u8; 64]);
        v
    }

    pub fn has_ffmpeg() -> bool {
        let ok = ffmpeg::find_ffmpeg().is_ok();
        if !ok {
            eprintln!("ffmpeg not installed; skipping");
        }
        ok
    }

    /// Pod-server `/run` + `/status`: IN_PROGRESS once, then COMPLETED with `output`.
    async fn mount_pod_job(server: &MockServer, pod_id: &str, output: Value) {
        Mock::given(method("POST"))
            .and(path(format!("/proxy/{pod_id}/run")))
            .respond_with(ok(json!({"id": "rj1", "status": "IN_QUEUE"})))
            .mount(server)
            .await;
        struct Two(Value, std::sync::atomic::AtomicUsize);
        impl Respond for Two {
            fn respond(&self, _: &Request) -> ResponseTemplate {
                if self.1.fetch_add(1, std::sync::atomic::Ordering::SeqCst) == 0 {
                    ok(json!({"id": "rj1", "status": "IN_PROGRESS", "output": {"phase": "sampling"}}))
                } else {
                    ok(json!({"id": "rj1", "status": "COMPLETED", "delayTime": 5, "executionTime": 9000, "output": self.0}))
                }
            }
        }
        Mock::given(method("GET"))
            .and(path(format!("/proxy/{pod_id}/status/rj1")))
            .respond_with(Two(output, Default::default()))
            .mount(server)
            .await;
    }

    /// Core with the embedded registry (real `h3ref`), a running video pod `vid1` and a pod job
    /// that returns a tiny MP4.
    pub async fn video_harness() -> (Harness, MockServer) {
        let server = MockServer::start().await;
        let pod = json!({"id": "vid1", "name": VID, "status": "RUNNING", "cost": 2.39,
            "gpu": {"id": "NVIDIA H200", "count": 1}, "dataCenterId": "CA-MTL-3",
            "createdAt": "2026-10-09T10:00:00Z", "startedAt": "2026-10-09T10:00:05Z", "env": {}});
        Mock::given(method("GET")).and(path("/v2/pods"))
            .respond_with(ok(json!({"pods": [pod.clone()], "pagination": {"hasNextPage": false}})))
            .mount(&server).await;
        Mock::given(method("GET")).and(path("/v2/pods/vid1")).respond_with(ok(pod)).mount(&server).await;
        Mock::given(method("GET")).and(path("/v2/network-volumes"))
            .respond_with(ok(json!({"networkVolumes": [
                {"id": "v7hzxkm304", "name": "image-studio-video", "size": 150, "dataCenter": "CA-MTL-3"}]})))
            .mount(&server).await;
        Mock::given(method("GET")).and(path_regex(r"^/proxy/[^/]+/ping$"))
            .respond_with(ok(json!({"status": "ok"}))).mount(&server).await;
        Mock::given(method("GET")).and(path_regex(r"^/proxy/[^/]+/health$"))
            .respond_with(ok(json!({"ready": true, "jobs": {}, "workers": {"idle": 1, "running": 0}})))
            .mount(&server).await;
        let b64 = base64::engine::general_purpose::STANDARD.encode(clip_bytes());
        mount_pod_job(&server, "vid1", json!({"video": {"base64": b64, "mime": "video/mp4"}})).await;

        let dir = tempfile::tempdir().unwrap();
        let secrets = Arc::new(MemoryStore::default());
        secrets.set(ACCOUNT_RUNPOD, Some("test-key")).unwrap();
        secrets.set(ACCOUNT_POD_TOKEN, Some("podtok")).unwrap();
        let settings = Settings::new(secrets, HashMap::new(), dir.path().join("settings.json"));
        let sink = Arc::new(Collect::default());
        let clock: Clock = Arc::new(chrono::Utc::now);
        let cfg = CoreConfig {
            data_dir: dir.path().to_path_buf(),
            runpod_root: server.uri(),
            civitai_root: server.uri(),
            hf_root: server.uri(),
            poll_interval: Duration::from_millis(10),
            rest_root: server.uri(),
            pod_proxy_template: format!("{}/proxy/{{podId}}", server.uri()),
            pod_poll_interval: Duration::from_millis(10),
            pod_start_timeout: Duration::from_secs(5),
            gpu_wait_timeout: Duration::from_millis(300),
            pod_stop_timeout: Duration::from_secs(2),
            rest_timeout: Duration::from_secs(1),
            clock,
        };
        let core = Core::new(Registry::embedded(), Db::open_in_memory().unwrap(), settings, sink.clone(), cfg).unwrap();
        pod::adopt_for(&core, Profile::Video).await.unwrap();
        for _ in 0..500 {
            if pod::state_for(&core, Profile::Video).status == GpuStatus::Running {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        assert_eq!(pod::state_for(&core, Profile::Video).status, GpuStatus::Running);
        (Harness { core, sink, _dir: dir }, server)
    }

    fn png_bytes() -> Vec<u8> {
        let img = image::RgbImage::from_pixel(64, 36, image::Rgb([1, 2, 3]));
        let mut buf = Vec::new();
        image::DynamicImage::ImageRgb8(img)
            .write_to(&mut std::io::Cursor::new(&mut buf), image::ImageFormat::Png)
            .unwrap();
        buf
    }

    /// One adult generated character "Mara" with 2 imported refs, a 16:9 story casting her and
    /// shots `(continuity, duration_s)` in order. Returns (story_id, shot ids).
    pub fn seed_story(core: &Core, shots: &[(&str, u32)]) -> (String, Vec<String>) {
        let dir = core.cfg.references_dir();
        let refs: Vec<String> = (0..2)
            .map(|_| app_lib::references::import_bytes(&dir, &png_bytes()).unwrap().ref_id)
            .collect();
        let mara = Character {
            id: "c-mara".into(), name: "Mara".into(), description: "woman in her 30s, short black hair".into(),
            source: "generated".into(), consent: false, adult: true, ref_ids: refs,
            created_at: "t".into(), updated_at: "t".into(),
        };
        let story = Story {
            id: "s-1".into(), title: "Rooftop".into(), logline: String::new(), brief: "A heist on a rooftop".into(),
            target_s: shots.iter().map(|s| s.1).sum(), aspect: "16:9".into(), style: String::new(),
            cast: vec![mara.id.clone()], voices: vec![], status: "planned".into(), result_image_id: None,
            created_at: "t".into(), updated_at: "t".into(),
        };
        let list: Vec<Shot> = shots
            .iter()
            .enumerate()
            .map(|(i, (cont, dur))| Shot {
                id: format!("shot-{}", i + 1), story_id: story.id.clone(), position: i as u32 + 1, duration_s: *dur,
                characters: vec![mara.id.clone()], setting: "rooftop at night".into(), camera: "wide".into(),
                action: "Mara runs to the edge.".into(),
                dialogue: vec![DialogueLine { speaker: mara.id.clone(), line: "Now.".into(), delivery: String::new() }],
                sound: String::new(), continuity: cont.to_string(), approved_take_id: None,
            })
            .collect();
        let db = core.db.lock().unwrap();
        store::save_character(&db, &mara).unwrap();
        store::save_story(&db, &story).unwrap();
        store::replace_shots(&db, &story.id, &list).unwrap();
        (story.id, list.into_iter().map(|s| s.id).collect())
    }

    /// Waits for `job_id` to complete and returns its saved record.
    pub async fn wait_video(h: &Harness, job_id: &str) -> ImageRecord {
        for _ in 0..1000 {
            let done = h.sink.jobs.lock().unwrap().iter().rev()
                .find(|j| j.job_id == job_id && matches!(j.status, JobState::Completed | JobState::Failed | JobState::Cancelled))
                .cloned();
            if let Some(j) = done {
                assert_eq!(j.status, JobState::Completed, "{:?}", j.error);
                let id = j.images[0].id.clone();
                return h.core.db.lock().unwrap().get_image(&id).unwrap().unwrap();
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        panic!("job {job_id} did not finish");
    }

    /// `input` of the last `/run` sent to the pod.
    pub async fn last_run_input(server: &MockServer) -> Value {
        let reqs = server.received_requests().await.unwrap();
        let run = reqs.iter().rev().find(|r| r.url.path() == "/proxy/vid1/run").expect("no /run");
        run.body_json::<Value>().unwrap()["input"].clone()
    }
}

use app_lib::stories::render;
use render_harness::{has_ffmpeg, last_run_input, seed_story, video_harness, wait_video};

#[tokio::test]
async fn render_shot_queues_h3ref_job_with_compiled_prompt_and_refs() {
    let (h, server) = video_harness().await;
    let (story_id, shot_ids) = seed_story(&h.core, &[("cut", 8)]);
    let job = render::render_shot(&h.core, &shot_ids[0]).unwrap();
    let rec = wait_video(&h, &job).await;
    assert_eq!(rec.story_id.as_deref(), Some(story_id.as_str()));
    assert_eq!(rec.shot_id.as_deref(), Some(shot_ids[0].as_str()));
    let body = last_run_input(&server).await;
    assert_eq!(body["model"], "h3ref");
    assert_eq!(body["resolution"], "1344x768");
    assert_eq!(body["durationS"], 8.0);
    assert_eq!(body["references"].as_array().unwrap().len(), 2);
    let prompt = body["prompt"].as_str().unwrap();
    assert!(prompt.starts_with("subject_definitions:\n<Subject 1> is Mara, the person in <Picture 1> and <Picture 2>: woman in her 30s, short black hair.\n\nsummary:\n[reference generation] "), "{prompt}");
    assert!(prompt.contains("<Subject 1> (S1) says: <d>[English] Now.</d>"), "{prompt}");
    assert!(!prompt.contains("<Picture 3>"), "{prompt}");
    assert!(body.get("initImage").is_none());
    let (page, _) = h.core.db.lock().unwrap().list_images(100, None).unwrap();
    assert!(page.iter().all(|r| r.id != rec.id), "takes stay out of the gallery");
    let view = render::story_view(&h.core, &story_id).unwrap();
    assert_eq!(view.takes.len(), 1);
    assert_eq!(view.cast[0].name, "Mara");
    assert!(view.issues.is_empty(), "{:?}", view.issues);
}

#[tokio::test]
async fn continues_shot_requires_approved_previous() {
    let (h, _server) = video_harness().await;
    let (_, shot_ids) = seed_story(&h.core, &[("cut", 8), ("continues", 8)]);
    let e = render::render_shot(&h.core, &shot_ids[1]).unwrap_err();
    assert!(e.contains("Approve shot 1 first"), "{e}");
}

#[tokio::test]
async fn render_story_skips_waiting_continues_shots() {
    let (h, _server) = video_harness().await;
    let (story_id, shot_ids) = seed_story(&h.core, &[("cut", 8), ("continues", 8), ("cut", 8)]);
    let queued = render::render_story(&h.core, &story_id).unwrap();
    let ids: Vec<&str> = queued.iter().map(|q| q.0.as_str()).collect();
    assert_eq!(ids, vec![shot_ids[0].as_str(), shot_ids[2].as_str()]);
    for (_, job) in &queued {
        wait_video(&h, job).await;
    }
    // Shots with takes are not re-rendered.
    assert!(render::render_story(&h.core, &story_id).unwrap().is_empty());
}

#[tokio::test]
async fn approving_a_shot_queues_the_continuing_shot_with_its_last_frame() {
    if !has_ffmpeg() {
        return;
    }
    let (h, server) = video_harness().await;
    let (_, shot_ids) = seed_story(&h.core, &[("cut", 8), ("continues", 8)]);
    let take = wait_video(&h, &render::render_shot(&h.core, &shot_ids[0]).unwrap()).await;
    let queued = render::approve_take(&h.core, &shot_ids[0], &take.id).unwrap().unwrap();
    assert_eq!(queued.0, shot_ids[1]);
    wait_video(&h, &queued.1).await;
    let body = last_run_input(&server).await;
    assert!(body["initImage"]["base64"].as_str().unwrap().len() > 100);
    // 2 character refs + the previous shot's last frame as <Picture 3>.
    let refs = body["references"].as_array().unwrap();
    assert_eq!(refs.len(), 3);
    assert_eq!(refs[2]["base64"], body["initImage"]["base64"], "the frame is the last reference");
    let prompt = body["prompt"].as_str().unwrap();
    assert!(prompt.contains("\n<Picture 3> is the first frame of [Shot 1], the last frame of the previous shot.\n"), "{prompt}");
    assert!(prompt.contains("summary:\n[keyframe completion + reference generation] "), "{prompt}");
    assert!(prompt.contains("<Picture 3> ([Shot 1] first frame): fully_preserved - the shot starts exactly from this frame."), "{prompt}");
    assert!(prompt.contains("[Shot 1] The shot begins from <Picture 3>. wide."), "{prompt}");
    // A take of another shot can't be approved here.
    let e = render::approve_take(&h.core, &shot_ids[1], &take.id).unwrap_err();
    assert!(e.contains("another shot"), "{e}");
}

#[tokio::test]
async fn render_refuses_invalid_story_and_unconsented_real_person() {
    let (h, _server) = video_harness().await;
    let (_, shot_ids) = seed_story(&h.core, &[("cut", 3)]); // 3 s is invalid
    let e = render::render_shot(&h.core, &shot_ids[0]).unwrap_err();
    assert!(e.contains("5–15"), "{e}");

    let (h, _server) = video_harness().await;
    let (_, shot_ids) = seed_story(&h.core, &[("cut", 8)]);
    {
        let db = h.core.db.lock().unwrap();
        let mut c = app_lib::stories::store::get_character(&db, "c-mara").unwrap().unwrap();
        c.source = "real_person".into();
        app_lib::stories::store::save_character(&db, &c).unwrap();
    }
    let e = render::render_shot(&h.core, &shot_ids[0]).unwrap_err();
    assert!(e.contains("Mara is a real person without a consent tick"), "{e}");
}

#[tokio::test]
async fn assemble_requires_all_approved_and_saves_gallery_video() {
    if !has_ffmpeg() {
        return;
    }
    let (h, _server) = video_harness().await;
    let (story_id, shot_ids) = seed_story(&h.core, &[("cut", 8), ("cut", 8)]);
    let t1 = wait_video(&h, &render::render_shot(&h.core, &shot_ids[0]).unwrap()).await;
    render::approve_take(&h.core, &shot_ids[0], &t1.id).unwrap();
    let e = render::assemble_story(&h.core, &story_id).unwrap_err();
    assert!(e.contains("shot 2"), "{e}");
    let t2 = wait_video(&h, &render::render_shot(&h.core, &shot_ids[1]).unwrap()).await;
    render::approve_take(&h.core, &shot_ids[1], &t2.id).unwrap();
    let out = render::assemble_story(&h.core, &story_id).unwrap();
    assert_eq!(out.story_id.as_deref(), Some(story_id.as_str()));
    assert_eq!(out.shot_id, None);
    assert!(std::path::Path::new(&out.path).is_file());
    assert!(std::path::Path::new(out.poster_path.as_deref().unwrap()).is_file());
    let (page, _) = h.core.db.lock().unwrap().list_images(100, None).unwrap();
    assert!(page.iter().any(|r| r.id == out.id));
    // Re-assembling replaces the previous result.
    let again = render::assemble_story(&h.core, &story_id).unwrap();
    assert!(!std::path::Path::new(&out.path).exists());
    assert!(h.core.db.lock().unwrap().get_image(&out.id).unwrap().is_none());
    let view = render::story_view(&h.core, &story_id).unwrap();
    assert_eq!(view.story.result_image_id.as_deref(), Some(again.id.as_str()));
    assert_eq!(view.story.status, "assembled");
}

// ----- fix round 1: no duplicate renders, pre-plan safety gate -----

#[tokio::test]
async fn second_render_of_a_shot_is_refused_while_the_first_runs() {
    let (h, _server) = video_harness().await;
    let (_, shot_ids) = seed_story(&h.core, &[("cut", 8)]);
    let job = render::render_shot(&h.core, &shot_ids[0]).unwrap();
    let e = render::render_shot(&h.core, &shot_ids[0]).unwrap_err();
    assert_eq!(e, "Shot 1 is already rendering");
    wait_video(&h, &job).await;
    // Finished jobs no longer count (reroll).
    let again = render::render_shot(&h.core, &shot_ids[0]).unwrap();
    wait_video(&h, &again).await;
}

#[tokio::test]
async fn render_story_twice_queues_each_shot_once() {
    let (h, server) = video_harness().await;
    let (story_id, _) = seed_story(&h.core, &[("cut", 8), ("cut", 8)]);
    let first = render::render_story(&h.core, &story_id).unwrap();
    assert_eq!(first.len(), 2);
    assert!(render::render_story(&h.core, &story_id).unwrap().is_empty());
    for (_, job) in &first {
        wait_video(&h, job).await;
    }
    let runs = server.received_requests().await.unwrap().iter().filter(|r| r.url.path() == "/proxy/vid1/run").count();
    assert_eq!(runs, 2);
}

/// Points the app's LLM settings at a mock LM Studio (models + chat).
async fn mock_llm(core: &app_lib::state::Core, shots_json: String) -> MockServer {
    let s = MockServer::start().await;
    Mock::given(method("GET")).and(path("/v1/models"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({"data": [{"id": "m"}]}))).mount(&s).await;
    Mock::given(method("POST")).and(path("/v1/chat/completions")).respond_with(reply(&shots_json)).mount(&s).await;
    core.settings.save_llm(Some(format!("{}/v1", s.uri())), Some("m".into())).unwrap();
    s
}

#[tokio::test]
async fn plan_story_refuses_unsafe_stories_without_contacting_the_llm() {
    use app_lib::stories::store;
    let (h, _server) = video_harness().await;
    let (story_id, _) = seed_story(&h.core, &[("cut", 8)]);
    let llm = mock_llm(&h.core, good_plan(8)).await;
    let edit_story = |f: &dyn Fn(&mut Story)| {
        let db = h.core.db.lock().unwrap();
        let mut s = store::get_story(&db, &story_id).unwrap().unwrap();
        f(&mut s);
        store::save_story(&db, &s).unwrap();
    };
    let edit_mara = |f: &dyn Fn(&mut Character)| {
        let db = h.core.db.lock().unwrap();
        let mut c = store::get_character(&db, "c-mara").unwrap().unwrap();
        f(&mut c);
        store::save_character(&db, &c).unwrap();
    };

    edit_story(&|s| s.brief = "A teen heist on a rooftop".into());
    let e = render::plan_story(&h.core, &story_id).await.unwrap_err();
    assert!(e.contains("adults only"), "{e}");
    edit_story(&|s| s.brief = "A heist on a rooftop".into());

    edit_mara(&|c| c.adult = false);
    let e = render::plan_story(&h.core, &story_id).await.unwrap_err();
    assert_eq!(e, "Mara is not confirmed as an adult (18+)");
    edit_mara(&|c| c.adult = true);

    edit_mara(&|c| c.source = "real_person".into());
    let e = render::plan_story(&h.core, &story_id).await.unwrap_err();
    assert_eq!(e, "Mara is a real person without a consent tick");
    assert!(llm.received_requests().await.unwrap().is_empty(), "nothing reached the LLM");

    // Once safe, planning goes through and replaces the shots.
    edit_mara(&|c| c.consent = true);
    let view = render::plan_story(&h.core, &story_id).await.unwrap();
    assert_eq!(view.story.status, "planned");
    assert_eq!(view.shots.len(), 1);
    assert!(view.issues.is_empty(), "{:?}", view.issues);
}

#[tokio::test]
async fn story_view_of_a_fresh_draft_reports_cast_issues() {
    use app_lib::stories::store;
    let (h, _server) = video_harness().await;
    let (story_id, _) = seed_story(&h.core, &[]);
    {
        let db = h.core.db.lock().unwrap();
        let mut s = store::get_story(&db, &story_id).unwrap().unwrap();
        s.status = "draft".into();
        store::save_story(&db, &s).unwrap();
        let mut c = store::get_character(&db, "c-mara").unwrap().unwrap();
        c.adult = false;
        store::save_character(&db, &c).unwrap();
    }
    let view = render::story_view(&h.core, &story_id).unwrap();
    let msgs: Vec<&str> = view.issues.iter().map(|i| i.message.as_str()).collect();
    assert_eq!(msgs, vec!["Mara is not confirmed as an adult (18+)"], "no 'no shots' issue on a draft");
}
