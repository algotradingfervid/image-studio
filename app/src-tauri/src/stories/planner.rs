use super::{validate::validate, Character, DialogueLine, Issue, Shot, Story, Voice};
use serde_json::{json, Value};
use std::time::Duration;

pub const LM_STUDIO_HINT: &str = "Could not reach the local LLM. Start LM Studio's server (Developer → Start server, or `lms server start`) and load a model.";
const MAX_ATTEMPTS: u32 = 3;
const TEMPERATURE: f64 = 0.6;
/// A written plan runs about 40 tokens per second of film (50–120 word actions, dialogue,
/// setting, camera, sound, JSON). The cap leaves ~1.6x headroom over that.
const TOKENS_PER_FILM_S: u32 = 40;
const CAP_PER_FILM_S: u32 = 65;
const MIN_CAP: u32 = 4000;
const MAX_CAP: u32 = 14000;
/// Qwen3-style templates in LM Studio ignore `enable_thinking=false`; an empty think block as an assistant prefill really turns thinking off.
const THINK_PREFILL: &str = "<think>\n\n</think>\n\n";
/// Longest silence tolerated: before the first token (prompt processing) and between tokens.
const IDLE_TIMEOUT: Duration = Duration::from_secs(300);
/// Progress events are throttled to this interval.
const PROGRESS_EVERY: Duration = Duration::from_millis(400);

/// `max_tokens` for a story of `target_s` seconds.
pub fn max_tokens_for(target_s: u32) -> u32 {
    target_s.saturating_mul(CAP_PER_FILM_S).clamp(MIN_CAP, MAX_CAP)
}

/// Where a plan stands, emitted while the LLM writes it.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlanProgress {
    pub attempt: u32,
    pub max_attempts: u32,
    /// Streamed chunks so far in this attempt (≈ tokens).
    pub tokens: u32,
    /// A typical full plan for the target length, for a progress bar.
    pub expected_tokens: u32,
    pub elapsed_s: u32,
    /// "waiting" (prompt processing) or "writing".
    pub phase: &'static str,
}

struct Reply { content: String, truncated: bool, tokens: u32 }

#[derive(Debug, Clone)]
pub struct PlanOutcome { pub title: String, pub logline: String, pub voices: Vec<Voice>, pub shots: Vec<Shot>, pub issues: Vec<Issue>, pub attempts: u32 }

fn schema() -> Value {
    json!({"type": "object", "required": ["title", "logline", "voices", "shots"], "properties": {
        "title": {"type": "string"}, "logline": {"type": "string"},
        "voices": {"type": "array", "items": {"type": "object", "required": ["name", "voice"],
            "properties": {"name": {"type": "string"}, "voice": {"type": "string"}}}},
        "shots": {"type": "array", "minItems": 1, "items": {"type": "object",
            "required": ["duration_s", "characters", "continuity", "setting", "camera", "action", "dialogue", "sound"],
            "properties": {
                "duration_s": {"type": "integer", "minimum": 5, "maximum": 15},
                "characters": {"type": "array", "items": {"type": "string"}, "maxItems": 2},
                "continuity": {"type": "string", "enum": ["cut", "continues"]},
                "setting": {"type": "string"}, "camera": {"type": "string"},
                "action": {"type": "string"},
                "dialogue": {"type": "array", "items": {"type": "object", "required": ["speaker", "delivery", "line"],
                    "properties": {"speaker": {"type": "string"}, "delivery": {"type": "string"}, "line": {"type": "string"}}}},
                "sound": {"type": "string"}}}}}})
}

/// Research §3b system prompt (per-field rules for MiniMax H3's Context-IR format).
const SYSTEM_PROMPT: &str = r#"You are a film writer and director. Turn the brief into a short film told in shots. Each shot is
generated separately by a video model that reads your fields literally, so write only what can be
seen or heard, in plain English, present tense.

Characters you may use (exact names, no others; every character is an adult, 18 or older):
{people}

Hard limits:
- Total length about {target_s} seconds; each shot 5 to 15 seconds (duration_s, whole seconds).
  Vary shot lengths between 5 and 15 seconds to fit each beat (a reaction or insert is short, a
  long exchange or movement is long); do not give every shot the same length.
- At most 2 characters per shot. Dialogue only from characters in that shot.
- At most 2.5 spoken words per second of shot, and the last line must end at least 1 second before
  the shot ends.
- continuity: "cut" (new framing, place or time) or "continues". Use "continues" whenever a shot
  shows the same characters in the same place at the exact moment the previous shot ended (the
  action simply carries on); the first shot is "cut".
- Spread the dialogue across the shots so the story is carried by speech wherever the brief implies
  it: give most shots at least one line, not all of it in one shot, while staying within 2.5 spoken
  words per second. A shot may be silent only for a deliberate beat.
- Never describe anyone as under 18. Never describe a character's face, hair, body or clothing;
  that is fixed elsewhere.

How to write each field:
- voices (once for the whole film): for every character who speaks anywhere, invent a distinct voice
  from that character's description and role, one phrase giving gender, age range, pitch, timbre,
  pace, accent if any. The two voices must clearly differ from each other. The voices in the
  example below are placeholders; never copy them. The phrase is reused word for word in every shot.
- setting: one or two sentences: the place, time of day, light source and quality, weather, and two
  or three concrete props or background details. No characters here.
- camera: one sentence: shot size, where each character stands in the frame, and exactly ONE camera
  move from this list: static shot, push in, pull out, pan left/right, truck left/right, tilt up/down,
  pedestal up/down, arc shot, tracking shot, zoom in/out, shake slightly. Add "with small amplitude"
  or "with large amplitude" and "at slow speed" or "at fast speed" only when they matter.
  Example: "A medium two-shot frames {A} on the left and {B} on the right; the camera pushes in with
  small amplitude at slow speed."
- action: 3 to 6 sentences, 50 to 120 words, in the order things happen, covering the whole shot:
  starting positions and what each character is doing, the main action, small physical details
  (hands, gaze, props, weather on them). The last sentence must describe the held final pose: every
  character's position and gaze, motionless, that stays until the cut (no action still in motion).
  Refer to characters by name. Do not put spoken words in action. The first sentence of action is the opening
  state before anyone speaks.
- dialogue: each line is what is said, word for word, with no quotation marks, no stage directions
  and ending with . ? or !; delivery is a short phrase for what the speaker does while saying it and
  how, e.g. "turns her head toward {B} and says quietly". Lines are spoken in the order given, after
  the opening of the action.
- sound: one or two sentences of real sounds in this shot: ambience of the place and the sounds of
  the actions (footsteps, fabric, rain, doors, props). No dialogue, no music.

Reply with JSON only, in this shape:
{example}"#;

/// Research §3b example (two characters); `{A}`/`{B}` are the first two cast names.
const EXAMPLE_TWO: &str = r#"{"title": "Light Packing", "logline": "Two old partners decide on a rooftop to run tonight.",
 "voices": [{"name": "{A}", "voice": "<invent a voice for {A}: gender, age range, pitch, timbre, pace>"},
            {"name": "{B}", "voice": "<invent a different voice for {B}: gender, age range, pitch, timbre, pace>"}],
 "shots": [{"duration_s": 10, "characters": ["{A}", "{B}"], "continuity": "cut",
   "setting": "A flat rooftop at night, wet concrete shining under a single sodium lamp, a rusted water tank behind them and the city's lights spread out below in a light drizzle.",
   "camera": "A medium two-shot frames {A} on the left and {B} on the right at the rooftop's edge; the camera pushes in with small amplitude at slow speed.",
   "action": "{A} stands with her hands in her jacket pockets, watching the street below, while {B} leans on the low parapet beside her, rolling an unlit cigarette between his fingers. He pockets the cigarette as {A} nods once and looks back out over the city. Both hold still in the drizzle until the end of the shot.",
   "dialogue": [{"speaker": "{A}", "delivery": "turns her head toward {B} and says quietly", "line": "We leave tonight."},
                {"speaker": "{B}", "delivery": "stops rolling the cigarette, straightens up and answers with a tired half-smile", "line": "Then I'd better pack light."}],
   "sound": "Light rain patters on the wet concrete and the metal water tank while distant city traffic hums far below; fabric rustles softly as they shift their weight."}]}"#;

/// The same example for a one-character cast (no second character to copy).
const EXAMPLE_ONE: &str = r#"{"title": "Light Packing", "logline": "A woman decides on a rooftop to leave tonight.",
 "voices": [{"name": "{A}", "voice": "<invent a voice for {A}: gender, age range, pitch, timbre, pace>"}],
 "shots": [{"duration_s": 10, "characters": ["{A}"], "continuity": "cut",
   "setting": "A flat rooftop at night, wet concrete shining under a single sodium lamp, a rusted water tank behind her and the city's lights spread out below in a light drizzle.",
   "camera": "A medium shot frames {A} in the center at the rooftop's edge; the camera pushes in with small amplitude at slow speed.",
   "action": "{A} stands with her hands in her jacket pockets, watching the street below, rain beading on her shoulders. She takes a slow breath, pulls a train ticket from her pocket and turns it over between her fingers. She folds the ticket away and looks back out over the city, holding still in the drizzle until the end of the shot.",
   "dialogue": [{"speaker": "{A}", "delivery": "looks down at the street and says quietly to herself", "line": "I leave tonight."}],
   "sound": "Light rain patters on the wet concrete and the metal water tank while distant city traffic hums far below; fabric rustles softly as she moves."}]}"#;

/// A JSON string's inner text (quotes and backslashes escaped).
fn json_inner(s: &str) -> String {
    let q = serde_json::to_string(s).unwrap_or_default();
    q[1..q.len() - 1].to_string()
}

pub fn system_prompt(story: &Story, cast: &[Character]) -> String {
    let people: Vec<String> = cast.iter().map(|c| format!("- {}: {}", c.name, c.description)).collect();
    let a = cast.first().map(|c| c.name.as_str()).unwrap_or("Mara");
    let b = cast.get(1).map(|c| c.name.as_str());
    let example = match b {
        Some(b) => EXAMPLE_TWO.replace("{A}", &json_inner(a)).replace("{B}", &json_inner(b)),
        None => EXAMPLE_ONE.replace("{A}", &json_inner(a)),
    };
    let mut text = SYSTEM_PROMPT.to_string();
    if b.is_none() {
        // One-character cast: examples without a second character.
        text = text
            .replace("A medium two-shot frames {A} on the left and {B} on the right;", "A medium shot frames {A} in the center;")
            .replace("turns her head toward {B} and says quietly", "looks down at the street and says quietly");
    }
    text
        .replace("{A}", a)
        .replace("{B}", b.unwrap_or("the other character"))
        .replace("{target_s}", &story.target_s.to_string())
        .replace("{people}", &people.join("\n"))
        .replace("{example}", &example)
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
            .map(|d| DialogueLine { speaker: id_of(&s(d, "speaker"), issues, pos), line: s(d, "line"), delivery: s(d, "delivery") })
            .filter(|d| !d.line.is_empty()).collect();
        let continuity = if s(x, "continuity") == "continues" { "continues" } else { "cut" };
        Shot { id: uuid::Uuid::new_v4().to_string(), story_id: story.id.clone(), position: pos,
            duration_s: x.get("duration_s").and_then(Value::as_u64).unwrap_or(0) as u32,
            characters, setting: s(x, "setting"), camera: s(x, "camera"), action: s(x, "action"),
            dialogue, sound: s(x, "sound"), continuity: continuity.into(), approved_take_id: None }
    }).collect()
}

/// Plan voices by character id (unknown names become issues; the first phrase per character wins).
fn to_voices(v: &Value, cast: &[Character], issues: &mut Vec<Issue>) -> Vec<Voice> {
    let mut out: Vec<Voice> = Vec::new();
    for x in v.get("voices").and_then(Value::as_array).cloned().unwrap_or_default() {
        let name = x.get("name").and_then(Value::as_str).unwrap_or("").trim().to_string();
        let voice = x.get("voice").and_then(Value::as_str).unwrap_or("").trim().to_string();
        if voice.is_empty() {
            continue;
        }
        match cast.iter().find(|c| c.name.eq_ignore_ascii_case(&name)) {
            Some(c) if !out.iter().any(|o| o.character_id == c.id) => out.push(Voice { character_id: c.id.clone(), voice }),
            Some(_) => {}
            None => issues.push(Issue { shot: None, message: format!("{name} is not in the cast") }),
        }
    }
    out
}

/// One chat completion, streamed. Outer Err = transport failure (LLM not reachable or silent);
/// inner Err = HTTP error body. A server that ignores `stream` and answers with plain JSON works too.
async fn chat(http: &reqwest::Client, base_url: &str, body: &Value, started: std::time::Instant,
              progress: &mut (dyn FnMut(u32, &'static str) + Send)) -> Result<Result<Reply, String>, String> {
    let send = http.post(format!("{base_url}/chat/completions")).json(body).send();
    let mut resp = tokio::time::timeout(IDLE_TIMEOUT, send).await
        .map_err(|_| "The local LLM did not start answering in time".to_string())?
        .map_err(|_| LM_STUDIO_HINT.to_string())?;
    let status = resp.status().as_u16();
    let sse = resp.headers().get("content-type").and_then(|v| v.to_str().ok()).is_some_and(|t| t.contains("text/event-stream"));
    if status >= 400 || !sse {
        let v: Value = resp.json().await.unwrap_or(Value::Null);
        if status >= 400 {
            return Ok(Err(v.to_string()));
        }
        // Some servers put the whole answer in `reasoning_content` and leave `content` empty.
        let field = |k: &str| v.pointer(&format!("/choices/0/message/{k}")).and_then(Value::as_str).filter(|s| !s.trim().is_empty());
        let content = field("content").or_else(|| field("reasoning_content")).map(String::from)
            .or_else(|| v.pointer("/choices/0/message/content").and_then(Value::as_str).map(String::from))
            .ok_or_else(|| "The planner returned no message".to_string())?;
        let truncated = v.pointer("/choices/0/finish_reason").and_then(Value::as_str) == Some("length");
        let tokens = v.pointer("/usage/completion_tokens").and_then(Value::as_u64).unwrap_or(0) as u32;
        return Ok(Ok(Reply { content, truncated, tokens }));
    }
    let (mut buf, mut content, mut reasoning) = (Vec::<u8>::new(), String::new(), String::new());
    let (mut finish, mut tokens, mut last_emit) = (None::<String>, 0u32, started);
    'stream: loop {
        let chunk = tokio::time::timeout(IDLE_TIMEOUT, resp.chunk()).await
            .map_err(|_| "The local LLM stopped answering".to_string())?
            .map_err(|e| format!("The connection to the local LLM dropped: {e}"))?;
        let Some(chunk) = chunk else { break };
        buf.extend_from_slice(&chunk);
        while let Some(i) = buf.iter().position(|&b| b == b'\n') {
            let line = String::from_utf8_lossy(&buf[..i]).trim().to_string();
            buf.drain(..=i);
            let Some(data) = line.strip_prefix("data:").map(str::trim) else { continue };
            if data == "[DONE]" { break 'stream; }
            let Ok(v) = serde_json::from_str::<Value>(data) else { continue };
            if let Some(e) = v.get("error") { return Ok(Err(e.to_string())); }
            if let Some(f) = v.pointer("/choices/0/finish_reason").and_then(Value::as_str) { finish = Some(f.to_string()); }
            if let Some(t) = v.pointer("/choices/0/delta/content").and_then(Value::as_str).filter(|t| !t.is_empty()) {
                content.push_str(t);
                tokens += 1;
            } else if let Some(t) = v.pointer("/choices/0/delta/reasoning_content").and_then(Value::as_str).filter(|t| !t.is_empty()) {
                reasoning.push_str(t);
                tokens += 1;
            }
            if let Some(u) = v.pointer("/usage/completion_tokens").and_then(Value::as_u64) { tokens = tokens.max(u as u32); }
            if last_emit.elapsed() >= PROGRESS_EVERY {
                last_emit = std::time::Instant::now();
                progress(tokens, "writing");
            }
        }
    }
    progress(tokens, "writing");
    let content = if content.trim().is_empty() { reasoning } else { content };
    if content.trim().is_empty() { return Err("The planner returned no message".into()); }
    Ok(Ok(Reply { content, truncated: finish.as_deref() == Some("length"), tokens }))
}

pub async fn plan(base_url: &str, model: &str, story: &Story, cast: &[Character]) -> Result<PlanOutcome, String> {
    plan_with_progress(base_url, model, story, cast, &|_| {}).await
}

/// Plans the story, reporting `PlanProgress` as the reply streams in.
pub async fn plan_with_progress(base_url: &str, model: &str, story: &Story, cast: &[Character],
                                on_progress: &(dyn Fn(&PlanProgress) + Send + Sync)) -> Result<PlanOutcome, String> {
    let http = reqwest::Client::builder().connect_timeout(Duration::from_secs(10)).build().map_err(|e| e.to_string())?;
    let max_tokens = max_tokens_for(story.target_s);
    let expected_tokens = story.target_s.saturating_mul(TOKENS_PER_FILM_S).min(max_tokens);
    let started = std::time::Instant::now();
    let mut messages = vec![json!({"role": "system", "content": system_prompt(story, cast)}),
                            json!({"role": "user", "content": user_prompt(story)})];
    let mut structured = true;
    let mut best: Option<PlanOutcome> = None;
    let mut last_issue = String::new();
    let mut attempt = 0;
    while attempt < MAX_ATTEMPTS {
        attempt += 1;
        let mut sent = messages.clone();
        sent.push(json!({"role": "assistant", "content": THINK_PREFILL}));
        let mut body = json!({"model": model, "messages": sent, "temperature": TEMPERATURE, "max_tokens": max_tokens, "stream": true,
            "chat_template_kwargs": {"enable_thinking": false}});
        if structured {
            body["response_format"] = json!({"type": "json_schema", "json_schema": {"name": "story_plan", "strict": true, "schema": schema()}});
        }
        let report = |tokens: u32, phase: &'static str| on_progress(&PlanProgress {
            attempt, max_attempts: MAX_ATTEMPTS, tokens, expected_tokens, elapsed_s: started.elapsed().as_secs() as u32, phase });
        report(0, "waiting");
        let mut report = report;
        let reply = match chat(&http, base_url, &body, started, &mut report).await? {
            Ok(r) => r,
            Err(err) if structured && err.contains("response_format") => { structured = false; attempt -= 1; continue; }
            Err(err) => return Err(format!("The local LLM returned an error: {err}")),
        };
        if reply.truncated {
            // A cut-off plan is not valid JSON, and retrying only replays the same long reply: keep an earlier
            // attempt if there is one, otherwise say why it failed.
            if best.is_some() { break; }
            return Err(format!("The plan was cut off after {} tokens (limit {max_tokens}) — the story is too long for one reply. \
                Shorten the target length or split the brief into two stories.", reply.tokens));
        }
        let content = reply.content;
        let mut issues = Vec::new();
        let (title, logline, voices, shots) = match parse_reply(&content) {
            Ok(v) => {
                let voices = to_voices(&v, cast, &mut issues);
                let shots = to_shots(&v, story, cast, &mut issues);
                (v.get("title").and_then(Value::as_str).unwrap_or("").to_string(),
                 v.get("logline").and_then(Value::as_str).unwrap_or("").to_string(), voices, shots)
            }
            Err(e) => { issues.push(Issue { shot: None, message: e }); (String::new(), String::new(), Vec::new(), Vec::new()) }
        };
        // The plan's voices are checked too (adults only).
        let planned = Story { voices: voices.clone(), ..story.clone() };
        issues.extend(validate(&planned, &shots, cast));
        let outcome = PlanOutcome { title, logline, voices, shots, issues, attempts: attempt };
        if outcome.issues.is_empty() { return Ok(outcome); }
        let errors: Vec<String> = outcome.issues.iter().map(|i| match i.shot {
            Some(n) => format!("Shot {n}: {}", i.message), None => i.message.clone() }).collect();
        messages.push(json!({"role": "assistant", "content": content}));
        messages.push(json!({"role": "user", "content": format!("Fix these problems and reply with the full corrected JSON only:\n{}", errors.join("\n"))}));
        last_issue = outcome.issues.first().map(|i| i.message.clone()).unwrap_or_default();
        // Plans with shots beat plans without; among those, fewest issues wins (ties go to the later attempt).
        let better = !outcome.shots.is_empty()
            && best.as_ref().is_none_or(|b| outcome.issues.len() <= b.issues.len());
        if better {
            best = Some(outcome);
        }
    }
    let mut out = best.ok_or_else(|| format!("The planner produced nothing usable: {last_issue}"))?;
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
