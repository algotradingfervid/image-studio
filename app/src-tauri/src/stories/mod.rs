//! Stories: multi-shot video stories planned by a local LLM, rendered shot by shot, then assembled.
use serde::{Deserialize, Serialize};

pub mod compile;
pub mod ffmpeg;
pub mod planner;
pub mod render;
pub mod store;
pub mod validate;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Character {
    pub id: String,
    pub name: String,
    pub description: String,
    /// "generated" | "real_person"
    pub source: String,
    pub consent: bool,
    pub adult: bool,
    pub ref_ids: Vec<String>,
    /// Display paths next to each `ref_ids` entry: filled when read, ignored when saved.
    #[serde(default)]
    pub ref_paths: Vec<String>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DialogueLine {
    /// character id
    pub speaker: String,
    pub line: String,
    /// What the speaker does while saying the line and how (may be empty).
    #[serde(default)]
    pub delivery: String,
}

/// The voice phrase of one character, pasted verbatim at their first line in every shot.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct Voice {
    pub character_id: String,
    pub voice: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Shot {
    pub id: String,
    pub story_id: String,
    pub position: u32,
    pub duration_s: u32,
    /// character ids
    pub characters: Vec<String>,
    pub setting: String,
    pub camera: String,
    pub action: String,
    pub dialogue: Vec<DialogueLine>,
    /// Real sounds of the shot (may be empty: a generic ambience is used).
    #[serde(default)]
    pub sound: String,
    /// "cut" | "continues"
    pub continuity: String,
    pub approved_take_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Story {
    pub id: String,
    pub title: String,
    pub logline: String,
    pub brief: String,
    pub target_s: u32,
    /// "16:9" | "9:16" | "1:1"
    pub aspect: String,
    pub style: String,
    /// character ids, cast order
    pub cast: Vec<String>,
    /// one voice phrase per speaking character
    #[serde(default)]
    pub voices: Vec<Voice>,
    /// "draft" | "planned" | "assembled"
    pub status: String,
    pub result_image_id: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

/// A partial story update: only the fields that are set are written.
#[derive(Debug, Clone, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct StoryPatch {
    pub title: Option<String>,
    pub brief: Option<String>,
    pub target_s: Option<u32>,
    pub aspect: Option<String>,
    pub style: Option<String>,
    pub cast: Option<Vec<String>>,
    pub voices: Option<Vec<Voice>>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Issue {
    /// 1-based shot position
    pub shot: Option<u32>,
    pub message: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct StoryView {
    pub story: Story,
    pub cast: Vec<Character>,
    pub shots: Vec<Shot>,
    pub takes: Vec<crate::db::ImageRecord>,
    pub result: Option<crate::db::ImageRecord>,
    pub issues: Vec<Issue>,
}

/// The model to plan with: `configured` when LM Studio lists it, else the
/// first listed model. Unreachable → `planner::LM_STUDIO_HINT`.
pub async fn resolve_llm_model(base_url: &str, configured: &str) -> Result<String, String> {
    let models = planner::list_models(base_url).await?;
    if models.iter().any(|m| m == configured) {
        return Ok(configured.to_string());
    }
    models.into_iter().next().ok_or_else(|| "Load a model in LM Studio first".to_string())
}

/// The voices to keep for a story: at most one per cast member, non-empty phrases only.
/// A partial list is fine (a speaker without a voice gets no voice phrase).
pub fn cast_voices(cast: &[String], voices: Vec<Voice>) -> Vec<Voice> {
    let mut out: Vec<Voice> = Vec::new();
    for v in voices {
        let voice = v.voice.trim().to_string();
        if !voice.is_empty() && cast.contains(&v.character_id) && !out.iter().any(|o| o.character_id == v.character_id) {
            out.push(Voice { character_id: v.character_id, voice });
        }
    }
    out
}

pub fn resolution_for(aspect: &str) -> Result<&'static str, String> {
    match aspect {
        "16:9" => Ok("1344x768"),
        "9:16" => Ok("768x1344"),
        "1:1" => Ok("768x768"),
        other => Err(format!("Unknown aspect {other}")),
    }
}
