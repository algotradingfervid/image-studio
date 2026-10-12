# Plan: MiniMax H3 character reference (ref2va) — 2026-10-12

## Problem
i2v videos keep the uploaded character only at frame 0, then identity drifts.
Root cause: both i2v graphs anchor only the first frame (H3 `MiniMaxH3ImageToVideo`
→ `minimax_keyframes` at index 0; LTX `LTXVImgToVideoInplace` on the first latent).
Nothing conditions identity for the rest of the clip. Owner confirmed "starts right, drifts".

## Fix
New video model `h3ref` = MiniMax H3 reference-to-video (`MiniMaxH3ReferenceToVideo`,
ComfyUI v0.39.0 `comfy_extras/nodes_minimax_h3.py`; official template
`Comfy-Org/workflow_templates templates/video_minimax_h3_r2v.json`). Reference image
tokens ride through every sampling step → identity is held for the whole clip.

- Weights: `minimax_h3_ref2va_pruned_fp8_scaled.safetensors` (20 958 205 608 B,
  sha256 f86f2f79ebd2d76eb8eeb46091e83982e6ff51d255747e7b16e92834b392b8e9), folder unet.
  clip / video_vae / audio_vae shared with `h3` (download skips present files).
- Registry: `videoModels` entry `h3ref`, `modes: ["r2v"]`, `maxReferences: 4`
  (node allows 9; 4 keeps speed sane), same defaults/limits/volume/licence as h3.
- Graph (API format), mirrors the template:
  UNETLoader(ref2va) ; CLIPLoader(minimax) ; VAELoader(video) ; VAELoader(audio)
  LoadImage × N → MiniMaxH3ReferenceToVideo(clip, vae, audio_vae, prompt, width, height,
  length, ref_image_size="match", `ref_images.ref_image_0` … `ref_image_{N-1}`  ← 0-based,
  Autogrow TemplatePrefix uses range(max))
  → BasicGuider(cond 0) + BasicScheduler(simple, steps, 1) + KSamplerSelect(res_multistep)
  + RandomNoise → SamplerCustomAdvanced(latent = out 1) → VAEDecode / VAEDecodeAudio
  → CreateVideo(24) → SaveVideo + poster (shared `_save_video`).
- Output size: the preset resolution (no start image).
- Prompt: the app shows a hint that references are `<Picture 1>`, `<Picture 2>`… in order.
- Request: `references: [{name, base64}]` (1..maxReferences) — same shape as image jobs.
- Out of scope: combining ref2va with a first-frame guide (MiniMaxH3AddGuide) — untested
  whether ref2va weights honour keyframes; ref videos/audio; the turbo LoRA; LTX changes.

## Work split (independent files)
A. Worker (`worker/`): workflows.py builder `_h3ref` + OUTPUT_TYPES + video stage map
   (LoadImage feeding the ref node → `preparing_references`); handler.py validate +
   upload `references` for video; fixture entry for MiniMaxH3ReferenceToVideo (Autogrow);
   video graph validator handles Autogrow; tests; README.
B. App (`app/`): Rust VideoRequest/generate_video `reference_ids`, build_video_plan mode
   logic (r2v when model has r2v; require 1..max refs), payload + record.references;
   CONTAINER_DISK_GB_VIDEO 120 → 150 (H3 + H3 ref + LTX ≈ 115 GB); TS types, VideoPanel
   reference picker (reuse `References` from Controls.tsx) when model has r2v, prompt hint,
   licence note for every `h3*` id; ModelsScreen mode label + licence; mock support.
C. shared/models.json entry (done first, by the lead).

## Verification
- `cd worker && uv run pytest -q` all green, incl. new h3ref graph validated against fixture.
- `cd app/src-tauri && cargo test && cargo clippy --all-targets -- -D warnings`.
- `cd app && npm run build`; drive the mock app: pick H3 Character, add 2 refs, submit.
- Real run (paid, owner confirms first): download h3ref on Models tab, generate 5 s clip
  with the drifting character as reference, compare identity at start/middle/end frames.

## Addendum: Qwen-Image 2.1 multi-reference identity (same day)
Symptom: several reference photos of one person → output treats them as different people.
Root cause: ComfyUI v0.39.0 `comfy/text_encoders/qwen_image21.py:23` labels each reference
`<image1>`, `<image2>`… for the text encoder; Qwen-Image 2.1 is a multi-subject composer
(official template: "Mention them in the prompt as `<image1>`, `<image2>`"; image_1 is the
edit target). Our prompts never relate the references, so each is read as its own subject.
Fix (app only, shared `References` component): per-model tag labels on each ref thumbnail
(qwen `<image{n}>`, h3ref `<Picture {n}>`), click-to-insert, and a "Same person" action that
inserts a visible sentence ("<image1> and <image2> show the same person."). No hidden prompt
rewriting. Effect on output must be confirmed with a real (paid) Qwen run.
