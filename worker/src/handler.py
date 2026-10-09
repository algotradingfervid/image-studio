"""Image Studio RunPod Serverless handler.

Runtime image (spec "v4"): worker/boot/boot.py fetches this directory from
GitHub (WORKER_REF) into /app/src (fallback: the baked /app-baked/src), starts
ComfyUI in the background and then execs `python -u <dir>/handler.py`.
Legacy image: installed as /handler.py; the base image's /start.sh starts
ComfyUI and then runs it.

Actions (docs/spec.md, "Worker job protocol"):
  generate  {model, prompt, negativePrompt, width, height, seed, steps, cfg,
             references: [{name, base64}], loras: [{filename, strength}],
             initImage?: {name, base64}, denoise?: 0.05-1.0 (default 0.6)}
            -> {image: {base64, seed, width, height}, timings: {loadMs, sampleMs, totalMs}}
            initImage (img2img, models with supportsImg2Img only): the output
            size follows the start image (1 MP, multiples of 16); width and
            height are then optional and ignored.
  status    -> {files: [{folder, filename, sizeBytes}], volume: {totalBytes, freeBytes},
                comfyuiVersion}
  download  {files: [{folder, filename, url, sizeBytes?, sha256?}]}
            -> {downloaded: [filename], skipped: [filename], elapsedMs, avgMBps}
            (up to 3 files in parallel; progress is aggregated, see _run_downloads)
  delete    {files: [{folder, filename}]} -> {deleted: [filename], missing: [filename]}
  generate_video (spec "v5")
            {model: "h3" | "ltx25", prompt, negativePrompt?, initImage?: {name, base64},
             durationS, fps, resolution: "WxH", seed?, steps?, cfg?, audio: bool}
            -> {video: {base64, mime: "video/mp4", width, height, fps, frames, durationS,
                        hasAudio},
                poster: {base64, mime: "image/jpeg", width, height},
                seed, timings: {loadMs, sampleMs, encodeMs, totalMs}}
            initImage makes it image->video; the output keeps its aspect ratio
            at the preset's pixel count. See worker/README.md.

Failures are returned as {"error": "<CODE>: <detail>"}; the RunPod SDK then
marks the job FAILED with that message.

Pod mode (MODE=pod, docs/spec.md "v3 change"): the same entrypoint runs this
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

import local_models
from comfy_client import ComfyClient, ComfyError
from downloader import DownloadConfig, DownloadError, download_file
from registry import get_model, get_video_model, load_registry, model_ids, video_model_ids
from safe_paths import PathError, resolve, validate_filename, validate_folder
from workflows import (DEFAULT_DENOISE, LOADER_STAGES, MAX_DENOISE, MIN_DENOISE, STAGE_PHASE,
                       WorkflowError, build_video_workflow, build_workflow, graph_node_stages,
                       graph_stages, init_image_size, sampler_node_ids)

VOLUME_ROOT = Path(os.environ.get("VOLUME_ROOT", "/runpod-volume"))
MODELS_ROOT = Path(os.environ.get("MODELS_ROOT", str(VOLUME_ROOT / "models")))
COMFYUI_PATH = Path(os.environ.get("COMFYUI_PATH", "/comfyui"))
COMFY_READY_TIMEOUT_S = float(os.environ.get("COMFY_READY_TIMEOUT_S", "300"))
GENERATE_TIMEOUT_S = float(os.environ.get("GENERATE_TIMEOUT_S", "590"))
# Video sampling + decode + encode of a 15-20 s clip can take well over 10 min.
VIDEO_TIMEOUT_S = float(os.environ.get("VIDEO_TIMEOUT_S", "3000"))
PROGRESS_MIN_INTERVAL_S = 0.5   # <= 2 progress updates per second
DOWNLOAD_CONCURRENCY = int(os.environ.get("DOWNLOAD_CONCURRENCY", "3"))
# Longest a job waits for its model's local copies (pod mode, local_models.py)
# before loading the rest from the network volume.
LOCAL_COPY_WAIT_S = local_models.wait_timeout_s()
COPY_STAGE = "copying_models"

MAX_LORAS = 3
MAX_SEED = 2**64 - 1
MIN_SIDE, MAX_SIDE = 64, 4096
MAX_STEPS = 200
LISTED_FOLDERS = ("unet", "clip", "vae", "latent_upscale_models")

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


def _decode_image(ref: Any, code: str, what: str) -> tuple[bytes, str, str]:
    if not isinstance(ref, dict) or not isinstance(ref.get("base64"), str):
        raise InputError(f"{code}: {what} needs {{name, base64}}")
    b64 = ref["base64"]
    if b64.startswith("data:"):
        b64 = b64.split(",", 1)[-1]
    try:
        data = base64.b64decode(b64, validate=True)
    except (binascii.Error, ValueError):
        raise InputError(f"{code}: {what} is not valid base64") from None
    for magic, ext, mime in _IMAGE_MAGIC:
        if data.startswith(magic) and (ext != "webp" or data[8:12] == b"WEBP"):
            return data, ext, mime
    raise InputError(f"{code}: {what} is not a PNG, JPEG or WebP image")


def _decode_reference(ref: Any, index: int) -> tuple[bytes, str, str]:
    return _decode_image(ref, "INVALID_REFERENCE", f"reference {index}")


def _jpeg_exif_transposed(seg: bytes) -> bool:
    """True if an APP1 Exif segment has an orientation that swaps the sides (5-8)."""
    if not seg.startswith(b"Exif\x00\x00") or len(seg) < 14:
        return False
    tiff = seg[6:]
    bo = {b"II": "<", b"MM": ">"}.get(tiff[:2])
    if bo is None:
        return False
    try:
        (ifd,) = struct.unpack(bo + "I", tiff[4:8])
        (count,) = struct.unpack(bo + "H", tiff[ifd:ifd + 2])
        for i in range(count):
            e = ifd + 2 + 12 * i
            tag, _typ, _n = struct.unpack(bo + "HHI", tiff[e:e + 8])
            if tag == 0x0112:
                (value,) = struct.unpack(bo + "H", tiff[e + 8:e + 10])
                return value in (5, 6, 7, 8)
    except struct.error:
        return False
    return False


def image_size(data: bytes, ext: str) -> tuple[int, int] | None:
    """Pixel size of a PNG / JPEG / WebP as ComfyUI's LoadImage sees it
    (JPEG EXIF orientation applied). None if the header can't be read."""
    try:
        if ext == "png":
            return png_size(data)
        if ext == "webp":
            chunk = data[12:16]
            if chunk == b"VP8 ":
                w, h = struct.unpack("<HH", data[26:30])
                return w & 0x3FFF, h & 0x3FFF
            if chunk == b"VP8L":
                b = data[21:25]
                w = 1 + (((b[1] & 0x3F) << 8) | b[0])
                h = 1 + (((b[3] & 0x0F) << 10) | (b[2] << 2) | ((b[1] & 0xC0) >> 6))
                return w, h
            if chunk == b"VP8X":
                w = 1 + int.from_bytes(data[24:27], "little")
                h = 1 + int.from_bytes(data[27:30], "little")
                return w, h
            return None
        if ext == "jpg":
            i, transposed = 2, False
            while i + 4 <= len(data):
                if data[i] != 0xFF:
                    return None
                marker = data[i + 1]
                if marker in (0xD8, 0x01) or 0xD0 <= marker <= 0xD7:
                    i += 2
                    continue
                (length,) = struct.unpack(">H", data[i + 2:i + 4])
                if marker == 0xE1:
                    transposed = transposed or _jpeg_exif_transposed(data[i + 4:i + 2 + length])
                if marker in (0xC0, 0xC1, 0xC2, 0xC3, 0xC5, 0xC6, 0xC7, 0xC9, 0xCA, 0xCB,
                              0xCD, 0xCE, 0xCF):
                    h, w = struct.unpack(">HH", data[i + 5:i + 9])
                    return (h, w) if transposed else (w, h)
                if marker == 0xDA:
                    return None
                i += 2 + length
    except (struct.error, IndexError):
        return None
    return None


def _decode_init_image(inp: dict, model: dict) -> dict | None:
    init = inp.get("initImage")
    if init is None:
        return None
    if not model.get("supportsImg2Img", False):
        raise InputError(f"IMG2IMG_NOT_SUPPORTED: {model['id']} does not accept a start image "
                         "(initImage)")
    data, ext, mime = _decode_image(init, "INVALID_INIT_IMAGE", "initImage")
    size = image_size(data, ext)
    if size is None or size[0] <= 0 or size[1] <= 0:
        raise InputError("INVALID_INIT_IMAGE: could not read the size of initImage")
    return {"data": data, "ext": ext, "mime": mime, "width": size[0], "height": size[1]}


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
    init = _decode_init_image(inp, model)
    # With a start image the output size follows it; width/height are ignored.
    width = _number(inp, "width", int, MIN_SIDE, MAX_SIDE, required=init is None)
    height = _number(inp, "height", int, MIN_SIDE, MAX_SIDE, required=init is None)
    if init is None and (width % 16 or height % 16):
        raise InputError("INVALID_INPUT: width and height must be multiples of 16")
    denoise = None
    if init is not None:
        denoise = _number(inp, "denoise", float, MIN_DENOISE, MAX_DENOISE, required=False)
        if denoise is None:
            denoise = DEFAULT_DENOISE
        width, height = init_image_size(init["width"], init["height"])
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
        "initImage": init, "denoise": denoise,
    }


def missing_files(model: dict, loras: list[dict]) -> list[str]:
    wanted = [(f["folder"], f["filename"]) for f in model["files"]]
    wanted += [(f"loras/{model['id']}", l["filename"]) for l in loras]
    return [f"{folder}/{fn}" for folder, fn in wanted
            if not (MODELS_ROOT / folder / fn).is_file()]


# ---------------------------------------------------------------------------
# generate
# ---------------------------------------------------------------------------
class StageTracker:
    """Turns ComfyUI websocket events into the generate progress payload.

    Payload (every field always present):
      phase           "loading" | "sampling" | "saving" (v1 back-compat)
      stage           current stage, one of workflows.STAGES
      stages          the stages that apply to this graph, in display order
      step, totalSteps
      elapsedMs       since the job started
      stageElapsedMs  since the current stage started
      cached          True once ComfyUI reported a loader stage as cached
                      (weights already in memory)
      cachedStages    the stages whose nodes were all cached (instant)
      stageTimes      {stage: ms} accumulated time of the stages already left
    and, only while/after a "copying_models" stage (pod mode, local_models.py):
      copyPercent, copyBytes, copyTotalBytes

    Stage transitions are sent immediately (forced); step updates go through
    the Throttle (<= 2/s) except the final step.
    """

    def __init__(self, progress: Throttle, graph: dict, total_steps: int, t0: float,
                 pre_stages: tuple[str, ...] = ()):
        self.progress = progress
        self.pre_stages = list(pre_stages)
        self.copy: dict | None = None
        self.job = progress.job
        self.t0 = t0
        self.total = total_steps
        self.step = 0
        self.cached_stages: set[str] = set()
        self.times: dict[str, int] = {}
        self.set_graph(graph)
        self.stage = self.stages[0]
        self.stage_start = clock()

    def set_graph(self, graph: dict) -> None:
        self.node_stages = graph_node_stages(graph)
        self.stages = self.pre_stages + graph_stages(graph)

    def payload(self) -> dict:
        now = clock()
        return {
            "phase": STAGE_PHASE[self.stage],
            "stage": self.stage,
            "stages": list(self.stages),
            "step": self.step,
            "totalSteps": self.total,
            "elapsedMs": _ms(now - self.t0),
            "stageElapsedMs": _ms(now - self.stage_start),
            "cached": bool(self.cached_stages & LOADER_STAGES),
            "cachedStages": [s for s in self.stages if s in self.cached_stages],
            "stageTimes": dict(self.times),
            **(self.copy or {}),
        }

    def send(self, force: bool = False) -> None:
        self.progress(self.payload(), force=force)

    def enter(self, stage: str) -> None:
        if stage == self.stage:
            return
        now = clock()
        self.times[self.stage] = self.times.get(self.stage, 0) + _ms(now - self.stage_start)
        self.stage, self.stage_start = stage, now
        if stage in ("decoding", "video_decoding", "audio_decoding", "encoding_video", "saving"):
            self.step = self.total
        self.send(force=True)

    def on_copy_progress(self, done: int, total: int) -> None:
        pct = 100 if total <= 0 else min(100, int(done * 100 // total))
        before = self.copy
        self.copy = {"copyPercent": pct, "copyBytes": done, "copyTotalBytes": total}
        if before != self.copy:
            self.send(force=pct >= 100)

    def leave_pre_stages(self) -> None:
        """After the copy wait: move to the first graph stage."""
        if self.stage in self.pre_stages and len(self.stages) > len(self.pre_stages):
            self.enter(self.stages[len(self.pre_stages)])

    def on_executing(self, node: str) -> None:
        stage = self.node_stages.get(node)
        if stage is not None:
            self.enter(stage)

    def on_progress(self, step: int, total: int) -> None:
        self.step, self.total = step, total
        if self.stage != "sampling":
            self.enter("sampling")
        else:
            self.send(force=step >= total)

    def on_cached(self, nodes: list) -> None:
        cached = {str(n) for n in nodes or []}
        before = set(self.cached_stages)
        for stage in self.stages:
            members = [n for n, s in self.node_stages.items() if s == stage]
            if members and all(n in cached for n in members):
                self.cached_stages.add(stage)
        if self.cached_stages != before:
            self.send(force=True)


def _watch(client: ComfyClient, ws, prompt_id: str, samplers: set[str], total_steps: int,
           progress: Throttle, t_queued: float, tracker: StageTracker | None = None,
           step_offsets: dict[str, int] | None = None,
           timeout_s: float | None = None) -> dict:
    """Follows the ComfyUI websocket until the prompt finishes.

    Returns {"error": str} or {"sample_start": t|None, "sample_end": t|None}.
    loadMs = first sampler progress event - queue time (model loading happens
    lazily inside the sampler node, so "executing" is too early a marker).
    step_offsets (video, several samplers in a row): {sampler node: steps of
    the samplers before it}, so step/totalSteps count across all of them; a
    later sampler's progress also moves sample_end past the nodes in between.
    """
    if tracker is None:
        tracker = StageTracker(progress, {}, total_steps, t_queued)
    timeout_s = GENERATE_TIMEOUT_S if timeout_s is None else timeout_s
    deadline = t_queued + timeout_s
    sample_start = sample_end = None
    interrupted = False
    for msg in client.iter_messages(ws):
        now = clock()
        if not interrupted and cancelled(tracker.job):
            # Pod mode: covers a cancel that raced queue_prompt.
            interrupted = True
            client.interrupt()
        if msg is None:
            if now > deadline:
                return {"error": f"COMFYUI_TIMEOUT: no result after {timeout_s:.0f}s"}
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
            if step_offsets is not None:
                sample_end = None  # still sampling (e.g. LTX stage 2 after the upscaler)
                tracker.on_progress(step_offsets.get(data.get("node"), 0) + int(data.get("value", 0)),
                                    total_steps)
            else:
                tracker.on_progress(int(data.get("value", 0)),
                                    int(data.get("max", tracker.total)))
        elif mtype == "execution_cached":
            tracker.on_cached(data.get("nodes") or [])
        elif mtype == "executing":
            node = data.get("node")
            if node is None:
                if data.get("prompt_id") == prompt_id:
                    break
                continue
            if node not in samplers and sample_start is not None and sample_end is None:
                sample_end = now
            tracker.on_executing(str(node))
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


def _wait_local_copies(job: dict, entries: list, tracker: StageTracker) -> dict | None:
    """Pod mode: waits for the job's model files to reach the container disk
    (stage "copying_models"). Never fails the job because of the copier: on a
    copier error or after LOCAL_COPY_WAIT_S the remaining files load from the
    network volume. Returns an error dict only when the job was cancelled."""
    try:
        m = local_models.get()
        if m is not None:
            res = m.wait(entries, timeout=LOCAL_COPY_WAIT_S, cancel=job.get(CANCEL_EVENT),
                         on_progress=tracker.on_copy_progress)
            if res["fallback"]:
                print(f"local copy: loading {', '.join(res['fallback'])} from the network volume"
                      + (" (wait timed out)" if res["timedOut"] else ""), flush=True)
    except Exception:  # the copier must never fail a job
        traceback.print_exc()
    if cancelled(job):
        return {"error": "CANCELLED: cancelled while copying the model to local disk"}
    tracker.leave_pre_stages()
    return None


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
    # The stage list only depends on the graph's shape, so a preview graph with
    # placeholder reference names gives it before anything is uploaded.
    init = params["initImage"]

    def graph_init(name: str) -> dict | None:
        if init is None:
            return None
        return {"name": name, "width": init["width"], "height": init["height"]}

    preview, _ = build_workflow(
        {**params, "references": [f"ref{i}" for i in range(len(params["references"]))],
         "initImage": graph_init("init")},
        registry)
    copies = local_models.begin_for_job(params["model"])
    tracker = StageTracker(progress, preview, steps, t0,
                           pre_stages=(COPY_STAGE,) if copies else ())
    tracker.send(force=True)
    if copies:
        err = _wait_local_copies(job, copies, tracker)
        if err:
            return err

    client = make_client()
    client.wait_ready(COMFY_READY_TIMEOUT_S)

    tag = uuid.uuid4().hex[:12]
    ref_names = []
    for i, (data, ext, mime) in enumerate(params["references"], start=1):
        ref_names.append(client.upload_image(f"is_{tag}_ref{i}.{ext}", data, mime))
    upload_names = list(ref_names)
    init_name = None
    if init is not None:
        init_name = client.upload_image(f"is_{tag}_init.{init['ext']}", init["data"], init["mime"])
        upload_names.append(init_name)

    graph, out_node = build_workflow(
        {**params, "references": ref_names, "initImage": graph_init(init_name)}, registry)
    samplers = sampler_node_ids(graph)
    tracker.set_graph(graph)

    if cancelled(job):
        return {"error": "CANCELLED: cancelled before the prompt was queued"}
    ws = client.connect_ws()
    try:
        t_queued = clock()
        prompt_id = client.queue_prompt(graph)
        res = _watch(client, ws, prompt_id, samplers, steps, progress, t_queued, tracker)
    finally:
        try:
            ws.close()
        except Exception:
            pass
    if "error" in res:
        return res

    tracker.enter("saving")
    hist = client.history(prompt_id)
    images = (hist.get("outputs", {}).get(out_node) or {}).get("images") or []
    if not images:
        if hist.get("status", {}).get("status_str") == "error":
            return {"error": _history_error(hist)}
        return {"error": "COMFYUI_NO_OUTPUT: the workflow produced no image"}
    img = images[0]
    data = client.view(img["filename"], img.get("subfolder", ""), img.get("type", "output"))
    size = png_size(data) or (params["width"], params["height"])
    _cleanup(img, upload_names)

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
# generate_video (spec "v5")
# ---------------------------------------------------------------------------
MAX_VIDEO_STEPS = 100
POSTER_JPEG_QUALITY = 90


def validate_generate_video(inp: dict, registry: dict) -> dict:
    mid = inp.get("model")
    if mid not in video_model_ids(registry):
        raise InputError(f"UNKNOWN_MODEL: {mid!r} (video models: "
                         f"{', '.join(video_model_ids(registry))})")
    model = get_video_model(registry, mid)
    d, lim = model["defaults"], model["limits"]
    prompt = inp.get("prompt")
    if not isinstance(prompt, str) or not prompt.strip():
        raise InputError("INVALID_INPUT: prompt is required")
    neg = inp.get("negativePrompt")
    if neg is not None and not isinstance(neg, str):
        raise InputError("INVALID_INPUT: negativePrompt must be a string")
    init = None
    if inp.get("initImage") is not None:
        if "i2v" not in model.get("modes", []):
            raise InputError(f"I2V_NOT_SUPPORTED: {mid} does not accept a start image")
        data, ext, mime = _decode_image(inp["initImage"], "INVALID_INIT_IMAGE", "initImage")
        size = image_size(data, ext)
        if size is None or size[0] <= 0 or size[1] <= 0:
            raise InputError("INVALID_INIT_IMAGE: could not read the size of initImage")
        init = {"data": data, "ext": ext, "mime": mime, "width": size[0], "height": size[1]}
    duration = _number(inp, "durationS", float, float(lim.get("minDurationS", 0)),
                       float(lim["maxDurationS"]), required=False)
    fps = _number(inp, "fps", float, 1, 120, required=False)
    if fps is not None and (not fps.is_integer() or int(fps) not in lim["fpsOptions"]):
        raise InputError(f"INVALID_INPUT: fps must be one of {lim['fpsOptions']} for {mid}")
    resolution = inp.get("resolution")
    if resolution is not None:
        if not isinstance(resolution, str) or resolution not in lim["resolutions"]:
            raise InputError(f"INVALID_INPUT: resolution must be one of "
                             f"{', '.join(lim['resolutions'])} for {mid}")
    seed = _number(inp, "seed", int, 0, MAX_SEED, required=False)
    if seed is None:
        seed = random.randint(0, 2**53 - 1)
    steps = _number(inp, "steps", int, 1, MAX_VIDEO_STEPS, required=False)
    cfg = _number(inp, "cfg", float, 0.0, 30.0, required=False)
    audio = inp.get("audio", True)
    if not isinstance(audio, bool):
        raise InputError("INVALID_INPUT: audio must be true or false")
    return {
        "model": mid, "prompt": prompt, "negativePrompt": neg,
        "durationS": d["durationS"] if duration is None else duration,
        "fps": int(d["fps"] if fps is None else fps),
        "resolution": d["resolution"] if resolution is None else resolution,
        "seed": seed, "steps": steps, "cfg": cfg, "audio": audio, "initImage": init,
    }


def mp4_info(data: bytes) -> dict | None:
    """Reads an MP4's moov box: {width, height, frames, fps, durationS,
    hasAudio} from the first video track (tkhd size, mdhd duration/timescale,
    stsz sample count) and whether a sound track exists. None if unreadable.
    Standard library only (ISO/IEC 14496-12 box layout)."""

    def boxes(buf: bytes, start: int, end: int):
        i = start
        while i + 8 <= end:
            size, kind = struct.unpack(">I4s", buf[i:i + 8])
            hdr = 8
            if size == 1:
                if i + 16 > end:
                    return
                (size,) = struct.unpack(">Q", buf[i + 8:i + 16])
                hdr = 16
            elif size == 0:
                size = end - i
            if size < hdr or i + size > end:
                return
            yield kind, i + hdr, i + size
            i += size

    def child(buf, start, end, kind):
        return next(((s, e) for k, s, e in boxes(buf, start, end) if k == kind), None)

    try:
        moov = child(data, 0, len(data), b"moov")
        if moov is None:
            return None
        video, has_audio = None, False
        for kind, s, e in boxes(data, *moov):
            if kind != b"trak":
                continue
            mdia = child(data, s, e, b"mdia")
            hdlr = mdia and child(data, *mdia, b"hdlr")
            if not hdlr:
                continue
            handler_type = data[hdlr[0] + 8:hdlr[0] + 12]
            if handler_type == b"soun":
                has_audio = True
            elif handler_type == b"vide" and video is None:
                tkhd = child(data, s, e, b"tkhd")
                mdhd = child(data, *mdia, b"mdhd")
                minf = child(data, *mdia, b"minf")
                stbl = minf and child(data, *minf, b"stbl")
                stsz = stbl and child(data, *stbl, b"stsz")
                if not (tkhd and mdhd and stsz):
                    continue
                w, h = struct.unpack(">II", data[tkhd[1] - 8:tkhd[1]])
                ver = data[mdhd[0]]
                if ver == 1:
                    timescale, duration = struct.unpack(">IQ", data[mdhd[0] + 20:mdhd[0] + 32])
                else:
                    timescale, duration = struct.unpack(">II", data[mdhd[0] + 12:mdhd[0] + 20])
                (frames,) = struct.unpack(">I", data[stsz[0] + 8:stsz[0] + 12])
                video = {"width": w >> 16, "height": h >> 16, "frames": frames,
                         "durationS": round(duration / timescale, 3) if timescale else None}
        if video is None:
            return None
        video["hasAudio"] = has_audio
        if video["durationS"]:
            video["fps"] = round(video["frames"] / video["durationS"], 3)
        return video
    except (struct.error, IndexError, TypeError):
        return None


def poster_jpeg(png: bytes) -> tuple[bytes, str]:
    """Frame-0 PNG -> JPEG (q90) with Pillow (installed with ComfyUI in the
    image). Without Pillow the PNG is returned as is."""
    try:
        from io import BytesIO

        from PIL import Image
    except ImportError:
        return png, "image/png"
    with Image.open(BytesIO(png)) as im:
        out = BytesIO()
        im.convert("RGB").save(out, "JPEG", quality=POSTER_JPEG_QUALITY)
    return out.getvalue(), "image/jpeg"


def missing_video_files(model: dict) -> list[str]:
    return [f"{f['folder']}/{f['filename']}" for f in model["files"]
            if not (MODELS_ROOT / f["folder"] / f["filename"]).is_file()]


def _first_output(hist: dict, node: str) -> dict | None:
    items = (hist.get("outputs", {}).get(node) or {}).get("images") or []
    return items[0] if items else None


def do_generate_video(job: dict, inp: dict) -> dict:
    t0 = clock()
    registry = load_registry()
    params = validate_generate_video(inp, registry)
    model = get_video_model(registry, params["model"])
    missing = missing_video_files(model)
    if missing:
        return {"error": "MODEL_NOT_INSTALLED: " + ", ".join(missing)}

    init = params["initImage"]

    def graph_params(init_name: str | None) -> dict:
        gi = None if init is None else {"name": init_name, "width": init["width"],
                                        "height": init["height"]}
        return {**params, "initImage": gi}

    progress = Throttle(job)
    preview, info = build_video_workflow(graph_params("init"), registry)
    copies = local_models.begin_for_job(params["model"])
    tracker = StageTracker(progress, preview, info["totalSteps"], t0,
                           pre_stages=(COPY_STAGE,) if copies else ())
    tracker.send(force=True)
    if copies:
        err = _wait_local_copies(job, copies, tracker)
        if err:
            return err

    client = make_client()
    client.wait_ready(COMFY_READY_TIMEOUT_S)
    tag = uuid.uuid4().hex[:12]
    uploads = []
    init_name = None
    if init is not None:
        init_name = client.upload_image(f"is_{tag}_init.{init['ext']}", init["data"], init["mime"])
        uploads.append(init_name)

    graph, info = build_video_workflow(graph_params(init_name), registry)
    tracker.set_graph(graph)
    offsets, acc = {}, 0
    for node, n in info["samplers"]:
        offsets[node] = acc
        acc += n

    if cancelled(job):
        return {"error": "CANCELLED: cancelled before the prompt was queued"}
    ws = client.connect_ws()
    try:
        t_queued = clock()
        prompt_id = client.queue_prompt(graph)
        res = _watch(client, ws, prompt_id, set(offsets), info["totalSteps"], progress, t_queued,
                     tracker, step_offsets=offsets, timeout_s=VIDEO_TIMEOUT_S)
    finally:
        try:
            ws.close()
        except Exception:
            pass
    if "error" in res:
        return res

    tracker.enter("saving")
    hist = client.history(prompt_id)
    vid = _first_output(hist, info["videoNode"])
    if vid is None:
        if hist.get("status", {}).get("status_str") == "error":
            return {"error": _history_error(hist)}
        return {"error": "COMFYUI_NO_OUTPUT: the workflow produced no video"}
    mp4 = client.view(vid["filename"], vid.get("subfolder", ""), vid.get("type", "output"))
    poster = None
    pst = _first_output(hist, info["posterNode"])
    if pst is not None:
        png = client.view(pst["filename"], pst.get("subfolder", ""), pst.get("type", "output"))
        size = png_size(png) or (info["width"], info["height"])
        try:
            data, mime = poster_jpeg(png)
        except Exception:  # a broken poster must not lose the video
            traceback.print_exc()
            data, mime = png, "image/png"
        poster = {"base64": base64.b64encode(data).decode("ascii"), "mime": mime,
                  "width": size[0], "height": size[1]}
    _cleanup(vid, uploads)
    if pst is not None:
        _cleanup(pst, [])

    probed = mp4_info(mp4) or {}
    video = {
        "base64": base64.b64encode(mp4).decode("ascii"),
        "mime": "video/mp4",
        "width": probed.get("width") or info["width"],
        "height": probed.get("height") or info["height"],
        "fps": info["fps"],
        "frames": probed.get("frames") or info["frames"],
        "durationS": probed.get("durationS") or info["durationS"],
        "hasAudio": probed.get("hasAudio", info["hasAudio"]),
        "sizeBytes": len(mp4),
    }
    t_end = clock()
    s0, s1 = res["sample_start"], res["sample_end"]
    load_ms = _ms((s0 if s0 is not None else t_end) - t0)
    sample_ms = _ms(s1 - s0) if s0 is not None and s1 is not None else 0
    return {
        "video": video,
        "poster": poster,
        "seed": params["seed"],
        "timings": {"loadMs": load_ms, "sampleMs": sample_ms,
                    "encodeMs": _ms(t_end - s1) if s1 is not None else 0,
                    "totalMs": _ms(t_end - t0)},
    }


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
        if did:
            _invalidate_local(dest)
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


def _invalidate_local(path: Path) -> None:
    """The volume file at `path` changed or is going away: drop its local
    copy (pod mode) so it can't shadow the new content. Best effort."""
    m = local_models.get()
    if m is None:
        return
    try:
        rel = path.relative_to(MODELS_ROOT)
        m.invalidate(rel.parent.as_posix(), rel.name)
    except Exception:
        traceback.print_exc()


def do_delete(job: dict, inp: dict) -> dict:
    registry = load_registry()
    ids = model_ids(registry)
    targets = [resolve(MODELS_ROOT, f.get("folder"), f.get("filename"), ids)
               for f in _file_list(inp)]
    deleted, missing = [], []
    for path in targets:
        _invalidate_local(path)
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
    "generate_video": do_generate_video,
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
        import server  # next to this file (PYTHONPATH); imports `handler` from there
        server.main()
    else:
        runpod.serverless.start({"handler": handler})


if __name__ == "__main__":
    main()
