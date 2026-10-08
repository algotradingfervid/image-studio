"""Image Studio RunPod Serverless handler.

Installed as /handler.py in the image, replacing the upstream worker-comfyui
handler; the base image's /start.sh starts ComfyUI in the background and then
runs `python -u /handler.py`.

Actions (docs/spec.md, "Worker job protocol"):
  generate  {model, prompt, negativePrompt, width, height, seed, steps, cfg,
             references: [{name, base64}], loras: [{filename, strength}]}
            -> {image: {base64, seed, width, height}, timings: {loadMs, sampleMs, totalMs}}
  status    -> {files: [{folder, filename, sizeBytes}], volume: {totalBytes, freeBytes},
                comfyuiVersion}
  download  {files: [{folder, filename, url, sizeBytes?, sha256?}]}
            -> {downloaded: [filename], skipped: [filename], elapsedMs, avgMBps}
            (up to 3 files in parallel; progress is aggregated, see _run_downloads)
  delete    {files: [{folder, filename}]} -> {deleted: [filename], missing: [filename]}

Failures are returned as {"error": "<CODE>: <detail>"}; the RunPod SDK then
marks the job FAILED with that message.

Pod mode (MODE=pod, docs/spec.md "v3 change"): the same /start.sh runs this
file, which then starts server.py instead of runpod.serverless.start. The pod
server passes two private keys in the job dict:
  "_progress": callable(payload)  receives progress instead of progress_update
  "_cancel":   threading.Event    set when the job is cancelled
Serverless jobs never carry these keys, so serverless behaviour is unchanged.
"""

from __future__ import annotations

import base64
import binascii
import math
import os
import random
import re
import shutil
import struct
import threading
import time
import traceback
import uuid
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from typing import Any, Callable

import runpod

from comfy_client import ComfyClient, ComfyError
from downloader import DownloadConfig, DownloadError, download_file
from registry import get_model, load_registry, model_ids
from safe_paths import PathError, resolve, validate_filename, validate_folder
from workflows import WorkflowError, build_workflow, sampler_node_ids

VOLUME_ROOT = Path(os.environ.get("VOLUME_ROOT", "/runpod-volume"))
MODELS_ROOT = Path(os.environ.get("MODELS_ROOT", str(VOLUME_ROOT / "models")))
COMFYUI_PATH = Path(os.environ.get("COMFYUI_PATH", "/comfyui"))
COMFY_READY_TIMEOUT_S = float(os.environ.get("COMFY_READY_TIMEOUT_S", "300"))
GENERATE_TIMEOUT_S = float(os.environ.get("GENERATE_TIMEOUT_S", "590"))
PROGRESS_MIN_INTERVAL_S = 0.5   # <= 2 progress updates per second
DOWNLOAD_CONCURRENCY = int(os.environ.get("DOWNLOAD_CONCURRENCY", "3"))

MAX_LORAS = 3
MAX_SEED = 2**64 - 1
MIN_SIDE, MAX_SIDE = 64, 4096
MAX_STEPS = 200
LISTED_FOLDERS = ("unet", "clip", "vae")

PROGRESS_HOOK = "_progress"
CANCEL_EVENT = "_cancel"


def _send_progress(job: dict, payload: dict) -> None:
    """Pod mode: the job's progress hook; serverless: runpod's progress_update."""
    hook = job.get(PROGRESS_HOOK)
    if callable(hook):
        hook(payload)
    else:
        runpod.serverless.progress_update(job, payload)


# Indirection points for tests.
make_client: Callable[[], ComfyClient] = ComfyClient
send_progress: Callable[[dict, dict], None] = _send_progress
clock: Callable[[], float] = time.monotonic


class InputError(ValueError):
    pass


class JobCancelled(RuntimeError):
    pass


def cancelled(job: dict) -> bool:
    """True once the pod server cancelled this job (never in serverless mode)."""
    ev = job.get(CANCEL_EVENT)
    return ev is not None and ev.is_set()


# ---------------------------------------------------------------------------
# helpers
# ---------------------------------------------------------------------------
class Throttle:
    """Sends progress at most every `interval` seconds (forced sends bypass)."""

    def __init__(self, job: dict, interval: float = PROGRESS_MIN_INTERVAL_S):
        self.job = job
        self.interval = interval
        self.last = -math.inf
        self.last_payload: dict | None = None
        self._lock = threading.Lock()

    def __call__(self, payload: dict, force: bool = False) -> None:
        with self._lock:
            now = clock()
            if payload == self.last_payload:
                return
            if not force and now - self.last < self.interval:
                return
            self.last = now
            self.last_payload = payload
        try:
            send_progress(self.job, payload)
        except Exception:  # progress is best effort
            traceback.print_exc()


def _ms(seconds: float) -> int:
    return int(round(seconds * 1000))


def png_size(data: bytes) -> tuple[int, int] | None:
    if data[:8] == b"\x89PNG\r\n\x1a\n" and data[12:16] == b"IHDR":
        w, h = struct.unpack(">II", data[16:24])
        return w, h
    return None


_IMAGE_MAGIC = (
    (b"\x89PNG\r\n\x1a\n", "png", "image/png"),
    (b"\xff\xd8\xff", "jpg", "image/jpeg"),
    (b"RIFF", "webp", "image/webp"),
)


def _decode_reference(ref: Any, index: int) -> tuple[bytes, str, str]:
    if not isinstance(ref, dict) or not isinstance(ref.get("base64"), str):
        raise InputError(f"INVALID_REFERENCE: reference {index} needs {{name, base64}}")
    b64 = ref["base64"]
    if b64.startswith("data:"):
        b64 = b64.split(",", 1)[-1]
    try:
        data = base64.b64decode(b64, validate=True)
    except (binascii.Error, ValueError):
        raise InputError(f"INVALID_REFERENCE: reference {index} is not valid base64") from None
    for magic, ext, mime in _IMAGE_MAGIC:
        if data.startswith(magic) and (ext != "webp" or data[8:12] == b"WEBP"):
            return data, ext, mime
    raise InputError(f"INVALID_REFERENCE: reference {index} is not a PNG, JPEG or WebP image")


def _number(inp: dict, key: str, kind: type, lo: float, hi: float, required: bool = True):
    v = inp.get(key)
    if v is None:
        if required:
            raise InputError(f"INVALID_INPUT: {key} is required")
        return None
    if isinstance(v, bool) or not isinstance(v, (int, float)):
        raise InputError(f"INVALID_INPUT: {key} must be a number")
    if kind is int:
        if isinstance(v, float) and not v.is_integer():
            raise InputError(f"INVALID_INPUT: {key} must be an integer")
        v = int(v)
    else:
        v = float(v)
        if not math.isfinite(v):
            raise InputError(f"INVALID_INPUT: {key} must be finite")
    if not lo <= v <= hi:
        raise InputError(f"INVALID_INPUT: {key} must be within [{lo}, {hi}]")
    return v


def validate_generate(inp: dict, registry: dict) -> dict:
    mid = inp.get("model")
    if mid not in model_ids(registry):
        raise InputError(f"UNKNOWN_MODEL: {mid!r}")
    model = get_model(registry, mid)
    prompt = inp.get("prompt")
    if not isinstance(prompt, str) or not prompt.strip():
        raise InputError("INVALID_INPUT: prompt is required")
    neg = inp.get("negativePrompt")
    if neg is not None and not isinstance(neg, str):
        raise InputError("INVALID_INPUT: negativePrompt must be a string")
    width = _number(inp, "width", int, MIN_SIDE, MAX_SIDE)
    height = _number(inp, "height", int, MIN_SIDE, MAX_SIDE)
    if width % 16 or height % 16:
        raise InputError("INVALID_INPUT: width and height must be multiples of 16")
    seed = _number(inp, "seed", int, 0, MAX_SEED, required=False)
    if seed is None:
        seed = random.randint(0, 2**53 - 1)
    steps = _number(inp, "steps", int, 1, MAX_STEPS, required=False)
    cfg = _number(inp, "cfg", float, 0.0, 30.0, required=False)

    refs = inp.get("references") or []
    if not isinstance(refs, list):
        raise InputError("INVALID_INPUT: references must be a list")
    if len(refs) > int(model.get("maxReferences", 0)):
        raise InputError(
            f"TOO_MANY_REFERENCES: {mid} accepts at most {model.get('maxReferences', 0)}")
    decoded = [_decode_reference(r, i) for i, r in enumerate(refs)]

    loras = inp.get("loras") or []
    if not isinstance(loras, list) or len(loras) > MAX_LORAS:
        raise InputError(f"INVALID_INPUT: at most {MAX_LORAS} loras")
    clean_loras = []
    for i, lora in enumerate(loras):
        if not isinstance(lora, dict):
            raise InputError(f"INVALID_INPUT: lora {i} must be an object")
        try:
            fn = validate_filename(lora.get("filename"))
        except PathError as exc:
            raise InputError(str(exc)) from None
        strength = _number(lora, "strength", float, -5.0, 5.0, required=False)
        clean_loras.append({"filename": fn, "strength": 1.0 if strength is None else strength})

    return {
        "model": mid, "prompt": prompt, "negativePrompt": neg,
        "width": width, "height": height, "seed": seed, "steps": steps, "cfg": cfg,
        "references": decoded, "loras": clean_loras,
    }


def missing_files(model: dict, loras: list[dict]) -> list[str]:
    wanted = [(f["folder"], f["filename"]) for f in model["files"]]
    wanted += [(f"loras/{model['id']}", l["filename"]) for l in loras]
    return [f"{folder}/{fn}" for folder, fn in wanted
            if not (MODELS_ROOT / folder / fn).is_file()]


# ---------------------------------------------------------------------------
# generate
# ---------------------------------------------------------------------------
def _watch(client: ComfyClient, ws, prompt_id: str, samplers: set[str], total_steps: int,
           progress: Throttle, t_queued: float) -> dict:
    """Follows the ComfyUI websocket until the prompt finishes.

    Returns {"error": str} or {"sample_start": t|None, "sample_end": t|None}.
    loadMs = first sampler progress event - queue time (model loading happens
    lazily inside the sampler node, so "executing" is too early a marker).
    """
    deadline = t_queued + GENERATE_TIMEOUT_S
    sample_start = sample_end = None
    interrupted = False
    for msg in client.iter_messages(ws):
        now = clock()
        if not interrupted and cancelled(progress.job):
            # Pod mode: covers a cancel that raced queue_prompt.
            interrupted = True
            client.interrupt()
        if msg is None:
            if now > deadline:
                return {"error": f"COMFYUI_TIMEOUT: no result after {GENERATE_TIMEOUT_S:.0f}s"}
            hist = client.history(prompt_id)
            if hist.get("status", {}).get("completed"):
                break
            if hist.get("status", {}).get("status_str") == "error":
                return {"error": _history_error(hist)}
            continue
        mtype, data = msg.get("type"), msg.get("data") or {}
        if data.get("prompt_id") not in (None, prompt_id):
            continue
        if mtype == "progress" and data.get("node") in samplers:
            if sample_start is None:
                sample_start = now
            step, mx = int(data.get("value", 0)), int(data.get("max", total_steps))
            progress({"phase": "sampling", "step": step, "totalSteps": mx},
                     force=step >= mx)
        elif mtype == "executing":
            node = data.get("node")
            if node is None:
                if data.get("prompt_id") == prompt_id:
                    break
            elif node not in samplers and sample_start is not None and sample_end is None:
                sample_end = now
                progress({"phase": "saving", "step": total_steps, "totalSteps": total_steps},
                         force=True)
        elif mtype == "execution_error" and data.get("prompt_id") == prompt_id:
            return {"error": format_execution_error(data)}
        elif mtype == "execution_interrupted" and data.get("prompt_id") == prompt_id:
            return {"error": f"COMFYUI_INTERRUPTED: node {data.get('node_id')} "
                             f"({data.get('node_type')})"}
        elif mtype == "execution_success" and data.get("prompt_id") == prompt_id:
            break
    if sample_start is not None and sample_end is None:
        sample_end = clock()
    return {"sample_start": sample_start, "sample_end": sample_end}


def format_execution_error(data: dict) -> str:
    msg = str(data.get("exception_message", "")).strip()
    etype = str(data.get("exception_type", "")).rsplit(".", 1)[-1]
    return (f"COMFYUI_EXECUTION_ERROR: node {data.get('node_id')} ({data.get('node_type')}): "
            f"{etype + ': ' if etype else ''}{msg}")


def _history_error(hist: dict) -> str:
    for kind, data in hist.get("status", {}).get("messages", []):
        if kind == "execution_error":
            return format_execution_error(data)
    return "COMFYUI_EXECUTION_ERROR: unknown error"


def do_generate(job: dict, inp: dict) -> dict:
    t0 = clock()
    registry = load_registry()
    params = validate_generate(inp, registry)
    model = get_model(registry, params["model"])
    missing = missing_files(model, params["loras"])
    if missing:
        return {"error": "MODEL_NOT_INSTALLED: " + ", ".join(missing)}

    steps = params["steps"] or model["defaults"]["steps"]
    progress = Throttle(job)
    progress({"phase": "loading", "step": 0, "totalSteps": steps}, force=True)

    client = make_client()
    client.wait_ready(COMFY_READY_TIMEOUT_S)

    tag = uuid.uuid4().hex[:12]
    ref_names = []
    for i, (data, ext, mime) in enumerate(params["references"], start=1):
        ref_names.append(client.upload_image(f"is_{tag}_ref{i}.{ext}", data, mime))

    graph, out_node = build_workflow({**params, "references": ref_names}, registry)
    samplers = sampler_node_ids(graph)

    if cancelled(job):
        return {"error": "CANCELLED: cancelled before the prompt was queued"}
    ws = client.connect_ws()
    try:
        t_queued = clock()
        prompt_id = client.queue_prompt(graph)
        res = _watch(client, ws, prompt_id, samplers, steps, progress, t_queued)
    finally:
        try:
            ws.close()
        except Exception:
            pass
    if "error" in res:
        return res

    progress({"phase": "saving", "step": steps, "totalSteps": steps}, force=True)
    hist = client.history(prompt_id)
    images = (hist.get("outputs", {}).get(out_node) or {}).get("images") or []
    if not images:
        if hist.get("status", {}).get("status_str") == "error":
            return {"error": _history_error(hist)}
        return {"error": "COMFYUI_NO_OUTPUT: the workflow produced no image"}
    img = images[0]
    data = client.view(img["filename"], img.get("subfolder", ""), img.get("type", "output"))
    size = png_size(data) or (params["width"], params["height"])
    _cleanup(img, ref_names)

    t_end = clock()
    s0, s1 = res["sample_start"], res["sample_end"]
    load_ms = _ms((s0 if s0 is not None else t_end) - t0)
    sample_ms = _ms(s1 - s0) if s0 is not None and s1 is not None else 0
    return {
        "image": {"base64": base64.b64encode(data).decode("ascii"), "seed": params["seed"],
                  "width": size[0], "height": size[1]},
        "timings": {"loadMs": load_ms, "sampleMs": sample_ms, "totalMs": _ms(t_end - t0)},
    }


def _cleanup(img: dict, ref_names: list[str]) -> None:
    """Best effort: keep the container disk clean between jobs."""
    targets = [COMFYUI_PATH / "output" / img.get("subfolder", "") / img["filename"]]
    targets += [COMFYUI_PATH / "input" / n for n in ref_names]
    for t in targets:
        try:
            t.unlink(missing_ok=True)
        except OSError:
            pass


# ---------------------------------------------------------------------------
# status
# ---------------------------------------------------------------------------
def comfyui_version() -> str | None:
    try:
        text = (COMFYUI_PATH / "comfyui_version.py").read_text()
    except OSError:
        return None
    m = re.search(r"__version__\s*=\s*['\"]([^'\"]+)['\"]", text)
    return m.group(1) if m else None


def _list_dir(folder: str) -> list[dict]:
    out = []
    d = MODELS_ROOT / folder
    if not d.is_dir():
        return out
    for p in sorted(d.iterdir()):
        if p.is_file() and not p.is_symlink() and p.name.endswith(".safetensors"):
            out.append({"folder": folder, "filename": p.name, "sizeBytes": p.stat().st_size})
    return out


def do_status(job: dict, inp: dict) -> dict:
    files: list[dict] = []
    for folder in LISTED_FOLDERS:
        files += _list_dir(folder)
    loras = MODELS_ROOT / "loras"
    if loras.is_dir():
        for sub in sorted(loras.iterdir()):
            if sub.is_dir() and not sub.is_symlink():
                files += _list_dir(f"loras/{sub.name}")
    try:
        usage = shutil.disk_usage(VOLUME_ROOT)
        volume = {"totalBytes": usage.total, "freeBytes": usage.free}
    except OSError:
        volume = {"totalBytes": 0, "freeBytes": 0}
    return {"files": files, "volume": volume, "comfyuiVersion": comfyui_version()}


# ---------------------------------------------------------------------------
# download / delete
# ---------------------------------------------------------------------------
def _file_list(inp: dict) -> list[dict]:
    files = inp.get("files")
    if not isinstance(files, list) or not files:
        raise InputError("INVALID_INPUT: files must be a non-empty list")
    if not all(isinstance(f, dict) for f in files):
        raise InputError("INVALID_INPUT: each file must be an object")
    return files


def do_download(job: dict, inp: dict) -> dict:
    registry = load_registry()
    ids = model_ids(registry)
    plan = []
    for f in _file_list(inp):
        dest = resolve(MODELS_ROOT, f.get("folder"), f.get("filename"), ids)
        url = f.get("url")
        if not isinstance(url, str) or not url:
            raise InputError(f"INVALID_INPUT: url is required for {f.get('filename')}")
        size = f.get("sizeBytes")
        if size is not None and (isinstance(size, bool) or not isinstance(size, int) or size < 0):
            raise InputError(f"INVALID_INPUT: sizeBytes of {f['filename']}")
        sha = f.get("sha256")
        if sha is not None and not (isinstance(sha, str) and re.fullmatch(r"[0-9a-fA-F]{64}", sha)):
            raise InputError(f"INVALID_INPUT: sha256 of {f['filename']}")
        if any(p[0] == dest for p in plan):
            continue  # same file listed twice: download it once
        plan.append((dest, url, size, sha))

    return _run_downloads(job, plan)


def _run_downloads(job: dict, plan: list[tuple[Path, str, int | None, str | None]]) -> dict:
    """Downloads up to DOWNLOAD_CONCURRENCY files at once.

    Single HF streams to RunPod often run at 10-50 MB/s while the volume
    takes 200-400 MB/s, so files are fetched in parallel. Each file keeps the
    full per-file behaviour (.part, Range resume, sha256, stall guard, auth
    dropped on cross-host redirect). Progress is aggregated across files.
    """
    progress = Throttle(job)
    lock = threading.Lock()
    state = {
        str(dest): {"filename": dest.name, "bytes": 0, "totalBytes": size, "status": "queued"}
        for dest, _, size, _ in plan
    }
    transferred: dict[str, int] = {}

    def snapshot(force: bool = False, current: str | None = None) -> None:
        with lock:
            files = [dict(v) for v in state.values()]
            total_known = all(f["totalBytes"] is not None for f in files)
            payload = {
                "phase": "downloading",
                "file": current,
                "bytes": sum(f["bytes"] for f in files),
                "totalBytes": sum(f["totalBytes"] for f in files) if total_known else None,
                "files": files,
            }
            progress(payload, force=force)

    cfg = DownloadConfig.from_env()

    def one(item) -> bool:
        dest, url, size, sha = item
        name, key = dest.name, str(dest)
        part = dest.with_name(name + ".part")
        before = part.stat().st_size if part.exists() else 0
        if cancelled(job):
            raise JobCancelled(f"CANCELLED: {name}")
        with lock:
            state[key]["status"] = "downloading"

        def on_progress(b: int, total: int | None) -> None:
            if cancelled(job):  # pod mode: stop at the next chunk; .part is kept
                raise JobCancelled(f"CANCELLED: {name}")
            with lock:
                state[key]["bytes"] = b
                if total is not None:
                    state[key]["totalBytes"] = total
            snapshot(current=name)

        snapshot(force=True, current=name)
        try:
            did = download_file(url, dest, size, sha, cfg=cfg, on_progress=on_progress)
        except Exception:
            with lock:
                state[key]["status"] = "failed"
            snapshot(force=True, current=name)
            raise
        final = dest.stat().st_size
        with lock:
            state[key].update(bytes=final, totalBytes=final,
                               status="downloaded" if did else "skipped")
            transferred[key] = max(0, final - before) if did else 0
        snapshot(force=True, current=name)
        return did

    t0 = clock()
    downloaded, skipped, errors = [], [], []
    with ThreadPoolExecutor(max_workers=DOWNLOAD_CONCURRENCY) as pool:
        futures = [(item[0].name, pool.submit(one, item)) for item in plan]
        for name, fut in futures:  # results reported in request order
            try:
                (downloaded if fut.result() else skipped).append(name)
            except Exception as exc:
                errors.append(str(exc) if isinstance(exc, (DownloadError, OSError, JobCancelled))
                              else f"{name}: {type(exc).__name__}: {exc}")
    elapsed = max(clock() - t0, 1e-6)
    snapshot(force=True)
    if errors:
        return {"error": "DOWNLOAD_FAILED: " + "; ".join(errors)
                + (f" (completed: {', '.join(downloaded + skipped)})" if downloaded or skipped else "")}
    moved = sum(transferred.values())
    return {"downloaded": downloaded, "skipped": skipped,
            "elapsedMs": _ms(elapsed), "avgMBps": round(moved / 1e6 / elapsed, 2)}


def do_delete(job: dict, inp: dict) -> dict:
    registry = load_registry()
    ids = model_ids(registry)
    targets = [resolve(MODELS_ROOT, f.get("folder"), f.get("filename"), ids)
               for f in _file_list(inp)]
    deleted, missing = [], []
    for path in targets:
        part = path.with_name(path.name + ".part")
        part.unlink(missing_ok=True)
        if path.is_file():
            path.unlink()
            deleted.append(path.name)
        else:
            missing.append(path.name)
    # Free ComfyUI's loaded models so deleted weights don't linger in (V)RAM.
    # Best effort: if ComfyUI isn't up yet nothing is loaded anyway.
    client = make_client()
    if client.is_up():
        client.free()
    return {"deleted": deleted, "missing": missing}


# ---------------------------------------------------------------------------
# entry point
# ---------------------------------------------------------------------------
ACTIONS = {
    "generate": do_generate,
    "status": do_status,
    "download": do_download,
    "delete": do_delete,
}


def handler(job: dict) -> dict:
    inp = job.get("input") or {}
    action = inp.get("action")
    fn = ACTIONS.get(action)
    if fn is None:
        return {"error": f"UNKNOWN_ACTION: {action!r} (expected one of {sorted(ACTIONS)})"}
    try:
        return fn(job, inp)
    except (InputError, PathError, WorkflowError, ComfyError, DownloadError, JobCancelled) as exc:
        return {"error": str(exc)}
    except Exception as exc:  # never leak a raw traceback blob to the app
        traceback.print_exc()
        return {"error": f"INTERNAL_ERROR: {type(exc).__name__}: {exc}"}


def main() -> None:
    if os.environ.get("MODE", "").strip().lower() == "pod":
        import server  # the /image_studio copy; imports `handler` from PYTHONPATH
        server.main()
    else:
        runpod.serverless.start({"handler": handler})


if __name__ == "__main__":
    main()
