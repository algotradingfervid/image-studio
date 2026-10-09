"""Local copies of model weights on the pod's container disk (pod mode only).

Why: ComfyUI v0.39.0 loads weights lazily during the first forward pass with
small blocking reads. On the RunPod network volume that ran at 30-150 MB/s, so
a first MiniMax H3 video (~54 GB of weights) spent most of its time loading.
Reading the same files with many parallel large reads is much faster, and once
the weights are on the local disk ComfyUI's own reads are fast too.

How it is wired:
  * extra_model_paths.yaml lists /models-local before /runpod-volume/models
    (`is_default: true`). ComfyUI's folder_paths.get_full_path returns the
    first folder where the file exists, so a finished local copy wins and a
    missing one (still copying, failed, skipped) falls back to the volume.
    Files appear under their final name only after a complete, size-checked
    copy (written to `<name>.<random>.part`, renamed when complete), and
    ComfyUI ignores `.part` names (not a model extension).
  * One copier thread copies one file at a time, each with `threads`
    concurrent os.pread / os.pwrite calls of `chunk` bytes. Order per model:
    text encoder (clip), unet, then VAEs and the rest.
  * server.py creates the manager (init_from_env) and requests the
    PREFETCH_MODELS at boot; handler.py requests a job's model on demand and
    waits for it (stage "copying_models"). A copy that fails, is skipped for
    lack of space or runs past LOCAL_COPY_WAIT_S never fails the job: the job
    just loads that file from the volume.

Environment:
  LOCAL_MODELS=0           disable (default: on in MODE=pod)
  LOCAL_MODELS_ROOT        default /models-local
  LOCAL_COPY_THREADS       default 16 (1-64)
  LOCAL_COPY_CHUNK_MB      default 64
  LOCAL_COPY_RESERVE_GB    free space kept on the container disk, default 4
  LOCAL_COPY_WAIT_S        longest a job waits for its copies, default 1800
  PREFETCH_MODELS          comma-separated model ids copied right after boot
"""

from __future__ import annotations

import errno
import logging
import os
import shutil
import threading
import time
import uuid
from concurrent.futures import FIRST_EXCEPTION, ThreadPoolExecutor, wait
from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable, Iterable, Mapping

log = logging.getLogger("image_studio.local_models")

MiB = 1024 * 1024
GiB = 1024 * MiB
PART_SUFFIX = ".part"
MAX_ATTEMPTS = 2           # a failed file is retried once, on a later request
# Copy order within a model: text encoder first (it runs first), then the
# diffusion model, then VAEs / upscalers.
FOLDER_RANK = {"clip": 0, "unet": 1, "vae": 2, "latent_upscale_models": 3}

PENDING, COPYING, DONE = "pending", "copying", "done"
FAILED, SKIPPED, MISSING, IDLE = "failed", "skipped", "missing", "idle"
TERMINAL = frozenset({DONE, FAILED, SKIPPED, MISSING})


def _env_int(env: Mapping[str, str], key: str, default: int, lo: int, hi: int) -> int:
    try:
        v = int(str(env.get(key, "")).strip() or default)
    except ValueError:
        v = default
    return max(lo, min(hi, v))


def _env_float(env: Mapping[str, str], key: str, default: float) -> float:
    try:
        return float(str(env.get(key, "")).strip() or default)
    except ValueError:
        return default


def default_source_root(env: Mapping[str, str] = os.environ) -> Path:
    vol = env.get("VOLUME_ROOT") or "/runpod-volume"
    return Path(env.get("MODELS_ROOT") or f"{vol}/models")


# ---------------------------------------------------------------------------
# one file
# ---------------------------------------------------------------------------
class CopyError(Exception):
    pass


class CopyCancelled(CopyError):
    pass


def _preallocate(fd: int, size: int) -> None:
    """Reserve the blocks up front so a full disk fails at once (ENOSPC)
    instead of after tens of GB. Falls back to a sparse ftruncate where
    fallocate is not supported (macOS, some overlay setups)."""
    fallocate = getattr(os, "posix_fallocate", None)
    if fallocate is not None:
        try:
            fallocate(fd, 0, size)
            return
        except OSError as e:
            if e.errno == errno.ENOSPC:
                raise
    os.ftruncate(fd, size)


def copy_file(src: Path, dst: Path, *, threads: int = 16, chunk: int = 64 * MiB,
              on_bytes: Callable[[int], None] | None = None,
              cancel: threading.Event | None = None) -> int:
    """Copies `src` to `dst` with `threads` parallel pread/pwrite calls of
    `chunk` bytes. Writes `<dst>.<random>.part` and renames it to `dst` only
    after every range is written and the size matches the source (a sha256
    would read the file a second time, doubling the cost, so it is skipped).
    Two concurrent calls for the same dst each write their own part file; the
    last rename wins with identical content. Returns the bytes copied.
    Raises CopyError / OSError; the part file is always removed on failure."""
    src_fd = os.open(src, os.O_RDONLY)
    try:
        size = os.fstat(src_fd).st_size
        dst.parent.mkdir(parents=True, exist_ok=True)
        part = dst.with_name(f"{dst.name}.{uuid.uuid4().hex[:8]}{PART_SUFFIX}")
        out_fd = os.open(part, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o644)
        out_open, ok = True, False
        try:
            if size:
                _preallocate(out_fd, size)
            stop = threading.Event()

            def one(off: int, n: int) -> int:
                got = 0
                while got < n:
                    if stop.is_set() or (cancel is not None and cancel.is_set()):
                        raise CopyCancelled("cancelled")
                    data = os.pread(src_fd, n - got, off + got)
                    if not data:
                        raise CopyError(f"source ended early at byte {off + got} of {size}")
                    view, w = memoryview(data), 0
                    while w < len(view):
                        w += os.pwrite(out_fd, view[w:], off + got + w)
                    got += len(data)
                    if on_bytes is not None:
                        on_bytes(len(data))
                return got

            ranges = [(off, min(chunk, size - off)) for off in range(0, size, chunk)]
            written = 0
            if ranges:
                with ThreadPoolExecutor(max_workers=max(1, min(threads, len(ranges))),
                                        thread_name_prefix="copy") as pool:
                    futs = [pool.submit(one, off, n) for off, n in ranges]
                    done, _ = wait(futs, return_when=FIRST_EXCEPTION)
                    if any(f.exception() is not None for f in done):
                        stop.set()  # the remaining ranges bail out at once
                    wait(futs)
                    errors = [f.exception() for f in futs if f.exception() is not None]
                    if errors:
                        real = [e for e in errors if not isinstance(e, CopyCancelled)]
                        raise (real or errors)[0]
                    written = sum(f.result() for f in futs)
            if cancel is not None and cancel.is_set():
                raise CopyCancelled("cancelled")
            got_size = os.fstat(out_fd).st_size
            if written != size or got_size != size:
                raise CopyError(f"size mismatch: wrote {written} bytes, file has {got_size}, "
                                f"source has {size}")
            if os.stat(src).st_size != size:
                raise CopyError("source changed size during the copy")
            os.close(out_fd)
            out_open = False
            os.replace(part, dst)
            ok = True
            return written
        finally:
            if out_open:
                os.close(out_fd)
            if not ok:
                try:
                    part.unlink()
                except OSError:
                    pass
    finally:
        os.close(src_fd)


def remove_stale_parts(root: Path) -> int:
    """Deletes leftover `*.part` files (a copy killed by a restart)."""
    n = 0
    if not root.is_dir():
        return 0
    for p in root.rglob(f"*{PART_SUFFIX}"):
        try:
            p.unlink()
            n += 1
        except OSError:
            pass
    return n


# ---------------------------------------------------------------------------
# state
# ---------------------------------------------------------------------------
@dataclass
class FileCopy:
    folder: str
    filename: str
    src: Path
    dst: Path
    total: int = 0
    done: int = 0             # bytes in place locally (copied or already there)
    copied: int = 0           # bytes actually copied by this process
    state: str = IDLE
    error: str | None = None
    started: float | None = None
    finished: float | None = None
    attempts: int = 0
    preempted: bool = False
    event: threading.Event = field(default_factory=threading.Event)   # set when terminal
    cancel: threading.Event = field(default_factory=threading.Event)

    @property
    def key(self) -> tuple[str, str]:
        return self.folder, self.filename

    def seconds(self, now: float) -> float:
        if self.started is None:
            return 0.0
        return max(0.0, (self.finished if self.finished is not None else now) - self.started)

    def mbps(self, now: float) -> float:
        s = self.seconds(now)
        return round(self.copied / 1e6 / s, 1) if s > 0 and self.copied else 0.0

    def view(self, now: float) -> dict:
        out = {"folder": self.folder, "filename": self.filename, "state": self.state,
               "doneBytes": self.done, "totalBytes": self.total, "MBps": self.mbps(now)}
        if self.error:
            out["error"] = self.error
        return out


def _model_state(states: set[str]) -> str:
    for s in (COPYING, PENDING, FAILED, SKIPPED, MISSING, IDLE):
        if s in states:
            return {PENDING: "queued"}.get(s, s)
    return DONE


class LocalModels:
    """Copies registry models from `src_root` to `dst_root`, one file at a
    time on one background thread. Thread-safe; every public method is cheap
    except wait()."""

    def __init__(self, registry: Callable[[], dict], src_root: Path, dst_root: Path, *,
                 threads: int = 16, chunk: int = 64 * MiB, reserve: int = 4 * GiB,
                 disk_usage: Callable[[Path], object] = shutil.disk_usage,
                 copy: Callable[..., int] = copy_file,
                 clock: Callable[[], float] = time.monotonic):
        self.registry = registry
        self.src_root = Path(src_root)
        self.dst_root = Path(dst_root)
        self.threads = threads
        self.chunk = chunk
        self.reserve = reserve
        self.disk_usage = disk_usage
        self.copy = copy
        self.clock = clock
        self.lock = threading.Condition()
        self.files: dict[tuple[str, str], FileCopy] = {}
        self.models: dict[str, list[tuple[str, str]]] = {}
        self.queue: list[tuple[str, str]] = []
        self.current: FileCopy | None = None
        self._thread: threading.Thread | None = None
        self._closed = False

    # ---- registry -----------------------------------------------------------
    def model_files(self, model_id: str) -> list[dict] | None:
        reg = self.registry()
        for m in list(reg.get("models", [])) + list(reg.get("videoModels", [])):
            if m.get("id") == model_id:
                files = [f for f in m.get("files", []) if f.get("folder") and f.get("filename")]
                return sorted(files, key=lambda f: FOLDER_RANK.get(f["folder"], 9))
        return None

    # ---- requests -----------------------------------------------------------
    def request(self, model_id: str, front: bool = False) -> list[FileCopy] | None:
        """Queues every file of `model_id` that isn't local yet and returns
        the model's entries (shared with any other request for the same
        file). `front` (a real job): its files go to the head of the queue and
        an in-flight copy of a file it doesn't need is preempted (requeued).
        None for an unknown model id."""
        files = self.model_files(model_id)
        if files is None:
            log.warning("local copy: unknown model %r; ignored", model_id)
            return None
        with self.lock:
            entries: list[FileCopy] = []
            for f in files:
                key = (f["folder"], f["filename"])
                fc = self.files.get(key)
                if fc is None:
                    fc = FileCopy(f["folder"], f["filename"],
                                  self.src_root / f["folder"] / f["filename"],
                                  self.dst_root / f["folder"] / f["filename"],
                                  total=int(f.get("sizeBytes") or 0))
                    self.files[key] = fc
                retry = (fc.state == IDLE or fc.state in (SKIPPED, MISSING)
                         or (fc.state == FAILED and fc.attempts < MAX_ATTEMPTS))
                if retry:
                    fc.state, fc.error, fc.finished = PENDING, None, None
                    fc.event = threading.Event()
                    fc.cancel = threading.Event()
                if fc.state == PENDING and key not in self.queue:
                    self.queue.append(key)
                entries.append(fc)
            keys = [fc.key for fc in entries]
            self.models[model_id] = keys
            if front:
                mine = [k for k in keys if k in self.queue]
                self.queue = mine + [k for k in self.queue if k not in mine]
                cur = self.current
                if cur is not None and cur.key not in keys and cur.state == COPYING:
                    log.info("local copy: pausing %s/%s for %s (a job needs it now)",
                             cur.folder, cur.filename, model_id)
                    cur.preempted = True
                    cur.cancel.set()
            self._ensure_thread()
            self.lock.notify_all()
        self._log_space(model_id, entries)
        return entries

    def _log_space(self, model_id: str, entries: list[FileCopy]) -> None:
        need = sum(e.total for e in entries if e.state in (PENDING, COPYING))
        if not need:
            return
        try:
            free = self.disk_usage(self.dst_root).free
        except OSError:
            return
        if free < need + self.reserve:
            log.warning("local copy: %s needs %.1f GB but %s has %.1f GB free (%.0f GB kept "
                        "spare); files that don't fit load from the network volume",
                        model_id, need / 1e9, self.dst_root, free / 1e9, self.reserve / 1e9)

    def invalidate(self, folder: str, filename: str) -> None:
        """The volume's file changed (download) or went away (delete): drop
        the local copy so it can't shadow the new content."""
        key = (folder, filename)
        with self.lock:
            fc = self.files.get(key)
            if fc is not None:
                fc.cancel.set()
                if key in self.queue:
                    self.queue.remove(key)
                if not fc.event.is_set():
                    fc.state, fc.error = FAILED, "invalidated"
                    fc.event.set()
                fresh = FileCopy(folder, filename, fc.src, fc.dst, total=fc.total)
                self.files[key] = fresh
            dst = self.dst_root / folder / filename
        try:
            dst.unlink()
        except FileNotFoundError:
            pass
        except OSError as e:
            log.warning("local copy: could not remove %s: %s", dst, e)

    # ---- worker -------------------------------------------------------------
    def _ensure_thread(self) -> None:
        if self._thread is None or not self._thread.is_alive():
            self._thread = threading.Thread(target=self._run, name="local-copy", daemon=True)
            self._thread.start()

    def close(self) -> None:
        with self.lock:
            self._closed = True
            if self.current is not None:
                self.current.cancel.set()
            self.lock.notify_all()

    def _run(self) -> None:
        while True:
            with self.lock:
                while not self.queue and not self._closed:
                    self.lock.wait()
                if self._closed:
                    return
                key = self.queue.pop(0)
                fc = self.files.get(key)
                if fc is None or fc.state != PENDING:
                    continue
                fc.state, fc.started, fc.finished = COPYING, self.clock(), None
                fc.done = fc.copied = 0
                fc.attempts += 1
                fc.preempted = False
                self.current = fc
            try:
                self._copy_one(fc)
            except Exception as e:  # never let the copier thread die
                log.exception("local copy: unexpected error")
                self._finish(fc, FAILED, f"{type(e).__name__}: {e}")
            finally:
                with self.lock:
                    self.current = None

    def _finish(self, fc: FileCopy, state: str, error: str | None = None) -> None:
        with self.lock:
            if fc.event.is_set():   # invalidated meanwhile
                return
            fc.state, fc.error, fc.finished = state, error, self.clock()
            fc.event.set()
            self.lock.notify_all()

    def _copy_one(self, fc: FileCopy) -> None:
        name = f"{fc.folder}/{fc.filename}"
        try:
            total = os.stat(fc.src).st_size
        except FileNotFoundError:
            self._finish(fc, MISSING, "not on the network volume")
            return
        fc.total = total
        try:
            if fc.dst.is_file():
                if fc.dst.stat().st_size == total:
                    fc.done = total
                    self._finish(fc, DONE)
                    log.info("local copy: %s already local", name)
                    return
                fc.dst.unlink()
            self.dst_root.mkdir(parents=True, exist_ok=True)
            free = self.disk_usage(self.dst_root).free
        except OSError as e:
            self._finish(fc, FAILED, f"{type(e).__name__}: {e}")
            log.warning("local copy: %s failed before copying (%s); it loads from the volume",
                        name, e)
            return
        if free < total + self.reserve:
            msg = (f"not enough space: {total / 1e9:.1f} GB needed, {free / 1e9:.1f} GB free "
                   f"({self.reserve / 1e9:.0f} GB kept spare)")
            self._finish(fc, SKIPPED, msg)
            log.warning("local copy: skipping %s: %s; it loads from the volume", name, msg)
            return

        def on_bytes(n: int) -> None:
            with self.lock:
                fc.done += n
                fc.copied += n

        log.info("local copy: %s (%.2f GB) -> %s with %d threads", name, total / 1e9,
                 fc.dst, self.threads)
        try:
            self.copy(fc.src, fc.dst, threads=self.threads, chunk=self.chunk,
                      on_bytes=on_bytes, cancel=fc.cancel)
        except Exception as e:
            with self.lock:
                if fc.preempted and not fc.event.is_set() and not self._closed:
                    # Paused for a job's model: start over later, not a failure.
                    fc.state, fc.done, fc.copied, fc.started = PENDING, 0, 0, None
                    fc.attempts -= 1
                    fc.preempted = False
                    fc.cancel = threading.Event()
                    self.queue.append(fc.key)
                    self.lock.notify_all()
                    return
            self._finish(fc, FAILED, f"{type(e).__name__}: {e}")
            log.warning("local copy: %s failed (%s: %s); it loads from the volume",
                        name, type(e).__name__, e)
            return
        if fc.cancel.is_set():  # invalidated while the last range was written
            try:
                fc.dst.unlink()
            except OSError:
                pass
            self._finish(fc, FAILED, "invalidated")
            return
        with self.lock:
            fc.done = total
        self._finish(fc, DONE)
        log.info("local copy: %s done in %.1f s (%.0f MB/s)", name, fc.seconds(self.clock()),
                 fc.mbps(self.clock()))

    # ---- waiting / status ---------------------------------------------------
    def progress(self, entries: Iterable[FileCopy]) -> tuple[int, int]:
        """(bytes ready, total bytes); a finished file counts as ready even
        when it failed (the job no longer waits for it)."""
        with self.lock:
            done = total = 0
            for e in entries:
                total += e.total
                done += e.total if e.event.is_set() else min(e.done, e.total)
            return done, total

    def wait(self, entries: list[FileCopy], *, timeout: float | None = None,
             cancel: threading.Event | None = None,
             on_progress: Callable[[int, int], None] | None = None,
             poll_s: float = 0.5) -> dict:
        """Blocks until every entry is finished, `timeout` passes or `cancel`
        is set. Returns {local: [file], fallback: [file], timedOut, cancelled};
        `fallback` files load from the network volume."""
        deadline = None if timeout is None else self.clock() + timeout
        timed_out = was_cancelled = False
        while True:
            pending = [e for e in entries if not e.event.is_set()]
            if on_progress is not None:
                on_progress(*self.progress(entries))
            if not pending:
                break
            if cancel is not None and cancel.is_set():
                was_cancelled = True
                break
            if deadline is not None and self.clock() >= deadline:
                timed_out = True
                break
            pending[0].event.wait(poll_s)
        with self.lock:
            local = [e.filename for e in entries if e.state == DONE]
            fallback = [e.filename for e in entries if e.state != DONE]
        return {"local": local, "fallback": fallback, "timedOut": timed_out,
                "cancelled": was_cancelled}

    def health(self) -> dict:
        """{model: {state, doneBytes, totalBytes, MBps, files: [...]}} for every
        model requested since boot."""
        now = self.clock()
        out: dict[str, dict] = {}
        with self.lock:
            for mid, keys in self.models.items():
                fcs = [self.files[k] for k in keys if k in self.files]
                secs = sum(f.seconds(now) for f in fcs if f.copied)
                copied = sum(f.copied for f in fcs)
                out[mid] = {
                    "state": _model_state({f.state for f in fcs}),
                    "doneBytes": sum(min(f.done, f.total) if f.total else f.done for f in fcs),
                    "totalBytes": sum(f.total for f in fcs),
                    "MBps": round(copied / 1e6 / secs, 1) if secs > 0 else 0.0,
                    "files": [f.view(now) for f in fcs],
                }
        return out


# ---------------------------------------------------------------------------
# process-wide manager
# ---------------------------------------------------------------------------
_manager: LocalModels | None = None


def get() -> LocalModels | None:
    return _manager


def set_manager(m: LocalModels | None) -> None:
    global _manager
    _manager = m


def init_from_env(env: Mapping[str, str] = os.environ,
                  registry: Callable[[], dict] | None = None) -> LocalModels | None:
    """Creates the process-wide manager in pod mode (None otherwise, or when
    LOCAL_MODELS=0, or when the local root can't be created)."""
    if (env.get("MODE") or "").strip().lower() != "pod":
        return None
    if (env.get("LOCAL_MODELS") or "1").strip().lower() in ("0", "false", "off", "no"):
        log.info("local copy: disabled (LOCAL_MODELS=%s)", env.get("LOCAL_MODELS"))
        return None
    root = Path(env.get("LOCAL_MODELS_ROOT") or "/models-local")
    try:
        root.mkdir(parents=True, exist_ok=True)
        stale = remove_stale_parts(root)
    except OSError as e:
        log.warning("local copy: disabled, cannot use %s: %s", root, e)
        return None
    if registry is None:
        from registry import load_registry
        registry = load_registry
    m = LocalModels(registry, default_source_root(env), root,
                    threads=_env_int(env, "LOCAL_COPY_THREADS", 16, 1, 64),
                    chunk=_env_int(env, "LOCAL_COPY_CHUNK_MB", 64, 1, 1024) * MiB,
                    reserve=_env_int(env, "LOCAL_COPY_RESERVE_GB", 4, 0, 10_000) * GiB)
    set_manager(m)
    log.info("local copy: enabled, %s -> %s (%d threads x %d MB%s)", m.src_root, root,
             m.threads, m.chunk // MiB, f"; removed {stale} stale .part file(s)" if stale else "")
    return m


def wait_timeout_s(env: Mapping[str, str] = os.environ) -> float:
    return _env_float(env, "LOCAL_COPY_WAIT_S", 1800.0)


def prefetch_ids(env: Mapping[str, str], registry: dict) -> list[str]:
    """PREFETCH_MODELS (comma-separated) -> known model ids, in order, once."""
    known = {m["id"] for m in registry.get("models", [])} | \
        {m["id"] for m in registry.get("videoModels", [])}
    out: list[str] = []
    for raw in (env.get("PREFETCH_MODELS") or "").split(","):
        mid = raw.strip()
        if not mid:
            continue
        if mid not in known:
            log.warning("PREFETCH_MODELS: unknown model %r ignored", mid)
        elif mid not in out:
            out.append(mid)
    return out


def begin_for_job(model_id: str) -> list[FileCopy] | None:
    """Handler hook: requests `model_id` with priority. Returns the entries to
    wait for, or None when there is nothing to wait for (copier off, unknown
    model, everything already finished). Never raises."""
    m = get()
    if m is None:
        return None
    try:
        entries = m.request(model_id, front=True)
    except Exception:
        log.exception("local copy: request for %s failed; using the volume", model_id)
        return None
    if not entries or all(e.event.is_set() for e in entries):
        return None
    return entries
