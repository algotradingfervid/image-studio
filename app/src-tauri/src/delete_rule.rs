//! Shared-file delete rule (pure).
//!
//! Deleting model X deletes all of X's files, except that a file shared with
//! model Y is deleted only if Y is fully deleted. Y counts as deleted when none
//! of its other files are on the volume and Y is not downloading or queued.
//! "Other files" of Y are Y's files that X does not also own (those are being
//! deleted together with X anyway).

use crate::registry::{Model, ModelFile};
use serde::Serialize;
use std::collections::HashSet;

/// Identity of a file on the volume.
pub type FileKey = (String, String); // (folder, filename)

pub fn key(f: &ModelFile) -> FileKey {
    (f.folder.clone(), f.filename.clone())
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct KeptFile {
    pub filename: String,
    pub reason: String,
}

#[derive(Debug, Clone, PartialEq)]
pub struct DeletePlan {
    /// Files to send to the worker's `delete` action.
    pub delete_files: Vec<ModelFile>,
    /// Bytes freed: sizes of files in `delete_files` that are currently present.
    pub freed_bytes: u64,
    pub kept_files: Vec<KeptFile>,
}

/// `present`: files currently on the volume. `busy`: ids of models that are
/// downloading or queued for download.
pub fn plan_delete(
    target: &Model,
    all: &[Model],
    present: &HashSet<FileKey>,
    busy: &HashSet<String>,
) -> DeletePlan {
    let target_keys: HashSet<FileKey> = target.files.iter().map(key).collect();
    let mut delete_files = Vec::new();
    let mut kept_files = Vec::new();
    let mut freed_bytes = 0u64;

    for file in &target.files {
        let k = key(file);
        let mut keep_reason: Option<String> = None;
        for other in all.iter().filter(|m| m.id != target.id) {
            if !other.files.iter().any(|f| key(f) == k) {
                continue;
            }
            let others_present: Vec<&ModelFile> = other
                .files
                .iter()
                .filter(|f| !target_keys.contains(&key(f)))
                .filter(|f| present.contains(&key(f)))
                .collect();
            let n_other = other
                .files
                .iter()
                .filter(|f| !target_keys.contains(&key(f)))
                .count();
            if busy.contains(&other.id) {
                keep_reason = Some(format!(
                    "Shared with {}, which is downloading or queued",
                    other.name
                ));
            } else if !others_present.is_empty() {
                let state = if others_present.len() == n_other {
                    "installed"
                } else {
                    "partially installed"
                };
                keep_reason = Some(format!("Shared with {}, which is {state}", other.name));
            }
            if keep_reason.is_some() {
                break;
            }
        }
        match keep_reason {
            Some(reason) => kept_files.push(KeptFile {
                filename: file.filename.clone(),
                reason,
            }),
            None => {
                if present.contains(&k) {
                    freed_bytes += file.size_bytes.unwrap_or(0);
                }
                delete_files.push(file.clone());
            }
        }
    }
    DeletePlan {
        delete_files,
        freed_bytes,
        kept_files,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::registry::Registry;

    fn setup() -> (Registry, HashSet<FileKey>) {
        let r = Registry::embedded();
        let present: HashSet<FileKey> = r
            .models
            .iter()
            .flat_map(|m| m.files.iter().map(key))
            .collect();
        (r, present)
    }

    fn files_of(r: &Registry, id: &str) -> Vec<FileKey> {
        r.model(id).unwrap().files.iter().map(key).collect()
    }

    fn ae() -> FileKey {
        ("vae".into(), "ae.safetensors".into())
    }

    fn deleted_names(p: &DeletePlan) -> Vec<String> {
        p.delete_files.iter().map(|f| f.filename.clone()).collect()
    }

    #[test]
    fn other_model_fully_present_keeps_shared() {
        let (r, present) = setup();
        let p = plan_delete(
            r.model("chroma").unwrap(),
            &r.models,
            &present,
            &HashSet::new(),
        );
        assert!(!deleted_names(&p).contains(&"ae.safetensors".to_string()));
        assert_eq!(p.kept_files.len(), 1);
        assert_eq!(p.kept_files[0].filename, "ae.safetensors");
        assert!(p.kept_files[0].reason.contains("Z-Image Turbo"));
        assert!(p.kept_files[0].reason.contains("installed"));
        assert_eq!(p.delete_files.len(), 2);
        let expected: u64 = r.model("chroma").unwrap().files[..2]
            .iter()
            .filter_map(|f| f.size_bytes)
            .sum();
        assert_eq!(p.freed_bytes, expected);
    }

    #[test]
    fn other_model_partially_present_keeps_shared() {
        let (r, mut present) = setup();
        // Z-Image has its unet but not its text encoder.
        let z = files_of(&r, "zimage");
        present.remove(&z[1]);
        let p = plan_delete(
            r.model("chroma").unwrap(),
            &r.models,
            &present,
            &HashSet::new(),
        );
        assert_eq!(p.kept_files.len(), 1);
        assert!(p.kept_files[0].reason.contains("partially installed"));
    }

    #[test]
    fn other_model_downloading_keeps_shared() {
        let (r, mut present) = setup();
        for k in files_of(&r, "zimage") {
            if k != ae() {
                present.remove(&k);
            }
        }
        let busy: HashSet<String> = ["zimage".to_string()].into();
        let p = plan_delete(r.model("chroma").unwrap(), &r.models, &present, &busy);
        assert_eq!(p.kept_files.len(), 1);
        assert!(p.kept_files[0].reason.contains("downloading"));
    }

    #[test]
    fn other_model_fully_deleted_deletes_shared() {
        let (r, mut present) = setup();
        for k in files_of(&r, "zimage") {
            if k != ae() {
                present.remove(&k);
            }
        }
        let p = plan_delete(
            r.model("chroma").unwrap(),
            &r.models,
            &present,
            &HashSet::new(),
        );
        assert!(p.kept_files.is_empty());
        assert!(deleted_names(&p).contains(&"ae.safetensors".to_string()));
        assert_eq!(p.freed_bytes, r.model("chroma").unwrap().total_bytes());
    }

    #[test]
    fn deleting_second_model_last_deletes_shared() {
        let (r, mut present) = setup();
        // First delete chroma: ae is kept because zimage is installed.
        let p1 = plan_delete(
            r.model("chroma").unwrap(),
            &r.models,
            &present,
            &HashSet::new(),
        );
        assert!(p1.kept_files.iter().any(|k| k.filename == "ae.safetensors"));
        for f in &p1.delete_files {
            present.remove(&key(f));
        }
        assert!(present.contains(&ae()));
        // Then delete zimage: chroma is fully gone, so ae goes too.
        let p2 = plan_delete(
            r.model("zimage").unwrap(),
            &r.models,
            &present,
            &HashSet::new(),
        );
        assert!(p2.kept_files.is_empty());
        assert!(deleted_names(&p2).contains(&"ae.safetensors".to_string()));
    }
}
