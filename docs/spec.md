# Image Studio — Design Spec (v2, 2026-10-08)

Supersedes v1 (local ComfyUI on the Mac).

## Goal
A native macOS app (Tauri 2) for one user. It creates images from text, and from text plus reference images, with four models. ComfyUI runs on **RunPod Serverless**.

**Done means** you can:
- pick a model, type a prompt, and optionally add reference images (FLUX.2, Qwen) and LoRAs
- press Generate and watch progress
- see the result saved in a gallery with its full settings, and restore those settings with one click
- download or delete models and LoRAs from the app, with the files living on a RunPod network volume
- add a LoRA by pasting a Hugging Face or Civitai link

## Models
The single source of truth is **`shared/models.json`**: id, name, licence, defaults, `maxReferences`, `supportsNegativePrompt`, `civitaiBaseModels`, and the file list (folder, filename, url, sizeBytes, sha256, gated). The worker image and the app both embed it. Aspect-ratio sizes are in there too.

| id | Model | Diffusion model | Text encoder | VAE | Refs |
|---|---|---|---|---|---|
| chroma | Chroma1-HD | fp8mixed | T5-XXL fp16 | ae (shared) | 0 |
| zimage | Z-Image Turbo | bf16 (no fp8 exists) | Qwen3-4B | ae (shared) | 0 |
| flux2 | FLUX.2 [klein] 9B distilled | fp8 (BFL, gated) | Qwen3-8B fp8mixed | flux2-vae | 4 |
| qwen | Qwen-Image 2.1 | int8_convrot | Qwen3-VL-8B int8 | qwen_image_2.1_vae | 4 |

- Qwen defaults are `0` / `""` in the registry until the worker agent fills them from the official Comfy template.
- The worker agent also checks every default against the official templates.

## Architecture
```
Mac: Tauri 2 app                                  RunPod Serverless endpoint
┌──────────────────────────────────┐   HTTPS     ┌──────────────────────────────────┐
│ React UI (app/src)               │  /run       │ worker image (worker/)           │
│   ⇅ invoke + events              │  /status    │  FROM runpod/worker-comfyui:     │
│ Rust core (app/src-tauri)        │  /cancel    │       5.10.0-base-cuda12.8.1 + v0.39│
│   runpod client · job manager    │ ──────────▶ │  handler.py (actions below)      │
│   gallery (SQLite) · Keychain    │             │  workflows.py (graph builders)   │
│   civitai/HF link resolver       │             │  /runpod-volume/models/{unet,    │
│   delete-rule (pure fn)          │             │     clip,vae,loras/<modelId>}    │
└──────────────────────────────────┘             └──────────────────────────────────┘
```

**Endpoint configuration**
- GPU priority: RTX 5090 (32 GB), then L40S, then A6000 (48 GB).
- Workers: max 2 (so a download doesn't block generation), min/active 0, idle timeout 5 s.
- One 100 GB network volume, in a datacenter that has those GPUs.
- Endpoint env/secrets: `HF_TOKEN`, `CIVITAI_API_KEY`.

## Worker job protocol (`worker/`)
Request: `POST /run {"input": {"action": ..., ...}, "policy": {"executionTimeout": ms}}`. Generation uses 600 000 ms and downloads use 3 600 000 ms; check that `policy` is supported, otherwise rely on the endpoint setting.

| action | input | output |
|---|---|---|
| `generate` | `model, prompt, negativePrompt, width, height, seed, steps, cfg, references: [{name, base64}], loras: [{filename, strength}]` | `{ image: {base64, seed, width, height}, timings: {loadMs, sampleMs, totalMs} }` |
| `status` | — | `{ files: [{folder, filename, sizeBytes}], volume: {totalBytes, freeBytes}, comfyuiVersion }` (lists `models/{unet,clip,vae,loras/*}`) |
| `download` | `files: [{folder, filename, url, sizeBytes?, sha256?}]` | `{ downloaded: [filename], skipped: [filename] }` |
| `delete` | `files: [{folder, filename}]` | `{ deleted: [filename], missing: [filename] }` |

**Generate**
- `generate` builds the ComfyUI graph in `workflows.py` (pure, unit-tested), not the app.
- References: FLUX.2 uses `ReferenceLatent` chained on the conditioning; Qwen uses its native edit/reference conditioning per the official template.
- LoRAs: one `LoraLoaderModelOnly` per LoRA, chained after the diffusion-model loader, reading `loras/<modelId>/<filename>`.
- Progress: `runpod.serverless.progress_update(job, {"phase": "loading" | "sampling" | "saving" | "downloading", "step", "totalSteps", "file", "bytes", "totalBytes"})`, read from the ComfyUI websocket.
- Validation: the model files must be on the volume, otherwise fail with `MODEL_NOT_INSTALLED: <files>`.

**Download**
- Plain HTTPS streaming, never `huggingface_hub` or Xet.
- Writes to `<file>.part`, verifies size and sha256 when given, then renames atomically.
- Already present with the right size → skipped.
- Auth headers: `HF_TOKEN` for `huggingface.co`, `CIVITAI_API_KEY` for `civitai.com` (as `Authorization: Bearer`).
- Retries with Range resume when fewer than 100 KB arrive in 60 s, up to 10 times.

**Paths and models**
- `folder` must be one of `unet`, `clip`, `vae`, `loras/<modelId>`. Filenames are sanitised: no `/`, no `..`, extension `.safetensors`. Anything else is rejected.
- `extra_model_paths.yaml` maps unet, clip, vae, loras and diffusion_models/text_encoders onto `/runpod-volume/models/...`.
- After a `delete`, the worker frees ComfyUI's loaded models.

## Rules
- **Shared-file delete rule** (pure Rust function, unit-tested): deleting model X deletes all of X's files, except that a file shared with model Y is deleted only if Y is fully deleted. Y counts as deleted when none of its other files are on the volume and Y is not downloading or queued.
- **Model status cache:** each `status` call costs GPU seconds, so the app caches the last status in SQLite. It refreshes only on app start (if older than 24 h), on the Refresh button, and after a download or delete finishes.
- **Count > 1:** one RunPod job per image, with seeds `seed, seed+1, …`. Every image stores its own seed.
- **References:** at most `maxReferences`. Each is downscaled to fit within 1 MP and re-encoded as JPEG q90 (PNG if it has alpha), so the request stays under RunPod's 10 MB `/run` limit.
- **LoRAs:** up to 3 per generation. Only LoRAs whose `modelId` matches the selected model are offered.

## Mac app (`app/`)
- Tauri 2 + React + TypeScript (Vite).
- Data in the Tauri app-data dir (`~/Library/Application Support/<identifier>/`): `studio.db` (SQLite), `images/`, `references/`.
- Images are shown through Tauri's asset protocol (`convertFileSrc`), scoped to the app-data dir.
- **Secrets:**
  - The Keychain (`keyring` crate, service `ImageStudio`) holds `runpod_api_key`.
  - `endpointId` sits in a settings file (not secret).
  - Debug builds also read `RUNPOD_API_KEY` and `RUNPOD_ENDPOINT_ID` from the repo `.env` when the Keychain is empty.
  - `CIVITAI_API_KEY` from `.env` / the Keychain is also used by the app's Civitai metadata lookups.

### Commands (`invoke`) — camelCase JSON

Settings and status:
- `get_settings() -> {hasApiKey, endpointId, hasCivitaiKey}`
- `save_settings({apiKey?, endpointId?, civitaiKey?})`
- `test_connection() -> {ok, workers: {idle, running}, jobs: {inQueue, inProgress}, error?}`, via `GET /health`
- `list_models() -> ModelView[]`. `ModelView` = registry fields + `{installed: bool, files: [{...file, present}], presentBytes, totalBytes, task: Task | null}`
- `refresh_status() -> {models: ModelView[], volume: {totalBytes, freeBytes}, checkedAt}`

Models:
- `download_model(id) -> Task`
- `cancel_task(taskId)`
- `delete_preview(id) -> {deleteFiles: string[], freedBytes, keptFiles: [{filename, reason}]}`
- `delete_model(id) -> {freedBytes, keptFiles}`

LoRAs:
- `resolve_lora_link(url) -> {source: "huggingface" | "civitai", name, downloadUrl, filename, sizeBytes?, sha256?, baseModel?, suggestedModelId?, triggerWords: string[], previewUrl?}`
  - Civitai: parse the model/version id from the URL and use `https://civitai.com/api/v1/model-versions/{id}` (or `/models/{id}` → latest version). Download URL is `https://civitai.com/api/download/models/{versionId}`. `suggestedModelId` maps `baseModel` through the registry's `civitaiBaseModels`; verify the real Civitai baseModel strings.
  - Hugging Face: a `blob/` or `resolve/` URL to a `.safetensors` file, with size and sha from the HF API.
- `add_lora({url, modelId, name, triggerWords}) -> Lora`, which starts a download task
- `list_loras() -> Lora[]`. `Lora = {id, name, modelId, source, sourceUrl, filename, sizeBytes, triggerWords, present, task}`
- `delete_lora(id)`

Generation and gallery:
- `import_reference(path) -> {refId, thumbPath}`. Also `import_reference_bytes(base64, mime)` for paste and drag-and-drop.
- `generate({model, prompt, negativePrompt?, aspectRatio, count, seed?, steps?, cfg?, referenceIds, loras: [{loraId, strength}]}) -> {jobId}`
- `cancel_job(jobId)`
- `list_images({limit, before?}) -> {items: ImageRecord[], nextBefore}`
- `delete_image(id)`

### Events

**`job-update`**:
```
Job {jobId, status: "queued" | "starting" | "running" | "completed" | "failed" | "cancelled",
     total, completed, progress: {phase, step, totalSteps} | null, images: ImageRecord[], error}
```
`starting` means the RunPod job is IN_QUEUE while a worker cold-starts.

**`task-update`**:
```
Task {taskId, kind: "download" | "delete", target: {type: "model" | "lora", id},
      status: "queued" | "running" | "completed" | "failed" | "cancelled",
      bytes, totalBytes, file, error}
```

**ImageRecord**:
```
{id, path, model, prompt, negativePrompt, aspectRatio, width, height, seed, steps, cfg,
 references: [path], loras: [{name, strength}], createdAt, durationMs,
 runpod: {delayMs, executionMs}}
```

- Polling: the Rust job manager polls `GET /status/{id}` every 1 s while jobs are active. It decodes the output image into `images/` and records `delayTime` and `executionTime`.

### UI
Three tabs.

**Create**
- Model cards, with a "Not installed" state that links to Models.
- Prompt (⌘↵ to generate).
- References drop zone, shown only when `maxReferences > 0`; supports paste and drop.
- LoRA picker: add from the library, strength slider 0–2, trigger-word chips that click to insert.
- Aspect chips, count 1–4.
- Advanced drawer: seed/random, steps, CFG, negative prompt, reset.
- Job card: "Starting GPU… (cold start)", then the step bar; Cancel.
- Gallery grid with infinite scroll. The lightbox shows settings and has Download (save dialog), Copy prompt, Use these settings, and Delete.

**Models**
- Volume usage, last-checked time and a Refresh button.
- Per-model card: licence, size, file list with present/missing and shared badges, Download/Delete with progress, and a delete preview dialog.
- LoRA library: paste-link field, resolved preview (name, base model, model selector pre-filled, trigger words, size), Add; list with status and delete.

**Settings**
- RunPod API key (masked; stored in the Keychain), endpoint ID, Civitai key, Test connection.
- A note on costs and cold starts.

Design: dark, polished studio look; keyboard-friendly; native window. No `window.alert` or `window.confirm`.

## Setup (`scripts/`)
- `scripts/build_worker.sh` runs `docker buildx build --platform linux/amd64` and pushes to `$WORKER_IMAGE` (Docker Hub or GHCR).
- `scripts/runpod_setup.py` uses the RunPod REST API (`https://rest.runpod.io/v1`; verify the endpoints) with `RUNPOD_API_KEY` from `.env` to:
  - create the network volume (100 GB)
  - create the template: image, env `HF_TOKEN`/`CIVITAI_API_KEY` from `.env` as RunPod secrets if supported, otherwise as env
  - create the endpoint
  - write `RUNPOD_ENDPOINT_ID` back to `.env`

  It is idempotent, prints every resource it creates, and `--dry-run` shows the plan.
- `docs/setup.md` covers the manual console steps as a fallback.

## Testing
- **Worker:** pytest. Workflow graphs per model (with and without references and LoRAs), path sanitising, the download manager (resume, sha mismatch, stall, auth header per host), and the handler with a fake ComfyUI.
- **Rust:** `cargo test`. Delete rule (5 cases), job state machine with mocked RunPod (`wiremock`), Civitai/HF link resolver with fixtures, seed expansion, reference downscaling.
- **UI:** `tsc --noEmit` and `vite build`; a dev mock of the Tauri commands for browser preview.
- **End to end (real RunPod, after setup):**
  - one image per model, FLUX.2 and Qwen with a reference, one LoRA
  - model delete and redownload, including the shared VAE
  - record cold start, seconds per image and cost in `docs/results.md`

## Out of scope
FLUX.2 [dev], inpainting/editing, img2img for Chroma/Z-Image, Qwen prompt-enhancer encoders, multiple users/LAN, hosting the app.

---

## v3 change (2026-10-09): dedicated GPU pod with Start/Stop (replaces serverless for generation)
Reason: in testing, serverless flex workers waited 16.5 min for a free GPU (every machine throttled). The user chose a dedicated pod.

**GPU and location**
- **GPU:** NVIDIA RTX PRO 6000 Blackwell Server Edition (96 GB), Secure Cloud, $2.49/h.
- **Datacenter:** US-NE-1.
- **Volume:** `image-studio-models-us` (`p6b2e0kjhk`), mounted at `/runpod-volume`, the same layout the worker already uses.
- The app finds the volume by name with `GET /v2/network-volumes`; no ids are hard-coded in the app.

**Pod lifecycle (Rust `pod.rs`, RunPod REST v2 `/v2/pods`)**
- **Start:**
  - Create a pod named `image-studio-gpu` with image `ghcr.io/algotradingfervid/image-studio-worker:latest`.
  - `gpu` = RTX PRO 6000 Blackwell Server Edition × 1; `dataCenterIds` = [the volume's DC]; network mount {volumeId, path `/runpod-volume`}; `ports` `["8000/http"]`; container disk 20 GB.
  - env: `MODE=pod`, `API_TOKEN=<random 32-byte, Keychain account pod_api_token>`, `IDLE_MINUTES=<setting, default 30>`, `HF_TOKEN`/`CIVITAI_API_KEY` as RunPod secret refs (`{{ RUNPOD_SECRET_image-studio-hf-token }}` etc. — existing secrets), plus whatever the watchdog needs (below).
  - Then poll `https://<podId>-8000.proxy.runpod.net/health` (with token) until ready.
  - The pod id is stored in SQLite, so it survives app restarts.
- **Stop:** `DELETE /v2/pods/{id}` (terminate). All state lives on the volume and on the Mac.
- **Generate while stopped:** auto-start, and show "Starting GPU…" phases.
- **On app launch:** find any existing `image-studio-gpu` pod via `GET /v2/pods` and re-adopt it. Show a warning banner if it was left running.
- **App-side auto-stop:** after `IDLE_MINUTES` with no jobs or tasks (only while the app is open).

**Pod server (`worker/src/server.py`, `MODE=pod`)**
- The entrypoint starts ComfyUI as today, then serves HTTP on `:8000` instead of `runpod.serverless.start`.
- It is **API-compatible with RunPod serverless**, so the Rust client only swaps its base URL and token:
  - `POST /run {input, policy?} → {id, status:"IN_QUEUE"}`
  - `GET /status/{id} → {id, status, output, delayTime, executionTime, error?}`. While IN_PROGRESS, `output` = the latest `progress_update` payload. Statuses: IN_QUEUE / IN_PROGRESS / COMPLETED / FAILED / CANCELLED.
  - `POST /cancel/{id}`
  - `GET /health → {jobs:{inQueue,inProgress,completed,failed}, workers:{idle,running}, ready: bool, gpu: str, comfyui: str}`
  - `GET /ping` (no auth, for liveness)
- **Auth:** every endpoint except `/ping` needs `Authorization: Bearer $API_TOKEN` (constant-time compare). Missing or wrong → 401. The server refuses to start without `API_TOKEN`.
- **Execution:**
  - One job at a time, FIFO (ComfyUI is single-GPU).
  - `download`/`delete`/`status` jobs may run concurrently with `generate`, using a separate executor.
  - It reuses the existing handler action functions, unchanged, with a progress hook that writes to the job record.
  - Finished jobs are kept for 30 min.
- **Idle watchdog:** if no request other than `/ping` arrives within `IDLE_MINUTES` and no job is active, the pod **terminates itself** through the RunPod API, using `RUNPOD_POD_ID` (injected by RunPod) and an API key. Verify whether RunPod injects a pod-scoped `RUNPOD_API_KEY`; if not, the app passes the user's key as a pod env var. Log the shutdown.

**App UI**
- **GPU pill in the header:**
  - `Stopped` + **Start**
  - `Starting · <phase>` (creating pod → pulling image → booting ComfyUI → ready)
  - `Running · RTX PRO 6000 · 23 min · ~$0.95` + **Stop**
  - `Error` + message + Retry
- **Settings:** "Auto-stop after N idle minutes" (default 30); GPU type (read-only for now).
- **Startup banner** if a pod was found running.

**New commands and events**
- `get_gpu_state() -> GpuState`
- `start_gpu() -> GpuState`
- `stop_gpu() -> GpuState`
- event `gpu-update` (GpuState)
- `GpuState = {status: "stopped"|"starting"|"running"|"stopping"|"error", podId?, gpuType?, startedAt?, costPerHr?, phase?, error?, idleMinutes}`

**Fix:** the volume total/free in the Models screen = the volume's `size` (GB, from `GET /v2/network-volumes`) minus the sum of present file sizes. The worker's `shutil.disk_usage` reports the whole shared filesystem.

**Serverless:** the endpoint stays configured but unused. The Settings "Test connection" now checks the pod when it's running, and otherwise the RunPod API key.
