"""Planner LLM on the video pod (pod mode only, off unless LLM_MODEL is set).

The app's Stories planner talks to an OpenAI-compatible server. On the video
pod that server is vLLM, run from its own venv (/opt/vllm, see
Dockerfile.runtime step 4c: vLLM 0.24 needs transformers 5.x, ComfyUI needs
4.x) on 127.0.0.1:8001; server.py proxies `/v1/...` to it behind the usual
Bearer auth.

LLMSupervisor, one background thread:
  1. downloading: huggingface_hub.snapshot_download of LLM_MODEL (HF_TOKEN)
     into /models-local/llm/<repo name>. Skipped when a previous run left the
     completion marker. totalBytes comes from the Hub's file metadata,
     downloadedBytes from the size of the directory on disk (in-flight files
     live under its .cache/huggingface/download/).
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
"""

from __future__ import annotations

import collections
import json
import logging
import math
import os
import shutil
import subprocess
import threading
import time
from pathlib import Path
from typing import Any, Callable, Mapping

import requests

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
DISK_RESERVE = 2 * GiB        # kept free on the container disk after the download
START_TIMEOUT_S = 1800.0      # weights load + torch.compile + CUDA graphs, first boot
GATE_TIMEOUT_S = 300.0
POLL_S = 2.0
LOG_TAIL = 20                 # vLLM lines kept for the failure reason
# The model card's verified serve flags (vLLM 0.24.0), minus the ones we size
# ourselves (utilization, max length, sequences). No --quantization: the FP8
# scheme is read from config.json.
SPECULATIVE_CONFIG = '{"method":"mtp","num_speculative_tokens":3}'


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

    def __init__(self, repo: str, root: Path, *, served_name: str = DEFAULT_SERVED_NAME,
                 gpu_gb: float = DEFAULT_GPU_GB, max_len: int = DEFAULT_MAX_LEN,
                 token: str | None = None, env: Mapping[str, str] | None = None,
                 vllm_bin: str = VLLM_BIN, port: int = PORT,
                 popen: Callable[..., Any] = subprocess.Popen,
                 download: Callable[[str, Path, str | None], None] = hf_download,
                 total_bytes: Callable[[str, str | None], int] = hf_total_bytes,
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
        self.dir = Path(root) / repo.rstrip("/").split("/")[-1]
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
        self.proc: Any = None
        self.tail: collections.deque[str] = collections.deque(maxlen=LOG_TAIL)
        self._stopped = False

    @classmethod
    def from_env(cls, env: Mapping[str, str], **kw) -> "LLMSupervisor | None":
        """None (feature off) unless LLM_MODEL is set."""
        repo = (env.get("LLM_MODEL") or "").strip()
        if not repo:
            return None
        root = Path(env.get("LOCAL_MODELS_ROOT") or "/models-local") / "llm"
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
            done = min(self.disk_bytes(self.dir), total)
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

    def _download(self) -> bool:
        marker = self.dir / COMPLETE_MARKER
        try:
            done = json.loads(marker.read_text())
            if done.get("repo") == self.repo:
                with self.lock:
                    self.total = self.downloaded = int(done.get("totalBytes") or 0)
                log.info("planner LLM: %s already on local disk (%s)", self.repo, self.dir)
                return True
        except (OSError, ValueError, AttributeError):
            pass
        t0 = self.clock()
        try:
            total = int(self.total_bytes(self.repo, self.token))
            with self.lock:
                self.total = total
            self.dir.mkdir(parents=True, exist_ok=True)
            need = total - min(self.disk_bytes(self.dir), total)
            free = self.disk_usage(self.dir).free
            if free < need + DISK_RESERVE:
                self._fail(f"not enough disk space for {self.repo}: {need / 1e9:.1f} GB "
                           f"needed, {free / 1e9:.1f} GB free")
                return False
            log.info("planner LLM: downloading %s (%.1f GB) -> %s", self.repo, total / 1e9,
                     self.dir)
            self.download(self.repo, self.dir, self.token)
        except Exception as exc:
            msg = str(exc).strip().splitlines()[0][:300] if str(exc).strip() else ""
            self._fail(f"download of {self.repo} failed: {type(exc).__name__}"
                       + (f": {msg}" if msg else ""))
            return False
        with self.lock:
            self.downloaded = self.total
        marker.write_text(json.dumps({"repo": self.repo, "totalBytes": self.total}))
        log.info("planner LLM: download done in %.0f s", self.clock() - t0)
        return True

    def command(self, util: float) -> list[str]:
        return [self.vllm_bin, "serve", str(self.dir),
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
                "--disable-uvicorn-access-log"]

    def _child_env(self) -> dict[str, str]:
        env = dict(self.env)
        # PYTHONPATH points at the worker's src/ (handler.py, server.py,
        # registry.py, ...): those names must not shadow anything in vLLM.
        env.pop("PYTHONPATH", None)
        env.setdefault("VLLM_NO_USAGE_STATS", "1")
        env.setdefault("DO_NOT_TRACK", "1")
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
                    print(f"vllm | {line}", flush=True)
        except (OSError, ValueError):
            pass

    def _tail_text(self, n: int = 5) -> str:
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
