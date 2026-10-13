//! Where a character or story lives: SQLite (General) or the vault. The only
//! module that knows; render.rs and commands.rs call these verbs.
//!
//! While the vault is locked nothing of it shows: lists hold General records
//! only, a vault story or character answers `VAULT_LOCKED: …`, and the only
//! vault write that still works is sealing a finished take (`Vault::put_item`,
//! not routed here). A record's store is fixed at creation: a save that says
//! otherwise keeps it where it is.

use crate::db::ImageRecord;
use crate::state::Core;
use crate::stories::{store, validate, Character, Shot, Story, StoryDoc};
use crate::vault::{ERR_LOCKED, ERR_NO_VAULT};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Home {
    General,
    Vault,
}

fn home_of(vault: bool) -> Home {
    if vault {
        Home::Vault
    } else {
        Home::General
    }
}

fn locked(what: &str) -> String {
    format!("{ERR_LOCKED}: Unlock the vault to {what}")
}

fn no_vault() -> String {
    format!("{ERR_NO_VAULT}: Create the vault first (Gallery → Vault)")
}

/// `VAULT_LOCKED` errors from the vault layer become the spec's copy for `what`.
fn map_locked(e: String, what: &str) -> String {
    if e.starts_with(ERR_LOCKED) {
        locked(what)
    } else {
        e
    }
}

const OPEN_STORY: &str = "open this story";
const OPEN_CHARACTER: &str = "open this character";

// ----- homes -----

/// Which store holds the story, if any. Works while locked (a file-name check).
pub fn story_home(core: &Core, id: &str) -> Result<Option<Home>, String> {
    if store::get_story(&core.db.lock().unwrap(), id)?.is_some() {
        return Ok(Some(Home::General));
    }
    Ok(core.vault.story_file_exists(id).then_some(Home::Vault))
}

/// Which store holds the character, if any. Works while locked (a file-name check).
pub fn character_home(core: &Core, id: &str) -> Result<Option<Home>, String> {
    if store::get_character(&core.db.lock().unwrap(), id)?.is_some() {
        return Ok(Some(Home::General));
    }
    Ok(core.vault.character_file_exists(id).then_some(Home::Vault))
}

// ----- story docs (vault) -----

/// The vault story's doc; `VAULT_LOCKED` while locked, `Ok(None)` when there is no such story.
fn vault_doc(core: &Core, id: &str) -> Result<Option<StoryDoc>, String> {
    if core.vault.is_unlocked() {
        return Ok(core.vault.story_doc(id).ok());
    }
    if core.vault.story_file_exists(id) {
        return Err(locked(OPEN_STORY));
    }
    Ok(None)
}

/// Seals the doc with a fresh `updated_at` (the vault lists stories by it, as SQLite does).
fn put_doc(core: &Core, mut doc: StoryDoc) -> Result<Story, String> {
    doc.story.updated_at = crate::state::now_rfc3339();
    doc.shots.sort_by_key(|s| s.position);
    core.vault.put_story_doc(&doc).map_err(|e| map_locked(e, OPEN_STORY))?;
    Ok(doc.story)
}

/// The unlocked vault's doc holding `shot_id`, if any.
fn doc_with_shot(core: &Core, shot_id: &str) -> Result<Option<StoryDoc>, String> {
    if !core.vault.is_unlocked() {
        return Ok(None);
    }
    Ok(core.vault.story_docs()?.into_iter().find(|d| d.shots.iter().any(|s| s.id == shot_id)))
}

// ----- stories -----

pub fn get_story(core: &Core, id: &str) -> Result<Option<Story>, String> {
    if let Some(s) = store::get_story(&core.db.lock().unwrap(), id)? {
        return Ok(Some(s));
    }
    Ok(vault_doc(core, id)?.map(|d| d.story))
}

/// General stories, plus the vault's while it is unlocked; most recently updated first.
pub fn list_stories(core: &Core) -> Result<Vec<Story>, String> {
    let mut v = store::list_stories(&core.db.lock().unwrap())?;
    if core.vault.is_unlocked() {
        v.extend(core.vault.story_docs()?.into_iter().map(|d| d.story));
    }
    v.sort_by(|a, b| b.updated_at.cmp(&a.updated_at).then(b.created_at.cmp(&a.created_at)));
    Ok(v)
}

/// Inserts or updates the story in its store (an existing story keeps its
/// store whatever `s.vault` says; a new one goes where `s.vault` points).
pub fn save_story(core: &Core, s: &Story) -> Result<Story, String> {
    let existing = story_home(core, &s.id)?;
    let home = existing.unwrap_or(home_of(s.vault));
    let mut s = s.clone();
    s.vault = home == Home::Vault;
    match home {
        Home::General => {
            store::save_story(&core.db.lock().unwrap(), &s)?;
            Ok(s)
        }
        Home::Vault => {
            if !core.vault.exists() {
                return Err(no_vault());
            }
            if !core.vault.is_unlocked() {
                return Err(locked(if existing.is_some() { OPEN_STORY } else { "create a vault story" }));
            }
            let mut doc = vault_doc(core, &s.id)?.unwrap_or(StoryDoc { story: s.clone(), shots: vec![], sidecar: None });
            doc.story = s;
            put_doc(core, doc)
        }
    }
}

/// Deletes the story and its shots. A vault story's takes and film (its
/// items) go with it; a General story's records are the caller's.
pub fn delete_story(core: &Core, id: &str) -> Result<(), String> {
    match story_home(core, id)? {
        Some(Home::General) | None => store::delete_story(&core.db.lock().unwrap(), id),
        Some(Home::Vault) => {
            if !core.vault.is_unlocked() {
                return Err(locked(OPEN_STORY));
            }
            for item in core.vault.items_for_story(id)? {
                core.vault.delete_item(&item.id)?;
            }
            core.vault.delete_story_doc(id).map_err(|e| map_locked(e, OPEN_STORY))
        }
    }
}

/// Records the assembled film and the planner's sidecar; the story becomes "assembled".
pub fn set_result(core: &Core, story_id: &str, image_id: &str, sidecar: &serde_json::Value) -> Result<(), String> {
    match story_home(core, story_id)? {
        Some(Home::General) | None => store::set_result(&core.db.lock().unwrap(), story_id, image_id, &sidecar.to_string()),
        Some(Home::Vault) => {
            let mut doc = vault_doc(core, story_id)?.ok_or("That story no longer exists")?;
            doc.story.result_image_id = Some(image_id.to_string());
            doc.story.status = "assembled".into();
            doc.sidecar = Some(sidecar.clone());
            put_doc(core, doc).map(|_| ())
        }
    }
}

// ----- shots -----

/// A story's shots, by position (empty for an unknown story).
pub fn list_shots(core: &Core, story_id: &str) -> Result<Vec<Shot>, String> {
    match story_home(core, story_id)? {
        Some(Home::General) => store::list_shots(&core.db.lock().unwrap(), story_id),
        Some(Home::Vault) => {
            let mut shots = vault_doc(core, story_id)?.map(|d| d.shots).unwrap_or_default();
            shots.sort_by_key(|s| s.position);
            Ok(shots)
        }
        None => Ok(vec![]),
    }
}

/// A shot by id: SQLite, else a scan of the unlocked vault's docs (a handful of stories).
pub fn get_shot(core: &Core, id: &str) -> Result<Option<Shot>, String> {
    if let Some(s) = store::get_shot(&core.db.lock().unwrap(), id)? {
        return Ok(Some(s));
    }
    Ok(doc_with_shot(core, id)?.and_then(|d| d.shots.into_iter().find(|s| s.id == id)))
}

/// Replaces all of a story's shots; each is stored under `story_id`.
pub fn replace_shots(core: &Core, story_id: &str, shots: &[Shot]) -> Result<(), String> {
    match story_home(core, story_id)? {
        Some(Home::General) | None => store::replace_shots(&core.db.lock().unwrap(), story_id, shots),
        Some(Home::Vault) => {
            let mut doc = vault_doc(core, story_id)?.ok_or("That story no longer exists")?;
            doc.shots = shots
                .iter()
                .cloned()
                .map(|mut s| {
                    s.story_id = story_id.to_string();
                    s
                })
                .collect();
            put_doc(core, doc).map(|_| ())
        }
    }
}

/// Updates an existing shot's fields (by id).
pub fn update_shot(core: &Core, shot: &Shot) -> Result<(), String> {
    if store::get_shot(&core.db.lock().unwrap(), &shot.id)?.is_some() {
        return store::update_shot(&core.db.lock().unwrap(), shot);
    }
    let mut doc = doc_with_shot(core, &shot.id)?.ok_or("That shot no longer exists")?;
    let slot = doc.shots.iter_mut().find(|s| s.id == shot.id).ok_or("That shot no longer exists")?;
    *slot = shot.clone();
    put_doc(core, doc).map(|_| ())
}

/// Records (or clears) the approved take of a shot.
pub fn set_approved(core: &Core, shot_id: &str, take_id: Option<&str>) -> Result<(), String> {
    if store::get_shot(&core.db.lock().unwrap(), shot_id)?.is_some() {
        return store::set_approved(&core.db.lock().unwrap(), shot_id, take_id);
    }
    let Some(mut doc) = doc_with_shot(core, shot_id)? else {
        return Ok(());
    };
    for s in doc.shots.iter_mut().filter(|s| s.id == shot_id) {
        s.approved_take_id = take_id.map(String::from);
    }
    put_doc(core, doc).map(|_| ())
}

// ----- takes -----

/// A story's takes (records with a `shot_id`), newest first.
pub fn list_takes(core: &Core, story: &Story) -> Result<Vec<ImageRecord>, String> {
    if !story.vault {
        return core.db.lock().unwrap().list_takes(&story.id);
    }
    let items = core.vault.items_for_story(&story.id).map_err(|e| map_locked(e, OPEN_STORY))?;
    Ok(items.iter().filter(|i| i.shot_id.is_some()).map(|i| i.to_record()).collect())
}

/// A take or film record from either store (vault: unlocked only).
pub fn get_take(core: &Core, id: &str) -> Result<Option<ImageRecord>, String> {
    if let Some(r) = core.db.lock().unwrap().get_image(id)? {
        return Ok(Some(r));
    }
    if core.vault.is_unlocked() {
        return Ok(core.vault.item(id).ok().map(|i| i.to_record()));
    }
    Ok(None)
}

/// A deleted take or film: the shot that approved it loses the approval; a
/// story whose film it was goes back to "planned".
pub fn clear_image_refs(core: &Core, image_id: &str) -> Result<(), String> {
    store::clear_image_refs(&core.db.lock().unwrap(), image_id)?;
    if core.vault.is_unlocked() {
        for mut d in core.vault.story_docs()? {
            let mut changed = false;
            for s in d.shots.iter_mut() {
                if s.approved_take_id.as_deref() == Some(image_id) {
                    s.approved_take_id = None;
                    changed = true;
                }
            }
            if d.story.result_image_id.as_deref() == Some(image_id) {
                d.story.result_image_id = None;
                d.story.status = "planned".into();
                changed = true;
            }
            if changed {
                put_doc(core, d)?;
            }
        }
    }
    Ok(())
}

// ----- characters -----

pub fn get_character(core: &Core, id: &str) -> Result<Option<Character>, String> {
    if let Some(c) = store::get_character(&core.db.lock().unwrap(), id)? {
        return Ok(Some(c));
    }
    if core.vault.is_unlocked() {
        return Ok(core.vault.character(id).ok());
    }
    if core.vault.character_file_exists(id) {
        return Err(locked(OPEN_CHARACTER));
    }
    Ok(None)
}

/// General characters, plus the vault's while it is unlocked; by name.
/// `ref_paths` are left for the caller (`render::with_ref_paths`).
pub fn list_characters(core: &Core) -> Result<Vec<Character>, String> {
    let mut v = store::list_characters(&core.db.lock().unwrap())?;
    if core.vault.is_unlocked() {
        v.extend(core.vault.characters()?);
    }
    v.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()).then(a.id.cmp(&b.id)));
    Ok(v)
}

/// Inserts or updates the character in its store. The store is fixed: an
/// existing character keeps its home whatever the request says. A vault
/// character's references are vault blobs; a General one's are `references/` ids.
pub fn save_character(core: &Core, c: &Character) -> Result<Character, String> {
    let existing = character_home(core, &c.id)?;
    let home = existing.unwrap_or(home_of(c.vault));
    let mut c = c.clone();
    c.vault = home == Home::Vault;
    if !c.ref_ids.iter().all(|r| crate::vault::is_vault_path(r) == c.vault) {
        return Err("Reference images must be in the same place as the character".into());
    }
    match home {
        Home::General => {
            store::save_character(&core.db.lock().unwrap(), &c)?;
            Ok(c)
        }
        Home::Vault => {
            if !core.vault.exists() {
                return Err(no_vault());
            }
            if !core.vault.is_unlocked() {
                return Err(locked(if existing.is_some() { OPEN_CHARACTER } else { "create a vault character" }));
            }
            // Names are unique per store (SQLite enforces the General store's).
            if core.vault.characters()?.iter().any(|x| x.id != c.id && x.name.eq_ignore_ascii_case(&c.name)) {
                return Err(format!("A character named {} already exists", c.name));
            }
            core.vault.put_character(&c).map_err(|e| map_locked(e, OPEN_CHARACTER))?;
            Ok(c)
        }
    }
}

/// Refused while a story casts the character, and for a General character
/// while the vault is locked (a vault story may cast it).
pub fn delete_character(core: &Core, id: &str) -> Result<(), String> {
    let c = get_character(core, id)?.ok_or("That character no longer exists")?;
    if !c.vault && core.vault.exists() && !core.vault.is_unlocked() {
        return Err("Unlock the vault first: a vault story may use this character".into());
    }
    if let Some(s) = list_stories(core)?.into_iter().find(|s| s.cast.iter().any(|x| x == id)) {
        return Err(format!("{} is used by story \"{}\"", c.name, s.title));
    }
    if c.vault {
        core.vault.delete_character(id).map(|_| ())
    } else {
        store::delete_character(&core.db.lock().unwrap(), id)
    }
}

/// The cast rules of spec §3.9: every cast id is a saved character, a General
/// story casts no vault character, and cast names differ (case-insensitive).
pub fn check_cast(core: &Core, story: &Story) -> Result<(), String> {
    let mut cast = Vec::with_capacity(story.cast.len());
    for id in &story.cast {
        let c = get_character(core, id)?.ok_or("A cast character no longer exists")?;
        if c.vault && !story.vault {
            return Err("A General story can't use a vault character. Create the story as a vault story.".into());
        }
        cast.push(c);
    }
    match validate::duplicate_cast_name(&cast) {
        Some(m) => Err(m),
        None => Ok(()),
    }
}
