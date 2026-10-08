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
    pub defaults: Defaults,
    #[serde(default)]
    pub civitai_base_models: Vec<String>,
    pub files: Vec<ModelFile>,
    /// Unknown registry fields are preserved and passed to the UI.
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

impl Model {
    pub fn total_bytes(&self) -> u64 {
        self.files.iter().filter_map(|f| f.size_bytes).sum()
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Registry {
    pub version: u32,
    pub models: Vec<Model>,
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
    pub fn shared_with(&self, model_id: &str, folder: &str, filename: &str) -> Vec<String> {
        self.models
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
        assert!(r.aspect("5:5").is_err());
        // ae.safetensors is shared between chroma and zimage.
        assert_eq!(
            r.shared_with("chroma", "vae", "ae.safetensors"),
            vec!["zimage"]
        );
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
