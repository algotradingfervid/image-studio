"""Is comfy-kitchen's CUDA backend (fused int8/fp8 kernels) enabled?

ComfyUI v0.39.0 decides this once, when comfy/quant_ops.py is imported: it
disables comfy-kitchen's "cuda" backend unless torch.version.cuda >= 13
(cu130 wheels), and comfy-kitchen itself only registers it when its _C
extension loads and a GPU is visible. ComfyUI has no API that reports the
result, so `start()` runs ComfyUI's own quant_ops import once, in a short
subprocess with the same Python and ComfyUI tree, and reads comfy-kitchen's
registry there. The result is logged once and served as /health
`cudaKernels`:

  {"enabled": true|false|null, "torchCuda": "13.0", "comfyKitchen": "0.2.37",
   "reason": null | "<why it is off>"}

`enabled` is null while the probe runs or when it failed (reason says why).
`status()` is None until `start()` was called (tests, legacy callers), so
/health only gains the field on a real pod.
"""

from __future__ import annotations

import json
import logging
import os
import subprocess
import sys
import threading

log = logging.getLogger("image_studio.cuda_info")

PROBE_TIMEOUT_S = 300
DEFAULT_COMFY = "/comfyui"

# Runs in a child process: argv[1] is the ComfyUI directory. Prints one JSON line.
PROBE_SCRIPT = r"""
import json, sys
sys.path.insert(0, sys.argv[1])
out = {"enabled": False, "torchCuda": None, "comfyKitchen": None, "reason": None}
try:
    import torch
    out["torchCuda"] = torch.version.cuda
    from importlib import metadata
    try:
        out["comfyKitchen"] = metadata.version("comfy-kitchen")
    except metadata.PackageNotFoundError:
        pass
    import comfy.quant_ops as q  # ComfyUI's own gate (cuda < 13 -> disabled)
    if not q._CK_AVAILABLE:
        out["reason"] = "comfy_kitchen failed to import"
    else:
        import comfy_kitchen as ck
        info = ck.list_backends().get("cuda") or {}
        out["enabled"] = bool(ck.registry.is_available("cuda"))
        if not out["enabled"]:
            if info.get("disabled"):
                out["reason"] = f"disabled by ComfyUI (torch CUDA {torch.version.cuda}; needs >= 13)"
            else:
                out["reason"] = info.get("unavailable_reason") or "cuda backend not registered"
except Exception as e:
    out["enabled"] = None
    out["reason"] = f"probe error: {e!r}"
print("CUDA_INFO " + json.dumps(out), flush=True)
"""

_lock = threading.Lock()
_status: dict | None = None


def parse_probe_output(stdout: str) -> dict | None:
    for line in reversed(stdout.splitlines()):
        if line.startswith("CUDA_INFO "):
            try:
                data = json.loads(line[len("CUDA_INFO "):])
            except ValueError:
                return None
            return data if isinstance(data, dict) else None
    return None


def probe(comfy_dir: str | None = None, python: str = sys.executable,
          timeout: float = PROBE_TIMEOUT_S, run=subprocess.run) -> dict:
    comfy_dir = comfy_dir or os.environ.get("COMFYUI_PATH") or DEFAULT_COMFY
    try:
        p = run([python, "-c", PROBE_SCRIPT, comfy_dir], capture_output=True, text=True,
                timeout=timeout, cwd=comfy_dir if os.path.isdir(comfy_dir) else None)
    except (OSError, subprocess.SubprocessError) as e:
        return {"enabled": None, "torchCuda": None, "comfyKitchen": None,
                "reason": f"probe failed: {e!r}"}
    data = parse_probe_output(p.stdout or "")
    if data is None:
        tail = " | ".join((p.stderr or p.stdout or "").strip().splitlines()[-3:])
        return {"enabled": None, "torchCuda": None, "comfyKitchen": None,
                "reason": f"probe exited {p.returncode}: {tail}"[:500]}
    return data


def _run(probe_fn) -> None:
    global _status
    result = probe_fn()
    with _lock:
        _status = result
    if result.get("enabled"):
        log.info("cuda kernels: comfy-kitchen CUDA backend ENABLED (torch CUDA %s, comfy-kitchen %s)",
                 result.get("torchCuda"), result.get("comfyKitchen"))
    else:
        log.warning("cuda kernels: comfy-kitchen CUDA backend NOT enabled (torch CUDA %s, "
                    "comfy-kitchen %s): %s", result.get("torchCuda"),
                    result.get("comfyKitchen"), result.get("reason"))


def start(probe_fn=probe, background: bool = True) -> None:
    """Probe once (in a daemon thread by default); later calls are no-ops."""
    global _status
    with _lock:
        if _status is not None:
            return
        _status = {"enabled": None, "torchCuda": None, "comfyKitchen": None,
                   "reason": "probing"}
    if background:
        threading.Thread(target=_run, args=(probe_fn,), name="cuda-info", daemon=True).start()
    else:
        _run(probe_fn)


def status() -> dict | None:
    with _lock:
        return dict(_status) if _status is not None else None


def _reset_for_tests() -> None:
    global _status
    with _lock:
        _status = None
