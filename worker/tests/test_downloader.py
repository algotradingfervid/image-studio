"""Download manager against a local HTTP server (tests/conftest.py FileServer)."""

from __future__ import annotations

import hashlib
import os

import pytest

from downloader import (DownloadConfig, DownloadError, FatalDownloadError, auth_header_for,
                        download_file)

DATA = os.urandom(3 * 1024 * 1024 + 123)
SHA = hashlib.sha256(DATA).hexdigest()


def cfg(**kw):
    kw.setdefault("allow_http", True)
    kw.setdefault("sleep", lambda s: None)
    kw.setdefault("stall_seconds", 2.0)
    kw.setdefault("tokens", {})
    return DownloadConfig(**kw)


def test_plain_download_verifies_and_renames(file_server, tmp_path):
    file_server.add("/f", DATA)
    dest = tmp_path / "unet" / "m.safetensors"
    seen = []
    assert download_file(file_server.url("/f"), dest, len(DATA), SHA, cfg=cfg(),
                         on_progress=lambda b, t: seen.append((b, t))) is True
    assert dest.read_bytes() == DATA
    assert not dest.with_name("m.safetensors.part").exists()
    assert seen[-1] == (len(DATA), len(DATA))
    assert all(a[0] <= b[0] for a, b in zip(seen, seen[1:]))


def test_skip_when_present_with_right_size(file_server, tmp_path):
    dest = tmp_path / "m.safetensors"
    dest.write_bytes(DATA)
    assert download_file(file_server.url("/missing"), dest, len(DATA), SHA, cfg=cfg()) is False
    assert file_server.requests == []


def test_redownload_when_size_differs(file_server, tmp_path):
    file_server.add("/f", DATA)
    dest = tmp_path / "m.safetensors"
    dest.write_bytes(b"short")
    assert download_file(file_server.url("/f"), dest, len(DATA), SHA, cfg=cfg()) is True
    assert dest.read_bytes() == DATA


def test_resume_after_connection_drop(file_server, tmp_path):
    file_server.add("/f", DATA, drop_after=1024 * 1024)
    dest = tmp_path / "m.safetensors"
    assert download_file(file_server.url("/f"), dest, len(DATA), SHA, cfg=cfg())
    assert dest.read_bytes() == DATA
    reqs = file_server.requests_for("/f")
    assert len(reqs) == 2
    assert "Range" not in reqs[0]["headers"]
    start = int(reqs[1]["headers"]["Range"].split("=")[1].rstrip("-"))
    assert 0 < start <= 1024 * 1024


def test_resume_from_existing_part_file(file_server, tmp_path):
    file_server.add("/f", DATA)
    dest = tmp_path / "m.safetensors"
    dest.with_name("m.safetensors.part").write_bytes(DATA[:500_000])
    assert download_file(file_server.url("/f"), dest, len(DATA), SHA, cfg=cfg())
    assert dest.read_bytes() == DATA
    assert file_server.requests_for("/f")[0]["headers"]["Range"] == "bytes=500000-"


def test_server_ignoring_range_restarts_cleanly(file_server, tmp_path):
    file_server.add("/f", DATA, ignore_range=True)
    dest = tmp_path / "m.safetensors"
    dest.with_name("m.safetensors.part").write_bytes(DATA[:1000])
    assert download_file(file_server.url("/f"), dest, len(DATA), SHA, cfg=cfg())
    assert dest.read_bytes() == DATA


def test_sha_mismatch_fails_and_removes_part(file_server, tmp_path):
    file_server.add("/f", DATA)
    dest = tmp_path / "m.safetensors"
    with pytest.raises(FatalDownloadError, match="SHA256_MISMATCH"):
        download_file(file_server.url("/f"), dest, len(DATA), "0" * 64, cfg=cfg())
    assert not dest.exists()
    assert not dest.with_name("m.safetensors.part").exists()
    assert len(file_server.requests_for("/f")) == 1  # not retried


def test_size_mismatch_fails(file_server, tmp_path):
    file_server.add("/f", DATA)
    dest = tmp_path / "m.safetensors"
    with pytest.raises(DownloadError):
        download_file(file_server.url("/f"), dest, len(DATA) + 10, None, cfg=cfg(max_retries=1))
    assert not dest.exists()


def test_stall_total_silence_retries_with_range(file_server, tmp_path):
    # 200 KB then silence longer than the stall window -> read timeout -> resume.
    file_server.add("/f", DATA, stall_after=200 * 1024, stall_for=3.0)
    dest = tmp_path / "m.safetensors"
    assert download_file(file_server.url("/f"), dest, len(DATA), SHA,
                         cfg=cfg(stall_seconds=0.5))
    assert dest.read_bytes() == DATA
    reqs = file_server.requests_for("/f")
    assert len(reqs) == 2 and reqs[1]["headers"]["Range"].startswith("bytes=")


def test_stall_trickle_below_threshold_retries(file_server, tmp_path):
    # Bytes keep arriving (no read timeout) but far below 100 KB per window.
    small = DATA[:300_000]
    file_server.add("/f", small, trickle=(1024, 0.05))
    dest = tmp_path / "m.safetensors"
    assert download_file(file_server.url("/f"), dest, len(small),
                         hashlib.sha256(small).hexdigest(), cfg=cfg(stall_seconds=0.4))
    assert dest.read_bytes() == small
    assert len(file_server.requests_for("/f")) == 2


def test_gives_up_after_max_retries(file_server, tmp_path):
    file_server.add("/f", DATA, drop_after=10, drop_times=99)
    sleeps = []
    dest = tmp_path / "m.safetensors"
    with pytest.raises(DownloadError, match="gave up after 10 retries"):
        download_file(file_server.url("/f"), dest, len(DATA), SHA,
                      cfg=cfg(sleep=sleeps.append))
    assert len(file_server.requests_for("/f")) == 11
    assert sleeps == [1, 2, 4, 8, 16, 32, 60, 60, 60, 60]  # exponential, capped


def test_server_errors_are_retried(file_server, tmp_path):
    file_server.add("/f", DATA)
    file_server.behaviours["/f"] = {}
    calls = {"n": 0}
    original = file_server.behaviours

    # first request 503, then OK
    class Once(dict):
        def get(self, k, d=None):
            if k == "/f":
                calls["n"] += 1
                return {"status": 503} if calls["n"] == 1 else {}
            return original.get(k, d)

    file_server.behaviours = Once()
    dest = tmp_path / "m.safetensors"
    assert download_file(file_server.url("/f"), dest, len(DATA), SHA, cfg=cfg())
    assert calls["n"] == 2


@pytest.mark.parametrize("status", [401, 403, 404])
def test_auth_and_not_found_fail_fast(file_server, tmp_path, status):
    file_server.add("/f", DATA, status=status)
    with pytest.raises(FatalDownloadError, match=f"HTTP_{status}"):
        download_file(file_server.url("/f"), tmp_path / "m.safetensors", None, None, cfg=cfg())
    assert len(file_server.requests_for("/f")) == 1


def test_https_only_by_default(tmp_path):
    with pytest.raises(FatalDownloadError, match="https only"):
        download_file("http://example.com/x", tmp_path / "m.safetensors", None, None,
                      cfg=DownloadConfig(tokens={}))
    with pytest.raises(FatalDownloadError):
        download_file("file:///etc/passwd", tmp_path / "m.safetensors", None, None, cfg=cfg())


def test_unknown_size_uses_content_length(file_server, tmp_path):
    file_server.add("/f", DATA)
    seen = []
    dest = tmp_path / "m.safetensors"
    assert download_file(file_server.url("/f"), dest, None, None, cfg=cfg(),
                         on_progress=lambda b, t: seen.append(t))
    assert set(seen) == {len(DATA)}


# --------------------------------------------------------------------------- auth
def test_auth_header_per_host():
    tokens = {"huggingface.co": "hf_x", "civitai.com": "cv_y"}
    assert auth_header_for("https://huggingface.co/a/resolve/main/b", tokens) == {
        "Authorization": "Bearer hf_x"}
    assert auth_header_for("https://civitai.com/api/download/models/1", tokens) == {
        "Authorization": "Bearer cv_y"}
    assert auth_header_for("https://www.civitai.com/x", tokens) == {"Authorization": "Bearer cv_y"}
    assert auth_header_for("https://cdn-lfs.huggingface.co/x", tokens) == {}
    assert auth_header_for("https://huggingface.co.evil.com/x", tokens) == {}
    assert auth_header_for("https://evilhuggingface.co/x", tokens) == {}
    assert auth_header_for("https://example.com/x", tokens) == {}
    assert auth_header_for("https://huggingface.co/x", {"huggingface.co": ""}) == {}


def test_from_env(monkeypatch):
    monkeypatch.setenv("HF_TOKEN", "hf_env")
    monkeypatch.setenv("CIVITAI_API_KEY", "cv_env")
    c = DownloadConfig.from_env()
    assert c.tokens == {"huggingface.co": "hf_env", "civitai.com": "cv_env"}
    monkeypatch.delenv("HF_TOKEN")
    assert "huggingface.co" not in DownloadConfig.from_env().tokens


def test_auth_sent_to_matching_host_only(file_server, tmp_path):
    file_server.add("/f", DATA)
    file_server.add("/g", DATA)
    c = cfg(tokens={"127.0.0.1": "secret-a", "localhost": "secret-b"})
    download_file(file_server.url("/f"), tmp_path / "a.safetensors", len(DATA), SHA, cfg=c)
    download_file(file_server.url("/g", host="localhost"), tmp_path / "b.safetensors",
                  len(DATA), SHA, cfg=c)
    assert file_server.requests_for("/f")[0]["headers"]["Authorization"] == "Bearer secret-a"
    assert file_server.requests_for("/g")[0]["headers"]["Authorization"] == "Bearer secret-b"


def test_auth_dropped_on_cross_host_redirect(file_server, tmp_path):
    # 127.0.0.1 (token holder, like huggingface.co) -> localhost (like a CDN /
    # presigned S3 URL): the second hop must not carry the Authorization header.
    file_server.add("/blob", DATA)
    file_server.add("/resolve", b"", redirect=file_server.url("/blob", host="localhost"))
    c = cfg(tokens={"127.0.0.1": "secret"})
    dest = tmp_path / "m.safetensors"
    assert download_file(file_server.url("/resolve"), dest, len(DATA), SHA, cfg=c)
    assert dest.read_bytes() == DATA
    first = file_server.requests_for("/resolve")[0]["headers"]
    hop = file_server.requests_for("/blob")[0]["headers"]
    assert first["Authorization"] == "Bearer secret"
    assert "Authorization" not in hop


def test_auth_dropped_even_if_redirect_target_has_its_own_token(file_server, tmp_path):
    # Never forward or swap credentials across hosts mid-redirect.
    file_server.add("/blob", DATA)
    file_server.add("/resolve", b"", redirect=file_server.url("/blob", host="localhost"))
    c = cfg(tokens={"127.0.0.1": "secret", "localhost": "other"})
    download_file(file_server.url("/resolve"), tmp_path / "m.safetensors", len(DATA), SHA, cfg=c)
    assert "Authorization" not in file_server.requests_for("/blob")[0]["headers"]


def test_auth_kept_on_same_host_relative_redirect(file_server, tmp_path):
    file_server.add("/blob", DATA)
    file_server.add("/resolve", b"", redirect="/blob")
    c = cfg(tokens={"127.0.0.1": "secret"})
    download_file(file_server.url("/resolve"), tmp_path / "m.safetensors", len(DATA), SHA, cfg=c)
    assert file_server.requests_for("/blob")[0]["headers"]["Authorization"] == "Bearer secret"


def test_resume_after_redirect_keeps_range_and_drops_auth(file_server, tmp_path):
    file_server.add("/blob", DATA, drop_after=700_000)
    file_server.add("/resolve", b"", redirect=file_server.url("/blob", host="localhost"))
    c = cfg(tokens={"127.0.0.1": "secret"})
    dest = tmp_path / "m.safetensors"
    assert download_file(file_server.url("/resolve"), dest, len(DATA), SHA, cfg=c)
    assert dest.read_bytes() == DATA
    resolves = file_server.requests_for("/resolve")
    blobs = file_server.requests_for("/blob")
    assert len(resolves) == 2 and len(blobs) == 2  # retry restarts at the origin URL
    assert all(r["headers"]["Authorization"] == "Bearer secret" for r in resolves)
    assert all("Authorization" not in b["headers"] for b in blobs)
    assert blobs[1]["headers"]["Range"].startswith("bytes=")


def test_redirect_loop(file_server, tmp_path):
    file_server.add("/loop", b"", redirect="/loop")
    with pytest.raises(FatalDownloadError, match="TOO_MANY_REDIRECTS"):
        download_file(file_server.url("/loop"), tmp_path / "m.safetensors", None, None, cfg=cfg())
