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
