//! Settings: secrets in the Keychain (behind a trait), endpointId in a JSON
//! config file, and a debug-only fallback to the repo `.env`.
//!
//! Secret values are never logged or returned to the UI.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

pub const KEYCHAIN_SERVICE: &str = "ImageStudio";
pub const ACCOUNT_RUNPOD: &str = "runpod_api_key";
pub const ACCOUNT_CIVITAI: &str = "civitai_api_key";
/// Random 32-byte hex token the app generates once and passes to the pod as
/// `API_TOKEN`; the pod server requires it as a Bearer token.
pub const ACCOUNT_POD_TOKEN: &str = "pod_api_token";

pub const DEFAULT_IDLE_MINUTES: u32 = 30;
/// Network volumes in priority order; the first that exists wins and the pod
/// is placed in its data center.
pub const DEFAULT_VOLUME_NAMES: &[&str] = &["image-studio-models"];
/// GPU types in priority order; tried one by one on capacity errors.
pub const DEFAULT_GPU_TYPES: &[&str] = &[
    "NVIDIA RTX PRO 6000 Blackwell Server Edition",
    "NVIDIA RTX PRO 4500 Blackwell",
    "NVIDIA GeForce RTX 4090",
    "NVIDIA RTX PRO 4000 Blackwell",
];
/// Video profile (spec v5): its volume in CA-MTL-3 (Canada), and GPUs with
/// at least 80 GB, in priority order.
pub const DEFAULT_VIDEO_VOLUME_NAMES: &[&str] = &["image-studio-video"];
pub const DEFAULT_VIDEO_GPU_TYPES: &[&str] = &[
    "NVIDIA RTX PRO 6000 Blackwell Server Edition",
    "NVIDIA H200",
    "NVIDIA H100 80GB HBM3",
];
/// Git ref the pod's boot script fetches worker code from (`WORKER_REF`): a
/// branch, tag or commit SHA of the image-studio repo (spec "v4").
pub const DEFAULT_WORKER_REF: &str = "main";
pub const MIN_IDLE_MINUTES: u32 = 5;
/// Vault auto-lock after this many minutes without interaction (spec v6).
pub const DEFAULT_VAULT_AUTO_LOCK_MINUTES: u32 = crate::vault::DEFAULT_AUTO_LOCK_MINUTES;
pub const MAX_IDLE_MINUTES: u32 = 240;

pub const ENV_RUNPOD_KEY: &str = "RUNPOD_API_KEY";
pub const ENV_RUNPOD_ENDPOINT: &str = "RUNPOD_ENDPOINT_ID";
pub const ENV_CIVITAI_KEY: &str = "CIVITAI_API_KEY";

/// Secret storage abstraction so tests never touch the real Keychain.
pub trait SecretStore: Send + Sync {
    fn get(&self, account: &str) -> Result<Option<String>, String>;
    /// `None` deletes the secret.
    fn set(&self, account: &str, value: Option<&str>) -> Result<(), String>;
}

/// macOS Keychain via the `keyring` crate.
pub struct KeychainStore;

impl SecretStore for KeychainStore {
    fn get(&self, account: &str) -> Result<Option<String>, String> {
        let entry = keyring::Entry::new(KEYCHAIN_SERVICE, account)
            .map_err(|e| format!("Keychain unavailable: {e}"))?;
        match entry.get_password() {
            Ok(v) => Ok(Some(v)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(e) => Err(format!("Could not read from the Keychain: {e}")),
        }
    }

    fn set(&self, account: &str, value: Option<&str>) -> Result<(), String> {
        let entry = keyring::Entry::new(KEYCHAIN_SERVICE, account)
            .map_err(|e| format!("Keychain unavailable: {e}"))?;
        match value {
            Some(v) => entry
                .set_password(v)
                .map_err(|e| format!("Could not save to the Keychain: {e}")),
            None => match entry.delete_credential() {
                Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
                Err(e) => Err(format!("Could not remove from the Keychain: {e}")),
            },
        }
    }
}

/// Caches reads in memory so each Keychain item is read at most once per app
/// launch (every read of an item whose access list doesn't include this build
/// shows a macOS password prompt). Writes go through and update the cache.
pub struct CachedStore<S: SecretStore> {
    inner: S,
    cache: Mutex<HashMap<String, Option<String>>>,
}

impl<S: SecretStore> CachedStore<S> {
    pub fn new(inner: S) -> CachedStore<S> {
        CachedStore {
            inner,
            cache: Mutex::new(HashMap::new()),
        }
    }
}

impl<S: SecretStore> SecretStore for CachedStore<S> {
    fn get(&self, account: &str) -> Result<Option<String>, String> {
        if let Some(v) = self.cache.lock().unwrap().get(account) {
            return Ok(v.clone());
        }
        // Errors (e.g. the user pressed Deny) are not cached, so a later
        // action can ask again.
        let v = self.inner.get(account)?;
        self.cache
            .lock()
            .unwrap()
            .insert(account.to_string(), v.clone());
        Ok(v)
    }

    fn set(&self, account: &str, value: Option<&str>) -> Result<(), String> {
        self.inner.set(account, value)?;
        self.cache
            .lock()
            .unwrap()
            .insert(account.to_string(), value.map(str::to_string));
        Ok(())
    }
}

/// In-memory store for tests.
#[derive(Default)]
pub struct MemoryStore(Mutex<HashMap<String, String>>);

impl SecretStore for MemoryStore {
    fn get(&self, account: &str) -> Result<Option<String>, String> {
        Ok(self.0.lock().unwrap().get(account).cloned())
    }
    fn set(&self, account: &str, value: Option<&str>) -> Result<(), String> {
        let mut m = self.0.lock().unwrap();
        match value {
            Some(v) => m.insert(account.to_string(), v.to_string()),
            None => m.remove(account),
        };
        Ok(())
    }
}

/// Parse a dotenv file body. Supports comments, `export`, and quoted values.
pub fn parse_dotenv(body: &str) -> HashMap<String, String> {
    let mut out = HashMap::new();
    for line in body.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let line = line.strip_prefix("export ").unwrap_or(line);
        let Some((k, v)) = line.split_once('=') else {
            continue;
        };
        let k = k.trim();
        let mut v = v.trim();
        if v.len() >= 2
            && ((v.starts_with('"') && v.ends_with('"'))
                || (v.starts_with('\'') && v.ends_with('\'')))
        {
            v = &v[1..v.len() - 1];
        } else if let Some(i) = v.find(" #") {
            v = v[..i].trim();
        }
        out.insert(k.to_string(), v.to_string());
    }
    out
}

/// Repo-root `.env`, located at build time via CARGO_MANIFEST_DIR/../../.env.
pub fn repo_dotenv_path() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../.env")
}

/// Debug builds read the repo `.env`; release builds never do.
pub fn load_env_fallback() -> HashMap<String, String> {
    if cfg!(debug_assertions) {
        std::fs::read_to_string(repo_dotenv_path())
            .map(|b| parse_dotenv(&b))
            .unwrap_or_default()
    } else {
        HashMap::new()
    }
}

/// Primary value wins when non-empty, else the fallback when non-empty.
pub fn resolve(primary: Option<String>, fallback: Option<&String>) -> Option<String> {
    primary
        .filter(|s| !s.trim().is_empty())
        .or_else(|| fallback.filter(|s| !s.trim().is_empty()).cloned())
        .map(|s| s.trim().to_string())
}

/// Where worker jobs run: the dedicated GPU pod (default since v3) or the
/// legacy serverless endpoint.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "lowercase")]
pub enum Backend {
    #[default]
    Pod,
    Serverless,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppConfig {
    #[serde(default)]
    pub endpoint_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub backend: Option<Backend>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub idle_minutes: Option<u32>,
    /// Pass the user's RunPod API key to the pod as `RUNPOD_API_KEY` so its
    /// idle watchdog can terminate it (default true).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pass_api_key_to_pod: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub volume_names: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub gpu_types: Option<Vec<String>>,
    /// Video profile volume names / GPU list (config file only; spec v5).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub video_volume_names: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub video_gpu_types: Option<Vec<String>>,
    /// `WORKER_REF` for the pod (default "main"). Pin a commit SHA for
    /// stability. Edited in the config file only.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub worker_ref: Option<String>,
    /// Container image override (default `pod::POD_IMAGE`, the runtime image).
    /// Set to `pod::LEGACY_POD_IMAGE` to go back to the all-in-one image
    /// without an app rebuild. Edited in the config file only.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pod_image: Option<String>,
    /// Vault auto-lock minutes (spec v6; default 10).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub vault_auto_lock_minutes: Option<u32>,
}

/// Trimmed value, or `default` when unset or blank.
fn str_or(v: Option<&String>, default: &str) -> String {
    v.map(|s| s.trim())
        .filter(|s| !s.is_empty())
        .unwrap_or(default)
        .to_string()
}

fn list_or(v: Option<&Vec<String>>, default: &[&str]) -> Vec<String> {
    let l: Vec<String> = v
        .map(|x| {
            x.iter()
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty())
                .collect()
        })
        .unwrap_or_default();
    if l.is_empty() {
        default.iter().map(|s| s.to_string()).collect()
    } else {
        l
    }
}

/// Pod-related settings (v3); additive to `SettingsView` in `get_settings`.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SavePodSettings {
    pub backend: Option<Backend>,
    pub idle_minutes: Option<u32>,
    pub pass_api_key_to_pod: Option<bool>,
    pub volume_names: Option<Vec<String>>,
    pub gpu_types: Option<Vec<String>>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SettingsView {
    pub has_api_key: bool,
    pub endpoint_id: Option<String>,
    pub has_civitai_key: bool,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveSettings {
    pub api_key: Option<String>,
    pub endpoint_id: Option<String>,
    pub civitai_key: Option<String>,
}

pub struct Settings {
    secrets: Arc<dyn SecretStore>,
    env: HashMap<String, String>,
    config_path: PathBuf,
    config: Mutex<AppConfig>,
}

impl Settings {
    pub fn new(
        secrets: Arc<dyn SecretStore>,
        env: HashMap<String, String>,
        config_path: PathBuf,
    ) -> Settings {
        let config = std::fs::read_to_string(&config_path)
            .ok()
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or_default();
        Settings {
            secrets,
            env,
            config_path,
            config: Mutex::new(config),
        }
    }

    pub fn runpod_api_key(&self) -> Option<String> {
        resolve(
            self.secrets.get(ACCOUNT_RUNPOD).ok().flatten(),
            self.env.get(ENV_RUNPOD_KEY),
        )
    }

    pub fn civitai_api_key(&self) -> Option<String> {
        resolve(
            self.secrets.get(ACCOUNT_CIVITAI).ok().flatten(),
            self.env.get(ENV_CIVITAI_KEY),
        )
    }

    pub fn endpoint_id(&self) -> Option<String> {
        resolve(
            self.config.lock().unwrap().endpoint_id.clone(),
            self.env.get(ENV_RUNPOD_ENDPOINT),
        )
    }

    pub fn backend(&self) -> Backend {
        self.config.lock().unwrap().backend.unwrap_or_default()
    }

    pub fn idle_minutes(&self) -> u32 {
        self.config
            .lock()
            .unwrap()
            .idle_minutes
            .unwrap_or(DEFAULT_IDLE_MINUTES)
            .clamp(MIN_IDLE_MINUTES, MAX_IDLE_MINUTES)
    }

    pub fn pass_api_key_to_pod(&self) -> bool {
        self.config.lock().unwrap().pass_api_key_to_pod.unwrap_or(true)
    }

    pub fn volume_names(&self) -> Vec<String> {
        list_or(self.config.lock().unwrap().volume_names.as_ref(), DEFAULT_VOLUME_NAMES)
    }

    pub fn gpu_types(&self) -> Vec<String> {
        list_or(self.config.lock().unwrap().gpu_types.as_ref(), DEFAULT_GPU_TYPES)
    }

    /// Volume names for a GPU profile (image: `volumeNames`, video: `videoVolumeNames`).
    pub fn volume_names_for(&self, p: crate::pod::Profile) -> Vec<String> {
        match p {
            crate::pod::Profile::Image => self.volume_names(),
            crate::pod::Profile::Video => list_or(
                self.config.lock().unwrap().video_volume_names.as_ref(),
                DEFAULT_VIDEO_VOLUME_NAMES,
            ),
        }
    }

    /// GPU priority list for a profile (image: `gpuTypes`, video: `videoGpuTypes`).
    pub fn gpu_types_for(&self, p: crate::pod::Profile) -> Vec<String> {
        match p {
            crate::pod::Profile::Image => self.gpu_types(),
            crate::pod::Profile::Video => list_or(
                self.config.lock().unwrap().video_gpu_types.as_ref(),
                DEFAULT_VIDEO_GPU_TYPES,
            ),
        }
    }

    /// `WORKER_REF` passed to the pod (config `workerRef`, default "main").
    pub fn worker_ref(&self) -> String {
        str_or(self.config.lock().unwrap().worker_ref.as_ref(), DEFAULT_WORKER_REF)
    }

    /// Pod container image (config `podImage`, default the runtime image).
    pub fn pod_image(&self) -> String {
        str_or(self.config.lock().unwrap().pod_image.as_ref(), crate::pod::POD_IMAGE)
    }

    /// Minutes without interaction before the vault locks itself (1–240, default 10).
    pub fn vault_auto_lock_minutes(&self) -> u32 {
        self.config
            .lock()
            .unwrap()
            .vault_auto_lock_minutes
            .unwrap_or(DEFAULT_VAULT_AUTO_LOCK_MINUTES)
            .clamp(
                crate::vault::MIN_AUTO_LOCK_MINUTES,
                crate::vault::MAX_AUTO_LOCK_MINUTES,
            )
    }

    pub fn save_vault_auto_lock(&self, minutes: u32) -> Result<(), String> {
        if !(crate::vault::MIN_AUTO_LOCK_MINUTES..=crate::vault::MAX_AUTO_LOCK_MINUTES).contains(&minutes) {
            return Err(format!(
                "Auto-lock must be between {} and {} minutes",
                crate::vault::MIN_AUTO_LOCK_MINUTES,
                crate::vault::MAX_AUTO_LOCK_MINUTES
            ));
        }
        let mut cfg = self.config.lock().unwrap();
        cfg.vault_auto_lock_minutes = Some(minutes);
        self.write_config(&cfg)
    }

    /// The pod token, generated (32 random bytes, hex) and stored on first use.
    /// Path of the pod token file (next to the settings file, mode 0600).
    fn pod_token_path(&self) -> PathBuf {
        self.config_path
            .parent()
            .map(|d| d.join("pod_token"))
            .unwrap_or_else(|| PathBuf::from("pod_token"))
    }

    /// The pod's `API_TOKEN`. It is generated by the app (not a user secret),
    /// so it lives in a private file instead of the Keychain: Keychain reads
    /// from unsigned dev builds trigger a password prompt on every rebuild.
    /// A token from older builds is migrated from the Keychain once, so a pod
    /// started earlier keeps working.
    pub fn pod_token(&self) -> Result<String, String> {
        let path = self.pod_token_path();
        if let Ok(t) = std::fs::read_to_string(&path) {
            let t = t.trim().to_string();
            if !t.is_empty() {
                return Ok(t);
            }
        }
        let token = match self
            .secrets
            .get(ACCOUNT_POD_TOKEN)
            .ok()
            .flatten()
            .filter(|t| !t.trim().is_empty())
        {
            Some(t) => t.trim().to_string(),
            None => {
                let bytes: [u8; 32] = rand::random();
                bytes.iter().map(|b| format!("{b:02x}")).collect()
            }
        };
        write_private_file(&path, &token)?;
        Ok(token)
    }

    fn write_config(&self, cfg: &AppConfig) -> Result<(), String> {
        if let Some(dir) = self.config_path.parent() {
            std::fs::create_dir_all(dir).map_err(|e| format!("Could not save settings: {e}"))?;
        }
        let body = serde_json::to_string_pretty(cfg).map_err(|e| e.to_string())?;
        std::fs::write(&self.config_path, body)
            .map_err(|e| format!("Could not save settings: {e}"))
    }

    /// Missing fields are left unchanged.
    pub fn save_pod(&self, s: SavePodSettings) -> Result<(), String> {
        if let Some(m) = s.idle_minutes {
            if !(MIN_IDLE_MINUTES..=MAX_IDLE_MINUTES).contains(&m) {
                return Err(format!(
                    "Auto-stop must be between {MIN_IDLE_MINUTES} and {MAX_IDLE_MINUTES} minutes"
                ));
            }
        }
        if s.backend.is_none()
            && s.idle_minutes.is_none()
            && s.pass_api_key_to_pod.is_none()
            && s.volume_names.is_none()
            && s.gpu_types.is_none()
        {
            return Ok(());
        }
        let mut cfg = self.config.lock().unwrap();
        if let Some(b) = s.backend {
            cfg.backend = Some(b);
        }
        if let Some(m) = s.idle_minutes {
            cfg.idle_minutes = Some(m);
        }
        if let Some(p) = s.pass_api_key_to_pod {
            cfg.pass_api_key_to_pod = Some(p);
        }
        if let Some(v) = s.volume_names {
            cfg.volume_names = Some(v);
        }
        if let Some(g) = s.gpu_types {
            cfg.gpu_types = Some(g);
        }
        self.write_config(&cfg)
    }

    pub fn view(&self) -> SettingsView {
        SettingsView {
            has_api_key: self.runpod_api_key().is_some(),
            endpoint_id: self.endpoint_id(),
            has_civitai_key: self.civitai_api_key().is_some(),
        }
    }

    /// Missing fields are left unchanged; an empty string clears the value.
    pub fn save(&self, s: SaveSettings) -> Result<SettingsView, String> {
        let norm = |v: &str| {
            let t = v.trim();
            if t.is_empty() {
                None
            } else {
                Some(t.to_string())
            }
        };
        if let Some(k) = s.api_key.as_deref() {
            self.secrets.set(ACCOUNT_RUNPOD, norm(k).as_deref())?;
        }
        if let Some(k) = s.civitai_key.as_deref() {
            self.secrets.set(ACCOUNT_CIVITAI, norm(k).as_deref())?;
        }
        if let Some(e) = s.endpoint_id.as_deref() {
            let e = norm(e);
            if let Some(id) = &e {
                if !id
                    .chars()
                    .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
                {
                    return Err("Endpoint ID may only contain letters, digits, - and _".into());
                }
            }
            let mut cfg = self.config.lock().unwrap();
            cfg.endpoint_id = e;
            self.write_config(&cfg)?;
        }
        Ok(self.view())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn env(pairs: &[(&str, &str)]) -> HashMap<String, String> {
        pairs
            .iter()
            .map(|(k, v)| (k.to_string(), v.to_string()))
            .collect()
    }

    #[test]
    fn dotenv_parsing() {
        let m = parse_dotenv(
            "# c\nexport A=1\nB = \"two words\"\nC='x'\nD=val # trailing\n\nbad line\nE=",
        );
        assert_eq!(m["A"], "1");
        assert_eq!(m["B"], "two words");
        assert_eq!(m["C"], "x");
        assert_eq!(m["D"], "val");
        assert_eq!(m["E"], "");
        assert!(!m.contains_key("bad line"));
    }

    #[test]
    fn keychain_wins_then_env_fallback() {
        let dir = tempfile::tempdir().unwrap();
        let store = Arc::new(MemoryStore::default());
        let s = Settings::new(
            store.clone(),
            env(&[(ENV_RUNPOD_KEY, "env-key"), (ENV_RUNPOD_ENDPOINT, "env-ep")]),
            dir.path().join("config.json"),
        );
        // Empty keychain -> env.
        assert_eq!(s.runpod_api_key().as_deref(), Some("env-key"));
        assert_eq!(s.endpoint_id().as_deref(), Some("env-ep"));
        assert!(s.civitai_api_key().is_none());
        // Keychain set -> keychain.
        let v = s
            .save(SaveSettings {
                api_key: Some("kc-key".into()),
                endpoint_id: Some("cfg-ep".into()),
                civitai_key: Some("civ".into()),
            })
            .unwrap();
        assert_eq!(
            v,
            SettingsView {
                has_api_key: true,
                endpoint_id: Some("cfg-ep".into()),
                has_civitai_key: true
            }
        );
        assert_eq!(s.runpod_api_key().as_deref(), Some("kc-key"));
        // Config file persisted.
        let reloaded = Settings::new(
            store.clone(),
            HashMap::new(),
            dir.path().join("config.json"),
        );
        assert_eq!(reloaded.endpoint_id().as_deref(), Some("cfg-ep"));
        // Clearing falls back to env again; untouched fields stay.
        s.save(SaveSettings {
            api_key: Some("  ".into()),
            ..Default::default()
        })
        .unwrap();
        assert_eq!(s.runpod_api_key().as_deref(), Some("env-key"));
        assert!(s.civitai_api_key().is_some());
    }

    #[test]
    fn nothing_configured() {
        let dir = tempfile::tempdir().unwrap();
        let s = Settings::new(
            Arc::new(MemoryStore::default()),
            env(&[(ENV_RUNPOD_KEY, "")]),
            dir.path().join("c.json"),
        );
        assert_eq!(
            s.view(),
            SettingsView {
                has_api_key: false,
                endpoint_id: None,
                has_civitai_key: false
            }
        );
        assert!(s
            .save(SaveSettings {
                endpoint_id: Some("bad/id".into()),
                ..Default::default()
            })
            .is_err());
    }

    #[test]
    fn pod_settings_and_token() {
        let dir = tempfile::tempdir().unwrap();
        let store = Arc::new(MemoryStore::default());
        let path = dir.path().join("c.json");
        let s = Settings::new(store.clone(), HashMap::new(), path.clone());
        assert_eq!(s.backend(), Backend::Pod);
        assert_eq!(s.idle_minutes(), DEFAULT_IDLE_MINUTES);
        assert!(s.pass_api_key_to_pod());
        assert!(s
            .save_pod(SavePodSettings {
                idle_minutes: Some(4),
                ..Default::default()
            })
            .is_err());
        s.save_pod(SavePodSettings {
            idle_minutes: Some(45),
            backend: Some(Backend::Serverless),
            pass_api_key_to_pod: Some(false),
            gpu_types: Some(vec!["G1".into(), " ".into()]),
            volume_names: Some(vec![]),
        })
        .unwrap();
        let r = Settings::new(store.clone(), HashMap::new(), path);
        assert_eq!(r.idle_minutes(), 45);
        assert_eq!(r.backend(), Backend::Serverless);
        assert!(!r.pass_api_key_to_pod());
        assert_eq!(r.gpu_types(), vec!["G1".to_string()]);
        assert_eq!(r.volume_names().len(), DEFAULT_VOLUME_NAMES.len(), "empty list → defaults");
        assert_eq!(s.gpu_types(), vec!["G1".to_string()]);
        let t = s.pod_token().unwrap();
        assert_eq!(t.len(), 64);
        assert!(t.chars().all(|c| c.is_ascii_hexdigit()));
        assert_eq!(r.pod_token().unwrap(), t, "generated once, then reused");
    }

    #[test]
    fn worker_ref_and_pod_image_from_config_file() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("c.json");
        let store = Arc::new(MemoryStore::default());
        let s = Settings::new(store.clone(), HashMap::new(), path.clone());
        assert_eq!(s.worker_ref(), "main");
        assert_eq!(s.pod_image(), crate::pod::POD_IMAGE);
        assert!(crate::pod::POD_IMAGE.contains("image-studio-runtime"));

        std::fs::write(
            &path,
            format!(
                r#"{{"workerRef": " 0123456789abcdef0123456789abcdef01234567 ", "podImage": "{}"}}"#,
                crate::pod::LEGACY_POD_IMAGE
            ),
        )
        .unwrap();
        let r = Settings::new(store.clone(), HashMap::new(), path.clone());
        assert_eq!(r.worker_ref(), "0123456789abcdef0123456789abcdef01234567");
        assert_eq!(r.pod_image(), crate::pod::LEGACY_POD_IMAGE);
        // Saving other settings keeps the hand-edited keys.
        r.save_pod(SavePodSettings {
            idle_minutes: Some(20),
            ..Default::default()
        })
        .unwrap();
        let body = std::fs::read_to_string(&path).unwrap();
        assert!(body.contains("\"workerRef\"") && body.contains("\"podImage\""), "{body}");

        std::fs::write(&path, r#"{"workerRef": "  ", "podImage": ""}"#).unwrap();
        let b = Settings::new(store, HashMap::new(), path);
        assert_eq!(b.worker_ref(), DEFAULT_WORKER_REF, "blank → default");
        assert_eq!(b.pod_image(), crate::pod::POD_IMAGE);
    }

    #[test]
    fn vault_auto_lock_setting() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("c.json");
        let store = Arc::new(MemoryStore::default());
        let s = Settings::new(store.clone(), HashMap::new(), path.clone());
        assert_eq!(s.vault_auto_lock_minutes(), 10);
        assert!(s.save_vault_auto_lock(0).is_err());
        assert!(s.save_vault_auto_lock(241).is_err());
        s.save_vault_auto_lock(25).unwrap();
        let r = Settings::new(store, HashMap::new(), path);
        assert_eq!(r.vault_auto_lock_minutes(), 25);
    }
}

/// Writes `body` to `path` readable only by the current user (0600).
fn write_private_file(path: &Path, body: &str) -> Result<(), String> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| format!("Could not save the pod token: {e}"))?;
    }
    use std::io::Write;
    #[cfg(unix)]
    use std::os::unix::fs::OpenOptionsExt;
    let mut opts = std::fs::OpenOptions::new();
    opts.write(true).create(true).truncate(true);
    #[cfg(unix)]
    opts.mode(0o600);
    let mut f = opts
        .open(path)
        .map_err(|e| format!("Could not save the pod token: {e}"))?;
    f.write_all(body.as_bytes())
        .map_err(|e| format!("Could not save the pod token: {e}"))
}

#[cfg(test)]
mod secret_cache_tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    struct Counting(MemoryStore, AtomicUsize);
    impl SecretStore for Counting {
        fn get(&self, a: &str) -> Result<Option<String>, String> {
            self.1.fetch_add(1, Ordering::SeqCst);
            self.0.get(a)
        }
        fn set(&self, a: &str, v: Option<&str>) -> Result<(), String> {
            self.0.set(a, v)
        }
    }

    #[test]
    fn cached_store_reads_each_item_once() {
        let s = CachedStore::new(Counting(MemoryStore::default(), AtomicUsize::new(0)));
        s.inner.0.set("k", Some("v")).unwrap();
        for _ in 0..5 {
            assert_eq!(s.get("k").unwrap().as_deref(), Some("v"));
            assert_eq!(s.get("missing").unwrap(), None);
        }
        assert_eq!(s.inner.1.load(Ordering::SeqCst), 2);
        s.set("k", Some("w")).unwrap();
        assert_eq!(s.get("k").unwrap().as_deref(), Some("w"));
        assert_eq!(s.inner.1.load(Ordering::SeqCst), 2);
    }

    #[test]
    fn pod_token_lives_in_a_private_file_and_migrates_once() {
        let dir = tempfile::tempdir().unwrap();
        let store = Arc::new(MemoryStore::default());
        store.set(ACCOUNT_POD_TOKEN, Some("legacy")).unwrap();
        let st = Settings::new(store.clone(), HashMap::new(), dir.path().join("settings.json"));
        assert_eq!(st.pod_token().unwrap(), "legacy");
        let p = dir.path().join("pod_token");
        assert_eq!(std::fs::read_to_string(&p).unwrap(), "legacy");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(std::fs::metadata(&p).unwrap().permissions().mode() & 0o777, 0o600);
        }
        store.set(ACCOUNT_POD_TOKEN, None).unwrap();
        assert_eq!(st.pod_token().unwrap(), "legacy");

        let dir2 = tempfile::tempdir().unwrap();
        let st2 = Settings::new(Arc::new(MemoryStore::default()), HashMap::new(), dir2.path().join("settings.json"));
        let t = st2.pod_token().unwrap();
        assert_eq!(t.len(), 64);
        assert_eq!(st2.pod_token().unwrap(), t);
    }
}
