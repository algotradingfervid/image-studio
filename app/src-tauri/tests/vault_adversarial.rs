//! Adversarial tests for the vault (spec v6) through the public API only.
//!
//! Every test works on a temp dir with throw-away data. An attacker here has
//! read/write access to the vault directory (one tier above the stated threat
//! model, which is read access) and must never make the vault return wrong
//! plaintext, crash the process, or accept a wrong password.

use app_lib::db::{RunpodTimes, KIND_IMAGE};
use app_lib::vault::{
    parse_range, BlobRef, KdfParams, Served, Vault, VaultItem, CHUNK_SIZE, ERR_LOCKED,
    ERR_WRONG_PASSWORD, MAX_RANGE_RESPONSE,
};
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::path::PathBuf;

const PW: &[u8] = b"correct horse battery staple";
const CS: usize = CHUNK_SIZE as usize;
/// Blob layout as written by `vault.rs`: magic(4) version(1) eph_pub(32)
/// wrap_nonce(24) wrapped_key(48) stream_nonce(20) chunk_size(4) len(8).
const HEADER_LEN: usize = 4 + 1 + 32 + 24 + 48 + 20 + 4 + 8;
const TAG_LEN: usize = 16;
const OFF_EPH_PUB: usize = 5;
const OFF_WRAP_NONCE: usize = 37;
const OFF_WRAPPED_KEY: usize = 61;
const OFF_STREAM_NONCE: usize = 109;
const OFF_CHUNK_SIZE: usize = 129;
const OFF_LEN: usize = 133;

fn new_vault() -> (tempfile::TempDir, Vault) {
    let dir = tempfile::tempdir().unwrap();
    let v = Vault::new(dir.path().join("vault"), 10);
    v.create(PW, KdfParams::fast()).unwrap();
    (dir, v)
}

fn blob_file(v: &Vault, id: &str) -> PathBuf {
    v.dir().join("blobs").join(format!("{id}.bin"))
}

fn item_file(v: &Vault, id: &str) -> PathBuf {
    v.dir().join("items").join(format!("{id}.bin"))
}

fn data(n: usize) -> Vec<u8> {
    (0..n).map(|i| ((i * 7919) ^ (i >> 11)) as u8).collect()
}

fn chunk_count(len: usize) -> usize {
    len.div_ceil(CS).max(1)
}

fn expected_file_len(len: usize) -> usize {
    HEADER_LEN + len + chunk_count(len) * TAG_LEN
}

/// Offset of chunk `i`'s ciphertext (body) in the file.
fn chunk_start(i: usize) -> usize {
    HEADER_LEN + i * (CS + TAG_LEN)
}

/// Full extent (body + tag) of chunk `i` for a plaintext of `len` bytes.
fn chunk_range(i: usize, len: usize) -> std::ops::Range<usize> {
    let body = len.saturating_sub(i * CS).min(CS);
    chunk_start(i)..chunk_start(i) + body + TAG_LEN
}

fn sample_item(media: &BlobRef, prompt: &str) -> VaultItem {
    VaultItem {
        id: uuid::Uuid::new_v4().to_string(),
        kind: KIND_IMAGE.into(),
        model: "chroma".into(),
        prompt: prompt.into(),
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

fn walk(dir: &std::path::Path) -> Vec<PathBuf> {
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
    !needle.is_empty() && hay.windows(needle.len()).any(|w| w == needle)
}

fn hdr(s: &Served, k: &str) -> Option<String> {
    s.headers.iter().find(|(h, _)| *h == k).map(|(_, v)| v.clone())
}

/// Runs `f` and demands an `Err` — a panic is a failure too (the release
/// profile has `panic = "abort"`, so any panic on a corrupt file kills the app).
fn must_err<T: std::fmt::Debug>(what: &str, f: impl FnOnce() -> Result<T, String>) {
    match catch_unwind(AssertUnwindSafe(f)) {
        Ok(Err(_)) => {}
        Ok(Ok(v)) => panic!("{what}: accepted instead of rejected: {v:?}"),
        Err(_) => panic!("{what}: PANICKED on a corrupt file instead of returning an error"),
    }
}

// ---------------------------------------------------------------- password

#[test]
fn wrong_password_is_rejected_and_leaves_the_vault_locked() {
    let (_d, v) = new_vault();
    let b = v.seal_blob(b"secret bytes", "bin").unwrap();
    assert!(v.lock());

    for wrong in [
        &b"correct horse battery stapl"[..], // one char short
        b"correct horse battery staple ",   // one char long
        b"Correct horse battery staple",    // case
        b"",                                // empty
        b"\x00\x00\x00\x00\x00\x00\x00\x00", // non-text
        b"\xff\xfe not utf-8 \xff",         // invalid UTF-8
    ] {
        let e = v.unlock(wrong).unwrap_err();
        assert!(e.starts_with(ERR_WRONG_PASSWORD), "{wrong:?} → {e}");
        assert!(!v.is_unlocked());
        assert!(v.open_blob(&b.id).unwrap_err().starts_with(ERR_LOCKED));
        assert_eq!(v.serve(&format!("/{}", b.id), None).status, 403);
    }
    // Changing the password needs the current one.
    assert!(v
        .change_password(b"not the password", b"a brand new password", KdfParams::fast())
        .unwrap_err()
        .starts_with(ERR_WRONG_PASSWORD));
    v.unlock(PW).unwrap();
    assert_eq!(v.open_blob(&b.id).unwrap().as_slice(), b"secret bytes");
}

#[test]
fn tampered_vault_json_cannot_unlock_and_never_panics() {
    let (_d, v) = new_vault();
    v.lock();
    let path = v.dir().join("vault.json");
    let orig = std::fs::read_to_string(&path).unwrap();
    let json: serde_json::Value = serde_json::from_str(&orig).unwrap();

    // Flip one base64 character in each secret-bearing field.
    for field in ["/publicKey", "/kdf/salt", "/privateKey/nonce", "/privateKey/ciphertext"] {
        let mut j = json.clone();
        let s = j.pointer_mut(field).unwrap();
        let mut text = s.as_str().unwrap().to_string();
        let i = text.len() / 2;
        let c = text.as_bytes()[i];
        let flipped = if c == b'A' { b'B' } else { b'A' };
        text.replace_range(i..i + 1, std::str::from_utf8(&[flipped]).unwrap());
        *s = serde_json::Value::String(text);
        std::fs::write(&path, serde_json::to_string(&j).unwrap()).unwrap();
        let fresh = Vault::new(v.dir().to_path_buf(), 10);
        must_err(&format!("vault.json {field} tampered"), || fresh.unlock(PW));
        assert!(!fresh.is_unlocked());
    }
    // Absurd KDF parameters are refused rather than executed.
    for (field, val) in [
        ("/kdf/mCostKib", serde_json::json!(u32::MAX)),
        ("/kdf/tCost", serde_json::json!(0)),
        ("/kdf/pCost", serde_json::json!(1 << 24)),
        ("/kdf/algorithm", serde_json::json!("md5")),
    ] {
        let mut j = json.clone();
        *j.pointer_mut(field).unwrap() = val;
        std::fs::write(&path, serde_json::to_string(&j).unwrap()).unwrap();
        must_err(&format!("vault.json {field} absurd"), || Vault::new(v.dir().to_path_buf(), 10).unlock(PW));
    }
    // Garbage and truncation.
    for bad in ["", "{", "null", "[]", &orig[..orig.len() / 2]] {
        std::fs::write(&path, bad).unwrap();
        must_err("vault.json garbage", || Vault::new(v.dir().to_path_buf(), 10).unlock(PW));
    }
    std::fs::write(&path, &orig).unwrap();
    Vault::new(v.dir().to_path_buf(), 10).unlock(PW).unwrap();
}

#[test]
fn change_password_replaces_the_file_atomically_and_rewraps_only_the_key() {
    let (_d, v) = new_vault();
    let b = v.seal_blob(b"kept across password change", "bin").unwrap();
    let blob_before = std::fs::read(blob_file(&v, &b.id)).unwrap();
    let json_before: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string(v.dir().join("vault.json")).unwrap()).unwrap();

    // A stale temp file from an earlier crash must not block the change.
    std::fs::write(v.dir().join("vault.tmp"), b"half-written junk").unwrap();
    v.change_password(PW, b"a brand new password", KdfParams::fast()).unwrap();

    let json_after: serde_json::Value =
        serde_json::from_str(&std::fs::read_to_string(v.dir().join("vault.json")).unwrap()).unwrap();
    assert_eq!(json_after["publicKey"], json_before["publicKey"], "key pair unchanged");
    assert_ne!(json_after["kdf"]["salt"], json_before["kdf"]["salt"], "fresh salt");
    assert_ne!(json_after["privateKey"]["nonce"], json_before["privateKey"]["nonce"], "fresh nonce");
    assert_ne!(json_after["privateKey"]["ciphertext"], json_before["privateKey"]["ciphertext"]);
    assert_eq!(std::fs::read(blob_file(&v, &b.id)).unwrap(), blob_before, "blobs untouched");
    assert!(!v.dir().join("vault.tmp").exists(), "temp file renamed away");

    // Only the complete new file is ever visible: a fresh instance sees the new password.
    let fresh = Vault::new(v.dir().to_path_buf(), 10);
    assert!(fresh.unlock(PW).unwrap_err().starts_with(ERR_WRONG_PASSWORD));
    fresh.unlock(b"a brand new password").unwrap();
    assert_eq!(fresh.open_blob(&b.id).unwrap().as_slice(), b"kept across password change");
}

// ---------------------------------------------------------------- blob format

#[test]
fn blob_file_sizes_follow_the_documented_layout() {
    let (_d, v) = new_vault();
    for len in [0, 1, 64, CS - 1, CS, CS + 1, 2 * CS, 2 * CS + 12345] {
        let b = v.seal_blob(&data(len), "bin").unwrap();
        let on_disk = std::fs::metadata(blob_file(&v, &b.id)).unwrap().len() as usize;
        assert_eq!(on_disk, expected_file_len(len), "len {len}");
        let bytes = std::fs::read(blob_file(&v, &b.id)).unwrap();
        assert_eq!(&bytes[..4], b"ISVB");
        assert_eq!(bytes[4], 1);
        assert_eq!(u32::from_le_bytes(bytes[OFF_CHUNK_SIZE..OFF_CHUNK_SIZE + 4].try_into().unwrap()), CHUNK_SIZE);
        assert_eq!(u64::from_le_bytes(bytes[OFF_LEN..OFF_LEN + 8].try_into().unwrap()), len as u64);
    }
}

#[test]
fn every_header_byte_is_authenticated() {
    let (_d, v) = new_vault();
    let pt = data(2 * CS + 12345); // 3 chunks, last partial
    let b = v.seal_blob(&pt, "bin").unwrap();
    let path = blob_file(&v, &b.id);
    let orig = std::fs::read(&path).unwrap();
    for i in 0..HEADER_LEN {
        let mut t = orig.clone();
        t[i] ^= 0x01;
        std::fs::write(&path, &t).unwrap();
        let region = match i {
            0..=3 => "magic",
            4 => "version",
            OFF_EPH_PUB..OFF_WRAP_NONCE => "ephemeral public key",
            OFF_WRAP_NONCE..OFF_WRAPPED_KEY => "wrap nonce",
            OFF_WRAPPED_KEY..OFF_STREAM_NONCE => "wrapped content key (incl. tag)",
            OFF_STREAM_NONCE..OFF_CHUNK_SIZE => "stream nonce",
            OFF_CHUNK_SIZE..OFF_LEN => "chunk size",
            _ => "length",
        };
        must_err(&format!("header byte {i} ({region}) flipped: open_blob"), || v.open_blob(&b.id));
        must_err(&format!("header byte {i} ({region}) flipped: read_blob_range"), || {
            v.read_blob_range(&b.id, 0, 3)
        });
        // Over vault:// a tampered blob is an error status with an empty body, never bytes.
        let s = v.serve(&format!("/{}", b.id), Some("bytes=0-3"));
        assert!(s.status >= 400 && s.body.is_empty(), "header byte {i}: status {}", s.status);
    }
    std::fs::write(&path, &orig).unwrap();
    assert_eq!(v.open_blob(&b.id).unwrap().as_slice(), pt.as_slice());
}

#[test]
fn tampered_chunk_bodies_and_tags_are_rejected() {
    let (_d, v) = new_vault();
    let pt = data(2 * CS + 12345);
    let b = v.seal_blob(&pt, "bin").unwrap();
    let path = blob_file(&v, &b.id);
    let orig = std::fs::read(&path).unwrap();
    let n = chunk_count(pt.len());
    assert_eq!(n, 3);

    for i in 0..n {
        let r = chunk_range(i, pt.len());
        let body_byte = r.start + (r.len() - TAG_LEN) / 2;
        let tag_byte = r.end - TAG_LEN / 2;
        for (where_, idx, mask) in [
            ("body", body_byte, 0x01u8),
            ("body-high-bit", body_byte, 0x80u8),
            ("tag", tag_byte, 0x01u8),
            ("tag-last-byte", r.end - 1, 0xffu8),
        ] {
            let mut t = orig.clone();
            t[idx] ^= mask;
            std::fs::write(&path, &t).unwrap();
            must_err(&format!("chunk {i} {where_}: open_blob"), || v.open_blob(&b.id));
            must_err(&format!("chunk {i} {where_}: verify_blob"), || v.verify_blob(&b.id, &pt));
            // Reading inside the damaged chunk fails...
            let (s, e) = ((i * CS) as u64, (i * CS + 10).min(pt.len() - 1) as u64);
            must_err(&format!("chunk {i} {where_}: range inside"), || v.read_blob_range(&b.id, s, e));
            // ...while an intact chunk still decrypts (random access is per chunk by design).
            let other = (i + 1) % n;
            let (os, oe) = ((other * CS) as u64, (other * CS + 10).min(pt.len() - 1) as u64);
            assert_eq!(
                v.read_blob_range(&b.id, os, oe).unwrap().as_slice(),
                &pt[os as usize..=oe as usize],
                "chunk {other} should still be readable when only chunk {i} is damaged"
            );
        }
    }
    // Setting a whole tag to zero.
    let mut t = orig.clone();
    let r = chunk_range(2, pt.len());
    t[r.end - TAG_LEN..r.end].fill(0);
    std::fs::write(&path, &t).unwrap();
    must_err("zeroed tag", || v.open_blob(&b.id));
}

#[test]
fn truncated_or_extended_files_are_rejected_even_for_early_chunks() {
    let (_d, v) = new_vault();
    let pt = data(2 * CS + 12345);
    let b = v.seal_blob(&pt, "bin").unwrap();
    let path = blob_file(&v, &b.id);
    let orig = std::fs::read(&path).unwrap();
    let last = chunk_range(2, pt.len());

    let cases: Vec<(&str, Vec<u8>)> = vec![
        ("minus 1 byte", orig[..orig.len() - 1].to_vec()),
        ("minus the last tag", orig[..orig.len() - TAG_LEN].to_vec()),
        ("minus the last chunk entirely", orig[..last.start].to_vec()),
        ("minus the last chunk but its tag kept", {
            let mut t = orig[..last.start].to_vec();
            t.extend_from_slice(&orig[last.end - TAG_LEN..]);
            t
        }),
        ("header only", orig[..HEADER_LEN].to_vec()),
        ("header minus 1", orig[..HEADER_LEN - 1].to_vec()),
        ("empty file", vec![]),
        ("plus 1 byte", {
            let mut t = orig.clone();
            t.push(0);
            t
        }),
        ("plus a whole extra chunk (copy of chunk 1)", {
            let mut t = orig.clone();
            t.extend_from_slice(&orig[chunk_range(1, pt.len())]);
            t
        }),
    ];
    for (what, bytes) in cases {
        std::fs::write(&path, &bytes).unwrap();
        must_err(&format!("{what}: open_blob"), || v.open_blob(&b.id));
        must_err(&format!("{what}: blob_len"), || v.blob_len(&b.id));
        // The header's length is authenticated, so a file of the wrong size is
        // refused outright — even a request that only needs the (intact) first chunk.
        must_err(&format!("{what}: range in chunk 0"), || v.read_blob_range(&b.id, 0, 7));
        assert_eq!(v.serve(&format!("/{}", b.id), None).status, 404, "{what}");
    }
    std::fs::write(&path, &orig).unwrap();
    assert_eq!(v.open_blob(&b.id).unwrap().as_slice(), pt.as_slice());
}

#[test]
fn reordered_duplicated_or_cross_file_chunks_are_rejected() {
    let (_d, v) = new_vault();
    let pt = data(3 * CS); // 3 full chunks: swaps never change the file size
    let b = v.seal_blob(&pt, "bin").unwrap();
    let path = blob_file(&v, &b.id);
    let orig = std::fs::read(&path).unwrap();
    let c = |i: usize| orig[chunk_range(i, pt.len())].to_vec();

    let rebuilt = |order: [usize; 3]| {
        let mut t = orig[..HEADER_LEN].to_vec();
        for i in order {
            t.extend_from_slice(&c(i));
        }
        t
    };
    for (what, order) in [
        ("swap 0 and 1", [1, 0, 2]),
        ("swap 1 and 2 (last flag)", [0, 2, 1]),
        ("swap 0 and 2", [2, 1, 0]),
        ("rotate", [1, 2, 0]),
        ("duplicate chunk 0", [0, 0, 2]),
        ("duplicate last chunk", [0, 2, 2]),
    ] {
        std::fs::write(&path, rebuilt(order)).unwrap();
        must_err(&format!("{what}: open_blob"), || v.open_blob(&b.id));
        for i in 0..3u64 {
            if order[i as usize] != i as usize {
                must_err(&format!("{what}: range in displaced chunk {i}"), || {
                    v.read_blob_range(&b.id, i * CS as u64, i * CS as u64 + 7)
                });
            }
        }
    }

    // A chunk from a *different* blob of identical size and position.
    let pt2 = data(3 * CS).iter().map(|x| x.wrapping_add(1)).collect::<Vec<_>>();
    let b2 = v.seal_blob(&pt2, "bin").unwrap();
    let orig2 = std::fs::read(blob_file(&v, &b2.id)).unwrap();
    let mut t = orig.clone();
    t[chunk_range(1, pt.len())].copy_from_slice(&orig2[chunk_range(1, pt2.len())]);
    std::fs::write(&path, &t).unwrap();
    must_err("chunk 1 from another blob", || v.open_blob(&b.id));
    must_err("chunk 1 from another blob: range", || v.read_blob_range(&b.id, CS as u64, CS as u64 + 7));
    assert_eq!(v.read_blob_range(&b.id, 0, 7).unwrap().as_slice(), &pt[..8], "chunk 0 intact");

    // Header from blob 2 on blob 1's body (content key confusion).
    let mut t = orig.clone();
    t[..HEADER_LEN].copy_from_slice(&orig2[..HEADER_LEN]);
    std::fs::write(&path, &t).unwrap();
    must_err("foreign header", || v.open_blob(&b.id));

    std::fs::write(&path, &orig).unwrap();
    assert_eq!(v.open_blob(&b.id).unwrap().as_slice(), pt.as_slice());
}

#[test]
fn blobs_from_another_vault_are_rejected() {
    let (_d1, a) = new_vault();
    let (_d2, other) = new_vault(); // different key pair, same password
    let foreign = other.seal_blob(b"foreign plaintext", "bin").unwrap();
    std::fs::copy(blob_file(&other, &foreign.id), blob_file(&a, &foreign.id)).unwrap();
    must_err("foreign blob", || a.open_blob(&foreign.id));
    must_err("foreign blob range", || a.read_blob_range(&foreign.id, 0, 3));
    assert_eq!(a.serve(&format!("/{}", foreign.id), None).status, 404);
}

/// The blob id (file name) is bound into the associated data of every chunk,
/// so an existing blob copied under another uuid does not decrypt under that
/// name (and a record copied under another name is skipped on unlock).
#[test]
fn blob_copied_under_another_id_is_rejected() {
    let (_d, v) = new_vault();
    let b = v.seal_blob(b"original blob", "bin").unwrap();
    let other_id = uuid::Uuid::new_v4().to_string();
    std::fs::copy(blob_file(&v, &b.id), blob_file(&v, &other_id)).unwrap();
    must_err("blob copied under another id", || v.open_blob(&other_id));
    must_err("blob copied under another id: range", || v.read_blob_range(&other_id, 0, 3));
    assert_eq!(v.serve(&format!("/{}", other_id), None).status, 404);
    assert_eq!(v.open_blob(&b.id).unwrap().as_slice(), b"original blob", "the original still opens");
}

#[test]
fn item_record_copied_under_another_name_does_not_duplicate_or_crash() {
    let (_d, v) = new_vault();
    let b = v.seal_blob(b"media", "png").unwrap();
    let item = sample_item(&b, "the prompt");
    v.put_item(&item).unwrap();
    let other = uuid::Uuid::new_v4().to_string();
    std::fs::copy(item_file(&v, &item.id), item_file(&v, &other)).unwrap();
    v.lock();
    v.unlock(PW).unwrap();
    let items = v.items().unwrap();
    assert_eq!(items.len(), 1, "records are keyed by their inner id");
    assert_eq!(items[0].id, item.id);
}

#[test]
fn tampered_item_record_is_skipped_on_unlock_not_fatal() {
    let (_d, v) = new_vault();
    let b1 = v.seal_blob(b"media one", "png").unwrap();
    let b2 = v.seal_blob(b"media two", "png").unwrap();
    let good = sample_item(&b1, "good prompt");
    let bad = sample_item(&b2, "bad prompt");
    v.put_item(&good).unwrap();
    v.put_item(&bad).unwrap();
    let p = item_file(&v, &bad.id);
    let mut t = std::fs::read(&p).unwrap();
    t[HEADER_LEN + 5] ^= 0x40;
    std::fs::write(&p, &t).unwrap();
    v.lock();
    v.unlock(PW).unwrap();
    let items = v.items().unwrap();
    assert_eq!(items.len(), 1);
    assert_eq!(items[0].prompt, "good prompt");
    assert!(v.item(&bad.id).is_err());
    // A record file that is not a sealed blob at all.
    std::fs::write(&p, b"{\"id\":\"x\",\"prompt\":\"plaintext injected\"}").unwrap();
    v.lock();
    v.unlock(PW).unwrap();
    assert_eq!(v.items().unwrap().len(), 1, "unencrypted records are never accepted");
}

/// Crafted header whose `len`/`chunk_size` make the size arithmetic wrap.
/// The vault must answer with an error, never a panic or a giant allocation.
#[test]
fn crafted_length_fields_do_not_panic() {
    let (_d, v) = new_vault();
    let b = v.seal_blob(&data(1000), "bin").unwrap();
    let path = blob_file(&v, &b.id);
    let orig = std::fs::read(&path).unwrap();
    let actual = orig.len() as u64;

    // 1) chunk_size = 1 and len chosen so that HEADER + len + 16*len ≡ actual (mod 2^64),
    //    i.e. the stored size "matches" after wrapping arithmetic.
    let inv17: u64 = {
        // multiplicative inverse of 17 modulo 2^64 (Newton iteration)
        let mut x: u64 = 1;
        for _ in 0..6 {
            x = x.wrapping_mul(2u64.wrapping_sub(17u64.wrapping_mul(x)));
        }
        assert_eq!(17u64.wrapping_mul(x), 1);
        x
    };
    let len = actual.wrapping_sub(HEADER_LEN as u64).wrapping_mul(inv17);
    let mut t = orig.clone();
    t[OFF_CHUNK_SIZE..OFF_CHUNK_SIZE + 4].copy_from_slice(&1u32.to_le_bytes());
    t[OFF_LEN..OFF_LEN + 8].copy_from_slice(&len.to_le_bytes());
    std::fs::write(&path, &t).unwrap();
    must_err("wrapping len/chunk_size: open_blob", || v.open_blob(&b.id));
    must_err("wrapping len/chunk_size: blob_len", || v.blob_len(&b.id));
    must_err("wrapping len/chunk_size: range", || v.read_blob_range(&b.id, 0, 3));
    let s = catch_unwind(AssertUnwindSafe(|| v.serve(&format!("/{}", b.id), Some("bytes=0-3"))));
    assert!(matches!(s, Ok(ref s) if s.status >= 400), "serve must fail cleanly, not panic");

    // 2) len = u64::MAX with the real chunk size.
    let mut t = orig.clone();
    t[OFF_LEN..OFF_LEN + 8].copy_from_slice(&u64::MAX.to_le_bytes());
    std::fs::write(&path, &t).unwrap();
    must_err("len = u64::MAX", || v.open_blob(&b.id));

    // 3) chunk_size = u32::MAX, len unchanged (chunk count stays 1, size check passes).
    let mut t = orig.clone();
    t[OFF_CHUNK_SIZE..OFF_CHUNK_SIZE + 4].copy_from_slice(&u32::MAX.to_le_bytes());
    std::fs::write(&path, &t).unwrap();
    must_err("chunk_size = u32::MAX", || v.open_blob(&b.id));
    must_err("chunk_size = u32::MAX: range", || v.read_blob_range(&b.id, 0, 3));

    std::fs::write(&path, &orig).unwrap();
    assert_eq!(v.open_blob(&b.id).unwrap().as_slice(), data(1000).as_slice());
}

// ---------------------------------------------------------------- lifecycle

#[test]
fn sealed_while_locked_opens_after_unlock_and_leaves_no_plaintext_on_disk() {
    let (_d, v) = new_vault();
    assert!(v.lock());
    let media = {
        let mut m = b"\x89PNG\r\n\x1a\nLOCKED-MEDIA-MARKER-".to_vec();
        m.extend(data(CS + 777));
        m
    };
    let b = v.seal_blob(&media, "png").unwrap();
    let item = sample_item(&b, "LOCKED-PROMPT-MARKER explicit private text");
    v.put_item(&item).unwrap();

    // Nothing readable while locked.
    assert!(v.open_blob(&b.id).unwrap_err().starts_with(ERR_LOCKED));
    assert!(v.read_blob_range(&b.id, 0, 1).unwrap_err().starts_with(ERR_LOCKED));
    assert!(v.blob_len(&b.id).unwrap_err().starts_with(ERR_LOCKED));
    assert!(v.items().unwrap_err().starts_with(ERR_LOCKED));
    assert!(v.item(&item.id).unwrap_err().starts_with(ERR_LOCKED));
    assert!(v.delete_item(&item.id).unwrap_err().starts_with(ERR_LOCKED));
    assert_eq!(v.status().item_count, None);
    let s = v.serve(&format!("/{}.png", b.id), None);
    assert_eq!((s.status, s.body.len()), (403, 0));
    assert_eq!(hdr(&s, "Cache-Control").as_deref(), Some("no-store"));

    // Every byte under the vault dir is ciphertext / public material.
    for f in walk(v.dir()) {
        let bytes = std::fs::read(&f).unwrap();
        assert!(!contains(&bytes, b"LOCKED-MEDIA-MARKER"), "{}", f.display());
        assert!(!contains(&bytes, b"LOCKED-PROMPT-MARKER"), "{}", f.display());
        assert!(!contains(&bytes, b"explicit private text"), "{}", f.display());
        assert!(!contains(&bytes, b"\x89PNG"), "{}", f.display());
        assert!(!contains(&bytes, &media[64..200]), "{}", f.display());
        assert!(!contains(&bytes, b"chroma"), "{}: model name leaked", f.display());
        assert!(!contains(&bytes, b".png"), "{}: extension leaked", f.display());
    }
    assert!(!v.dir().join("blobs").join(format!("{}.tmp", b.id)).exists(), "temp file renamed away");

    v.unlock(PW).unwrap();
    assert_eq!(v.open_blob(&b.id).unwrap().as_slice(), media.as_slice());
    let items = v.items().unwrap();
    assert_eq!(items.len(), 1);
    assert_eq!(items[0].prompt, item.prompt);
    assert_eq!(items[0].media, b);
    assert_eq!(v.status().item_count, Some(1));
    let s = v.serve(&format!("/{}.png", b.id), None);
    assert_eq!(s.status, 200);
    assert_eq!(s.body, media);
    assert_eq!(hdr(&s, "Content-Type").as_deref(), Some("image/png"));
}

#[test]
fn a_fresh_instance_over_the_same_dir_sees_a_locked_vault() {
    let (_d, v) = new_vault();
    let b = v.seal_blob(b"persisted", "bin").unwrap();
    let fresh = Vault::new(v.dir().to_path_buf(), 10);
    assert!(fresh.exists());
    assert!(!fresh.is_unlocked());
    assert!(fresh.open_blob(&b.id).unwrap_err().starts_with(ERR_LOCKED));
    // Writing still works without the password (public key only).
    let c = fresh.seal_blob(b"written by the locked instance", "bin").unwrap();
    assert_eq!(v.open_blob(&c.id).unwrap().as_slice(), b"written by the locked instance");
    // A second create is refused even though the fresh instance never unlocked.
    assert!(fresh.create(PW, KdfParams::fast()).is_err());
    // A corrupt vault.json must not let "create" overwrite the real one.
    std::fs::write(v.dir().join("vault.json"), "{ not json").unwrap();
    let broken = Vault::new(v.dir().to_path_buf(), 10);
    assert!(!broken.exists());
    assert!(broken.create(PW, KdfParams::fast()).is_err(), "would destroy the user's key");
}

// ---------------------------------------------------------------- sizes

#[test]
fn zero_length_blob_round_trips() {
    let (_d, v) = new_vault();
    let b = v.seal_blob(b"", "bin").unwrap();
    assert_eq!(std::fs::metadata(blob_file(&v, &b.id)).unwrap().len() as usize, HEADER_LEN + TAG_LEN);
    assert!(v.open_blob(&b.id).unwrap().is_empty());
    assert_eq!(v.blob_len(&b.id).unwrap(), 0);
    v.verify_blob(&b.id, b"").unwrap();
    assert!(v.verify_blob(&b.id, b"x").is_err());
    assert!(v.read_blob_range(&b.id, 0, 0).is_err(), "no byte 0 in an empty blob");
    let s = v.serve(&format!("/{}", b.id), None);
    assert!(s.body.is_empty());
    assert!(s.status == 200 || s.status == 404, "status {}", s.status);
    let r = v.serve(&format!("/{}", b.id), Some("bytes=0-0"));
    assert!(r.body.is_empty());
    assert!(r.status == 404 || r.status == 416, "no byte of an empty blob is satisfiable: {}", r.status);
    // Truncating the single (empty) chunk's tag is detected.
    let path = blob_file(&v, &b.id);
    let orig = std::fs::read(&path).unwrap();
    std::fs::write(&path, &orig[..HEADER_LEN]).unwrap();
    must_err("empty blob without tag", || v.open_blob(&b.id));
    std::fs::write(&path, &orig).unwrap();
    assert!(v.open_blob(&b.id).unwrap().is_empty());
}

#[test]
fn exactly_chunk_size_and_one_more_byte() {
    let (_d, v) = new_vault();
    for len in [CS, CS + 1, 2 * CS, 2 * CS + 1, CS - 1] {
        let pt = data(len);
        let b = v.seal_blob(&pt, "bin").unwrap();
        let n = chunk_count(len);
        let path = blob_file(&v, &b.id);
        assert_eq!(std::fs::metadata(&path).unwrap().len() as usize, expected_file_len(len), "len {len}");
        assert_eq!(v.open_blob(&b.id).unwrap().as_slice(), pt.as_slice(), "len {len}");
        assert_eq!(v.blob_len(&b.id).unwrap() as usize, len);
        v.verify_blob(&b.id, &pt).unwrap();

        // Every byte at a chunk boundary, individually and in pairs.
        let last = (len - 1) as u64;
        for i in 1..n {
            let edge = (i * CS) as u64;
            assert_eq!(v.read_blob_range(&b.id, edge - 1, edge - 1).unwrap().as_slice(), &pt[edge as usize - 1..edge as usize]);
            assert_eq!(v.read_blob_range(&b.id, edge, edge).unwrap().as_slice(), &pt[edge as usize..=edge as usize]);
            assert_eq!(v.read_blob_range(&b.id, edge - 1, edge).unwrap().as_slice(), &pt[edge as usize - 1..=edge as usize]);
        }
        assert_eq!(v.read_blob_range(&b.id, 0, 0).unwrap().as_slice(), &pt[..1]);
        assert_eq!(v.read_blob_range(&b.id, last, last).unwrap().as_slice(), &pt[len - 1..]);
        assert_eq!(v.read_blob_range(&b.id, 0, last).unwrap().as_slice(), pt.as_slice());
        assert!(v.read_blob_range(&b.id, last, last + 1).is_err(), "end past the file");
        assert!(v.read_blob_range(&b.id, last + 1, last + 1).is_err());
        assert!(v.read_blob_range(&b.id, 3, 2).is_err(), "start > end");
        assert!(v.read_blob_range(&b.id, 0, u64::MAX).is_err());
        assert!(v.read_blob_range(&b.id, u64::MAX, u64::MAX).is_err());

        // Damage confined to the (possibly 1-byte) last chunk.
        let orig = std::fs::read(&path).unwrap();
        let r = chunk_range(n - 1, len);
        let mut t = orig.clone();
        t[r.start] ^= 1;
        std::fs::write(&path, &t).unwrap();
        must_err(&format!("len {len}: last chunk body"), || v.open_blob(&b.id));
        must_err(&format!("len {len}: last byte"), || v.read_blob_range(&b.id, last, last));
        if n > 1 {
            assert_eq!(v.read_blob_range(&b.id, 0, 7).unwrap().as_slice(), &pt[..8], "len {len}: chunk 0 intact");
        }
        // Remove the last chunk together with its tag → the file shrinks by body+16, rejected.
        std::fs::write(&path, &orig[..r.start]).unwrap();
        must_err(&format!("len {len}: last chunk removed"), || v.open_blob(&b.id));
        std::fs::write(&path, &orig).unwrap();
    }
}

// ---------------------------------------------------------------- ranges

#[test]
fn parse_range_edge_cases() {
    let len = 1000;
    // valid
    assert_eq!(parse_range("bytes=0-0", len), Some((0, 0)));
    assert_eq!(parse_range("bytes=999-999", len), Some((999, 999)));
    assert_eq!(parse_range("bytes=999-", len), Some((999, 999)));
    assert_eq!(parse_range("bytes=0-", len), Some((0, 999)));
    assert_eq!(parse_range("bytes=-1", len), Some((999, 999)));
    assert_eq!(parse_range("bytes=-1000", len), Some((0, 999)));
    assert_eq!(parse_range("bytes=-1001", len), Some((0, 999)), "suffix longer than the file clamps");
    assert_eq!(parse_range("bytes=0-1", 1), Some((0, 0)), "end clamps to len-1");
    assert_eq!(parse_range("bytes=0-", 1), Some((0, 0)));
    assert_eq!(parse_range("bytes=-1", 1), Some((0, 0)));
    assert_eq!(parse_range(" bytes=0-9 ", len), Some((0, 9)));
    assert_eq!(parse_range("bytes= 0 - 9 ", len), Some((0, 9)));
    assert_eq!(parse_range("bytes=0-9,500-600", len), Some((0, 9)), "first range only");
    assert_eq!(parse_range("bytes=0-18446744073709551615", len), Some((0, 999)), "u64::MAX end clamps");
    assert_eq!(parse_range("bytes=-18446744073709551615", len), Some((0, 999)), "u64::MAX suffix clamps");
    // invalid / unsatisfiable → None (→ 416)
    for bad in [
        "",
        "bytes",
        "bytes=",
        "bytes=-",
        "bytes=-0",
        "bytes=1000-",
        "bytes=1000-1000",
        "bytes=5-4",
        "bytes=1-2-3",
        "bytes=a-b",
        "bytes=0x10-0x20",
        "bytes=1.5-2",
        "bytes=-5-",
        "bytes=18446744073709551616-", // u64::MAX + 1
        "bytes=0-18446744073709551616", // overflow in the end → rejected (clamping would also be fine)
        "bytes=-18446744073709551616",
        "bytes=18446744073709551615-18446744073709551615",
        "items=0-1",
        "BYTES=0-1",
        "bytes=0-1\r\nX-Injected: 1",
        "bytes=,0-1",
        "bytes=0-1;",
        "bytes=\u{ff10}-\u{ff11}", // full-width digits
    ] {
        assert_eq!(parse_range(bad, len), None, "{bad:?}");
    }
    // No byte of a zero-length resource is satisfiable.
    for r in ["bytes=0-0", "bytes=0-", "bytes=-1", "bytes=-0"] {
        assert_eq!(parse_range(r, 0), None, "{r:?} on empty");
    }
    // u64::MAX-sized resource: no overflow anywhere.
    assert_eq!(parse_range("bytes=0-", u64::MAX), Some((0, u64::MAX - 1)));
    assert_eq!(parse_range("bytes=-1", u64::MAX), Some((u64::MAX - 1, u64::MAX - 1)));
    assert_eq!(parse_range("bytes=18446744073709551614-", u64::MAX), Some((u64::MAX - 1, u64::MAX - 1)));
    assert_eq!(parse_range("bytes=18446744073709551615-", u64::MAX), None);
}

#[test]
fn served_ranges_are_exact_and_capped() {
    let (_d, v) = new_vault();
    let total = 10 * CS + 4321; // > 2 * MAX_RANGE_RESPONSE, 11 chunks
    let mut pt = b"\x89PNG\r\n\x1a\n".to_vec();
    pt.extend(data(total - 8));
    let b = v.seal_blob(&pt, "png").unwrap();
    let p = format!("/{}.png", b.id);
    let len = pt.len() as u64;

    let check = |range: &str, start: u64, end: u64| {
        let s = v.serve(&p, Some(range));
        assert_eq!(s.status, 206, "{range}");
        assert_eq!(s.body, &pt[start as usize..=end as usize], "{range}");
        assert_eq!(hdr(&s, "Content-Length"), Some((end - start + 1).to_string()), "{range}");
        assert_eq!(hdr(&s, "Content-Range"), Some(format!("bytes {start}-{end}/{len}")), "{range}");
        assert_eq!(hdr(&s, "Cache-Control").as_deref(), Some("no-store"), "{range}");
        assert_eq!(hdr(&s, "Accept-Ranges").as_deref(), Some("bytes"), "{range}");
        assert_eq!(hdr(&s, "Content-Type").as_deref(), Some("image/png"), "{range}");
    };
    check("bytes=0-0", 0, 0);
    check(&format!("bytes={}-{}", len - 1, len - 1), len - 1, len - 1);
    check("bytes=-1", len - 1, len - 1);
    check(&format!("bytes={}-", len - 1), len - 1, len - 1);
    // every chunk boundary
    for i in 1..11u64 {
        let e = i * CS as u64;
        check(&format!("bytes={}-{}", e - 1, e), e - 1, e);
        check(&format!("bytes={}-{}", e, e), e, e);
        check(&format!("bytes={}-{}", e - 3, e + 3), e - 3, e + 3);
    }
    // open-ended and oversized ranges are capped at MAX_RANGE_RESPONSE, not the whole file
    let cap = MAX_RANGE_RESPONSE;
    check("bytes=0-", 0, cap - 1);
    check(&format!("bytes=0-{}", len - 1), 0, cap - 1);
    check("bytes=0-18446744073709551615", 0, cap - 1);
    check(&format!("bytes=100-{}", len - 1), 100, 100 + cap - 1);
    check(&format!("bytes=-{}", len), 0, cap - 1);
    // the tail after the cap is reachable in a follow-up request
    check(&format!("bytes={}-", cap), cap, cap + cap - 1);
    check(&format!("bytes={}-", 2 * cap), 2 * cap, len - 1);

    // unsatisfiable → 416 with the resource size, empty body
    for bad in [
        format!("bytes={}-", len),
        format!("bytes={}-{}", len, len + 10),
        "bytes=5-4".to_string(),
        "bytes=-0".to_string(),
        "bytes=18446744073709551616-".to_string(),
        "garbage".to_string(),
        String::new(),
    ] {
        let s = v.serve(&p, Some(&bad));
        assert_eq!(s.status, 416, "{bad:?}");
        assert!(s.body.is_empty());
        assert_eq!(hdr(&s, "Content-Range"), Some(format!("bytes */{len}")), "{bad:?}");
    }

    // path handling: traversal, non-uuid, other extension, missing blob
    for path in [
        "/../vault.json",
        "/../../vault.json",
        "/vault.json",
        "/blobs/x.bin",
        "/00000000-0000-0000-0000-000000000000.png",
        "/not-a-uuid.png",
        "/",
        "",
        "/%2e%2e/vault.json",
    ] {
        let s = v.serve(path, None);
        assert_eq!(s.status, 404, "{path:?}");
        assert!(s.body.is_empty(), "{path:?}");
    }
    // A valid uuid followed by junk serves that blob (trailing segments are ignored),
    // never anything outside blobs/.
    let s = v.serve(&format!("/{}.bin/../../vault.json", b.id), None);
    assert!(s.status == 404 || (s.status == 200 && s.body == pt), "status {}", s.status);
    assert!(!contains(&s.body, b"argon2id"), "vault.json must never be served");
    // the extension in the URL is cosmetic; the type comes from the bytes
    let s = v.serve(&format!("/{}.mp4", b.id), Some("bytes=0-3"));
    assert_eq!(s.status, 206);
    assert_eq!(hdr(&s, "Content-Type").as_deref(), Some("image/png"));

    // full GET
    let s = v.serve(&p, None);
    assert_eq!(s.status, 200);
    assert_eq!(s.body, pt);
    assert_eq!(hdr(&s, "Content-Length"), Some(len.to_string()));
}

#[test]
fn deleting_an_item_removes_only_unshared_blobs_and_deleted_blobs_are_gone() {
    let (_d, v) = new_vault();
    let shared = v.seal_blob(b"shared start image", "jpg").unwrap();
    let m1 = v.seal_blob(b"media 1", "png").unwrap();
    let m2 = v.seal_blob(b"media 2", "png").unwrap();
    let mut a = sample_item(&m1, "a");
    a.init_image = Some(shared.clone());
    let mut b = sample_item(&m2, "b");
    b.init_image = Some(shared.clone());
    v.put_item(&a).unwrap();
    v.put_item(&b).unwrap();
    v.delete_item(&a.id).unwrap();
    assert!(!blob_file(&v, &m1.id).exists());
    assert!(!item_file(&v, &a.id).exists());
    assert!(blob_file(&v, &shared.id).exists(), "still referenced by b");
    assert!(v.open_blob(&m1.id).is_err());
    assert_eq!(v.serve(&format!("/{}", m1.id), None).status, 404);
    assert!(v.delete_item(&a.id).is_err(), "already gone");
    v.delete_item(&b.id).unwrap();
    assert!(!blob_file(&v, &shared.id).exists());
    assert!(v.items().unwrap().is_empty());
    // Bad ids never touch the filesystem.
    assert!(v.delete_blob("../vault.json").is_err());
    assert!(v.delete_blob("../../vault").is_err());
    assert!(v.open_blob("../vault.json").is_err());
    assert!(v.dir().join("vault.json").exists());
    let bad_item = VaultItem {
        id: "../escape".into(),
        ..sample_item(&m2, "x")
    };
    assert!(v.put_item(&bad_item).is_err());
    assert!(!v.dir().join("escape.bin").exists());
}
