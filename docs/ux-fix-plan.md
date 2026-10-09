# UX review fix plan (2026-10-09)

Source: `~/ux-reviews/127.0.0.1-5180-20261009-0703/` — `final.json`, `final-findings-01..07.json` (95 findings, each with
observation, steps, recommendation, owner `answer` where given) and `report.md`. Read the findings you own there before coding.
The review ran on commit `aaa7172`; UX-001 (confirm before paid GPU start) is already fixed (`f90832b`, `e9166a9`).

## Owner decisions (binding)
- Cancel the only job while its GPU is starting → stop that GPU automatically, and say so on the card.
- A GPU started only for Refresh / Download / Delete (models or LoRAs) → stop it when the task finishes, unless a generation started meanwhile.
- "Save to" (General | Vault) never changes by itself (not on vault creation, unlock, lock or auto-lock). Saving to a locked vault still works.
- Vault auto-lock minutes can only be changed while the vault is unlocked (UI and Rust).
- Video resolution auto-matches the start image's orientation (closest preset of the same orientation; user can still change it).
- Each model remembers its own form state (LoRAs + strengths, seed, steps, CFG, negative prompt, duration/resolution/audio for video); switching back restores it; keep the start image when the new model supports it.
- Remove Serverless (legacy) mode from the app (UI + settings; keep old saved settings loading without error → treat as pod).
- Add "Add LoRA from link" inside the Create screen's LoRA menu; keep the Models library.
- Always confirm before any paid GPU start (done). Vault threat model: nothing from the vault visible while locked. Windows must work down to ~800 px wide.

## Ownership (no agent edits another agent's files)
| Agent | Owns (edit only these) | Findings |
|---|---|---|
| **A — Layout** | `app/src/styles.css`, `app/src-tauri/tauri.conf.json`, `app/src/App.tsx`, `app/src/components/Dialog.tsx`, `app/src/main.tsx` | UX-002, 018, 051 (vault-unlocked indicator + Lock in the header), 056, 058, 065, 070, 085, 087 |
| **C — Create screen** | `app/src/screens/create/CreateScreen.tsx`, `Controls.tsx`, `VideoPanel.tsx`, `GalleryPicker.tsx` | UX-003, 005, 009, 010, 011, 012, 015, 022, 024, 025, 027, 033, 034, 035, 036, 046, 050, 054, 057, 060, 068, 069, 078, 079, 080, 081, 082, 084, 086, 094 |
| **D — Gallery, lightbox, jobs, vault views** | `app/src/screens/create/Gallery.tsx`, `Lightbox.tsx`, `JobCard.tsx`, `VaultViews.tsx`, `app/src/state/vault.tsx`, `app/src/state/library.tsx`, `app/src/components/Toast*` | UX-006, 007, 008, 019, 020, 032, 037, 038, 039, 040, 041, 049, 059, 061, 062, 063, 073, 074, 075, 083, 095, and the job-card half of UX-014 |
| **E — GPU, Settings, Models, Rust** | `app/src/screens/settings/*`, `app/src/screens/models/*`, `app/src/components/GpuPill.tsx`, `StartGpuDialog.tsx`, `app/src/state/gpu.tsx`, all of `app/src-tauri/src/**` and `app/src-tauri/tests/**` | UX-004, 013, 014 (backend + GPU stop), 016, 017, 021, 023, 026, 028, 029, 030, 031, 042, 043, 044, 045, 047, 048, 052, 053, 055, 064, 066, 067, 071, 072, 076, 077, 089, 090, 091, 092, 093, and auto-lock-only-while-unlocked |

Shared files: `app/src/api/types.ts`, `api/index.ts`, `api/backend.ts`, `api/mock.ts`, `components/Icon.tsx` — **additive edits only** (add new
fields/functions/icons; never rename or remove), re-read right before each edit. CSS: only A edits `styles.css`; C, D, E put new
rules in their own new file (`app/src/styles/create.css`, `gallery.css`, `gpu-settings.css`) imported from one of their own
components. Cross-agent needs: C exposes nothing new; D may call existing library/vault hooks; if you need another agent's
file changed, describe it in your final summary instead of editing it.

Interfaces agreed up front:
- `state/vault.tsx` (D) keeps its current API. C clears/restores vault-derived Create state by reacting to `useVault().status.unlocked` changing (no new API needed).
- "Redraw this image" (UX-037, D) uses the same mechanism "Make video" already uses to hand a start image to the Create screen, in Image mode.
- Header (A) reads GPU state only through `useGpu()` and vault state through `useVault()`.

## Done means
`npx tsc --noEmit` and `npm run build` pass; E also `cargo test` + `cargo clippy --all-targets -- -D warnings` in `app/src-tauri`;
each agent walks its flows in the browser mock (`npm run dev`) at 1440 and 820 px. Don't commit. Report per finding: fixed /
partly / not done (why).
