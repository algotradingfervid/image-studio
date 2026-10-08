"""Handler actions against a fake ComfyUI.

The fake replaces ComfyClient's HTTP session and websocket. Message and
response shapes are copied from a real ComfyUI v0.39.0 run (CPU, local):
execution_start / executing / progress / executed / execution_success,
execution_error {node_id, node_type, exception_message, exception_type},
/history/{id} -> {id: {outputs: {node: {images: [...]}}, status: {...}}},
/upload/image -> {name, subfolder, type}.
"""

from __future__ import annotations

import base64
import hashlib
import json
import os
import struct
import threading
import time
import zlib

import pytest
import websocket

import comfy_client
import handler
from comfy_client import ComfyClient


def make_png(w: int, h: int) -> bytes:
    def chunk(t, d):
        return struct.pack(">I", len(d)) + t + d + struct.pack(">I", zlib.crc32(t + d))
    raw = b"".join(b"\x00" + b"\x00\x00\x00" * w for _ in range(h))
    return (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 2, 0, 0, 0))
            + chunk(b"IDAT", zlib.compress(raw)) + chunk(b"IEND", b""))


PNG_REF = make_png(8, 8)
JPEG_REF = b"\xff\xd8\xff\xe0" + b"\x00" * 32


class Resp:
    def __init__(self, status=200, body=None, content=b""):
        self.status_code = status
        self._body = body
        self.content = content if body is None else json.dumps(body).encode()
        self.text = self.content.decode(errors="replace")

    def json(self):
        if self._body is None:
            raise ValueError("no json")
        return self._body

    def raise_for_status(self):
        if self.status_code >= 400:
            raise RuntimeError(f"HTTP {self.status_code}")


class FakeComfy:
    """Scriptable fake of the ComfyUI HTTP API + websocket."""

    def __init__(self, scenario="ok", steps=4, out_size=(1216, 832)):
        self.scenario = scenario
        self.steps = steps
        self.out_png = make_png(*out_size)
        self.uploads: list[tuple[str, bytes, str]] = []
        self.prompts: list[dict] = []
        self.freed = 0
        self.up = True
        self.prompt_id = "11111111-2222-3333-4444-555555555555"
        self.messages: list = []
        self.history_body: dict = {}

    # -- HTTP --------------------------------------------------------------
    def get(self, url, params=None, timeout=None):
        path = url.split("8188", 1)[1]
        if path == "/":
            if not self.up:
                raise comfy_client.requests.ConnectionError("down")
            return Resp(200, content=b"<html>")
        if path.startswith("/history/"):
            return Resp(200, {self.prompt_id: self.history_body} if self.history_body else {})
        if path == "/view":
            assert params["type"] == "output"
            return Resp(200, content=self.out_png)
        if path == "/system_stats":
            return Resp(200, {"system": {"comfyui_version": "0.39.0"}})
        return Resp(404)

    def post(self, url, json=None, files=None, data=None, timeout=None):
        path = url.split("8188", 1)[1]
        if path == "/upload/image":
            name, content, mime = files["image"]
            assert data["overwrite"] == "true"
            self.uploads.append((name, content, mime))
            return Resp(200, {"name": name, "subfolder": "", "type": "input"})
        if path == "/prompt":
            self.prompts.append(json)
            if self.scenario == "invalid":
                return Resp(400, {"error": {"type": "prompt_outputs_failed_validation",
                                            "message": "Prompt outputs failed validation"},
                                  "node_errors": {"1": {"errors": [{"message": "Value not in list",
                                                                     "details": "unet_name: 'x' not in []"}],
                                                        "class_type": "UNETLoader"}}})
            self._script(json["prompt"])
            return Resp(200, {"prompt_id": self.prompt_id, "number": 1, "node_errors": {}})
        if path == "/free":
            assert json == {"unload_models": True, "free_memory": True}
            self.freed += 1
            return Resp(200, {})
        return Resp(404)

    # -- websocket script --------------------------------------------------
    def _script(self, graph):
        pid = self.prompt_id
        sampler = next(n for n, v in graph.items()
                       if v["class_type"] in ("KSampler", "SamplerCustomAdvanced"))
        decode = next(n for n, v in graph.items() if v["class_type"] == "VAEDecode")
        save = next(n for n, v in graph.items() if v["class_type"] == "SaveImage")
        m = [{"type": "status", "data": {"status": {"exec_info": {"queue_remaining": 1}}}},
             {"type": "execution_start", "data": {"prompt_id": pid}},
             {"type": "execution_cached", "data": {"nodes": [], "prompt_id": pid}},
             {"type": "executing", "data": {"node": "1", "display_node": "1", "prompt_id": pid}},
             b"\x00\x00\x00\x01binary-preview"]
        if self.scenario == "error":
            m.append({"type": "execution_error", "data": {
                "prompt_id": pid, "node_id": "1", "node_type": "UNETLoader", "executed": [],
                "exception_message": "Error while deserializing header: header too small\n",
                "exception_type": "safetensors._safetensors_rust.SafetensorError",
                "traceback": ["..."]}})
            self.messages = m
            self.history_body = {"outputs": {}, "status": {"status_str": "error", "completed": False}}
            return
        m.append({"type": "executing", "data": {"node": sampler, "display_node": sampler, "prompt_id": pid}})
        # a progress event from another prompt must be ignored
        m.append({"type": "progress", "data": {"value": 9, "max": 9, "prompt_id": "other", "node": sampler}})
        for s in range(1, self.steps + 1):
            m.append({"type": "progress", "data": {"value": s, "max": self.steps,
                                                   "prompt_id": pid, "node": sampler}})
            m.append("TICK")
        m += [{"type": "executing", "data": {"node": decode, "display_node": decode, "prompt_id": pid}},
              {"type": "executing", "data": {"node": save, "display_node": save, "prompt_id": pid}},
              {"type": "executed", "data": {"node": save, "output": {"images": [
                  {"filename": "image_studio_00001_.png", "subfolder": "", "type": "output"}]},
                  "prompt_id": pid}}]
        if self.scenario == "lost_ws":
            m = m[:6] + ["TIMEOUT"]  # socket goes quiet; history says done
        else:
            m.append({"type": "execution_success", "data": {"prompt_id": pid}})
        self.messages = m
        self.history_body = {
            "outputs": {save: {"images": [{"filename": "image_studio_00001_.png",
                                           "subfolder": "", "type": "output"}]}},
            "status": {"status_str": "success", "completed": True, "messages": []}}

    def ws_factory(self):
        fake = self

        class WS:
            def connect(self, url, timeout=None):
                assert url.startswith("ws://127.0.0.1:8188/ws?clientId=")

            def settimeout(self, t):
                pass

            def recv(self):
                while fake.messages:
                    m = fake.messages.pop(0)
                    if m == "TICK":
                        fake.clock.advance(0.3)
                        continue
                    if m == "TIMEOUT":
                        raise websocket.WebSocketTimeoutException("quiet")
                    return m if isinstance(m, bytes) else json.dumps(m)
                raise websocket.WebSocketTimeoutException("no more")

            def close(self):
                pass

        return WS()


class FakeClock:
    def __init__(self):
        self.t = 1000.0

    def __call__(self):
        return self.t

    def advance(self, s):
        self.t += s


@pytest.fixture
def env(tmp_path, monkeypatch, registry):
    vol = tmp_path / "runpod-volume"
    models = vol / "models"
    for d in ("unet", "clip", "vae", "loras/flux2"):
        (models / d).mkdir(parents=True)
    comfy = tmp_path / "comfyui"
    (comfy / "output").mkdir(parents=True)
    (comfy / "input").mkdir()
    (comfy / "comfyui_version.py").write_text('__version__ = "0.39.0"\n')
    monkeypatch.setattr(handler, "VOLUME_ROOT", vol)
    monkeypatch.setattr(handler, "MODELS_ROOT", models)
    monkeypatch.setattr(handler, "COMFYUI_PATH", comfy)
    monkeypatch.setattr(comfy_client, "COMFY_PID_FILE", str(tmp_path / "no.pid"))
    sent: list[dict] = []
    monkeypatch.setattr(handler, "send_progress", lambda job, p: sent.append(json.loads(json.dumps(p))))
    clock = FakeClock()
    monkeypatch.setattr(handler, "clock", clock)

    class Env:
        pass

    e = Env()
    e.vol, e.models, e.comfy, e.sent, e.clock, e.registry = vol, models, comfy, sent, clock, registry

    def install(model_id, extra=()):
        m = next(x for x in registry["models"] if x["id"] == model_id)
        for f in m["files"]:
            (models / f["folder"] / f["filename"]).write_bytes(b"w")
        for rel in extra:
            (models / rel).write_bytes(b"l")

    def fake(**kw):
        f = FakeComfy(**kw)
        f.clock = clock
        monkeypatch.setattr(handler, "make_client",
                            lambda: ComfyClient("127.0.0.1:8188", ws_factory=f.ws_factory, session=f))
        return f

    e.install, e.fake = install, fake
    return e


def gen_input(**kw):
    inp = {"action": "generate", "model": "flux2", "prompt": "a fox", "negativePrompt": "",
           "width": 1216, "height": 832, "seed": 42, "steps": 4, "cfg": 1.0,
           "references": [], "loras": []}
    inp.update(kw)
    return {"id": "job-1", "input": inp}


# --------------------------------------------------------------------------- generate
def test_generate_ok(env):
    env.install("flux2", ["loras/flux2/style.safetensors"])
    fake = env.fake(steps=4)
    (env.comfy / "output" / "image_studio_00001_.png").write_bytes(b"x")
    out = handler.handler(gen_input(
        references=[{"name": "a.png", "base64": base64.b64encode(PNG_REF).decode()},
                    {"name": "b.jpg", "base64": "data:image/jpeg;base64," + base64.b64encode(JPEG_REF).decode()}],
        loras=[{"filename": "style.safetensors", "strength": 0.7}]))
    assert "error" not in out, out
    assert base64.b64decode(out["image"]["base64"]) == fake.out_png
    assert out["image"] == {"base64": out["image"]["base64"], "seed": 42, "width": 1216, "height": 832}
    t = out["timings"]
    assert set(t) == {"loadMs", "sampleMs", "totalMs"}
    assert t["sampleMs"] == 1200 and t["totalMs"] >= t["loadMs"] + t["sampleMs"]

    # references uploaded and wired into the graph
    assert [u[2] for u in fake.uploads] == ["image/png", "image/jpeg"]
    assert fake.uploads[0][1] == PNG_REF
    graph = fake.prompts[0]["prompt"]
    loads = [n["inputs"]["image"] for n in graph.values() if n["class_type"] == "LoadImage"]
    assert loads == [u[0] for u in fake.uploads]
    assert any(n["class_type"] == "LoraLoaderModelOnly"
               and n["inputs"]["lora_name"] == "flux2/style.safetensors" for n in graph.values())
    assert fake.prompts[0]["client_id"]

    # progress: loading -> sampling steps -> saving, all phases valid
    phases = [p["phase"] for p in env.sent]
    assert phases[0] == "loading" and "sampling" in phases and phases[-1] == "saving"
    steps = [p["step"] for p in env.sent if p["phase"] == "sampling"]
    assert steps == sorted(steps) and steps[-1] == 4
    assert all(p.get("totalSteps") == 4 for p in env.sent)
    # output file cleaned from the container disk
    assert not (env.comfy / "output" / "image_studio_00001_.png").exists()


def test_generate_progress_throttled(env, monkeypatch):
    env.install("chroma")
    fake = env.fake(steps=40)
    # each step 0.1 s apart -> at most ~2 updates per second
    orig = fake.ws_factory

    def ws_factory():
        ws = orig()
        real = ws.recv

        def recv():
            r = real()
            env.clock.advance(0.1)
            return r
        ws.recv = recv
        return ws

    fake.ws_factory = ws_factory
    monkeypatch.setattr(handler, "make_client",
                        lambda: ComfyClient("127.0.0.1:8188", ws_factory=ws_factory, session=fake))
    out = handler.handler(gen_input(model="chroma", steps=40))
    assert "error" not in out, out
    sampling = [p for p in env.sent if p["phase"] == "sampling"]
    assert 2 <= len(sampling) < 40
    assert sampling[-1]["step"] == 40  # the final step is always sent


def test_generate_defaults_and_random_seed(env):
    env.install("qwen")
    fake = env.fake(steps=25)
    out = handler.handler(gen_input(model="qwen", steps=None, cfg=None, seed=None,
                                    negativePrompt=None))
    assert "error" not in out, out
    ks = next(n for n in fake.prompts[0]["prompt"].values() if n["class_type"] == "KSampler")
    assert ks["inputs"]["steps"] == 25 and ks["inputs"]["cfg"] == 1.0
    assert ks["inputs"]["seed"] == out["image"]["seed"]


def test_generate_model_not_installed(env):
    env.install("flux2")
    os.remove(env.models / "vae" / "flux2-vae.safetensors")
    fake = env.fake()
    out = handler.handler(gen_input(loras=[{"filename": "nope.safetensors", "strength": 1}]))
    assert out == {"error": "MODEL_NOT_INSTALLED: vae/flux2-vae.safetensors, "
                            "loras/flux2/nope.safetensors"}
    assert fake.prompts == []


def test_generate_execution_error(env):
    env.install("zimage")
    env.fake(scenario="error")
    out = handler.handler(gen_input(model="zimage"))
    assert out == {"error": "COMFYUI_EXECUTION_ERROR: node 1 (UNETLoader): SafetensorError: "
                            "Error while deserializing header: header too small"}


def test_generate_invalid_prompt(env):
    env.install("zimage")
    env.fake(scenario="invalid")
    out = handler.handler(gen_input(model="zimage"))
    assert out["error"].startswith("COMFYUI_INVALID_PROMPT: Prompt outputs failed validation")
    assert "node 1 (UNETLoader): unet_name" in out["error"]


def test_generate_recovers_from_quiet_websocket(env):
    env.install("zimage")
    env.fake(scenario="lost_ws")
    out = handler.handler(gen_input(model="zimage"))
    assert "error" not in out, out
    assert out["image"]["width"] == 1216


def test_generate_comfy_down(env, monkeypatch):
    env.install("zimage")
    fake = env.fake()
    fake.up = False
    monkeypatch.setattr(handler, "COMFY_READY_TIMEOUT_S", 0.0)
    out = handler.handler(gen_input(model="zimage"))
    assert out["error"].startswith("COMFYUI_NOT_REACHABLE")


@pytest.mark.parametrize("patch,code", [
    ({"model": "sdxl"}, "UNKNOWN_MODEL"),
    ({"prompt": "  "}, "INVALID_INPUT: prompt"),
    ({"width": 1000}, "INVALID_INPUT: width and height"),
    ({"width": 8192}, "INVALID_INPUT: width"),
    ({"steps": 0}, "INVALID_INPUT: steps"),
    ({"seed": -1}, "INVALID_INPUT: seed"),
    ({"seed": 2**64}, "INVALID_INPUT: seed"),
    ({"cfg": "high"}, "INVALID_INPUT: cfg"),
    ({"model": "chroma", "references": [{"name": "a", "base64": "eA=="}]}, "TOO_MANY_REFERENCES"),
    ({"references": [{"name": "a", "base64": "!!!"}]}, "INVALID_REFERENCE"),
    ({"references": [{"name": "a", "base64": base64.b64encode(b"GIF89a").decode()}]}, "INVALID_REFERENCE"),
    ({"loras": [{"filename": "../x.safetensors"}]}, "INVALID_FILENAME"),
    ({"loras": [{"filename": f"{i}.safetensors"} for i in range(4)]}, "INVALID_INPUT: at most 3"),
])
def test_generate_input_validation(env, patch, code):
    env.install("flux2")
    env.fake()
    out = handler.handler(gen_input(**patch))
    assert out["error"].startswith(code), out


def test_unknown_action():
    assert handler.handler({"id": "x", "input": {"action": "explode"}})["error"].startswith(
        "UNKNOWN_ACTION")


def test_internal_errors_are_reported_cleanly(env, monkeypatch):
    monkeypatch.setattr(handler, "do_status", lambda job, inp: 1 / 0)
    monkeypatch.setitem(handler.ACTIONS, "status", handler.do_status)
    out = handler.handler({"id": "x", "input": {"action": "status"}})
    assert out == {"error": "INTERNAL_ERROR: ZeroDivisionError: division by zero"}


# --------------------------------------------------------------------------- status
def test_status(env):
    env.install("zimage")
    (env.models / "loras" / "flux2" / "s.safetensors").write_bytes(b"12345")
    (env.models / "unet" / "partial.safetensors.part").write_bytes(b"xx")
    (env.models / "unet" / "notes.txt").write_text("x")
    out = handler.handler({"id": "x", "input": {"action": "status"}})
    assert out["comfyuiVersion"] == "0.39.0"
    assert {"folder": "loras/flux2", "filename": "s.safetensors", "sizeBytes": 5} in out["files"]
    names = {(f["folder"], f["filename"]) for f in out["files"]}
    assert names == {("unet", "z_image_turbo_bf16.safetensors"), ("clip", "qwen_3_4b.safetensors"),
                     ("vae", "ae.safetensors"), ("loras/flux2", "s.safetensors")}
    assert out["volume"]["totalBytes"] > 0 and 0 <= out["volume"]["freeBytes"] <= out["volume"]["totalBytes"]


def test_status_empty_volume(env, tmp_path, monkeypatch):
    monkeypatch.setattr(handler, "MODELS_ROOT", tmp_path / "nothing")
    out = handler.handler({"id": "x", "input": {"action": "status"}})
    assert out["files"] == []


# --------------------------------------------------------------------------- delete
def test_delete(env):
    env.install("flux2")
    (env.models / "vae" / "ae.safetensors.part").write_bytes(b"p")
    fake = env.fake()
    out = handler.handler({"id": "x", "input": {"action": "delete", "files": [
        {"folder": "unet", "filename": "flux-2-klein-9b-fp8.safetensors"},
        {"folder": "vae", "filename": "ae.safetensors"}]}})
    assert out == {"deleted": ["flux-2-klein-9b-fp8.safetensors"], "missing": ["ae.safetensors"]}
    assert not (env.models / "unet" / "flux-2-klein-9b-fp8.safetensors").exists()
    assert not (env.models / "vae" / "ae.safetensors.part").exists()
    assert (env.models / "clip" / "qwen_3_8b_fp8mixed.safetensors").exists()
    assert fake.freed == 1


def test_delete_skips_free_when_comfy_down(env):
    env.install("flux2")
    fake = env.fake()
    fake.up = False
    out = handler.handler({"id": "x", "input": {"action": "delete", "files": [
        {"folder": "clip", "filename": "qwen_3_8b_fp8mixed.safetensors"}]}})
    assert out["deleted"] == ["qwen_3_8b_fp8mixed.safetensors"] and fake.freed == 0


@pytest.mark.parametrize("bad", [
    {"folder": "unet", "filename": "../../etc/passwd"},
    {"folder": "../", "filename": "x.safetensors"},
    {"folder": "loras/unknown", "filename": "x.safetensors"},
    {"folder": "unet", "filename": "x.bin"},
])
def test_delete_rejects_unsafe_paths_before_touching_anything(env, bad):
    env.install("flux2")
    env.fake()
    out = handler.handler({"id": "x", "input": {"action": "delete", "files": [
        {"folder": "unet", "filename": "flux-2-klein-9b-fp8.safetensors"}, bad]}})
    assert out["error"].startswith(("INVALID_FOLDER", "INVALID_FILENAME"))
    assert (env.models / "unet" / "flux-2-klein-9b-fp8.safetensors").exists()


# --------------------------------------------------------------------------- download
@pytest.fixture
def dl_env(env, monkeypatch):
    monkeypatch.setenv("IMAGE_STUDIO_ALLOW_HTTP", "1")
    monkeypatch.delenv("HF_TOKEN", raising=False)
    monkeypatch.delenv("CIVITAI_API_KEY", raising=False)
    monkeypatch.setattr(handler, "clock", time.monotonic)
    return env


def test_download_and_skip(dl_env, file_server):
    a, b = os.urandom(300_000), os.urandom(200_000)
    sha_a = file_server.add("/a", a)
    file_server.add("/b", b)
    (dl_env.models / "vae" / "b.safetensors").write_bytes(b)  # already present
    out = handler.handler({"id": "x", "input": {"action": "download", "files": [
        {"folder": "loras/qwen", "filename": "a.safetensors", "url": file_server.url("/a"),
         "sizeBytes": len(a), "sha256": sha_a},
        {"folder": "vae", "filename": "b.safetensors", "url": file_server.url("/b"),
         "sizeBytes": len(b)}]}})
    assert out["downloaded"] == ["a.safetensors"] and out["skipped"] == ["b.safetensors"]
    assert out["elapsedMs"] >= 0 and out["avgMBps"] >= 0
    assert (dl_env.models / "loras" / "qwen" / "a.safetensors").read_bytes() == a
    assert file_server.requests_for("/b") == []
    last = dl_env.sent[-1]
    assert last["phase"] == "downloading"
    assert last["bytes"] == last["totalBytes"] == len(a) + len(b)
    assert {f["filename"]: f["status"] for f in last["files"]} == {
        "a.safetensors": "downloaded", "b.safetensors": "skipped"}


def test_download_parallel_with_aggregate_progress(dl_env, file_server, monkeypatch):
    # Interval 0 so every update is captured; the default is 0.5 s (<= 2/s).
    monkeypatch.setattr(handler, "PROGRESS_MIN_INTERVAL_S", 0.0)
    monkeypatch.setattr(handler.Throttle.__init__, "__defaults__", (0.0,))
    sizes = {"u.safetensors": 1_200_000, "c.safetensors": 900_000, "v.safetensors": 600_000}
    datas = {n: os.urandom(s) for n, s in sizes.items()}
    folders = {"u.safetensors": "unet", "c.safetensors": "clip", "v.safetensors": "vae"}
    files = []
    for n, d in datas.items():
        sha = file_server.add(f"/{n}", d, chunk_delay=0.03)  # ~0.3-0.6 s per file
        files.append({"folder": folders[n], "filename": n, "url": file_server.url(f"/{n}"),
                      "sizeBytes": len(d), "sha256": sha})
    t0 = time.monotonic()
    out = handler.handler({"id": "x", "input": {"action": "download", "files": files}})
    elapsed = time.monotonic() - t0
    assert "error" not in out, out
    assert out["downloaded"] == list(sizes) and out["skipped"] == []
    for n, d in datas.items():
        assert (dl_env.models / folders[n] / n).read_bytes() == d

    # all three streams were open at the same time
    assert file_server.max_in_flight == 3
    serial = sum(len(d) / 65536 * 0.03 for d in datas.values())
    assert elapsed < serial * 0.8

    total = sum(sizes.values())
    ups = dl_env.sent
    assert all(u["totalBytes"] == total for u in ups)
    for u in ups:  # aggregate == sum of the per-file entries, never above total
        assert u["bytes"] == sum(f["bytes"] for f in u["files"]) <= total
        assert {f["filename"] for f in u["files"]} == set(sizes)
    assert max(sum(f["status"] == "downloading" for f in u["files"]) for u in ups) >= 2
    per_file_seen = {n: [f["bytes"] for u in ups for f in u["files"] if f["filename"] == n]
                     for n in sizes}
    for n, seq in per_file_seen.items():
        assert seq == sorted(seq) and seq[-1] == sizes[n]
    assert ups[-1]["bytes"] == total
    assert all(f["status"] == "downloaded" for f in ups[-1]["files"])
    assert out["avgMBps"] > 0 and out["elapsedMs"] > 0


def test_download_progress_rate_limited(dl_env, file_server):
    data = os.urandom(2_000_000)
    file_server.add("/a", data, chunk_delay=0.02)  # ~0.6 s, ~30 chunks
    t0 = time.monotonic()
    out = handler.handler({"id": "x", "input": {"action": "download", "files": [
        {"folder": "unet", "filename": "a.safetensors", "url": file_server.url("/a"),
         "sizeBytes": len(data)}]}})
    elapsed = time.monotonic() - t0
    assert "error" not in out
    # forced updates: start, finish, final summary; plus <= 2/s throttled ones
    assert len(dl_env.sent) <= 3 + int(elapsed * 2) + 1


def test_download_failure_reports_error(dl_env, file_server):
    good = os.urandom(1000)
    file_server.add("/ok", good)
    file_server.add("/bad", os.urandom(1000))
    out = handler.handler({"id": "x", "input": {"action": "download", "files": [
        {"folder": "vae", "filename": "ok.safetensors", "url": file_server.url("/ok")},
        {"folder": "vae", "filename": "bad.safetensors", "url": file_server.url("/bad"),
         "sha256": hashlib.sha256(b"other").hexdigest()}]}})
    assert out["error"].startswith("DOWNLOAD_FAILED: SHA256_MISMATCH: bad.safetensors")
    assert "completed: ok.safetensors" in out["error"]
    assert (dl_env.models / "vae" / "ok.safetensors").read_bytes() == good
    assert not (dl_env.models / "vae" / "bad.safetensors").exists()
    statuses = {f["filename"]: f["status"] for f in dl_env.sent[-1]["files"]}
    assert statuses == {"ok.safetensors": "downloaded", "bad.safetensors": "failed"}


def test_download_uses_env_tokens_per_host(dl_env, file_server, monkeypatch):
    import downloader
    monkeypatch.setenv("HF_TOKEN", "hf_secret")
    # map the test server's host to the HF token, and redirect to another host
    monkeypatch.setattr(downloader.DownloadConfig, "from_env", classmethod(
        lambda cls, **kw: cls(tokens={"127.0.0.1": os.environ["HF_TOKEN"]}, allow_http=True,
                              sleep=lambda s: None)))
    data = os.urandom(5000)
    file_server.add("/blob", data)
    file_server.add("/resolve", b"", redirect=file_server.url("/blob", host="localhost"))
    out = handler.handler({"id": "x", "input": {"action": "download", "files": [
        {"folder": "unet", "filename": "m.safetensors", "url": file_server.url("/resolve")}]}})
    assert out["downloaded"] == ["m.safetensors"]
    assert file_server.requests_for("/resolve")[0]["headers"]["Authorization"] == "Bearer hf_secret"
    assert "Authorization" not in file_server.requests_for("/blob")[0]["headers"]


@pytest.mark.parametrize("files,code", [
    ([], "INVALID_INPUT"),
    ([{"folder": "unet", "filename": "a.safetensors"}], "INVALID_INPUT: url"),
    ([{"folder": "unet", "filename": "a.pt", "url": "https://x/y"}], "INVALID_FILENAME"),
    ([{"folder": "checkpoints", "filename": "a.safetensors", "url": "https://x/y"}], "INVALID_FOLDER"),
    ([{"folder": "unet", "filename": "a.safetensors", "url": "https://x/y", "sha256": "zz"}],
     "INVALID_INPUT: sha256"),
    ([{"folder": "unet", "filename": "a.safetensors", "url": "ftp://x/y"}], "DOWNLOAD_FAILED: UNSUPPORTED_URL"),
])
def test_download_validation(env, files, code):
    out = handler.handler({"id": "x", "input": {"action": "download", "files": files}})
    assert out["error"].startswith(code), out


def test_throttle_is_thread_safe_and_limits_rate(monkeypatch):
    sent = []
    monkeypatch.setattr(handler, "send_progress", lambda j, p: sent.append(p))
    monkeypatch.setattr(handler, "clock", time.monotonic)
    th = handler.Throttle({"id": "j"})
    stop = time.monotonic() + 1.2

    def spam(k):
        i = 0
        while time.monotonic() < stop:
            th({"phase": "downloading", "bytes": i, "k": k})
            i += 1

    ts = [threading.Thread(target=spam, args=(k,)) for k in range(3)]
    for t in ts:
        t.start()
    for t in ts:
        t.join()
    assert 2 <= len(sent) <= 4  # ~1.2 s at <= 2/s
