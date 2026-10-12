# UI review fix plan — 2026-10-12

Source: `~/ui-reviews/127.0.0.1-5180-20261011-2119/final.json` (80 actionable findings, UI-001…UI-080; observation, measured values and verified recommendations per id). Report: same folder, `report.html`.

Owner decisions:
- UI-059 vault erase: add "Erase vault and start over…" protected by **typed confirmation only** (type `erase`); no Touch ID. It deletes all vault contents and the vault itself; never reveals content.
- Owner rules still apply: always confirm before a paid GPU start (show profile + hourly price); layouts must work down to ~800px; phone is not a target; vault threat model = other Mac users + casual exposure.

## Phases

1. **P1 systemic (one agent, first):** colour tokens in `src/styles.css` (UI-001 muted text, UI-003 field borders, UI-004 focus ring, UI-015 selected states, UI-002 pending-stage colour token), shared focus handling in `src/components/Dialog.tsx` (return focus to the opener on close; per-dialog initial-focus option), safe default focus on Cancel for paid confirms in `src/components/StartGpuDialog.tsx` (UI-005), landmarks in `src/App.tsx` (UI-042). Creates `src/styles/{models,vault,jobs,viewer}.css` and imports them.
2. **P2 areas (five agents, parallel, file ownership below).**
3. **Build + tests:** `npx tsc --noEmit`, `npm run build`, `cargo test`, `cargo clippy`.
4. **Evidence:** fresh ui-verifier pass on the fixed app (mock mode, port 5180) re-checking every UI id on desktop and tablet; a finding that no longer reproduces is fixed. Before = original review shots; after = verifier shots.

## P2 ownership

| Agent | Owns (edit freely) | Findings |
|---|---|---|
| A Create form | `screens/create/{Controls,CreateScreen,VideoPanel}.tsx`, `styles/create.css` | 009 010 014 017(Create dialog) 018(Create side) 033 034 035 036 037(Create link side) 050 069 078, UI-006 in Create |
| B Gallery + viewer | `screens/create/{Gallery,GalleryPicker,Lightbox}.tsx`, `styles/{gallery,viewer}.css` | 013 023 024 025 026 027 028 029 030 031 032 063 071 072 073 080, UI-006 in gallery/picker/viewer |
| C Jobs, header, GPU, toasts | `screens/create/JobCard.tsx`, `App.tsx` (header), `components/{GpuPill,StartGpuDialog}.tsx`, `state/{gpu,toast}.tsx`, `styles/jobs.css` | 002 012 016 020 021 022 054 055 056 057 058 064 065 077, UI-006 for header Start/Stop |
| D Models + LoRA | `screens/models/{ModelsScreen,LoraLibrary}.tsx`, `styles/models.css`, LoRA/model delete in Rust | 011 017(library) 018(library side) 019 037(Models arrival) 038 040 041 051 052 053 068 070 074(LoRA) 075 076 |
| E Settings + vault | `screens/settings/SettingsScreen.tsx`, `screens/create/VaultViews.tsx`, `state/vault.tsx`, `styles/{gpu-settings,vault}.css`, vault erase in Rust | 007 008 039 043 044 045 046 047 048 049 059 060 061 062 066 067 074(vault) 079 |

Shared files (`api/mock.ts`, `api/index.ts`, `api/types.ts`, `src-tauri/src/commands.rs`, `lib.rs`, `styles.css`): Edit tool only, small hunks, re-read on a stale-file error; never rewrite whole files.

UI-018 target wording (both LoRA-from-link flows): field label "Civitai or Hugging Face link", button "Check link", confirm button "Add & download (starts GPU)", same validation and error copy as the library.
