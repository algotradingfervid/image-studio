# Progress / resume notes — 2026-10-09 (paused: owner on a flight)

## State
- All work committed. `main` is 1 commit ahead of origin (`aaa7172` vault-migration fix, app-only) — owner pushes when back (`git push`; not needed by pods).
- Installed app: /Applications/Image Studio.app = build of `7bff12f`. App data: ~/Library/Application Support/com.naren.imagestudio (vault created; 24 images migrated).
- No RunPod pods running (checked at pause). Runtime image `image-studio-runtime:latest` = CUDA 13 (cu130) build, CI success 2026-10-09 01:38 UTC.
- Volumes: image-studio-models (EU-RO-1), image-studio-video (CA-MTL-3, H3 + LTX-2.5 files verified).

## Owner to-do on return
1. Open the app → Vault tab → unlock → General tab → open the H3 video → **Move to vault** (it was skipped by the migration bug fixed in `aaa7172`). Check it plays in the Vault with its start image.
2. First GPU start on the new image: verify /health `cudaKernels.enabled: true`, `localModels` copy speed (MBps), and the warm-up; record numbers in docs/results.md.

## Pending work (in order)
1. **UI/UX review** (`/ux-review`) — paused during phase 4. Run folder: ~/ux-reviews/127.0.0.1-5180-20261009-0703 (screens.json = 66 screens merged, brief.json with owner answers, groups.json, lead-queue.md). No findings were written yet. Resume: serve the frozen app in mock mode
   (`cd <stable worktree or repo>/app && npx vite --port 5180 --strictPort --host 127.0.0.1`), then relaunch phase 4 (G1–G14 desktop, narrow-tablet, hunter, then 8 task walkers), verifiers, editor, report.
   Owner answers (in brief.json): ALWAYS confirm before any paid GPU start (show hourly price); vault protects against other Mac users AND casual exposure (strict); layouts must work down to ~800px window width; phone not a target.
2. **Implement "always confirm before starting a paid GPU"** (owner decision) — header Start, Start GPU & Generate (image + video), Models Download/Refresh. Show profile + hourly price.
3. Fix the review findings.
4. Deferred by owner: Sequence/storyboard long-form video feature; FastH3 / EasyCache / NVFP4 declined; H3 Turbo LoRA mentioned only.

## Known gaps / unverified
- Vault inside the real WKWebView: vault:// video playback + real Mac-sleep lock not yet exercised end to end.
- Fast-load copier and container-disk throughput unmeasured; `--fast-disk` intentionally off.
- CUDA 13 hosts (driver ≥ 580) availability unknown; pods request `gpu.minCudaVersion: "13.0"`.

## Update 2026-10-09 ~11:40 IST
- UX review COMPLETE: report at ~/ux-reviews/127.0.0.1-5180-20261009-0703/report.html (95 findings: 4 critical, 13 high, 37 medium, 41 low; UX-001 already fixed).
- Owner decisions recorded in docs/ux-fix-plan.md.
- Fixes in progress: 4 parallel agents (A layout, C create, D gallery/lightbox/jobs/vault views, E GPU/settings/models/Rust) per docs/ux-fix-plan.md ownership. After they finish: run tsc/build/cargo test/clippy, commit, rebuild app, install to /Applications, ask owner to push (worker unchanged unless E touched it).
- Commits since pause: f90832b (always confirm paid GPU start), e9166a9 (video confirm/pill in serverless).
