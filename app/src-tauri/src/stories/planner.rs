use super::{validate::validate, Character, DialogueLine, Issue, Shot, Story};
use serde_json::{json, Value};
use std::time::Duration;

pub const LM_STUDIO_HINT: &str = "Could not reach the local LLM. Start LM Studio's server (Developer → Start server, or `lms server start`) and load a model.";
const MAX_ATTEMPTS: u32 = 3;
const TEMPERATURE: f64 = 0.6;
const TIMEOUT: Duration = Duration::from_secs(600); // a 27B model can take minutes

#[derive(Debug, Clone)]
pub struct PlanOutcome { pub title: String, pub logline: String, pub shots: Vec<Shot>, pub issues: Vec<Issue>, pub attempts: u32 }

fn schema() -> Value {
    json!({"type": "object", "required": ["title", "logline", "shots"], "properties": {
        "title": {"type": "string"}, "logline": {"type": "string"},
        "shots": {"type": "array", "minItems": 1, "items": {"type": "object",
            "required": ["duration_s", "characters", "setting", "camera", "continuity", "action", "dialogue"],
            "properties": {
                "duration_s": {"type": "integer", "minimum": 5, "maximum": 15},
                "characters": {"type": "array", "items": {"type": "string"}, "maxItems": 2},
                "setting": {"type": "string"}, "camera": {"type": "string"},
                "continuity": {"type": "string", "enum": ["cut", "continues"]},
                "action": {"type": "string"},
                "dialogue": {"type": "array", "items": {"type": "object", "required": ["speaker", "line"],
                    "properties": {"speaker": {"type": "string"}, "line": {"type": "string"}}}}}}}}})
}

pub fn system_prompt(story: &Story, cast: &[Character]) -> String {
    let people: Vec<String> = cast.iter().map(|c| format!("- {}: {}", c.name, c.description)).collect();
    format!("You are a film writer and director. Turn the brief into a short film told in shots.\n\
Characters you may use (use these exact names and no others; every character is an adult, 18 or older):\n{}\n\
Rules:\n\
- Total length about {} seconds; each shot 5 to 15 seconds (duration_s, whole seconds).\n\
- At most 2 characters per shot. Dialogue only from characters in that shot.\n\
- At most 2.5 spoken words per second of shot.\n\
- Describe action that runs through the whole shot, never a frozen frame.\n\
- continuity is \"cut\" (new framing or place) or \"continues\" (picks up exactly where the previous shot ended, same characters); the first shot is \"cut\".\n\
- Never describe anyone as under 18.\n\
- Do not describe appearance or clothing; that is fixed elsewhere. Describe setting, camera, action and dialogue.\n\
Reply with JSON only, in this shape:\n\
{{\"title\": \"…\", \"logline\": \"one sentence\", \"shots\": [{{\"duration_s\": 8, \"characters\": [\"{}\"], \"setting\": \"rooftop at night, city lights below\", \"camera\": \"medium close-up, slow push-in\", \"continuity\": \"cut\", \"action\": \"…\", \"dialogue\": [{{\"speaker\": \"{}\", \"line\": \"…\"}}]}}]}}",
        people.join("\n"), story.target_s,
        cast.first().map(|c| c.name.as_str()).unwrap_or("Name"), cast.first().map(|c| c.name.as_str()).unwrap_or("Name"))
}

fn user_prompt(story: &Story) -> String {
    let mut s = format!("Brief: {}\nTarget length: {} seconds. Aspect {}.", story.brief.trim(), story.target_s, story.aspect);
    if !story.style.trim().is_empty() { s.push_str(&format!("\nVisual style: {}", story.style.trim())); }
    s
}

/// Extracts the JSON object from a model reply: drops `<think>…</think>`, code fences and prose around it.
pub fn parse_reply(content: &str) -> Result<Value, String> {
    let mut text = content.to_string();
    while let (Some(a), Some(b)) = (text.find("<think>"), text.find("</think>")) {
        if b < a { break; }
        text.replace_range(a..b + "</think>".len(), "");
    }
    let (start, end) = (text.find('{'), text.rfind('}'));
    match (start, end) {
        (Some(a), Some(b)) if b > a => serde_json::from_str(&text[a..=b]).map_err(|e| format!("The planner's reply is not valid JSON ({e})")),
        _ => Err("The planner's reply contains no JSON object".into()),
    }
}

fn to_shots(v: &Value, story: &Story, cast: &[Character], issues: &mut Vec<Issue>) -> Vec<Shot> {
    let id_of = |name: &str, issues: &mut Vec<Issue>, pos: u32| -> String {
        match cast.iter().find(|c| c.name.eq_ignore_ascii_case(name.trim())) {
            Some(c) => c.id.clone(),
            None => { issues.push(Issue { shot: Some(pos), message: format!("{} is not in the cast", name.trim()) }); name.trim().to_string() }
        }
    };
    let s = |x: &Value, k: &str| x.get(k).and_then(Value::as_str).unwrap_or("").trim().to_string();
    v.get("shots").and_then(Value::as_array).cloned().unwrap_or_default().iter().enumerate().map(|(i, x)| {
        let pos = i as u32 + 1;
        let characters = x.get("characters").and_then(Value::as_array).cloned().unwrap_or_default()
            .iter().filter_map(Value::as_str).map(|n| id_of(n, issues, pos)).collect();
        let dialogue = x.get("dialogue").and_then(Value::as_array).cloned().unwrap_or_default().iter()
            .map(|d| DialogueLine { speaker: id_of(&s(d, "speaker"), issues, pos), line: s(d, "line") })
            .filter(|d| !d.line.is_empty()).collect();
        let continuity = if s(x, "continuity") == "continues" { "continues" } else { "cut" };
        Shot { id: uuid::Uuid::new_v4().to_string(), story_id: story.id.clone(), position: pos,
            duration_s: x.get("duration_s").and_then(Value::as_u64).unwrap_or(0) as u32,
            characters, setting: s(x, "setting"), camera: s(x, "camera"), action: s(x, "action"),
            dialogue, continuity: continuity.into(), approved_take_id: None }
    }).collect()
}

async fn chat(http: &reqwest::Client, base_url: &str, body: &Value) -> Result<Result<String, String>, String> {
    // Outer Err = transport failure (LM Studio not reachable); inner Err = HTTP error body.
    let resp = http.post(format!("{base_url}/chat/completions")).json(body).send().await
        .map_err(|_| LM_STUDIO_HINT.to_string())?;
    let status = resp.status().as_u16();
    let v: Value = resp.json().await.unwrap_or(Value::Null);
    if status >= 400 {
        return Ok(Err(v.to_string()));
    }
    Ok(v.pointer("/choices/0/message/content").and_then(Value::as_str).map(String::from)
        .ok_or_else(|| "The planner returned no message".to_string()))
}

pub async fn plan(base_url: &str, model: &str, story: &Story, cast: &[Character]) -> Result<PlanOutcome, String> {
    let http = reqwest::Client::builder().timeout(TIMEOUT).build().map_err(|e| e.to_string())?;
    let mut messages = vec![json!({"role": "system", "content": system_prompt(story, cast)}),
                            json!({"role": "user", "content": user_prompt(story)})];
    let mut structured = true;
    let mut best: Option<PlanOutcome> = None;
    let mut attempt = 0;
    while attempt < MAX_ATTEMPTS {
        attempt += 1;
        let mut body = json!({"model": model, "messages": messages, "temperature": TEMPERATURE,
            "chat_template_kwargs": {"enable_thinking": false}});
        if structured {
            body["response_format"] = json!({"type": "json_schema", "json_schema": {"name": "story_plan", "strict": true, "schema": schema()}});
        }
        let content = match chat(&http, base_url, &body).await? {
            Ok(c) => c,
            Err(err) if structured && err.contains("response_format") => { structured = false; attempt -= 1; continue; }
            Err(err) => return Err(format!("The local LLM returned an error: {err}")),
        };
        let mut issues = Vec::new();
        let (title, logline, shots) = match parse_reply(&content) {
            Ok(v) => {
                let shots = to_shots(&v, story, cast, &mut issues);
                (v.get("title").and_then(Value::as_str).unwrap_or("").to_string(),
                 v.get("logline").and_then(Value::as_str).unwrap_or("").to_string(), shots)
            }
            Err(e) => { issues.push(Issue { shot: None, message: e }); (String::new(), String::new(), Vec::new()) }
        };
        issues.extend(validate(story, &shots, cast));
        let outcome = PlanOutcome { title, logline, shots, issues, attempts: attempt };
        if outcome.issues.is_empty() { return Ok(outcome); }
        let errors: Vec<String> = outcome.issues.iter().map(|i| match i.shot {
            Some(n) => format!("Shot {n}: {}", i.message), None => i.message.clone() }).collect();
        messages.push(json!({"role": "assistant", "content": content}));
        messages.push(json!({"role": "user", "content": format!("Fix these problems and reply with the full corrected JSON only:\n{}", errors.join("\n"))}));
        if best.as_ref().is_none_or(|b| outcome.issues.len() <= b.issues.len() && !outcome.shots.is_empty()) {
            best = Some(outcome);
        }
    }
    let mut out = best.ok_or("The planner produced nothing usable")?;
    out.attempts = attempt;
    Ok(out)
}

pub async fn list_models(base_url: &str) -> Result<Vec<String>, String> {
    let http = reqwest::Client::builder().timeout(Duration::from_secs(5)).build().map_err(|e| e.to_string())?;
    let v: Value = http.get(format!("{base_url}/models")).send().await.map_err(|_| LM_STUDIO_HINT.to_string())?
        .json().await.map_err(|_| LM_STUDIO_HINT.to_string())?;
    Ok(v.get("data").and_then(Value::as_array).cloned().unwrap_or_default().iter()
        .filter_map(|m| m.get("id").and_then(Value::as_str).map(String::from)).collect())
}
