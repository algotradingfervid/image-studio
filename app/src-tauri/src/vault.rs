//! Encrypted vault (spec v6): password-protected, encrypted-at-rest content.
//!
//! # Threat model
//!
//! Protects against: someone with read access to the app data directory
//! (backups, a copied disk, another local account, a stolen but unlocked Mac)
//! learning the vault's images, videos, prompts or settings while the vault is
//! locked. Everything in `vault/` is ciphertext except `vault.json`, which
//! holds the public key and the KDF parameters, and the item/blob file
//! *names*, which are random UUIDs. File sizes and timestamps are visible.
//!
//! Does not protect against: an attacker who controls the running app or the
//! user account while the vault is unlocked (the private key is then in this
//! process's memory), a malicious app build, kernel-level access, or someone
//! who knows the password. There is no password recovery: losing the password
//! loses the content. Deleted plaintext relies on FileVault for protection at
//! rest; APFS gives no reliable overwrite, so no secure wipe is claimed.
//!
//! # Construction (only composed from audited crates, nothing home-made)
//!
//! - Key pair: X25519 (`x25519-dalek`). The public key is stored in plain text;
//!   the private key is encrypted with XChaCha20-Poly1305 under a key derived
//!   from the password with Argon2id (256 MiB, t = 3, p = 1, 16-byte salt;
//!   the public key is the associated data). A wrong password simply fails the
//!   AEAD tag check.
//! - Sealing (writing) needs only the public key: each blob gets a fresh random
//!   32-byte content key, which is sealed to the vault public key with an
//!   ephemeral X25519 exchange → HKDF-SHA256 → XChaCha20-Poly1305 (a sealed
//!   box). So jobs that finish while the vault is locked are still saved
//!   encrypted.
//! - Blob bodies use the STREAM construction (`aead::stream::StreamLE31`) over
//!   XChaCha20-Poly1305 in 1 MiB chunks: the chunk index and a last-chunk flag
//!   are part of the nonce, so tampering, reordering and truncation are all
//!   detected, and any chunk can be decrypted on its own for random access
//!   (video seeking). The associated data of every chunk is the plaintext
//!   blob header followed by the blob's UUID (its file name), so a blob copied
//!   under another name does not decrypt.
//! - Item metadata (prompt, model, seed, …) is a JSON record sealed exactly
//!   like a blob (`vault/items/<uuid>.bin`); media live in
//!   `vault/blobs/<uuid>.bin`. The SQLite database never sees vault items.
//! - Keys and plaintext live in `Zeroizing` buffers; locking drops the private
//!   key (zeroized by `x25519-dalek`) and the decrypted item cache. Plaintext
//!   is never written to disk by this module (no temp files).

use crate::db::{ImageRecord, LoraRef, RunpodTimes, KIND_IMAGE, KIND_VIDEO};
use argon2::{Algorithm, Argon2, Params, Version};
use base64::Engine;
use chacha20poly1305::aead::generic_array::GenericArray;
use chacha20poly1305::aead::stream::{NewStream, StreamLE31, StreamPrimitive};
use chacha20poly1305::aead::{Aead, KeyInit, Payload};
use chacha20poly1305::{XChaCha20Poly1305, XNonce};
use hkdf::Hkdf;
use rand_core::{OsRng, RngCore};
use serde::{Deserialize, Serialize};
use sha2::Sha256;
use std::collections::{BTreeMap, HashMap};
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, Instant};
use x25519_dalek::{EphemeralSecret, PublicKey, StaticSecret};
use zeroize::{Zeroize, Zeroizing};

/// Plaintext bytes per STREAM chunk.
pub const CHUNK_SIZE: u32 = 1 << 20;
/// Largest body one `vault://` response carries (ranges are served in pieces).
pub const MAX_RANGE_RESPONSE: u64 = 4 << 20;
pub const MIN_PASSWORD_CHARS: usize = 8;
pub const DEFAULT_AUTO_LOCK_MINUTES: u32 = 10;
pub const MIN_AUTO_LOCK_MINUTES: u32 = 1;
pub const MAX_AUTO_LOCK_MINUTES: u32 = 240;

const VAULT_FILE: &str = "vault.json";
const BLOB_MAGIC: &[u8; 4] = b"ISVB";
const BLOB_VERSION: u8 = 1;
const HEADER_LEN: usize = 4 + 1 + 32 + 24 + 48 + 20 + 4 + 8;
const TAG_LEN: usize = 16;
/// Largest plaintext a blob may claim (1 TiB); anything above is corrupt.
const MAX_BLOB_LEN: u64 = 1 << 40;
/// Production floor for the password KDF: 64 MiB and two passes.
const MIN_M_COST_KIB: u32 = 64 * 1024;
const MIN_T_COST: u32 = 2;
const WRAP_INFO: &[u8] = b"image-studio-vault/v1/content-key-wrap";
/// Vault media URLs as the UI sees them: `vault://localhost/<uuid>.<ext>`
/// (served by the `vault` URI scheme; the extension is the plaintext's).
pub const VAULT_PATH_PREFIX: &str = "vault://localhost/";
/// Error-code prefixes shared with the UI (docs/vault-contract.md).
pub const ERR_LOCKED: &str = "VAULT_LOCKED";
pub const ERR_WRONG_PASSWORD: &str = "WRONG_PASSWORD";
pub const ERR_WEAK_PASSWORD: &str = "WEAK_PASSWORD";
pub const ERR_EXISTS: &str = "VAULT_EXISTS";
pub const ERR_NO_VAULT: &str = "NO_VAULT";

fn b64(v: &[u8]) -> String {
    base64::engine::general_purpose::STANDARD.encode(v)
}

fn unb64(v: &str) -> Result<Vec<u8>, String> {
    base64::engine::general_purpose::STANDARD
        .decode(v.trim())
        .map_err(|_| "The vault file is corrupt".to_string())
}

fn random_bytes<const N: usize>() -> [u8; N] {
    let mut b = [0u8; N];
    OsRng.fill_bytes(&mut b);
    b
}

/// Argon2id cost parameters (stored in `vault.json`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KdfParams {
    pub m_cost_kib: u32,
    pub t_cost: u32,
    pub p_cost: u32,
}

impl KdfParams {
    /// Spec values: 256 MiB, t = 3, p = 1.
    pub const PRODUCTION: KdfParams = KdfParams {
        m_cost_kib: 256 * 1024,
        t_cost: 3,
        p_cost: 1,
    };

    /// Cheap parameters for tests only (never offered to production code paths).
    #[cfg(debug_assertions)]
    pub fn fast() -> KdfParams {
        KdfParams {
            m_cost_kib: 1024,
            t_cost: 1,
            p_cost: 1,
        }
    }

    /// Hard bounds (never executes absurd parameters) plus the production
    /// floor. Only the exact test tuple from `fast()` is exempt from the floor,
    /// and only in debug builds.
    fn validate(&self) -> Result<(), String> {
        let bounds = (Params::MIN_M_COST..=1024 * 1024).contains(&self.m_cost_kib)
            && (1..=32).contains(&self.t_cost)
            && (1..=16).contains(&self.p_cost);
        let floor = self.m_cost_kib >= MIN_M_COST_KIB && self.t_cost >= MIN_T_COST;
        #[cfg(debug_assertions)]
        let floor = floor || *self == KdfParams::fast();
        if bounds && floor {
            Ok(())
        } else {
            Err("The vault file has unsupported key-derivation parameters".into())
        }
    }
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct KdfSection {
    algorithm: String,
    #[serde(flatten)]
    params: KdfParams,
    salt: String,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct WrappedPrivateKey {
    nonce: String,
    ciphertext: String,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct VaultFile {
    version: u32,
    public_key: String,
    kdf: KdfSection,
    private_key: WrappedPrivateKey,
    created_at: String,
}

/// A sealed file in `vault/blobs/`, with the plaintext's file extension.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct BlobRef {
    pub id: String,
    pub ext: String,
}

impl BlobRef {
    /// `vault://localhost/<uuid>.<ext>` — what the UI gets as a path.
    pub fn path(&self) -> String {
        format!("{VAULT_PATH_PREFIX}{}.{}", self.id, self.ext)
    }

    /// Parses `vault://localhost/<uuid>[.<ext>]`.
    pub fn parse(path: &str) -> Option<BlobRef> {
        let rest = path.strip_prefix(VAULT_PATH_PREFIX)?;
        let (id, ext) = rest.split_once('.').unwrap_or((rest, "bin"));
        uuid::Uuid::parse_str(id).ok()?;
        Some(BlobRef {
            id: id.to_string(),
            ext: ext.to_string(),
        })
    }
}

pub fn is_vault_path(p: &str) -> bool {
    p.starts_with(VAULT_PATH_PREFIX)
}

/// One vault item's metadata (the encrypted JSON record).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct VaultItem {
    pub id: String,
    #[serde(default = "default_kind")]
    pub kind: String,
    pub model: String,
    pub prompt: String,
    #[serde(default)]
    pub negative_prompt: String,
    pub aspect_ratio: String,
    pub width: u32,
    pub height: u32,
    pub seed: u64,
    pub steps: u32,
    pub cfg: f64,
    #[serde(default)]
    pub loras: Vec<LoraRef>,
    pub created_at: String,
    #[serde(default)]
    pub duration_ms: Option<u64>,
    #[serde(default)]
    pub runpod: RunpodTimes,
    #[serde(default)]
    pub denoise: Option<f64>,
    #[serde(default)]
    pub duration_s: Option<f64>,
    #[serde(default)]
    pub fps: Option<f64>,
    #[serde(default)]
    pub has_audio: Option<bool>,
    pub media: BlobRef,
    #[serde(default)]
    pub poster: Option<BlobRef>,
    #[serde(default)]
    pub thumb: Option<BlobRef>,
    #[serde(default)]
    pub init_image: Option<BlobRef>,
    #[serde(default)]
    pub references: Vec<BlobRef>,
    /// The id this item had in the general gallery before it moved here.
    #[serde(default)]
    pub source_id: Option<String>,
    #[serde(default)]
    pub added_at: String,
}

fn default_kind() -> String {
    KIND_IMAGE.to_string()
}

impl VaultItem {
    /// Every blob this item owns.
    pub fn blobs(&self) -> Vec<&BlobRef> {
        let mut v = vec![&self.media];
        v.extend(self.poster.iter());
        v.extend(self.thumb.iter());
        v.extend(self.init_image.iter());
        v.extend(self.references.iter());
        v
    }

    /// The record shape the UI already knows, with `vault:` paths.
    pub fn to_record(&self) -> ImageRecord {
        ImageRecord {
            id: self.id.clone(),
            path: self.media.path(),
            model: self.model.clone(),
            prompt: self.prompt.clone(),
            negative_prompt: self.negative_prompt.clone(),
            aspect_ratio: self.aspect_ratio.clone(),
            width: self.width,
            height: self.height,
            seed: self.seed,
            steps: self.steps,
            cfg: self.cfg,
            references: self.references.iter().map(BlobRef::path).collect(),
            loras: self.loras.clone(),
            created_at: self.created_at.clone(),
            duration_ms: self.duration_ms,
            runpod: self.runpod.clone(),
            init_image: self.init_image.as_ref().map(BlobRef::path),
            denoise: self.denoise,
            kind: self.kind.clone(),
            duration_s: self.duration_s,
            fps: self.fps,
            has_audio: self.has_audio,
            poster_path: self.poster.as_ref().map(BlobRef::path),
            vault: true,
            thumb_path: self
                .thumb
                .as_ref()
                .or(self.poster.as_ref())
                .map(BlobRef::path),
        }
    }
}

/// What the UI needs to know about the vault.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct VaultStatus {
    pub exists: bool,
    pub unlocked: bool,
    pub auto_lock_minutes: u32,
    /// Decrypted item count; null while locked.
    pub item_count: Option<usize>,
    /// The one-time migration into the vault has not finished.
    pub migration_pending: bool,
}

struct Unlocked {
    secret: StaticSecret, // zeroized on drop (x25519-dalek "zeroize" feature)
    items: BTreeMap<String, VaultItem>,
}

impl Drop for Unlocked {
    fn drop(&mut self) {
        // Prompts and settings are sensitive too: wipe the cached records.
        for item in self.items.values_mut() {
            item.prompt.zeroize();
            item.negative_prompt.zeroize();
        }
        self.items.clear();
    }
}

/// Header of a sealed blob. `aad` (header bytes ‖ blob UUID) is the
/// associated data of every chunk.
struct BlobHeader {
    aad: Vec<u8>,
    eph_pub: [u8; 32],
    wrap_nonce: [u8; 24],
    wrapped_key: [u8; 48],
    stream_nonce: [u8; 20],
    chunk_size: u32,
    len: u64,
}

fn corrupt() -> String {
    "The vault file is corrupt, truncated or was tampered with".to_string()
}

impl BlobHeader {
    /// Parses the fixed header; `binding` is the 16-byte UUID the file is
    /// named after. Only the one chunk size this build writes is accepted and
    /// the claimed length is capped, so the size arithmetic below cannot wrap.
    fn parse(bytes: &[u8], binding: &[u8; 16]) -> Result<BlobHeader, String> {
        if bytes.len() < HEADER_LEN || &bytes[0..4] != BLOB_MAGIC || bytes[4] != BLOB_VERSION {
            return Err("Not a vault file".into());
        }
        let mut h = BlobHeader {
            aad: Vec::with_capacity(HEADER_LEN + 16),
            eph_pub: [0; 32],
            wrap_nonce: [0; 24],
            wrapped_key: [0; 48],
            stream_nonce: [0; 20],
            chunk_size: 0,
            len: 0,
        };
        h.aad.extend_from_slice(&bytes[..HEADER_LEN]);
        h.aad.extend_from_slice(binding);
        h.eph_pub.copy_from_slice(&bytes[5..37]);
        h.wrap_nonce.copy_from_slice(&bytes[37..61]);
        h.wrapped_key.copy_from_slice(&bytes[61..109]);
        h.stream_nonce.copy_from_slice(&bytes[109..129]);
        h.chunk_size = u32::from_le_bytes(bytes[129..133].try_into().unwrap());
        h.len = u64::from_le_bytes(bytes[133..141].try_into().unwrap());
        if h.chunk_size != CHUNK_SIZE || h.len > MAX_BLOB_LEN {
            return Err(corrupt());
        }
        Ok(h)
    }

    fn chunk_count(&self) -> u64 {
        self.len.div_ceil(self.chunk_size as u64).max(1)
    }

    /// Plaintext length of chunk `i` (0 for chunks past the end).
    fn chunk_len(&self, i: u64) -> u64 {
        let start = i.saturating_mul(self.chunk_size as u64);
        self.len.saturating_sub(start).min(self.chunk_size as u64)
    }

    /// File offset of chunk `i`'s ciphertext.
    fn chunk_offset(&self, i: u64) -> Result<u64, String> {
        i.checked_mul(self.chunk_size as u64 + TAG_LEN as u64)
            .and_then(|o| o.checked_add(HEADER_LEN as u64))
            .ok_or_else(corrupt)
    }

    fn file_len(&self) -> Result<u64, String> {
        self.chunk_count()
            .checked_mul(TAG_LEN as u64)
            .and_then(|tags| tags.checked_add(self.len))
            .and_then(|n| n.checked_add(HEADER_LEN as u64))
            .ok_or_else(corrupt)
    }
}

/// The 16 bytes of a blob/record UUID (its file name), bound into the AEAD.
fn binding_of(id: &str) -> Result<[u8; 16], String> {
    uuid::Uuid::parse_str(id)
        .map(|u| u.into_bytes())
        .map_err(|_| "Invalid vault id".to_string())
}

// ----- primitives -----

fn derive_password_key(
    password: &[u8],
    salt: &[u8],
    params: KdfParams,
) -> Result<Zeroizing<[u8; 32]>, String> {
    params.validate()?;
    let p = Params::new(params.m_cost_kib, params.t_cost, params.p_cost, Some(32))
        .map_err(|_| "The vault file has unsupported key-derivation parameters".to_string())?;
    let argon = Argon2::new(Algorithm::Argon2id, Version::V0x13, p);
    let mut out = Zeroizing::new([0u8; 32]);
    argon
        .hash_password_into(password, salt, out.as_mut())
        .map_err(|_| "Could not derive the vault key".to_string())?;
    Ok(out)
}

fn hkdf_wrap_key(shared: &[u8; 32], eph_pub: &[u8; 32], recipient: &[u8; 32]) -> Zeroizing<[u8; 32]> {
    let mut salt = [0u8; 64];
    salt[..32].copy_from_slice(eph_pub);
    salt[32..].copy_from_slice(recipient);
    let hk = Hkdf::<Sha256>::new(Some(&salt), shared);
    let mut out = Zeroizing::new([0u8; 32]);
    hk.expand(WRAP_INFO, out.as_mut())
        .expect("32 bytes is a valid HKDF output length");
    out
}

/// A content key sealed to the vault public key.
struct WrappedKey {
    eph_pub: [u8; 32],
    nonce: [u8; 24],
    ciphertext: [u8; 48],
}

/// Seals `content_key` to `recipient` (an X25519 public key).
fn wrap_content_key(recipient: &[u8; 32], content_key: &[u8; 32]) -> Result<WrappedKey, String> {
    let eph = EphemeralSecret::random_from_rng(OsRng);
    let eph_pub = PublicKey::from(&eph).to_bytes();
    let shared = eph.diffie_hellman(&PublicKey::from(*recipient));
    if !shared.was_contributory() {
        return Err("The vault public key is invalid".into());
    }
    let key = hkdf_wrap_key(shared.as_bytes(), &eph_pub, recipient);
    let nonce = random_bytes::<24>();
    let mut aad = [0u8; 64];
    aad[..32].copy_from_slice(&eph_pub);
    aad[32..].copy_from_slice(recipient);
    let ct = XChaCha20Poly1305::new(GenericArray::from_slice(key.as_ref()))
        .encrypt(
            XNonce::from_slice(&nonce),
            Payload {
                msg: content_key,
                aad: &aad,
            },
        )
        .map_err(|_| "Could not seal the content key".to_string())?;
    let mut ciphertext = [0u8; 48];
    ciphertext.copy_from_slice(&ct);
    Ok(WrappedKey {
        eph_pub,
        nonce,
        ciphertext,
    })
}

fn unwrap_content_key(
    secret: &StaticSecret,
    eph_pub: &[u8; 32],
    nonce: &[u8; 24],
    wrapped: &[u8; 48],
) -> Result<Zeroizing<[u8; 32]>, String> {
    let recipient = PublicKey::from(secret).to_bytes();
    let shared = secret.diffie_hellman(&PublicKey::from(*eph_pub));
    if !shared.was_contributory() {
        return Err("The vault file is corrupt".into());
    }
    let key = hkdf_wrap_key(shared.as_bytes(), eph_pub, &recipient);
    let mut aad = [0u8; 64];
    aad[..32].copy_from_slice(eph_pub);
    aad[32..].copy_from_slice(&recipient);
    let pt = XChaCha20Poly1305::new(GenericArray::from_slice(key.as_ref()))
        .decrypt(
            XNonce::from_slice(nonce),
            Payload {
                msg: wrapped,
                aad: &aad,
            },
        )
        .map_err(|_| "The vault file is corrupt or was not written for this vault".to_string())?;
    let mut out = Zeroizing::new([0u8; 32]);
    out.copy_from_slice(&pt);
    let mut pt = pt;
    pt.zeroize();
    Ok(out)
}

fn stream(key: &[u8; 32], nonce: &[u8; 20]) -> StreamLE31<XChaCha20Poly1305> {
    StreamLE31::from_aead(
        XChaCha20Poly1305::new(GenericArray::from_slice(key)),
        GenericArray::from_slice(nonce),
    )
}

/// Seals `plaintext` to `recipient` into the blob format, in memory, bound
/// to the UUID the file will be named after.
fn seal_bytes(recipient: &[u8; 32], plaintext: &[u8], binding: &[u8; 16]) -> Result<Vec<u8>, String> {
    let content_key = Zeroizing::new(random_bytes::<32>());
    let wrapped = wrap_content_key(recipient, &content_key)?;
    let stream_nonce = random_bytes::<20>();
    let mut header = Vec::with_capacity(HEADER_LEN);
    header.extend_from_slice(BLOB_MAGIC);
    header.push(BLOB_VERSION);
    header.extend_from_slice(&wrapped.eph_pub);
    header.extend_from_slice(&wrapped.nonce);
    header.extend_from_slice(&wrapped.ciphertext);
    header.extend_from_slice(&stream_nonce);
    header.extend_from_slice(&CHUNK_SIZE.to_le_bytes());
    header.extend_from_slice(&(plaintext.len() as u64).to_le_bytes());
    debug_assert_eq!(header.len(), HEADER_LEN);
    let mut aad = header.clone();
    aad.extend_from_slice(binding);

    let prim = stream(&content_key, &stream_nonce);
    let n = (plaintext.len() as u64).div_ceil(CHUNK_SIZE as u64).max(1);
    let mut out = header;
    for i in 0..n {
        let start = (i * CHUNK_SIZE as u64) as usize;
        let end = (start + CHUNK_SIZE as usize).min(plaintext.len());
        let ct = prim
            .encrypt(
                i as u32,
                i == n - 1,
                Payload {
                    msg: &plaintext[start..end],
                    aad: &aad,
                },
            )
            .map_err(|_| "Encryption failed".to_string())?;
        out.extend_from_slice(&ct);
    }
    Ok(out)
}

/// Decrypts chunks `first..=last` of a sealed blob (random access).
fn open_chunks(
    secret: &StaticSecret,
    file: &mut (impl Read + Seek),
    header: &BlobHeader,
    first: u64,
    last: u64,
) -> Result<Zeroizing<Vec<u8>>, String> {
    let n = header.chunk_count();
    if first > last || last >= n {
        return Err("Range outside the file".into());
    }
    let key = unwrap_content_key(secret, &header.eph_pub, &header.wrap_nonce, &header.wrapped_key)?;
    let prim = stream(&key, &header.stream_nonce);
    let capacity: u64 = (first..=last).map(|i| header.chunk_len(i)).sum();
    let mut out = Zeroizing::new(Vec::with_capacity(usize::try_from(capacity).map_err(|_| corrupt())?));
    file.seek(SeekFrom::Start(header.chunk_offset(first)?))
        .map_err(|_| corrupt())?;
    for i in first..=last {
        let clen = header.chunk_len(i) as usize + TAG_LEN;
        let mut ct = vec![0u8; clen];
        file.read_exact(&mut ct).map_err(|_| corrupt())?;
        let pt = prim
            .decrypt(
                i as u32,
                i == n - 1,
                Payload {
                    msg: &ct,
                    aad: &header.aad,
                },
            )
            .map_err(|_| corrupt())?;
        out.extend_from_slice(&pt);
        let mut pt = pt;
        pt.zeroize();
    }
    Ok(out)
}

fn write_private(path: &Path, body: &[u8]) -> Result<(), String> {
    let err = |e: std::io::Error| format!("Could not write to the vault: {e}");
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(err)?;
    }
    let tmp = path.with_extension("tmp");
    {
        #[cfg(unix)]
        use std::os::unix::fs::OpenOptionsExt;
        let mut opts = std::fs::OpenOptions::new();
        opts.write(true).create(true).truncate(true);
        #[cfg(unix)]
        opts.mode(0o600);
        let mut f = opts.open(&tmp).map_err(err)?;
        f.write_all(body).map_err(err)?;
        f.sync_all().map_err(err)?;
    }
    std::fs::rename(&tmp, path).map_err(err)?;
    // Make the rename durable too.
    if let Some(dir) = path.parent() {
        if let Ok(d) = std::fs::File::open(dir) {
            let _ = d.sync_all();
        }
    }
    Ok(())
}

/// Removes `*.tmp` left behind by an interrupted write.
fn sweep_tmp(dir: &Path) {
    let Ok(rd) = std::fs::read_dir(dir) else { return };
    for e in rd.flatten() {
        let p = e.path();
        if p.extension().and_then(|x| x.to_str()) == Some("tmp") && p.is_file() {
            let _ = std::fs::remove_file(&p);
        }
    }
}

// ----- the vault -----

pub struct Vault {
    dir: PathBuf,
    public_key: Mutex<Option<[u8; 32]>>,
    unlocked: Mutex<Option<Unlocked>>,
    auto_lock: Mutex<Duration>,
    last_activity: Mutex<Instant>,
    /// Serialises password checks so parallel Argon2 runs cannot stack up.
    unlock_gate: Mutex<()>,
    /// `(plaintext length, content type)` per blob id for `vault://`, filled
    /// while unlocked and dropped on lock.
    media_cache: Mutex<HashMap<String, (u64, &'static str)>>,
}

/// Decrypted `vault://` response data.
pub struct Served {
    pub status: u16,
    pub headers: Vec<(&'static str, String)>,
    pub body: Vec<u8>,
}

impl Vault {
    /// Opens (does not create) the vault at `dir`, reading the public key if present.
    pub fn new(dir: PathBuf, auto_lock_minutes: u32) -> Vault {
        let public_key = std::fs::read_to_string(dir.join(VAULT_FILE))
            .ok()
            .and_then(|s| serde_json::from_str::<VaultFile>(&s).ok())
            .and_then(|f| unb64(&f.public_key).ok())
            .and_then(|k| <[u8; 32]>::try_from(k).ok());
        for d in [dir.clone(), dir.join("blobs"), dir.join("items")] {
            sweep_tmp(&d);
        }
        Vault {
            dir,
            public_key: Mutex::new(public_key),
            unlocked: Mutex::new(None),
            auto_lock: Mutex::new(Duration::from_secs(auto_lock_minutes as u64 * 60)),
            last_activity: Mutex::new(Instant::now()),
            unlock_gate: Mutex::new(()),
            media_cache: Mutex::new(HashMap::new()),
        }
    }

    pub fn dir(&self) -> &Path {
        &self.dir
    }
    fn blobs_dir(&self) -> PathBuf {
        self.dir.join("blobs")
    }
    fn items_dir(&self) -> PathBuf {
        self.dir.join("items")
    }
    fn blob_path(&self, id: &str) -> PathBuf {
        self.blobs_dir().join(format!("{id}.bin"))
    }
    fn item_path(&self, id: &str) -> PathBuf {
        self.items_dir().join(format!("{id}.bin"))
    }
    /// The migration journal (ids only); exists while a migration is unfinished.
    pub fn journal_path(&self) -> PathBuf {
        self.dir.join("migration.json")
    }

    pub fn exists(&self) -> bool {
        self.public_key.lock().unwrap().is_some()
    }

    pub fn is_unlocked(&self) -> bool {
        self.unlocked.lock().unwrap().is_some()
    }

    pub fn status(&self) -> VaultStatus {
        let unlocked = self.unlocked.lock().unwrap();
        VaultStatus {
            exists: self.exists(),
            unlocked: unlocked.is_some(),
            auto_lock_minutes: (self.auto_lock.lock().unwrap().as_secs() / 60) as u32,
            item_count: unlocked.as_ref().map(|u| u.items.len()),
            migration_pending: self.journal_path().exists(),
        }
    }

    fn public_key(&self) -> Result<[u8; 32], String> {
        self.public_key
            .lock()
            .unwrap()
            .ok_or_else(|| format!("{ERR_NO_VAULT}: No vault has been created yet"))
    }

    fn locked_err() -> String {
        format!("{ERR_LOCKED}: The vault is locked")
    }

    // ----- lifecycle -----

    /// Creates the key pair and `vault.json`; the vault is unlocked afterwards.
    pub fn create(&self, password: &[u8], params: KdfParams) -> Result<(), String> {
        if self.exists() || self.dir.join(VAULT_FILE).exists() {
            return Err(format!("{ERR_EXISTS}: A vault already exists"));
        }
        check_password(password)?;
        params.validate()?;
        let secret = StaticSecret::random_from_rng(OsRng);
        let public = PublicKey::from(&secret).to_bytes();
        let salt = random_bytes::<16>();
        let key = derive_password_key(password, &salt, params)?;
        let nonce = random_bytes::<24>();
        let ct = XChaCha20Poly1305::new(GenericArray::from_slice(key.as_ref()))
            .encrypt(
                XNonce::from_slice(&nonce),
                Payload {
                    msg: secret.as_bytes(),
                    aad: &public,
                },
            )
            .map_err(|_| "Could not encrypt the vault key".to_string())?;
        let file = VaultFile {
            version: 1,
            public_key: b64(&public),
            kdf: KdfSection {
                algorithm: "argon2id".into(),
                params,
                salt: b64(&salt),
            },
            private_key: WrappedPrivateKey {
                nonce: b64(&nonce),
                ciphertext: b64(&ct),
            },
            created_at: crate::state::now_rfc3339(),
        };
        std::fs::create_dir_all(self.blobs_dir()).map_err(|e| format!("Could not create the vault: {e}"))?;
        std::fs::create_dir_all(self.items_dir()).map_err(|e| format!("Could not create the vault: {e}"))?;
        write_private(
            &self.dir.join(VAULT_FILE),
            serde_json::to_string_pretty(&file).unwrap().as_bytes(),
        )?;
        *self.public_key.lock().unwrap() = Some(public);
        *self.unlocked.lock().unwrap() = Some(Unlocked {
            secret,
            items: BTreeMap::new(),
        });
        self.touch();
        Ok(())
    }

    fn read_vault_file(&self) -> Result<VaultFile, String> {
        let s = std::fs::read_to_string(self.dir.join(VAULT_FILE))
            .map_err(|_| format!("{ERR_NO_VAULT}: No vault has been created yet"))?;
        serde_json::from_str(&s).map_err(|_| "The vault file is corrupt".to_string())
    }

    /// Decrypts the private key with `password` (does not change state).
    fn open_private_key(&self, password: &[u8]) -> Result<(StaticSecret, [u8; 32]), String> {
        let file = self.read_vault_file()?;
        if file.kdf.algorithm != "argon2id" {
            return Err("The vault file has unsupported key-derivation parameters".into());
        }
        let public: [u8; 32] = unb64(&file.public_key)?
            .try_into()
            .map_err(|_| "The vault file is corrupt".to_string())?;
        let salt = unb64(&file.kdf.salt)?;
        let nonce = unb64(&file.private_key.nonce)?;
        let ct = unb64(&file.private_key.ciphertext)?;
        if nonce.len() != 24 {
            return Err("The vault file is corrupt".into());
        }
        let key = derive_password_key(password, &salt, file.kdf.params)?;
        let pt = XChaCha20Poly1305::new(GenericArray::from_slice(key.as_ref()))
            .decrypt(
                XNonce::from_slice(&nonce),
                Payload {
                    msg: &ct,
                    aad: &public,
                },
            )
            .map_err(|_| format!("{ERR_WRONG_PASSWORD}: Wrong password"))?;
        let bytes: Zeroizing<[u8; 32]> = Zeroizing::new(
            <[u8; 32]>::try_from(pt.as_slice()).map_err(|_| "The vault file is corrupt".to_string())?,
        );
        let mut pt = pt;
        pt.zeroize();
        let secret = StaticSecret::from(*bytes);
        if PublicKey::from(&secret).to_bytes() != public {
            return Err("The vault file is corrupt".into());
        }
        Ok((secret, public))
    }

    pub fn unlock(&self, password: &[u8]) -> Result<(), String> {
        let _gate = self.unlock_gate.lock().unwrap();
        let (secret, public) = self.open_private_key(password)?;
        let items = self.load_items(&secret);
        *self.public_key.lock().unwrap() = Some(public);
        *self.unlocked.lock().unwrap() = Some(Unlocked { secret, items });
        self.touch();
        Ok(())
    }

    /// Wipes the private key, the decrypted item cache and the media cache. Idempotent.
    pub fn lock(&self) -> bool {
        self.media_cache.lock().unwrap().clear();
        self.unlocked.lock().unwrap().take().is_some()
    }

    /// Re-wraps the private key under a new password (the key pair and every
    /// item stay as they are). Requires the current password.
    pub fn change_password(
        &self,
        current: &[u8],
        new: &[u8],
        params: KdfParams,
    ) -> Result<(), String> {
        check_password(new)?;
        params.validate()?;
        let _gate = self.unlock_gate.lock().unwrap();
        let (secret, public) = self.open_private_key(current)?;
        let mut file = self.read_vault_file()?;
        let salt = random_bytes::<16>();
        let key = derive_password_key(new, &salt, params)?;
        let nonce = random_bytes::<24>();
        let ct = XChaCha20Poly1305::new(GenericArray::from_slice(key.as_ref()))
            .encrypt(
                XNonce::from_slice(&nonce),
                Payload {
                    msg: secret.as_bytes(),
                    aad: &public,
                },
            )
            .map_err(|_| "Could not encrypt the vault key".to_string())?;
        file.kdf = KdfSection {
            algorithm: "argon2id".into(),
            params,
            salt: b64(&salt),
        };
        file.private_key = WrappedPrivateKey {
            nonce: b64(&nonce),
            ciphertext: b64(&ct),
        };
        write_private(
            &self.dir.join(VAULT_FILE),
            serde_json::to_string_pretty(&file).unwrap().as_bytes(),
        )?;
        self.touch();
        Ok(())
    }

    // ----- auto-lock -----

    pub fn touch(&self) {
        *self.last_activity.lock().unwrap() = Instant::now();
    }

    pub fn set_auto_lock(&self, minutes: u32) {
        *self.auto_lock.lock().unwrap() = Duration::from_secs(minutes as u64 * 60);
    }

    /// Locks when unlocked and idle for the auto-lock period. Returns true if it locked.
    pub fn lock_if_idle(&self, now: Instant) -> bool {
        let idle = now.saturating_duration_since(*self.last_activity.lock().unwrap());
        if idle >= *self.auto_lock.lock().unwrap() {
            self.lock()
        } else {
            false
        }
    }

    // ----- blobs -----

    /// Encrypts `plaintext` into a new blob (works while locked). `ext` is the
    /// plaintext's file extension, kept in the returned reference only.
    pub fn seal_blob(&self, plaintext: &[u8], ext: &str) -> Result<BlobRef, String> {
        let public = self.public_key()?;
        let id = uuid::Uuid::new_v4().to_string();
        let sealed = seal_bytes(&public, plaintext, &binding_of(&id)?)?;
        write_private(&self.blob_path(&id), &sealed)?;
        Ok(BlobRef {
            id,
            ext: ext.to_string(),
        })
    }

    fn open_header(&self, id: &str) -> Result<(std::fs::File, BlobHeader), String> {
        let binding = binding_of(id)?;
        let mut f = std::fs::File::open(self.blob_path(id))
            .map_err(|_| "That vault file no longer exists".to_string())?;
        let mut hb = [0u8; HEADER_LEN];
        f.read_exact(&mut hb).map_err(|_| corrupt())?;
        let header = BlobHeader::parse(&hb, &binding)?;
        let actual = f.metadata().map(|m| m.len()).unwrap_or(0);
        if actual != header.file_len()? {
            return Err(corrupt());
        }
        Ok((f, header))
    }

    /// Plaintext length of a blob (header only; still refused while locked).
    pub fn blob_len(&self, id: &str) -> Result<u64, String> {
        if !self.is_unlocked() {
            return Err(Self::locked_err());
        }
        Ok(self.open_header(id)?.1.len)
    }

    /// Decrypts a whole blob into memory. Requires the unlocked private key.
    pub fn open_blob(&self, id: &str) -> Result<Zeroizing<Vec<u8>>, String> {
        let guard = self.unlocked.lock().unwrap();
        let u = guard.as_ref().ok_or_else(Self::locked_err)?;
        let (mut f, header) = self.open_header(id)?;
        open_chunks(&u.secret, &mut f, &header, 0, header.chunk_count() - 1)
    }

    /// Decrypts plaintext bytes `start..=end` of a blob, touching only the chunks that cover them.
    pub fn read_blob_range(&self, id: &str, start: u64, end: u64) -> Result<Zeroizing<Vec<u8>>, String> {
        let guard = self.unlocked.lock().unwrap();
        let u = guard.as_ref().ok_or_else(Self::locked_err)?;
        let (mut f, header) = self.open_header(id)?;
        if start > end || end >= header.len {
            return Err("Range outside the file".into());
        }
        let cs = header.chunk_size as u64;
        let (first, last) = (start / cs, end / cs);
        let chunks = open_chunks(&u.secret, &mut f, &header, first, last)?;
        let off = (start - first * cs) as usize;
        let n = (end - start + 1) as usize;
        Ok(Zeroizing::new(chunks[off..off + n].to_vec()))
    }

    /// Decrypts the blob and checks it equals `expected` (the round-trip check
    /// before a plaintext original may be deleted).
    pub fn verify_blob(&self, id: &str, expected: &[u8]) -> Result<(), String> {
        let got = self.open_blob(id)?;
        if got.as_slice() == expected {
            Ok(())
        } else {
            Err("The encrypted copy did not match the original".into())
        }
    }

    pub fn delete_blob(&self, id: &str) -> Result<(), String> {
        if uuid::Uuid::parse_str(id).is_err() {
            return Err("Invalid vault blob id".into());
        }
        self.media_cache.lock().unwrap().remove(id);
        match std::fs::remove_file(self.blob_path(id)) {
            Ok(()) => Ok(()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(e) => Err(format!("Could not delete the vault file: {e}")),
        }
    }

    // ----- items -----

    fn load_items(&self, secret: &StaticSecret) -> BTreeMap<String, VaultItem> {
        let mut items = BTreeMap::new();
        let Ok(rd) = std::fs::read_dir(self.items_dir()) else {
            return items;
        };
        for entry in rd.flatten() {
            let path = entry.path();
            if path.extension().and_then(|e| e.to_str()) != Some("bin") {
                continue;
            }
            match Self::read_item_file(secret, &path) {
                Ok(item) => {
                    items.insert(item.id.clone(), item);
                }
                Err(e) => eprintln!(
                    "[vault] skipping unreadable item {}: {e}",
                    path.file_name().unwrap_or_default().to_string_lossy()
                ),
            }
        }
        items
    }

    fn read_item_file(secret: &StaticSecret, path: &Path) -> Result<VaultItem, String> {
        let stem = path.file_stem().and_then(|s| s.to_str()).unwrap_or("");
        let binding = binding_of(stem)?;
        let mut f = std::fs::File::open(path).map_err(|e| e.to_string())?;
        let mut hb = [0u8; HEADER_LEN];
        f.read_exact(&mut hb).map_err(|_| "truncated".to_string())?;
        let header = BlobHeader::parse(&hb, &binding)?;
        if f.metadata().map(|m| m.len()).unwrap_or(0) != header.file_len()? {
            return Err(corrupt());
        }
        let pt = open_chunks(secret, &mut f, &header, 0, header.chunk_count() - 1)?;
        let item: VaultItem = serde_json::from_slice(&pt).map_err(|_| "not a vault record".to_string())?;
        if item.id != stem {
            return Err("record id does not match its file".into());
        }
        Ok(item)
    }

    /// The item that was moved in from general record `source_id`, if any
    /// (lets an interrupted migration resume without duplicating).
    pub fn find_by_source(&self, source_id: &str) -> Result<Option<VaultItem>, String> {
        let guard = self.unlocked.lock().unwrap();
        let u = guard.as_ref().ok_or_else(Self::locked_err)?;
        Ok(u
            .items
            .values()
            .find(|i| i.source_id.as_deref() == Some(source_id))
            .cloned())
    }

    /// Seals an item record (works while locked). When unlocked, the cache is updated too.
    pub fn put_item(&self, item: &VaultItem) -> Result<(), String> {
        if uuid::Uuid::parse_str(&item.id).is_err() {
            return Err("Invalid vault item id".into());
        }
        let public = self.public_key()?;
        let json = Zeroizing::new(serde_json::to_vec(item).map_err(|e| e.to_string())?);
        let sealed = seal_bytes(&public, &json, &binding_of(&item.id)?)?;
        std::fs::create_dir_all(self.items_dir()).map_err(|e| format!("Could not write to the vault: {e}"))?;
        write_private(&self.item_path(&item.id), &sealed)?;
        if let Some(u) = self.unlocked.lock().unwrap().as_mut() {
            u.items.insert(item.id.clone(), item.clone());
        }
        Ok(())
    }

    /// Decrypted items, newest first. Locked → error.
    pub fn items(&self) -> Result<Vec<VaultItem>, String> {
        let guard = self.unlocked.lock().unwrap();
        let u = guard.as_ref().ok_or_else(Self::locked_err)?;
        let mut v: Vec<VaultItem> = u.items.values().cloned().collect();
        v.sort_by(|a, b| b.created_at.cmp(&a.created_at).then(b.id.cmp(&a.id)));
        Ok(v)
    }

    pub fn item(&self, id: &str) -> Result<VaultItem, String> {
        let guard = self.unlocked.lock().unwrap();
        let u = guard.as_ref().ok_or_else(Self::locked_err)?;
        u.items
            .get(id)
            .cloned()
            .ok_or_else(|| "That vault item no longer exists".to_string())
    }

    /// Removes an item and every blob no other item still references.
    pub fn delete_item(&self, id: &str) -> Result<VaultItem, String> {
        let item = {
            let mut guard = self.unlocked.lock().unwrap();
            let u = guard.as_mut().ok_or_else(Self::locked_err)?;
            let item = u
                .items
                .remove(id)
                .ok_or_else(|| "That vault item no longer exists".to_string())?;
            let still_used: std::collections::HashSet<&str> = u
                .items
                .values()
                .flat_map(|i| i.blobs().into_iter().map(|b| b.id.as_str()))
                .collect();
            for b in item.blobs() {
                if !still_used.contains(b.id.as_str()) {
                    self.delete_blob(&b.id)?;
                }
            }
            item
        };
        match std::fs::remove_file(self.item_path(id)) {
            Ok(()) | Err(_) => {}
        }
        Ok(item)
    }

    // ----- vault:// -----

    /// Answers a `vault://` request for `path` (`/<uuid>[.<ext>]`), honouring a
    /// single `Range` header. 403 while locked, 404 for unknown blobs, 416 for
    /// unsatisfiable ranges. Responses are `Cache-Control: no-store`.
    pub fn serve(&self, path: &str, range: Option<&str>) -> Served {
        let no_store = ("Cache-Control", "no-store".to_string());
        let empty = |status: u16, extra: Vec<(&'static str, String)>| Served {
            status,
            headers: std::iter::once(no_store.clone()).chain(extra).collect(),
            body: Vec::new(),
        };
        if !self.is_unlocked() {
            return empty(403, vec![]);
        }
        self.touch();
        let name = path.trim_start_matches('/');
        let id = name.split('.').next().unwrap_or("");
        let cached = self.media_cache.lock().unwrap().get(id).copied();
        let (len, mime) = match cached {
            Some(c) => c,
            None => {
                let len = match self.blob_len(id) {
                    Ok(l) => l,
                    Err(_) => return empty(404, vec![]),
                };
                // Sniff the type from the first bytes (the header carries no plaintext type).
                let head = match self.read_blob_range(id, 0, len.saturating_sub(1).min(64)) {
                    Ok(h) if len > 0 => h,
                    _ => return empty(404, vec![]),
                };
                let mime = sniff_mime(&head);
                self.media_cache.lock().unwrap().insert(id.to_string(), (len, mime));
                (len, mime)
            }
        };
        let base = vec![
            no_store.clone(),
            ("Content-Type", mime.to_string()),
            ("Accept-Ranges", "bytes".to_string()),
        ];
        // A blob that fails to decrypt now (deleted or damaged since it was cached) is gone.
        let failed = |this: &Vault| {
            this.media_cache.lock().unwrap().remove(id);
            empty(404, vec![])
        };
        let Some(range) = range else {
            return match self.open_blob(id) {
                Ok(mut body) => Served {
                    status: 200,
                    headers: base
                        .into_iter()
                        .chain([("Content-Length", len.to_string())])
                        .collect(),
                    body: std::mem::take(&mut *body),
                },
                Err(_) => failed(self),
            };
        };
        let Some((start, end)) = parse_range(range, len) else {
            return empty(416, vec![("Content-Range", format!("bytes */{len}"))]);
        };
        let end = end.min(start.saturating_add(MAX_RANGE_RESPONSE - 1));
        match self.read_blob_range(id, start, end) {
            Ok(mut body) => Served {
                status: 206,
                headers: base
                    .into_iter()
                    .chain([
                        ("Content-Length", (end - start + 1).to_string()),
                        ("Content-Range", format!("bytes {start}-{end}/{len}")),
                    ])
                    .collect(),
                body: std::mem::take(&mut *body),
            },
            Err(_) => failed(self),
        }
    }
}

fn check_password(password: &[u8]) -> Result<(), String> {
    let chars = std::str::from_utf8(password).map(|s| s.chars().count()).unwrap_or(0);
    if chars < MIN_PASSWORD_CHARS {
        return Err(format!(
            "{ERR_WEAK_PASSWORD}: Use a password of at least {MIN_PASSWORD_CHARS} characters"
        ));
    }
    Ok(())
}

/// `bytes=a-b` | `bytes=a-` | `bytes=-n` → inclusive (start, end) within `len`.
/// Only the first range of a list is served.
pub fn parse_range(header: &str, len: u64) -> Option<(u64, u64)> {
    let spec = header.trim().strip_prefix("bytes=")?;
    let first = spec.split(',').next()?.trim();
    let (a, b) = first.split_once('-')?;
    let (a, b) = (a.trim(), b.trim());
    if len == 0 {
        return None;
    }
    if a.is_empty() {
        let n: u64 = b.parse().ok()?;
        if n == 0 {
            return None;
        }
        return Some((len.saturating_sub(n), len - 1));
    }
    let start: u64 = a.parse().ok()?;
    if start >= len {
        return None;
    }
    let end = if b.is_empty() {
        len - 1
    } else {
        b.parse::<u64>().ok()?.min(len - 1)
    };
    (start <= end).then_some((start, end))
}

/// Content type from magic bytes: PNG, JPEG, WebP, GIF, MP4, else octet-stream.
pub fn sniff_mime(bytes: &[u8]) -> &'static str {
    if bytes.len() > 12 && &bytes[4..8] == b"ftyp" {
        return "video/mp4";
    }
    match image::guess_format(bytes) {
        Ok(image::ImageFormat::Png) => "image/png",
        Ok(image::ImageFormat::Jpeg) => "image/jpeg",
        Ok(image::ImageFormat::WebP) => "image/webp",
        Ok(image::ImageFormat::Gif) => "image/gif",
        _ => "application/octet-stream",
    }
}

/// File extension for sealed plaintext, from its magic bytes.
pub fn sniff_ext(bytes: &[u8]) -> &'static str {
    match sniff_mime(bytes) {
        "video/mp4" => "mp4",
        "image/png" => "png",
        "image/jpeg" => "jpg",
        "image/webp" => "webp",
        "image/gif" => "gif",
        _ => "bin",
    }
}

/// Builds the item record for a job output or a moved gallery record.
#[allow(clippy::too_many_arguments)]
pub fn item_from_record(
    rec: &ImageRecord,
    id: String,
    media: BlobRef,
    poster: Option<BlobRef>,
    thumb: Option<BlobRef>,
    init_image: Option<BlobRef>,
    references: Vec<BlobRef>,
    source_id: Option<String>,
) -> VaultItem {
    VaultItem {
        id,
        kind: if rec.kind == KIND_VIDEO {
            KIND_VIDEO.into()
        } else {
            KIND_IMAGE.into()
        },
        model: rec.model.clone(),
        prompt: rec.prompt.clone(),
        negative_prompt: rec.negative_prompt.clone(),
        aspect_ratio: rec.aspect_ratio.clone(),
        width: rec.width,
        height: rec.height,
        seed: rec.seed,
        steps: rec.steps,
        cfg: rec.cfg,
        loras: rec.loras.clone(),
        created_at: rec.created_at.clone(),
        duration_ms: rec.duration_ms,
        runpod: rec.runpod.clone(),
        denoise: rec.denoise,
        duration_s: rec.duration_s,
        fps: rec.fps,
        has_audio: rec.has_audio,
        media,
        poster,
        thumb,
        init_image,
        references,
        source_id,
        added_at: crate::state::now_rfc3339(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const PW: &[u8] = b"correct horse battery";

    fn vault() -> (tempfile::TempDir, Vault) {
        let dir = tempfile::tempdir().unwrap();
        let v = Vault::new(dir.path().join("vault"), 10);
        (dir, v)
    }

    fn big(n: usize) -> Vec<u8> {
        (0..n).map(|i| (i % 251) as u8 ^ (i / 7919) as u8).collect()
    }

    #[test]
    fn create_unlock_roundtrip_and_wrong_password() {
        let (_d, v) = vault();
        assert!(!v.exists());
        assert!(v.seal_blob(b"x", "bin").is_err(), "no public key yet");
        assert!(v.create(b"short", KdfParams::fast()).unwrap_err().starts_with("WEAK_PASSWORD"));
        assert!(v.unlock(PW).unwrap_err().starts_with("NO_VAULT"));
        v.create(PW, KdfParams::fast()).unwrap();
        assert!(v.exists() && v.is_unlocked());
        assert!(v.create(PW, KdfParams::fast()).is_err(), "one vault only");
        let b = v.seal_blob(b"hello vault", "txt").unwrap();
        assert_eq!(v.open_blob(&b.id).unwrap().as_slice(), b"hello vault");
        assert!(v.lock());
        assert!(!v.lock());
        assert_eq!(v.open_blob(&b.id).unwrap_err(), "VAULT_LOCKED: The vault is locked");
        assert_eq!(v.unlock(b"wrong password!!").unwrap_err(), "WRONG_PASSWORD: Wrong password");
        assert!(v.create(b"short", KdfParams::fast()).unwrap_err().starts_with("VAULT_EXISTS"));
        assert!(!v.is_unlocked());
        v.unlock(PW).unwrap();
        assert_eq!(v.open_blob(&b.id).unwrap().as_slice(), b"hello vault");
        // A fresh Vault over the same directory sees the public key and unlocks.
        let v2 = Vault::new(v.dir().to_path_buf(), 10);
        assert!(v2.exists() && !v2.is_unlocked());
        v2.unlock(PW).unwrap();
        assert_eq!(v2.open_blob(&b.id).unwrap().as_slice(), b"hello vault");
        // The vault file holds the public key and KDF params in plain text, nothing else readable.
        let json = std::fs::read_to_string(v.dir().join(VAULT_FILE)).unwrap();
        assert!(json.contains("argon2id") && json.contains("\"mCostKib\": 1024"));
        assert!(!json.contains("hello vault"));
    }

    #[test]
    fn seal_while_locked_then_open_after_unlock() {
        let (_d, v) = vault();
        v.create(PW, KdfParams::fast()).unwrap();
        v.lock();
        let b = v.seal_blob(b"written while locked", "bin").unwrap();
        let item = VaultItem {
            prompt: "secret prompt".into(),
            ..sample_item(&b)
        };
        v.put_item(&item).unwrap();
        assert!(v.items().is_err());
        assert!(v.open_blob(&b.id).is_err());
        assert_eq!(v.serve(&format!("/{}", b.id), None).status, 403);
        v.unlock(PW).unwrap();
        assert_eq!(v.open_blob(&b.id).unwrap().as_slice(), b"written while locked");
        let items = v.items().unwrap();
        assert_eq!(items.len(), 1);
        assert_eq!(items[0].prompt, "secret prompt");
        // Nothing in the vault dir contains the plaintext.
        for entry in walk(v.dir()) {
            let bytes = std::fs::read(&entry).unwrap();
            assert!(!contains(&bytes, b"written while locked"), "{}", entry.display());
            assert!(!contains(&bytes, b"secret prompt"), "{}", entry.display());
        }
    }

    #[test]
    fn chunk_tampering_reordering_truncation_detected_and_random_access_works() {
        let (_d, v) = vault();
        v.create(PW, KdfParams::fast()).unwrap();
        let data = big(CHUNK_SIZE as usize * 2 + 12345); // 3 chunks, last partial
        let b = v.seal_blob(&data, "bin").unwrap();
        assert_eq!(v.open_blob(&b.id).unwrap().as_slice(), data.as_slice());
        assert_eq!(v.blob_len(&b.id).unwrap(), data.len() as u64);
        // random access across a chunk boundary and in the last chunk
        let (s, e) = (CHUNK_SIZE as u64 - 5, CHUNK_SIZE as u64 + 5);
        assert_eq!(v.read_blob_range(&b.id, s, e).unwrap().as_slice(), &data[s as usize..=e as usize]);
        let last = data.len() as u64 - 1;
        assert_eq!(v.read_blob_range(&b.id, last - 3, last).unwrap().as_slice(), &data[data.len() - 4..]);
        assert!(v.read_blob_range(&b.id, 10, last + 1).is_err());

        let path = v.blob_path(&b.id);
        let orig = std::fs::read(&path).unwrap();
        let chunk = CHUNK_SIZE as usize + TAG_LEN;
        // tamper one byte in chunk 1
        let mut t = orig.clone();
        t[HEADER_LEN + chunk + 100] ^= 1;
        std::fs::write(&path, &t).unwrap();
        assert!(v.open_blob(&b.id).is_err());
        assert!(v.read_blob_range(&b.id, 0, 10).is_ok(), "chunk 0 is intact");
        assert!(v.read_blob_range(&b.id, CHUNK_SIZE as u64, CHUNK_SIZE as u64 + 1).is_err());
        // swap chunks 0 and 1
        let mut r = orig.clone();
        let (c0, c1) = (HEADER_LEN..HEADER_LEN + chunk, HEADER_LEN + chunk..HEADER_LEN + 2 * chunk);
        let a = orig[c0.clone()].to_vec();
        let bb = orig[c1.clone()].to_vec();
        r[c0].copy_from_slice(&bb);
        r[c1].copy_from_slice(&a);
        std::fs::write(&path, &r).unwrap();
        assert!(v.open_blob(&b.id).is_err());
        assert!(v.read_blob_range(&b.id, 0, 10).is_err());
        // truncate: drop the last chunk entirely (file size mismatch), then by one byte
        std::fs::write(&path, &orig[..HEADER_LEN + 2 * chunk]).unwrap();
        assert!(v.open_blob(&b.id).is_err());
        std::fs::write(&path, &orig[..orig.len() - 1]).unwrap();
        assert!(v.open_blob(&b.id).is_err());
        // header tamper (length field) is detected through the AD
        let mut h = orig.clone();
        h[133] ^= 1;
        std::fs::write(&path, &h).unwrap();
        assert!(v.open_blob(&b.id).is_err());
        // restored → fine again
        std::fs::write(&path, &orig).unwrap();
        assert_eq!(v.open_blob(&b.id).unwrap().as_slice(), data.as_slice());
        // a blob copied under another name is refused (the id is bound into the AD)
        let other_id = uuid::Uuid::new_v4().to_string();
        std::fs::copy(&path, v.blob_path(&other_id)).unwrap();
        assert!(v.open_blob(&other_id).is_err());
        // a blob written for another vault cannot be opened here
        let (_d2, other) = vault();
        other.create(PW, KdfParams::fast()).unwrap();
        let foreign = other.seal_blob(b"foreign", "bin").unwrap();
        std::fs::copy(other.blob_path(&foreign.id), v.blob_path(&foreign.id)).unwrap();
        assert!(v.open_blob(&foreign.id).is_err());
    }

    #[test]
    fn empty_and_exact_multiple_blobs() {
        let (_d, v) = vault();
        v.create(PW, KdfParams::fast()).unwrap();
        let e = v.seal_blob(b"", "bin").unwrap();
        assert!(v.open_blob(&e.id).unwrap().is_empty());
        let data = big(CHUNK_SIZE as usize * 2);
        let b = v.seal_blob(&data, "bin").unwrap();
        assert_eq!(v.open_blob(&b.id).unwrap().as_slice(), data.as_slice());
        v.verify_blob(&b.id, &data).unwrap();
        assert!(v.verify_blob(&b.id, &data[1..]).is_err());
    }

    #[test]
    fn change_password_rewraps_only_the_private_key() {
        let (_d, v) = vault();
        v.create(PW, KdfParams::fast()).unwrap();
        let b = v.seal_blob(b"kept", "bin").unwrap();
        let blob_before = std::fs::read(v.blob_path(&b.id)).unwrap();
        assert!(v.change_password(b"nope nope nope", b"new password 123", KdfParams::fast()).is_err());
        assert!(v.change_password(PW, b"short", KdfParams::fast()).is_err());
        v.change_password(PW, b"new password 123", KdfParams::fast()).unwrap();
        assert_eq!(std::fs::read(v.blob_path(&b.id)).unwrap(), blob_before, "blobs untouched");
        v.lock();
        assert_eq!(v.unlock(PW).unwrap_err(), "WRONG_PASSWORD: Wrong password");
        v.unlock(b"new password 123").unwrap();
        assert_eq!(v.open_blob(&b.id).unwrap().as_slice(), b"kept");
    }

    #[test]
    fn lock_wipes_state_and_auto_lock_fires_after_idle() {
        let (_d, v) = vault();
        v.create(PW, KdfParams::fast()).unwrap();
        let b = v.seal_blob(b"m", "png").unwrap();
        v.put_item(&sample_item(&b)).unwrap();
        assert_eq!(v.status().item_count, Some(1));
        v.set_auto_lock(1);
        let t0 = Instant::now();
        assert!(!v.lock_if_idle(t0 + Duration::from_secs(30)));
        assert!(v.is_unlocked());
        assert!(v.lock_if_idle(t0 + Duration::from_secs(61)));
        let s = v.status();
        assert!(!s.unlocked && s.exists);
        assert_eq!(s.item_count, None);
        let locked = "VAULT_LOCKED: The vault is locked";
        assert_eq!(v.items().unwrap_err(), locked);
        assert_eq!(v.item(&sample_item(&b).id).unwrap_err(), locked);
        assert_eq!(v.open_blob(&b.id).unwrap_err(), locked);
        assert_eq!(v.read_blob_range(&b.id, 0, 0).unwrap_err(), locked);
        assert_eq!(v.blob_len(&b.id).unwrap_err(), locked);
        assert!(v.delete_item("x").is_err());
        // activity resets the idle clock
        v.unlock(PW).unwrap();
        v.touch();
        assert!(!v.lock_if_idle(Instant::now() + Duration::from_secs(59)));
    }

    #[test]
    fn items_cache_and_shared_blob_deletion() {
        let (_d, v) = vault();
        v.create(PW, KdfParams::fast()).unwrap();
        let shared = v.seal_blob(b"start image", "jpg").unwrap();
        let m1 = v.seal_blob(b"media one", "png").unwrap();
        let m2 = v.seal_blob(b"media two", "png").unwrap();
        let mut a = sample_item(&m1);
        a.init_image = Some(shared.clone());
        a.created_at = "2026-01-01T00:00:00Z".into();
        let mut b = sample_item(&m2);
        b.init_image = Some(shared.clone());
        b.created_at = "2026-01-02T00:00:00Z".into();
        v.put_item(&a).unwrap();
        v.put_item(&b).unwrap();
        let ids: Vec<String> = v.items().unwrap().into_iter().map(|i| i.id).collect();
        assert_eq!(ids, vec![b.id.clone(), a.id.clone()], "newest first");
        v.delete_item(&a.id).unwrap();
        assert!(v.open_blob(&m1.id).is_err(), "own media removed");
        assert_eq!(v.open_blob(&shared.id).unwrap().as_slice(), b"start image", "shared blob kept");
        v.delete_item(&b.id).unwrap();
        assert!(v.open_blob(&shared.id).is_err(), "last user removed it");
        assert!(v.items().unwrap().is_empty());
        // records are reloaded from disk on unlock
        v.put_item(&sample_item(&v.seal_blob(b"z", "png").unwrap())).unwrap();
        v.lock();
        v.unlock(PW).unwrap();
        assert_eq!(v.items().unwrap().len(), 1);
        let rec = v.items().unwrap()[0].to_record();
        assert!(rec.vault);
        assert!(rec.path.starts_with("vault://localhost/") && rec.path.ends_with(".png"));
        assert_eq!(BlobRef::parse(&rec.path).unwrap().ext, "png");
        assert_eq!(BlobRef::parse(&format!("vault://localhost/{}", rec.id)).map(|b| b.ext), Some("bin".into()));
        assert!(BlobRef::parse("vault://localhost/not-a-uuid.png").is_none());
        assert!(BlobRef::parse("/x/y.png").is_none());
    }

    #[test]
    fn serve_handles_lock_ranges_and_types() {
        let (_d, v) = vault();
        v.create(PW, KdfParams::fast()).unwrap();
        let mut png = b"\x89PNG\r\n\x1a\n".to_vec();
        png.extend(big(CHUNK_SIZE as usize + 1000));
        let b = v.seal_blob(&png, "png").unwrap();
        let p = format!("/{}.png", b.id);
        let hdr = |s: &Served, k: &str| s.headers.iter().find(|(h, _)| *h == k).map(|(_, v)| v.clone());

        let full = v.serve(&p, None);
        assert_eq!(full.status, 200);
        assert_eq!(full.body, png);
        assert_eq!(hdr(&full, "Content-Type").as_deref(), Some("image/png"));
        assert_eq!(hdr(&full, "Cache-Control").as_deref(), Some("no-store"));
        assert_eq!(hdr(&full, "Accept-Ranges").as_deref(), Some("bytes"));
        assert_eq!(hdr(&full, "Content-Length").as_deref(), Some(png.len().to_string().as_str()));

        let r = v.serve(&p, Some("bytes=1048570-1048585"));
        assert_eq!(r.status, 206);
        assert_eq!(r.body, &png[1048570..=1048585]);
        assert_eq!(hdr(&r, "Content-Range"), Some(format!("bytes 1048570-1048585/{}", png.len())));
        let open = v.serve(&p, Some("bytes=5-"));
        assert_eq!(open.status, 206);
        assert_eq!(open.body, &png[5..]);
        let suffix = v.serve(&p, Some("bytes=-3"));
        assert_eq!(suffix.body, &png[png.len() - 3..]);
        let bad = v.serve(&p, Some("bytes=99999999-"));
        assert_eq!(bad.status, 416);
        assert_eq!(hdr(&bad, "Content-Range"), Some(format!("bytes */{}", png.len())));
        assert_eq!(v.serve(&p, Some("garbage")).status, 416);
        assert_eq!(v.serve("/00000000-0000-0000-0000-000000000000", None).status, 404);
        assert_eq!(v.serve("/../vault.json", None).status, 404);

        let mp4 = v.seal_blob(b"\0\0\0\x18ftypisom\0\0\0\0isommp41", "mp4").unwrap();
        assert_eq!(hdr(&v.serve(&format!("/{}", mp4.id), None), "Content-Type").as_deref(), Some("video/mp4"));

        v.lock();
        let locked = v.serve(&p, None);
        assert_eq!(locked.status, 403);
        assert!(locked.body.is_empty());
        assert_eq!(hdr(&locked, "Cache-Control").as_deref(), Some("no-store"));
        assert_eq!(v.serve(&p, Some("bytes=0-10")).status, 403);
    }

    #[test]
    fn kdf_floor_and_stale_tmp_sweep() {
        assert!(KdfParams::PRODUCTION.validate().is_ok());
        assert!(KdfParams::fast().validate().is_ok(), "exact test tuple, debug builds only");
        for bad in [
            KdfParams { m_cost_kib: 32 * 1024, t_cost: 3, p_cost: 1 },
            KdfParams { m_cost_kib: 256 * 1024, t_cost: 1, p_cost: 1 },
            KdfParams { m_cost_kib: 2048, t_cost: 1, p_cost: 1 },
            KdfParams { m_cost_kib: 256 * 1024, t_cost: 3, p_cost: 0 },
        ] {
            assert!(bad.validate().is_err(), "{bad:?}");
        }
        let (_d, v) = vault();
        v.create(PW, KdfParams::fast()).unwrap();
        let b = v.seal_blob(b"x", "bin").unwrap();
        std::fs::write(v.blob_path("stale").with_extension("tmp"), b"junk").unwrap();
        std::fs::write(v.dir().join("vault.tmp"), b"junk").unwrap();
        std::fs::write(v.items_dir().join("half.tmp"), b"junk").unwrap();
        let fresh = Vault::new(v.dir().to_path_buf(), 10);
        assert!(!v.blob_path("stale").with_extension("tmp").exists());
        assert!(!v.dir().join("vault.tmp").exists());
        assert!(!v.items_dir().join("half.tmp").exists());
        fresh.unlock(PW).unwrap();
        assert_eq!(fresh.open_blob(&b.id).unwrap().as_slice(), b"x");
    }

    #[test]
    fn served_media_cache_is_dropped_on_lock() {
        let (_d, v) = vault();
        v.create(PW, KdfParams::fast()).unwrap();
        let b = v.seal_blob(b"\x89PNG\r\n\x1a\nbody", "png").unwrap();
        assert_eq!(v.serve(&format!("/{}", b.id), None).status, 200);
        assert!(v.media_cache.lock().unwrap().contains_key(&b.id));
        v.lock();
        assert!(v.media_cache.lock().unwrap().is_empty());
        assert_eq!(v.serve(&format!("/{}", b.id), None).status, 403);
        v.unlock(PW).unwrap();
        assert_eq!(v.serve(&format!("/{}", b.id), Some("bytes=0-3")).status, 206);
        v.delete_blob(&b.id).unwrap();
        assert_eq!(v.serve(&format!("/{}", b.id), None).status, 404);
    }

    #[test]
    fn range_parsing() {
        assert_eq!(parse_range("bytes=0-99", 1000), Some((0, 99)));
        assert_eq!(parse_range("bytes=0-5000", 1000), Some((0, 999)));
        assert_eq!(parse_range("bytes=10-", 1000), Some((10, 999)));
        assert_eq!(parse_range("bytes=-10", 1000), Some((990, 999)));
        assert_eq!(parse_range("bytes=-5000", 1000), Some((0, 999)));
        assert_eq!(parse_range("bytes=0-10, 20-30", 1000), Some((0, 10)));
        assert_eq!(parse_range("bytes=1000-", 1000), None);
        assert_eq!(parse_range("bytes=5-4", 1000), None);
        assert_eq!(parse_range("bytes=-0", 1000), None);
        assert_eq!(parse_range("items=0-1", 1000), None);
        assert_eq!(parse_range("bytes=0-1", 0), None);
    }

    fn sample_item(media: &BlobRef) -> VaultItem {
        VaultItem {
            id: uuid::Uuid::new_v4().to_string(),
            kind: KIND_IMAGE.into(),
            model: "chroma".into(),
            prompt: "p".into(),
            negative_prompt: String::new(),
            aspect_ratio: "1:1".into(),
            width: 8,
            height: 8,
            seed: 1,
            steps: 4,
            cfg: 1.0,
            loras: vec![],
            created_at: "2026-10-09T00:00:00Z".into(),
            duration_ms: None,
            runpod: RunpodTimes::default(),
            denoise: None,
            duration_s: None,
            fps: None,
            has_audio: None,
            media: media.clone(),
            poster: None,
            thumb: None,
            init_image: None,
            references: vec![],
            source_id: None,
            added_at: String::new(),
        }
    }

    fn walk(dir: &Path) -> Vec<PathBuf> {
        let mut out = vec![];
        if let Ok(rd) = std::fs::read_dir(dir) {
            for e in rd.flatten() {
                let p = e.path();
                if p.is_dir() {
                    out.extend(walk(&p));
                } else {
                    out.push(p);
                }
            }
        }
        out
    }

    fn contains(hay: &[u8], needle: &[u8]) -> bool {
        hay.windows(needle.len()).any(|w| w == needle)
    }
}
