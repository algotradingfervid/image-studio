# Stories: brief → consistent video (v1) — design

Date: 2026-10-13 · Owner: Naren · Status: approved in chat, awaiting spec review
Source: "Brief-to-Video Pipeline Build Plan (Qwen + MiniMax H3 on RunPod).pdf", adapted to
Image Studio and cut to a simple first version at the owner's request ("a consistent video
creator first without too much complexity … not go for perfection").

## 1. Goal and success criteria

Type a simple prompt and a target length; get back one finished video that tells a story with
the same characters in every shot and spoken dialogue taken from the story.

v1 is done when, in the real app:
1. With 2 AI-generated characters, a 1-minute brief produces a validated shot list (4–10 shots)
   with no manual fixing in at least 4 of 5 tries (Gemma 4 26B via LM Studio).
2. All shots render as H3 Character jobs, each reviewable with Approve / Reroll / Edit.
3. Assemble produces one MP4 in the gallery (or vault) with every approved shot in order,
   dialogue audible, loudness normalized.
4. The whole flow also runs in the browser mock (no GPU, no LLM) for UI work and review.

## 2. Design rules

- **The LLM writes content; code writes prompts.** The planner never produces H3 prompt text.
  Character descriptions, `<Picture N>` numbering, style and limits are filled in by code, so
  they cannot drift between shots (from the PDF).
- **Reuse the app.** Rendering goes through the existing job queue, H3 Character model
  (`h3ref`), GPU start/stop/retry, paid-GPU confirmation, Save-to (gallery/vault) and gallery.
- **Adults only, always.** Hard rule in the planner prompt, the validator and the character form.
- **Simple consent gate.** A character is `generated` (AI-made images) or `real_person`;
  a real person requires the owner to tick "I have this person's consent to use their likeness".
  Untick → the character cannot be planned or rendered. (Full consent registry: later.)

## 3. User flow — the Stories screen

A fourth top-level screen, **Stories**, beside Create / Models / Settings. Left: list of
stories (+ New story). Right: the selected story in four steps.

1. **Cast** — pick 1–2 characters for this story from the character library, or create one:
   - name (unique), 1–3 reference images (import file / gallery / vault — same pickers as
     Create references), locked description (one line, ≤ 200 chars, e.g. "woman in her 30s,
     short black hair, green bomber jacket"),
   - source: AI-generated / Real person (+ consent tick), and a required "This character is an
     adult (18+)" tick.
   - Characters are reusable across stories. Editing a character affects future renders only.
2. **Brief** — prompt (free text), target length (30 s – 3 min, step 15 s), aspect (16:9,
   9:16, 1:1 → H3 Character presets 1344x768 / 768x1344 / 768x768), optional style line
   (≤ 300 chars, e.g. "35 mm film, warm grain, handheld"). **Plan story** button.
3. **Plan** — shows title + logline and the shot list. Each shot card: number, duration,
   characters, setting, camera, action, dialogue lines, continuity (Cut / Continues previous).
   Every field is editable; shots can be added, deleted, reordered. **Re-plan** discards the
   list (confirm). Validation errors are shown per shot and block rendering.
4. **Render & review** — **Render all** queues every unrendered *cut* shot in order (one
   paid-GPU confirm as today); a *continues* shot is queued automatically once its previous
   shot has an approved take (its card says "Waits for shot N to be approved"). Each shot card shows its current take (video player), status, and:
   **Approve**, **Reroll** (same text, new seed), **Edit & re-render** (opens the shot text).
   Earlier takes stay listed (newest first) and any take can be approved instead.
   **Assemble** is enabled when every shot has an approved take.

## 4. Planner (local LLM)

- Endpoint: OpenAI-compatible chat completions. Settings → Stories: base URL (default
  `http://localhost:1234/v1`, LM Studio) and model id (default: the first model the server
  lists; Gemma 4 26B is installed today). If unreachable: inline message "Start LM Studio's
  server (Developer → Start server, or `lms server start`) and load a model".
- One request per plan (simplicity over the PDF's three passes), temperature 0.6, with
  `response_format: {type: "json_schema", ...}` (structured output). If the server rejects
  `json_schema`, fall back to plain JSON with the schema in the prompt and parse the first
  JSON object. (To verify against LM Studio's API during implementation.)
- System prompt contents (template in code, `stories/planner_prompt.txt`):
  role ("film writer and director"); the character ids/names/descriptions it may use and
  nothing else; all characters are adults; hard limits (shot 5–15 s, ≤ 2 characters per shot,
  ≤ 2.5 spoken words per second, total ≈ target); "describe action that runs through the
  whole shot, never a frozen frame"; dialogue must come from the story; one complete example.
- Output schema:
  ```json
  { "title": "…", "logline": "…",
    "shots": [ { "duration_s": 10, "characters": ["mara"], "setting": "rooftop at night",
                 "camera": "medium close-up, slow push-in", "continuity": "cut",
                 "action": "…",
                 "dialogue": [ {"speaker": "mara", "line": "…"} ] } ] }
  ```
- Repair loop: on validation failure, send the previous output + the exact error list back
  (same conversation), up to 3 attempts; after that, show the best attempt with its errors
  for manual editing.

## 5. Validator (Rust, deterministic)

Runs after planning and after every manual edit. Per shot / story:

| Rule | Check |
|---|---|
| Duration | 5 ≤ duration_s ≤ 15 (H3 trained range ~5–15 s) |
| Total | sum within ±15 % of target |
| Cast | 0–2 characters, every id in this story's cast |
| Dialogue speaker | speaker is one of the shot's characters |
| Dialogue fit | total words in the shot ≤ 2.5 × duration_s |
| Continuity | first shot is `cut`; `continues` requires the previous shot to share ≥ 1 character |
| Adult rule | no character/action/dialogue text matches the under-18 term list (child, kid, minor, teen, schoolgirl, schoolboy, underage, "years old" with a number < 18, …) |
| Consent | every cast character: adult ticked; real_person → consent ticked |
| Prompt length | compiled prompt ≤ 7,000 chars |
| References | ≤ 9 images per shot (2 characters × 3 images = 6 max) |

## 6. Prompt compiler (Rust)

Fixed reference order per shot: character A images, then character B images (in cast order),
numbered `<Picture 1>`…; the compiled text (H3 five-block style, from the PDF):

```
ROLES:
<Picture 1>, <Picture 2> are Mara: woman in her 30s, short black hair, green bomber jacket.
Keep her face, hair, body and clothing identical to these pictures.
SHOT ({duration}s, {aspect}, {camera}): {setting}.
{action}
Mara says: "…"
LOOK: {style line, or "natural cinematic look"}
SOUND: natural ambient sound of the setting. Dialogue is spoken aloud and lip-synced to the speaker.
LIMITS: Hold identity and clothing from the pictures. No subtitles, no on-screen text,
no watermark, no extra people, no face morphing.
```

Locked descriptions and the style line are pasted verbatim into every shot. The compiled
prompt, reference list and seed are stored with each take.

## 7. Rendering

- Each take = one normal `generate_video` job: model `h3ref`, compiled prompt, the shot's
  character reference images, duration = shot duration, resolution from the aspect, audio on,
  steps = model default, a random seed, destination = the story's Save-to. Jobs appear in the
  existing job list (labelled "Story: {title} · shot N").
- **Continues previous** (worker change): `generate_video` for `h3ref` accepts an optional
  `initImage`; the graph adds `MiniMaxH3AddGuide(positive, vae, latent, image, frame_idx=0)`
  between `MiniMaxH3ReferenceToVideo` and the guider (node verified in ComfyUI v0.39.0
  `nodes_minimax_h3.py`). The app extracts the previous shot's approved take's last frame on
  the Mac (`ffmpeg -sseof -0.1 -i prev.mp4 -frames:v 1 last.png`). A continues shot renders
  only after its previous shot has an approved take.
- **First task of the build is a GPU spike (~$1):** does ref2va honour the frame-0 guide?
  If not, "Continues previous" is hidden and every shot is a cut; nothing else changes.
- Takes are stored as video records with `story_id`/`shot_id` set and are hidden from the
  normal gallery (shown only inside the story). Vault stories seal takes like other vault
  videos (existing `seal_output`).

## 8. Assembly (Mac, ffmpeg)

- ffmpeg located at `/opt/homebrew/bin/ffmpeg`, `/usr/local/bin/ffmpeg` or PATH; missing →
  message "Install ffmpeg (brew install ffmpeg)".
- One ffmpeg run: concat filter over the approved takes in shot order, re-encoded H.264
  (crf 18) + AAC 48 kHz stereo, `loudnorm=I=-14:TP=-1.5:LRA=11`, optional "AI-generated"
  label (drawtext, bottom-right, small, on by default) and `comment=AI-generated` metadata.
  Vault stories: inputs decrypted to a private temp dir, output sealed, temp wiped.
- Result saved as a normal gallery video (kind video, `story_id` set, poster = first frame),
  visible in the gallery; re-assembling replaces the story's previous result.
- A sidecar JSON (shots, prompts, seeds, character ids) is stored with the story record.

## 9. Data (SQLite, `db.rs` migrations)

- `characters(id, name, description, source[generated|real_person], consent INTEGER,
  adult INTEGER, refs_json, created_at, updated_at, vault INTEGER)`
- `stories(id, title, logline, brief, target_s, aspect, style, cast_json, destination,
  status, result_image_id, sidecar_json, created_at, updated_at)`
- `shots(id, story_id, position, duration_s, characters_json, setting, camera, action,
  dialogue_json, continuity, approved_take_id)`
- `images` gains nullable `story_id`, `shot_id` (takes and results); gallery queries exclude
  rows with `shot_id` set.
- Character reference images use the existing references store / vault blobs (`refs_json` =
  reference ids, same as image jobs).

## 10. Code layout

- Worker: `workflows.py` `_h3ref` optional first-frame guide; handler accepts `initImage` for
  r2v; fixture + tests.
- Rust: `stories/` module — `planner.rs` (LLM client + repair loop), `validate.rs`,
  `compile.rs`, `assemble.rs` (ffmpeg), `store.rs` (tables), commands in `commands.rs`.
- TS: `screens/stories/` (StoriesScreen, CastStep, BriefStep, PlanStep, RenderStep,
  CharacterForm), `api` types + mock (canned plan, instant renders).
- Settings: LLM base URL + model.

## 11. Testing

- Rust unit tests: validator (each rule, pass and fail), compiler (golden prompt text,
  reference order), planner (mock HTTP server: json_schema path, fallback path, repair loop
  with 2 failures then success, 3 failures → errors shown), assembly (ffmpeg command
  construction; one real ffmpeg run on two generated test clips when ffmpeg is present).
- Worker tests: h3ref graph with and without first frame validated against the fixture.
- Mock-driven UI walk: create 2 characters → brief → plan → edit a shot → render → approve
  → assemble.
- Real run (paid, owner confirms): GPU spike first; then one 1-minute story end to end.

## 12. Out of scope (later, in this order of likely value)

Voice references (`<Audio N>` per character), draft/final tiers (turbo LoRA), face-similarity
QC, full consent registry (releases, ID, revocation), H3 edit path, colour grading/LUT,
music bed, multi-pass planning.
