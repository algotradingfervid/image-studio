//! Model registry embedded from `shared/models.json` (the single source of truth).

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use std::collections::BTreeMap;

pub const MODELS_JSON: &str = include_str!("../../../shared/models.json");

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ModelFile {
    pub folder: String,
    pub filename: String,
    pub url: String,
    #[serde(default)]
    pub size_bytes: Option<u64>,
    #[serde(default)]
    pub sha256: Option<String>,
    #[serde(default)]
    pub gated: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Defaults {
    #[serde(default)]
    pub steps: u32,
    #[serde(default)]
    pub cfg: f64,
    #[serde(default)]
    pub sampler: String,
    #[serde(default)]
    pub scheduler: String,
    #[serde(default)]
    pub negative_prompt: String,
    /// Any extra default keys are passed through untouched.
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Model {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub license: String,
    #[serde(default)]
    pub precision: String,
    #[serde(default)]
    pub max_references: u32,
    #[serde(default)]
    pub supports_negative_prompt: bool,
    /// img2img ("start image" + strength) support; absent = false.
    #[serde(default, rename = "supportsImg2Img")]
    pub supports_img2img: bool,
    pub defaults: Defaults,
    #[serde(default)]
    pub civitai_base_models: Vec<String>,
    pub files: Vec<ModelFile>,
    // ----- video models only (`videoModels`, spec v5) -----
    /// "t2v" and/or "i2v".
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub modes: Option<Vec<String>>,
    /// Generates an audio track.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub audio: Option<bool>,
    /// Network volume holding the files (informational; the pod profile
    /// decides which volume is mounted).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub volume: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub limits: Option<VideoLimits>,
    /// Unknown registry fields are preserved and passed to the UI.
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

/// Video model limits (from the official templates).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct VideoLimits {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub min_duration_s: Option<f64>,
    #[serde(default)]
    pub max_duration_s: Option<f64>,
    /// Resolution options: strings ("1280x720") or objects ({id|label, width, height}).
    #[serde(default)]
    pub resolutions: Vec<Value>,
    #[serde(default)]
    pub fps_options: Vec<f64>,
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

/// Id of a resolution option: a string as-is; an object's `id`, `label`,
/// or "WxH" (the UI's `resolutionId` matches this).
pub fn resolution_id(v: &Value) -> Option<String> {
    if let Some(s) = v.as_str() {
        return Some(s.to_string());
    }
    let o = v.as_object()?;
    for k in ["id", "label"] {
        if let Some(s) = o.get(k).and_then(Value::as_str) {
            return Some(s.to_string());
        }
    }
    let w = o.get("width").and_then(Value::as_u64)?;
    let h = o.get("height").and_then(Value::as_u64)?;
    Some(format!("{w}x{h}"))
}

impl Model {
    pub fn total_bytes(&self) -> u64 {
        self.files.iter().filter_map(|f| f.size_bytes).sum()
    }

    /// A numeric default from `defaults` (typed field or extra key).
    pub fn default_f64(&self, key: &str) -> Option<f64> {
        self.defaults.extra.get(key).and_then(Value::as_f64)
    }

    pub fn default_str(&self, key: &str) -> Option<String> {
        self.defaults
            .extra
            .get(key)
            .and_then(Value::as_str)
            .map(str::to_string)
    }

    pub fn has_mode(&self, mode: &str) -> bool {
        self.modes
            .as_ref()
            .map(|m| m.iter().any(|x| x == mode))
            .unwrap_or(true)
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Registry {
    pub version: u32,
    pub models: Vec<Model>,
    /// Video models (spec v5); optional until the worker side ships them.
    #[serde(default)]
    pub video_models: Vec<Model>,
    pub aspect_ratios: BTreeMap<String, [u32; 2]>,
}

impl Registry {
    pub fn embedded() -> Registry {
        Self::parse(MODELS_JSON).expect("shared/models.json is invalid")
    }

    pub fn parse(json: &str) -> Result<Registry, String> {
        serde_json::from_str(json).map_err(|e| format!("Invalid model registry: {e}"))
    }

    pub fn model(&self, id: &str) -> Option<&Model> {
        self.models.iter().find(|m| m.id == id)
    }

    pub fn require_model(&self, id: &str) -> Result<&Model, String> {
        self.model(id)
            .ok_or_else(|| format!("Unknown model \"{id}\""))
    }

    pub fn video_model(&self, id: &str) -> Option<&Model> {
        self.video_models.iter().find(|m| m.id == id)
    }

    pub fn require_video_model(&self, id: &str) -> Result<&Model, String> {
        self.video_model(id)
            .ok_or_else(|| format!("Unknown video model \"{id}\""))
    }

    pub fn is_video_model(&self, id: &str) -> bool {
        self.video_model(id).is_some()
    }

    /// An image or video model.
    pub fn any_model(&self, id: &str) -> Result<&Model, String> {
        self.model(id)
            .or_else(|| self.video_model(id))
            .ok_or_else(|| format!("Unknown model \"{id}\""))
    }

    /// The models sharing a volume with `id` (its own list: image or video).
    pub fn family_of(&self, id: &str) -> &[Model] {
        if self.is_video_model(id) {
            &self.video_models
        } else {
            &self.models
        }
    }

    pub fn aspect(&self, ratio: &str) -> Result<(u32, u32), String> {
        self.aspect_ratios
            .get(ratio)
            .map(|[w, h]| (*w, *h))
            .ok_or_else(|| format!("Unknown aspect ratio \"{ratio}\""))
    }

    /// Map a Civitai `baseModel` string to a registry model id.
    /// Exact match first, then a normalised match (lowercase, alphanumerics only).
    pub fn model_for_civitai_base(&self, base: &str) -> Option<String> {
        if let Some(m) = self
            .models
            .iter()
            .find(|m| m.civitai_base_models.iter().any(|b| b == base))
        {
            return Some(m.id.clone());
        }
        let norm = normalise(base);
        self.models
            .iter()
            .find(|m| m.civitai_base_models.iter().any(|b| normalise(b) == norm))
            .map(|m| m.id.clone())
    }

    /// Ids of other models that also use the file `(folder, filename)`.
    /// Only models on the same volume (image or video list) share files.
    pub fn shared_with(&self, model_id: &str, folder: &str, filename: &str) -> Vec<String> {
        self.family_of(model_id)
            .iter()
            .filter(|m| m.id != model_id)
            .filter(|m| {
                m.files
                    .iter()
                    .any(|f| f.folder == folder && f.filename == filename)
            })
            .map(|m| m.id.clone())
            .collect()
    }
}

fn normalise(s: &str) -> String {
    s.chars()
        .filter(|c| c.is_ascii_alphanumeric())
        .flat_map(|c| c.to_lowercase())
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn embedded_registry_parses() {
        let r = Registry::embedded();
        assert!(r.models.len() >= 4);
        for id in ["chroma", "zimage", "flux2", "qwen"] {
            let m = r.require_model(id).unwrap();
            assert!(!m.files.is_empty());
        }
        assert_eq!(r.aspect("1:1").unwrap(), (1024, 1024));
        let img2img: Vec<(&str, bool)> = r
            .models
            .iter()
            .map(|m| (m.id.as_str(), m.supports_img2img))
            .collect();
        assert_eq!(
            img2img,
            [
                ("chroma", true),
                ("zimage", true),
                ("flux2", false),
                ("qwen", false)
            ]
        );
        // exposed to the UI under its registry name, not duplicated in `extra`
        let v = serde_json::to_value(r.model("chroma").unwrap()).unwrap();
        assert_eq!(v["supportsImg2Img"], serde_json::json!(true));
        assert!(!r
            .model("chroma")
            .unwrap()
            .extra
            .contains_key("supportsImg2Img"));
        assert!(r.aspect("5:5").is_err());
        // ae.safetensors is shared between chroma and zimage.
        assert_eq!(
            r.shared_with("chroma", "vae", "ae.safetensors"),
            vec!["zimage"]
        );
    }

    #[test]
    fn video_models_are_optional_and_parsed() {
        let base = r#"{"version": 1, "aspectRatios": {"1:1": [1024, 1024]}, "models": []}"#;
        let r = Registry::parse(base).unwrap();
        assert!(r.video_models.is_empty());
        let with = r#"{"version": 1, "aspectRatios": {}, "models": [], "videoModels": [
            {"id": "h3", "name": "MiniMax H3", "license": "MiniMax H3 Community",
             "modes": ["t2v", "i2v"], "audio": true, "volume": "image-studio-video",
             "defaults": {"durationS": 5, "fps": 24, "resolution": "1280x720", "steps": 30, "cfg": 4.0},
             "limits": {"maxDurationS": 10, "resolutions": ["1280x720", {"id": "720p", "width": 1280, "height": 720}], "fpsOptions": [24, 25]},
             "files": [{"folder": "vae", "filename": "ae.safetensors", "url": "u", "sizeBytes": 5}]}]}"#;
        let r = Registry::parse(with).unwrap();
        let m = r.require_video_model("h3").unwrap();
        assert!(r.model("h3").is_none(), "video models are not image models");
        assert_eq!(r.any_model("h3").unwrap().id, "h3");
        assert_eq!(m.default_f64("durationS"), Some(5.0));
        assert_eq!(m.default_str("resolution").as_deref(), Some("1280x720"));
        assert_eq!(m.defaults.steps, 30);
        let l = m.limits.as_ref().unwrap();
        assert_eq!(l.max_duration_s, Some(10.0));
        let ids: Vec<String> = l.resolutions.iter().filter_map(resolution_id).collect();
        assert_eq!(ids, ["1280x720", "720p"]);
        assert!(m.has_mode("i2v") && !m.has_mode("x"));
        let v = serde_json::to_value(m).unwrap();
        assert_eq!(v["audio"], serde_json::json!(true));
        assert_eq!(v["limits"]["fpsOptions"], serde_json::json!([24.0, 25.0]));
        assert_eq!(v["defaults"]["fps"], serde_json::json!(24));
        // image models don't grow video keys
        let img = serde_json::to_value(Registry::embedded().model("chroma").unwrap()).unwrap();
        assert!(img.get("limits").is_none() && img.get("modes").is_none());
        // a file named like an image model's file is not "shared" across volumes
        assert!(r.shared_with("h3", "vae", "ae.safetensors").is_empty());
    }

    #[test]
    fn embedded_video_models_parse() {
        // shared/models.json `videoModels` (spec v5), as shipped by the worker side.
        let r = Registry::embedded();
        for id in ["h3", "ltx25"] {
            let m = r.require_video_model(id).unwrap();
            assert!(r.model(id).is_none());
            assert!(m.has_mode("t2v") && m.has_mode("i2v"));
            assert_eq!(m.audio, Some(true));
            assert_eq!(m.volume.as_deref(), Some("image-studio-video"));
            let l = m.limits.as_ref().unwrap();
            assert!(l.max_duration_s.unwrap() > 0.0 && !l.fps_options.is_empty());
            let res: Vec<String> = l.resolutions.iter().filter_map(resolution_id).collect();
            assert!(res.contains(&m.default_str("resolution").unwrap()));
            assert!(!m.files.is_empty());
        }
    }

    #[test]
    fn civitai_base_mapping() {
        let r = Registry::embedded();
        assert_eq!(
            r.model_for_civitai_base("Chroma").as_deref(),
            Some("chroma")
        );
        assert_eq!(
            r.model_for_civitai_base("chroma").as_deref(),
            Some("chroma")
        );
        assert_eq!(
            r.model_for_civitai_base("ZImageTurbo").as_deref(),
            Some("zimage")
        );
        assert_eq!(
            r.model_for_civitai_base("Flux.2 Klein 9B").as_deref(),
            Some("flux2")
        );
        assert_eq!(r.model_for_civitai_base("SDXL 1.0"), None);
    }
}
