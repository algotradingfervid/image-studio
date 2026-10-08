"""Resumable HTTPS downloads onto the network volume.

Spec ("Download"):
- plain HTTPS streaming (requests), never huggingface_hub or Xet;
- writes `<file>.part`, verifies size and sha256 when given, renames atomically;
- already present with the right size -> skipped;
- Authorization: Bearer HF_TOKEN for huggingface.co, CIVITAI_API_KEY for civitai.com;
- retries with Range resume when fewer than 100 KB arrive in 60 s, up to 10 times.

Redirects are followed manually so the Authorization header is sent only to
the host it belongs to: it is dropped as soon as a redirect leaves the
original host (HF -> cdn-lfs / Xet bridge, Civitai -> presigned S3/R2 URL).
Presigned URLs reject or leak extra credentials, so this matters.
"""

from __future__ import annotations

import hashlib
import os
import shutil
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable
from urllib.parse import urljoin, urlsplit

import requests
import urllib3

CHUNK = 1024 * 1024


def _chunks(resp: requests.Response):
    """Yields body bytes as soon as they arrive (read1), so a slow trickle is
    seen by the stall guard and a dropped connection loses no received data.
    Falls back to iter_content on urllib3 < 2."""
    raw = resp.raw
    if hasattr(raw, "read1"):
        while True:
            b = raw.read1(CHUNK)
            if not b:
                return
            yield b
    else:  # pragma: no cover
        yield from resp.iter_content(chunk_size=CHUNK)
MAX_REDIRECTS = 10


class DownloadError(RuntimeError):
    pass


class FatalDownloadError(DownloadError):
    """Not worth retrying (auth, not found, checksum mismatch, bad URL)."""


class _Stalled(DownloadError):
    pass


@dataclass
class DownloadConfig:
    stall_bytes: int = 100 * 1024       # fewer than this ...
    stall_seconds: float = 60.0         # ... within this window -> stalled
    max_retries: int = 10
    backoff_base: float = 2.0
    backoff_max: float = 60.0
    connect_timeout: float = 30.0
    allow_http: bool = False            # tests only (local server)
    sleep: Callable[[float], None] = time.sleep
    clock: Callable[[], float] = time.monotonic
    tokens: dict[str, str] = field(default_factory=dict)  # host -> token

    @classmethod
    def from_env(cls, **kw) -> "DownloadConfig":
        tokens = {}
        if os.environ.get("HF_TOKEN"):
            tokens["huggingface.co"] = os.environ["HF_TOKEN"]
        if os.environ.get("CIVITAI_API_KEY"):
            tokens["civitai.com"] = os.environ["CIVITAI_API_KEY"]
        kw.setdefault("tokens", tokens)
        kw.setdefault("allow_http", os.environ.get("IMAGE_STUDIO_ALLOW_HTTP") == "1")
        return cls(**kw)


def _host(url: str) -> str:
    return (urlsplit(url).hostname or "").lower()


def auth_header_for(url: str, tokens: dict[str, str]) -> dict[str, str]:
    """Bearer header for huggingface.co / civitai.com (and www. variants) only."""
    host = _host(url)
    for domain, token in tokens.items():
        if token and (host == domain or host == f"www.{domain}"):
            return {"Authorization": f"Bearer {token}"}
    return {}


def _check_scheme(url: str, cfg: DownloadConfig) -> None:
    scheme = urlsplit(url).scheme
    if scheme == "https" or (scheme == "http" and cfg.allow_http):
        return
    raise FatalDownloadError(f"UNSUPPORTED_URL: {url!r} (https only)")


def _open(session: requests.Session, url: str, offset: int,
          cfg: DownloadConfig) -> requests.Response:
    """GET with manual redirects; auth only while on the original host."""
    origin = _host(url)
    current = url
    for _ in range(MAX_REDIRECTS + 1):
        _check_scheme(current, cfg)
        headers = {"User-Agent": "image-studio-worker/1", "Accept-Encoding": "identity"}
        if _host(current) == origin:
            headers.update(auth_header_for(current, cfg.tokens))
        if offset > 0:
            headers["Range"] = f"bytes={offset}-"
        resp = session.get(current, headers=headers, stream=True, allow_redirects=False,
                           timeout=(cfg.connect_timeout, cfg.stall_seconds))
        if resp.is_redirect or resp.status_code in (301, 302, 303, 307, 308):
            loc = resp.headers.get("Location")
            resp.close()
            if not loc:
                raise DownloadError(f"redirect without Location from {current}")
            current = urljoin(current, loc)
            continue
        return resp
    raise FatalDownloadError(f"TOO_MANY_REDIRECTS: {url}")


def _hash_existing(path: Path) -> "hashlib._Hash":
    h = hashlib.sha256()
    with open(path, "rb") as fh:
        for chunk in iter(lambda: fh.read(CHUNK), b""):
            h.update(chunk)
    return h


def download_file(
    url: str,
    dest: Path,
    size: int | None = None,
    sha256: str | None = None,
    cfg: DownloadConfig | None = None,
    session: requests.Session | None = None,
    on_progress: Callable[[int, int | None], None] | None = None,
) -> bool:
    """Download `url` to `dest`. Returns False if skipped (already present).

    on_progress(bytes_done, total_or_None) is called after every chunk.
    """
    cfg = cfg or DownloadConfig.from_env()
    session = session or requests.Session()
    dest = Path(dest)
    _check_scheme(url, cfg)

    if dest.is_file() and (size is None or dest.stat().st_size == size):
        return False

    dest.parent.mkdir(parents=True, exist_ok=True)
    part = dest.with_name(dest.name + ".part")
    if size is not None:
        have = part.stat().st_size if part.exists() else 0
        free = shutil.disk_usage(dest.parent).free
        if size - have > free:
            raise FatalDownloadError(
                f"INSUFFICIENT_SPACE: {dest.name} needs {size - have} bytes, {free} free")

    attempt = 0
    while True:
        try:
            _attempt(url, part, size, cfg, session, on_progress)
            break
        except FatalDownloadError:
            raise
        except (_Stalled, DownloadError, requests.RequestException, OSError) as exc:
            attempt += 1
            if attempt > cfg.max_retries:
                raise DownloadError(
                    f"DOWNLOAD_FAILED: {dest.name}: gave up after {cfg.max_retries} retries: {exc}"
                ) from exc
            cfg.sleep(min(cfg.backoff_max, cfg.backoff_base ** (attempt - 1)))

    got = part.stat().st_size
    if size is not None and got != size:
        part.unlink(missing_ok=True)
        raise FatalDownloadError(f"SIZE_MISMATCH: {dest.name}: expected {size}, got {got}")
    if sha256:
        digest = _hash_existing(part).hexdigest()
        if digest.lower() != sha256.lower():
            part.unlink(missing_ok=True)
            raise FatalDownloadError(
                f"SHA256_MISMATCH: {dest.name}: expected {sha256.lower()}, got {digest}")
    with open(part, "rb") as fh:
        os.fsync(fh.fileno())
    os.replace(part, dest)
    return True


def _attempt(url: str, part: Path, size: int | None, cfg: DownloadConfig,
             session: requests.Session, on_progress) -> None:
    offset = part.stat().st_size if part.exists() else 0
    if size is not None and offset > size:
        part.unlink()
        offset = 0
    if size is not None and offset == size and offset > 0:
        return  # .part already complete (e.g. crash before rename)

    resp = _open(session, url, offset, cfg)
    with resp:
        status = resp.status_code
        if status == 416 and offset > 0:
            # Range not satisfiable: our .part is at/over the end. If the size
            # is unknown trust it; otherwise restart cleanly.
            if size is None:
                return
            part.unlink(missing_ok=True)
            raise DownloadError("HTTP 416, restarting from zero")
        if status in (401, 403):
            raise FatalDownloadError(
                f"HTTP_{status}: {url} (missing/invalid token or licence not accepted)")
        if status == 404:
            raise FatalDownloadError(f"HTTP_404: {url}")
        if status == 429 or status >= 500:
            raise DownloadError(f"HTTP {status}")
        if status not in (200, 206):
            raise FatalDownloadError(f"HTTP_{status}: {url}")

        if status == 200 and offset > 0:
            offset = 0  # server ignored Range: start over
        mode = "ab" if offset > 0 else "wb"
        total = size
        if total is None:
            cr = resp.headers.get("Content-Range", "")
            if "/" in cr and cr.rsplit("/", 1)[1].isdigit():
                total = int(cr.rsplit("/", 1)[1])
            elif resp.headers.get("Content-Length", "").isdigit():
                total = offset + int(resp.headers["Content-Length"])

        done = offset
        window_start = cfg.clock()
        window_bytes = 0
        with open(part, mode) as fh:
            try:
                for chunk in _chunks(resp):
                    if not chunk:
                        continue
                    fh.write(chunk)
                    done += len(chunk)
                    window_bytes += len(chunk)
                    if on_progress:
                        on_progress(done, total)
                    now = cfg.clock()
                    if now - window_start >= cfg.stall_seconds:
                        if window_bytes < cfg.stall_bytes:
                            raise _Stalled(
                                f"stalled: {window_bytes} B in {now - window_start:.0f}s")
                        window_start, window_bytes = now, 0
            except (requests.exceptions.ConnectionError,
                    requests.exceptions.ChunkedEncodingError,
                    requests.exceptions.Timeout,
                    urllib3.exceptions.HTTPError,
                    TimeoutError, ConnectionError) as exc:
                # A read timeout means no byte for stall_seconds: a stall.
                raise _Stalled(f"connection lost or stalled: {exc}") from exc
        if total is not None and done < total:
            raise DownloadError(f"short read: {done} of {total} bytes")
