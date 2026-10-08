# Implementation Plan — Image Studio v2

Spec: `docs/spec.md`. Contracts: the spec's worker job protocol, Tauri commands/events, and `shared/models.json`.

## Work packages (run in parallel; no shared files)
| # | Package | Owns | Depends on |
|---|---|---|---|
| A | RunPod worker: Dockerfile, handler, workflows, downloads, tests | `worker/` | registry (it may update the `defaults` of `shared/models.json`) |
| B | Rust core: RunPod client, jobs, gallery DB, Keychain, link resolver, delete rule, commands/events | `app/src-tauri/` | spec |
| C | React UI: Create/Models/Settings, mock of the commands | `app/src/`, `app/index.html`, `app/package.json`, `app/vite.config.ts` | spec |
| D | Setup: worker image build (local Docker or GitHub Actions → GHCR), RunPod REST setup script, setup docs | `scripts/`, `.github/`, `docs/setup.md` | spec |

## Integration (main session, sequential)
1. Wire the UI to the real commands; `npm run tauri build` and `cargo test`.
2. Build and push the worker image, then run `runpod_setup.py` (needs the user's RunPod key, a registry, HF token, licence acceptance).
3. Download the models from the app; run the end-to-end checks from the spec; record results in `docs/results.md`.
4. Review the final diff against the spec; commit.
