# Stories in the vault, final film in the workspace, edit character, shot order — design

Date: 2026-10-13 · Owner: Naren · Status: owner decisions A–D made in chat; this document resolves
the design questions they leave open. Builds on `2026-10-13-stories-design.md` (Stories v1) and the
vault (spec v6: `app/src-tauri/src/vault.rs` header, `docs/vault-contract.md`).

## 1. Goals

A. **Vault stories, end to end.** A character and a story can each be *Vault* (chosen at creation).
   For a vault story everything is encrypted in the existing vault: the characters' reference
   images, character name/description, story brief/style/title/logline/voices, every shot
   (setting/camera/action/dialogue/sound), every take and the final film. Visible and renderable
   only while the vault is unlocked; while locked, vault characters and vault stories vanish from
   the Stories tab (General stories still show). A vault story may use General characters; a
   General story may not use a vault character. Renders already running when the vault locks still
   save, sealed. Approving, assembling, planning and editing need the vault unlocked.
B. **Final film in the Stories tab only.** No story row (take or assembled film, General or vault)
   appears in the Image/Video galleries. The workspace plays the final film and offers
   *Show in Finder* (General) and *Export…* (both; vault = decrypt to a chosen file).
C. **Edit character.** A pencil on each cast chip and in the cast menu opens `CharacterForm`
   prefilled: name, description, add/remove/replace 1–3 reference images, source, consent, adult.
   Existing takes are unaffected; the next render uses the character's current references.
D. **Shot order.** Shots queued together ("Render all" on a cold pod) are submitted to the GPU
   worker in shot-position order.

Done means: the Rust and TS checks pass (`cargo test`, `cargo clippy --all-targets -- -D warnings`,
`npx tsc --noEmit && npm run build`), the mock walk in §12 works, and one real vault story renders,
assembles and exports with no plaintext file ever written (verified by the test in §12.4).

## 2. Non-goals

- Moving a character or story between General and Vault after creation (the move would have to
  re-home takes, films and reference blobs; nothing in A needs it). *Out of scope; a later task.*
- Changing how the vault itself works (keys, blob format, `vault://`, auto-lock, migration).
- Hiding anything from the GPU pod, from LM Studio, or from the running app's memory (§4).
- A separate "Save to" for takes versus the film: a story's store decides both.
- Worker changes (the pod and its API are untouched). ffmpeg feature changes.
- Vault migration of existing story data: "The Reel Returns", Mara and Theo stay General (§7).

## 3. Decisions, with the alternatives considered

### 3.1 Where vault characters, stories and shots live (problem 1)

**Chosen: sealed JSON records in two new vault folders, cached in memory while unlocked, with a
thin routing layer (`stories/repo.rs`) in front of the unchanged SQLite store.**

- `vault/characters/<uuid>.bin` — one sealed `Character` per vault character. Its `ref_ids` are
  `vault://localhost/<blobId>.<ext>` URLs; the images are ordinary blobs in `vault/blobs/`.
- `vault/stories/<uuid>.bin` — one sealed `StoryDoc { story, shots, sidecar }` per vault story.
  The story and all its shots are one record: shots are always listed and replaced per story,
  one AEAD record makes "story + shots" atomic, and a story's text is a few KB, so rewriting the
  whole record on every change is cheaper than consistency rules between records.
- Takes and the final film are vault *items* exactly like today's vault videos
  (`vault/items/<uuid>.bin` + blobs), sealed by the existing `vault_migrate::seal_output`
  (`vault_migrate.rs:166`). `VaultItem` gains `story_id` and `shot_id` (serde default `None`), and
  `VaultItem::to_record` passes them through (`vault.rs:286-320`, today hard-coded `None`).
- Sealing uses the same `seal_bytes` / `write_private` path as items (`vault.rs:539,616`): the
  record's UUID is bound into the AEAD, `.tmp` + rename, mode 0600. Reading uses the same
  `read_item_file` logic, generalised to `read_sealed<T>(secret, path)`.
- The in-memory index: `Unlocked` (`vault.rs:336`) gains `characters: BTreeMap<String, Character>`
  and `stories: BTreeMap<String, StoryDoc>`, filled at unlock like `items`, wiped on lock (the
  `Drop` zeroizes every text field, as it zeroizes prompts today).
- **Writes to characters/stories require the unlocked vault** (they are edits the user makes; the
  cache must stay the source of truth). The one write that must work while locked — saving a
  finished take or film — is an item write (`put_item`, `vault.rs:1126`), which already works
  locked because sealing needs only the public key.
- Existence while locked: `vault/stories/<id>.bin` file names are the story ids (random UUIDs,
  same exposure as `vault/items/`). `Vault::story_file_exists(id)` lets the router answer
  "that story is in the locked vault" (`VAULT_LOCKED: …`) instead of "no such story".

How the rest of the code reads them — `stories/repo.rs`, the only place that knows where a story
lives:

```rust
// Same verbs as store.rs, taking &Core instead of &Db. General (SQLite) first, then the vault.
pub fn get_story(core: &Core, id: &str) -> Result<Option<Story>, String>
pub fn list_stories(core: &Core) -> Result<Vec<Story>, String>   // SQLite ∪ vault (when unlocked)
pub fn save_story(core: &Core, s: &Story) -> Result<(), String>  // routed by s.vault
pub fn list_shots / get_shot / replace_shots / update_shot / set_approved / set_result
pub fn list_characters / get_character / save_character / delete_character
pub fn list_takes(core, story_id) / get_take(core, id) / clear_image_refs(core, image_id)
```

`store.rs` stays SQLite-only and untouched in shape (no schema change: every row in SQLite is
General, so `vault: false` is set when rows are read). `render.rs` and `commands.rs` swap
`store::x(&db, …)` for `repo::x(core, …)` — a mechanical edit of the existing call sites
(`render.rs:18-47, 116-130, 223-233, 345-383, 389-444, 463-489`; `commands.rs:841-957`).
`Story` and `Character` gain `#[serde(default)] vault: bool`, fixed at creation.

Rejected:
- *A trait `StoryStore` with two impls and a `Box<dyn StoryStore>` chosen per call.* The caller
  must already know the store to pick the impl, and listing must merge both; the router does the
  same with less code and no trait objects.
- *SQLite rows with encrypted columns.* Breaks the vault's rule "The SQLite database never sees
  vault items" (`vault.rs:40`) and leaks row counts, timestamps and shot counts through the schema.
- *One sealed record per shot.* More files, and approve/replan would need multi-record
  consistency for no gain.

### 3.2 ffmpeg without plaintext files (problem 2)

**Chosen: ffmpeg never gets a path to plaintext. Inputs are fed through anonymous pipes
(`pipe:3`, `pipe:4`, …), the output comes back on stdout, and the same code path serves General and
vault stories.** Verified on the installed Homebrew ffmpeg 8.1 (2026-10-13) with the real worker
take `videos/4e01f928….mp4` (1344×768, 14.4 s, 6.2 MB) and a synthetic 1344×768 10 s clip:

| Need | What works | What does not |
|---|---|---|
| Multiple inputs | `-i pipe:3 -i pipe:4 …` (the `pipe` protocol takes any fd number; `ffmpeg -protocols` lists `pipe` and `fd`) | FIFOs would also work but leave filesystem nodes to clean up |
| Reading the worker's MP4 from a pipe | Works: the worker's takes are moov-first (`ftyp, moov, free, mdat`, checked on the real take) | A moov-at-end MP4 fails from a pipe ("partial file"); not our case, and asserted by a test on the worker fixture |
| Last frame of a take | `-i pipe:0 -an -f rawvideo -pix_fmt rgb24 pipe:1`, keep the last `w×h×3` bytes, encode PNG in Rust (`image` crate). 14 s take: 0.24 s, 1.07 GB streamed, nothing kept but one frame | `-sseof -0.1` / input-side `-ss` make the demuxer seek, which a pipe cannot ("partial file") |
| Concat + loudnorm | Unchanged filter graph, output `-f mp4 -movflags frag_keyframe+empty_moov+default_base_moof pipe:1` (fragmented MP4, 10.67 MB vs 10.68 MB for the file version, 1.5 s) | `-movflags +faststart` needs a seekable output |
| Poster | `-i pipe:0 -frames:v 1 -q:v 3 -f image2pipe -c:v mjpeg pipe:1` from the fMP4 bytes | — |
| In-RAM seekable files | — | macOS `shm_open` fds refuse `write`/`lseek` (ENXIO / ESPIPE, tested); no tmpfs by default; a RAM disk is a mounted volume visible to every process |

Plaintext inventory for one vault render/assembly, exactly:
1. The app process: decrypted take bytes, the raw last frame, the PNG, the fMP4 and poster bytes —
   all in `Zeroizing` buffers, dropped after sealing.
2. Kernel pipe buffers between the app and ffmpeg (at most 64 KiB per pipe at any moment).
3. The ffmpeg process: demuxed packets, decoded frames, encoder state; gone when it exits.
4. Nothing on disk: no temp file, no FIFO node, no `stories-tmp/` (that directory is removed; the
   General path uses the pipes too). libx264 and single-pass `loudnorm` write no scratch files;
   the fragmented muxer never seeks; ffmpeg runs with `-nostdin -hide_banner -loglevel error` and
   its stderr is captured by the app (only the last three lines reach an error message).
5. Same as today, outside the vault's threat model: process memory may be paged to macOS's
   encrypted swap; a crashed ffmpeg produces no core dump on a default macOS.

Consequences: the General final film becomes a fragmented MP4 written to `videos/<id>.mp4`
(WebKit, QuickTime and ffmpeg play it; the workspace player and Export use it as a file). General
continues-shots no longer write `stories-tmp/<uuid>.png`: the frame goes straight to
`references::import_bytes` (General) or `seal_verified` (vault).

Rejected:
- *A documented exception: plaintext temp files in a 0700 dir inside `vault/`, deleted right
  after.* Would contradict `vault.rs:42-43` ("Plaintext is never written to disk by this module"),
  and APFS gives no overwrite guarantee (`vault.rs:16-17`), so a crash mid-assembly leaves
  recoverable frames on disk. Not honest.
- *Decoding in memory without ffmpeg.* No audited pure-Rust H.264/AAC decoder and encoder to lean
  on; ffmpeg stays.

### 3.3 Reference images of vault characters (problem 3)

- Storage: sealed blobs, imported through the existing `import_reference(_bytes)` with
  `destination: "vault"` (`vault_migrate::import_reference_to_vault`, downscaled to ≤ 1 MP first).
  A gallery pick of a vault image re-seals the downscaled copy (`import_reference` with a
  `vault://` path, `commands.rs:448-451`); a General gallery image picked for a vault character
  is imported with `destination: "vault"`. A General character only accepts General images, as now.
- Upload to the pod: unchanged from today's vault image/video jobs — `jobs::load_reference`
  (`jobs.rs:322-357`) decrypts the blob in memory and sends it base64 in the job input over
  HTTPS to the pod; the pod decodes references and the start image into ComfyUI's input folder on
  its container disk for the duration of the job and cleans up between jobs
  (`worker/src/handler.py:197-286, 717`). The pod is outside the vault's threat model (§4).
- Thumbnails: the `vault://localhost/<blob>.<ext>` URL is used directly as `<img src>`
  (`api.fileSrc` passes vault URLs through); 403 while locked, so a stale chip shows nothing.
- `Character.ref_paths` (new, read-only, serde default): display paths filled by the router —
  the `references/<id>.<ext>` file for General, the vault URL for vault — so the edit form can
  show the current images without the UI reconstructing paths.
- A continues shot's first frame is sealed as a `png` blob and used as `init_image` of the take,
  which `load_reference` already accepts for a vault job.

### 3.4 Lock and unlock (problem 4)

Backend:
- A render that already started keeps running: its job input (prompt, base64 references) is in
  the job's memory; the output is sealed with the public key (`seal_output` → `put_item`,
  works locked), `job-update` is redacted as today (`jobs.rs:1262-1272`), and the take appears
  after the next unlock. The `save_video` orphan check (`jobs.rs:1092-1099`) is skipped for a
  vault story while locked: a shot cannot be removed while it renders (`refuse_rendering`) nor at
  all while locked, so the take cannot be orphaned.
- `Core.story_renders` (`state.rs:110`) is unchanged: it maps shot id → job id, both random UUIDs.
  Entries of vault stories stay through a lock; `rendering()` still prunes finished jobs.
- Approve, assemble, plan, save shots/story, edit/delete character, delete story: refused while
  locked with `VAULT_LOCKED: Unlock the vault to …` (the router returns it; nothing is changed).
  A plan in flight when the vault locks loses its result: `store_shots` fails with `VAULT_LOCKED`,
  the LLM output was only in memory.
- The job card label of a vault story is `Vault story · shot N` — never the title: `Job.label` is
  emitted while locked (`jobs.rs:166-170`). General stories keep `Story: {title} · shot N`.
- `vault_unlock` loads characters and story docs with the items (one pass over three folders).

UI (`useVault().unlocked` / `lockEpoch`, `state/vault.tsx:134-178`):
- `StoriesPanel` reloads stories and characters whenever `unlocked` changes: vault entries appear
  on unlock and vanish on lock. The picker marks vault stories with a lock icon.
- If the selected story is a vault story and the vault locks, the workspace shows a lock screen
  ("This story is in the vault. Unlock to continue." + Unlock button → `vault.requestUnlock()`),
  pending shot/voice/title edits are dropped (toast: "Vault locked — unsaved edits to this story
  were discarded"), and the panel form resets. The selection is kept, so unlocking brings the story
  straight back (the workspace remounts on `lockEpoch`).
- A take sealed while locked raises the existing "N videos saved to the vault — Unlock to view"
  notice (`state/vault.tsx:181-200`); the workspace refetches on unlock.

### 3.5 Planner (problem 5)

The brief, style, title, cast names + descriptions and voices of a vault story go to LM Studio at
`http://localhost:1234/v1` in plain HTTP over loopback, exactly as for General stories; nothing
else (no images, no takes). LM Studio is another process on the same Mac and may keep its own
server logs or conversation history on disk — that is outside the vault's threat model (§4) and
is stated in the UI hint next to "Save to: Vault". No change to `planner.rs`.

### 3.6 Story rows out of both galleries (problem 6)

- General: `Db::list_images` filters `story_id IS NULL` (today only `shot_id IS NULL`,
  `db.rs:350`), so the assembled film goes too. `all_image_ids` already skips story rows
  (`db.rs:431`).
- Vault: `Vault::gallery_items()` = items with `story_id == None`; `list_vault_items`
  (`commands.rs:753`) and `VaultStatus.item_count` (`vault.rs:753`) use it. `items()` keeps
  returning everything for internal use (deletion, GC, story takes).
- Live events: `CreateScreen` drops `job-update` outputs with `storyId` or `shotId`
  (`CreateScreen.tsx:809-815`, today `shotId` only); `refreshGalleryTop` after a story change goes.
- `move_to_vault` keeps refusing story media (`vault_migrate.rs:19-20, 305-307`), message updated
  to "Story videos are managed from the Stories tab".

### 3.7 Migration (problem 7)

None. SQLite schema unchanged (`vault` is not a column: SQLite rows are General by definition).
`Story.vault` / `Character.vault` default to `false` on read. Existing General data stays.

### 3.8 Shot submission order (decision D)

Today every queued job spawns a task (`jobs.rs:859`) that waits for the pod in
`worker::client_for` → `pod::ensure_running_as` (`pod.rs:1660-1706`, a `watch` channel), then
calls `client.run` (`jobs.rs:1205`). When the pod turns Running every waiter wakes and the HTTP
`/run` calls race, so ComfyUI's queue order is arbitrary.

**Chosen: a submission ticket.** `start_job` takes a ticket from a per-profile counter at queue
time (synchronously, in the caller's order — `render_story` calls `render_shot` in position
order, `render.rs:189-204`) and the spawned task waits, after the pod is ready and before its
first `/run`, until it holds the lowest outstanding ticket of its profile. The ticket is released
when the job's `/run` calls are done or when the task leaves early (pod start failed, cancelled)
— a guard with `Drop`, so a failed job never blocks the ones behind it. ~40 lines in `jobs.rs`
plus one field on `Core`; no change to the pod code or the worker.

Rejected: *a `tokio::sync::Mutex` around wait-for-pod + submit* — acquisition order is the order
tasks reach the lock, which is the arbitrary wake order, not the queue order.

### 3.9 Rules between the stores

| Rule | Where enforced | Message |
|---|---|---|
| A General story may not cast a vault character | `repo::check_cast` on create/update | "A General story can't use a vault character. Create the story as a vault story." |
| A vault story may cast General characters | — (allowed) | |
| Creating a vault story or character needs a vault that is unlocked | `create_story` / `save_character` | `VAULT_LOCKED: Unlock the vault to create a vault story` / `NO_VAULT: Create the vault first (Gallery → Vault)` |
| A story's store is fixed | `update_story` ignores `vault` | — |
| Cast names must differ (name uniqueness is per store) | `check_story` / `preflight` | "Two cast members are both named {X}. Rename one." |
| Deleting a character used by a visible story is refused (as today) | `repo::delete_character` | "{name} is used by story \"{title}\"" |
| Deleting a General character while a vault exists and is locked is refused (a locked vault story may use it) | `repo::delete_character` | "Unlock the vault first: a vault story may use this character" |
| A vault character's references are vault blobs; a General character's are `references/` ids | `repo::save_character` | "Reference images must be in the same place as the character" |

## 4. Threat-model statement for vault stories

Inherits `vault.rs:3-17`. For a vault story, **protected while the vault is locked** against
someone who can read the app data directory (backups, a copied disk, another local account, a
stolen unlocked Mac):

- Character names, descriptions, source/consent flags and reference images.
- Story title, logline, brief, style, voices, the planner's sidecar, and every shot's setting,
  camera, action, dialogue and sound.
- Every take (video + poster + thumbnail + the references and first frame it was rendered with)
  and the final film with its poster. The compiled prompt is in the take's item record (sealed).
- The SQLite database holds none of it (unchanged rule); `timings.jsonl` holds timings only
  (`state.rs:163-167`); `app.log` never carries story text (the job log lines log model, size and
  count — `jobs.rs:820-834` — and this design adds the rule that no title, brief or shot text is
  ever logged).

**Visible to that attacker** (as for vault items today): that a vault exists; the number, sizes
and timestamps of `vault/characters/*.bin`, `vault/stories/*.bin`, `vault/items/*.bin` and
blobs; the item/story/character UUIDs (file names).

**Not protected — by design, and stated in the UI**:
- The GPU pod: it receives the compiled prompt, reference images and the first frame in plaintext
  over HTTPS and returns the video; it writes them to its container disk for the job. This is the
  existing behaviour of every vault image and video job.
- LM Studio on this Mac: receives the brief, style, names, descriptions and voices over
  loopback HTTP and may keep its own logs.
- The running app and ffmpeg child processes while the vault is unlocked (private key in memory),
  including the WebKit webview that renders the workspace; the `vault://` scheme answers 403 and
  the UI drops its copies on lock, but nothing is claimed about process memory.
- Job cards while locked: "Vault story · shot N", the job's progress and timings. Not the title.
- Encrypted swap and crash dumps: macOS defaults, not something the app enforces.

## 5. Data model

Rust (`stories/mod.rs`):

```rust
pub struct Character { …, #[serde(default)] pub vault: bool,
    /// Display paths for the UI (General: references/<id>.<ext>; vault: the vault URL). Read-only.
    #[serde(default)] pub ref_paths: Vec<String> }
pub struct Story { …, #[serde(default)] pub vault: bool }
/// One sealed record per vault story (`vault/stories/<id>.bin`).
pub struct StoryDoc { pub story: Story, pub shots: Vec<Shot>, #[serde(default)] pub sidecar: Option<serde_json::Value> }
pub struct StoryView { …, /// The assembled film (General record or vault item), if any.
    pub result: Option<ImageRecord> }
```

`vault.rs`: `VaultItem { …, #[serde(default)] story_id: Option<String>, #[serde(default)] shot_id: Option<String> }`;
`Unlocked { secret, items, characters, stories }`.

New `Vault` methods (all `Result<_, String>`, locked → `VAULT_LOCKED` unless noted):
`put_character`, `character(id)`, `characters()`, `delete_character(id)` (also deletes blobs no
item or character still references); `put_story_doc`, `story_doc(id)`, `story_docs()`,
`delete_story_doc(id)`; `story_file_exists(id)` / `character_file_exists(id)` (work locked;
file-name check only); `gallery_items()`; `items_for_story(story_id)`.

TypeScript (`api/types.ts`): `Character.vault`, `Character.refPaths`, `Story.vault`,
`StoryView.result: ImageRecord | null`; `createStory` input gains `destination?: Destination`;
`saveCharacter` sends `vault` (honoured for a new character only).

Commands (additive): `create_story { …, destination? }`; `get_story` may return
`VAULT_LOCKED: …`; `list_stories` / `list_characters` include vault entries only while unlocked;
new `reveal_image { id }` (General records only: `tauri_plugin_opener::reveal_item_in_dir`,
as `reveal_settings_file` does at `commands.rs:81-86`); `export_image` already falls through to
`export_vault_item` for a vault id (`commands.rs:638-649`).

Files on disk (new): `vault/characters/<uuid>.bin`, `vault/stories/<uuid>.bin`. Removed:
`<data>/stories-tmp/`.

## 6. Flows

**Create.** Panel → "Save to: General | Vault" (shown only when a vault exists; Vault disabled
while locked with "Unlock the vault to create a vault story"). `create_story` with
`destination: "vault"` → `repo::save_story` seals the doc (vault must be unlocked) → `story_view`.
A vault story's picker entry carries a lock icon. New character from a vault story defaults to
"Keep in vault" (toggle, new characters only).

**Plan.** `plan_story` → `repo` reads story + cast (vault: from the cache) → LM Studio (§3.5) →
`store_shots` → `repo::replace_shots` rewrites the sealed doc → `save_story`. Locked anywhere in
between → `VAULT_LOCKED`, nothing changed.

**Render one shot** (`render_shot`): as today, except `compile_shot` references are the
character's current `ref_ids` (vault URLs for vault characters, accepted by `load_reference`
because the job's destination is Vault); `destination` = the story's store; `label` per §3.4;
`VideoRequest.story_take` unchanged. For a continues shot: `take_bytes(prev approved take)`
(General: read the file; vault: `open_blob`) → `ffmpeg::last_frame_png(bytes, w, h)` → General:
`references::import_bytes`; vault: `seal_verified(png)` → `init_image_id`.

**Render all**: unchanged logic; submission order guaranteed by §3.8.

**Take arrives** (`save_video`): General unchanged; vault → `seal_output` with `story_id/shot_id`
on the template record (works locked), `vault-update` emitted, `job-update` redacted while locked.

**Approve**: `repo::get_take` (General row or vault item; vault locked → `VAULT_LOCKED`),
`repo::set_approved` (vault: rewrite the doc), then the existing "render the next continues shot".

**Assemble**: `repo` gathers the approved takes' bytes (vault: `open_blob`, unlocked only) →
`ffmpeg::assemble(inputs: &[Vec<u8>]) -> Vec<u8>` (pipes, §3.2) → `ffmpeg::first_frame_jpg(bytes)`
→ General: write `videos/<id>.mp4` + poster, insert row; vault: `seal_output(template with
story_id, film, poster)`; then `repo::set_result` (vault: doc) and delete the previous film
(General `delete_record` / vault `delete_item`). The sidecar goes into the doc (vault) or the
`sidecar_json` column (General).

**Watch / Show in Finder / Export** (workspace "Final film" section, replaces today's "the story
video is in the gallery" notice, `StoryWorkspace.tsx:785-792`): `<video controls>` with
`fileSrc(result.path)` and the poster; **Show in Finder** (General only) → `reveal_image`;
**Export…** → `api.pickSavePath("<title>.mp4")` → `api.exportImage({ id, destPath })`. For a vault
film the inline confirmation from the Lightbox is reused word for word: "The exported copy is
**not encrypted** — anyone with access to where you save it can open it."

**Delete story**: refused while a shot renders (as today); deletes takes and film in the story's
store, then the row/doc. **Delete character**: §3.9.

**Lock / unlock**: §3.4.

## 7. UI changes

- `StoriesPanel`: Save-to segmented control for a new story; lock icon on vault stories; cast menu
  rows show a lock tag for vault characters and are disabled for a General story (title "Only a
  vault story can use a vault character"); pencil (`Icon name="edit"`, new path) on every cast chip
  and an Edit button on every menu row → `CharacterForm` in edit mode; reload lists on `unlocked`.
- `CharacterForm`: `character?: Character` prop → title "Edit character", fields prefilled,
  `refs` from `refPaths`; "Keep in vault" toggle (new character only; needs an unlocked vault);
  imports use the character's store; the gallery picker allows vault images for vault characters.
  Save keeps the id. Hint under the toggle: "Encrypted in the vault. The GPU pod and LM Studio
  still see what they need to render and plan."
- `StoryWorkspace`: Final film section (player, Show in Finder, Export…); lock screen for a vault
  story while locked; the job label; "Assembled" copy no longer mentions the gallery.
- `CreateScreen`: job-update gallery filter by `storyId`; no `refreshGalleryTop` on story changes;
  `storyItem` lightbox still opens takes from the workspace (vault takes play through `vault://`).
- Settings: none. Gallery / Lightbox: none beyond the Rust-side filtering.
- Mock (`api/mock.ts`): `vault` on characters/stories; vault entries hidden while the mock vault is
  locked; `get_story` of a hidden vault story throws `VAULT_LOCKED: …`; story rows never in
  `list_images` / `list_vault_items`; `reveal_image` no-op; `result` on the view.

## 8. Error copy

| Situation | Message |
|---|---|
| Opening/editing a vault story while locked | `VAULT_LOCKED: Unlock the vault to open this story` |
| Approve / assemble / plan while locked | `VAULT_LOCKED: Unlock the vault to approve takes` / `… to assemble the story` / `… to plan the story` |
| Creating a vault story/character while locked | `VAULT_LOCKED: Unlock the vault to create a vault story` / `… a vault character` |
| No vault yet | `NO_VAULT: Create the vault first (Gallery → Vault)` (existing) |
| General story with a vault character | A General story can't use a vault character. Create the story as a vault story. |
| Two cast members share a name | Two cast members are both named {X}. Rename one. |
| Deleting a General character while the vault is locked | Unlock the vault first: a vault story may use this character |
| Character references in the wrong store | Reference images must be in the same place as the character |
| Take or film missing | The approved take's video is missing (existing) |
| ffmpeg could not read a take | Could not read the take's video (ffmpeg: {last lines}) |
| Last frame could not be decoded | Could not read the last frame of shot {N} |
| Vault locked mid-plan | The vault locked while planning; unlock and plan again |
| Show in Finder on a vault film | (button hidden; the tooltip on Export says "Vault films are exported as an unencrypted copy") |
| Workspace lock screen | This story is in the vault. Unlock to continue. |
| Toast on lock with pending edits | Vault locked — unsaved edits to this story were discarded |

## 9. Testing strategy

Rust (`cd app/src-tauri && cargo test`, `cargo clippy --all-targets -- -D warnings`):
- `vault.rs`: character / story-doc round trip; locked → `VAULT_LOCKED`; file names only visible;
  nothing in `vault/` contains the brief/action text or a reference's bytes; `Drop` wipes;
  blob GC keeps a blob shared by a take item; `gallery_items` and `item_count` exclude story media.
- `repo.rs`: routing by id across both stores; vault entries absent while locked; `get_story` of a
  locked vault story → `VAULT_LOCKED`; rules of §3.9.
- `ffmpeg.rs` (real ffmpeg, skipped when missing): assemble two synthetic clips from bytes to
  bytes; last frame of a clip equals a known colour; poster from the fMP4 bytes; the test's
  data directory has the same file list before and after; a moov-at-end input fails with a clear
  message (documents the assumption about the worker's files).
- `tests/stories.rs` / `tests/vault.rs`: a vault story rendered against the mocked pod seals a
  take with `story_id/shot_id`; the same with the vault locked between queue and completion;
  approve/assemble with the vault unlocked produces a sealed film and `list_vault_items` does not
  list it; after the whole run a walk of the data directory finds no plaintext needle (brief,
  action text, the take's MP4 bytes) outside `studio.db` for General rows — the pattern of
  `vault_adversarial.rs`.
- `tests/jobs.rs`: three jobs queued while the pod is not ready are submitted (`/run`) in ticket
  order; a job that fails before submitting does not block the next.
- `db.rs`: `list_images` hides takes *and* films; `list_takes` still returns takes.
Frontend (`cd app && npx tsc --noEmit && npm run build`) and the mock walk: create a vault
character → vault story → plan → render → approve → assemble → watch in the workspace → export;
lock the mock vault → the story disappears and the workspace shows the lock screen → unlock →
back. Edit a character (rename, replace an image) → the next render's job uses the new image.
Real run (paid, owner confirms): one vault story end to end; `ls -la` of the data dir during
assembly shows no new file.

## 10. Open points for the owner

1. The final film is a fragmented MP4 for both stores (§3.2). Fine for playback and export; if a
   classic moov-first MP4 is wanted for sharing, Export could remux (`-c copy -movflags
   +faststart`) to the chosen path — General only (it needs a seekable output), vault stays fMP4.
2. Vault films and takes count toward the vault's size but not toward "N items in the vault".
3. Deleting a General character while the vault is locked is refused (§3.9) — the safe default;
   the alternative (allow, and let a locked vault story lose a cast member) was rejected.
