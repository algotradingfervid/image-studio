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

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppConfig {
    #[serde(default)]
    pub endpoint_id: Option<String>,
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
            if let Some(dir) = self.config_path.parent() {
                std::fs::create_dir_all(dir)
                    .map_err(|e| format!("Could not save settings: {e}"))?;
            }
            let body = serde_json::to_string_pretty(&*cfg).map_err(|e| e.to_string())?;
            std::fs::write(&self.config_path, body)
                .map_err(|e| format!("Could not save settings: {e}"))?;
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
}
