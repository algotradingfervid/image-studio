//! LoRA link resolver for Civitai and Hugging Face URLs.

use crate::registry::Registry;
use serde::Serialize;
use serde_json::{json, Value};
use std::time::Duration;

pub const CIVITAI_ROOT: &str = "https://civitai.com";
pub const HF_ROOT: &str = "https://huggingface.co";

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ResolvedLora {
    pub source: String, // "huggingface" | "civitai"
    pub name: String,
    pub download_url: String,
    pub filename: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub size_bytes: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sha256: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub base_model: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub suggested_model_id: Option<String>,
    pub trigger_words: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub preview_url: Option<String>,
    /// Civitai `sizeKB` is approximate, so the size must not be used for
    /// download verification. Internal only.
    #[serde(skip)]
    pub size_exact: bool,
}

#[derive(Debug, Clone, PartialEq)]
pub enum Link {
    CivitaiModel(u64),
    CivitaiVersion(u64),
    HuggingFace {
        repo: String,
        revision: String,
        path: String,
    },
}

fn parse_id(s: &str) -> Result<u64, String> {
    s.parse::<u64>()
        .map_err(|_| format!("\"{s}\" is not a valid Civitai id"))
}

pub fn parse_link(input: &str) -> Result<Link, String> {
    let url = url::Url::parse(input.trim()).map_err(|_| {
        "That doesn't look like a URL. Paste a Civitai or Hugging Face link.".to_string()
    })?;
    let host = url
        .host_str()
        .unwrap_or("")
        .trim_start_matches("www.")
        .to_lowercase();
    let segs: Vec<&str> = url
        .path_segments()
        .map(|s| s.filter(|p| !p.is_empty()).collect())
        .unwrap_or_default();

    if host == "civitai.com" || host.ends_with(".civitai.com") || host.starts_with("civitai.") {
        if let Some((_, v)) = url.query_pairs().find(|(k, _)| k == "modelVersionId") {
            return Ok(Link::CivitaiVersion(parse_id(&v)?));
        }
        return match segs.as_slice() {
            ["models", id, ..] => Ok(Link::CivitaiModel(parse_id(id)?)),
            ["model-versions", id, ..] => Ok(Link::CivitaiVersion(parse_id(id)?)),
            ["api", "download", "models", id, ..] => Ok(Link::CivitaiVersion(parse_id(id)?)),
            ["api", "v1", "model-versions", id, ..] => Ok(Link::CivitaiVersion(parse_id(id)?)),
            ["api", "v1", "models", id, ..] => Ok(Link::CivitaiModel(parse_id(id)?)),
            _ => Err("Unrecognised Civitai link. Use a model page link like https://civitai.com/models/123?modelVersionId=456".into()),
        };
    }

    if host == "huggingface.co" || host == "hf.co" {
        return match segs.as_slice() {
            [owner, repo, kind, rev, rest @ ..]
                if (*kind == "blob" || *kind == "resolve") && !rest.is_empty() =>
            {
                let path = rest.join("/");
                if !path.to_lowercase().ends_with(".safetensors") {
                    return Err("The Hugging Face link must point to a .safetensors file".into());
                }
                Ok(Link::HuggingFace {
                    repo: format!("{owner}/{repo}"),
                    revision: rev.to_string(),
                    path,
                })
            }
            _ => Err("Use a Hugging Face file link (…/blob/main/file.safetensors or …/resolve/main/file.safetensors)".into()),
        };
    }

    Err("Only Civitai and Hugging Face links are supported".into())
}

/// Make a filename acceptable to the worker: no path parts, safe characters,
/// `.safetensors` extension.
pub fn sanitize_filename(name: &str) -> Result<String, String> {
    let base = name.rsplit(['/', '\\']).next().unwrap_or("");
    let cleaned: String = base
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-') {
                c
            } else {
                '_'
            }
        })
        .collect();
    let cleaned = cleaned.trim_start_matches('.').to_string();
    if !cleaned.to_lowercase().ends_with(".safetensors") || cleaned.len() <= ".safetensors".len() {
        return Err(format!("\"{name}\" is not a .safetensors file"));
    }
    if cleaned.contains("..") {
        return Err(format!("Invalid filename \"{name}\""));
    }
    Ok(cleaned)
}

pub struct LinkResolver {
    http: reqwest::Client,
    civitai_root: String,
    hf_root: String,
    civitai_key: Option<String>,
}

impl LinkResolver {
    pub fn new(civitai_root: &str, hf_root: &str, civitai_key: Option<String>) -> LinkResolver {
        LinkResolver {
            http: reqwest::Client::builder()
                .timeout(Duration::from_secs(30))
                .user_agent("ImageStudio/0.1")
                .build()
                .expect("http client"),
            civitai_root: civitai_root.trim_end_matches('/').to_string(),
            hf_root: hf_root.trim_end_matches('/').to_string(),
            civitai_key,
        }
    }

    pub async fn resolve(&self, url: &str, registry: &Registry) -> Result<ResolvedLora, String> {
        match parse_link(url)? {
            Link::CivitaiVersion(v) => self.civitai_version(v, registry).await,
            Link::CivitaiModel(m) => {
                let model = self
                    .civitai_get(&format!("/api/v1/models/{m}"), "model")
                    .await?;
                let vid = model
                    .get("modelVersions")
                    .and_then(Value::as_array)
                    .and_then(|vs| vs.first())
                    .and_then(|v| v.get("id"))
                    .and_then(Value::as_u64)
                    .ok_or("This Civitai model has no published versions")?;
                self.civitai_version(vid, registry).await
            }
            Link::HuggingFace {
                repo,
                revision,
                path,
            } => self.huggingface(&repo, &revision, &path).await,
        }
    }

    async fn civitai_get(&self, path: &str, what: &str) -> Result<Value, String> {
        let mut req = self.http.get(format!("{}{}", self.civitai_root, path));
        if let Some(k) = &self.civitai_key {
            req = req.bearer_auth(k);
        }
        let resp = req
            .send()
            .await
            .map_err(|e| format!("Could not reach Civitai: {}", e.without_url()))?;
        match resp.status().as_u16() {
            200..=299 => resp
                .json()
                .await
                .map_err(|_| "Civitai returned an unreadable response".into()),
            404 => Err(format!("Civitai {what} not found")),
            401 | 403 => Err("Civitai refused access; add a Civitai API key in Settings".into()),
            s => Err(format!("Civitai error {s}")),
        }
    }

    async fn civitai_version(&self, id: u64, registry: &Registry) -> Result<ResolvedLora, String> {
        let v = self
            .civitai_get(&format!("/api/v1/model-versions/{id}"), "model version")
            .await?;
        civitai_from_version(&v, id, registry)
    }

    async fn huggingface(&self, repo: &str, rev: &str, path: &str) -> Result<ResolvedLora, String> {
        let filename = sanitize_filename(path.rsplit('/').next().unwrap_or(path))?;
        let resp = self
            .http
            .post(format!(
                "{}/api/models/{repo}/paths-info/{rev}",
                self.hf_root
            ))
            .json(&json!({ "paths": [path] }))
            .send()
            .await
            .map_err(|e| format!("Could not reach Hugging Face: {}", e.without_url()))?;
        let (size, sha) = match resp.status().as_u16() {
            200..=299 => {
                let v: Value = resp
                    .json()
                    .await
                    .map_err(|_| "Hugging Face returned an unreadable response".to_string())?;
                let entry = v
                    .as_array()
                    .and_then(|a| {
                        a.iter()
                            .find(|e| e.get("path").and_then(Value::as_str) == Some(path))
                    })
                    .ok_or("File not found in that Hugging Face repo")?;
                let lfs = entry.get("lfs");
                let size = lfs
                    .and_then(|l| l.get("size"))
                    .or_else(|| entry.get("size"))
                    .and_then(Value::as_u64);
                let sha = lfs
                    .and_then(|l| l.get("oid"))
                    .and_then(Value::as_str)
                    .map(str::to_lowercase);
                (size, sha)
            }
            // Gated/private: the worker downloads with HF_TOKEN; metadata is optional.
            401 | 403 => (None, None),
            404 => return Err("Hugging Face repo or file not found".into()),
            s => return Err(format!("Hugging Face error {s}")),
        };
        let name = filename.trim_end_matches(".safetensors").to_string();
        Ok(ResolvedLora {
            source: "huggingface".into(),
            name,
            download_url: format!("{HF_ROOT}/{repo}/resolve/{rev}/{path}"),
            filename,
            size_bytes: size,
            sha256: sha,
            base_model: None,
            suggested_model_id: None,
            trigger_words: vec![],
            preview_url: None,
            size_exact: size.is_some(),
        })
    }
}

/// Build a result from a Civitai `/api/v1/model-versions/{id}` response.
pub fn civitai_from_version(
    v: &Value,
    id: u64,
    registry: &Registry,
) -> Result<ResolvedLora, String> {
    let model_type = v
        .pointer("/model/type")
        .and_then(Value::as_str)
        .unwrap_or("");
    if !model_type.is_empty()
        && !matches!(
            model_type.to_uppercase().as_str(),
            "LORA" | "LOCON" | "DORA"
        )
    {
        return Err(format!("This Civitai link is a {model_type}, not a LoRA"));
    }
    let files = v
        .get("files")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let is_st = |f: &&Value| {
        f.get("name")
            .and_then(Value::as_str)
            .is_some_and(|n| n.to_lowercase().ends_with(".safetensors"))
    };
    let file = files
        .iter()
        .filter(is_st)
        .find(|f| f.get("primary").and_then(Value::as_bool) == Some(true))
        .or_else(|| {
            files
                .iter()
                .filter(is_st)
                .find(|f| f.get("type").and_then(Value::as_str) == Some("Model"))
        })
        .or_else(|| files.iter().find(is_st))
        .ok_or("This Civitai version has no .safetensors file")?;
    let filename = sanitize_filename(file.get("name").and_then(Value::as_str).unwrap_or(""))?;
    let size = file
        .get("sizeKB")
        .and_then(Value::as_f64)
        .map(|kb| (kb * 1024.0).round() as u64);
    let sha = file
        .pointer("/hashes/SHA256")
        .and_then(Value::as_str)
        .map(str::to_lowercase);
    let base_model = v
        .get("baseModel")
        .and_then(Value::as_str)
        .map(str::to_string);
    let suggested = base_model
        .as_deref()
        .and_then(|b| registry.model_for_civitai_base(b));
    let name = v
        .pointer("/model/name")
        .and_then(Value::as_str)
        .or_else(|| v.get("name").and_then(Value::as_str))
        .unwrap_or("Civitai LoRA")
        .to_string();
    let trigger_words = v
        .get("trainedWords")
        .and_then(Value::as_array)
        .map(|a| {
            a.iter()
                .filter_map(Value::as_str)
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty())
                .collect()
        })
        .unwrap_or_default();
    let preview_url = v
        .get("images")
        .and_then(Value::as_array)
        .and_then(|imgs| {
            imgs.iter()
                .find(|i| i.get("type").and_then(Value::as_str).unwrap_or("image") == "image")
        })
        .and_then(|i| i.get("url"))
        .and_then(Value::as_str)
        .map(str::to_string);
    Ok(ResolvedLora {
        source: "civitai".into(),
        name,
        download_url: format!("{CIVITAI_ROOT}/api/download/models/{id}"),
        filename,
        size_bytes: size,
        sha256: sha,
        base_model,
        suggested_model_id: suggested,
        trigger_words,
        preview_url,
        size_exact: false,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use wiremock::matchers::{body_json, header, method, path};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    const MODEL: &str = include_str!("../tests/fixtures/civitai_model_1662740.json");
    const V_QWEN: &str = include_str!("../tests/fixtures/civitai_version_3349565.json");
    const V_CHROMA: &str = include_str!("../tests/fixtures/civitai_version_2299345.json");
    const HF: &str = include_str!("../tests/fixtures/hf_paths_info.json");

    #[test]
    fn parses_links() {
        assert_eq!(
            parse_link(
                "https://civitai.com/models/1662740/lenovo-ultrareal?modelVersionId=2299345"
            )
            .unwrap(),
            Link::CivitaiVersion(2299345)
        );
        assert_eq!(
            parse_link("https://civitai.com/models/1662740").unwrap(),
            Link::CivitaiModel(1662740)
        );
        assert_eq!(
            parse_link("https://civitai.com/api/download/models/2299345?type=Model").unwrap(),
            Link::CivitaiVersion(2299345)
        );
        assert_eq!(
            parse_link("https://huggingface.co/a/b/blob/main/sub/x.safetensors?download=true")
                .unwrap(),
            Link::HuggingFace {
                repo: "a/b".into(),
                revision: "main".into(),
                path: "sub/x.safetensors".into()
            }
        );
        assert!(parse_link("https://huggingface.co/a/b").is_err());
        assert!(parse_link("https://huggingface.co/a/b/resolve/main/x.ckpt").is_err());
        assert!(parse_link("https://example.com/x.safetensors").is_err());
        assert!(parse_link("not a url").is_err());
        assert!(parse_link("https://civitai.com/user/foo").is_err());
    }

    #[test]
    fn sanitizes() {
        assert_eq!(
            sanitize_filename("a b(1).safetensors").unwrap(),
            "a_b_1_.safetensors"
        );
        assert_eq!(
            sanitize_filename("../../x.safetensors").unwrap(),
            "x.safetensors"
        );
        assert!(sanitize_filename("x.ckpt").is_err());
        assert!(sanitize_filename(".safetensors").is_err());
    }

    #[tokio::test]
    async fn civitai_version_link() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/api/v1/model-versions/2299345"))
            .and(header("authorization", "Bearer civ-key"))
            .respond_with(ResponseTemplate::new(200).set_body_raw(V_CHROMA, "application/json"))
            .mount(&server)
            .await;
        let r = LinkResolver::new(&server.uri(), &server.uri(), Some("civ-key".into()))
            .resolve(
                "https://civitai.com/models/1662740/lenovo?modelVersionId=2299345",
                &Registry::embedded(),
            )
            .await
            .unwrap();
        assert_eq!(r.source, "civitai");
        assert_eq!(r.name, "Lenovo UltraReal");
        assert_eq!(r.filename, "lenovo_chroma.safetensors");
        assert_eq!(
            r.download_url,
            "https://civitai.com/api/download/models/2299345"
        );
        assert_eq!(r.base_model.as_deref(), Some("Chroma"));
        assert_eq!(r.suggested_model_id.as_deref(), Some("chroma"));
        assert_eq!(r.trigger_words, vec!["l3n0v0"]);
        assert!(r
            .sha256
            .as_deref()
            .unwrap()
            .chars()
            .all(|c| !c.is_ascii_uppercase()));
        assert!(r.size_bytes.unwrap() > 0);
        assert!(r.preview_url.is_some());
        assert!(!r.size_exact);
    }

    #[tokio::test]
    async fn civitai_model_link_uses_latest_version() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/api/v1/models/1662740"))
            .respond_with(ResponseTemplate::new(200).set_body_raw(MODEL, "application/json"))
            .mount(&server)
            .await;
        Mock::given(method("GET"))
            .and(path("/api/v1/model-versions/3349565"))
            .respond_with(ResponseTemplate::new(200).set_body_raw(V_QWEN, "application/json"))
            .mount(&server)
            .await;
        let r = LinkResolver::new(&server.uri(), &server.uri(), None)
            .resolve(
                "https://civitai.com/models/1662740/lenovo",
                &Registry::embedded(),
            )
            .await
            .unwrap();
        assert_eq!(r.filename, "lenovo_qwen21.safetensors");
        assert_eq!(r.base_model.as_deref(), Some("Qwen 2.1"));
        assert_eq!(
            r.download_url,
            "https://civitai.com/api/download/models/3349565"
        );
        assert!(r.trigger_words.is_empty());
    }

    #[tokio::test]
    async fn civitai_not_found() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .respond_with(ResponseTemplate::new(404))
            .mount(&server)
            .await;
        let err = LinkResolver::new(&server.uri(), &server.uri(), None)
            .resolve(
                "https://civitai.com/models/1?modelVersionId=2",
                &Registry::embedded(),
            )
            .await
            .unwrap_err();
        assert!(err.contains("not found"));
    }

    #[tokio::test]
    async fn huggingface_blob_link() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/api/models/Comfy-Org/z_image_turbo/paths-info/main"))
            .and(body_json(
                json!({"paths": ["split_files/vae/ae.safetensors"]}),
            ))
            .respond_with(ResponseTemplate::new(200).set_body_raw(HF, "application/json"))
            .mount(&server)
            .await;
        let r = LinkResolver::new(&server.uri(), &server.uri(), None)
            .resolve(
                "https://huggingface.co/Comfy-Org/z_image_turbo/blob/main/split_files/vae/ae.safetensors",
                &Registry::embedded(),
            )
            .await
            .unwrap();
        assert_eq!(r.source, "huggingface");
        assert_eq!(r.filename, "ae.safetensors");
        assert_eq!(r.name, "ae");
        assert_eq!(
            r.download_url,
            "https://huggingface.co/Comfy-Org/z_image_turbo/resolve/main/split_files/vae/ae.safetensors"
        );
        assert_eq!(r.size_bytes, Some(335304388));
        assert_eq!(
            r.sha256.as_deref(),
            Some("afc8e28272cd15db3919bacdb6918ce9c1ed22e96cb12c4d5ed0fba823529e38")
        );
        assert!(r.size_exact);
        let js = serde_json::to_value(&r).unwrap();
        assert!(js.get("baseModel").is_none());
        assert_eq!(js["triggerWords"], json!([]));
    }
}
