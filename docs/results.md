# Measured Results & Gotchas

## Model install (2026-10-08)
- **Volume:** `image-studio-models` (`xzrw5sl5ho`), 100 GB STANDARD, EU-RO-1.
- **Method:** temporary CPU pod (`cpu3c`, 4 vCPU, $0.12/h) with the volume mounted at `/runpod-volume`. A stdlib Python downloader ran 3 files in parallel over plain HTTPS.
- **Result:** 11 files, 75.4 GB, **310 s, average 244 MB/s** (peaks around 600 MB/s). Cost about $0.02.
- **Verification:** 10 files passed SHA-256. `flux-2-klein-9b-fp8.safetensors` was size-checked only, because its sha256 needs auth to read. It is now in `shared/models.json`, so later downloads verify it.

## Gotchas
- **Hugging Face's Xet download path stalled at 0 KB/s** on the home connection; plain HTTPS `resolve/main` URLs worked. Never use `huggingface_hub`/Xet for downloads in this project.
- **fp8 doesn't run on Apple Silicon (MPS)**, which is why v1 (local) used GGUF. Irrelevant now that inference runs on RunPod.
- **The datacenter listing ≠ volume support.** CA-MTL-1 is listed as storage-capable but offers only HIGH_PERFORMANCE volumes. Use `GET /v2/catalog/datacenters` → `networkVolumeTypes`.
- **Serverless stock ≠ pod stock.** Check `GET /v2/catalog/gpus?include=AVAILABILITY&product=SERVERLESS` per datacenter. L40S/A6000 serverless stock was only in datacenters without volumes.
- **`runpod/worker-comfyui:5.11.0-base` doesn't exist.** Use `5.10.0-base-cuda12.8.1`; Blackwell GPUs need CUDA ≥ 12.8.
- **worker-comfyui only maps `models/unet` and `models/clip`** (not `diffusion_models`/`text_encoders`) unless you ship your own `extra_model_paths.yaml`, which the worker does.
- **Secrets:** `.env.example` is committed, so real values go only in `.env`. A local pre-commit hook enforces this.

## Still to measure
Cold start, seconds per image per model, and cost per image. Filled in after the end-to-end run.

## 2026-10-09 — video (v5) measurements and gotchas
- **Video volume:** `image-studio-video` (`v7hzxkm304`), 150 GB, CA-MTL-3.
- **MiniMax H3 download:** 4 files, 53.9 GB, all sha256-verified. Took 445 s at 121 MB/s average, on an RTX PRO 6000 fill pod at $2.49/h (about $0.30).
- **LTX-2.5 download:** 8 files, 41.4 GB, all sha256-verified. Took 297 s at 140 MB/s average, on an H200 fill pod at $5.29/h, because no cheaper GPU was available in CA-MTL-3 after 9 GPU types were tried.
- **LTX-2.5 is gated:** the Hugging Face licence must be accepted first, or downloads return HTTP 403.
- **First real H3 video:** image→video, 15.08 s, 736×576, 24 fps, H.264 + AAC, 4.6 MB. Worker total time was 893.7 s (about 14.9 min) on an H200 in CA-MTL-3. Most of that time went to loading weights from the network volume; GPU memory grew at roughly 30–150 MB/s. The pod lived from 23:53:29 to 00:11:04 UTC (about 17.6 min, roughly $1.55).
- **Pod boot with the runtime image cached on the host:** the server was up 71 s after the pod was created.

## Video gotchas
- **Pods load worker code from GitHub `main` at boot.** A pod started before `git push` ran the old code and failed with `UNKNOWN_ACTION: 'generate_video'`. Fix: push first, then Stop and Start the GPU.
- **RTX PRO 6000 was often unavailable in CA-MTL-3,** so the app fell back to an H200 at $5.29/h.
