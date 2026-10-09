# Vault: UI ↔ Rust contract (spec v6)

The Rust side (`app/src-tauri`) and the UI (`app/src`) are built in parallel against this file.
Tauri commands take camelCase args and return camelCase JSON. Errors are plain strings; the
codes below are prefixes (`"WRONG_PASSWORD: ..."`).

## Types

```ts
type VaultStatus = {
  exists: boolean;            // a vault has been created
  unlocked: boolean;
  autoLockMinutes: number;    // 1..240, default 10
  itemCount: number | null;   // null while locked
  migrationPending: boolean;  // a started migration has items left (resume on unlock)
};

type MigrationProgress = {
  phase: string;              // "encrypting" | "verifying" | "cleaning" | "done" | "error"
  done: number; total: number;
  counts: { images: number; videos: number; posters: number; startImages: number; references: number };
  errors: number; error: string | null;
};

type Destination = "general" | "vault";
```

Vault items are returned as the existing `ImageRecord` shape plus `vault: true` and
`thumbPath` (a small JPEG preview for grid tiles; videos reuse the poster). Their `path`,
`posterPath`, `thumbPath`, `initImage` and `references` are
`vault://localhost/<blobId>.<ext>` URLs (the extension is the plaintext's — png/jpg/webp/mp4 —
so download names stay right; the scheme ignores it), which the UI uses directly as
`<img src>` / `<video src>` (never through `convertFileSrc`). The scheme answers 403 while
locked, supports `Range` (video seeking) and sends `Cache-Control: no-store`. General records
get `vault: false`.

## Commands

| Command | Args | Returns | Errors |
|---|---|---|---|
| `vault_status` | – | `VaultStatus` | |
| `vault_create` | `{ password }` | `VaultStatus` (unlocked) — then migrates all existing content, emitting `vault-migration` | `WEAK_PASSWORD` (< 8 chars), `VAULT_EXISTS` |
| `vault_unlock` | `{ password }` | `VaultStatus` (resumes a pending migration) | `WRONG_PASSWORD`, `NO_VAULT` |
| `vault_lock` | – | `VaultStatus` | |
| `vault_change_password` | `{ oldPassword, newPassword }` | `VaultStatus` | `WRONG_PASSWORD`, `WEAK_PASSWORD`, `VAULT_LOCKED` |
| `vault_set_auto_lock` | `{ minutes }` | `VaultStatus` | |
| `vault_touch` | – | – (resets the inactivity timer; UI calls it on user input, throttled to once per 30 s) | |
| `list_vault_items` | – | `ImageRecord[]` newest first | `VAULT_LOCKED` |
| `delete_vault_item` | `{ id }` | – | `VAULT_LOCKED` |
| `move_to_vault` | `{ id }` (general record) | `ImageRecord` (vault) | `VAULT_LOCKED` — the spec requires verifying the encrypted copy by decrypting it before the plaintext is deleted, which needs the private key, so moving in needs the unlocked vault (the UI shows "Unlock the vault to move items") |
| `move_to_general` | `{ id }` (vault item) | `ImageRecord` (general) | `VAULT_LOCKED` |
| `export_vault_item` | `{ id, dest }` (path from the save dialog) | – | `VAULT_LOCKED` |
| `delete_image` / `export_image` | existing args | as today; a vault item id falls through to `delete_vault_item` / `export_vault_item` | |
| `seal_reference` | `{ refId }` | `ImportedReference` — moves an already-imported plain reference into the vault (new `refId`, a `vault://localhost/…` URL); optional: a vault job seals plain references itself | |
| `generate`, `generate_video` | existing args + `destination: Destination` (default `"general"`); start image may also be `initImageVaultId` (vault item id; needs unlocked). `generate` also accepts `initImageGalleryId` (general record id) like `generate_video` already did | as today | `VAULT_LOCKED` when using a vault start image while locked; `NO_VAULT` for `destination: "vault"` before a vault exists; a plain error when a vault start image / reference is used with `destination: "general"` |
| `import_reference` / `import_reference_bytes` | existing args + `destination` (`"vault"` seals the downscaled copy instead of writing `references/`); `import_reference` also accepts a `vault://localhost/…` URL as `path` (re-import of a vault item's start image / reference, always into the vault) | as today; a vault reference's `refId` and `thumbPath` are the same `vault://localhost/…` URL | |

## Events

- `vault-update` → `VaultStatus` on create / unlock / lock / auto-lock / password change and
  whenever vault items change, including when a vault job's output is sealed (UI re-fetches
  `list_vault_items` when unlocked).
- `vault-migration` → `MigrationProgress` during create/resume. `done`/`total` count every
  record of the migration (records whose file is missing are skipped and counted in `errors`;
  they stay in the general gallery).
- `get_settings` also returns `vaultAutoLockMinutes`.

## Jobs

`Job` gains `destination: Destination`. When the vault is locked, the UI hides the prompt and
thumbnails of jobs whose destination is `"vault"` (shows "Saved to vault").

- **Outputs sealed while the vault is locked never appear in `job-update.images`**: the Rust
  side only increments `completed` (so `completed` can exceed `images.length` for a vault job).
  No path, prompt or id of such an output leaves the vault; the item shows up in
  `list_vault_items` after the next unlock (a `vault-update` is emitted when it is sealed, as
  for every sealed output). Outputs sealed while unlocked are pushed to `images` as vault
  records (`vault: true`, `vault://localhost/…` URLs) like today.
- **A vault job seals its plain references itself**: `generate` / `generate_video` with
  `destination: "vault"` read each plain `referenceIds` / `initImageId` entry from
  `references/`, seal it into the vault and record the vault URL — the UI never needs to call
  `seal_reference`. While unlocked the plaintext copy in `references/` is deleted after the
  encrypted copy is verified; while **locked** it cannot be verified, so the plaintext copy
  is kept (it is a downscaled scratch import, not the output). Importing with
  `destination: "vault"` in the first place avoids that copy entirely.
- `vault-migration` always ends with a final event: `phase: "done"`, or `phase: "error"` with
  `error` set (interruption or failure). A `vault-update` follows in both cases.
