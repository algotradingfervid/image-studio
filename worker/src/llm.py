"""Planner LLM on the video pod (pod mode only, off unless LLM_MODEL is set).

The app's Stories planner talks to an OpenAI-compatible server. On the video
pod that server is vLLM, run from its own venv (/opt/vllm, see
Dockerfile.runtime step 4c: vLLM 0.24 needs transformers 5.x, ComfyUI needs
4.x) on 127.0.0.1:8001; server.py proxies `/v1/...` to it behind the usual
Bearer auth.

LLMSupervisor, one background thread:
  1. downloading: the weights end up in /models-local/llm/<repo name> on the
     container disk (vLLM loads with small reads, slow on the network volume):
       - local completion marker present -> nothing to do;
       - otherwise huggingface_hub.snapshot_download of LLM_MODEL (HF_TOKEN)
         straight to the local disk (31 GB in 27 s on the first pod boot);
       - the Hub fails and the network volume has a complete copy in
         /runpod-volume/models/llm/<repo name> -> copy that instead
         (local_models.copy_file; 1362 s for the same 31 GB, the volume's
         throughput being shared with the H3 copy); too little local room ->
         vLLM serves from that volume copy.
     Nothing new is written to the volume. totalBytes comes from the Hub's
     file metadata; downloadedBytes from the size of the directory being
     downloaded into (in-flight files live under its
     .cache/huggingface/download/), or the bytes copied so far.
  2. starting: `/opt/vllm/bin/vllm serve <dir> ...` (vllm.entrypoints.cli.main,
     the console script of vLLM 0.24), its output prefixed "vllm | " in the pod
     log; GET http://127.0.0.1:8001/health is polled until it answers 200.
  3. ready, until the process exits (-> failed).
  Any error -> failed, with a short reason (the last vLLM log lines).

Before launching it waits (at most GATE_TIMEOUT_S) for `gate()`: the CUDA
probe (cuda_info) briefly holds a CUDA context, and vLLM's memory profiling
asserts that no other process frees GPU memory while it runs.

Environment (set by the app on the video pod only):
  LLM_MODEL         HF repo id; empty or unset = feature off
  LLM_SERVED_NAME   model name clients send, default "qwen3.8-27b-uncensored"
  LLM_GPU_GB        GPU memory for vLLM in GiB, default 44
                    (--gpu-memory-utilization = LLM_GPU_GB / total, in [0.1, 0.9])
  LLM_MAX_LEN       --max-model-len, default 32768
  VOLUME_ROOT, MODELS_ROOT  where the volume copy lives (local_models.default_source_root)
"""

from __future__ import annotations

import collections
import json
import logging
import math
import os
import re
import shutil
import subprocess
import threading
import time
from pathlib import Path
from typing import Any, Callable, Mapping

import requests

import local_models

log = logging.getLogger("image_studio.llm")

OFF, DOWNLOADING, STARTING, READY, FAILED = "off", "downloading", "starting", "ready", "failed"

DEFAULT_SERVED_NAME = "qwen3.8-27b-uncensored"
DEFAULT_GPU_GB = 44.0
DEFAULT_MAX_LEN = 32768
MAX_NUM_SEQS = 4
VLLM_BIN = "/opt/vllm/bin/vllm"
HOST, PORT = "127.0.0.1", 8001
UPSTREAM = f"http://{HOST}:{PORT}"
COMPLETE_MARKER = ".image-studio-complete"
GiB = 1024 ** 3
DISK_RESERVE = 2 * GiB        # kept free on the disk after a download or copy
COPY_THREADS = 16
START_TIMEOUT_S = 1800.0      # weights load + torch.compile + CUDA graphs, first boot
GATE_TIMEOUT_S = 300.0
POLL_S = 2.0
LOG_TAIL = 20                 # vLLM lines kept for the failure reason
_PREFIX = re.compile(r"^\((?:APIServer|EngineCore)[^)]*\)\s*(?:(?:ERROR|WARNING|INFO)\s+\S+\s+\S+\s+\[[^\]]*\]\s*)?")
_ERROR = re.compile(r"^[\w.]*(?:Error|Exception)(?::|$)")


def root_cause(line: str) -> str | None:
    """The error line in one vLLM log line ("torch._inductor.exc.InductorError: ..."),
    without the "(EngineCore pid=N) ERROR <date> <time> [file:line]" prefix; None for
    other lines, warnings, and vLLM's generic wrapper error."""
    if "WARNING" in line[:60]:
        return None
    text = _PREFIX.sub("", line.strip())
    if not _ERROR.match(text) or "Engine core initialization failed" in text:
        return None
    return text[:400]
# The model card's verified serve flags (vLLM 0.24.0), minus the ones we size
# ourselves (utilization, max length, sequences). No --quantization: the FP8
# scheme is read from config.json.
# The MTP drafter picks its own attention backend (--attention-backend covers
# only the target model): FlashInfer on Blackwell, which JIT-compiles with nvcc.
SPECULATIVE_CONFIG = '{"method":"mtp","num_speculative_tokens":3,"attention_backend":"TRITON_ATTN"}'


def off_status() -> dict:
    return {"state": OFF, "model": None, "downloadedBytes": 0, "totalBytes": 0, "error": None}


def gpu_utilization(gpu_gb: float, total_mib: float) -> float:
    """Fraction of the GPU vLLM may take: `gpu_gb` GiB of `total_mib` MiB
    (nvidia-smi's unit), rounded down to 3 decimals, clamped to [0.1, 0.9]."""
    frac = math.floor(gpu_gb * 1024 / total_mib * 1000) / 1000
    return max(0.1, min(0.9, frac))


def gpu_total_mib() -> float | None:
    """Total memory of GPU 0 in MiB, from nvidia-smi; None if unknown."""
    try:
        p = subprocess.run(["nvidia-smi", "--query-gpu=memory.total",
                            "--format=csv,noheader,nounits"],
                           capture_output=True, text=True, timeout=10)
        if p.returncode == 0 and p.stdout.strip():
            return float(p.stdout.strip().splitlines()[0])
    except (OSError, subprocess.SubprocessError, ValueError):
        pass
    return None


def hf_total_bytes(repo: str, token: str | None) -> int:
    from huggingface_hub import HfApi  # system python's hub (<1.0); lazy for tests
    info = HfApi().model_info(repo, files_metadata=True, token=token or None)
    return sum(int(s.size or 0) for s in (info.siblings or []))


def hf_download(repo: str, dest: Path, token: str | None) -> None:
    from huggingface_hub import snapshot_download
    snapshot_download(repo_id=repo, local_dir=str(dest), token=token or None, max_workers=8)


def dir_bytes(root: Path) -> int:
    """Bytes of every file under `root`, including in-flight downloads."""
    total = 0
    for dirpath, _, files in os.walk(root):
        for f in files:
            try:
                total += os.lstat(os.path.join(dirpath, f)).st_size
            except OSError:
                pass
    return total


def _env_float(env: Mapping[str, str], key: str, default: float) -> float:
    try:
        v = float(str(env.get(key, "")).strip() or default)
    except ValueError:
        return default
    return v if v > 0 else default


def _env_int(env: Mapping[str, str], key: str, default: int) -> int:
    try:
        v = int(str(env.get(key, "")).strip() or default)
    except ValueError:
        return default
    return v if v > 0 else default


class LLMSupervisor:
    """Downloads the model, runs vLLM, reports state. Thread-safe status()."""

    def __init__(self, repo: str, root: Path, *, store: Path | None = None, served_name: str = DEFAULT_SERVED_NAME,
                 gpu_gb: float = DEFAULT_GPU_GB, max_len: int = DEFAULT_MAX_LEN,
                 token: str | None = None, env: Mapping[str, str] | None = None,
                 vllm_bin: str = VLLM_BIN, port: int = PORT,
                 popen: Callable[..., Any] = subprocess.Popen,
                 download: Callable[[str, Path, str | None], None] = hf_download,
                 total_bytes: Callable[[str, str | None], int] = hf_total_bytes,
                 copy: Callable[..., int] = local_models.copy_file,
                 disk_bytes: Callable[[Path], int] = dir_bytes,
                 disk_usage: Callable[[Path], Any] = shutil.disk_usage,
                 gpu_mib: Callable[[], float | None] = gpu_total_mib,
                 http_get: Callable[..., Any] = requests.get,
                 gate: Callable[[], bool] | None = None,
                 start_timeout_s: float = START_TIMEOUT_S, gate_timeout_s: float = GATE_TIMEOUT_S,
                 poll_s: float = POLL_S,
                 sleep: Callable[[float], None] = time.sleep,
                 clock: Callable[[], float] = time.monotonic):
        self.repo = repo
        name = repo.rstrip("/").split("/")[-1]
        self.dir = Path(root) / name                 # local disk, what vLLM serves
        self.store = Path(store) / name if store is not None else None  # volume copy
        self.serve_dir = self.dir
        self.served_name = served_name
        self.gpu_gb = gpu_gb
        self.max_len = max_len
        self.token = token
        self.env = dict(os.environ if env is None else env)
        self.vllm_bin = vllm_bin
        self.port = port
        self.popen = popen
        self.download = download
        self.total_bytes = total_bytes
        self.copy = copy
        self.disk_bytes = disk_bytes
        self.disk_usage = disk_usage
        self.gpu_mib = gpu_mib
        self.http_get = http_get
        self.gate = gate
        self.start_timeout_s = start_timeout_s
        self.gate_timeout_s = gate_timeout_s
        self.poll_s = poll_s
        self.sleep = sleep
        self.clock = clock
        self.lock = threading.Lock()
        self.state = DOWNLOADING
        self.error: str | None = None
        self.total = 0
        self.downloaded = 0
        self._progress: Callable[[], int] = lambda: self.disk_bytes(self.dir)
        self.proc: Any = None
        self.tail: collections.deque[str] = collections.deque(maxlen=LOG_TAIL)
        self.cause: str | None = None
        self._stopped = False

    @classmethod
    def from_env(cls, env: Mapping[str, str], **kw) -> "LLMSupervisor | None":
        """None (feature off) unless LLM_MODEL is set."""
        repo = (env.get("LLM_MODEL") or "").strip()
        if not repo:
            return None
        root = Path(env.get("LOCAL_MODELS_ROOT") or "/models-local") / "llm"
        models = local_models.default_source_root(env)
        kw.setdefault("store", models / "llm" if models.is_dir() else None)
        return cls(repo, root,
                   served_name=(env.get("LLM_SERVED_NAME") or "").strip() or DEFAULT_SERVED_NAME,
                   gpu_gb=_env_float(env, "LLM_GPU_GB", DEFAULT_GPU_GB),
                   max_len=_env_int(env, "LLM_MAX_LEN", DEFAULT_MAX_LEN),
                   token=(env.get("HF_TOKEN") or "").strip() or None, env=env, **kw)

    # ---- status ------------------------------------------------------------
    @property
    def base_url(self) -> str:
        return f"http://{HOST}:{self.port}"

    def status(self) -> dict:
        with self.lock:
            state, total, done, error = self.state, self.total, self.downloaded, self.error
        if state == DOWNLOADING and total:
            done = min(self._progress(), total)
            with self.lock:
                self.downloaded = max(self.downloaded, done)
                done = self.downloaded
        return {"state": state, "model": self.served_name, "downloadedBytes": done,
                "totalBytes": total, "error": error}

    def ready(self) -> bool:
        return self.state == READY

    def busy(self) -> bool:
        """Downloading or starting: ComfyUI should keep off the GPU."""
        return self.state in (DOWNLOADING, STARTING)

    def _set(self, state: str, error: str | None = None) -> None:
        with self.lock:
            self.state, self.error = state, error

    def _fail(self, error: str) -> None:
        self._set(FAILED, error[:500])
        log.error("planner LLM failed: %s", error[:500])

    # ---- run -----------------------------------------------------------------
    def start(self) -> None:
        threading.Thread(target=self.run, name="llm", daemon=True).start()

    def run(self) -> None:
        try:
            if not self._download():
                return
            self._launch()
        except Exception as exc:  # never let the supervisor hurt the server
            log.exception("planner LLM supervisor error")
            self._kill()
            self._fail(f"{type(exc).__name__}: {exc}")

    def _complete(self, d: Path) -> int | None:
        """totalBytes from `d`'s completion marker for this repo, else None."""
        try:
            done = json.loads((d / COMPLETE_MARKER).read_text())
            if done.get("repo") == self.repo:
                return int(done.get("totalBytes") or 0)
        except (OSError, ValueError, AttributeError, TypeError):
            pass
        return None

    def _mark(self, d: Path) -> None:
        (d / COMPLETE_MARKER).write_text(json.dumps({"repo": self.repo,
                                                     "totalBytes": self.total}))

    def _download(self) -> bool:
        total = self._complete(self.dir)
        if total is not None:
            with self.lock:
                self.total = self.downloaded = total
            log.info("planner LLM: %s already on local disk (%s)", self.repo, self.dir)
            return True
        # Straight from the Hub to the local disk first: on the first pod boot
        # (2026-10-13) the 31 GB download took 27 s, while copying the volume copy
        # to the local disk took 1362 s (the network volume, shared with the H3
        # copy, is the bottleneck). The volume copy is only the fallback.
        vol_total = self._complete(self.store) if self.store is not None else None
        fetched = self._fetch(self.dir, fall_back=vol_total is not None)
        if fetched:
            return True
        if vol_total is None:
            return False
        self._set(DOWNLOADING)
        if fetched is None:  # no room on the local disk
            log.warning("planner LLM: serving %s from the volume copy (%s)", self.repo, self.store)
            self.serve_dir = self.store
            with self.lock:
                self.total = self.downloaded = vol_total
            return True
        log.warning("planner LLM: Hub download failed; copying the volume copy instead")
        self._copy_local()
        return True

    def _fetch(self, dest: Path, fall_back: bool = False) -> bool | None:
        """Downloads the repo into `dest` and marks it complete. False after a
        failure (only logged when `fall_back`: the caller has another source);
        None (nothing failed) when `fall_back` and `dest` lacks room."""
        t0 = self.clock()
        try:
            total = int(self.total_bytes(self.repo, self.token))
            with self.lock:
                self.total = total
            dest.mkdir(parents=True, exist_ok=True)
            need = total - min(self.disk_bytes(dest), total)
            free = self.disk_usage(dest).free
            if free < need + DISK_RESERVE:
                msg = (f"not enough disk space for {self.repo}: {need / 1e9:.1f} GB "
                       f"needed, {free / 1e9:.1f} GB free")
                if fall_back:
                    log.warning("planner LLM: %s on the local disk", msg)
                    return None
                self._fail(msg)
                return False
            log.info("planner LLM: downloading %s (%.1f GB) -> %s", self.repo, total / 1e9,
                     dest)
            self._progress = lambda: self.disk_bytes(dest)
            self.download(self.repo, dest, self.token)
        except Exception as exc:
            msg = str(exc).strip().splitlines()[0][:300] if str(exc).strip() else ""
            err = f"download of {self.repo} failed: {type(exc).__name__}" + (f": {msg}" if msg else "")
            if fall_back:
                log.warning("planner LLM: %s", err)
            else:
                self._fail(err)
            return False
        with self.lock:
            self.downloaded = self.total
        self._mark(dest)
        log.info("planner LLM: download done in %.0f s", self.clock() - t0)
        return True

    def _copy_local(self) -> None:
        """Copies the volume copy to the local disk; on any trouble vLLM
        serves from the volume instead (slower load, same model)."""
        src = self.store
        files = [p for p in sorted(src.rglob("*"))
                 if p.is_file() and p.name != COMPLETE_MARKER
                 and ".cache" not in p.relative_to(src).parts]
        size = sum(p.stat().st_size for p in files)
        copied = [0]
        with self.lock:
            self.total, self.downloaded = size, 0
        self._progress = lambda: copied[0]
        t0 = self.clock()
        try:
            self.dir.mkdir(parents=True, exist_ok=True)
            free = self.disk_usage(self.dir).free
            if free < size + DISK_RESERVE:
                raise OSError(f"{size / 1e9:.1f} GB needed, {free / 1e9:.1f} GB free")
            log.info("planner LLM: copying %s (%.1f GB) from the volume to %s", self.repo,
                     size / 1e9, self.dir)
            for p in files:
                dst = self.dir / p.relative_to(src)
                if dst.is_file() and dst.stat().st_size == p.stat().st_size:
                    copied[0] += dst.stat().st_size
                    continue

                def add(n: int) -> None:
                    copied[0] += n

                self.copy(p, dst, threads=COPY_THREADS, on_bytes=add)
        except Exception as exc:
            log.warning("planner LLM: copy to the local disk failed (%s: %s); serving "
                        "from the volume", type(exc).__name__, exc)
            self.serve_dir = src
        else:
            self._mark(self.dir)
            log.info("planner LLM: copy done in %.0f s", self.clock() - t0)
        with self.lock:
            self.downloaded = self.total

    def command(self, util: float) -> list[str]:
        return [self.vllm_bin, "serve", str(self.serve_dir),
                "--served-model-name", self.served_name,
                "--host", HOST, "--port", str(self.port),
                "--language-model-only",
                "--speculative-config", SPECULATIVE_CONFIG,
                "--kv-cache-dtype", "fp8",
                "--gpu-memory-utilization", f"{util:g}",
                "--max-model-len", str(self.max_len),
                "--max-num-seqs", str(MAX_NUM_SEQS),
                "--trust-remote-code",
                "--reasoning-parser", "qwen3",
                # FlashInfer's GDN prefill kernel is JIT-compiled with nvcc,
                # which the runtime image does not ship: Triton needs only cc.
                "--gdn-prefill-backend", "triton",
                # vLLM picks FlashInfer attention on Blackwell (fp8 KV cache), JIT-compiled
                # with nvcc as well: Triton attention runs fp8 KV on every SM89+ GPU.
                "--attention-backend", "TRITON_ATTN",
                "--disable-uvicorn-access-log"]

    def _child_env(self) -> dict[str, str]:
        env = dict(self.env)
        # PYTHONPATH points at the worker's src/ (handler.py, server.py,
        # registry.py, ...): those names must not shadow anything in vLLM.
        env.pop("PYTHONPATH", None)
        env.setdefault("VLLM_NO_USAGE_STATS", "1")
        env.setdefault("DO_NOT_TRACK", "1")
        # FlashInfer's top-k/top-p sampler is JIT-compiled with nvcc as well.
        env.setdefault("VLLM_USE_FLASHINFER_SAMPLER", "0")
        return env

    def _launch(self) -> None:
        self._set(STARTING)
        if self.gate is not None:
            deadline = self.clock() + self.gate_timeout_s
            while not self.gate() and self.clock() < deadline:
                self.sleep(self.poll_s)
        total_mib = self.gpu_mib()
        if not total_mib:
            self._fail("could not read the GPU's total memory (nvidia-smi)")
            return
        util = gpu_utilization(self.gpu_gb, total_mib)
        cmd = self.command(util)
        log.info("planner LLM: %.0f GiB of %.0f GiB -> --gpu-memory-utilization %g",
                 self.gpu_gb, total_mib / 1024, util)
        log.info("planner LLM: starting %s", " ".join(cmd))
        self.proc = self.popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                               text=True, bufsize=1, env=self._child_env())
        reader = threading.Thread(target=self._pump, args=(self.proc,), name="llm-log",
                                  daemon=True)
        reader.start()
        t0 = self.clock()
        deadline = t0 + self.start_timeout_s
        url = self.base_url + "/health"
        while True:
            if self._stopped:
                return
            code = self.proc.poll()
            if code is not None:
                reader.join(5)  # let the last lines reach the tail
                self._fail(f"vLLM exited with code {code} while starting: {self._tail_text()}")
                return
            try:
                if self.http_get(url, timeout=5).status_code == 200:
                    break
            except requests.RequestException:
                pass
            if self.clock() >= deadline:
                self._kill()
                self._fail(f"vLLM did not become healthy within {self.start_timeout_s:g} s: "
                           f"{self._tail_text()}")
                return
            self.sleep(self.poll_s)
        self._set(READY)
        log.info("planner LLM ready: %s as %r in %.0f s", self.repo, self.served_name,
                 self.clock() - t0)
        code = self.proc.wait()
        reader.join(5)
        if not self._stopped:
            self._fail(f"vLLM exited with code {code}: {self._tail_text()}")

    def _pump(self, proc: Any) -> None:
        try:
            for line in proc.stdout:
                line = line.rstrip()
                if line:
                    self.tail.append(line)
                    cause = root_cause(line)
                    if cause:
                        self.cause = cause
                    print(f"vllm | {line}", flush=True)
        except (OSError, ValueError):
            pass

    def _tail_text(self, n: int = 5) -> str:
        # The real error is usually far above vLLM's last lines ("Engine core
        # initialization failed. See root cause above").
        if self.cause:
            return self.cause
        lines = list(self.tail)[-n:]
        return " | ".join(lines) if lines else "no output"

    def _kill(self) -> None:
        p = self.proc
        if p is None or p.poll() is not None:
            return
        try:
            p.terminate()
            p.wait(timeout=30)
        except Exception:
            try:
                p.kill()
            except Exception:
                pass

    def stop(self) -> None:
        self._stopped = True
        self._kill()
