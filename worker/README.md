# Image Studio worker (RunPod Serverless or dedicated pod + ComfyUI)

Custom worker for Image Studio. It runs ComfyUI v0.39.0 and implements the job
protocol in `docs/spec.md` ("Worker job protocol"). The same image runs as a
RunPod Serverless worker (default) or, with `MODE=pod`, as an HTTP server on a
dedicated GPU pod ("v3 change"; see [Pod mode](#pod-mode-modepod)).

## Images and how code ships (v4)

Pods run the slim **runtime image**, which fetches the worker code from GitHub every
time it starts (`docs/spec.md`, "v4 runtime image + code at boot"):

| | Runtime image (default) | Legacy image |
|---|---|---|
| Image | `ghcr.io/algotradingfervid/image-studio-runtime` | `ghcr.io/algotradingfervid/image-studio-worker` |
| Dockerfile | `Dockerfile.runtime` | `Dockerfile` |
| Built by | `runtime-image.yml`: on changes to `Dockerfile.runtime*`, `boot/**` or `requirements-runtime.txt`, or by hand | `worker-image.yml`: by hand only |
| Worker code | downloaded at boot from `WORKER_REF`, with a baked fallback | baked in |
| Size (compressed) | about 4.5 GB, estimated (the CI summary prints the real figure) | about 14.8 GB |

**Shipping code:** push to `main`, then Stop and Start the GPU. Nothing is built.
To pin a version, set `"workerRef": "<commit sha>"` in the app's settings file
(`~/Library/Application Support/com.naren.imagestudio/settings.json`). The default is `"main"`.

**Back to the legacy image** (no app rebuild): set
`"podImage": "ghcr.io/algotradingfervid/image-studio-worker:latest"` in the same file,
then Stop and Start. If that image is stale, rebuild it first with
**Actions → worker-image → Run workflow**.

### Runtime image (`Dockerfile.runtime`)

The build context is the repo root. `Dockerfile.runtime.dockerignore` limits it to `worker/boot/`,
`worker/src/`, `worker/requirements-runtime.txt` and `shared/models.json`.

```sh
docker buildx build --platform linux/amd64 -f worker/Dockerfile.runtime \
  --build-arg GIT_SHA=$(git rev-parse HEAD) -t <registry>/image-studio-runtime:<tag> .
```

Pinned versions:

| Component | Version | Source |
|---|---|---|
| Base | `python:3.12.15-slim-bookworm@sha256:34386ef0…7258` | Docker Hub |
| torch / torchvision / torchaudio | 2.11.0 / 0.26.0 / 2.11.0 `+cu130` | `download.pytorch.org/whl/cu130` |
| ComfyUI | v0.39.0, commit `b0b743566f65…` (checked at build) | codeload tag tarball |
| Worker deps (`requirements-runtime.txt`) | runpod 1.12.0, requests 2.34.2, websocket-client 1.9.2, transformers <5, huggingface-hub <1.0 | PyPI |
| uv (build only, bind-mounted, not in the image) | 0.11.7 | `ghcr.io/astral-sh/uv` |
| apt | `libtcmalloc-minimal4` only | Debian bookworm |

There is no CUDA toolkit in the image. The cu130 torch wheels pull the CUDA 13.0 runtime as wheels
(`cuda-toolkit[cublas,cudart,…]==13.0.2`, installed under `site-packages/nvidia/cu13/lib`, plus
`nvidia-cudnn-cu13`, `nvidia-nccl-cu13`), and the NVIDIA container runtime mounts the host
driver. cu130 rather than cu128 because ComfyUI v0.39.0 disables comfy-kitchen's CUDA backend
(the fused int8/fp8 kernels) when `torch.version.cuda` is below 13; comfy-kitchen dlopens
`libcublasLt.so.13` from the `nvidia-cublas` wheel. The pod server logs at boot whether that
backend is enabled and reports it as `cudaKernels` in `/health` (`src/cuda_info.py`). The image sets `NVIDIA_VISIBLE_DEVICES=all` and
`NVIDIA_DRIVER_CAPABILITIES=compute,utility`, as the `nvidia/cuda` images do.

The cu130 kernels cover sm_75 through sm_120:

- Blackwell RTX PRO 4000/4500/6000 is sm_120.
- Ada (RTX 4090) runs the sm_86 kernels.

They need host driver ≥ 580 (CUDA 13.0).

**What the Dockerfile does:**

1. Installs tcmalloc from apt.
2. Downloads the ComfyUI tag tarball and checks its commit.
3. Installs torch in its own layer from the cu130 index. It asserts the version, that `torch.version.cuda` is 13.x and that sm_120 kernels are present.
4. Installs ComfyUI's requirements and `requirements-runtime.txt`, with torch frozen by a constraints file. It then removes the six `comfyui-workflow-templates-media-*` packages, about 0.5 GB of example media for the web UI, which this worker never serves.
   Step 4b then checks, without a GPU, that comfy-kitchen's CUDA extension loads and finds `libcublasLt.so.13`.
5. Runs the CPU smoke tests:
   - checks the ComfyUI version
   - runs `main.py --quick-test-for-ci --cpu`
   - runs `boot/check_comfy_nodes.py`, which asserts that every node class `src/workflows.py` adds is registered

   It then precompiles bytecode.
6. Copies `boot/boot.py` to `/boot`, and `src/` + `shared/models.json` to `/app-baked` (the fallback), with `BUILD_INFO.json` = `{"commit": $GIT_SHA}`. It then runs `boot.py --check /app-baked`.

`CMD ["python", "-u", "/boot/boot.py"]`.

### Boot sequence (`boot/boot.py`, standard library only)

1. Download `https://codeload.github.com/algotradingfervid/image-studio/tar.gz/$WORKER_REF`. The default ref is `main`; a branch, tag, or short or full SHA also works. Each attempt has a 20 s deadline, with 3 attempts and 1 s / 2 s backoff. A 404 is final.
2. Check the tarball:
   - one top-level dir
   - no absolute paths or `..`, which reject the whole tarball
   - no symlinks or hardlinks among the files taken
   - `src/handler.py`, `src/server.py`, `src/extra_model_paths.yaml` and `models.json` present
   - `models.json` parses as JSON
   - every `.py` compiles
   - a full-SHA ref matches the tarball commit

   Then extract only `worker/src/**` → `/app/src` and `shared/models.json` → `/app/models.json`, and run `import handler, server` in a subprocess. The commit comes from the tarball's pax `comment` header, or from the `image-studio-<sha>` dir name.
3. On any failure, log a `FALLBACK` banner with the reason and use `/app-baked`. `WORKER_CODE_SOURCE=baked` forces this. If `/app-baked` is broken too, the container exits.
4. Write `{source, ref, commit, error?}` to `$IMAGE_STUDIO_CODE_INFO` (`/tmp/image_studio_code.json`). The pod server returns it as `code` in `GET /health`.
5. Start ComfyUI, matching upstream `start.sh`:
   - `LD_PRELOAD` = tcmalloc
   - `--disable-auto-launch --disable-metadata --listen 127.0.0.1 --port 8188 --extra-model-paths-config <code>/src/extra_model_paths.yaml --verbose $COMFY_LOG_LEVEL --log-stdout $COMFY_EXTRA_ARGS`
   - PID in `/tmp/comfyui.pid`
6. Start a non-fatal GPU check in parallel. It logs the GPU, its `sm_XY` and torch's arch list, or a "no kernel image" hint. `GPU_CHECK=0` turns it off.
7. `exec python -u <code>/src/handler.py`, with the environment passed through, plus `PYTHONPATH=<code>/src` and `REGISTRY_PATH=<code>/models.json`. `MODE=pod` gives the pod server; anything else gives `runpod.serverless.start`.

| Boot variable | Purpose |
|---|---|
| `WORKER_REF` | Git ref to load code from. Default `main`. The app sends it from `workerRef`. |
| `WORKER_REPO` | `owner/name`. Default `algotradingfervid/image-studio`. |
| `WORKER_CODE_SOURCE=baked` | Skip GitHub and use `/app-baked`. |
| `COMFY_LOG_LEVEL` | ComfyUI `--verbose` level. Default `DEBUG`, as upstream. |
| `COMFY_EXTRA_ARGS` | Extra ComfyUI flags, shell-split. |
| `GPU_CHECK=0` | Skip the GPU diagnostic. |

### Legacy image (`Dockerfile`)

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
| `VIDEO_TIMEOUT_S` | `generate_video` watchdog. Default 3000 s; send `policy.executionTimeout` ≥ 3 000 000 ms. |

The image and boot script set these; you normally don't change them: `REGISTRY_PATH`, `VOLUME_ROOT=/runpod-volume`, `COMFYUI_PATH=/comfyui`, `PYTHONPATH`, `IMAGE_STUDIO_CODE_INFO`.

Tokens are never forwarded across hosts. Redirects are followed manually, and the
`Authorization` header is dropped as soon as a redirect leaves the original host,
for example HF → CDN or Civitai → a presigned S3/R2 URL.

## Pod mode (`MODE=pod`)

The entrypoint (`boot.py`, or `/start.sh` on the legacy image) starts ComfyUI
(on 127.0.0.1:8188, not exposed) and runs `handler.py`, whose `main()` sees `MODE=pod` and starts
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
| `WORKER_REF` | Runtime image only: the git ref the code was loaded from (see [Boot sequence](#boot-sequence-bootbootpy-standard-library-only)). |
| `HF_TOKEN`, `CIVITAI_API_KEY`, … | As in serverless mode. |
| `PREFETCH_MODELS` | Comma-separated model ids to copy to the local disk at boot; the first one is also warmed up (see [Local model copies](#local-model-copies-and-warm-up)). The app sends the profile's last generated model. |
| `COMFY_LOG_LEVEL` | ComfyUI `--verbose` level (boot.py default `DEBUG`); the app sends `INFO`. |
| `LOCAL_MODELS` | `0` turns the local copies off. |
| `LOCAL_MODELS_ROOT`, `LOCAL_COPY_THREADS`, `LOCAL_COPY_CHUNK_MB`, `LOCAL_COPY_RESERVE_GB`, `LOCAL_COPY_WAIT_S` | Copier tuning: default `/models-local`, 16 threads, 64 MB ranges, 4 GB kept free, a job waits at most 1800 s for its copies. |
| `WARMUP` | `0` turns the boot warm-up off. |

Secrets are never logged. The startup line names only the key variables that are set.

### API (compatible with RunPod serverless)

Every route also answers under `/v2/<anything>/…`, so the serverless URL shape works too.

| Route | Response |
|---|---|
| `POST /run {input, policy?}` | `{id, status: "IN_QUEUE"}`. Ids look like `pod-<uuid>`. The body can be up to 32 MB. |
| `GET /status/{id}` | `{id, status, delayTime, executionTime, output?, error?}` |
| `POST /cancel/{id}` | `{id, status}` |
| `GET /health` | `{jobs: {inQueue, inProgress, completed, failed}, workers: {idle, running}, ready, gpu, comfyui, watchdog: {armed, check, idleMinutes, idleForS, lastError}, code?: {source: "github"\|"baked", ref, commit, error?}}` (see [Idle watchdog](#idle-watchdog)). `code` is present only on the runtime image. |
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

- `generate` and `generate_video` jobs share one FIFO queue and run one at a time on a dedicated thread. Cancelling a running video job interrupts ComfyUI, as for `generate`.
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

### Local model copies and warm-up

ComfyUI v0.39.0 reads weights lazily during the first forward pass with small
blocking reads, which ran at 30-150 MB/s from the network volume. In pod mode,
`src/local_models.py` therefore copies a model's files from
`/runpod-volume/models/<folder>/<file>` to the container disk at
`/models-local/<folder>/<file>`, one file at a time. Each file is read with 16
parallel `os.pread` calls of 64 MB and written with `os.pwrite` into
`<file>.<random>.part`. The part file is renamed only after its size matches
the source. Within a model the order is text encoder, then unet, then VAEs and
the upscaler. LoRAs stay on the volume.

`src/extra_model_paths.yaml` lists `/models-local` as `is_default`, so ComfyUI
searches it first. A file that is still copying, failed, or was skipped for
space is simply not there yet, and ComfyUI loads it from the volume.
`--fast-disk` is not set: it is a global switch and would also force the slow
disk-backed path for files that fall back to the volume.

- **On demand.** A `generate` / `generate_video` job requests its model with
  priority. Its files jump the queue, and a copy of another model's file that
  is already in progress is paused and restarted later. The job waits in
  progress stage `copying_models` (`phase: "loading"`, plus `copyPercent`,
  `copyBytes` and `copyTotalBytes`) for at most `LOCAL_COPY_WAIT_S`. A copy
  error never fails the job; those files load from the volume.
- **Prefetch.** `PREFETCH_MODELS` is queued right after the server starts.
- **Warm-up.** Once the first prefetched model is copied and ComfyUI is up, the
  server runs one 1-step job through the normal handler and discards its
  output. Image jobs are 256x256; video jobs use the smallest resolution and
  the minimum duration. The warm-up is skipped once any real generate job has
  been submitted, and a job that arrives during it waits only for that
  warm-up. It is not a job: it is not listed or counted and does not reset the
  idle watchdog.
- **Idempotent.** A local file with the source's size counts as done, including
  after a restart. Two requests for the same file share one copy. Stale
  `.part` files are deleted at boot. `download` and `delete` drop the local
  copy of any volume file they change.
- **Space.** Before each file the copier checks free space, keeping
  `LOCAL_COPY_RESERVE_GB` spare. A file that does not fit is skipped and logged.

`GET /health` adds the following fields:

- `localModels: {<model>: {state, doneBytes, totalBytes, MBps, files: [{folder, filename, state, doneBytes, totalBytes, MBps, error?}]}}`.
  The model state is one of `queued`, `copying`, `done`, `failed`, `skipped`,
  `missing` or `idle`.
- `warmup: {model, state, detail?, elapsedMs?}`.

## Volume layout

```
/runpod-volume/models/
  unet/               diffusion models   (ComfyUI: diffusion_models / unet)
  clip/               text encoders      (ComfyUI: text_encoders / clip)
  vae/
  loras/<modelId>/    LoRAs; ComfyUI lora_name = "<modelId>/<filename>"
  latent_upscale_models/   video (v5): the LTX-2.5 x2 spatial latent upscaler
```

The video models live on their own volume, `image-studio-video` (CA-MTL-3), with the
same layout. `extra_model_paths.yaml` maps every folder to `/runpod-volume/models/<folder>`.

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
| `generate_video` | `model, prompt, negativePrompt?, initImage?: {name, base64}, durationS, fps, resolution, seed, steps?, cfg?, audio` | `{video: {base64 (MP4), mime, width, height, fps, frames, durationS, hasAudio, sizeBytes}, poster: {base64 (JPEG), mime, width, height}, seed, timings: {loadMs, sampleMs, encodeMs, totalMs}}` |

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

### `generate_video` (v5)

Video models come from `videoModels` in `shared/models.json` (`h3` MiniMax H3, `ltx25`
LTX-2.5 distilled). Each has `modes`, `audio`, `volume`, `defaults {durationS, fps,
resolution, steps, cfg, …}`, `limits {minDurationS, maxDurationS, resolutions, fpsOptions}`
and `tunable {steps, cfg}`. Each file also has a `role` (`unet`, `clip`, `video_vae`,
`audio_vae`, `spatial_upscaler`), which is how the graph builder picks it.

| | `h3` | `ltx25` |
|---|---|---|
| defaults | 5 s, 24 fps, `864x480`, 20 steps | 5 s, 24 fps, `1280x704`, cfg 1.0 |
| durationS | 2–15 | 2–20 |
| fps | 24 (fixed by the model) | 24, 25 |
| resolutions | `864x480` `480x864` `640x640` `1344x768` `768x1344` `768x768` | `1280x704` `704x1280` `1024x1024` `896x512` `512x896` `1920x1088` `1088x1920` |
| frames | `max(5, round(d·24))` snapped **up** to 17k+5 (5 s → 124) | `d·fps` snapped to the nearest 8n, + 1 (5 s @ 24 → 121) |
| steps | `steps` → BasicScheduler | fixed: the template's manual sigmas, 8 + 3 (`steps` ignored) |
| cfg | ignored (BasicGuider, no negative prompt) | → `video_cfg` and `audio_cfg` of both LTXVDualCFGGuiders |

- **Input:** `durationS`, `fps`, `resolution`, `steps`, `cfg` and `negativePrompt` may be
  omitted or null; they then take the model's `defaults`. `resolution` (a string `"WxH"`)
  and `fps` must be listed in `limits`; `durationS` must be within the limits. `audio`
  defaults to `true`. Without `seed` the worker picks one and returns it.
- **Image → video:** `initImage` (PNG, JPEG or WebP; uploaded like references) makes it
  i2v. The output keeps the start image's aspect ratio at the preset's pixel count, rounded
  to multiples of 32 (H3) or 64 (LTX). The templates instead stretch (H3) or centre-crop (LTX)
  the image to a fixed canvas. Read the real size from `video.width/height`.
- **Audio off:** both models still sample the joint audio+video latent, which is how they
  are trained, but the audio is not decoded and the MP4 has no audio track.
- **Output:** the MP4 is H.264 (`yuv420p`) with AAC audio, written by ComfyUI's
  `CreateVideo` → `SaveVideo(format mp4, codec h264)` through PyAV, whose wheels bundle
  FFmpeg with libx264. `width`, `height`, `frames`, `durationS` and `hasAudio` are read
  from the MP4's `moov` box; if that fails they fall back to the graph's values.
  `durationS` is `frames / fps` (5 s on H3 is 124 frames, 5.167 s). The poster is frame 0
  (`ImageFromBatch` → `SaveImage`), re-encoded as JPEG q90 with Pillow (PNG with
  `mime: image/png` if Pillow is missing, which it never is in the image).
- **Errors:** `UNKNOWN_MODEL`, `INVALID_INPUT: …` (prompt, durationS, fps, resolution,
  seed, steps 1–100, cfg 0–30, audio), `INVALID_INIT_IMAGE: …`,
  `MODEL_NOT_INSTALLED: <folder/file>, …` (every file of the model's `videoModels` entry
  must be on the volume), `COMFYUI_INVALID_PROMPT`, `COMFYUI_EXECUTION_ERROR`,
  `COMFYUI_NO_OUTPUT: the workflow produced no video`, and `COMFYUI_TIMEOUT` after
  `VIDEO_TIMEOUT_S` (default 3000 s; images keep `GENERATE_TIMEOUT_S` = 590 s). Send
  `policy.executionTimeout` of at least 3 000 000 ms for video.
- **Timings:** `loadMs` and `sampleMs` as for `generate`. With LTX, `sampleMs` covers both
  samplers and the upscaler between them. `encodeMs` runs from the end of sampling to the
  end of the handler (decode, mux, fetching the files).
- **Size:** base64 makes the output about 1.33× the MP4. A 10–20 s 720p clip is typically
  5–30 MB, so 7–40 MB of JSON. The pod server returns it whole: aiohttp's
  `client_max_size` (32 MB) limits only request bodies. The serverless `/status` output
  limit was not checked; video is meant for the pod.

### Progress (`runpod.serverless.progress_update`, at most 2 per second)

- `generate`: `{phase: "loading" | "sampling" | "saving", stage, stages, step, totalSteps, elapsedMs, stageElapsedMs, cached, cachedStages, stageTimes}`. The final step and every stage change are always sent.
  - `stage` comes from the class of the node ComfyUI reports as `executing`: `loading_text_encoder` (CLIPLoader*), `encoding_prompt` (CLIPTextEncode*, TextEncodeQwenImage21, T5TokenizerOptions), `loading_model` (UNETLoader, UnetLoaderGGUF, LoraLoaderModelOnly, ModelSampling*, QwenImage21Cache), `preparing_references` (LoadImage, ImageScaleToTotalPixels, VAEEncode, ReferenceLatent), `sampling`, `decoding`, `saving`. Other nodes keep the current stage. `phase` is the v1 value of the stage.
  - `stages` lists the stages of this graph in display order, known from the first update. ComfyUI may run them in another order, so use `stageTimes` (ms spent in each stage already left) and `cachedStages` to mark stages done.
  - `cachedStages` are stages whose nodes ComfyUI reported in `execution_cached` (they never run). `cached` is true when a loader stage is among them, meaning the weights were already in memory.
  - `elapsedMs` counts from the start of the job; `stageElapsedMs` from the start of the current stage.
- `generate_video`: the same shape. Its stages are `loading_text_encoder`, `encoding_prompt`
  (CLIPTextEncode, LTXVConditioning, MiniMaxH3ImageToVideo), `loading_model` (UNETLoader,
  LatentUpscaleModelLoader), `preparing_init_image` (i2v: LoadImage, ResizeImageMaskNode,
  LTXVPreprocess, LTXVImgToVideoInplace), `sampling` (SamplerCustomAdvanced, and for LTX the
  upscaler and stage-2 image conditioning between the two samplers), `video_decoding`
  (VAEDecode / VAEDecodeTiled), `audio_decoding` (VAEDecodeAudio / LTXVAudioVAEDecode; only
  with audio), `encoding_video` (CreateVideo, SaveVideo, poster) and `saving` (fetching the
  MP4). `step`/`totalSteps` count across all samplers: LTX reports 1–8, then 9–11 of 11.
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

- `folder` must be `unet`, `clip`, `vae`, `latent_upscale_models` or `loras/<modelId>`, where `<modelId>` is in the registry. `status` lists `unet`, `clip`, `vae`, `latent_upscale_models` and `loras/*`.
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

**Video (v5),** `build_video_workflow(params, registry) -> (graph, info)`, from the same
templates commit:

| model | template(s) | graph |
|---|---|---|
| h3 | `video_minimax_h3_t2v.json`, `video_minimax_h3_i2v.json` (subgraph "Image to Video (MiniMax H3)") | UNETLoader → BasicScheduler(simple, steps) + BasicGuider; CLIPLoader(minimax) + VAELoader(video) → MiniMaxH3ImageToVideo(prompt, W, H, length[, first_frame ← LoadImage]); RandomNoise + KSamplerSelect(res_multistep) → SamplerCustomAdvanced → VAEDecode + VAEDecodeAudio(audio VAE) → CreateVideo(24) → SaveVideo |
| ltx25 | `video_ltx2_5_t2v.json`, `video_ltx2_5_i2v.json` | CLIPLoader(ltxv) → CLIPTextEncode ×2 → LTXVConditioning(fps). Stage 1 at W/2×H/2: EmptyLTXVLatentVideo [→ LTXVImgToVideoInplace 0.7] + LTXVEmptyLatentAudio → LTXVConcatAVLatent → SamplerCustomAdvanced(seed, LTXVDualCFGGuider, euler_ancestral, 8 manual sigmas) → LTXVSeparateAVLatent. Stage 2: LTXVLatentUpsampler(x2) [→ LTXVImgToVideoInplace 1.0] + stage-1 audio → Concat → SamplerCustomAdvanced(seed 42, 3 manual sigmas) → Separate → VAEDecodeTiled(512, 64, 64, 16) + LTXVAudioVAEDecode → CreateVideo(fps) → SaveVideo. i2v image: LoadImage → ResizeImageMaskNode(longer side 1536, lanczos) → LTXVPreprocess(18) |

`fl2va` ("first/last frame → video + audio") is the only H3 diffusion model either template
loads. With no keyframe it is text → video; with `first_frame` it is image → video. Both run
on the same `MiniMaxH3ImageToVideo` node.

Where the video graphs differ from the templates:

- Model variants follow the registry. H3 uses the fp8-scaled diffusion model, the int8
  text encoder and the fp16 video VAE; the templates use int8 / nvfp4 / int8. All of them
  are variants in `Comfy-Org/MiniMax-H3`, and ComfyUI's loaders detect the format.
- Left out because they are off by default: the H3 turbo-LoRA switch, and the LTX prompt
  enhancer (`TextGenerateLTX2Prompt` + `gemma4_e2b`, about 5 GB more). Also left out: the
  Math, Primitive and Switch helpers (computed in Python), notes, and `PreviewAny`.
- i2v sizing follows the start image (see `generate_video`).
- LTX stage 2 keeps the template's fixed noise seed 42; `seed` drives stage 1.
- A frame-0 poster branch (`ImageFromBatch` → `SaveImage`) is added.
- The LTX duration head (`model_patches/`), temporal upscaler and conv VAE are on the
  volume, but no template uses them, so they are not in `videoModels`.

The fixture `tests/fixtures/object_info_v0.39.0.json` had no video nodes. The 20 classes the
video graphs use were transcribed from the ComfyUI v0.39.0 source (see its `_added`).
`boot/check_comfy_nodes.py` also checks them against a real ComfyUI when the runtime image
builds.

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

- **Video graphs** (`tests/test_video_workflows.py`): both models × t2v/i2v × audio on/off, validated against the fixture, including DynamicCombo (`format.codec`) and MatchType inputs. Also covered: frame rules, sizes, seeds, steps and cfg, defaults and limits, rejections, stages, and that `videoModels` lists exactly the files the graphs load.
- **`generate_video`** (`tests/test_video_handler.py`): a fake ComfyUI returns a real 9-frame H.264 + AAC MP4 (`tests/fixtures/tiny_h264_aac.mp4`, written with PyAV 19.0.1 / libx264) and a PNG poster. Covered: output and metadata, progress across two samplers, validation errors, `MODEL_NOT_INSTALLED`, the video timeout, cancel, `latent_upscale_models` status/download/delete, and a 40 MB output through the pod server.
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
- **Boot** (`tests/test_boot.py`), covering:
  - extraction of only `worker/src` and `models.json` from a fake GitHub-style tarball
  - rejection of path traversal, links, a second top-level dir, missing files, syntax errors, bad JSON and garbage
  - commit parsing, from the pax header or the dir name
  - download retries, the per-attempt deadline, 404 and the size cap
  - fallback to the baked copy on HTTP failure, a bad tarball, a failed import check or a SHA mismatch
  - the ComfyUI command line and handler environment
  - a check that `boot.py` imports only the standard library
- **Handler actions**, with a fake ComfyUI built from message and response shapes captured from a real v0.39.0 run. This includes parallel downloads with aggregate progress.
