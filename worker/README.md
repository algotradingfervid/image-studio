# Image Studio worker (RunPod Serverless or dedicated pod + ComfyUI)

Custom worker for Image Studio. It runs ComfyUI v0.39.0 and implements the job
protocol in `docs/spec.md` ("Worker job protocol"). The same image runs as a
RunPod Serverless worker (default) or, with `MODE=pod`, as an HTTP server on a
dedicated GPU pod ("v3 change"; see [Pod mode](#pod-mode-modepod)).

## Build

The build context is the **repo root**, because the image embeds `shared/models.json`:

```sh
docker buildx build --platform linux/amd64 -f worker/Dockerfile -t <registry>/image-studio-worker:<tag> .
```

`worker/Dockerfile.dockerignore` limits the context to `shared/models.json` and
`worker/src/`, so the repo `.env` and `app/` never reach the build.

**Base image:** `runpod/worker-comfyui:5.10.0-base-cuda12.8.1`, pinned by digest
`sha256:45a1abd8…9c47`. `5.11.0` is tagged on GitHub but was never published to
Docker Hub. The published image config shows:

- CUDA 12.8.1 and cuDNN 9.8 (`nvidia/cuda:12.8.1-cudnn-runtime-ubuntu24.04`)
- Python 3.12 venv at `/opt/venv`
- ComfyUI 0.34.0 installed by comfy-cli 1.13.0 as a git checkout at `/comfyui`
- torch 2.11.0+cu128, which supports Blackwell / RTX 5090 and needs driver ≥ 570

**What the Dockerfile does:**

1. Checks out ComfyUI `v0.39.0` in `/comfyui` (`git fetch --tags`, then `git checkout tags/v0.39.0`).
2. Installs ComfyUI's requirements into `/opt/venv`. torch, torchvision and torchaudio are frozen with a constraints file, so ComfyUI's bare `torch` requirement cannot pull PyPI's CUDA 13 wheels. The build also asserts that torch is still `2.11.0+cu128`.
3. Asserts the ComfyUI version, then runs upstream's CPU smoke test (`main.py --quick-test-for-ci --cpu`).
4. Copies `src/extra_model_paths.yaml` to `/comfyui/extra_model_paths.yaml`. ComfyUI auto-loads this file.
5. Copies `src/*.py` to `/image_studio/` (`PYTHONPATH`) and `src/handler.py` to `/handler.py`. That replaces the upstream handler. The base `/start.sh` starts ComfyUI in the background, then runs `python -u /handler.py`. `handler.py` calls `runpod.serverless.start`, or with `MODE=pod` starts `server.py`. The image `EXPOSE`s 8000.

## Endpoint environment

| Variable | Purpose |
|---|---|
| `HF_TOKEN` | Sent as `Authorization: Bearer` to `huggingface.co` only. Needed for gated FLUX.2. |
| `CIVITAI_API_KEY` | Sent as `Authorization: Bearer` to `civitai.com` only. |
| `DOWNLOAD_CONCURRENCY` | Files downloaded in parallel. Default 3. |
| `COMFY_READY_TIMEOUT_S` | How long `generate` waits for ComfyUI to boot. Default 300. |
| `GENERATE_TIMEOUT_S` | Generation watchdog. Default 590, just under the 600 s job policy. |

Set these by the Dockerfile; you normally don't change them: `REGISTRY_PATH`, `VOLUME_ROOT=/runpod-volume`, `COMFYUI_PATH=/comfyui`, `PYTHONPATH`.

Tokens are never forwarded across hosts. Redirects are followed manually, and the
`Authorization` header is dropped as soon as a redirect leaves the original host,
for example HF → CDN or Civitai → a presigned S3/R2 URL.

## Pod mode (`MODE=pod`)

The entrypoint is unchanged: `/start.sh` starts ComfyUI (on 127.0.0.1:8188,
not exposed) and runs `/handler.py`, whose `main()` sees `MODE=pod` and starts
`server.py` (aiohttp, already in the image as a `runpod` dependency) on
`0.0.0.0:8000` instead of `runpod.serverless.start`.

### Pod environment

| Variable | Purpose |
|---|---|
| `MODE=pod` | Selects the HTTP server. Anything else means serverless. |
| `API_TOKEN` | Required. Bearer token for every route except `/ping`. The server exits with code 2 if it is empty. |
| `IDLE_MINUTES` | Idle watchdog, default 30. `0` disables it. |
| `RUNPOD_POD_ID` | Injected by RunPod. Used by the watchdog. |
| `RUNPOD_API_KEY` | Injected by RunPod into every pod as a "Pod-scoped API key". Its permissions are not documented. The watchdog tries it second. |
| `RUNPOD_TERMINATE_API_KEY` | Optional key from the app (the user's RunPod key). The watchdog tries it first. A separate name avoids clashing with RunPod's injected `RUNPOD_API_KEY`. |
| `PORT` | Default 8000. |
| `HF_TOKEN`, `CIVITAI_API_KEY`, … | As in serverless mode. |

Secrets are never logged. The startup line names only the key variables that are set.

### API (compatible with RunPod serverless)

Every route also answers under `/v2/<anything>/…`, so the serverless URL shape works too.

| Route | Response |
|---|---|
| `POST /run {input, policy?}` | `{id, status: "IN_QUEUE"}`. Ids look like `pod-<uuid>`. The body can be up to 32 MB. |
| `GET /status/{id}` | `{id, status, delayTime, executionTime, output?, error?}` |
| `POST /cancel/{id}` | `{id, status}` |
| `GET /health` | `{jobs: {inQueue, inProgress, completed, failed}, workers: {idle, running}, ready, gpu, comfyui, watchdog: {armed, check, idleMinutes, idleForS, lastError}}` (see [Idle watchdog](#idle-watchdog)) |
| `GET /ping` | `{status: "ok"}`. No auth. |

**Auth:** `Authorization: Bearer $API_TOKEN`, compared in constant time. A missing or wrong header gets 401 `{"error": "unauthorized"}`. An unknown or expired job id gets 404.

**Status semantics:**

- Statuses are `IN_QUEUE`, `IN_PROGRESS`, `COMPLETED`, `FAILED`, `CANCELLED` and `TIMED_OUT`.
- `delayTime` is the time queued, in ms. `executionTime` is the time running, in ms. Both are always present, and both are live while the job is unfinished.
- While `IN_PROGRESS`, `output` is the latest progress payload (the same objects serverless sends through `progress_update`, at most 2 per second).
- `COMPLETED`: `output` is the action's result.
- `FAILED`: this is runpod-python's `run_job` mapping. The handler's `{"error": "<CODE>: …"}` becomes the top-level `error` string, and an empty `output` is dropped, so there is no `output` key.
- `CANCELLED` and `TIMED_OUT` have no `output`.

**Execution:**

- `generate` jobs run one at a time in FIFO order on a dedicated thread.
- `status`, `download` and `delete` jobs, and any unknown action, run on a separate pool of 4 threads, concurrently with generation.
- Both paths call `handler.handler(job)` unchanged. The server passes a progress hook (`job["_progress"]`) and a cancel event (`job["_cancel"]`) in the job dict. In serverless mode these keys are absent, so `progress_update` is used as before.
- `policy.executionTimeout` (ms) is honoured. A job running longer than that is cancelled and reported as `TIMED_OUT`.
- Finished jobs are kept for 30 minutes, then `/status` returns 404.

**Cancel:**

- A queued job becomes `CANCELLED` and never runs.
- A running `generate` is marked `CANCELLED` and ComfyUI gets `POST /interrupt`. The generate loop also interrupts if the cancel raced the prompt being queued. The next generate starts once ComfyUI has stopped.
- A running `download` stops at its next chunk, and its `.part` file is kept for resume.
- `delete` and `status` jobs are short. They are marked `CANCELLED` and their result is discarded.
- Cancelling a finished job returns its status unchanged.

### Idle watchdog

Every 30 s the server checks whether there has been no authenticated request
(`/ping` and 401s don't count), and no job has finished, for `IDLE_MINUTES`,
with no job queued or running. When all of that holds, it terminates the pod:

1. It sends `DELETE https://api.runpod.io/v2/pods/$RUNPOD_POD_ID`, which returns 204 on success, then `DELETE https://rest.runpod.io/v1/pods/$RUNPOD_POD_ID`. It tries each with `RUNPOD_TERMINATE_API_KEY`, then with `RUNPOD_API_KEY` (a key the arm check confirmed goes first). Any 2xx counts as success: RunPod then stops the pod.
2. If both fail, it runs `runpodctl pod delete $RUNPOD_POD_ID`, then `runpodctl remove pod …`, if `runpodctl` is on `PATH`.
3. If nothing worked, or no key is set, it logs a warning that the pod is still billing and **stays up**, retrying every 5 minutes (`RETRY_S` = 300 s) while the pod is still idle. Any authenticated request or a job starting resets the attempt state and the idle timer.

It never exits the server. An exit would make RunPod restart the container, which
resets the idle timer, so the pod would bill indefinitely. The app-side auto-stop
remains the backstop when the pod cannot terminate itself.

**Arm check:** at startup a background thread sends an authenticated
`GET https://api.runpod.io/v2/pods/$RUNPOD_POD_ID` with each key, in the order above.
The first key that gets a 2xx is recorded and preferred for terminate. A successful
GET proves only that the key can read the pod, not that it may delete it, so the check
is reported as `"read"`.

`GET /health` reports it as `watchdog`:

| Field | Meaning |
|---|---|
| `armed` | `true` if some key could read this pod. |
| `check` | `pending` (not run yet), `read` (GET succeeded), `failed`, or `disabled` (`IDLE_MINUTES=0`). |
| `idleMinutes` | `IDLE_MINUTES`. |
| `idleForS` | Seconds since the last authenticated request or finished job. |
| `lastError` | The last terminate failure, else the arm-check error, else `null`. It names key variables, never key values. |

Terminating releases the GPU and detaches the network volume without deleting it.

## Volume layout

```
/runpod-volume/models/
  unet/               diffusion models   (ComfyUI: diffusion_models / unet)
  clip/               text encoders      (ComfyUI: text_encoders / clip)
  vae/
  loras/<modelId>/    LoRAs; ComfyUI lora_name = "<modelId>/<filename>"
```

## Protocol

Send `POST /run {"input": {"action": ...}, "policy": {"executionTimeout": ms}}`.
RunPod documents `policy.executionTimeout` in milliseconds, from 5 s up to 7 days.
On any failure the handler returns `{"error": "<CODE>: <detail>"}`, and RunPod marks the job FAILED with that string.

| action | input | output |
|---|---|---|
| `generate` | `model, prompt, negativePrompt, width, height, seed, steps, cfg, references: [{name, base64}], loras: [{filename, strength}]` | `{image: {base64 (PNG), seed, width, height}, timings: {loadMs, sampleMs, totalMs}}` |
| `status` | — | `{files: [{folder, filename, sizeBytes}], volume: {totalBytes, freeBytes}, comfyuiVersion}` |
| `download` | `files: [{folder, filename, url, sizeBytes?, sha256?}]` | `{downloaded, skipped, elapsedMs, avgMBps}` |
| `delete` | `files: [{folder, filename}]` | `{deleted, missing}`, then `POST /free` to ComfyUI |

### `generate`

- `steps`, `cfg` and `negativePrompt` may be null. They then take the registry `defaults`.
- If `seed` is null, the worker picks a random one and returns it.
- `width` and `height` must be multiples of 16, between 64 and 4096.
- At most `maxReferences` references, as PNG, JPEG or WebP. A `data:` URL prefix is accepted.
- At most 3 LoRAs, with strength between -5 and 5.
- **Model files missing:** `MODEL_NOT_INSTALLED: unet/x.safetensors, loras/flux2/y.safetensors`.
- **ComfyUI rejects the graph:** `COMFYUI_INVALID_PROMPT: …`, with per-node details.
- **ComfyUI fails at runtime:** `COMFYUI_EXECUTION_ERROR: node <id> (<class>): <ExceptionType>: <message>`.
- **Timings:**
  - `loadMs` runs from job start to the sampler's first progress event. This includes model loading, which ComfyUI does lazily inside the sampler node.
  - `sampleMs` runs from that event until the sampler finishes.
  - `totalMs` is the whole handler.

### Progress (`runpod.serverless.progress_update`, at most 2 per second)

- `generate`: `{phase: "loading" | "sampling" | "saving", stage, stages, step, totalSteps, elapsedMs, stageElapsedMs, cached, cachedStages, stageTimes}`. The final step and every stage change are always sent.
  - `stage` comes from the class of the node ComfyUI reports as `executing`: `loading_text_encoder` (CLIPLoader*), `encoding_prompt` (CLIPTextEncode*, TextEncodeQwenImage21, T5TokenizerOptions), `loading_model` (UNETLoader, UnetLoaderGGUF, LoraLoaderModelOnly, ModelSampling*, QwenImage21Cache), `preparing_references` (LoadImage, ImageScaleToTotalPixels, VAEEncode, ReferenceLatent), `sampling`, `decoding`, `saving`. Other nodes keep the current stage. `phase` is the v1 value of the stage.
  - `stages` lists the stages of this graph in display order, known from the first update. ComfyUI may run them in another order, so use `stageTimes` (ms spent in each stage already left) and `cachedStages` to mark stages done.
  - `cachedStages` are stages whose nodes ComfyUI reported in `execution_cached` (they never run). `cached` is true when a loader stage is among them, meaning the weights were already in memory.
  - `elapsedMs` counts from the start of the job; `stageElapsedMs` from the start of the current stage.
- `download`: `{phase: "downloading", file, bytes, totalBytes, files: [{filename, bytes, totalBytes, status}]}`.
  - `bytes` and `totalBytes` are summed across all files in the job.
  - `totalBytes` is null while any file's size is unknown.
  - `status` is one of `queued`, `downloading`, `downloaded`, `skipped` or `failed`.
  - `file` is the file that most recently reported progress.

### `download` details

- Up to 3 files download at the same time. A single HF stream to RunPod often runs at only 10–50 MB/s.
- Downloads use plain `requests` streaming (no `huggingface_hub`, no Xet). Each file is written to `<file>.part`, checked for size and sha256 when given, then renamed atomically.
- A file is skipped when it is already present with the right size. Without `sizeBytes`, any existing file counts as present.
- **Stall guard:** an attempt counts as stalled if it receives fewer than 100 KB in a 60 s window, or nothing at all for 60 s.
- **Retries:** after a stall, a dropped connection, HTTP 5xx or 429, the worker retries up to 10 times. Backoff is 1, 2, 4, … s, capped at 60 s. Each retry resumes with a `Range` request and starts again from the original URL, so presigned URLs are refreshed.
- **No retry:** 401, 403, 404, a sha256 or size mismatch, or a non-HTTPS URL fail at once.
- **Too little space:** if the volume lacks room for a known size, the worker fails up front with `INSUFFICIENT_SPACE`.
- **Partial failure:** if one file fails, the others still finish. The job returns `DOWNLOAD_FAILED: …`, with the list of files that completed.
- `avgMBps` is the bytes actually transferred in this job, divided by `elapsedMs`. Skipped files and resumed bytes are not counted.

### Paths

- `folder` must be `unet`, `clip`, `vae` or `loras/<modelId>`, where `<modelId>` is in the registry.
- Filenames must end in `.safetensors`. They cannot contain `/`, `\`, `..`, control characters or `:*?"<>|`, and cannot start with `.`, `-` or a space.
- The resolved path must stay inside `/runpod-volume/models`, even through symlinks.
- Every file in a request is validated before anything is touched.

## Graphs (`src/workflows.py`)

Each graph is an API-format conversion of the official Comfy-Org template, with
our filenames and the request parameters substituted. The templates come from
https://github.com/Comfy-Org/workflow_templates `templates/` at main `8be1f8c4`.

| model | template(s) | graph |
|---|---|---|
| chroma | `image_chroma_text_to_image.json` | UNETLoader → [LoRAs] → ModelSamplingAuraFlow(1) → BasicScheduler(beta); CLIPLoader(chroma) → T5TokenizerOptions(0,0) → CLIPTextEncode ×2; CFGGuider, KSamplerSelect(euler), RandomNoise, EmptySD3LatentImage → SamplerCustomAdvanced |
| zimage | `image_z_image_turbo.json` | UNETLoader → [LoRAs] → ModelSamplingAuraFlow(3) → KSampler(res_multistep, simple); CLIPLoader(lumina2); ConditioningZeroOut negative; EmptySD3LatentImage |
| flux2 | `image_flux2_klein_text_to_image.json` (distilled subgraph), `image_flux2_klein_image_edit_9b_distilled.json` | UNETLoader → [LoRAs] → CFGGuider; CLIPLoader(flux2); ConditioningZeroOut negative; per reference LoadImage → ImageScaleToTotalPixels(lanczos, 1 MP) → VAEEncode → ReferenceLatent on **both** the positive and negative chains; Flux2Scheduler; EmptyFlux2LatentImage |
| qwen | `image_qwen_image_2_1_t2i.json`, `image_qwen_image_2_1_image_edit.json` | UNETLoader → [LoRAs] → QwenImage21Cache(auto) → KSampler(euler, simple); CLIPLoader(qwen_image) → TextEncodeQwenImage21 (outputs: positive, negative); references go on `images.image_1..N` plus `vae`, with resolution 1024; EmptyLatentImage |

Where we deliberately differ from the templates:

- Output size always comes from the request. The edit templates instead size the output from the first reference: FLUX.2 via GetImageSize, Qwen via the encoder's latent output.
- The Qwen prompt-enhancer branch, which is off by default in the templates, is out of scope.
- We use `SaveImage` rather than `SaveImageAdvanced`.

## VRAM (RTX 5090, 32 GB)

Estimated from the file sizes in the registry (decimal GB) and not measured on a GPU:

| model | diffusion | text encoder | VAE | total weights |
|---|---|---|---|---|
| FLUX.2 klein 9B fp8 + Qwen3-8B fp8mixed | 9.43 | 8.66 | 0.34 | **18.4** |
| Qwen-Image 2.1 int8 + Qwen3-VL-8B int8 | 7.26 | 9.35 | 0.68 | **17.3** |
| Chroma1-HD fp8mixed + T5-XXL fp16 | 9.19 | 9.79 | 0.34 | 19.3 |
| Z-Image Turbo bf16 + Qwen3-4B | 12.31 | 8.04 | 0.34 | 20.7 |

Every model fits fully resident in 32 GB, leaving about 11–15 GB for activations at
1–2 MP. Even so, ComfyUI's normal memory management offloads the text encoder to
RAM after encoding when it needs room.

Qwen's `QwenImage21Cache(auto)` keeps its KV cache in spare VRAM and falls back to
RAM. That matters most with 4 references.

Container RAM on the 5090 pool has not been checked. ComfyUI loads weights through
system RAM, so about 20 GB+ of free RAM is comfortable.

## Local tests

```sh
cd worker
uv venv --python 3.13      # .venv is gitignored
uv sync
uv run pytest -q
```

**What the tests cover:**

- **Graphs:** every model with and without references and LoRAs. Node input names, link types and output indexes are checked against `tests/fixtures/object_info_v0.39.0.json`, a trimmed `GET /object_info` from ComfyUI v0.39.0.
- **Path sanitising.**
- **Download manager**, against a local HTTP server: resume, Range ignored, sha and size mismatch, total stall and trickle stall, retry cap and backoff, auth per host, auth dropped on a cross-host redirect, redirect loops.
- **Pod server** (`tests/test_server.py`), a real aiohttp server on a random port with a fake action and an injected clock. It covers:
  - auth: 401s, open `/ping`, and refusing to start without `API_TOKEN`
  - the run → status lifecycle, with progress `output` and `delayTime`/`executionTime`
  - generate jobs running FIFO, one at a time, with downloads running alongside
  - cancelling queued jobs, running generate (interrupt), running downloads, and the real handler's cooperative download cancel
  - `executionTimeout`, the failure shape, and 30-minute expiry
  - the idle watchdog and the terminate call, with mocked HTTP and `runpodctl`: retrying every `RETRY_S` without ever exiting, reset on requests and jobs, the startup arm check and its `/health` report, and keys never reaching the logs
- **Handler actions**, with a fake ComfyUI built from message and response shapes captured from a real v0.39.0 run. This includes parallel downloads with aggregate progress.
