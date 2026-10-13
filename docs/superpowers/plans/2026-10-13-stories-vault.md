# Stories: vault stories, film in the workspace, edit character, shot order — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Tasks 1–4 are independent: run them in parallel worktrees (superpowers:using-git-worktrees), one task per worktree, and merge before Task 5.

**Goal:** (A) a character and a story can be *Vault*: everything about a vault story — character references and text, story text, shots, takes, final film — is sealed in the existing vault, visible and renderable only while unlocked, with running renders still saving sealed when it locks; (B) no story take or film in the Image/Video galleries (General or vault) — the Stories workspace plays the film and offers Show in Finder / Export; (C) edit a character (pencil on cast chips and the cast menu) with prefilled form and replaceable references; (D) shots queued together are submitted to the GPU worker in shot-position order.

**Architecture:** Vault characters and stories are sealed JSON records (`vault/characters/<id>.bin`, `vault/stories/<id>.bin` = story + shots), cached in `Vault`'s unlocked state next to items; takes and films are ordinary vault items with `story_id/shot_id`. A new router `stories/repo.rs` offers the `store.rs` verbs over both stores (SQLite first, then the vault) and is the only code that knows where a story lives; `render.rs`/`commands.rs` call it instead of `store.rs`. ffmpeg never gets a plaintext path: inputs go through anonymous pipes (`pipe:3…`), output comes back on stdout as fragmented MP4, one code path for both stores. Submission order is a per-profile ticket taken at queue time and honoured before the first `/run`.

**Tech Stack:** Rust (Tauri 2, rusqlite, tokio, `libc` for pipes, `image` for PNG), React + TypeScript (Vite), ffmpeg 8.1 (Homebrew) on the Mac. No worker (Python) changes.

**Spec:** `docs/superpowers/specs/2026-10-13-stories-vault-design.md` (read it first; every decision below cites it). Vault rules: `app/src-tauri/src/vault.rs:1-43`, `docs/vault-contract.md`.

## Global Constraints

- **No plaintext of a vault story ever touches disk**: no temp files, no FIFOs, no `stories-tmp/`. The only writers of story media are `vault_migrate::seal_output` (vault) and `videos/` writes for General records. Grep gate at the end of every task that touches `stories/`: `grep -n "std::fs::write\|stories-tmp\|tempfile" app/src-tauri/src/stories/` must show only General-store writes in `render.rs`.
- **Nothing secret while locked**: `list_stories`/`list_characters` return General only; `get_story` of a vault story returns `VAULT_LOCKED: …`; job labels of vault stories are `Vault story · shot N`; `alog!` never logs a title, brief, prompt or shot text.
- **Writes to vault characters/stories need the unlocked vault**; sealing a finished take/film (`put_item`) works locked (public key only).
- **Rules** (spec §3.9): a General story never casts a vault character; a story's store is fixed; cast names differ; a vault character's refs are vault blobs; deleting a General character with the vault locked is refused.
- **Galleries**: `Db::list_images` → `story_id IS NULL`; `Vault::gallery_items()` and `item_count` exclude `story_id.is_some()`; the UI drops `job-update` outputs with `storyId`.
- **ffmpeg**: `-nostdin -hide_banner -loglevel error`; inputs `pipe:3+i`; output `-f mp4 -movflags frag_keyframe+empty_moov+default_base_moof pipe:1`; last frame via `-f rawvideo -pix_fmt rgb24 pipe:1` keeping the last `w*h*3` bytes; the worker's MP4s are moov-first (asserted by a test).
- **Blob GC**: a vault blob is deleted only when no item *and* no character references it.
- **Tickets** are released on every exit path (guard `Drop`); per profile.
- Error codes stay string prefixes (`VAULT_LOCKED`, `NO_VAULT`); copy from spec §8 verbatim.
- Commands after each task: `cd app/src-tauri && cargo test`, `cargo clippy --all-targets -- -D warnings`, `cd app && npx tsc --noEmit && npm run build`. No worker tests (worker untouched).
- Keep it simple ("consistent video creator first"): no store moves, no new settings, no new dialogs beyond the lock screen and the Save-to control.

## Review Focus

1. **Plaintext on disk**: any `std::fs::write`, `tempfile`, `mkfifo`, `create_dir_all("…tmp")` reachable from a vault story. → Task 4 test `assemble_writes_no_files`, Task 7 test `vault_story_leaves_no_plaintext_on_disk`.
2. **Leaks while locked**: titles in job labels or logs; `list_stories` while locked; `VaultStatus.item_count`. → Task 6 tests `vault_story_invisible_while_locked`, `vault_story_job_label_has_no_title`.
3. **Blob GC deleting a take's reference** (character edit removes an image a take still references). → Task 5 test `character_blob_gc_keeps_blobs_used_by_items`.
4. **Ticket never released** (pod start fails, cancel before submit) → every job behind it hangs. → Task 3 tests `dropped_ticket_unblocks_the_next`, `failed_pod_start_releases_ticket`.
5. **General story with a vault character** slipping in through `update_story` (cast patch) or through editing a General character into the vault. → Task 6 test `general_story_rejects_vault_character_on_create_and_update`.
6. **Film still reachable from a gallery** (`list_images`, `list_vault_items`, live `job-update`, the Lightbox "Open" from the old toast). → Task 1 tests `list_images_hides_takes_and_films`, `vault_gallery_hides_story_items`, and the mock walk.

---

## File Structure

**Rust (`app/src-tauri/src/`)**
- Modify `db.rs` — `list_images` filter; test.
- Modify `vault.rs` — `VaultItem.story_id/shot_id`; `gallery_items`; `item_count`; `Unlocked.characters/stories`; sealed-record helpers; character/story-doc methods; GC; tests.
- Modify `stories/mod.rs` — `Character.vault/ref_paths`, `Story.vault`, `StoryDoc`, `StoryView.result`.
- Create `stories/repo.rs` — router over SQLite + vault; rules; `ref_paths`.
- Modify `stories/store.rs` — none in shape (`vault: false` set when reading rows).
- Modify `stories/ffmpeg.rs` — rewrite to bytes in / bytes out over pipes.
- Modify `stories/render.rs` — call `repo`; `take_bytes`; continues frame + assembly from bytes; vault sealing; labels; `result` in the view.
- Modify `jobs.rs` — `SubmitGate`/`Ticket`; `save_video` orphan check for locked vault stories.
- Modify `state.rs` — `Core.submit_gate`.
- Modify `commands.rs` — `create_story(destination)`, `reveal_image`, `list_vault_items` filter, `delete_vault_item` clears story refs, character commands via `repo`.
- Modify `lib.rs` — register `reveal_image`.
- Modify `vault_migrate.rs` — `ERR_STORY_MEDIA` copy; `seal_output` keeps `story_id/shot_id`.
- Modify `Cargo.toml` — `libc = "0.2"`.
- Tests: `tests/jobs.rs`, `tests/vault.rs`, `tests/stories.rs`.

**Frontend (`app/src/`)**
- Modify `api/types.ts`, `api/index.ts`, `api/mock.ts`.
- Modify `components/Icon.tsx` — `edit` icon.
- Modify `screens/create/CreateScreen.tsx` — job-update filter; no gallery refresh on story changes.
- Modify `screens/create/stories/StoryWorkspace.tsx` — Final film section; lock screen.
- Modify `screens/create/stories/StoriesPanel.tsx` — Save-to; lock marks; pencil; menu Edit; reload on lock.
- Modify `screens/create/stories/CharacterForm.tsx` — edit mode; vault toggle.
- Modify `screens/create/stories/stories.css`, `workspace.css` — small additions.

**Docs**
- Modify `docs/vault-contract.md` (new commands/fields), `docs/superpowers/specs/2026-10-13-stories-design.md` (§3 "v1 general only" note → points here).

## Dependency graph

| Task | Depends on | Shares files with | Worktree group |
|---|---|---|---|
| 1 Galleries hide story rows + Final film section (B) | — | 2 (`commands.rs`, `types.ts`, `mock.ts`, minor), 4 (`render.rs::story_view` vs `render_shot/assemble_story`) | **Group 1 (parallel)** |
| 2 Edit character (C) | — | 1 (as above) | **Group 1** |
| 3 Shot submission order (D) | — | none | **Group 1** |
| 4 ffmpeg over pipes (both stores) | — | 1 (`render.rs`, different functions) | **Group 1** |
| 5 Vault sealed characters/stories + GC | 1 (`VaultItem.story_id`) | — | Group 2 |
| 6 `repo.rs` router, rules, locked behaviour, labels | 1, 2, 5 | `render.rs`, `commands.rs` (sequential) | Group 2 |
| 7 Vault render path (refs, first frame, takes, film, export, delete) | 4, 5, 6 | `render.rs`, `jobs.rs` | Group 2 |
| 8 Frontend vault stories | 6, 7 (API shape); UI-only parts can start after 6 | `StoriesPanel`, `CharacterForm`, `StoryWorkspace`, `mock.ts` | Group 2 |
| 9 Docs, mock walk, real run | all | docs | Last |

Merge order after Group 1: 3, 4, 2, 1 (1 last because it touches the most shared files; resolve the two `render.rs` hunks by keeping both).

---

### Task 1: Galleries hide every story row; the workspace shows the final film (B)

**Files:**
- Modify: `app/src-tauri/src/db.rs:342-368, 849-866`
- Modify: `app/src-tauri/src/vault.rs:225-320, 747-756` (`VaultItem.story_id/shot_id`, `to_record`, `gallery_items`, `status`)
- Modify: `app/src-tauri/src/vault_migrate.rs:19-20, 163-195` (message; `item_from_record` keeps story ids — it copies `rec` fields, add the two)
- Modify: `app/src-tauri/src/stories/mod.rs:110-118` (`StoryView.result`), `stories/render.rs:27-48` (fill it)
- Modify: `app/src-tauri/src/commands.rs:636-649, 751-756` (`reveal_image`, `list_vault_items`), `lib.rs:288-351` (register)
- Modify: `app/src/api/types.ts:614-620`, `api/index.ts:236-251`, `api/mock.ts` (`list_images`, `list_vault_items`, `reveal_image`, `storyView`)
- Modify: `app/src/screens/create/CreateScreen.tsx:796-815, 1510-1523`, `screens/create/stories/StoryWorkspace.tsx:560-592, 785-792`, `workspace.css`

**Interfaces:**
- Produces (Rust): `Vault::gallery_items() -> Result<Vec<VaultItem>, String>`; `VaultItem { story_id: Option<String>, shot_id: Option<String> }`; `StoryView.result: Option<ImageRecord>`; command `reveal_image { id } -> ()` (General only; vault id → error "Vault films are exported, not shown in Finder").
- Produces (TS): `StoryView.result: ImageRecord | null`; `api.revealImage(id)`.
- Consumes: `tauri_plugin_opener::reveal_item_in_dir` (as `commands.rs:81-86`), `api.pickSavePath`, `api.exportImage` (falls through to the vault export, `commands.rs:638-649`).

- [ ] **Step 1: Failing Rust tests**

`db.rs` — replace `list_images_hides_story_takes` (`db.rs:849-866`):

```rust
#[test]
fn list_images_hides_takes_and_films() {
    let db = Db::open_in_memory().unwrap();
    let mut take = img("take", 1);
    take.story_id = Some("s1".into());
    take.shot_id = Some("sh1".into());
    let mut film = img("film", 2);
    film.story_id = Some("s1".into());
    db.insert_image(&img("plain", 3)).unwrap();
    db.insert_image(&take).unwrap();
    db.insert_image(&film).unwrap();
    let (list, _) = db.list_images(100, None).unwrap();
    assert_eq!(list.iter().map(|r| r.id.as_str()).collect::<Vec<_>>(), vec!["plain"]);
    assert_eq!(db.list_takes("s1").unwrap().len(), 1, "takes still reachable");
    assert_eq!(db.get_image("film").unwrap().unwrap().story_id.as_deref(), Some("s1"));
}
```

`vault.rs` tests module:

```rust
#[test]
fn vault_gallery_hides_story_items_but_counts_them_internally() {
    let (_d, v) = vault();
    v.create(PW, KdfParams::fast()).unwrap();
    let plain = sample_item(&v.seal_blob(b"\0\0\0\x18ftypisom", "mp4").unwrap());
    let mut take = sample_item(&v.seal_blob(b"\0\0\0\x18ftypisom", "mp4").unwrap());
    take.story_id = Some("s1".into());
    take.shot_id = Some("sh1".into());
    let mut film = sample_item(&v.seal_blob(b"\0\0\0\x18ftypisom", "mp4").unwrap());
    film.story_id = Some("s1".into());
    for i in [&plain, &take, &film] { v.put_item(i).unwrap(); }
    let gallery: Vec<String> = v.gallery_items().unwrap().into_iter().map(|i| i.id).collect();
    assert_eq!(gallery, vec![plain.id.clone()]);
    assert_eq!(v.items().unwrap().len(), 3);
    assert_eq!(v.status().item_count, Some(1));
    let rec = v.item(&take.id).unwrap().to_record();
    assert_eq!((rec.story_id.as_deref(), rec.shot_id.as_deref()), (Some("s1"), Some("sh1")));
    // Records sealed before this change (no story fields) still load.
    v.lock(); v.unlock(PW).unwrap();
    assert_eq!(v.items().unwrap().len(), 3);
}
```

- [ ] **Step 2: Run** `cd app/src-tauri && cargo test list_images_hides_takes_and_films vault_gallery_hides` — FAIL (no `story_id` on `VaultItem`, no `gallery_items`).
- [ ] **Step 3: Implement**

`db.rs:350`: `"SELECT * FROM images WHERE seq < ?1 AND story_id IS NULL ORDER BY seq DESC LIMIT ?2"`.

`vault.rs` — `VaultItem` gains, after `added_at`:

```rust
    /// Stories: set on takes (with `shot_id`) and on the assembled film; such
    /// items are listed inside their story only, never in the vault gallery.
    #[serde(default)]
    pub story_id: Option<String>,
    #[serde(default)]
    pub shot_id: Option<String>,
```

`to_record`: `story_id: self.story_id.clone(), shot_id: self.shot_id.clone()`. `item_from_record` (`vault.rs:1343`): `story_id: rec.story_id.clone(), shot_id: rec.shot_id.clone()`. Add:

```rust
    /// Decrypted items for the gallery: story takes and films are left out
    /// (they belong to their story's workspace). Newest first.
    pub fn gallery_items(&self) -> Result<Vec<VaultItem>, String> {
        Ok(self.items()?.into_iter().filter(|i| i.story_id.is_none()).collect())
    }
```

`status()`: `item_count: unlocked.as_ref().map(|u| u.items.values().filter(|i| i.story_id.is_none()).count())`. Fix the test `sample_item` and every `VaultItem { … }` literal (`story_id: None, shot_id: None`).

`vault_migrate.rs:20`: `const ERR_STORY_MEDIA: &str = "Story videos are managed from the Stories tab";`.

`commands.rs:753`: `Ok(core.vault.gallery_items()?.iter().map(|i| i.to_record()).collect())`. Add:

```rust
/// Shows a General record's file in Finder. Vault items are exported instead.
#[tauri::command]
pub fn reveal_image(core: CoreState<'_>, id: String) -> Res<()> {
    let rec = core.db.lock().unwrap().get_image(&id)?;
    let Some(rec) = rec else {
        return Err("Vault films are exported, not shown in Finder".into());
    };
    tauri_plugin_opener::reveal_item_in_dir(&rec.path).map_err(|e| format!("Couldn't show the file: {e}"))
}
```

`stories/mod.rs` `StoryView`: `pub result: Option<ImageRecord>` (after `takes`). `render.rs::story_view`: `let result = match story.result_image_id.as_deref() { Some(id) => db.get_image(id)?, None => None };` inside the db block; `Ok(StoryView { story, cast, shots, takes, result, issues })`. (Task 6 moves this to `repo::get_take`.)

TS: `types.ts` `StoryView` gains `result: ImageRecord | null;`; `index.ts`: `export const revealImage = (id: string) => call<void>("reveal_image", { id });`. Mock: `list_images` already excludes takes (`takes` array, `mock.ts:1378`); make `assemble_story` push the film into a `films: ImageRecord[]` list (not `images`), `storyView` returns `result: films.find(f => f.id === story.resultImageId) ?? null`, `reveal_image: () => undefined`, and `export_image` accepts a film id.

`CreateScreen.tsx:810`: `const outputs = payload.images.filter((r) => !r.shotId && !r.storyId);`. In the `<StoryWorkspace onChanged>` handler drop `void refreshGalleryTop();` (keep `setStoryEpoch`).

`StoryWorkspace.tsx`: delete `openResult` (560-570); add `const id = useId();` to `Workspace` (it has none yet); replace the "Assembled" notice (785-792) with:

```tsx
{view.result && (
  <section className="story-film" aria-labelledby={`${id}-film`}>
    <h3 id={`${id}-film`} className="story-film__title"><Icon name="layers" size={14} /> Final film</h3>
    <video className="story-film__player" controls playsInline preload="metadata"
      src={fileSrc(view.result.path)} poster={view.result.posterPath ? fileSrc(view.result.posterPath) : undefined} />
    <div className="story-film__actions">
      {!view.result.vault && (
        <button type="button" className="btn btn--sm" onClick={() => void api.revealImage(view.result!.id).catch((e) => toast.error("Couldn't show the film", e))}>
          Show in Finder
        </button>
      )}
      <button type="button" className="btn btn--sm" onClick={() => void exportFilm()}
        title={view.result.vault ? "Vault films are exported as an unencrypted copy" : undefined}>
        <Icon name="download" size={14} /> Export…
      </button>
      {view.result.vault && <span className="hint">Encrypted in the vault.</span>}
    </div>
  </section>
)}
```

with

```tsx
const exportFilm = async () => {
  const film = view?.result;
  if (!film) return;
  if (film.vault && !window.confirm("The exported copy is not encrypted — anyone with access to where you save it can open it. Export?")) return;
  try {
    const dest = await api.pickSavePath(`${(story?.title || "story").replace(/[\\/:]/g, "-")}.mp4`);
    if (!dest) return;
    await api.exportImage({ id: film.id, destPath: dest });
    toast.success(film.vault ? "Film exported — not encrypted" : "Film exported", dest);
  } catch (e) {
    toast.error("Couldn't export the film", e);
  }
};
```

(The Lightbox uses an inline confirm panel, `Lightbox.tsx:688-730`; a `window.confirm` here keeps Task 1 small — Task 8 may swap it for the same inline pattern.) The assemble toast becomes `title: "Film assembled"` with no "Open" action. Add `.story-film` styles to `workspace.css` (player `max-height: 360px; width: 100%; background: #000; border-radius: var(--radius)`).

- [ ] **Step 4: Run** `cd app/src-tauri && cargo test && cargo clippy --all-targets -- -D warnings && cd ../ && npx tsc --noEmit && npm run build` — PASS. Mock walk: assemble a story → the film plays in the workspace, Export saves, the Image/Video tabs show no story rows.
- [ ] **Step 5: Commit** `git commit -am "Stories: story takes and films live in the workspace only; final film player, Show in Finder, Export"`

---

### Task 2: Edit character (C)

**Files:**
- Modify: `app/src-tauri/src/stories/mod.rs:11-24` (`Character.ref_paths`), `stories/render.rs` (new `with_ref_paths`), `commands.rs:841-871`
- Modify: `app/src/api/types.ts:552-562`, `api/mock.ts:1680-1706`
- Modify: `app/src/components/Icon.tsx` (`edit` path), `screens/create/stories/CharacterForm.tsx`, `screens/create/stories/StoriesPanel.tsx:218-260, 431-516`, `stories.css`

**Interfaces:**
- Produces: `Character.ref_paths: Vec<String>` (read-only; General: `references/<id>.<ext>`, missing file → `""`); `CharacterForm` prop `character?: Character | null`; `StoriesPanel` → `onEditCharacter(c)`.
- Consumes: `references::find` (`references.rs:119`), `store::save_character` upsert (`store.rs:98`, keeps `created_at` via `commands.rs:858-862`).

- [ ] **Step 1: Failing Rust test** (`tests/stories.rs`)

```rust
#[test]
fn characters_list_with_display_paths_and_edits_keep_id() {
    let dir = tempfile::tempdir().unwrap();
    let refs = dir.path().join("references");
    let r = app_lib::references::import_bytes(&refs, &png_bytes()).unwrap(); // helper: a 10×10 PNG, as in references.rs tests
    let db = app_lib::db::Db::open_in_memory().unwrap();
    let c = Character { id: "c1".into(), name: "Mara".into(), ref_ids: vec![r.ref_id.clone()], ..mara() };
    app_lib::stories::store::save_character(&db, &c).unwrap();
    let listed = app_lib::stories::render::with_ref_paths(&refs, app_lib::stories::store::list_characters(&db).unwrap());
    assert_eq!(listed[0].ref_paths, vec![r.thumb_path.clone()]);
    let mut edited = listed[0].clone();
    edited.name = "Mara K".into();
    edited.ref_ids = vec![];
    assert!(app_lib::stories::store::check_character(&edited).is_err(), "still needs a reference");
    edited.ref_ids = vec![r.ref_id.clone()];
    app_lib::stories::store::save_character(&db, &edited).unwrap();
    let back = app_lib::stories::store::get_character(&db, "c1").unwrap().unwrap();
    assert_eq!((back.name.as_str(), back.created_at.as_str()), ("Mara K", "t"));
}
```

- [ ] **Step 2: Run** `cargo test characters_list_with_display_paths` — FAIL.
- [ ] **Step 3: Implement**

`stories/mod.rs` `Character`: add `#[serde(default)] pub ref_paths: Vec<String>` (doc: display paths, filled when read, ignored when saved). `render.rs`:

```rust
/// Display paths for the UI next to each `ref_ids` entry: the `references/`
/// file for a General character ("" when it is gone). Vault paths are their own display path.
pub fn with_ref_paths(refs_dir: &Path, cs: Vec<Character>) -> Vec<Character> {
    cs.into_iter().map(|mut c| {
        c.ref_paths = c.ref_ids.iter().map(|id| {
            if crate::vault::is_vault_path(id) { id.clone() }
            else { crate::references::find(refs_dir, id).map(|p| p.to_string_lossy().into_owned()).unwrap_or_default() }
        }).collect();
        c
    }).collect()
}
```

`commands.rs::list_characters`: `Ok(render::with_ref_paths(&core.cfg.references_dir(), stories::store::list_characters(&db)?))`; `save_character` returns the saved character through `with_ref_paths` too and clears `c.ref_paths` before `check_character`/save (not stored).

`Icon.tsx`: `edit: "M12.5 3.5l4 4L7 17H3v-4L12.5 3.5z"` (16-px grid like the others).

`CharacterForm.tsx`: props `{ open, character, onClose, onSaved }`; the reset effect (lines 47-56) seeds from `character` when given: `setName(character.name)`, …, `setRefs(character.refIds.map((refId, i) => ({ refId, thumbPath: character.refPaths[i] || refId })))`; title `character ? "Edit character" : "New character"`; button "Save changes"; `save` sends `id: character?.id ?? ""`, `createdAt: character?.createdAt ?? ""`. Nothing else changes: remove/add/replace already work on `refs`.

`StoriesPanel.tsx`: state `const [editing, setEditing] = useState<Character | null>(null)`; chip (434-440) gains before the ✕:

```tsx
<button type="button" className="chip__x" aria-label={`Edit ${c.name}`} title="Edit character" onClick={() => { setEditing(c); setFormOpen(true); }}>
  <Icon name="edit" size={12} />
</button>
```

menu rows (478-492) become a row with the name button plus a trailing `icon-btn` "Edit" (`role="menuitem"`, closes the menu, opens the form). `<CharacterForm character={editing} … onSaved={(c) => { setCharacters(cs => cs.some(x => x.id === c.id) ? cs.map(x => x.id === c.id ? c : x) : [...cs, c]); if (!editing) addToCast(c.id); setEditing(null); setFormOpen(false); onSavedRef.current?.(); }} onClose={() => { setEditing(null); setFormOpen(false); }} />`. `onSaved` bumps the panel epoch so the workspace reloads the cast (the next render compiles with the new references; existing takes keep their recorded reference paths).

Mock `save_character` (`mock.ts:1682-1700`) already upserts by id; add `refPaths: saved.refIds` to the returned object and to `list_characters`.

- [ ] **Step 4: Run** `cd app/src-tauri && cargo test && cargo clippy --all-targets -- -D warnings && cd ../ && npx tsc --noEmit && npm run build` — PASS. Mock walk: edit Mara → rename, replace an image → the chip updates, the story still lists her; Render shot → job prompt cites the new picture count.
- [ ] **Step 5: Commit** `git commit -am "Stories: edit character (name, description, references, consent) from the cast"`

---

### Task 3: Shot submission order — per-profile tickets (D)

**Files:**
- Modify: `app/src-tauri/src/jobs.rs:236-245 (Plan), 814-881 (start_job), 1177-1219 (run_job)`
- Modify: `app/src-tauri/src/state.rs:93-141` (`Core.submit_gate`)
- Test: `app/src-tauri/src/jobs.rs` (unit), `app/src-tauri/tests/jobs.rs`

**Interfaces:**
- Produces: `pub struct SubmitGate`, `pub struct Ticket` (`SubmitGate::take(&self: Arc, profile) -> Ticket`, `Ticket::wait_turn(&self).await`, release on drop); `Core.submit_gate: Arc<SubmitGate>`.
- Consumes: `Profile` (`pod.rs`), `tokio::sync::Notify`.

- [ ] **Step 1: Failing unit tests** (`jobs.rs` tests module)

```rust
#[tokio::test]
async fn tickets_submit_in_queue_order_whatever_the_wake_order() {
    let gate = Arc::new(SubmitGate::default());
    let t0 = gate.clone().take(Profile::Video);
    let t1 = gate.clone().take(Profile::Video);
    let t2 = gate.clone().take(Profile::Video);
    let order = Arc::new(std::sync::Mutex::new(Vec::new()));
    let mut tasks = Vec::new();
    // Wake order 2, 1, 0 (the pod-ready race), submission must still be 0, 1, 2.
    for (delay, t) in [(0u64, t2), (5, t1), (10, t0)] {
        let order = order.clone();
        tasks.push(tokio::spawn(async move {
            tokio::time::sleep(std::time::Duration::from_millis(delay)).await;
            t.wait_turn().await;
            order.lock().unwrap().push(t.n());
            drop(t);
        }));
    }
    for t in tasks { t.await.unwrap(); }
    assert_eq!(*order.lock().unwrap(), vec![0, 1, 2]);
}

#[tokio::test]
async fn dropped_ticket_unblocks_the_next_and_profiles_are_independent() {
    let gate = Arc::new(SubmitGate::default());
    let video0 = gate.clone().take(Profile::Video);
    let video1 = gate.clone().take(Profile::Video);
    let image = gate.clone().take(Profile::Image);
    tokio::time::timeout(std::time::Duration::from_millis(100), image.wait_turn()).await.expect("image profile not blocked by video");
    assert!(tokio::time::timeout(std::time::Duration::from_millis(50), video1.wait_turn()).await.is_err());
    drop(video0); // a job that failed before submitting
    tokio::time::timeout(std::time::Duration::from_millis(100), video1.wait_turn()).await.expect("released by drop");
}
```

- [ ] **Step 2: Run** `cargo test tickets_submit dropped_ticket` — FAIL.
- [ ] **Step 3: Implement** (`jobs.rs`, near `JobKind`)

```rust
use std::collections::{BTreeSet, HashMap};
use std::sync::atomic::{AtomicU64, Ordering};

/// Submission order (Stories "Render all" on a cold pod): jobs queued together
/// wake together when the pod is ready and would race their `/run` calls. A
/// ticket is taken at queue time, in the caller's order; a job submits only
/// when it holds the lowest outstanding ticket of its profile. Dropping the
/// ticket (submitted, failed to start, cancelled) lets the next one through.
#[derive(Default)]
pub struct SubmitGate {
    next: AtomicU64,
    pending: std::sync::Mutex<HashMap<Profile, BTreeSet<u64>>>,
    notify: tokio::sync::Notify,
}

pub struct Ticket {
    gate: Arc<SubmitGate>,
    profile: Profile,
    n: u64,
}

impl SubmitGate {
    pub fn take(self: Arc<Self>, profile: Profile) -> Ticket {
        let n = self.next.fetch_add(1, Ordering::SeqCst);
        self.pending.lock().unwrap().entry(profile).or_default().insert(n);
        Ticket { gate: self, profile, n }
    }
}

impl Ticket {
    pub fn n(&self) -> u64 { self.n }
    /// Resolves when every earlier ticket of this profile has been released.
    pub async fn wait_turn(&self) {
        loop {
            // Registered before the check, so a release between the check and the await is not missed.
            let notified = self.gate.notify.notified();
            let first = self.gate.pending.lock().unwrap().get(&self.profile).and_then(|s| s.first().copied());
            if first == Some(self.n) { return; }
            notified.await;
        }
    }
}

impl Drop for Ticket {
    fn drop(&mut self) {
        if let Some(s) = self.gate.pending.lock().unwrap().get_mut(&self.profile) { s.remove(&self.n); }
        self.gate.notify.notify_waiters();
    }
}
```

`Profile` needs `Hash + Eq` (check `pod.rs`; add derives if missing). `state.rs`: `pub submit_gate: Arc<crate::jobs::SubmitGate>` initialised `Arc::default()`. `start_job`: `let ticket = core.submit_gate.clone().take(profile);` right after `precheck_for` (the counter runs in call order, which for `render_story` is shot order); move `ticket` into the spawned task and pass it to `run_job(core2, id2, client, plan, ticket)`; on the `Err` arms it is dropped with the task. `run_job`: before the submit loop `ticket.wait_turn().await;` and after the loop `drop(ticket);` (every `/run` of a multi-seed job goes out together). Log once at debug level: `alog!("job", "{} submitting (ticket {})", short(&id), ticket.n())` — no content.

- [ ] **Step 4: Integration test** (`tests/jobs.rs`, after `generate_cancel`)

```rust
#[tokio::test]
async fn jobs_queued_together_are_submitted_in_queue_order() {
    let server = MockServer::start().await;
    let h = harness(&server).await;
    Mock::given(method("POST")).and(path("/proxy/pod1/run")).respond_with(RunIds(AtomicUsize::new(0))).mount(&server).await;
    Mock::given(method("GET")).and(path_regex("/proxy/pod1/status/.*")).respond_with(ResponseTemplate::new(200).set_body_json(completed(1))).mount(&server).await;
    let ids: Vec<String> = (0..4).map(|i| jobs::generate(&h.core, req(1, Some(100 + i))).unwrap()).collect();
    for _ in 0..4 { wait_job(&h.sink).await; }
    let seeds: Vec<u64> = worker_requests(&server).await.iter()
        .filter(|r| r.url.path().ends_with("/run"))
        .map(|r| r.body_json::<Value>().unwrap()["input"]["seed"].as_u64().unwrap()).collect();
    assert_eq!(seeds, vec![100, 101, 102, 103], "jobs {ids:?}");
}
```

- [ ] **Step 5: Run** `cd app/src-tauri && cargo test && cargo clippy --all-targets -- -D warnings` — PASS.
- [ ] **Step 6: Commit** `git commit -am "Jobs: submit queued jobs to the worker in queue order (shot order for Render all)"`

---

### Task 4: ffmpeg over pipes — bytes in, bytes out, no files (both stores)

**Files:**
- Modify: `app/src-tauri/Cargo.toml` (`libc = "0.2"` under `[dependencies]`)
- Rewrite: `app/src-tauri/src/stories/ffmpeg.rs`
- Modify: `app/src-tauri/src/stories/render.rs:50-63 (take_path → take_bytes), 133-152 (continues frame), 248-332 (assemble_story)`

**Interfaces:**
- Produces: `pub fn assemble(ffmpeg: &Path, inputs: &[&[u8]]) -> Result<Vec<u8>, String>` (fragmented MP4); `pub fn assemble_args(n: usize) -> Vec<String>`; `pub fn last_frame_png(ffmpeg: &Path, video: &[u8], width: u32, height: u32) -> Result<Vec<u8>, String>`; `pub fn first_frame_jpg(ffmpeg: &Path, video: &[u8]) -> Result<Vec<u8>, String>`; `pub fn find_ffmpeg()` unchanged.
- Consumes: `libc::{pipe, fcntl, dup2, close}`, `std::os::unix::process::CommandExt::pre_exec`, `image` crate PNG encoder.

- [ ] **Step 1: Failing tests** (`ffmpeg.rs` tests; real ffmpeg, skipped when missing)

```rust
#[test]
fn assemble_args_pipes_and_fragmented_output() {
    let s = assemble_args(2).join(" ");
    assert!(s.starts_with("-i pipe:3 -i pipe:4 "), "run_piped adds -nostdin/-hide_banner/-loglevel itself");
    assert!(s.contains("[0:v][0:a][1:v][1:a]concat=n=2:v=1:a=1[v][a0];[a0]loudnorm=I=-14:TP=-1.5:LRA=11,aresample=48000[a]"));
    assert!(s.contains("-c:v libx264 -crf 18 -pix_fmt yuv420p -c:a aac -ar 48000 -ac 2 -metadata comment=AI-generated"));
    assert!(s.ends_with("-f mp4 -movflags frag_keyframe+empty_moov+default_base_moof pipe:1"));
}

/// Synthetic clips are written by ffmpeg into the temp dir (test fixtures); the
/// functions under test get bytes and must create no file anywhere.
#[test]
fn real_ffmpeg_bytes_in_bytes_out_writes_no_files() {
    let Ok(ff) = find_ffmpeg() else { eprintln!("ffmpeg not installed; skipping"); return };
    let dir = tempfile::tempdir().unwrap();
    let mk = |name: &str, color: &str| -> Vec<u8> {
        let p = dir.path().join(name);
        let st = std::process::Command::new(&ff).args(["-f", "lavfi", "-i", &format!("color=c={color}:s=320x180:d=1:r=24"),
            "-f", "lavfi", "-i", "sine=frequency=440:duration=1", "-shortest", "-c:v", "libx264", "-pix_fmt", "yuv420p",
            "-c:a", "aac", "-movflags", "+faststart", "-y"]).arg(&p).status().unwrap();
        assert!(st.success());
        std::fs::read(&p).unwrap()
    };
    let (a, b) = (mk("a.mp4", "red"), mk("b.mp4", "blue"));
    let listing = || { let mut v: Vec<_> = std::fs::read_dir(dir.path()).unwrap().map(|e| e.unwrap().file_name()).collect(); v.sort(); v };
    let before = listing();
    let film = assemble(&ff, &[&a, &b]).unwrap();
    assert!(film.len() > 1000 && &film[4..8] == b"ftyp");
    let png = last_frame_png(&ff, &b, 320, 180).unwrap();
    let img = image::load_from_memory(&png).unwrap().to_rgb8();
    let p = img.get_pixel(160, 90).0;
    assert!(p[2] > 200 && p[0] < 40 && p[1] < 40, "last frame of the blue clip: {p:?}");
    let jpg = first_frame_jpg(&ff, &film).unwrap();
    assert!(jpg.starts_with(&[0xFF, 0xD8]));
    assert_eq!(listing(), before, "no file was created");
    assert_eq!(last_frame_png(&ff, &b, 321, 180).unwrap_err(), "Could not read the last frame (unexpected frame size)");
}

/// The worker's takes are moov-first; a moov-at-end file cannot be read from a pipe.
#[test]
fn moov_at_end_input_is_a_clear_error() {
    let Ok(ff) = find_ffmpeg() else { return };
    let dir = tempfile::tempdir().unwrap();
    let p = dir.path().join("late.mp4");
    std::process::Command::new(&ff).args(["-f", "lavfi", "-i", "testsrc2=s=640x360:d=3:r=24", "-f", "lavfi", "-i", "sine=duration=3",
        "-shortest", "-c:v", "libx264", "-c:a", "aac", "-y"]).arg(&p).status().unwrap();
    let bytes = std::fs::read(&p).unwrap();
    assert!(bytes.len() > 64 * 1024, "must exceed ffmpeg's probe buffer for the test to mean anything");
    let e = first_frame_jpg(&ff, &bytes).unwrap_err();
    assert!(e.starts_with("ffmpeg failed:"), "{e}");
}
```

- [ ] **Step 2: Run** `cargo test stories::ffmpeg` — FAIL.
- [ ] **Step 3: Implement** (`ffmpeg.rs`; keep `find_ffmpeg` and `FFMPEG_MISSING`)

```rust
use std::io::{Read, Write};
use std::os::fd::FromRawFd;
use std::os::unix::process::CommandExt;
use std::process::{Command, Stdio};

const BASE: [&str; 4] = ["-nostdin", "-hide_banner", "-loglevel", "error"];

fn args<const N: usize>(a: [&str; N]) -> Vec<String> { a.iter().map(|s| s.to_string()).collect() }

/// Runs ffmpeg with `inputs[i]` readable as `pipe:{3+i}` and returns its stdout.
/// Nothing touches the filesystem: anonymous pipes, one writer thread per input.
fn run_piped(ffmpeg: &Path, args: &[String], inputs: &[&[u8]]) -> Result<Vec<u8>, String> {
    let err = |what: &str| format!("Could not run ffmpeg: {what}");
    let mut readers = Vec::with_capacity(inputs.len());
    let mut writers = Vec::with_capacity(inputs.len());
    for _ in inputs {
        let mut fds = [0i32; 2];
        // SAFETY: pipe(2) with a valid 2-int buffer. Both ends get CLOEXEC so no
        // other child spawned meanwhile inherits them; the read end is moved to a
        // high number so the child's dup2 targets (3, 4, …) can never collide.
        let r = unsafe {
            if libc::pipe(fds.as_mut_ptr()) != 0 { return Err(err("pipe")); }
            libc::fcntl(fds[1], libc::F_SETFD, libc::FD_CLOEXEC);
            let high = libc::fcntl(fds[0], libc::F_DUPFD_CLOEXEC, 100);
            libc::close(fds[0]);
            high
        };
        if r < 0 { return Err(err("fcntl")); }
        readers.push(r);
        writers.push(fds[1]);
    }
    let mut cmd = Command::new(ffmpeg);
    cmd.args(BASE).args(args).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
    let targets = readers.clone();
    // SAFETY: only async-signal-safe dup2 calls between fork and exec; dup2
    // clears CLOEXEC on the target, so the child sees pipe:3, pipe:4, …
    unsafe {
        cmd.pre_exec(move || {
            for (i, fd) in targets.iter().enumerate() {
                if libc::dup2(*fd, 3 + i as i32) < 0 { return Err(std::io::Error::last_os_error()); }
            }
            Ok(())
        });
    }
    let mut child = cmd.spawn().map_err(|e| err(&e.to_string()))?;
    for fd in readers { unsafe { libc::close(fd); } } // the child has its copies
    let mut stdout = child.stdout.take().expect("piped");
    let mut stderr = child.stderr.take().expect("piped");
    let (out, log) = std::thread::scope(|s| {
        for (fd, bytes) in writers.iter().zip(inputs) {
            let (fd, bytes) = (*fd, *bytes);
            s.spawn(move || {
                // SAFETY: fd is the write end we created and nobody else owns it; dropping the File closes it (EOF for ffmpeg).
                let mut f = unsafe { std::fs::File::from_raw_fd(fd) };
                let _ = f.write_all(bytes); // ffmpeg may stop reading early (error); its exit status says so
            });
        }
        let log = s.spawn(move || { let mut e = String::new(); let _ = stderr.read_to_string(&mut e); e });
        let mut out = Vec::new();
        let _ = stdout.read_to_end(&mut out);
        (out, log.join().unwrap_or_default())
    });
    let status = child.wait().map_err(|e| err(&e.to_string()))?;
    if !status.success() {
        let tail: Vec<&str> = log.lines().rev().take(3).collect();
        return Err(format!("ffmpeg failed: {}", tail.into_iter().rev().collect::<Vec<_>>().join(" / ")));
    }
    Ok(out)
}

/// Last frame as PNG: every frame streams out raw and only the last one is kept
/// (an input-side seek is impossible on a pipe). `width`/`height` come from the take record.
pub fn last_frame_png(ffmpeg: &Path, video: &[u8], width: u32, height: u32) -> Result<Vec<u8>, String> {
    let raw = run_piped(ffmpeg, &args(["-i", "pipe:3", "-an", "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1"]), &[video])?;
    let frame = (width as usize) * (height as usize) * 3;
    if frame == 0 || raw.len() < frame || raw.len() % frame != 0 {
        return Err("Could not read the last frame (unexpected frame size)".into());
    }
    let last = &raw[raw.len() - frame..];
    let mut png = Vec::new();
    image::codecs::png::PngEncoder::new(&mut png)
        .write_image(last, width, height, image::ExtendedColorType::Rgb8)
        .map_err(|e| format!("Could not encode the last frame: {e}"))?;
    Ok(png)
}

pub fn first_frame_jpg(ffmpeg: &Path, video: &[u8]) -> Result<Vec<u8>, String> {
    run_piped(ffmpeg, &args(["-i", "pipe:3", "-frames:v", "1", "-q:v", "3", "-f", "image2pipe", "-c:v", "mjpeg", "pipe:1"]), &[video])
}

/// Everything after the base flags (which `run_piped` adds).
pub fn assemble_args(n: usize) -> Vec<String> {
    let mut a: Vec<String> = Vec::new();
    for i in 0..n { a.push("-i".into()); a.push(format!("pipe:{}", 3 + i)); }
    let streams: String = (0..n).map(|i| format!("[{i}:v][{i}:a]")).collect();
    let filter = format!("{streams}concat=n={n}:v=1:a=1[v][a0];[a0]loudnorm=I=-14:TP=-1.5:LRA=11,aresample=48000[a]");
    for x in ["-filter_complex", &filter, "-map", "[v]", "-map", "[a]", "-c:v", "libx264", "-crf", "18", "-pix_fmt", "yuv420p",
              "-c:a", "aac", "-ar", "48000", "-ac", "2", "-metadata", "comment=AI-generated",
              "-f", "mp4", "-movflags", "frag_keyframe+empty_moov+default_base_moof", "pipe:1"] {
        a.push(x.to_string());
    }
    a
}

/// Approved takes (shot order) → one fragmented MP4, in memory.
pub fn assemble(ffmpeg: &Path, inputs: &[&[u8]]) -> Result<Vec<u8>, String> {
    if inputs.is_empty() { return Err("Nothing to assemble".into()); }
    run_piped(ffmpeg, &assemble_args(inputs.len()), inputs)
}
```

(`image::ImageEncoder` must be in scope for `write_image`.) Use `Zeroizing<Vec<u8>>` at the call sites in `render.rs`, not here.

`render.rs`: replace `take_path` by

```rust
/// The approved take's video bytes (General: the file; vault: Task 7).
fn take_bytes(core: &Core, take_id: &str) -> Result<(ImageRecord, Zeroizing<Vec<u8>>), String> {
    let rec = core.db.lock().unwrap().get_image(take_id)?.ok_or("The approved take's video is missing")?;
    let bytes = std::fs::read(&rec.path).map_err(|_| "The approved take's video file is missing".to_string())?;
    Ok((rec, Zeroizing::new(bytes)))
}
```

Continues shot (`render.rs:144-151`): `let (prev_rec, bytes) = take_bytes(core, take)?; let frame = ffmpeg::last_frame_png(&ff, &bytes, prev_rec.width, prev_rec.height).map_err(|e| format!("Could not read the last frame of shot {}: {e}", prev.position))?; init_image_id = Some(crate::references::import_bytes(&core.cfg.references_dir(), &frame)?.ref_id);` — no `stories-tmp`. `assemble_story`: collect `Vec<Zeroizing<Vec<u8>>>`, `let film = ffmpeg::assemble(&ff, &inputs.iter().map(|b| b.as_slice()).collect::<Vec<_>>())?; let poster = ffmpeg::first_frame_jpg(&ff, &film)?;` then write `videos/<id>.mp4` and `videos/<id>.jpg` with `std::fs::write` (General only) and continue as today. Delete the `stories-tmp` directory handling (and remove a stale one at startup: `let _ = std::fs::remove_dir_all(core.cfg.data_dir.join("stories-tmp"))` in `Core::new`).

- [ ] **Step 4: Run** `cd app/src-tauri && cargo test && cargo clippy --all-targets -- -D warnings` — PASS. Manual: in the app, assemble "The Reel Returns" → plays in the workspace; `ls` of the data dir shows no `stories-tmp`.
- [ ] **Step 5: Commit** `git commit -am "Stories: feed ffmpeg through pipes (no temp files); fragmented MP4 output"`

---

### Task 5: Vault — sealed characters and story docs, GC, locked-safe existence

**Files:**
- Modify: `app/src-tauri/src/vault.rs:336-350 (Unlocked), 689-737 (paths), 864-879 (unlock), 1071-1184 (items)` + tests
- Modify: `app/src-tauri/src/stories/mod.rs` (`Character.vault`, `Story.vault`, `StoryDoc`)
- Test: `app/src-tauri/tests/vault.rs`

**Interfaces:**
- Produces: `StoryDoc { story, shots, sidecar }`; `Vault::{put_character, character, characters, delete_character, put_story_doc, story_doc, story_docs, delete_story_doc, story_file_exists, character_file_exists, items_for_story}`.
- Consumes: `seal_bytes`, `write_private`, `BlobHeader::parse`, `open_chunks` (all private in `vault.rs`).

- [ ] **Step 1: Failing tests** (`vault.rs` tests module)

```rust
fn vchar(v: &Vault, name: &str) -> Character {
    let b = v.seal_blob(b"\x89PNG\r\n\x1a\nface", "png").unwrap();
    Character { id: uuid::Uuid::new_v4().to_string(), name: name.into(), description: "woman in her 30s, green jacket".into(),
        source: "generated".into(), consent: false, adult: true, ref_ids: vec![b.path()], ref_paths: vec![], vault: true,
        created_at: "t".into(), updated_at: "t".into() }
}

#[test]
fn characters_and_story_docs_seal_round_trip_and_hide_while_locked() {
    let (_d, v) = vault();
    v.create(PW, KdfParams::fast()).unwrap();
    let c = vchar(&v, "Mara");
    v.put_character(&c).unwrap();
    let story = Story { id: uuid::Uuid::new_v4().to_string(), title: "Light Packing".into(), logline: String::new(),
        brief: "two partners decide to run tonight".into(), target_s: 60, aspect: "16:9".into(), style: String::new(),
        cast: vec![c.id.clone()], voices: vec![], status: "draft".into(), result_image_id: None, vault: true,
        created_at: "t".into(), updated_at: "t".into() };
    let doc = StoryDoc { story: story.clone(), shots: vec![], sidecar: None };
    v.put_story_doc(&doc).unwrap();
    assert_eq!(v.characters().unwrap(), vec![c.clone()]);
    assert_eq!(v.story_doc(&story.id).unwrap().story.title, "Light Packing");
    v.lock();
    assert!(v.characters().unwrap_err().starts_with("VAULT_LOCKED"));
    assert!(v.story_doc(&story.id).unwrap_err().starts_with("VAULT_LOCKED"));
    assert!(v.put_story_doc(&doc).unwrap_err().starts_with("VAULT_LOCKED"), "edits need the unlocked vault");
    assert!(v.story_file_exists(&story.id) && !v.story_file_exists("nope"));
    for f in walk(v.dir()) {
        let bytes = std::fs::read(&f).unwrap();
        for needle in [b"Light Packing".as_slice(), b"run tonight", b"green jacket", b"Mara"] {
            assert!(!contains(&bytes, needle), "{}", f.display());
        }
    }
    v.unlock(PW).unwrap();
    assert_eq!(v.story_docs().unwrap().len(), 1);
    v.delete_story_doc(&story.id).unwrap();
    assert!(v.story_docs().unwrap().is_empty());
    assert!(!v.story_file_exists(&story.id));
}

#[test]
fn character_blob_gc_keeps_blobs_used_by_items() {
    let (_d, v) = vault();
    v.create(PW, KdfParams::fast()).unwrap();
    let c = vchar(&v, "Mara");
    let face = BlobRef::parse(&c.ref_ids[0]).unwrap();
    v.put_character(&c).unwrap();
    // A take rendered with that reference keeps it alive.
    let mut take = sample_item(&v.seal_blob(b"\0\0\0\x18ftypisom", "mp4").unwrap());
    take.references = vec![face.clone()];
    take.story_id = Some("s".into());
    take.shot_id = Some("sh".into());
    v.put_item(&take).unwrap();
    let mut edited = c.clone();
    edited.ref_ids = vec![v.seal_blob(b"\x89PNG\r\n\x1a\nother", "png").unwrap().path()];
    v.put_character(&edited).unwrap();
    assert!(v.open_blob(&face.id).is_ok(), "still referenced by the take");
    v.delete_item(&take.id).unwrap();
    assert!(v.open_blob(&face.id).is_err(), "last user gone");
    v.delete_character(&edited.id).unwrap();
    assert!(v.open_blob(&BlobRef::parse(&edited.ref_ids[0]).unwrap().id).is_err());
}
```

`tests/vault.rs`: `unlock_loads_story_docs_and_lock_wipes_them` — put a doc, lock, unlock in a fresh `Vault::new` over the same dir, assert the doc is back; then `lock()` and assert `status().item_count` counts no story item.

- [ ] **Step 2: Run** `cargo test characters_and_story_docs character_blob_gc` — FAIL.
- [ ] **Step 3: Implement**

`stories/mod.rs`: `Character { …, #[serde(default)] pub vault: bool }`, `Story { …, #[serde(default)] pub vault: bool }`, and

```rust
/// One sealed record per vault story (`vault/stories/<id>.bin`): the story and all its shots.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct StoryDoc {
    pub story: Story,
    pub shots: Vec<Shot>,
    #[serde(default)]
    pub sidecar: Option<serde_json::Value>,
}
```

`store.rs::row_to_character/row_to_story`: `vault: false`, `ref_paths: vec![]`. `vault.rs`:

```rust
use crate::stories::{Character, StoryDoc};

struct Unlocked {
    secret: StaticSecret,
    items: BTreeMap<String, VaultItem>,
    characters: BTreeMap<String, Character>,
    stories: BTreeMap<String, StoryDoc>,
}
impl Drop for Unlocked {
    fn drop(&mut self) {
        for item in self.items.values_mut() { item.prompt.zeroize(); item.negative_prompt.zeroize(); }
        for c in self.characters.values_mut() { c.name.zeroize(); c.description.zeroize(); }
        for d in self.stories.values_mut() {
            for s in [&mut d.story.title, &mut d.story.logline, &mut d.story.brief, &mut d.story.style] { s.zeroize(); }
            for sh in d.shots.iter_mut() {
                for s in [&mut sh.setting, &mut sh.camera, &mut sh.action, &mut sh.sound] { s.zeroize(); }
                for l in sh.dialogue.iter_mut() { l.line.zeroize(); l.delivery.zeroize(); }
            }
        }
        self.items.clear(); self.characters.clear(); self.stories.clear();
    }
}

fn characters_dir(&self) -> PathBuf { self.dir.join("characters") }
fn stories_dir(&self) -> PathBuf { self.dir.join("stories") }

/// Seals a JSON record into `dir/<id>.bin` (public key only; works locked).
fn seal_record<T: Serialize>(&self, dir: &Path, id: &str, value: &T) -> Result<(), String> {
    let public = self.public_key()?;
    let json = Zeroizing::new(serde_json::to_vec(value).map_err(|e| e.to_string())?);
    let sealed = seal_bytes(&public, &json, &binding_of(id)?)?;
    std::fs::create_dir_all(dir).map_err(|e| format!("Could not write to the vault: {e}"))?;
    write_private(&dir.join(format!("{id}.bin")), &sealed)
}

/// `read_item_file`, generalised: any sealed JSON record whose `id` field equals its file stem.
fn read_sealed<T: serde::de::DeserializeOwned>(secret: &StaticSecret, path: &Path) -> Result<(String, T), String> { /* body of read_item_file up to serde_json::from_slice; returns (stem, value) */ }

fn load_dir<T: serde::de::DeserializeOwned>(secret: &StaticSecret, dir: &Path, id_of: impl Fn(&T) -> &str) -> BTreeMap<String, T> { /* as load_items, over any dir; skips and logs unreadable files */ }
```

`unlock` and `create` fill the three maps (`load_dir` for `characters/` and `stories/`; `StoryDoc` id = `doc.story.id`). Methods (locked → `locked_err()` for reads and writes alike, `put_item` stays the one locked-tolerant write):

```rust
pub fn put_character(&self, c: &Character) -> Result<(), String> {
    let mut guard = self.unlocked.lock().unwrap();
    let u = guard.as_mut().ok_or_else(Self::locked_err)?;
    self.seal_record(&self.characters_dir(), &c.id, c)?;
    let old = u.characters.insert(c.id.clone(), c.clone());
    if let Some(old) = old { self.gc_blobs(u, old.ref_ids.iter().filter_map(|p| BlobRef::parse(p))); }
    Ok(())
}
pub fn character(&self, id: &str) -> Result<Character, String>
pub fn characters(&self) -> Result<Vec<Character>, String>           // by name, case-insensitive
pub fn delete_character(&self, id: &str) -> Result<Character, String> // remove, gc its blobs, unlink the file
pub fn character_file_exists(&self, id: &str) -> bool
pub fn put_story_doc(&self, d: &StoryDoc) -> Result<(), String>
pub fn story_doc(&self, id: &str) -> Result<StoryDoc, String>
pub fn story_docs(&self) -> Result<Vec<StoryDoc>, String>
pub fn delete_story_doc(&self, id: &str) -> Result<(), String>       // the doc only; takes/film are items the caller deletes
pub fn story_file_exists(&self, id: &str) -> bool                     // file name check; works locked
pub fn items_for_story(&self, story_id: &str) -> Result<Vec<VaultItem>, String>

/// Deletes each candidate blob that no item and no character still references.
fn gc_blobs<'a>(&self, u: &Unlocked, candidates: impl Iterator<Item = BlobRef>) {
    let used: HashSet<&str> = u.items.values().flat_map(|i| i.blobs().into_iter().map(|b| b.id.as_str()))
        .chain(u.characters.values().flat_map(|c| c.ref_ids.iter().filter_map(|p| p.strip_prefix(VAULT_PATH_PREFIX)).map(|r| r.split('.').next().unwrap_or(""))))
        .collect();
    for b in candidates { if !used.contains(b.id.as_str()) { let _ = self.delete_blob(&b.id); } }
}
```

`delete_item` (`vault.rs:1160-1184`) uses `gc_blobs` too, so a character's reference blob is kept while any character lists it. `Vault::new` sweeps `.tmp` in the two new dirs as well (`vault.rs:697-699`). `erase` already removes the whole dir.

- [ ] **Step 4: Run** `cd app/src-tauri && cargo test && cargo clippy --all-targets -- -D warnings` — PASS.
- [ ] **Step 5: Commit** `git commit -am "Vault: sealed characters and story docs with an in-memory index; blob GC across items and characters"`

---

### Task 6: `stories/repo.rs` — one router over both stores; rules; locked behaviour; labels

**Files:**
- Create: `app/src-tauri/src/stories/repo.rs`; register in `stories/mod.rs`
- Modify: `app/src-tauri/src/stories/render.rs` (every `store::` call → `repo::`; `job_label`; `check_story` cast names; `story_view` uses `repo::list_takes`/`repo::get_take`; `delete_story`; `update_story`)
- Modify: `app/src-tauri/src/commands.rs:841-957` (`create_story(destination)`, character commands via `repo`), `delete_vault_item` → `repo::clear_image_refs`
- Modify: `app/src-tauri/src/stories/validate.rs:54-80` (`preflight`: duplicate cast names)
- Test: `app/src-tauri/tests/stories.rs`

**Interfaces:**
- Produces: `repo::{list_characters, get_character, save_character, delete_character, list_stories, get_story, save_story, delete_story, list_shots, get_shot, replace_shots, update_shot, set_approved, set_result, list_takes, get_take, clear_image_refs, check_cast, character_home, story_home}`; `enum Home { General, Vault }`.
- Consumes: Task 5 vault methods; `store.rs`; `Db::list_takes/get_image`; `Vault::items_for_story`.

- [ ] **Step 1: Failing tests** (`tests/stories.rs`; harness: `Core::new` over a temp dir with `Db::open_in_memory`, `NullSink`, `CoreConfig::production(dir)` as `tests/jobs.rs:81-102` builds it, plus `core.vault.create(PW, KdfParams::fast())`)

```rust
#[test]
fn stories_route_to_their_store_and_vault_ones_vanish_while_locked() {
    let (_d, core) = core_with_vault();
    let general = repo::save_story(&core, &story_in(Home::General, "The Reel Returns")).unwrap();
    let vault = repo::save_story(&core, &story_in(Home::Vault, "Light Packing")).unwrap();
    assert_eq!(repo::list_stories(&core).unwrap().len(), 2);
    assert!(repo::get_story(&core, &vault.id).unwrap().unwrap().vault);
    core.vault.lock();
    let titles: Vec<String> = repo::list_stories(&core).unwrap().into_iter().map(|s| s.title).collect();
    assert_eq!(titles, vec!["The Reel Returns"]);
    assert_eq!(repo::get_story(&core, &vault.id).unwrap_err(), "VAULT_LOCKED: Unlock the vault to open this story");
    assert_eq!(repo::get_story(&core, "nope").unwrap(), None);
    assert!(repo::get_story(&core, &general.id).unwrap().is_some());
}

#[test]
fn general_story_rejects_vault_character_on_create_and_update() {
    let (_d, core) = core_with_vault();
    let mara = repo::save_character(&core, &character_in(Home::General, "Mara")).unwrap();
    let secret = repo::save_character(&core, &character_in(Home::Vault, "Ivo")).unwrap();
    let mut s = story_in(Home::General, "G");
    s.cast = vec![secret.id.clone()];
    assert_eq!(repo::check_cast(&core, &s).unwrap_err(), "A General story can't use a vault character. Create the story as a vault story.");
    s.cast = vec![mara.id.clone()];
    let s = repo::save_story(&core, &s).unwrap();
    let e = render::update_story(&core, &s.id, StoryPatch { cast: Some(vec![mara.id.clone(), secret.id.clone()]), ..Default::default() }).unwrap_err();
    assert!(e.contains("can't use a vault character"), "{e}");
    let mut v = story_in(Home::Vault, "V");
    v.cast = vec![mara.id.clone(), secret.id.clone()];
    repo::check_cast(&core, &v).unwrap(); // a vault story may use General characters
}

#[test]
fn deleting_a_general_character_waits_for_the_locked_vault() {
    let (_d, core) = core_with_vault();
    let mara = repo::save_character(&core, &character_in(Home::General, "Mara")).unwrap();
    core.vault.lock();
    assert_eq!(repo::delete_character(&core, &mara.id).unwrap_err(), "Unlock the vault first: a vault story may use this character");
    core.vault.unlock(PW).unwrap();
    repo::delete_character(&core, &mara.id).unwrap();
}

#[test]
fn vault_story_job_label_has_no_title_and_cast_names_must_differ() {
    let mut s = story_in(Home::Vault, "Light Packing");
    assert_eq!(render::job_label(&s, 2), "Vault story · shot 2");
    s.vault = false;
    assert_eq!(render::job_label(&s, 2), "Story: Light Packing · shot 2");
    let (a, b) = (Character { id: "a".into(), ..mara() }, Character { id: "b".into(), ..mara() });
    let issues = app_lib::stories::validate::preflight(&story_with_cast(&["a", "b"]), &[a, b]);
    assert!(issues.iter().any(|i| i.message == "Two cast members are both named Mara. Rename one."));
}
```

- [ ] **Step 2: Run** `cargo test stories_route general_story_rejects deleting_a_general vault_story_job_label` — FAIL.
- [ ] **Step 3: Implement** (`repo.rs` core shape)

```rust
//! Where a character or story lives: SQLite (General) or the vault. The only
//! module that knows; render.rs and commands.rs call these verbs.
use crate::state::Core;
use crate::stories::{store, Character, Shot, Story, StoryDoc};
use crate::vault::ERR_LOCKED;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Home { General, Vault }

fn locked(what: &str) -> String { format!("{ERR_LOCKED}: Unlock the vault to {what}") }

pub fn get_story(core: &Core, id: &str) -> Result<Option<Story>, String> {
    if let Some(s) = store::get_story(&core.db.lock().unwrap(), id)? { return Ok(Some(s)); }
    if core.vault.is_unlocked() { return Ok(core.vault.story_doc(id).ok().map(|d| d.story)); }
    if core.vault.story_file_exists(id) { return Err(locked("open this story")); }
    Ok(None)
}

pub fn list_stories(core: &Core) -> Result<Vec<Story>, String> {
    let mut v = store::list_stories(&core.db.lock().unwrap())?;
    if core.vault.is_unlocked() { v.extend(core.vault.story_docs()?.into_iter().map(|d| d.story)); }
    v.sort_by(|a, b| b.updated_at.cmp(&a.updated_at).then(b.created_at.cmp(&a.created_at)));
    Ok(v)
}

pub fn save_story(core: &Core, s: &Story) -> Result<Story, String> {
    if !s.vault { store::save_story(&core.db.lock().unwrap(), s)?; return Ok(s.clone()); }
    if !core.vault.exists() { return Err(format!("{}: Create the vault first (Gallery → Vault)", crate::vault::ERR_NO_VAULT)); }
    let mut doc = core.vault.story_doc(&s.id).unwrap_or(StoryDoc { story: s.clone(), shots: vec![], sidecar: None });
    doc.story = s.clone();
    core.vault.put_story_doc(&doc).map_err(|e| if e.starts_with(ERR_LOCKED) { locked("save a vault story") } else { e })?;
    Ok(s.clone())
}

/// A shot by id: SQLite, else a scan of the unlocked vault's docs (a handful of stories).
pub fn get_shot(core: &Core, id: &str) -> Result<Option<Shot>, String> { … }
pub fn replace_shots(core: &Core, story_id: &str, shots: &[Shot]) -> Result<(), String> { /* General: store::replace_shots; vault: doc.shots = shots.to_vec(); put_story_doc */ }
pub fn set_approved / update_shot / set_result  // same split; vault = rewrite the doc

pub fn list_takes(core: &Core, story: &Story) -> Result<Vec<ImageRecord>, String> {
    if !story.vault { return core.db.lock().unwrap().list_takes(&story.id); }
    Ok(core.vault.items_for_story(&story.id)?.iter().filter(|i| i.shot_id.is_some()).map(|i| i.to_record()).collect())
}
/// A take or film record from either store (vault: unlocked only).
pub fn get_take(core: &Core, id: &str) -> Result<Option<ImageRecord>, String> { … }

pub fn check_cast(core: &Core, story: &Story) -> Result<(), String> {
    for id in &story.cast {
        let c = get_character(core, id)?.ok_or("A cast character no longer exists")?;
        if c.vault && !story.vault {
            return Err("A General story can't use a vault character. Create the story as a vault story.".into());
        }
    }
    Ok(())
}

pub fn delete_character(core: &Core, id: &str) -> Result<(), String> {
    let c = get_character(core, id)?.ok_or("That character no longer exists")?;
    if !c.vault && core.vault.exists() && !core.vault.is_unlocked() {
        return Err("Unlock the vault first: a vault story may use this character".into());
    }
    if let Some(s) = list_stories(core)?.into_iter().find(|s| s.cast.iter().any(|x| x == id)) {
        return Err(format!("{} is used by story \"{}\"", c.name, s.title));
    }
    if c.vault { core.vault.delete_character(id).map(|_| ()) } else { store::delete_character(&core.db.lock().unwrap(), id) }
}

pub fn save_character(core: &Core, c: &Character) -> Result<Character, String> {
    // The store is fixed: an existing character keeps its home whatever the request says.
    let home = match get_character(core, &c.id)? { Some(old) => home_of(old.vault), None => home_of(c.vault) };
    let ok = c.ref_ids.iter().all(|r| crate::vault::is_vault_path(r) == (home == Home::Vault));
    if !ok { return Err("Reference images must be in the same place as the character".into()); }
    match home {
        Home::General => { store::save_character(&core.db.lock().unwrap(), c)?; Ok(c.clone()) }
        Home::Vault => {
            if core.vault.characters()?.iter().any(|x| x.id != c.id && x.name.eq_ignore_ascii_case(&c.name)) {
                return Err(format!("A character named {} already exists", c.name));
            }
            core.vault.put_character(c).map_err(|e| if e.starts_with(ERR_LOCKED) { locked("create a vault character") } else { e })?;
            Ok(c.clone())
        }
    }
}

/// A deleted take or film: the shot that approved it loses the approval; a story whose film it was goes back to "planned".
pub fn clear_image_refs(core: &Core, image_id: &str) -> Result<(), String> {
    store::clear_image_refs(&core.db.lock().unwrap(), image_id)?;
    if core.vault.is_unlocked() {
        for mut d in core.vault.story_docs()? {
            let mut changed = false;
            for s in d.shots.iter_mut() { if s.approved_take_id.as_deref() == Some(image_id) { s.approved_take_id = None; changed = true; } }
            if d.story.result_image_id.as_deref() == Some(image_id) { d.story.result_image_id = None; d.story.status = "planned".into(); changed = true; }
            if changed { core.vault.put_story_doc(&d)?; }
        }
    }
    Ok(())
}
```

`list_characters` fills `ref_paths` through `render::with_ref_paths` (Task 2) for both stores. `render.rs`: `cast_of` → `repo::get_character`; `story_view` → `repo::get_story/list_shots/list_takes/get_take`; `render_shot`'s `destination` = `if view.story.vault { Destination::Vault } else { Destination::General }` and `label: Some(job_label(&view.story, shot.position))` with

```rust
pub fn job_label(story: &Story, position: u32) -> String {
    if story.vault { return format!("Vault story · shot {position}"); }
    … (existing body)
}
```

`check_story` + `preflight` add the duplicate-name rule (case-insensitive). `update_story` calls `repo::check_cast` after applying the patch and ignores any `vault` change. `commands::create_story` gains `destination: Option<String>` → `story.vault = Destination::parse(destination.as_deref())? == Destination::Vault`, then `repo::check_cast`, `repo::save_story`. `delete_vault_item` calls `repo::clear_image_refs(&core, &id)` before `delete_item`. `delete_story` (render.rs) → Task 7 handles vault media; here it routes the doc/row delete.

- [ ] **Step 4: Run** `cd app/src-tauri && cargo test && cargo clippy --all-targets -- -D warnings` — PASS (the existing `tests/stories.rs` tests keep passing with General stories).
- [ ] **Step 5: Commit** `git commit -am "Stories: repo router over SQLite and the vault; store rules; locked behaviour; vault job labels"`

---

### Task 7: Vault render path — references, first frame, takes, film, export, delete

**Files:**
- Modify: `app/src-tauri/src/stories/render.rs` (`take_bytes`, `render_shot` continues branch, `assemble_story`, `delete_story`, `store_shots` orphan takes)
- Modify: `app/src-tauri/src/jobs.rs:1090-1099` (orphan check), `vault_migrate.rs:163-195` (`seal_output` keeps story ids — done in Task 1's `item_from_record`)
- Test: `app/src-tauri/tests/vault.rs` (uses its `mock_server(image, video, poster)` and `adopt_running_pod` helpers, `tests/vault.rs:456-520`)

**Interfaces:**
- Produces: `take_bytes(core, &Story, take_id) -> (ImageRecord, Zeroizing<Vec<u8>>)` (vault: `open_blob(media)`); `assemble_story` for both stores; `delete_story` for both.
- Consumes: `vault_migrate::{seal_output, seal_verified}`, `Vault::{open_blob, delete_item, items_for_story}`, Task 4 ffmpeg functions.

- [ ] **Step 1: Failing tests** (`tests/vault.rs`)

```rust
#[tokio::test]
async fn vault_story_renders_sealed_even_when_locked_meanwhile_and_leaves_no_plaintext() {
    let server = mock_server(png(1, 64, 64), mp4(7), jpeg(2)).await; // the worker fixture: a moov-first MP4 (assert `&mp4(7)[4..8] == b"ftyp"` and moov before mdat)
    let h = harness(&server.uri());
    h.core.vault.create(PW, KdfParams::fast()).unwrap();
    adopt_running_pod(&h).await;
    let face = vault_migrate::import_reference_to_vault(&h.core, &png(3, 64, 64)).unwrap();
    let mara = repo::save_character(&h.core, &Character { ref_ids: vec![face.ref_id.clone()], vault: true, ..character("Mara") }).unwrap();
    let story = repo::save_story(&h.core, &Story { cast: vec![mara.id.clone()], vault: true, ..story_draft("Light Packing", "two partners decide to run tonight") }).unwrap();
    render::store_shots(&h.core, &story.id, &[shot(&story.id, 1, &mara.id, "Mara runs to the edge of the roof.")]).unwrap();
    let shot_id = repo::list_shots(&h.core, &story.id).unwrap()[0].id.clone();
    let job = render::render_shot(&h.core, &shot_id).unwrap();
    h.core.vault.lock();                       // locks while the pod works
    let done = wait_job(&h.sink, &job).await;
    assert_eq!(done.status, JobState::Completed);
    assert!(done.images.is_empty() && done.completed == 1, "redacted while locked");
    assert_eq!(done.label.as_deref(), Some("Vault story · shot 1"));
    h.core.vault.unlock(PW).unwrap();
    let view = render::story_view(&h.core, &story.id).unwrap();
    assert_eq!(view.takes.len(), 1);
    assert!(view.takes[0].vault && view.takes[0].path.starts_with("vault://localhost/"));
    assert_eq!(view.takes[0].shot_id.as_deref(), Some(shot_id.as_str()));
    assert!(h.core.vault.gallery_items().unwrap().is_empty(), "takes are not gallery items");
    // Approve and assemble (needs ffmpeg; skipped otherwise).
    if app_lib::stories::ffmpeg::find_ffmpeg().is_ok() {
        render::approve_take(&h.core, &shot_id, &view.takes[0].id).unwrap();
        let film = render::assemble_story(&h.core, &story.id).unwrap();
        assert!(film.vault && film.story_id.as_deref() == Some(story.id.as_str()) && film.shot_id.is_none());
        assert_eq!(repo::get_story(&h.core, &story.id).unwrap().unwrap().status, "assembled");
        assert!(h.core.vault.gallery_items().unwrap().is_empty());
        let dest = h.dir.path().join("export.mp4");
        vault_migrate::export_item(&h.core, &film.id, &dest).unwrap();
        assert_eq!(&std::fs::read(&dest).unwrap()[4..8], b"ftyp");
        std::fs::remove_file(&dest).unwrap();
    }
    // Nothing readable anywhere in the data dir: the brief, the action, the reference pixels, the take's video.
    for (path, bytes) in plaintext_areas(&h) {
        for needle in [b"run tonight".as_slice(), b"edge of the roof", b"Light Packing", &png(3, 64, 64)[16..48], &mp4(7)[..32]] {
            assert!(!contains(&bytes, needle), "{}", path.display());
        }
    }
    assert!(!h.dir.path().join("stories-tmp").exists());
    assert!(!h.dir.path().join("references").read_dir().unwrap().any(|_| true), "no plain reference for a vault character");
    // Delete the story: takes, film and doc go; the character's reference blob stays.
    render::delete_story(&h.core, &story.id).unwrap();
    assert!(h.core.vault.items().unwrap().is_empty());
    assert!(h.core.vault.open_blob(&BlobRef::parse(&face.ref_id).unwrap().id).is_ok());
}
```

(`plaintext_areas` = every file under the data dir except `vault/blobs`, `vault/items`, `vault/stories`, `vault/characters`, as `tests/vault.rs:162` does today — extend its exclusion list.)

- [ ] **Step 2: Run** `cargo test vault_story_renders_sealed` — FAIL.
- [ ] **Step 3: Implement**

`render.rs`:

```rust
fn take_bytes(core: &Core, story: &Story, take_id: &str) -> Result<(ImageRecord, Zeroizing<Vec<u8>>), String> {
    let rec = repo::get_take(core, take_id)?.ok_or("The approved take's video is missing")?;
    if story.vault {
        let b = BlobRef::parse(&rec.path).ok_or("The approved take's video is missing")?;
        return Ok((rec, core.vault.open_blob(&b.id)?));
    }
    let bytes = std::fs::read(&rec.path).map_err(|_| "The approved take's video file is missing".to_string())?;
    Ok((rec, Zeroizing::new(bytes)))
}
```

Continues branch: after `last_frame_png`, `init_image_id = Some(if view.story.vault { vault_migrate::seal_verified(core, &frame, "png")?.path() } else { references::import_bytes(&core.cfg.references_dir(), &frame)?.ref_id });`. The frame `Vec<u8>` is wrapped in `Zeroizing`.

`assemble_story`: build `rec` (template) as today with `vault: view.story.vault`; General → write files + `db.insert_image` (as Task 4 left it); vault → `let saved = vault_migrate::seal_output(core, &rec, &film, Some(&poster))?;` (seals, writes the item with `story_id`, emits `vault-update`), then `repo::set_result(core, &story, &saved.id, &sidecar)` (vault: `doc.sidecar = Some(sidecar); doc.story.result_image_id = Some(id); status = "assembled"`), then delete the previous film: General `core.cfg.delete_record`, vault `core.vault.delete_item(old)`. Store the sidecar in the doc, not a column.

`delete_story`: vault → `for it in core.vault.items_for_story(id)? { core.vault.delete_item(&it.id)?; }` (character reference blobs survive through the GC: the characters still list them), then `core.vault.delete_story_doc(id)`; General unchanged. `store_shots`'s orphan-take cleanup: vault → delete the items of shots that are gone. Both refuse while rendering (as today).

`jobs.rs::save_video` orphan check: it already runs only on the General branch (the vault branch returns earlier via `seal_output`); add the vault-side check for the unlocked case: after `seal_output`, `if core.vault.is_unlocked() { if let Some(shot) = rec.shot_id.as_deref() { if repo::get_shot(core, shot)?.is_none() { core.vault.delete_item(&saved.id)?; return Err("The shot was removed while it rendered; its take was discarded".into()); } } }`. While locked: skip (the shot cannot have been removed — spec §3.4).

`commands::export_image` already reaches `export_vault_item`; `export_vault_item` → `vault_migrate::export_item` writes the decrypted film to the chosen path (`vault_migrate.rs:378-385`) — unchanged.

- [ ] **Step 4: Run** `cd app/src-tauri && cargo test && cargo clippy --all-targets -- -D warnings` — PASS. Grep gate (Global Constraints) — only General writes in `render.rs`.
- [ ] **Step 5: Commit** `git commit -am "Stories: vault stories render, approve and assemble sealed; export and delete through the vault"`

---

### Task 8: Frontend — vault stories and characters, lock screen, Save-to

**Files:**
- Modify: `app/src/api/types.ts` (`Character.vault/refPaths`, `Story.vault`, `createStory` input), `api/index.ts:240-241`, `api/mock.ts` (vault flags; locked behaviour; `create_story` destination)
- Modify: `app/src/screens/create/stories/StoriesPanel.tsx`, `CharacterForm.tsx`, `StoryWorkspace.tsx`, `stories.css`, `workspace.css`
- Modify: `app/src/screens/create/CreateScreen.tsx` (pass `vault` state; nothing else)

**Interfaces:**
- Consumes: `useVault()` (`state/vault.tsx:86`: `exists`, `unlocked`, `lockEpoch`, `requestUnlock`), `SaveToSwitch` (`VaultViews.tsx:541`) or a two-button segmented control with the same classes, `GalleryPicker` (`preferVault`), `api.importReference(path, "vault")`, `api.importReferenceBytes(b64, mime, "vault")`.

- [ ] **Step 1: Types and mock first** (so `tsc` drives the UI work)

`types.ts`: `Character { …, vault: boolean; refPaths: string[] }`, `Story { …, vault: boolean }`; `index.ts`: `createStory = (input: { …; destination?: Destination })`. Mock: `characters`/`stories` carry `vault`; `const vaultVisible = () => vault.status.unlocked`; `list_stories`/`list_characters` filter `!x.vault || vaultVisible()`; `get_story`/`save_shots`/`approve_take`/`assemble_story`/`plan_story` on a vault story while locked throw `new Error("VAULT_LOCKED: Unlock the vault to open this story")`; `create_story` with `destination: "vault"` while locked throws `VAULT_LOCKED: Unlock the vault to create a vault story`; `save_character` with `vault` likewise; `checkCast` mirrors the General/vault rule; `storyJobLabel` returns `Vault story · shot N` for vault stories; takes/films of vault stories get `vault: true` and `vault://`-style mock paths (`mock-video:` is fine for playback placeholders). Run `npx tsc --noEmit` — FAIL in the UI until Step 2.

- [ ] **Step 2: StoriesPanel**

- Save-to for a new story (only `vault.exists`): a segmented control `General | Vault` above the brief; Vault disabled while locked (`title="Unlock the vault to create a vault story"`); hint under it: "Encrypted in the vault. The GPU pod and LM Studio still see what they need to render and plan." Passed as `destination` to `createStory`. A saved story shows a read-only badge instead (`<span className="tag"><Icon name="lock" size={11} /> Vault</span>` in the picker option text and next to the title).
- Reload `load()` whenever `vault.unlocked` changes (after the first load). If the selected story disappears from the list because the vault locked, keep `selectedStoryId` (the workspace shows the lock screen) — adjust the "Deleted elsewhere" effect (`StoriesPanel.tsx:134-145`) to ignore ids while `!vault.unlocked && lockedIds.current.has(id)`, where `lockedIds` remembers vault story ids seen while unlocked.
- Cast menu rows: vault characters show a lock tag; when the story (or the new-story Save-to) is General they are `disabled` with `title="Only a vault story can use a vault character"`.
- "New character…" from a vault story opens the form with `defaultVault`.

- [ ] **Step 3: CharacterForm**

Prop `defaultVault?: boolean`. New character only: a "Keep in vault" checkbox (shown when `vault.exists`; disabled while locked with the hint "Unlock the vault to create a vault character"). `dest = inVault ? "vault" : "general"` for `importReferenceBytes` / `importReference`. `fromGallery`: `if (rec.vault && !inVault) toast.info("Vault images can only be used by vault characters")`; else `api.importReference(rec.path, dest)` (a vault path is re-sealed; a General image is sealed when `inVault`). `GalleryPicker preferVault={inVault}`. Save sends `vault: inVault` (ignored for an existing character). Editing a vault character keeps `inVault = character.vault` (checkbox hidden).

- [ ] **Step 4: StoryWorkspace**

- `const vault = useVault();` When `view?.story.vault || loadError?.startsWith("VAULT_LOCKED")` and `!vault.unlocked`: render the lock screen in place of the workspace:

```tsx
<div className="empty story-ws__empty story-ws__locked">
  <div className="empty__art"><Icon name="lock" size={26} /></div>
  <h3>This story is in the vault.</h3>
  <p>Unlock to continue.</p>
  <button type="button" className="btn btn--primary btn--sm" onClick={() => vault.requestUnlock()}><Icon name="unlock" size={14} /> Unlock</button>
</div>
```

- On a lock while a vault story is open: cancel pending timers, `discard()`, and `toast.info("Vault locked — unsaved edits to this story were discarded")` (only if `saveState !== "idle"` or drafts exist). Remount on `vault.lockEpoch` (add it to the `key` in `CreateScreen.tsx:1511`), so unlocking refetches.
- Film section (Task 1): the inline "not encrypted" confirmation replaces the `window.confirm` using the Lightbox markup (`Lightbox.tsx:719-730`).
- Shot cards: nothing — `fileSrc` already serves `vault://` takes and posters (`ShotCard.tsx:161-166`).

- [ ] **Step 5: Run** `cd app && npx tsc --noEmit && npm run build` — PASS. Mock walk (`?vault=…` params as the mock supports; see `mock.ts:822-870`): create a vault character (gallery pick from the mock vault) → vault story → plan → Render all → approve → assemble → film plays → Export; lock the mock vault → the story and character vanish from the panel, the workspace shows the lock screen; unlock → back with the film. General story: vault characters are disabled in the menu.
- [ ] **Step 6: Commit** `git commit -am "Stories UI: vault stories and characters, lock screen, Save-to on new stories"`

---

### Task 9: Contract docs, mock walk, real run

**Files:**
- Modify: `docs/vault-contract.md` (new section "Stories": `create_story.destination`, `reveal_image`, `Character.vault/refPaths`, `Story.vault`, `StoryView.result`, `VAULT_LOCKED` cases, "story items never in `list_vault_items`/`itemCount`")
- Modify: `docs/superpowers/specs/2026-10-13-stories-design.md` §3 bullet "v1 stories save to the general gallery only" → "Superseded by `2026-10-13-stories-vault-design.md`"; §7 "Takes … hidden from the normal gallery" and §8 "visible in the gallery" → workspace only.

- [ ] **Step 1: Docs** as above (keep both documents short; link rather than repeat).
- [ ] **Step 2: Full verification** `cd app/src-tauri && cargo test && cargo clippy --all-targets -- -D warnings && cd .. && npx tsc --noEmit && npm run build`; the Task 8 mock walk; `grep -rn "stories-tmp\|std::fs::write" app/src-tauri/src/stories/` shows General-only writes.
- [ ] **Step 3: Real run (paid; the owner confirms before any GPU start):** create a vault character from an existing vault image, a 30 s vault story with one General character too, plan, Render all (watch the job list: shots submit 1, 2, 3 …), lock the vault while a shot renders, unlock, approve, assemble, play, Export, delete. During assembly `ls -la "$HOME/Library/Application Support/com.naren.imagestudio"` shows no new file outside `vault/`. Confirm "The Reel Returns", Mara and Theo are untouched.
- [ ] **Step 4: Commit** `git commit -am "Docs: vault contract and stories spec updated for vault stories"`
