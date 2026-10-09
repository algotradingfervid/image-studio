//! Moving content between the general gallery (plaintext files + SQLite) and
//! the vault (spec v6): sealing job outputs, "Move to vault" / "Move to
//! General", the one-time migration, and vault-side start images.
//!
//! Every move into the vault is encrypt → verify the round-trip → write the
//! item record → delete the plaintext → delete the database row, in that
//! order, so an interruption never loses content. The migration keeps a small
//! journal of ids (no content) so a re-run resumes where it stopped.

use crate::db::{ImageRecord, KIND_VIDEO};
use crate::references::{self, ImportedReference};
use crate::state::Core;
use crate::vault::{item_from_record, sniff_ext, BlobRef, VaultItem, ERR_LOCKED, ERR_NO_VAULT};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use zeroize::Zeroizing;

/// Test hook: `stop_after` simulates a crash after that many items.
#[derive(Debug, Clone, Default)]
pub struct MigrateOptions {
    pub stop_after: Option<usize>,
}

#[derive(Debug, Clone, Default, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct MigrationCounts {
    pub images: usize,
    pub videos: usize,
    pub posters: usize,
    pub start_images: usize,
    pub references: usize,
}

impl MigrationCounts {
    fn add(&mut self, o: &MigrationCounts) {
        self.images += o.images;
        self.videos += o.videos;
        self.posters += o.posters;
        self.start_images += o.start_images;
        self.references += o.references;
    }
}

/// `vault-migration` event payload.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct MigrationProgress {
    /// "encrypting" | "verifying" | "cleaning" | "done" | "error"
    pub phase: String,
    pub done: usize,
    pub total: usize,
    pub counts: MigrationCounts,
    pub errors: usize,
    pub error: Option<String>,
}

/// Ids only — never content.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Journal {
    started_at: String,
    pending: Vec<String>,
    done: BTreeMap<String, String>,
}

fn read_journal(path: &Path) -> Option<Journal> {
    std::fs::read_to_string(path)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
}

fn write_journal(path: &Path, j: &Journal) -> Result<(), String> {
    let tmp = path.with_extension("tmp");
    std::fs::write(&tmp, serde_json::to_string(j).unwrap())
        .and_then(|_| std::fs::rename(&tmp, path))
        .map_err(|e| format!("Could not write the migration journal: {e}"))
}

fn read_file(path: &str) -> Result<Zeroizing<Vec<u8>>, String> {
    std::fs::read(path)
        .map(Zeroizing::new)
        .map_err(|e| format!("Could not read {}: {e}", Path::new(path).file_name().unwrap_or_default().to_string_lossy()))
}

fn ext_of(path: &str, bytes: &[u8]) -> String {
    let sniffed = sniff_ext(bytes);
    if sniffed != "bin" {
        return sniffed.to_string();
    }
    Path::new(path)
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_ascii_lowercase())
        .unwrap_or_else(|| "bin".into())
}

/// Seals `bytes` and, when the vault is unlocked, checks the round-trip.
pub fn seal_verified(core: &Core, bytes: &[u8], ext: &str) -> Result<BlobRef, String> {
    let b = core.vault.seal_blob(bytes, ext)?;
    if core.vault.is_unlocked() {
        if let Err(e) = core.vault.verify_blob(&b.id, bytes) {
            let _ = core.vault.delete_blob(&b.id);
            return Err(e);
        }
    }
    Ok(b)
}

/// A reference/start-image path as it appears in a record → a blob for the
/// vault item. `vault:` paths are reused; plain files are sealed (the plain
/// file is left in place; `delete_originals` removes it when nothing else uses it).
fn seal_path(core: &Core, path: &str) -> Result<BlobRef, String> {
    if let Some(b) = BlobRef::parse(path) {
        return Ok(b);
    }
    let bytes = read_file(path)?;
    seal_verified(core, &bytes, &ext_of(path, &bytes))
}

fn thumb_for(core: &Core, rec_kind: &str, media: &[u8]) -> Option<BlobRef> {
    if rec_kind == KIND_VIDEO {
        return None;
    }
    let t = references::thumbnail(media)?;
    seal_verified(core, &t, "jpg").ok()
}

/// Seals a job output (bytes in memory, never on disk) and writes its record.
/// `template` is the plan's record with `created_at`, seed, sizes etc. filled
/// in; its `init_image`/`references` are `vault:` paths or plain files.
pub fn seal_output(
    core: &Core,
    template: &ImageRecord,
    media: &[u8],
    poster: Option<&[u8]>,
) -> Result<ImageRecord, String> {
    if !core.vault.exists() {
        return Err(format!("{ERR_NO_VAULT}: Create the vault first (Gallery → Vault)"));
    }
    let id = uuid::Uuid::new_v4().to_string();
    let media_ref = core.vault.seal_blob(media, sniff_ext(media))?;
    let poster_ref = match poster {
        Some(p) => Some(core.vault.seal_blob(p, sniff_ext(p))?),
        None => None,
    };
    let thumb = thumb_for(core, &template.kind, media);
    let init = match &template.init_image {
        Some(p) => Some(seal_path(core, p)?),
        None => None,
    };
    let refs = template
        .references
        .iter()
        .map(|p| seal_path(core, p))
        .collect::<Result<Vec<_>, _>>()?;
    let item = item_from_record(template, id, media_ref, poster_ref, thumb, init, refs, None);
    core.vault.put_item(&item)?;
    core.emit_vault();
    Ok(item.to_record())
}

struct Sealed {
    item: VaultItem,
    counts: MigrationCounts,
}

/// Encrypts every file of a general record and verifies each round-trip.
/// Nothing is deleted here.
fn seal_record(core: &Core, rec: &ImageRecord) -> Result<Sealed, String> {
    if !core.vault.is_unlocked() {
        return Err(format!("{ERR_LOCKED}: Unlock the vault first"));
    }
    let mut counts = MigrationCounts::default();
    let media = read_file(&rec.path)?;
    let media_ref = seal_verified(core, &media, &ext_of(&rec.path, &media))?;
    if rec.kind == KIND_VIDEO {
        counts.videos += 1;
    } else {
        counts.images += 1;
    }
    let poster = match &rec.poster_path {
        Some(p) => {
            let b = read_file(p)?;
            counts.posters += 1;
            Some(seal_verified(core, &b, &ext_of(p, &b))?)
        }
        None => None,
    };
    let thumb = thumb_for(core, &rec.kind, &media);
    let init = match &rec.init_image {
        Some(p) => {
            counts.start_images += 1;
            Some(seal_path(core, p)?)
        }
        None => None,
    };
    let mut refs = Vec::new();
    for p in &rec.references {
        refs.push(seal_path(core, p)?);
        counts.references += 1;
    }
    let item = item_from_record(
        rec,
        uuid::Uuid::new_v4().to_string(),
        media_ref,
        poster,
        thumb,
        init,
        refs,
        Some(rec.id.clone()),
    );
    Ok(Sealed { item, counts })
}

/// Deletes a general record's plaintext files (only under the app's own
/// `images/`, `videos/` and `references/`; shared reference files only when
/// no other record uses them) and then its database row.
fn delete_originals(core: &Core, rec: &ImageRecord) -> Result<(), String> {
    let owned = [core.cfg.images_dir(), core.cfg.videos_dir()];
    let refs_dir = core.cfg.references_dir();
    let db = core.db.lock().unwrap();
    for f in std::iter::once(&rec.path).chain(rec.poster_path.iter()) {
        let p = PathBuf::from(f);
        if owned.iter().any(|d| p.starts_with(d)) {
            remove_quiet(&p);
        }
    }
    for f in rec.init_image.iter().chain(rec.references.iter()) {
        let p = PathBuf::from(f);
        if p.starts_with(&refs_dir) && db.path_use_count(f)? <= 1 {
            remove_quiet(&p);
        }
    }
    db.delete_image(&rec.id)
}

fn remove_quiet(p: &Path) {
    if let Err(e) = std::fs::remove_file(p) {
        if e.kind() != std::io::ErrorKind::NotFound {
            eprintln!("[vault] could not delete {}: {e}", p.display());
        }
    }
}

/// The vault item for `rec`: an existing one from an interrupted earlier move
/// (same `source_id`), else a freshly sealed and verified one.
fn seal_or_reuse(core: &Core, rec: &ImageRecord) -> Result<(VaultItem, MigrationCounts), String> {
    if let Some(existing) = core.vault.find_by_source(&rec.id)? {
        return Ok((existing, MigrationCounts::default()));
    }
    let sealed = seal_record(core, rec)?;
    core.vault.put_item(&sealed.item)?;
    Ok((sealed.item, sealed.counts))
}

/// "Move to vault": encrypt, verify, record, then delete the plaintext and row.
pub fn move_to_vault(core: &Core, id: &str) -> Result<ImageRecord, String> {
    let rec = core
        .db
        .lock()
        .unwrap()
        .get_image(id)?
        .ok_or("Image not found")?;
    if !core.vault.is_unlocked() {
        return Err(format!("{ERR_LOCKED}: Unlock the vault first"));
    }
    let (item, _) = seal_or_reuse(core, &rec)?;
    delete_originals(core, &rec)?;
    core.db.lock().unwrap().scrub()?;
    core.vault.touch();
    Ok(item.to_record())
}

fn write_plain(path: &Path, bytes: &[u8]) -> Result<(), String> {
    if let Some(d) = path.parent() {
        std::fs::create_dir_all(d).map_err(|e| format!("Could not write {}: {e}", path.display()))?;
    }
    std::fs::write(path, bytes).map_err(|e| format!("Could not write {}: {e}", path.display()))
}

/// "Move to General": decrypt into `images/` / `videos/` / `references/`,
/// insert the database row, then remove the vault item.
pub fn move_to_general(core: &Core, id: &str) -> Result<ImageRecord, String> {
    let item = core.vault.item(id)?;
    let video = item.kind == KIND_VIDEO;
    let media_dir = if video {
        core.cfg.videos_dir()
    } else {
        core.cfg.images_dir()
    };
    let media = core.vault.open_blob(&item.media.id)?;
    let media_path = media_dir.join(format!("{}.{}", item.id, item.media.ext));
    write_plain(&media_path, &media)?;
    let poster_path = match &item.poster {
        Some(p) => {
            let b = core.vault.open_blob(&p.id)?;
            let path = media_dir.join(format!("{}.{}", item.id, p.ext));
            write_plain(&path, &b)?;
            Some(path.to_string_lossy().into_owned())
        }
        None => None,
    };
    let refs_dir = core.cfg.references_dir();
    let mut restore_ref = |b: &BlobRef| -> Result<String, String> {
        let bytes = core.vault.open_blob(&b.id)?;
        let path = refs_dir.join(format!("{}.{}", b.id, b.ext));
        write_plain(&path, &bytes)?;
        Ok(path.to_string_lossy().into_owned())
    };
    let init_image = match &item.init_image {
        Some(b) => Some(restore_ref(b)?),
        None => None,
    };
    let references = item
        .references
        .iter()
        .map(&mut restore_ref)
        .collect::<Result<Vec<_>, _>>()?;
    let mut rec = item.to_record();
    rec.vault = false;
    rec.thumb_path = None;
    rec.path = media_path.to_string_lossy().into_owned();
    rec.poster_path = poster_path;
    rec.init_image = init_image;
    rec.references = references;
    core.db.lock().unwrap().insert_image(&rec)?;
    core.vault.delete_item(id)?;
    core.vault.touch();
    Ok(rec)
}

/// Decrypts a vault item's media into a user-chosen file (an unencrypted copy).
pub fn export_item(core: &Core, id: &str, dest: &Path) -> Result<(), String> {
    let item = core.vault.item(id)?;
    let bytes = core.vault.open_blob(&item.media.id)?;
    std::fs::write(dest, &bytes).map_err(|e| {
        let what = if item.kind == KIND_VIDEO { "video" } else { "image" };
        format!("Could not save the {what}: {e}")
    })
}

pub fn migration_pending(core: &Core) -> bool {
    core.vault.journal_path().exists()
}

/// The one-time migration of every general record into the vault. Resumable:
/// the journal lists the ids still to do and the ones whose encrypted copy is
/// already verified (those only need their originals removed). Always ends
/// with a `vault-migration` event (`done` or `error`) and a `vault-update`.
pub fn migrate(core: &Core, opts: MigrateOptions) -> Result<MigrationProgress, String> {
    let mut progress = MigrationProgress {
        phase: "encrypting".into(),
        done: 0,
        total: 0,
        counts: MigrationCounts::default(),
        errors: 0,
        error: None,
    };
    let result = migrate_inner(core, opts, &mut progress);
    if let Err(e) = &result {
        progress.phase = "error".into();
        progress.error = Some(e.clone());
        core.sink.vault_migration(&progress);
        core.emit_vault();
    }
    result.map(|()| progress)
}

fn migrate_inner(
    core: &Core,
    opts: MigrateOptions,
    progress: &mut MigrationProgress,
) -> Result<(), String> {
    if !core.vault.is_unlocked() {
        return Err(format!("{ERR_LOCKED}: Unlock the vault first"));
    }
    let journal_path = core.vault.journal_path();
    let mut journal = match read_journal(&journal_path) {
        Some(j) => j,
        None => {
            let pending = core.db.lock().unwrap().all_image_ids()?;
            let j = Journal {
                started_at: crate::state::now_rfc3339(),
                pending,
                done: BTreeMap::new(),
            };
            write_journal(&journal_path, &j)?;
            j
        }
    };
    progress.total = journal.pending.len();
    core.sink.vault_migration(progress);
    let pending = journal.pending.clone();
    for (i, id) in pending.iter().enumerate() {
        if opts.stop_after == Some(i) {
            return Err("Migration interrupted".into());
        }
        progress.phase = "encrypting".into();
        core.sink.vault_migration(progress);
        let rec = core.db.lock().unwrap().get_image(id)?;
        let Some(rec) = rec else {
            // Row already gone (finished on an earlier run).
            progress.done += 1;
            continue;
        };
        let result: Result<(), String> = (|| {
            if let Some(item_id) = journal.done.get(id) {
                // Encrypted copy already verified; only the originals are left.
                if core.vault.item(item_id).is_ok() {
                    return delete_originals(core, &rec);
                }
            }
            // An item from an interrupted run that never reached the journal
            // is reused instead of sealed a second time.
            let (item, counts) = seal_or_reuse(core, &rec)?;
            journal.done.insert(id.clone(), item.id.clone());
            write_journal(&journal_path, &journal)?;
            progress.counts.add(&counts);
            progress.phase = "cleaning".into();
            core.sink.vault_migration(progress);
            delete_originals(core, &rec)
        })();
        match result {
            Ok(()) => progress.done += 1,
            Err(e) => {
                eprintln!("[vault] migration: item {id} skipped: {e}");
                progress.errors += 1;
                progress.done += 1;
            }
        }
        core.sink.vault_migration(progress);
    }
    let _ = std::fs::remove_file(&journal_path);
    core.db.lock().unwrap().scrub()?;
    progress.phase = "done".into();
    core.sink.vault_migration(progress);
    core.emit_vault();
    Ok(())
}

// ----- references / start images -----

/// Imports a start image or reference straight into the vault: downscaled
/// like every reference, then sealed. The id doubles as the path.
pub fn import_reference_to_vault(core: &Core, bytes: &[u8]) -> Result<ImportedReference, String> {
    if !core.vault.exists() {
        return Err(format!("{ERR_NO_VAULT}: Create the vault first (Gallery → Vault)"));
    }
    let (out, ext) = references::process(bytes)?;
    let out = Zeroizing::new(out);
    let b = seal_verified(core, &out, ext)?;
    Ok(ImportedReference {
        ref_id: b.path(),
        thumb_path: b.path(),
    })
}

/// Reads a start image / reference source: a `vault:` path (needs the
/// unlocked vault) or a plain file.
pub fn read_source(core: &Core, path: &str) -> Result<Zeroizing<Vec<u8>>, String> {
    match BlobRef::parse(path) {
        Some(b) => core.vault.open_blob(&b.id),
        None => read_file(path),
    }
}

/// Moves a plain imported reference (`references/<uuid>.<ext>`) into the
/// vault for a vault job. The plaintext is deleted only after the encrypted
/// copy is verified (so only while unlocked).
pub fn seal_plain_reference(core: &Core, ref_id: &str) -> Result<ImportedReference, String> {
    if let Some(b) = BlobRef::parse(ref_id) {
        return Ok(ImportedReference {
            ref_id: b.path(),
            thumb_path: b.path(),
        });
    }
    let p = references::find(&core.cfg.references_dir(), ref_id)?;
    let bytes = read_file(&p.to_string_lossy())?;
    let b = seal_verified(core, &bytes, &ext_of(&p.to_string_lossy(), &bytes))?;
    if core.vault.is_unlocked() {
        remove_quiet(&p);
    }
    Ok(ImportedReference {
        ref_id: b.path(),
        thumb_path: b.path(),
    })
}
