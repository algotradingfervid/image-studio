use app_lib::stories::{planner, Character, Story};
use serde_json::json;
use wiremock::matchers::{method, path};
use wiremock::{Mock, MockServer, ResponseTemplate, Request, Respond};
use std::sync::atomic::{AtomicUsize, Ordering};

fn mara() -> Character { Character { id: "c1".into(), name: "Mara".into(), description: "woman in her 30s".into(),
    source: "generated".into(), consent: false, adult: true, ref_ids: vec!["r1".into()], ref_paths: vec![], vault: false, created_at: "t".into(), updated_at: "t".into() } }
fn st(target: u32) -> Story { Story { id: "s1".into(), title: String::new(), logline: String::new(), brief: "A heist on a rooftop".into(),
    target_s: target, aspect: "16:9".into(), style: String::new(), cast: vec!["c1".into()], voices: vec![], status: "draft".into(),
    result_image_id: None, vault: false, created_at: "t".into(), updated_at: "t".into() } }
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
    let msgs = second["messages"].as_array().unwrap();
    let last = msgs[msgs.len() - 2]["content"].as_str().unwrap().to_string();
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
        // Like the worker, the pod reports the clip's real size (`clip_bytes` is 320x180).
        mount_pod_job(&server, "vid1", json!({"video": {"base64": b64, "mime": "video/mp4", "width": 320, "height": 180}})).await;

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
            source: "generated".into(), consent: false, adult: true, ref_ids: refs, ref_paths: vec![], vault: false,
            created_at: "t".into(), updated_at: "t".into(),
        };
        let story = Story {
            id: "s-1".into(), title: "Rooftop".into(), logline: String::new(), brief: "A heist on a rooftop".into(),
            target_s: shots.iter().map(|s| s.1).sum(), aspect: "16:9".into(), style: String::new(),
            cast: vec![mara.id.clone()], voices: vec![], status: "planned".into(), result_image_id: None, vault: false,
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
    let all = render::render_story(&h.core, &story_id).unwrap();
    assert_eq!(all.error, None);
    let queued = all.queued;
    let ids: Vec<&str> = queued.iter().map(|q| q.0.as_str()).collect();
    assert_eq!(ids, vec![shot_ids[0].as_str(), shot_ids[2].as_str()]);
    for (_, job) in &queued {
        wait_video(&h, job).await;
    }
    // Shots with takes are not re-rendered.
    assert!(render::render_story(&h.core, &story_id).unwrap().queued.is_empty());
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
    assert!(!page.iter().any(|r| r.id == out.id), "the film lives in its story, not the gallery");
    // Re-assembling replaces the previous result.
    let again = render::assemble_story(&h.core, &story_id).unwrap();
    assert!(!std::path::Path::new(&out.path).exists());
    assert!(h.core.db.lock().unwrap().get_image(&out.id).unwrap().is_none());
    let view = render::story_view(&h.core, &story_id).unwrap();
    assert_eq!(view.story.result_image_id.as_deref(), Some(again.id.as_str()));
    assert_eq!(view.story.status, "assembled");
    assert_eq!(view.result.map(|r| r.id), Some(again.id));
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
    let first = render::render_story(&h.core, &story_id).unwrap().queued;
    assert_eq!(first.len(), 2);
    assert!(render::render_story(&h.core, &story_id).unwrap().queued.is_empty());
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
    core.settings.save_planner_location(false).unwrap();
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

// ----- final review fixes -----

fn set_shot(core: &app_lib::state::Core, shot_id: &str, f: &dyn Fn(&mut app_lib::stories::Shot)) {
    let db = core.db.lock().unwrap();
    let mut s = app_lib::stories::store::get_shot(&db, shot_id).unwrap().unwrap();
    f(&mut s);
    app_lib::stories::store::update_shot(&db, &s).unwrap();
}

/// Waits for `job_id` to end (any final state) and returns its last update.
async fn wait_end(h: &render_harness::Harness, job_id: &str) -> app_lib::jobs::Job {
    use app_lib::jobs::JobState;
    for _ in 0..1000 {
        let done = h.sink.jobs.lock().unwrap().iter().rev()
            .find(|j| j.job_id == job_id && matches!(j.status, JobState::Completed | JobState::Failed | JobState::Cancelled))
            .cloned();
        if let Some(j) = done {
            return j;
        }
        tokio::time::sleep(std::time::Duration::from_millis(10)).await;
    }
    panic!("job {job_id} did not finish");
}

#[tokio::test]
async fn update_story_patch_writes_only_the_given_fields() {
    use app_lib::stories::{StoryPatch, Voice};
    let (h, _server) = video_harness().await;
    let (story_id, _) = seed_story(&h.core, &[("cut", 8)]);
    let voice = Voice { character_id: "c-mara".into(), voice: "a low, steady voice".into() };
    // The workspace saves the voices only.
    let v = render::update_story(&h.core, &story_id, StoryPatch { voices: Some(vec![voice.clone()]), ..Default::default() }).unwrap();
    assert_eq!(v.story.voices, vec![voice.clone()]);
    assert_eq!(v.story.brief, "A heist on a rooftop");
    // The panel then saves its fields from a copy that predates the voice edit: the voices stay.
    let v = render::update_story(&h.core, &story_id, StoryPatch {
        brief: Some("  A chase on a rooftop ".into()), target_s: Some(8), aspect: Some("16:9".into()),
        style: Some("35 mm".into()), cast: Some(vec!["c-mara".into()]), ..Default::default()
    }).unwrap();
    assert_eq!(v.story.voices, vec![voice]);
    assert_eq!((v.story.brief.as_str(), v.story.title.as_str(), v.story.style.as_str()), ("A chase on a rooftop", "Rooftop", "35 mm"));
    // A title-only rename keeps the brief.
    let v = render::update_story(&h.core, &story_id, StoryPatch { title: Some(" Night run ".into()), ..Default::default() }).unwrap();
    assert_eq!((v.story.title.as_str(), v.story.brief.as_str()), ("Night run", "A chase on a rooftop"));
    // Validated as before.
    let e = render::update_story(&h.core, &story_id, StoryPatch { brief: Some(" ".into()), ..Default::default() }).unwrap_err();
    assert_eq!(e, "Write a brief first");
    let e = render::update_story(&h.core, &story_id, StoryPatch { cast: Some(vec!["nobody".into()]), ..Default::default() }).unwrap_err();
    assert_eq!(e, "A cast character no longer exists");
    // Leaving the cast drops the character's voice.
    {
        let db = h.core.db.lock().unwrap();
        let mara = app_lib::stories::store::get_character(&db, "c-mara").unwrap().unwrap();
        let ivo = Character { id: "c-ivo".into(), name: "Ivo".into(), ..mara };
        app_lib::stories::store::save_character(&db, &ivo).unwrap();
    }
    let v = render::update_story(&h.core, &story_id, StoryPatch { cast: Some(vec!["c-ivo".into()]), ..Default::default() }).unwrap();
    assert!(v.story.voices.is_empty(), "{:?}", v.story.voices);
}

#[tokio::test]
async fn aspect_cannot_change_once_the_story_has_takes() {
    use app_lib::stories::StoryPatch;
    let (h, _server) = video_harness().await;
    let (story_id, shot_ids) = seed_story(&h.core, &[("cut", 8)]);
    let aspect = |a: &str| StoryPatch { aspect: Some(a.into()), ..Default::default() };
    // No takes yet: fine (and back).
    render::update_story(&h.core, &story_id, aspect("9:16")).unwrap();
    render::update_story(&h.core, &story_id, aspect("16:9")).unwrap();
    wait_video(&h, &render::render_shot(&h.core, &shot_ids[0]).unwrap()).await;
    let e = render::update_story(&h.core, &story_id, aspect("9:16")).unwrap_err();
    assert_eq!(e, "Change the aspect before rendering; this story already has takes");
    // Sending the unchanged aspect is not a change.
    let v = render::update_story(&h.core, &story_id, StoryPatch { aspect: Some("16:9".into()), brief: Some("New brief".into()), ..Default::default() }).unwrap();
    assert_eq!(v.story.brief, "New brief");
}

#[tokio::test]
async fn shot_without_characters_is_an_issue_and_render_all_reports_it_after_queueing_the_rest() {
    let (h, _server) = video_harness().await;
    let (story_id, shot_ids) = seed_story(&h.core, &[("cut", 8), ("cut", 8), ("cut", 8)]);
    set_shot(&h.core, &shot_ids[1], &|s| {
        s.characters.clear();
        s.dialogue.clear();
    });
    let view = render::story_view(&h.core, &story_id).unwrap();
    let issues: Vec<(Option<u32>, &str)> = view.issues.iter().map(|i| (i.shot, i.message.as_str())).collect();
    assert_eq!(issues, vec![(Some(2), "Shot 2 needs at least one character")]);
    let all = render::render_story(&h.core, &story_id).unwrap();
    let ids: Vec<&str> = all.queued.iter().map(|q| q.0.as_str()).collect();
    assert_eq!(ids, vec![shot_ids[0].as_str(), shot_ids[2].as_str()], "the valid shots render");
    assert_eq!(all.error.as_deref(), Some("Queued 2 shot(s); Shot 2 needs at least one character"));
    // The broken shot itself is refused.
    let e = render::render_shot(&h.core, &shot_ids[1]).unwrap_err();
    assert_eq!(e, "Shot 2 needs at least one character");
    for (_, job) in &all.queued {
        wait_video(&h, job).await;
    }
}

#[tokio::test]
async fn story_render_jobs_carry_a_story_and_shot_label() {
    let (h, _server) = video_harness().await;
    let (story_id, shot_ids) = seed_story(&h.core, &[("cut", 8), ("cut", 8)]);
    let job = render::render_shot(&h.core, &shot_ids[1]).unwrap();
    wait_video(&h, &job).await;
    let labels: Vec<Option<String>> = h.sink.jobs.lock().unwrap().iter().filter(|j| j.job_id == job).map(|j| j.label.clone()).collect();
    assert!(!labels.is_empty() && labels.iter().all(|l| l.as_deref() == Some("Story: Rooftop · shot 2")), "{labels:?}");
    let last = h.sink.jobs.lock().unwrap().iter().rev().find(|j| j.job_id == job).cloned().unwrap();
    assert_eq!(serde_json::to_value(&last).unwrap()["label"], "Story: Rooftop · shot 2");
    // Untitled: the start of the brief.
    {
        let db = h.core.db.lock().unwrap();
        let mut s = app_lib::stories::store::get_story(&db, &story_id).unwrap().unwrap();
        s.title = String::new();
        s.brief = "A long night on the rooftops of the old harbour district, with rain".into();
        app_lib::stories::store::save_story(&db, &s).unwrap();
    }
    let job = render::render_shot(&h.core, &shot_ids[0]).unwrap();
    let j = wait_end(&h, &job).await;
    assert_eq!(j.label.as_deref(), Some("Story: A long night on the rooftops of the old… · shot 1"));
}

#[test]
fn unlabelled_jobs_serialize_without_a_label() {
    let j = app_lib::jobs::Job {
        job_id: "j".into(), kind: app_lib::jobs::JobKind::Video, destination: Default::default(),
        status: app_lib::jobs::JobState::Queued, total: 1, completed: 0, progress: None, images: vec![],
        error: None, gpu_release: None, label: None,
    };
    assert!(serde_json::to_value(&j).unwrap().get("label").is_none());
}

#[tokio::test]
async fn deleting_replanning_or_removing_a_rendering_shot_is_refused() {
    use app_lib::stories::store;
    let (h, _server) = video_harness().await;
    let (story_id, shot_ids) = seed_story(&h.core, &[("cut", 8), ("cut", 8)]);
    let llm = mock_llm(&h.core, good_plan(16)).await;
    let job = render::render_shot(&h.core, &shot_ids[1]).unwrap();
    let wait = "Wait for shot 2 to finish rendering";
    assert_eq!(render::delete_story(&h.core, &story_id).unwrap_err(), wait);
    assert_eq!(render::plan_story(&h.core, &story_id).await.unwrap_err(), wait);
    assert!(llm.received_requests().await.unwrap().is_empty(), "refused before planning");
    let shots = store::list_shots(&h.core.db.lock().unwrap(), &story_id).unwrap();
    // Removing the rendering shot is refused; editing the other one is fine.
    assert_eq!(render::save_shots(&h.core, &story_id, vec![shots[0].clone()]).unwrap_err(), wait);
    let mut edited = shots.clone();
    edited[0].action = "Mara looks down.".into();
    render::save_shots(&h.core, &story_id, edited).unwrap();
    assert_eq!(store::list_shots(&h.core.db.lock().unwrap(), &story_id).unwrap().len(), 2, "nothing was removed");
    wait_video(&h, &job).await;
    // Done rendering: all allowed again.
    render::save_shots(&h.core, &story_id, vec![shots[0].clone()]).unwrap();
    render::delete_story(&h.core, &story_id).unwrap();
    assert!(store::get_story(&h.core.db.lock().unwrap(), &story_id).unwrap().is_none());
    assert!(h.core.db.lock().unwrap().list_takes(&story_id).unwrap().is_empty());
}

#[tokio::test]
async fn a_take_for_a_shot_that_is_gone_is_discarded_with_its_files() {
    use app_lib::jobs::JobState;
    let (h, _server) = video_harness().await;
    let (story_id, shot_ids) = seed_story(&h.core, &[("cut", 8)]);
    let job = render::render_shot(&h.core, &shot_ids[0]).unwrap();
    // Removed behind the app's back (the commands refuse this while it renders).
    app_lib::stories::store::replace_shots(&h.core.db.lock().unwrap(), &story_id, &[]).unwrap();
    let j = wait_end(&h, &job).await;
    assert_eq!(j.status, JobState::Failed, "{:?}", j.error);
    assert!(j.error.as_deref().unwrap_or_default().contains("The shot was removed while it rendered"), "{:?}", j.error);
    assert!(j.images.is_empty());
    assert!(h.core.db.lock().unwrap().list_takes(&story_id).unwrap().is_empty());
    let left: Vec<_> = std::fs::read_dir(h.core.cfg.videos_dir()).map(|d| d.flatten().map(|e| e.path()).collect()).unwrap_or_default();
    assert!(left.is_empty(), "{left:?}");
}

#[tokio::test]
async fn deleting_an_approved_take_or_the_result_clears_the_links() {
    use app_lib::stories::store;
    let (h, _server) = video_harness().await;
    let (story_id, shot_ids) = seed_story(&h.core, &[("cut", 8)]);
    let take = wait_video(&h, &render::render_shot(&h.core, &shot_ids[0]).unwrap()).await;
    render::approve_take(&h.core, &shot_ids[0], &take.id).unwrap();
    let db = h.core.db.lock().unwrap();
    h.core.cfg.delete_record(&db, &take).unwrap();
    assert_eq!(store::get_shot(&db, &shot_ids[0]).unwrap().unwrap().approved_take_id, None);
    // The assembled result (a gallery record) the same way.
    let mut result = take.clone();
    result.id = "result-1".into();
    result.shot_id = None;
    result.path = h.core.cfg.videos_dir().join("result-1.mp4").to_string_lossy().into();
    db.insert_image(&result).unwrap();
    store::set_result(&db, &story_id, "result-1", "{}").unwrap();
    h.core.cfg.delete_record(&db, &result).unwrap();
    let s = store::get_story(&db, &story_id).unwrap().unwrap();
    assert_eq!((s.result_image_id, s.status.as_str()), (None, "planned"));
}

const PREFILL: &str = "<think>\n\n</think>\n\n";

#[tokio::test]
async fn every_request_ends_with_empty_think_prefill_and_sets_max_tokens() {
    let s = MockServer::start().await;
    Mock::given(method("POST")).and(path("/v1/chat/completions"))
        .respond_with(Seq(vec![reply(&good_plan(3)), reply(&good_plan(10))], AtomicUsize::new(0))).mount(&s).await;
    let out = planner::plan(&format!("{}/v1", s.uri()), "m", &st(10), &[mara()]).await.unwrap();
    assert_eq!(out.attempts, 2);
    let reqs = s.received_requests().await.unwrap();
    assert_eq!(reqs.len(), 2);
    for r in &reqs {
        let b: serde_json::Value = r.body_json().unwrap();
        let last = b["messages"].as_array().unwrap().last().unwrap().clone();
        assert_eq!(last["role"], "assistant");
        assert_eq!(last["content"], PREFILL);
        assert_eq!(b["max_tokens"], 4000);
        assert_eq!(b["stream"], true);
        assert_eq!(b["chat_template_kwargs"]["enable_thinking"], false);
    }
    // The repair follow-up keeps the user's fix request before the prefill.
    let b: serde_json::Value = reqs[1].body_json().unwrap();
    let m = b["messages"].as_array().unwrap();
    assert_eq!(m[m.len() - 2]["role"], "user");
    assert!(m[m.len() - 2]["content"].as_str().unwrap().contains("5–15"));
    assert_eq!(m.iter().filter(|x| x["content"] == PREFILL).count(), 1);
}

#[tokio::test]
async fn empty_content_falls_back_to_reasoning_content() {
    let s = MockServer::start().await;
    let t = ResponseTemplate::new(200).set_body_json(json!({"choices": [{"message": {"role": "assistant", "content": "  \n",
        "reasoning_content": good_plan(10)}}]}));
    Mock::given(method("POST")).and(path("/v1/chat/completions")).respond_with(t).mount(&s).await;
    let out = planner::plan(&format!("{}/v1", s.uri()), "m", &st(10), &[mara()]).await.unwrap();
    assert!(out.issues.is_empty(), "{:?}", out.issues);
    assert_eq!(out.shots.len(), 1);
}

#[test]
fn prompt_tuning_rules_are_present_and_example_voices_are_not_copyable() {
    let ivo = Character { id: "c2".into(), name: "Ivo".into(), ..mara() };
    let p = planner::system_prompt(&st(10), &[mara(), ivo]);
    assert!(!p.contains("low, steady female voice"), "{p}");
    assert!(!p.contains("deep, slightly hoarse"), "{p}");
    assert!(p.contains("invent a distinct voice"), "{p}");
    assert!(p.contains("Vary shot lengths"), "{p}");
    assert!(p.contains("same characters in the same place at the exact moment"), "{p}");
    assert!(p.contains("Spread the dialogue across the shots"), "{p}");
    assert!(p.contains("held final pose"), "{p}");
}

fn png_10x10() -> Vec<u8> {
    let img = image::RgbImage::from_pixel(10, 10, image::Rgb([1, 2, 3]));
    let mut buf = Vec::new();
    image::DynamicImage::ImageRgb8(img).write_to(&mut std::io::Cursor::new(&mut buf), image::ImageFormat::Png).unwrap();
    buf
}

#[test]
fn characters_list_with_display_paths_and_edits_keep_id() {
    let dir = tempfile::tempdir().unwrap();
    let refs = dir.path().join("references");
    let r = app_lib::references::import_bytes(&refs, &png_10x10()).unwrap();
    let db = app_lib::db::Db::open_in_memory().unwrap();
    let c = Character { id: "c1".into(), name: "Mara".into(), ref_ids: vec![r.ref_id.clone()], ..mara() };
    app_lib::stories::store::save_character(&db, &c).unwrap();
    let listed = app_lib::stories::render::with_ref_paths(&refs, app_lib::stories::store::list_characters(&db).unwrap());
    assert_eq!(listed[0].ref_paths, vec![r.thumb_path.clone()]);
    let mut edited = listed[0].clone();
    edited.name = "Mara K".into();
    edited.ref_ids = vec![];
    assert!(app_lib::stories::store::check_character(&edited).is_err(), "still needs a reference");
    edited.ref_ids = vec![r.ref_id.clone()];
    app_lib::stories::store::save_character(&db, &edited).unwrap();
    let back = app_lib::stories::store::get_character(&db, "c1").unwrap().unwrap();
    assert_eq!((back.name.as_str(), back.created_at.as_str()), ("Mara K", "t"));
}

// ----- repo: one router over SQLite and the vault -----

mod repo_tests {
    use super::{mara, st};
    use app_lib::db::Db;
    use app_lib::registry::Registry;
    use app_lib::settings::{MemoryStore, Settings};
    use app_lib::state::{Core, CoreConfig};
    use app_lib::stories::repo::{self, Home};
    use app_lib::stories::{render, Character, Shot, Story, StoryPatch};
    use app_lib::vault::{KdfParams, VaultItem};
    use std::collections::HashMap;
    use std::sync::Arc;

    const PW: &[u8] = b"a long enough password";

    fn core_with_vault() -> (tempfile::TempDir, Arc<Core>) {
        let dir = tempfile::tempdir().unwrap();
        let settings = Settings::new(Arc::new(MemoryStore::default()), HashMap::new(), dir.path().join("settings.json"));
        let sink = Arc::new(super::render_harness::Collect::default());
        let cfg = CoreConfig::production(dir.path().to_path_buf());
        let core = Core::new(Registry::embedded(), Db::open_in_memory().unwrap(), settings, sink, cfg).unwrap();
        core.vault.create(PW, KdfParams::fast()).unwrap();
        (dir, core)
    }

    fn uuid() -> String {
        uuid::Uuid::new_v4().to_string()
    }

    fn character_in(home: Home, name: &str) -> Character {
        let vault = home == Home::Vault;
        let ref_ids = if vault { vec![format!("vault://localhost/{}.png", uuid())] } else { vec!["r1".into()] };
        Character { id: uuid(), name: name.into(), ref_ids, vault, ..mara() }
    }

    fn story_in(home: Home, title: &str) -> Story {
        Story { id: uuid(), title: title.into(), cast: vec![], vault: home == Home::Vault, ..st(10) }
    }

    fn story_with_cast(cast: &[&str]) -> Story {
        Story { cast: cast.iter().map(|c| c.to_string()).collect(), ..st(10) }
    }

    fn shot(story_id: &str, position: u32) -> Shot {
        Shot {
            id: uuid(), story_id: story_id.into(), position, duration_s: 8, characters: vec![], setting: "roof".into(),
            camera: "wide".into(), action: "walks".into(), dialogue: vec![], sound: String::new(), continuity: "cut".into(),
            approved_take_id: None,
        }
    }

    /// A sealed take (or film when `shot_id` is None) of a vault story.
    fn vault_take(core: &Core, story_id: &str, shot_id: Option<&str>) -> VaultItem {
        let media = core.vault.seal_blob(b"not really an mp4", "mp4").unwrap();
        let item = VaultItem {
            id: uuid(), kind: "video".into(), model: "h3ref".into(), prompt: "p".into(), negative_prompt: String::new(),
            aspect_ratio: "16:9".into(), width: 16, height: 9, seed: 1, steps: 0, cfg: 0.0, loras: vec![],
            created_at: "2026-01-01T00:00:00Z".into(), duration_ms: None, runpod: Default::default(), denoise: None,
            duration_s: Some(8.0), fps: Some(24.0), has_audio: Some(true), media, poster: None, thumb: None, init_image: None,
            references: vec![], source_id: None, added_at: String::new(), story_id: Some(story_id.into()),
            shot_id: shot_id.map(String::from),
        };
        core.vault.put_item(&item).unwrap();
        item
    }

    #[test]
    fn stories_route_to_their_store_and_vault_ones_vanish_while_locked() {
        let (_d, core) = core_with_vault();
        let general = repo::save_story(&core, &story_in(Home::General, "The Reel Returns")).unwrap();
        let vault = repo::save_story(&core, &story_in(Home::Vault, "Light Packing")).unwrap();
        assert_eq!(repo::list_stories(&core).unwrap().len(), 2);
        assert!(repo::get_story(&core, &vault.id).unwrap().unwrap().vault);
        core.vault.lock();
        let titles: Vec<String> = repo::list_stories(&core).unwrap().into_iter().map(|s| s.title).collect();
        assert_eq!(titles, vec!["The Reel Returns"]);
        assert_eq!(repo::get_story(&core, &vault.id).unwrap_err(), "VAULT_LOCKED: Unlock the vault to open this story");
        assert_eq!(repo::get_story(&core, "nope").unwrap(), None);
        assert!(repo::get_story(&core, &general.id).unwrap().is_some());
    }

    #[test]
    fn general_story_rejects_vault_character_on_create_and_update() {
        let (_d, core) = core_with_vault();
        let mara = repo::save_character(&core, &character_in(Home::General, "Mara")).unwrap();
        let secret = repo::save_character(&core, &character_in(Home::Vault, "Ivo")).unwrap();
        let mut s = story_in(Home::General, "G");
        s.cast = vec![secret.id.clone()];
        assert_eq!(repo::check_cast(&core, &s).unwrap_err(), "A General story can't use a vault character. Create the story as a vault story.");
        s.cast = vec![mara.id.clone()];
        let s = repo::save_story(&core, &s).unwrap();
        let e = render::update_story(&core, &s.id, StoryPatch { cast: Some(vec![mara.id.clone(), secret.id.clone()]), ..Default::default() }).unwrap_err();
        assert!(e.contains("can't use a vault character"), "{e}");
        let mut v = story_in(Home::Vault, "V");
        v.cast = vec![mara.id.clone(), secret.id.clone()];
        repo::check_cast(&core, &v).unwrap(); // a vault story may use General characters
    }

    #[test]
    fn deleting_a_general_character_waits_for_the_locked_vault() {
        let (_d, core) = core_with_vault();
        let mara = repo::save_character(&core, &character_in(Home::General, "Mara")).unwrap();
        core.vault.lock();
        assert_eq!(repo::delete_character(&core, &mara.id).unwrap_err(), "Unlock the vault first: a vault story may use this character");
        core.vault.unlock(PW).unwrap();
        repo::delete_character(&core, &mara.id).unwrap();
    }

    #[test]
    fn vault_story_job_label_has_no_title_and_cast_names_must_differ() {
        let mut s = story_in(Home::Vault, "Light Packing");
        assert_eq!(render::job_label(&s, 2), "Vault story · shot 2");
        s.vault = false;
        assert_eq!(render::job_label(&s, 2), "Story: Light Packing · shot 2");
        let (a, b) = (Character { id: "a".into(), ..mara() }, Character { id: "b".into(), ..mara() });
        let issues = app_lib::stories::validate::preflight(&story_with_cast(&["a", "b"]), &[a, b]);
        assert!(issues.iter().any(|i| i.message == "Two cast members are both named Mara. Rename one."));
    }

    #[test]
    fn cast_names_differ_case_insensitively_in_check_cast() {
        let (_d, core) = core_with_vault();
        let a = repo::save_character(&core, &character_in(Home::General, "Mara")).unwrap();
        let b = repo::save_character(&core, &character_in(Home::Vault, "mara")).unwrap();
        let mut v = story_in(Home::Vault, "V");
        v.cast = vec![a.id.clone(), b.id.clone()];
        assert_eq!(repo::check_cast(&core, &v).unwrap_err(), "Two cast members are both named Mara. Rename one.");
        let mut g = story_in(Home::General, "G");
        g.cast = vec!["missing".into()];
        assert_eq!(repo::check_cast(&core, &g).unwrap_err(), "A cast character no longer exists");
    }

    #[test]
    fn characters_route_to_their_store_refs_must_match_and_the_store_is_fixed() {
        let (_d, core) = core_with_vault();
        let mara = repo::save_character(&core, &character_in(Home::General, "Mara")).unwrap();
        let ivo = repo::save_character(&core, &character_in(Home::Vault, "Ivo")).unwrap();
        assert!(!mara.vault && ivo.vault);
        let names: Vec<String> = repo::list_characters(&core).unwrap().into_iter().map(|c| c.name).collect();
        assert_eq!(names, vec!["Ivo", "Mara"]);
        // Refs in the wrong store.
        let mut wrong = character_in(Home::Vault, "Zed");
        wrong.ref_ids = vec!["r9".into()];
        assert_eq!(repo::save_character(&core, &wrong).unwrap_err(), "Reference images must be in the same place as the character");
        let mut wrong = character_in(Home::General, "Zed");
        wrong.ref_ids = vec![format!("vault://localhost/{}.png", uuid())];
        assert_eq!(repo::save_character(&core, &wrong).unwrap_err(), "Reference images must be in the same place as the character");
        // The store is fixed: a request flipping `vault` keeps the character where it is.
        let mut moved = ivo.clone();
        moved.vault = false;
        moved.ref_ids = vec!["r1".into()];
        assert_eq!(repo::save_character(&core, &moved).unwrap_err(), "Reference images must be in the same place as the character");
        let mut renamed = ivo.clone();
        renamed.vault = false;
        renamed.description = "changed".into();
        let saved = repo::save_character(&core, &renamed).unwrap();
        assert!(saved.vault);
        assert_eq!(core.vault.character(&ivo.id).unwrap().description, "changed");
        assert!(app_lib::stories::store::get_character(&core.db.lock().unwrap(), &ivo.id).unwrap().is_none());
        // Names are unique per store (case-insensitive).
        let e = repo::save_character(&core, &character_in(Home::Vault, "ivo")).unwrap_err();
        assert_eq!(e, "A character named ivo already exists");
        repo::save_character(&core, &character_in(Home::General, "ivo")).unwrap();
        // Locked: General only, and vault characters can't be read, created or edited.
        core.vault.lock();
        let names: Vec<String> = repo::list_characters(&core).unwrap().into_iter().map(|c| c.name).collect();
        assert_eq!(names, vec!["ivo", "Mara"]);
        assert_eq!(repo::get_character(&core, &ivo.id).unwrap_err(), "VAULT_LOCKED: Unlock the vault to open this character");
        assert_eq!(repo::get_character(&core, "nope").unwrap(), None);
        assert_eq!(repo::character_home(&core, &ivo.id).unwrap(), Some(Home::Vault));
        assert_eq!(repo::character_home(&core, &mara.id).unwrap(), Some(Home::General));
        assert_eq!(
            repo::save_character(&core, &character_in(Home::Vault, "New")).unwrap_err(),
            "VAULT_LOCKED: Unlock the vault to create a vault character"
        );
        assert!(repo::save_character(&core, &renamed).unwrap_err().starts_with("VAULT_LOCKED"));
    }

    #[test]
    fn vault_story_shots_takes_and_deletion_go_through_the_doc() {
        let (_d, core) = core_with_vault();
        let s = repo::save_story(&core, &story_in(Home::Vault, "Light Packing")).unwrap();
        assert_eq!(repo::story_home(&core, &s.id).unwrap(), Some(Home::Vault));
        let (a, b) = (shot(&s.id, 1), shot(&s.id, 2));
        repo::replace_shots(&core, &s.id, &[b.clone(), a.clone()]).unwrap();
        let ids: Vec<String> = repo::list_shots(&core, &s.id).unwrap().into_iter().map(|x| x.id).collect();
        assert_eq!(ids, vec![a.id.clone(), b.id.clone()]);
        assert_eq!(repo::get_shot(&core, &b.id).unwrap().unwrap().position, 2);
        let mut a2 = a.clone();
        a2.action = "runs".into();
        repo::update_shot(&core, &a2).unwrap();
        assert_eq!(repo::get_shot(&core, &a.id).unwrap().unwrap().action, "runs");
        assert!(repo::update_shot(&core, &shot(&s.id, 9)).is_err());

        let take = vault_take(&core, &s.id, Some(&a.id));
        let film = vault_take(&core, &s.id, None);
        let takes = repo::list_takes(&core, &s).unwrap();
        assert_eq!(takes.len(), 1);
        assert!(takes[0].vault && takes[0].id == take.id);
        assert_eq!(repo::get_take(&core, &film.id).unwrap().unwrap().shot_id, None);
        repo::set_approved(&core, &a.id, Some(&take.id)).unwrap();
        assert_eq!(repo::get_shot(&core, &a.id).unwrap().unwrap().approved_take_id.as_deref(), Some(take.id.as_str()));
        repo::set_result(&core, &s.id, &film.id, &serde_json::json!({"k": "v"})).unwrap();
        let st = repo::get_story(&core, &s.id).unwrap().unwrap();
        assert_eq!((st.status.as_str(), st.result_image_id.as_deref()), ("assembled", Some(film.id.as_str())));
        assert_eq!(core.vault.story_doc(&s.id).unwrap().sidecar, Some(serde_json::json!({"k": "v"})));

        // A deleted take or film: the approval and the result are forgotten.
        repo::clear_image_refs(&core, &take.id).unwrap();
        assert_eq!(repo::get_shot(&core, &a.id).unwrap().unwrap().approved_take_id, None);
        repo::clear_image_refs(&core, &film.id).unwrap();
        let st = repo::get_story(&core, &s.id).unwrap().unwrap();
        assert_eq!((st.status.as_str(), st.result_image_id), ("planned", None));

        // Locked: shots and the story are unreadable; nothing is written.
        core.vault.lock();
        assert_eq!(repo::list_shots(&core, &s.id).unwrap_err(), "VAULT_LOCKED: Unlock the vault to open this story");
        assert_eq!(repo::get_shot(&core, &a.id).unwrap(), None);
        assert_eq!(repo::list_takes(&core, &s).unwrap_err(), "VAULT_LOCKED: Unlock the vault to open this story");
        assert!(repo::replace_shots(&core, &s.id, &[]).unwrap_err().starts_with("VAULT_LOCKED"));
        assert!(repo::delete_story(&core, &s.id).unwrap_err().starts_with("VAULT_LOCKED"));
        assert!(core.vault.story_file_exists(&s.id));
        core.vault.unlock(PW).unwrap();

        // Deleting the story deletes its takes and film with it.
        repo::delete_story(&core, &s.id).unwrap();
        assert_eq!(repo::get_story(&core, &s.id).unwrap(), None);
        assert!(core.vault.items_for_story(&s.id).unwrap().is_empty());
        assert!(core.vault.item(&take.id).is_err() && core.vault.item(&film.id).is_err());
        assert!(core.vault.open_blob(&take.media.id).is_err());
        assert!(repo::list_shots(&core, &s.id).unwrap().is_empty());
    }

    #[test]
    fn dropping_a_vault_shot_discards_its_sealed_take_and_its_approval() {
        let (_d, core) = core_with_vault();
        let s = repo::save_story(&core, &story_in(Home::Vault, "Light Packing")).unwrap();
        let (a, b) = (shot(&s.id, 1), shot(&s.id, 2));
        repo::replace_shots(&core, &s.id, &[a.clone(), b.clone()]).unwrap();
        let take_a = vault_take(&core, &s.id, Some(&a.id));
        let take_b = vault_take(&core, &s.id, Some(&b.id));
        repo::set_approved(&core, &a.id, Some(&take_a.id)).unwrap();
        // Shot a goes: its take and the take's blob go with it; shot b keeps its take.
        render::store_shots(&core, &s.id, &[Shot { position: 1, ..b.clone() }]).unwrap();
        assert!(core.vault.item(&take_a.id).is_err());
        assert!(core.vault.open_blob(&take_a.media.id).is_err());
        assert!(core.vault.item(&take_b.id).is_ok());
        let takes = repo::list_takes(&core, &s).unwrap();
        assert_eq!(takes.iter().map(|t| t.id.as_str()).collect::<Vec<_>>(), vec![take_b.id.as_str()]);
        assert_eq!(repo::get_shot(&core, &a.id).unwrap(), None);
        // Editing shots while locked changes nothing.
        core.vault.lock();
        assert_eq!(render::save_shots(&core, &s.id, vec![]).unwrap_err(), "VAULT_LOCKED: Unlock the vault to open this story");
        core.vault.unlock(PW).unwrap();
        assert_eq!(repo::list_shots(&core, &s.id).unwrap().len(), 1);
        assert!(core.vault.item(&take_b.id).is_ok());
    }

    #[test]
    fn a_vault_story_needs_a_vault_and_an_update_keeps_its_store() {
        let dir = tempfile::tempdir().unwrap();
        let settings = Settings::new(Arc::new(MemoryStore::default()), HashMap::new(), dir.path().join("settings.json"));
        let sink = Arc::new(super::render_harness::Collect::default());
        let core = Core::new(Registry::embedded(), Db::open_in_memory().unwrap(), settings, sink, CoreConfig::production(dir.path().to_path_buf())).unwrap();
        assert_eq!(
            repo::save_story(&core, &story_in(Home::Vault, "V")).unwrap_err(),
            "NO_VAULT: Create the vault first (Gallery → Vault)"
        );
        assert_eq!(
            repo::save_character(&core, &character_in(Home::Vault, "Ivo")).unwrap_err(),
            "NO_VAULT: Create the vault first (Gallery → Vault)"
        );
        core.vault.create(PW, KdfParams::fast()).unwrap();
        core.vault.lock();
        assert_eq!(
            repo::save_story(&core, &story_in(Home::Vault, "V")).unwrap_err(),
            "VAULT_LOCKED: Unlock the vault to create a vault story"
        );
        core.vault.unlock(PW).unwrap();
        let mara = repo::save_character(&core, &character_in(Home::General, "Mara")).unwrap();
        let mut v = story_in(Home::Vault, "V");
        v.cast = vec![mara.id.clone()];
        let v = repo::save_story(&core, &v).unwrap();
        // The store is fixed: a save that says General keeps the story in the vault.
        let mut flipped = v.clone();
        flipped.vault = false;
        flipped.title = "V2".into();
        let saved = repo::save_story(&core, &flipped).unwrap();
        assert!(saved.vault);
        assert!(app_lib::stories::store::get_story(&core.db.lock().unwrap(), &v.id).unwrap().is_none());
        let view = render::update_story(&core, &v.id, StoryPatch { title: Some("V3".into()), ..Default::default() }).unwrap();
        assert!(view.story.vault && view.story.title == "V3");
        assert_eq!(repo::list_stories(&core).unwrap()[0].title, "V3");
        // A General character used by a vault story can't go.
        assert_eq!(repo::delete_character(&core, &mara.id).unwrap_err(), "Mara is used by story \"V3\"");
    }

    /// The LLM reply arrives after the vault locked: the plan is lost, nothing changes, and the
    /// message says so. Locked before planning starts: the spec's `VAULT_LOCKED` copy.
    struct LockThenReply(Arc<Core>, String);
    impl wiremock::Respond for LockThenReply {
        fn respond(&self, _: &wiremock::Request) -> wiremock::ResponseTemplate {
            self.0.vault.lock();
            super::reply(&self.1)
        }
    }

    #[tokio::test]
    async fn a_vault_story_locking_mid_plan_loses_the_plan_and_says_so() {
        use wiremock::matchers::{method, path};
        use wiremock::{Mock, MockServer, ResponseTemplate};
        let (_d, core) = core_with_vault();
        let mara = repo::save_character(&core, &character_in(Home::Vault, "Mara")).unwrap();
        let story = repo::save_story(&core, &Story { cast: vec![mara.id.clone()], ..story_in(Home::Vault, "Light Packing") }).unwrap();
        let s = MockServer::start().await;
        Mock::given(method("GET")).and(path("/v1/models"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({"data": [{"id": "m"}]}))).mount(&s).await;
        Mock::given(method("POST")).and(path("/v1/chat/completions"))
            .respond_with(LockThenReply(core.clone(), super::good_plan(10))).mount(&s).await;
        core.settings.save_llm(Some(format!("{}/v1", s.uri())), Some("m".into())).unwrap();
    core.settings.save_planner_location(false).unwrap();
        assert_eq!(
            render::plan_story(&core, &story.id).await.unwrap_err(),
            "VAULT_LOCKED: The vault locked while planning; unlock and plan again"
        );
        assert!(!core.vault.is_unlocked());
        assert_eq!(render::plan_story(&core, &story.id).await.unwrap_err(), "VAULT_LOCKED: Unlock the vault to plan the story");
        core.vault.unlock(PW).unwrap();
        assert!(repo::list_shots(&core, &story.id).unwrap().is_empty(), "nothing changed");
        let st = repo::get_story(&core, &story.id).unwrap().unwrap();
        assert_eq!((st.status.as_str(), st.title.as_str()), ("draft", "Light Packing"));
    }
}

#[test]
fn max_tokens_scales_with_target_length() {
    assert_eq!(planner::max_tokens_for(30), 4000);
    assert_eq!(planner::max_tokens_for(180), 11700);
    assert_eq!(planner::max_tokens_for(600), 14000);
}

#[tokio::test]
async fn a_cut_off_plan_is_not_retried_and_says_why() {
    let s = MockServer::start().await;
    let t = ResponseTemplate::new(200).set_body_json(json!({"choices": [{"message": {"role": "assistant", "content": "{\"title\": \"x\", \"shots\": [{"},
        "finish_reason": "length"}], "usage": {"completion_tokens": 4000}}));
    Mock::given(method("POST")).and(path("/v1/chat/completions")).respond_with(t).mount(&s).await;
    let err = planner::plan(&format!("{}/v1", s.uri()), "m", &st(10), &[mara()]).await.unwrap_err();
    assert!(err.contains("cut off after 4000 tokens") && err.contains("Shorten the target"), "{err}");
    assert_eq!(s.received_requests().await.unwrap().len(), 1);
}

#[tokio::test]
async fn a_streamed_reply_is_assembled_and_reports_progress() {
    let s = MockServer::start().await;
    let plan = good_plan(10);
    let (a, b) = plan.split_at(plan.len() / 2);
    let sse = format!("data: {}\n\ndata: {}\n\ndata: {}\n\ndata: [DONE]\n\n",
        json!({"choices": [{"delta": {"content": a}}]}), json!({"choices": [{"delta": {"content": b}}]}),
        json!({"choices": [{"delta": {}, "finish_reason": "stop"}]}));
    let t = ResponseTemplate::new(200).set_body_raw(sse.into_bytes(), "text/event-stream");
    Mock::given(method("POST")).and(path("/v1/chat/completions")).respond_with(t).mount(&s).await;
    let seen = std::sync::Mutex::new(Vec::new());
    let out = planner::plan_with_progress(&format!("{}/v1", s.uri()), "m", None, &st(10), &[mara()],
        &|p| seen.lock().unwrap().push((p.attempt, p.tokens, p.phase))).await.unwrap();
    assert!(out.issues.is_empty(), "{:?}", out.issues);
    let seen = seen.lock().unwrap();
    assert_eq!(seen.first(), Some(&(1, 0, "waiting")));
    assert_eq!(seen.last(), Some(&(1, 2, "writing")));
}

#[tokio::test]
async fn the_pod_planner_sends_its_bearer_token() {
    use wiremock::matchers::header;
    let s = MockServer::start().await;
    Mock::given(method("POST")).and(path("/v1/chat/completions")).and(header("authorization", "Bearer pod-tok"))
        .respond_with(reply(&good_plan(10))).mount(&s).await;
    let out = planner::plan_with_progress(&format!("{}/v1", s.uri()), "m", Some("pod-tok"), &st(10), &[mara()], &|_| {}).await.unwrap();
    assert!(out.issues.is_empty(), "{:?}", out.issues);
}
