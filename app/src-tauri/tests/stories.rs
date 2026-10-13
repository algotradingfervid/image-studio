use app_lib::stories::{planner, Character, Story};
use serde_json::json;
use wiremock::matchers::{method, path};
use wiremock::{Mock, MockServer, ResponseTemplate, Request, Respond};
use std::sync::atomic::{AtomicUsize, Ordering};

fn mara() -> Character { Character { id: "c1".into(), name: "Mara".into(), description: "woman in her 30s".into(),
    source: "generated".into(), consent: false, adult: true, ref_ids: vec!["r1".into()], created_at: "t".into(), updated_at: "t".into() } }
fn st(target: u32) -> Story { Story { id: "s1".into(), title: String::new(), logline: String::new(), brief: "A heist on a rooftop".into(),
    target_s: target, aspect: "16:9".into(), style: String::new(), cast: vec!["c1".into()], status: "draft".into(),
    result_image_id: None, created_at: "t".into(), updated_at: "t".into() } }
fn reply(content: &str) -> ResponseTemplate {
    ResponseTemplate::new(200).set_body_json(json!({"choices": [{"message": {"role": "assistant", "content": content}}]}))
}
fn good_plan(dur: u32) -> String {
    json!({"title": "Rooftop", "logline": "Mara escapes.", "shots": [
        {"duration_s": dur, "characters": ["Mara"], "setting": "rooftop", "camera": "wide", "continuity": "cut",
         "action": "Mara runs to the edge.", "dialogue": [{"speaker": "mara", "line": "Now."}]}]}).to_string()
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
    let body: serde_json::Value = s.received_requests().await.unwrap()[0].body_json().unwrap();
    assert_eq!(body["response_format"]["type"], "json_schema");
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
async fn unreachable_server_gives_lm_studio_hint() {
    let e = planner::plan("http://127.0.0.1:9/v1", "m", &st(10), &[mara()]).await.unwrap_err();
    assert!(e.contains("LM Studio"), "{e}");
}
