//! SQLite persistence for characters, stories and shots.

use rusqlite::{params, OptionalExtension};

use crate::db::Db;
use crate::stories::{Character, Shot, Story};

fn e(err: rusqlite::Error) -> String {
    format!("Database error: {err}")
}

fn to_json<T: serde::Serialize>(v: &T) -> String {
    serde_json::to_string(v).unwrap()
}

fn from_json<T: serde::de::DeserializeOwned + Default>(s: &str) -> T {
    serde_json::from_str(s).unwrap_or_default()
}

fn u32_col(row: &rusqlite::Row, col: &str) -> rusqlite::Result<u32> {
    let v: i64 = row.get(col)?;
    Ok(v.clamp(0, u32::MAX as i64) as u32)
}

// ----- characters -----

fn row_to_character(row: &rusqlite::Row) -> rusqlite::Result<Character> {
    let refs: String = row.get("refs_json")?;
    Ok(Character {
        id: row.get("id")?,
        name: row.get("name")?,
        description: row.get("description")?,
        source: row.get("source")?,
        consent: row.get("consent")?,
        adult: row.get("adult")?,
        ref_ids: from_json(&refs),
        created_at: row.get("created_at")?,
        updated_at: row.get("updated_at")?,
    })
}

/// All characters, by name.
pub fn list_characters(db: &Db) -> Result<Vec<Character>, String> {
    let mut st = db
        .conn()
        .prepare("SELECT * FROM characters ORDER BY name COLLATE NOCASE")
        .map_err(e)?;
    let rows = st.query_map([], row_to_character).map_err(e)?;
    rows.collect::<Result<_, _>>().map_err(e)
}

pub fn get_character(db: &Db, id: &str) -> Result<Option<Character>, String> {
    db.conn()
        .query_row("SELECT * FROM characters WHERE id = ?1", [id], row_to_character)
        .optional()
        .map_err(e)
}

/// Inserts, or updates the character with the same id. Names are unique
/// (case-insensitive).
pub fn save_character(db: &Db, c: &Character) -> Result<(), String> {
    db.conn()
        .execute(
            "INSERT INTO characters (id, name, description, source, consent, adult, refs_json, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
             ON CONFLICT(id) DO UPDATE SET name = excluded.name, description = excluded.description,
               source = excluded.source, consent = excluded.consent, adult = excluded.adult,
               refs_json = excluded.refs_json, updated_at = excluded.updated_at",
            params![
                c.id,
                c.name,
                c.description,
                c.source,
                c.consent,
                c.adult,
                to_json(&c.ref_ids),
                c.created_at,
                c.updated_at
            ],
        )
        .map_err(|err| match err {
            rusqlite::Error::SqliteFailure(f, Some(msg))
                if f.code == rusqlite::ErrorCode::ConstraintViolation
                    && msg.contains("UNIQUE")
                    && msg.contains("characters.name") =>
            {
                format!("A character named {} already exists", c.name)
            }
            other => e(other),
        })?;
    Ok(())
}

/// Refused while any story's cast contains the character.
pub fn delete_character(db: &Db, id: &str) -> Result<(), String> {
    if let Some(s) = list_stories(db)?.into_iter().find(|s| s.cast.iter().any(|c| c == id)) {
        let name = get_character(db, id)?.map(|c| c.name).unwrap_or_else(|| id.to_string());
        return Err(format!("{name} is used by story \"{}\"", s.title));
    }
    db.conn()
        .execute("DELETE FROM characters WHERE id = ?1", [id])
        .map_err(e)?;
    Ok(())
}

// ----- stories -----

fn row_to_story(row: &rusqlite::Row) -> rusqlite::Result<Story> {
    let cast: String = row.get("cast_json")?;
    Ok(Story {
        id: row.get("id")?,
        title: row.get("title")?,
        logline: row.get("logline")?,
        brief: row.get("brief")?,
        target_s: u32_col(row, "target_s")?,
        aspect: row.get("aspect")?,
        style: row.get("style")?,
        cast: from_json(&cast),
        status: row.get("status")?,
        result_image_id: row.get("result_image_id")?,
        created_at: row.get("created_at")?,
        updated_at: row.get("updated_at")?,
    })
}

/// All stories, most recently updated first.
pub fn list_stories(db: &Db) -> Result<Vec<Story>, String> {
    let mut st = db
        .conn()
        .prepare("SELECT * FROM stories ORDER BY updated_at DESC, created_at DESC")
        .map_err(e)?;
    let rows = st.query_map([], row_to_story).map_err(e)?;
    rows.collect::<Result<_, _>>().map_err(e)
}

pub fn get_story(db: &Db, id: &str) -> Result<Option<Story>, String> {
    db.conn()
        .query_row("SELECT * FROM stories WHERE id = ?1", [id], row_to_story)
        .optional()
        .map_err(e)
}

/// Inserts, or updates the story with the same id (its sidecar is kept).
pub fn save_story(db: &Db, s: &Story) -> Result<(), String> {
    db.conn()
        .execute(
            "INSERT INTO stories (id, title, logline, brief, target_s, aspect, style, cast_json, status, result_image_id, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)
             ON CONFLICT(id) DO UPDATE SET title = excluded.title, logline = excluded.logline,
               brief = excluded.brief, target_s = excluded.target_s, aspect = excluded.aspect,
               style = excluded.style, cast_json = excluded.cast_json, status = excluded.status,
               result_image_id = excluded.result_image_id, updated_at = excluded.updated_at",
            params![
                s.id,
                s.title,
                s.logline,
                s.brief,
                s.target_s,
                s.aspect,
                s.style,
                to_json(&s.cast),
                s.status,
                s.result_image_id,
                s.created_at,
                s.updated_at
            ],
        )
        .map_err(e)?;
    Ok(())
}

/// Deletes the story and its shots (takes and result records are the caller's).
pub fn delete_story(db: &Db, id: &str) -> Result<(), String> {
    let tx = db.conn().unchecked_transaction().map_err(e)?;
    tx.execute("DELETE FROM shots WHERE story_id = ?1", [id]).map_err(e)?;
    tx.execute("DELETE FROM stories WHERE id = ?1", [id]).map_err(e)?;
    tx.commit().map_err(e)
}

/// Records the assembled video and its sidecar; the story becomes "assembled".
pub fn set_result(db: &Db, story_id: &str, image_id: &str, sidecar_json: &str) -> Result<(), String> {
    db.conn()
        .execute(
            "UPDATE stories SET result_image_id = ?2, sidecar_json = ?3, status = 'assembled' WHERE id = ?1",
            params![story_id, image_id, sidecar_json],
        )
        .map_err(e)?;
    Ok(())
}

// ----- shots -----

fn row_to_shot(row: &rusqlite::Row) -> rusqlite::Result<Shot> {
    let chars: String = row.get("characters_json")?;
    let dialogue: String = row.get("dialogue_json")?;
    Ok(Shot {
        id: row.get("id")?,
        story_id: row.get("story_id")?,
        position: u32_col(row, "position")?,
        duration_s: u32_col(row, "duration_s")?,
        characters: from_json(&chars),
        setting: row.get("setting")?,
        camera: row.get("camera")?,
        action: row.get("action")?,
        dialogue: from_json(&dialogue),
        continuity: row.get("continuity")?,
        approved_take_id: row.get("approved_take_id")?,
    })
}

const INSERT_SHOT: &str = "INSERT INTO shots (id, story_id, position, duration_s, characters_json, setting, camera, action, dialogue_json, continuity, approved_take_id)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)";

/// A story's shots, by position.
pub fn list_shots(db: &Db, story_id: &str) -> Result<Vec<Shot>, String> {
    let mut st = db
        .conn()
        .prepare("SELECT * FROM shots WHERE story_id = ?1 ORDER BY position")
        .map_err(e)?;
    let rows = st.query_map([story_id], row_to_shot).map_err(e)?;
    rows.collect::<Result<_, _>>().map_err(e)
}

pub fn get_shot(db: &Db, id: &str) -> Result<Option<Shot>, String> {
    db.conn()
        .query_row("SELECT * FROM shots WHERE id = ?1", [id], row_to_shot)
        .optional()
        .map_err(e)
}

/// Replaces all of a story's shots (one transaction). Each shot is stored
/// under `story_id`.
pub fn replace_shots(db: &Db, story_id: &str, shots: &[Shot]) -> Result<(), String> {
    let tx = db.conn().unchecked_transaction().map_err(e)?;
    tx.execute("DELETE FROM shots WHERE story_id = ?1", [story_id])
        .map_err(e)?;
    for s in shots {
        tx.execute(
            INSERT_SHOT,
            params![
                s.id,
                story_id,
                s.position,
                s.duration_s,
                to_json(&s.characters),
                s.setting,
                s.camera,
                s.action,
                to_json(&s.dialogue),
                s.continuity,
                s.approved_take_id
            ],
        )
        .map_err(e)?;
    }
    tx.commit().map_err(e)
}

/// Updates an existing shot's fields (by id).
pub fn update_shot(db: &Db, s: &Shot) -> Result<(), String> {
    let n = db
        .conn()
        .execute(
            "UPDATE shots SET story_id = ?2, position = ?3, duration_s = ?4, characters_json = ?5,
               setting = ?6, camera = ?7, action = ?8, dialogue_json = ?9, continuity = ?10,
               approved_take_id = ?11
             WHERE id = ?1",
            params![
                s.id,
                s.story_id,
                s.position,
                s.duration_s,
                to_json(&s.characters),
                s.setting,
                s.camera,
                s.action,
                to_json(&s.dialogue),
                s.continuity,
                s.approved_take_id
            ],
        )
        .map_err(e)?;
    if n == 0 {
        return Err("That shot no longer exists".into());
    }
    Ok(())
}

pub fn set_approved(db: &Db, shot_id: &str, take_id: Option<&str>) -> Result<(), String> {
    db.conn()
        .execute(
            "UPDATE shots SET approved_take_id = ?2 WHERE id = ?1",
            params![shot_id, take_id],
        )
        .map_err(e)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::Db;
    use crate::stories::{Character, DialogueLine, Shot, Story};

    fn ch(id: &str, name: &str) -> Character {
        Character {
            id: id.into(),
            name: name.into(),
            description: "adult woman".into(),
            source: "generated".into(),
            consent: false,
            adult: true,
            ref_ids: vec!["r1".into()],
            created_at: "t".into(),
            updated_at: "t".into(),
        }
    }
    fn story(id: &str, cast: &[&str]) -> Story {
        Story {
            id: id.into(),
            title: "T".into(),
            logline: String::new(),
            brief: "b".into(),
            target_s: 60,
            aspect: "16:9".into(),
            style: String::new(),
            cast: cast.iter().map(|s| s.to_string()).collect(),
            status: "draft".into(),
            result_image_id: None,
            created_at: "t".into(),
            updated_at: "t".into(),
        }
    }
    fn shot(id: &str, story: &str, pos: u32) -> Shot {
        Shot {
            id: id.into(),
            story_id: story.into(),
            position: pos,
            duration_s: 8,
            characters: vec!["c1".into()],
            setting: "roof".into(),
            camera: "wide".into(),
            action: "walks".into(),
            dialogue: vec![DialogueLine {
                speaker: "c1".into(),
                line: "Hi".into(),
            }],
            continuity: "cut".into(),
            approved_take_id: None,
        }
    }

    #[test]
    fn characters_round_trip_and_unique_name() {
        let db = Db::open_in_memory().unwrap();
        save_character(&db, &ch("c1", "Mara")).unwrap();
        assert_eq!(get_character(&db, "c1").unwrap().unwrap().name, "Mara");
        let e = save_character(&db, &ch("c2", "mara")).unwrap_err();
        assert!(e.contains("already exists"), "{e}");
    }

    #[test]
    fn delete_character_in_use_is_refused() {
        let db = Db::open_in_memory().unwrap();
        save_character(&db, &ch("c1", "Mara")).unwrap();
        save_story(&db, &story("s1", &["c1"])).unwrap();
        let e = delete_character(&db, "c1").unwrap_err();
        assert!(e.contains("Mara") && e.contains("\"T\""), "{e}");
    }

    #[test]
    fn shots_replace_order_and_approve() {
        let db = Db::open_in_memory().unwrap();
        save_story(&db, &story("s1", &[])).unwrap();
        replace_shots(&db, "s1", &[shot("b", "s1", 2), shot("a", "s1", 1)]).unwrap();
        let ids: Vec<_> = list_shots(&db, "s1").unwrap().into_iter().map(|s| s.id).collect();
        assert_eq!(ids, vec!["a", "b"]);
        set_approved(&db, "a", Some("take1")).unwrap();
        assert_eq!(
            get_shot(&db, "a").unwrap().unwrap().approved_take_id.as_deref(),
            Some("take1")
        );
        delete_story(&db, "s1").unwrap();
        assert!(list_shots(&db, "s1").unwrap().is_empty());
    }

    #[test]
    fn updates_and_result() {
        let db = Db::open_in_memory().unwrap();
        save_character(&db, &ch("c1", "Mara")).unwrap();
        let mut c = ch("c1", "Mara");
        c.description = "changed".into();
        save_character(&db, &c).unwrap();
        assert_eq!(list_characters(&db).unwrap(), vec![c]);
        delete_character(&db, "c1").unwrap();
        assert!(get_character(&db, "c1").unwrap().is_none());

        save_story(&db, &story("s1", &[])).unwrap();
        set_result(&db, "s1", "img1", "{}").unwrap();
        let s = get_story(&db, "s1").unwrap().unwrap();
        assert_eq!((s.status.as_str(), s.result_image_id.as_deref()), ("assembled", Some("img1")));
        assert_eq!(list_stories(&db).unwrap(), vec![s]);

        replace_shots(&db, "s1", &[shot("a", "s1", 1)]).unwrap();
        let mut a = shot("a", "s1", 1);
        a.action = "runs".into();
        update_shot(&db, &a).unwrap();
        assert_eq!(get_shot(&db, "a").unwrap(), Some(a));
        assert!(update_shot(&db, &shot("zz", "s1", 2)).is_err());
    }
}
