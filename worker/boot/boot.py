#!/usr/bin/env python3
"""Image Studio container entrypoint for the runtime image (docs/spec.md "v4").

The runtime image (worker/Dockerfile.runtime) holds only Python, torch,
ComfyUI and the worker's third-party dependencies. The worker code itself
(worker/src/ + shared/models.json) is fetched from GitHub at every container
start, so a push to main reaches the next pod without an image rebuild.

Sequence:
  1. Download https://codeload.github.com/<WORKER_REPO>/tar.gz/<WORKER_REF>
     (default repo algotradingfervid/image-studio, ref "main"; a branch, tag or
     commit SHA), with a per-attempt deadline and 3 attempts.
  2. Check the tarball (one top-level dir, no absolute paths or "..", no
     links/devices among the files we take, required files present, models.json
     parses, every .py compiles), extract ONLY worker/src/** -> /app/src and
     shared/models.json -> /app/models.json, then import `handler` and `server`
     in a subprocess.
  3. On any failure use the copy baked into the image at build time
     (/app-baked, same layout) and say so loudly in the log.
  4. Write {source, ref, commit[, error]} to IMAGE_STUDIO_CODE_INFO for the pod
     server's GET /health (`code`).
  5. Start ComfyUI in the background on 127.0.0.1:8188 (the equivalent of the
     upstream worker-comfyui start.sh: tcmalloc LD_PRELOAD, --disable-auto-launch
     --disable-metadata --verbose $COMFY_LOG_LEVEL --log-stdout, PID in
     /tmp/comfyui.pid), with our extra_model_paths.yaml for /runpod-volume.
  6. exec `python -u <code>/src/handler.py`; its main() runs the pod server
     when MODE=pod and the RunPod serverless loop otherwise. The environment is
     passed through, plus PYTHONPATH / REGISTRY_PATH / IMAGE_STUDIO_CODE_INFO.

Standard library only, so it runs before anything else is trusted and is unit
tested in worker/tests/test_boot.py. `boot.py --check [dir]` validates a code
dir (default: the baked copy) without starting anything; the image build runs
it so a broken baked copy fails the build.
"""

from __future__ import annotations

import io
import json
import os
import re
import shlex
import shutil
import subprocess
import sys
import tarfile
import time
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass
from pathlib import Path, PurePosixPath
from typing import Any, Callable, Mapping

DEFAULT_REPO = "algotradingfervid/image-studio"
DEFAULT_REF = "main"
CODELOAD_URL = "https://codeload.github.com/{repo}/tar.gz/{ref}"

APP_DIR = "/app"
BAKED_DIR = "/app-baked"
COMFYUI_DIR = "/comfyui"
CODE_INFO_PATH = "/tmp/image_studio_code.json"
COMFY_PID_FILE = "/tmp/comfyui.pid"  # read by comfy_client._pid_alive
TCMALLOC_CANDIDATES = (
    "/usr/lib/x86_64-linux-gnu/libtcmalloc_minimal.so.4",
    "/usr/lib/x86_64-linux-gnu/libtcmalloc.so.4",
)

# Paths inside the repo tarball (below its single top-level dir) -> code dir.
SRC_PREFIX = "worker/src/"
REGISTRY_MEMBER = "shared/models.json"
# Relative to a code dir (/app or /app-baked).
REQUIRED_FILES = ("src/handler.py", "src/server.py", "src/extra_model_paths.yaml",
                  "models.json")

ATTEMPTS = 3
ATTEMPT_TIMEOUT_S = 20.0
BACKOFF_S = (1.0, 2.0)
MAX_TARBALL_BYTES = 64 * 1024 * 1024
MAX_FILE_BYTES = 16 * 1024 * 1024
IMPORT_CHECK_TIMEOUT_S = 120.0

_REF_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$")
_REPO_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9-]{0,38}/[A-Za-z0-9._-]{1,100}$")
SHA_RE = re.compile(r"^[0-9a-f]{40}$")

GPU_CHECK_SCRIPT = """
import torch
try:
    torch.cuda.init()
    name = torch.cuda.get_device_name(0)
    cap = torch.cuda.get_device_capability(0)
    _ = (torch.zeros(8, device='cuda') + 1).sum().item()
    torch.cuda.synchronize()
    print(f'image-studio-boot: GPU OK: {name} (sm_{cap[0]}{cap[1]}), torch {torch.__version__}, '
          f'cuda {torch.version.cuda}, arch list {torch.cuda.get_arch_list()}', flush=True)
except Exception as e:
    print(f'image-studio-boot: GPU CHECK FAILED: {e!r}. A "no kernel image is available" '
          f'error means this torch build lacks kernels for this GPU.', flush=True)
    raise SystemExit(1)
"""


class BootError(Exception):
    """The GitHub code can't be used; fall back to the baked copy."""


class TooLarge(BootError):
    """Not retried: the same URL will be just as large next time."""


def log(msg: str) -> None:
    print(f"image-studio-boot: {msg}", flush=True)


@dataclass
class CodeInfo:
    source: str          # "github" | "baked"
    ref: str             # the requested WORKER_REF
    commit: str | None   # resolved commit SHA, if known
    root: Path           # code dir: <root>/src/*.py, <root>/models.json
    error: str | None = None  # why GitHub code was not used (baked only)

    def public(self) -> dict[str, Any]:
        out: dict[str, Any] = {"source": self.source, "ref": self.ref, "commit": self.commit}
        if self.error:
            out["error"] = self.error
        return out


# ---------------------------------------------------------------------------
# download
# ---------------------------------------------------------------------------
def tarball_url(repo: str, ref: str) -> str:
    if not _REPO_RE.match(repo):
        raise BootError(f"invalid WORKER_REPO {repo!r}")
    if not _REF_RE.match(ref) or ".." in ref or "//" in ref or ref.endswith("/"):
        raise BootError(f"invalid WORKER_REF {ref!r}")
    return CODELOAD_URL.format(repo=repo, ref=urllib.parse.quote(ref, safe="/"))


def fetch(url: str, *, attempts: int = ATTEMPTS, timeout_s: float = ATTEMPT_TIMEOUT_S,
          backoff_s: tuple[float, ...] = BACKOFF_S,
          opener: Callable[..., Any] = urllib.request.urlopen,
          sleep: Callable[[float], None] = time.sleep,
          clock: Callable[[], float] = time.monotonic,
          max_bytes: int = MAX_TARBALL_BYTES) -> bytes:
    """GET `url` with up to `attempts` tries, each bounded by `timeout_s` in
    total (not just per socket operation). 404 is final (unknown ref)."""
    last: str = "no attempt made"
    for attempt in range(1, attempts + 1):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "image-studio-boot"})
            deadline = clock() + timeout_s
            with opener(req, timeout=timeout_s) as resp:
                status = getattr(resp, "status", None) or resp.getcode()
                if status != 200:
                    raise BootError(f"HTTP {status}")
                buf = bytearray()
                while True:
                    chunk = resp.read(256 * 1024)
                    if not chunk:
                        break
                    buf += chunk
                    if len(buf) > max_bytes:
                        raise TooLarge(f"tarball larger than {max_bytes} bytes")
                    if clock() > deadline:
                        raise TimeoutError(f"download took longer than {timeout_s:g} s")
                return bytes(buf)
        except urllib.error.HTTPError as e:
            if e.code == 404:
                raise BootError(f"HTTP 404 for {url} (unknown repo or WORKER_REF)") from None
            last = f"HTTP {e.code}"
        except TooLarge:
            raise
        except BootError as e:
            last = str(e)
        except (urllib.error.URLError, OSError, ValueError) as e:  # TimeoutError is an OSError
            last = f"{type(e).__name__}: {getattr(e, 'reason', None) or e}"
        log(f"download attempt {attempt}/{attempts} failed: {last}")
        if attempt < attempts:
            sleep(backoff_s[min(attempt - 1, len(backoff_s) - 1)] if backoff_s else 0)
    raise BootError(f"download failed after {attempts} attempts: {last}")


# ---------------------------------------------------------------------------
# tarball
# ---------------------------------------------------------------------------
def member_target(rel: str) -> str | None:
    """Repo-relative path -> path inside the code dir, or None to skip."""
    if rel == REGISTRY_MEMBER:
        return "models.json"
    if rel.startswith(SRC_PREFIX) and len(rel) > len(SRC_PREFIX):
        sub = rel[len(SRC_PREFIX):]
        parts = sub.split("/")
        if "__pycache__" in parts or sub.endswith(".pyc"):
            return None
        return "src/" + sub
    return None


def commit_from_tarball(tf: tarfile.TarFile, top: str) -> str | None:
    """GitHub archives are `git archive` output: the commit SHA is the pax
    global header's `comment`. With a SHA ref the top dir also ends in it
    (`image-studio-<sha>`); with a branch it is `image-studio-main`."""
    comment = (tf.pax_headers or {}).get("comment", "")
    if SHA_RE.match(comment):
        return comment
    m = re.search(r"-([0-9a-f]{40})$", top)
    return m.group(1) if m else None


def _safe_parts(name: str) -> tuple[str, ...]:
    if not name or name.startswith("/") or "\\" in name or "\x00" in name:
        raise BootError(f"unsafe path in tarball: {name!r}")
    parts = tuple(p for p in PurePosixPath(name).parts if p not in ("", "."))
    if ".." in parts or (parts and re.match(r"^[A-Za-z]:", parts[0])):
        raise BootError(f"unsafe path in tarball: {name!r}")
    return parts


def extract_code(data: bytes, dest: Path) -> tuple[str, str | None]:
    """Extract worker/src/** and shared/models.json from a GitHub tarball into
    `dest` (which must be empty). Returns (top-level dir, commit SHA or None).
    Raises BootError on anything unexpected; the caller discards `dest`."""
    try:
        tf = tarfile.open(fileobj=io.BytesIO(data), mode="r:gz")
        members = tf.getmembers()
    except (tarfile.TarError, OSError, EOFError, ValueError) as e:
        raise BootError(f"not a readable .tar.gz: {e}") from None
    if not members:
        raise BootError("empty tarball")
    dest = dest.resolve()
    top: str | None = None
    for m in members:
        parts = _safe_parts(m.name)
        if not parts:
            continue
        if top is None:
            top = parts[0]
        elif parts[0] != top:
            raise BootError(f"more than one top-level dir ({top!r}, {parts[0]!r})")
        target = member_target("/".join(parts[1:]))
        if target is None or m.isdir():
            continue
        if not m.isfile():  # symlink, hardlink, device, fifo
            raise BootError(f"{m.name}: not a regular file")
        if m.size > MAX_FILE_BYTES:
            raise BootError(f"{m.name}: {m.size} bytes is too large")
        out = (dest / target).resolve()
        if dest not in out.parents:
            raise BootError(f"{m.name}: escapes the destination")
        fh = tf.extractfile(m)
        if fh is None:
            raise BootError(f"{m.name}: unreadable")
        out.parent.mkdir(parents=True, exist_ok=True)
        out.write_bytes(fh.read())
    assert top is not None
    validate_code_dir(dest)
    return top, commit_from_tarball(tf, top)


def validate_code_dir(root: Path) -> None:
    """Required files present, models.json is JSON, every .py compiles."""
    missing = [f for f in REQUIRED_FILES if not (root / f).is_file()]
    if missing:
        raise BootError(f"missing in code: {', '.join(missing)}")
    try:
        json.loads((root / "models.json").read_text(encoding="utf-8"))
    except (OSError, ValueError) as e:
        raise BootError(f"models.json is not valid JSON: {e}") from None
    for py in sorted((root / "src").rglob("*.py")):
        try:
            compile(py.read_bytes(), str(py), "exec", dont_inherit=True)
        except (SyntaxError, ValueError) as e:
            raise BootError(f"{py.relative_to(root)} does not compile: {e}") from None


def import_check(root: Path, python: str = sys.executable,
                 timeout_s: float = IMPORT_CHECK_TIMEOUT_S,
                 env: Mapping[str, str] | None = None) -> None:
    """Import handler and server from `root` in a fresh interpreter."""
    child_env = dict(os.environ if env is None else env)
    child_env["PYTHONPATH"] = str(root / "src")
    child_env["REGISTRY_PATH"] = str(root / "models.json")
    child_env["MODE"] = ""  # never start anything
    try:
        p = subprocess.run([python, "-c", "import handler, server"], cwd=str(root / "src"),
                           env=child_env, capture_output=True, text=True, timeout=timeout_s)
    except subprocess.TimeoutExpired:
        raise BootError(f"importing handler/server took longer than {timeout_s:g} s") from None
    except OSError as e:
        raise BootError(f"could not run the import check: {e}") from None
    if p.returncode != 0:
        tail = (p.stderr or p.stdout).strip().splitlines()[-3:]
        raise BootError("import handler/server failed: " + " | ".join(tail))


# ---------------------------------------------------------------------------
# choose the code
# ---------------------------------------------------------------------------
def baked_commit(baked: Path) -> str | None:
    try:
        c = json.loads((baked / "BUILD_INFO.json").read_text()).get("commit")
    except (OSError, ValueError, AttributeError):
        return None
    return c if isinstance(c, str) and c and c != "unknown" else None


def prepare_code(env: Mapping[str, str], app_dir: Path, baked_dir: Path, *,
                 fetch_fn: Callable[[str], bytes] = fetch,
                 import_check_fn: Callable[[Path], None] = import_check) -> CodeInfo:
    """GitHub code in `app_dir`, or the baked copy on any failure."""
    ref = (env.get("WORKER_REF") or "").strip() or DEFAULT_REF
    repo = (env.get("WORKER_REPO") or "").strip() or DEFAULT_REPO
    staging = app_dir.with_name(app_dir.name + ".new")
    try:
        if (env.get("WORKER_CODE_SOURCE") or "").strip().lower() == "baked":
            raise BootError("WORKER_CODE_SOURCE=baked")
        url = tarball_url(repo, ref)
        log(f"fetching worker code: {url}")
        t0 = time.monotonic()
        data = fetch_fn(url)
        shutil.rmtree(staging, ignore_errors=True)
        staging.mkdir(parents=True)
        top, commit = extract_code(data, staging)
        if SHA_RE.match(ref) and commit and commit != ref:
            raise BootError(f"tarball commit {commit} does not match WORKER_REF {ref}")
        import_check_fn(staging)
        shutil.rmtree(app_dir, ignore_errors=True)
        staging.rename(app_dir)
        log(f"using GitHub code: repo {repo}, ref {ref}, commit {commit or 'unknown'} "
            f"({top}, {len(data)} bytes, {time.monotonic() - t0:.1f} s)")
        return CodeInfo("github", ref, commit, app_dir)
    except Exception as e:  # anything at all -> baked copy
        shutil.rmtree(staging, ignore_errors=True)
        reason = f"{type(e).__name__}: {e}" if not isinstance(e, BootError) else str(e)
        try:
            validate_code_dir(baked_dir)
        except BootError as be:
            raise SystemExit(f"image-studio-boot: FATAL: GitHub code unusable ({reason}) "
                             f"and the baked copy is broken ({be})") from None
        commit = baked_commit(baked_dir)
        log("=" * 72)
        log(f"FALLBACK: GitHub code not used ({reason}).")
        log(f"Running the BAKED copy from the image build (commit {commit or 'unknown'}); "
            f"it may be older than {ref}.")
        log("=" * 72)
        return CodeInfo("baked", ref, commit, baked_dir, error=reason)


def write_code_info(path: Path, info: CodeInfo) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(path.name + ".tmp")
    tmp.write_text(json.dumps(info.public()))
    tmp.replace(path)


# ---------------------------------------------------------------------------
# processes
# ---------------------------------------------------------------------------
def tcmalloc_env(env: dict[str, str], candidates: tuple[str, ...] = TCMALLOC_CANDIDATES
                 ) -> dict[str, str]:
    """Upstream start.sh preloads tcmalloc (better RAM behaviour with big
    models). An LD_PRELOAD already set by the operator wins."""
    if env.get("LD_PRELOAD"):
        return env
    for lib in candidates:
        if os.path.exists(lib):
            env["LD_PRELOAD"] = lib
            break
    return env


def comfy_command(python: str, comfy_dir: str, info: CodeInfo,
                  env: Mapping[str, str]) -> list[str]:
    level = (env.get("COMFY_LOG_LEVEL") or "DEBUG").strip()
    cmd = [python, "-u", f"{comfy_dir}/main.py",
           "--disable-auto-launch", "--disable-metadata",
           "--listen", "127.0.0.1", "--port", "8188",
           "--extra-model-paths-config", str(info.root / "src" / "extra_model_paths.yaml"),
           "--verbose", level, "--log-stdout"]
    return cmd + shlex.split(env.get("COMFY_EXTRA_ARGS") or "")


def handler_env(env: Mapping[str, str], info: CodeInfo, code_info_path: str,
                comfy_dir: str) -> dict[str, str]:
    out = dict(env)
    src = str(info.root / "src")
    out["PYTHONPATH"] = src + (os.pathsep + env["PYTHONPATH"] if env.get("PYTHONPATH") else "")
    out["REGISTRY_PATH"] = str(info.root / "models.json")
    out["IMAGE_STUDIO_CODE_INFO"] = code_info_path
    out.setdefault("VOLUME_ROOT", "/runpod-volume")
    out.setdefault("COMFYUI_PATH", comfy_dir)
    return out


@dataclass
class Paths:
    app: Path
    baked: Path
    comfy: str
    code_info: str
    pid_file: str

    @classmethod
    def from_env(cls, env: Mapping[str, str]) -> "Paths":
        return cls(app=Path(env.get("BOOT_APP_DIR") or APP_DIR),
                   baked=Path(env.get("BOOT_BAKED_DIR") or BAKED_DIR),
                   comfy=env.get("COMFYUI_PATH") or COMFYUI_DIR,
                   code_info=env.get("IMAGE_STUDIO_CODE_INFO") or CODE_INFO_PATH,
                   pid_file=env.get("BOOT_COMFY_PID_FILE") or COMFY_PID_FILE)


def run(env: Mapping[str, str], *, python: str = sys.executable,
        prepare: Callable[..., CodeInfo] = prepare_code,
        popen: Callable[..., Any] = subprocess.Popen,
        execve: Callable[[str, list[str], dict[str, str]], Any] = os.execve) -> None:
    paths = Paths.from_env(env)
    info = prepare(env, paths.app, paths.baked)
    write_code_info(Path(paths.code_info), info)

    base = tcmalloc_env(dict(env))
    comfy_env = dict(base)  # no PYTHONPATH change: our server.py must not shadow ComfyUI's
    cmd = comfy_command(python, paths.comfy, info, base)
    log("starting ComfyUI: " + " ".join(shlex.quote(c) for c in cmd))
    proc = popen(cmd, cwd=paths.comfy, env=comfy_env)
    Path(paths.pid_file).write_text(f"{proc.pid}\n")

    if (env.get("GPU_CHECK") or "1").strip() != "0":
        # Diagnostic only, in parallel with ComfyUI's own startup.
        popen([python, "-c", GPU_CHECK_SCRIPT], env=comfy_env)

    henv = handler_env(base, info, paths.code_info, paths.comfy)
    handler = str(info.root / "src" / "handler.py")
    mode = "pod server" if (env.get("MODE") or "").strip().lower() == "pod" else "serverless"
    log(f"starting handler ({mode}) from {info.source} code, commit {info.commit or 'unknown'}")
    execve(python, [python, "-u", handler], henv)


def check(root: Path) -> int:
    """`boot.py --check [dir]`: validate a code dir and import it."""
    try:
        validate_code_dir(root)
        import_check(root)
    except BootError as e:
        log(f"check FAILED for {root}: {e}")
        return 1
    log(f"check OK for {root} (commit {baked_commit(root) or 'unknown'})")
    return 0


def main(argv: list[str] | None = None) -> None:
    argv = sys.argv[1:] if argv is None else argv
    if argv and argv[0] == "--check":
        sys.exit(check(Path(argv[1] if len(argv) > 1 else BAKED_DIR)))
    run(os.environ)


if __name__ == "__main__":
    main()
