//! Worker client for the RunPod-serverless job API: /run, /status, /cancel,
//! /health. Used both for the serverless endpoint and for the dedicated GPU
//! pod, whose server is API-compatible (only the base URL and token differ).

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::time::Duration;

pub const DEFAULT_API_ROOT: &str = "https://api.runpod.ai";
pub const GENERATE_TIMEOUT_MS: u64 = 600_000;
pub const DOWNLOAD_TIMEOUT_MS: u64 = 3_600_000;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RunStatus {
    InQueue,
    InProgress,
    Completed,
    Failed,
    Cancelled,
    TimedOut,
    Unknown,
}

impl RunStatus {
    pub fn parse(s: &str) -> RunStatus {
        match s {
            "IN_QUEUE" => RunStatus::InQueue,
            "IN_PROGRESS" => RunStatus::InProgress,
            "COMPLETED" => RunStatus::Completed,
            "FAILED" => RunStatus::Failed,
            "CANCELLED" => RunStatus::Cancelled,
            "TIMED_OUT" => RunStatus::TimedOut,
            _ => RunStatus::Unknown,
        }
    }
    pub fn is_terminal(self) -> bool {
        matches!(
            self,
            RunStatus::Completed | RunStatus::Failed | RunStatus::Cancelled | RunStatus::TimedOut
        )
    }
}

#[derive(Debug, Clone)]
pub struct JobStatus {
    pub id: String,
    pub status: RunStatus,
    pub raw_status: String,
    pub output: Option<Value>,
    pub error: Option<String>,
    pub delay_time_ms: Option<u64>,
    pub execution_time_ms: Option<u64>,
}

/// Progress reported by the worker via `runpod.serverless.progress_update`.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Progress {
    #[serde(default)]
    pub phase: Option<String>,
    #[serde(default)]
    pub step: Option<u64>,
    #[serde(default)]
    pub total_steps: Option<u64>,
    #[serde(default)]
    pub file: Option<String>,
    #[serde(default)]
    pub bytes: Option<u64>,
    #[serde(default)]
    pub total_bytes: Option<u64>,
}

/// runpod-python's `progress_update` posts `{"status":"IN_PROGRESS","output":<progress>}`,
/// so while IN_PROGRESS the progress object appears as `/status` `output`.
/// Handled defensively: an object, a JSON-encoded string, or nested under
/// `progress`. Plain strings or other shapes give `None`.
pub fn parse_progress(output: &Value) -> Option<Progress> {
    match output {
        Value::String(s) => serde_json::from_str::<Value>(s)
            .ok()
            .filter(|v| v.is_object())
            .and_then(|v| parse_progress(&v)),
        Value::Object(map) => {
            if map.contains_key("phase") || map.contains_key("step") || map.contains_key("bytes") {
                serde_json::from_value(output.clone()).ok()
            } else if let Some(inner) = map.get("progress") {
                parse_progress(inner)
            } else {
                None
            }
        }
        Value::Array(items) => items.iter().rev().find_map(parse_progress),
        _ => None,
    }
}

#[derive(Debug, Clone, Default, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Health {
    pub ok: bool,
    pub workers: WorkerCounts,
    pub jobs: JobCounts,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    /// Additive (v3): what was checked — "pod", "api" or "serverless".
    #[serde(skip_serializing_if = "Option::is_none")]
    pub target: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
    /// Pod only: ComfyUI ready flag and GPU name from the pod's /health.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ready: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub gpu: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct WorkerCounts {
    pub idle: u64,
    pub running: u64,
}

#[derive(Debug, Clone, Default, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct JobCounts {
    pub in_queue: u64,
    pub in_progress: u64,
}

#[derive(Clone)]
pub struct RunpodClient {
    http: reqwest::Client,
    base: String,
    api_key: String,
    /// True when talking to the dedicated GPU pod (affects error wording).
    pod: bool,
}

fn num(v: &Value, k: &str) -> u64 {
    v.get(k).and_then(Value::as_u64).unwrap_or(0)
}

fn error_text(v: &Value) -> String {
    match v {
        Value::String(s) => {
            // Errors are often JSON strings like {"error_type":..,"error_message":..}.
            if let Ok(inner) = serde_json::from_str::<Value>(s) {
                if inner.is_object() {
                    return error_text(&inner);
                }
            }
            s.clone()
        }
        Value::Object(m) => {
            for k in ["error_message", "message", "error"] {
                if let Some(x) = m.get(k) {
                    return error_text(x);
                }
            }
            v.to_string()
        }
        other => other.to_string(),
    }
}

impl RunpodClient {
    /// `api_root` is `https://api.runpod.ai` in production (overridable in tests).
    pub fn new(api_root: &str, endpoint_id: &str, api_key: &str) -> RunpodClient {
        let http = reqwest::Client::builder()
            .timeout(Duration::from_secs(60))
            .build()
            .expect("http client");
        RunpodClient {
            http,
            base: format!("{}/v2/{}", api_root.trim_end_matches('/'), endpoint_id),
            api_key: api_key.to_string(),
            pod: false,
        }
    }

    /// Client for the dedicated GPU pod's server at `base`
    /// (`https://<podId>-8000.proxy.runpod.net`), authenticated with the pod token.
    pub fn for_pod(base: &str, token: &str) -> RunpodClient {
        let http = reqwest::Client::builder()
            .timeout(Duration::from_secs(60))
            .build()
            .expect("http client");
        RunpodClient {
            http,
            base: base.trim_end_matches('/').to_string(),
            api_key: token.to_string(),
            pod: true,
        }
    }

    pub fn base_url(&self) -> &str {
        &self.base
    }

    pub fn is_pod(&self) -> bool {
        self.pod
    }

    async fn send(&self, req: reqwest::RequestBuilder) -> Result<Value, String> {
        let resp = req
            .bearer_auth(&self.api_key)
            .send()
            .await
            .map_err(|e| {
                if self.pod {
                    format!("Could not reach the GPU pod: {}", e.without_url())
                } else {
                    format!("Could not reach RunPod: {}", e.without_url())
                }
            })?;
        let status = resp.status();
        let body = resp.text().await.unwrap_or_default();
        if self.pod {
            if status.as_u16() == 401 || status.as_u16() == 403 {
                return Err("The GPU pod rejected the app's token (unauthorized). Stop and start the GPU again.".into());
            }
            if status.as_u16() == 404 {
                return Err("GPU pod: job not found (expired?)".into());
            }
            if !status.is_success() {
                let detail = serde_json::from_str::<Value>(&body)
                    .map(|v| error_text(&v))
                    .unwrap_or_else(|_| body.chars().take(300).collect());
                return Err(format!("GPU pod error {}: {}", status.as_u16(), detail));
            }
            return serde_json::from_str(&body)
                .map_err(|_| "The GPU pod returned an unreadable response".into());
        }
        if status.as_u16() == 401 || status.as_u16() == 403 {
            return Err("RunPod rejected the API key (unauthorized). Check Settings.".into());
        }
        if status.as_u16() == 404 {
            return Err("RunPod endpoint not found. Check the endpoint ID in Settings.".into());
        }
        if !status.is_success() {
            let detail = serde_json::from_str::<Value>(&body)
                .map(|v| error_text(&v))
                .unwrap_or_else(|_| body.chars().take(300).collect());
            return Err(format!("RunPod error {}: {}", status.as_u16(), detail));
        }
        serde_json::from_str(&body).map_err(|_| "RunPod returned an unreadable response".into())
    }

    /// POST /run. Returns the RunPod job id.
    pub async fn run(&self, input: Value, execution_timeout_ms: u64) -> Result<String, String> {
        let body =
            json!({ "input": input, "policy": { "executionTimeout": execution_timeout_ms } });
        let v = self
            .send(self.http.post(format!("{}/run", self.base)).json(&body))
            .await?;
        v.get("id")
            .and_then(Value::as_str)
            .map(str::to_string)
            .ok_or_else(|| "RunPod did not return a job id".into())
    }

    pub async fn status(&self, id: &str) -> Result<JobStatus, String> {
        let v = self
            .send(self.http.get(format!("{}/status/{}", self.base, id)))
            .await?;
        let raw = v
            .get("status")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string();
        Ok(JobStatus {
            id: id.to_string(),
            status: RunStatus::parse(&raw),
            raw_status: raw,
            output: v.get("output").cloned().filter(|o| !o.is_null()),
            error: v.get("error").filter(|e| !e.is_null()).map(error_text),
            delay_time_ms: v.get("delayTime").and_then(Value::as_u64),
            execution_time_ms: v.get("executionTime").and_then(Value::as_u64),
        })
    }

    pub async fn cancel(&self, id: &str) -> Result<(), String> {
        self.send(self.http.post(format!("{}/cancel/{}", self.base, id)))
            .await
            .map(|_| ())
    }

    pub async fn health(&self) -> Result<Health, String> {
        let v = self
            .send(self.http.get(format!("{}/health", self.base)))
            .await?;
        let w = v.get("workers").cloned().unwrap_or(Value::Null);
        let j = v.get("jobs").cloned().unwrap_or(Value::Null);
        Ok(Health {
            ok: true,
            workers: WorkerCounts {
                idle: num(&w, "idle"),
                running: num(&w, "running"),
            },
            jobs: JobCounts {
                in_queue: num(&j, "inQueue"),
                in_progress: num(&j, "inProgress"),
            },
            error: None,
            target: Some(if self.pod { "pod" } else { "serverless" }.into()),
            message: None,
            ready: v.get("ready").and_then(Value::as_bool),
            gpu: v.get("gpu").and_then(Value::as_str).map(str::to_string),
        })
    }
}

/// Error text from a terminal non-success status, made user-readable.
pub fn failure_message(s: &JobStatus) -> String {
    let base = s
        .error
        .clone()
        .or_else(|| {
            s.output
                .as_ref()
                .and_then(|o| o.get("error"))
                .map(error_text)
        })
        .unwrap_or_else(|| match s.status {
            RunStatus::TimedOut => "The job timed out on RunPod".into(),
            RunStatus::Cancelled => "The job was cancelled on RunPod".into(),
            _ => format!("The job failed on RunPod ({})", s.raw_status),
        });
    if let Some(rest) = base.split("MODEL_NOT_INSTALLED:").nth(1) {
        return format!(
            "Model files are not installed on the volume:{} — download the model on the Models tab.",
            rest.trim_end()
        );
    }
    base
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn progress_shapes() {
        let p = parse_progress(&json!({"phase":"sampling","step":3,"totalSteps":8})).unwrap();
        assert_eq!(p.phase.as_deref(), Some("sampling"));
        assert_eq!(p.step, Some(3));
        assert_eq!(p.total_steps, Some(8));
        let p = parse_progress(&json!(
            "{\"phase\":\"downloading\",\"file\":\"a\",\"bytes\":5,\"totalBytes\":10}"
        ))
        .unwrap();
        assert_eq!(p.bytes, Some(5));
        assert_eq!(p.total_bytes, Some(10));
        assert!(parse_progress(&json!({"progress": {"phase":"loading"}})).is_some());
        assert!(parse_progress(&json!("Update 1/3")).is_none());
        assert!(parse_progress(&json!(42)).is_none());
    }

    #[test]
    fn failure_messages() {
        let s = JobStatus {
            id: "x".into(),
            status: RunStatus::Failed,
            raw_status: "FAILED".into(),
            output: None,
            error: Some(error_text(&json!("{\"error_type\":\"RuntimeError\",\"error_message\":\"MODEL_NOT_INSTALLED: unet/a.safetensors\"}"))),
            delay_time_ms: None,
            execution_time_ms: None,
        };
        let m = failure_message(&s);
        assert!(m.contains("unet/a.safetensors"), "{m}");
        assert!(m.contains("Models tab"));
    }
}
