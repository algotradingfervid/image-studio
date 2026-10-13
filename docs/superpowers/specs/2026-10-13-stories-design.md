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
   with no manual fixing in at least 4 of 5 tries (Qwen 3.8 27B uncensored via LM Studio).
2. All shots render as H3 Character jobs, each reviewable with Approve / Reroll / Edit.
3. Assemble produces one MP4 (shown in the story's workspace) with every approved shot in order,
   dialogue audible, loudness normalized.
4. The whole flow also runs in the browser mock (no GPU, no LLM) for UI work and review.

## 2. Design rules

- **The LLM writes content; code writes prompts.** The planner never produces H3 prompt text.
  Character descriptions, `<Picture N>` numbering, style and limits are filled in by code, so
  they cannot drift between shots (from the PDF).
- **Reuse the app.** Stories is a Create tab beside Image and Video. Rendering goes through the existing job queue, H3 Character model
  (`h3ref`), GPU start/stop/retry, paid-GPU confirmation and gallery.
- **Adults only, always.** Hard rule in the planner prompt, the validator and the character form.
- **Simple consent gate.** A character is `generated` (AI-made images) or `real_person`;
  a real person requires the owner to tick "I have this person's consent to use their likeness".
  Untick → the character cannot be planned or rendered. (Full consent registry: later.)

## 3. User flow — the Stories tab on Create

A third tab in Create's mode switch: **Image · Video · Stories** (owner, 2026-10-13).
Same layout as the other two tabs:
- **Left panel** (where the Image form / Video panel sit): story picker (+ New story) and the
  Cast and Brief steps, with **Plan story** at the bottom.
- **Right area**: the job list stays on top as today; below it, in place of the gallery while
  the Stories tab is active, the selected story's workspace — Plan (shot list) and Render &
  review (shot cards) — plus **Assemble**. Switching back to Image or Video shows the gallery
  again. Assembled videos stay in the story's workspace (not the gallery).
- ~~v1 stories save to the general gallery only.~~ Superseded by
  `2026-10-13-stories-vault-design.md` (vault stories and characters, Save-to on new stories).
  Character reference images come from import or the general gallery.

The steps:

1. **Cast** — pick 1–2 characters for this story from the character library, or create one:
   - name (unique), 1–3 reference images (import file / general gallery — same pickers as
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
  `http://localhost:1234/v1`, LM Studio) and model id (default
  `qwen3.8-27b-uncensored-optiq` = `mlx-community/Qwen3.8-27B-Uncensored-OptiQ-4bit`,
  19.8 GB, owner's choice 2026-10-13; if that id is not listed, the first model the server
  lists). Qwen 3 thinking: the request sends `chat_template_kwargs: {"enable_thinking": false}`
  and the client strips any `<think>…</think>` block before parsing. If unreachable: inline message "Start LM Studio's
  server (Developer → Start server, or `lms server start`) and load a model".
- One request per plan (simplicity over the PDF's three passes), temperature 0.6, with
  `response_format: {type: "json_schema", ...}` (structured output). If the server rejects
  `json_schema`, fall back to plain JSON with the schema in the prompt and parse the first
  JSON object. (To verify against LM Studio's API during implementation.)
- System prompt (`SYSTEM_PROMPT` in `stories/planner.rs`; text from the H3 prompt research
  `.superpowers/sdd/2026-10-13-stories/h3-prompt-research.md` §3b): role ("film writer and
  director", fields are read literally by the video model, only what can be seen or heard,
  present tense); the character names/descriptions it may use and nothing else; all
  characters are adults; hard limits (shot 5–15 s, ≤ 2 characters per shot, ≤ 2.5 spoken words
  per second **and the last line ends at least 1 s before the shot ends**, total ≈ target,
  continuity rules, never describe face/hair/body/clothing); per-field writing rules:
  - `voices` (once per film): one phrase per speaking character (gender, age range, pitch,
    timbre, pace, accent), reused word for word in every shot;
  - `setting`: 1–2 sentences, place, time, light, weather, 2–3 concrete props, no characters;
  - `camera`: one sentence, shot size, who stands where, exactly one move from MiniMax's list
    (static shot, push in, pull out, pan, truck, tilt, pedestal, arc, tracking, zoom, shake
    slightly) with optional "with small/large amplitude", "at slow/fast speed";
  - `action`: 3–6 sentences, 50–120 words, in order, ending on a held state; names, never
    spoken words; the first sentence is the opening state before anyone speaks;
  - `dialogue`: `line` word for word, no quotation marks, ends with . ? or !; `delivery` = what
    the speaker does while saying it and how ("turns her head toward Ivo and says quietly");
  - `sound`: 1–2 sentences of real sounds in the shot, no dialogue, no music.

  One complete example (the research §3b rooftop plan, the first two cast names substituted;
  a one-character variant when the cast has one character).
- Output schema:
  ```json
  { "title": "…", "logline": "…",
    "voices": [ {"name": "Mara", "voice": "a low, steady female voice with a calm pace"} ],
    "shots": [ { "duration_s": 10, "characters": ["Mara"], "continuity": "cut",
                 "setting": "…", "camera": "…", "action": "…",
                 "dialogue": [ {"speaker": "Mara", "delivery": "…", "line": "…"} ],
                 "sound": "…" } ] }
  ```
  Names map to character ids (case-insensitive); an unknown name (in `characters`, `speaker`
  or `voices`) becomes the issue "X is not in the cast". The plan's voices are saved on the
  story (`Story.voices: [{characterId, voice}]`); a partial list is fine, and saving a story
  drops entries for characters no longer in the cast.
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
| Delivery | each dialogue line's `delivery` ≤ 15 words, no double quotes |
| Line quotes | dialogue `line` has no double quotes (quotes mean on-screen text to H3) |
| Adult rule | no character/action/dialogue/delivery/sound text matches the under-18 term list (child, kid, minor, teen, schoolgirl, schoolboy, underage, "years old" with a number < 18, …); voice phrases (story-level, checked before planning and rendering and on the planned voices) also refuse girl/boy/girlish/boyish/childlike/childish |
| Consent | every cast character: adult ticked; real_person → consent ticked |
| Prompt length | compiled prompt ≤ 7,000 chars |
| References | ≤ 6 character images per shot (2 characters × 3 images); `h3ref` maxReferences is 7 = 6 character images + 1 first frame for a continuing shot (node allows 9) |

## 6. Prompt compiler (Rust)

The compiled text follows MiniMax H3's official ref2va "Context IR" format (MiniMax-H3
`docs/VIDEO_PROMPT_WRITING_GUIDE_ref_en.md`; research §1–§3a): six sections in fixed order,
header on its own line, a blank line between sections. `compile_shot(story, shot, cast,
has_first_frame)` returns the prompt and the character reference ids.

Rules (deterministic):

1. Subjects = the shot's characters in cast order, labelled `<Subject 1>`, `<Subject 2>`.
   Pictures: all of subject 1's references, then subject 2's, as `<Picture 1>`…
2. Continuing shot: the previous approved take's last frame is an extra reference appended
   **last** (`<Picture M>`, M = character references + 1), with the anchor lines below, the
   summary prefix `[keyframe completion + reference generation]` and the body opening
   "The shot begins from <Picture M>." It is also still sent as the worker `initImage`
   (frame-0 guide); the GPU spike decides whether to keep that.
3. Names → labels: whole-word, case-sensitive cast names of the shot's characters become
   `<Subject k>` in setting, camera, action, delivery and sound — never inside dialogue lines.
4. Speaker ids `(S1)`, `(S2)` in order of first speech in the shot.
5. Dialogue: `<Subject k> (Sx), [in {voice}, ]{delivery}: <d>[English] {line}</d>` — the voice
   phrase (from `Story.voices`) only on that speaker's first line, omitted when the speaker
   has none; a delivery without a speech verb (says, asks, answers, replies, whispers, …)
   gets ", says:"; no delivery → "says:". Lines end with `.`, `?` or `!` (added when missing).
6. Body order: frame anchor, camera, setting, action sentence 1, the dialogue lines in order,
   the remaining action sentences, then (only with dialogue) "{last speaker} finishes the line
   and closes their lips; nobody speaks for the rest of the shot.", then
   "Only <Subject 1>[ and <Subject 2>] appear(s) in the shot."
7. Style sentence: "The target video is in a {style head} style[ with {rest}]." (style split at
   its first comma), or "The target video is in a live-action, cinematic style." when empty.
8. `overall_soundscape`: the shot's `sound`, or "Natural ambient sound of {setting first
   clause}, with soft footsteps and clothing movement." `non_diegetic_music`: always `N/A`
   (music is an assembly concern; per-shot score would jump at every cut).
9. Aspect and duration are request parameters, not prompt text. Compiled prompt ≤ 7,000 chars.
   No negative/LIMITS block (the H3 graph uses `BasicGuider`: there is no negative branch).

Template:

```
subject_definitions:
<Subject 1> is {Name1}, the person in <Picture 1>[ and <Picture 2>]: {locked description 1}.
<Subject 2> is {Name2}, the person in <Picture 3>: {locked description 2}.
[<Picture M> is the first frame of [Shot 1], the last frame of the previous shot.]

summary:
[reference generation] The target video is a single continuous shot of <Subject 1>[ and <Subject 2>] in {setting first clause}.

retention_analysis:
<Subject 1> (appears in [Shot 1]): fully_preserved - {Name1}'s face, hair, body and clothing from <Picture 1>[ and <Picture 2>] are retained.
<Subject 2> (appears in [Shot 1]): fully_preserved - {Name2}'s face, hair, body and clothing from <Picture 3> are retained.
[<Picture M> ([Shot 1] first frame): fully_preserved - the shot starts exactly from this frame.]

detailed_description:
{style sentence}
[Shot 1] [The shot begins from <Picture M>. ]{camera} {setting} {action 1} {dialogue} {action 2..} {closing} {scope}

overall_soundscape:
{sound or fallback}

non_diegetic_music:
N/A
```

Example (golden test in `compile.rs`; Mara 2 references, Ivo 1, style "35 mm film, warm
grain", both voices set, a cut shot):

```
subject_definitions:
<Subject 1> is Mara, the person in <Picture 1> and <Picture 2>: woman in her 30s, short black hair, green bomber jacket.
<Subject 2> is Ivo, the person in <Picture 3>: man in his 40s, grey beard, dark wool coat.

summary:
[reference generation] The target video is a single continuous shot of <Subject 1> and <Subject 2> in a flat rooftop at night.

retention_analysis:
<Subject 1> (appears in [Shot 1]): fully_preserved - Mara's face, hair, body and clothing from <Picture 1> and <Picture 2> are retained.
<Subject 2> (appears in [Shot 1]): fully_preserved - Ivo's face, hair, body and clothing from <Picture 3> are retained.

detailed_description:
The target video is in a 35 mm film style with warm grain.
[Shot 1] A medium two-shot frames <Subject 1> on the left and <Subject 2> on the right at the rooftop's edge; the camera pushes in with small amplitude at slow speed. A flat rooftop at night, wet concrete shining under a single sodium lamp, a rusted water tank behind them and the city's lights spread out below in a light drizzle. <Subject 1> stands with her hands in her jacket pockets, watching the street below, while <Subject 2> leans on the low parapet beside her, rolling an unlit cigarette between his fingers. <Subject 1> (S1), in a low, steady female voice with a calm pace, turns her head toward <Subject 2> and says quietly: <d>[English] We leave tonight.</d> <Subject 2> (S2), in a deep, slightly hoarse male voice with a slow pace, stops rolling the cigarette, straightens up and answers with a tired half-smile: <d>[English] Then I'd better pack light.</d> He pockets the cigarette as <Subject 1> nods once and looks back out over the city. Both hold still in the drizzle as the camera completes its push-in. <Subject 2> finishes the line and closes their lips; nobody speaks for the rest of the shot. Only <Subject 1> and <Subject 2> appear in the shot.

overall_soundscape:
Light rain patters on the wet concrete and the metal water tank while distant city traffic hums far below. Fabric rustles softly as the two shift their weight, and the sodium lamp buzzes faintly overhead.

non_diegetic_music:
N/A
```

Locked descriptions, voices and the style sentence are pasted verbatim into every shot. The
compiled prompt, reference list and seed are stored with each take.

## 7. Rendering

- Each take = one normal `generate_video` job: model `h3ref`, compiled prompt, the shot's
  character reference images, duration = shot duration, resolution from the aspect, audio on,
  steps = model default, a random seed, destination general. Jobs appear in the
  existing job list (labelled "Story: {title} · shot N").
- **Continues previous** (worker change): `generate_video` for `h3ref` accepts an optional
  `initImage`; the graph adds `MiniMaxH3AddGuide(positive, vae, latent, image, frame_idx=0)`
  between `MiniMaxH3ReferenceToVideo` and the guider (node verified in ComfyUI v0.39.0
  `nodes_minimax_h3.py`). The app extracts the previous shot's approved take's last frame on
  the Mac (`ffmpeg -sseof -0.1 -i prev.mp4 -frames:v 1 last.png`). A continues shot renders
  only after its previous shot has an approved take.
- **First task of the build is a GPU spike (~$1):** does ref2va honour the frame-0 guide?
  If not, "Continues previous" is hidden and every shot is a cut; nothing else changes.
- Takes are stored as video records with `story_id`/`shot_id` set and appear only in the
  story's workspace (never in the Image/Video galleries or the Vault tab).

## 8. Assembly (Mac, ffmpeg)

- ffmpeg located at `/opt/homebrew/bin/ffmpeg`, `/usr/local/bin/ffmpeg` or PATH; missing →
  message "Install ffmpeg (brew install ffmpeg)".
- One ffmpeg run: concat filter over the approved takes in shot order, re-encoded H.264
  (crf 18) + AAC 48 kHz stereo, `loudnorm=I=-14:TP=-1.5:LRA=11`, and `comment=AI-generated`
  metadata. (The installed Homebrew ffmpeg 8.1 has no `drawtext`, so a burned-in label is
  deferred.)
- Result saved as a video record (kind video, `story_id` set, poster = first frame; a vault
  story's is a sealed vault item), shown only in the story's workspace (Show in Finder for General,
  Export…); re-assembling replaces the story's previous result.
- A sidecar JSON (shots, prompts, seeds, character ids) is stored with the story record.

## 9. Data (SQLite, `db.rs` migrations)

- `characters(id, name, description, source[generated|real_person], consent INTEGER,
  adult INTEGER, refs_json, created_at, updated_at)`
- `stories(id, title, logline, brief, target_s, aspect, style, cast_json,
  status, result_image_id, sidecar_json, created_at, updated_at, voices_json)` (no destination
  column in v1; `voices_json` = `[{characterId, voice}]`)
- `shots(id, story_id, position, duration_s, characters_json, setting, camera, action,
  dialogue_json, continuity, approved_take_id, sound)` (`dialogue_json` =
  `[{speaker, line, delivery}]`)
- `images` gains nullable `story_id`, `shot_id` (takes and results); gallery queries exclude
  rows with `story_id` set.
- Character reference images use the existing references store (`refs_json` =
  reference ids, same as image jobs).

## 10. Code layout

- Worker: `workflows.py` `_h3ref` optional first-frame guide; handler accepts `initImage` for
  r2v; fixture + tests.
- Rust: `stories/` module — `planner.rs` (LLM client + repair loop), `validate.rs`,
  `compile.rs`, `assemble.rs` (ffmpeg), `store.rs` (tables), commands in `commands.rs`.
- TS: `CreateMode` gains `"stories"` (Controls.tsx `MODES`, persisted like the others);
  `screens/create/stories/` (StoriesPanel = left panel: picker, CastStep, BriefStep,
  CharacterForm; StoryWorkspace = right area: PlanStep, RenderStep, Assemble), wired into
  CreateScreen like VideoPanel; `api` types + mock (canned plan, instant renders).
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

Burned-in AI label (vault stories: see `2026-10-13-stories-vault-design.md`), voice references (`<Audio N>` per character: the
strongest cross-shot voice consistency in MiniMax's guide; needs per-character audio upload
and a worker audio input), draft/final tiers (turbo LoRA), face-similarity QC, full consent
registry (releases, ID, revocation), H3 edit path, colour grading/LUT, music bed, multi-pass
planning, a story-level dialogue language (`[Language]` tag; v1 is `[English]`).
Tuning to A/B on the GPU: `beta` (or `normal`) vs `simple` scheduler for h3ref (Comfy's r2v
template note says beta/normal beat simple for reference-heavy prompts); `ref_image_size: max`
(2048 px short edge) for identity-critical shots (stronger identity, slower).
