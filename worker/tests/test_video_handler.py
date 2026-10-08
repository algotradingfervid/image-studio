"""Handler action generate_video (spec "v5") against a fake ComfyUI.

The fake returns a real H.264 + AAC MP4 (tests/fixtures/tiny_h264_aac.mp4,
9 frames 64x32 at 24 fps, written with PyAV 19.0.1 / libx264 the same way
ComfyUI's SaveVideo does) and a PNG for the frame-0 poster.
"""

from __future__ import annotations

import base64
import json
import struct
from pathlib import Path

import pytest

import comfy_client
import handler
import server
from comfy_client import ComfyClient
from test_handler import FakeClock, FakeComfy, Resp, make_png
from workflows import POSTER_PREFIX, VIDEO_PREFIX

MP4 = (Path(__file__).parent / "fixtures" / "tiny_h264_aac.mp4").read_bytes()
PNG_INIT = make_png(30, 20)


def _ids(graph, *classes):
    return [nid for nid, n in graph.items() if n["class_type"] in classes]


class FakeVideoComfy(FakeComfy):
    """FakeComfy for video graphs: two SaveImage-like outputs, several samplers."""

    def __init__(self, scenario="ok", mp4=MP4, poster=None, **kw):
        super().__init__(scenario=scenario, **kw)
        self.mp4 = mp4
        self.poster_png = poster or make_png(64, 32)
        self.views: list[str] = []

    def get(self, url, params=None, timeout=None):
        path = url.split("8188", 1)[1]
        if path == "/view":
            self.views.append(params["filename"])
            if params["filename"].endswith(".mp4"):
                return Resp(200, content=self.mp4)
            return Resp(200, content=self.poster_png)
        return super().get(url, params=params, timeout=timeout)

    def _script(self, graph):
        pid = self.prompt_id
        samplers = _ids(graph, "SamplerCustomAdvanced")
        save = _ids(graph, "SaveVideo")[0]
        poster = next(n for n in _ids(graph, "SaveImage")
                      if graph[n]["inputs"]["filename_prefix"] == POSTER_PREFIX)
        self.graph = graph
        m = [{"type": "execution_start", "data": {"prompt_id": pid}},
             {"type": "execution_cached", "data": {"nodes": [], "prompt_id": pid}}]
        order = (_ids(graph, "CLIPLoader") + _ids(graph, "CLIPTextEncode", "LTXVConditioning",
                                                  "MiniMaxH3ImageToVideo")
                 + _ids(graph, "UNETLoader", "LatentUpscaleModelLoader")
                 + _ids(graph, "LoadImage", "ResizeImageMaskNode", "LTXVPreprocess"))
        for nid in order:
            m += [{"type": "executing", "data": {"node": nid, "prompt_id": pid}}, "TICK"]
        if self.scenario == "error":
            m.append({"type": "execution_error", "data": {
                "prompt_id": pid, "node_id": samplers[0], "node_type": "SamplerCustomAdvanced",
                "exception_message": "CUDA out of memory", "exception_type": "torch.OutOfMemoryError",
                "executed": [], "traceback": []}})
            self.messages = m
            self.history_body = {"outputs": {}, "status": {"status_str": "error", "completed": False}}
            return
        for i, s in enumerate(samplers):
            if i:  # LTX stage 2: upscaler between the samplers
                for nid in _ids(graph, "LTXVLatentUpsampler"):
                    m += [{"type": "executing", "data": {"node": nid, "prompt_id": pid}}, "TICK"]
            n = self.steps_per[i] if hasattr(self, "steps_per") else self.steps
            m.append({"type": "executing", "data": {"node": s, "prompt_id": pid}})
            for k in range(1, n + 1):
                m += [{"type": "progress", "data": {"value": k, "max": n, "prompt_id": pid,
                                                    "node": s}}, "TICK"]
        for cls in (("VAEDecode", "VAEDecodeTiled"), ("VAEDecodeAudio", "LTXVAudioVAEDecode"),
                    ("CreateVideo",), ("SaveVideo",), ("ImageFromBatch",)):
            for nid in _ids(graph, *cls):
                m += [{"type": "executing", "data": {"node": nid, "prompt_id": pid}}, "TICK"]
        m += [{"type": "executing", "data": {"node": poster, "prompt_id": pid}},
              {"type": "executing", "data": {"node": None, "prompt_id": pid}}]
        self.messages = m
        outputs = {poster: {"images": [{"filename": f"{POSTER_PREFIX}_00001_.png",
                                        "subfolder": "", "type": "output"}]}}
        if self.scenario != "no_video":
            outputs[save] = {"images": [{"filename": f"{VIDEO_PREFIX}_00001_.mp4",
                                         "subfolder": "", "type": "output"}], "animated": [True]}
        self.history_body = {"outputs": outputs,
                             "status": {"status_str": "success", "completed": True, "messages": []}}


@pytest.fixture
def venv(tmp_path, monkeypatch, registry):
    vol = tmp_path / "runpod-volume"
    models = vol / "models"
    for d in ("unet", "clip", "vae", "latent_upscale_models"):
        (models / d).mkdir(parents=True)
    comfy = tmp_path / "comfyui"
    (comfy / "output").mkdir(parents=True)
    (comfy / "input").mkdir()
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
    e.models, e.comfy, e.sent, e.clock, e.registry = models, comfy, sent, clock, registry

    def install(model_id, skip=()):
        m = next(x for x in registry["videoModels"] if x["id"] == model_id)
        for f in m["files"]:
            if f["filename"] not in skip:
                (models / f["folder"] / f["filename"]).write_bytes(b"w")

    def fake(**kw):
        f = FakeVideoComfy(**kw)
        f.clock = clock
        monkeypatch.setattr(handler, "make_client",
                            lambda: ComfyClient("127.0.0.1:8188", ws_factory=f.ws_factory, session=f))
        return f

    e.install, e.fake = install, fake
    return e


def vid_input(**kw):
    inp = {"action": "generate_video", "model": "h3", "prompt": "a fox in the snow",
           "durationS": 5, "fps": 24, "resolution": "864x480", "seed": 7, "audio": True}
    inp.update(kw)
    return {"id": "job-v", "input": inp}


def transitions(sent):
    out = []
    for p in sent:
        if not out or out[-1] != p["stage"]:
            out.append(p["stage"])
    return out


# ---------------------------------------------------------------------------
# happy paths
# ---------------------------------------------------------------------------
def test_generate_video_h3_t2v(venv, monkeypatch):
    venv.install("h3")
    fake = venv.fake(steps=20)
    for name in (f"{VIDEO_PREFIX}_00001_.mp4", f"{POSTER_PREFIX}_00001_.png"):
        (venv.comfy / "output" / name).write_bytes(b"x")
    monkeypatch.setattr(handler, "poster_jpeg", lambda png: (b"\xff\xd8\xffJPEG", "image/jpeg"))
    out = handler.handler(vid_input(steps=20))
    assert "error" not in out, out
    v = out["video"]
    assert base64.b64decode(v["base64"]) == MP4
    # metadata read from the MP4 itself (the fixture is 64x32, 9 frames, with audio)
    assert v == {**v, "mime": "video/mp4", "width": 64, "height": 32, "frames": 9, "fps": 24,
                 "durationS": 0.375, "hasAudio": True, "sizeBytes": len(MP4)}
    assert out["poster"] == {"base64": base64.b64encode(b"\xff\xd8\xffJPEG").decode(),
                             "mime": "image/jpeg", "width": 64, "height": 32}
    assert out["seed"] == 7
    t = out["timings"]
    assert set(t) == {"loadMs", "sampleMs", "encodeMs", "totalMs"}
    assert t["sampleMs"] == 20 * 300 and t["totalMs"] >= t["loadMs"] + t["sampleMs"]
    # the queued graph
    graph = fake.prompts[0]["prompt"]
    cond = next(n for n in graph.values() if n["class_type"] == "MiniMaxH3ImageToVideo")["inputs"]
    assert (cond["width"], cond["height"], cond["length"]) == (864, 480, 124)
    assert "first_frame" not in cond
    # outputs fetched and cleaned up
    assert fake.views == [f"{VIDEO_PREFIX}_00001_.mp4", f"{POSTER_PREFIX}_00001_.png"]
    assert not list((venv.comfy / "output").iterdir())
    # progress: stages and steps
    stages = ["loading_text_encoder", "encoding_prompt", "loading_model", "sampling",
              "video_decoding", "audio_decoding", "encoding_video", "saving"]
    assert venv.sent[0]["stages"] == stages
    assert transitions(venv.sent) == stages
    steps = [p["step"] for p in venv.sent if p["stage"] == "sampling"]
    assert steps[-1] == 20 and all(p["totalSteps"] == 20 for p in venv.sent)
    assert {p["phase"] for p in venv.sent if p["stage"] in stages[4:]} == {"saving"}


def test_generate_video_ltx_i2v_two_samplers(venv):
    venv.install("ltx25")
    fake = venv.fake()
    fake.steps_per = [8, 3]
    out = handler.handler(vid_input(
        model="ltx25", resolution="1280x704", cfg=1.0, negativePrompt="blurry", audio=False,
        initImage={"name": "start.png", "base64": base64.b64encode(PNG_INIT).decode()}))
    assert "error" not in out, out
    # start image uploaded once and wired into the graph; removed afterwards
    assert len(fake.uploads) == 1 and fake.uploads[0][1] == PNG_INIT
    graph = fake.prompts[0]["prompt"]
    load = [n for n in graph.values() if n["class_type"] == "LoadImage"]
    assert [n["inputs"]["image"] for n in load] == [fake.uploads[0][0]]
    assert not any(n["class_type"] == "LTXVAudioVAEDecode" for n in graph.values())
    # i2v size follows the 30x20 start image at 1280*704 px (multiples of 64)
    empty = next(n for n in graph.values() if n["class_type"] == "EmptyLTXVLatentVideo")["inputs"]
    assert (empty["width"], empty["height"]) == (576, 384)
    # steps run across both samplers: 1..8 then 9..11 of 11
    sampling = [(p["step"], p["totalSteps"]) for p in venv.sent if p["stage"] == "sampling"]
    assert sampling[-1] == (11, 11)
    assert [s for s, _ in sampling] == sorted(s for s, _ in sampling)
    assert "preparing_init_image" in venv.sent[0]["stages"]
    assert "audio_decoding" not in venv.sent[0]["stages"]
    # sampling time spans both samplers, upscaler included (8 + 1 + 3 ticks)
    assert out["timings"]["sampleMs"] == (8 + 1 + 3) * 300
    # without Pillow in the test env, the PNG poster is passed through
    assert out["poster"]["mime"] in ("image/jpeg", "image/png")


def test_generate_video_defaults(venv):
    venv.install("ltx25")
    fake = venv.fake()
    out = handler.handler({"id": "j", "input": {"action": "generate_video", "model": "ltx25",
                                                "prompt": "waves"}})
    assert "error" not in out, out
    graph = fake.prompts[0]["prompt"]
    empty = next(n for n in graph.values() if n["class_type"] == "EmptyLTXVLatentVideo")["inputs"]
    assert (empty["width"], empty["height"], empty["length"]) == (640, 352, 121)
    assert any(n["class_type"] == "LTXVAudioVAEDecode" for n in graph.values())  # audio default on
    assert isinstance(out["seed"], int)


def test_video_metadata_falls_back_to_graph_when_mp4_unreadable(venv):
    venv.install("h3")
    venv.fake(mp4=b"not an mp4")
    out = handler.handler(vid_input(durationS=10, audio=False))
    v = out["video"]
    assert (v["width"], v["height"], v["frames"], v["fps"]) == (864, 480, 243, 24)
    assert v["durationS"] == round(243 / 24, 3) and v["hasAudio"] is False


# ---------------------------------------------------------------------------
# validation and failures
# ---------------------------------------------------------------------------
def test_model_not_installed_lists_missing_video_files(venv):
    venv.install("ltx25", skip=("ltx-2.5-latent-spatial-upscaler-x2-bf16-1.0.safetensors",
                                "ltx-2.5-audio-vae-bf16.safetensors"))
    fake = venv.fake()
    out = handler.handler(vid_input(model="ltx25", resolution="1280x704"))
    assert out == {"error": "MODEL_NOT_INSTALLED: vae/ltx-2.5-audio-vae-bf16.safetensors, "
                            "latent_upscale_models/ltx-2.5-latent-spatial-upscaler-x2-bf16-1.0.safetensors"}
    assert fake.prompts == []


@pytest.mark.parametrize("patch,code", [
    ({"model": "chroma"}, "UNKNOWN_MODEL"),
    ({"model": None}, "UNKNOWN_MODEL"),
    ({"prompt": "  "}, "INVALID_INPUT: prompt"),
    ({"negativePrompt": 3}, "INVALID_INPUT: negativePrompt"),
    ({"durationS": 16}, "INVALID_INPUT: durationS"),
    ({"durationS": "5"}, "INVALID_INPUT: durationS"),
    ({"fps": 30}, "INVALID_INPUT: fps"),
    ({"fps": 24.5}, "INVALID_INPUT: fps"),
    ({"resolution": "1280x704"}, "INVALID_INPUT: resolution"),
    ({"resolution": [864, 480]}, "INVALID_INPUT: resolution"),
    ({"seed": -1}, "INVALID_INPUT: seed"),
    ({"steps": 0}, "INVALID_INPUT: steps"),
    ({"steps": 500}, "INVALID_INPUT: steps"),
    ({"cfg": 99}, "INVALID_INPUT: cfg"),
    ({"audio": "yes"}, "INVALID_INPUT: audio"),
    ({"initImage": {"name": "a.png", "base64": "!!!"}}, "INVALID_INIT_IMAGE"),
    ({"initImage": {"name": "a.gif", "base64": base64.b64encode(b"GIF89a....").decode()}},
     "INVALID_INIT_IMAGE"),
    ({"initImage": "x"}, "INVALID_INIT_IMAGE"),
])
def test_validation_errors(venv, patch, code):
    venv.install("h3")
    fake = venv.fake()
    out = handler.handler(vid_input(**patch))
    assert out["error"].startswith(code), out
    assert fake.prompts == [] and fake.uploads == []


def test_execution_error_reported(venv):
    venv.install("h3")
    venv.fake(scenario="error")
    out = handler.handler(vid_input())
    assert out["error"].startswith("COMFYUI_EXECUTION_ERROR: node ")
    assert "OutOfMemoryError: CUDA out of memory" in out["error"]


def test_no_video_output(venv):
    venv.install("h3")
    venv.fake(scenario="no_video")
    assert handler.handler(vid_input()) == {
        "error": "COMFYUI_NO_OUTPUT: the workflow produced no video"}


def test_video_timeout_is_separate_from_image_timeout(venv, monkeypatch):
    venv.install("h3")
    fake = venv.fake()
    monkeypatch.setattr(handler, "VIDEO_TIMEOUT_S", 1.0)
    orig = fake._script

    def quiet(graph):
        orig(graph)
        fake.messages = fake.messages[:4] + ["TICK"] * 10 + ["TIMEOUT"] * 3
        fake.history_body = {"outputs": {}, "status": {"completed": False}}
    fake._script = quiet
    out = handler.handler(vid_input())
    assert out["error"] == "COMFYUI_TIMEOUT: no result after 1s"
    assert handler.GENERATE_TIMEOUT_S == 590 and handler.VIDEO_TIMEOUT_S == 1.0


def test_cancel_before_queue(venv):
    import threading
    venv.install("h3")
    fake = venv.fake()
    ev = threading.Event()
    ev.set()
    job = vid_input()
    job["_cancel"] = ev
    job["_progress"] = lambda p: None
    out = handler.handler(job)
    assert out["error"].startswith("CANCELLED") and fake.prompts == []


# ---------------------------------------------------------------------------
# helpers
# ---------------------------------------------------------------------------
def _box(kind: bytes, payload: bytes) -> bytes:
    return struct.pack(">I4s", 8 + len(payload), kind) + payload


def test_mp4_info_real_file():
    assert handler.mp4_info(MP4) == {"width": 64, "height": 32, "frames": 9, "durationS": 0.375,
                                     "hasAudio": True, "fps": 24.0}


def test_mp4_info_synthetic_video_only_and_64bit_mdhd():
    tkhd = _box(b"tkhd", b"\x00" * 76 + struct.pack(">II", 1280 << 16, 704 << 16))
    mdhd = _box(b"mdhd", b"\x01\x00\x00\x00" + b"\x00" * 16 + struct.pack(">IQ", 12288, 61952)
                + b"\x00" * 4)
    hdlr = _box(b"hdlr", b"\x00" * 8 + b"vide" + b"\x00" * 13)
    stsz = _box(b"stsz", b"\x00" * 8 + struct.pack(">I", 121))
    trak = _box(b"trak", tkhd + _box(b"mdia", mdhd + hdlr + _box(b"minf", _box(b"stbl", stsz))))
    data = _box(b"ftyp", b"isom") + _box(b"mdat", b"\x00" * 10) + _box(b"moov", trak)
    assert handler.mp4_info(data) == {"width": 1280, "height": 704, "frames": 121,
                                      "durationS": round(61952 / 12288, 3), "hasAudio": False,
                                      "fps": round(121 / round(61952 / 12288, 3), 3)}


@pytest.mark.parametrize("data", [b"", b"garbage" * 10, MP4[:200], _box(b"moov", b"")])
def test_mp4_info_unreadable(data):
    assert handler.mp4_info(data) is None


def test_poster_jpeg_without_pillow(monkeypatch):
    import builtins
    real = builtins.__import__

    def no_pil(name, *a, **kw):
        if name == "PIL" or name.startswith("PIL."):
            raise ImportError(name)
        return real(name, *a, **kw)
    monkeypatch.setattr(builtins, "__import__", no_pil)
    png = make_png(4, 4)
    assert handler.poster_jpeg(png) == (png, "image/png")


def test_poster_jpeg_with_pillow():
    pytest.importorskip("PIL")
    data, mime = handler.poster_jpeg(make_png(16, 8))
    assert mime == "image/jpeg" and data.startswith(b"\xff\xd8\xff")


def test_status_lists_latent_upscale_models(venv):
    venv.install("ltx25")
    out = handler.handler({"id": "s", "input": {"action": "status"}})
    folders = {(f["folder"], f["filename"]) for f in out["files"]}
    assert ("latent_upscale_models",
            "ltx-2.5-latent-spatial-upscaler-x2-bf16-1.0.safetensors") in folders


def test_delete_in_latent_upscale_models(venv):
    venv.install("ltx25")
    venv.fake()
    fn = "ltx-2.5-latent-spatial-upscaler-x2-bf16-1.0.safetensors"
    out = handler.handler({"id": "d", "input": {"action": "delete", "files": [
        {"folder": "latent_upscale_models", "filename": fn}]}})
    assert out == {"deleted": [fn], "missing": []}
    out = handler.handler({"id": "d", "input": {"action": "delete", "files": [
        {"folder": "model_patches", "filename": "ltx-2.5-duration-head-bf16.safetensors"}]}})
    assert out["error"].startswith("INVALID_FOLDER")


def test_download_into_latent_upscale_models(venv, file_server, monkeypatch):
    monkeypatch.setenv("IMAGE_STUDIO_ALLOW_HTTP", "1")
    monkeypatch.delenv("HF_TOKEN", raising=False)
    sha = file_server.add("/up.safetensors", b"u" * 1000)
    out = handler.handler({"id": "dl", "input": {"action": "download", "files": [
        {"folder": "latent_upscale_models", "filename": "up.safetensors",
         "url": file_server.url("/up.safetensors"), "sizeBytes": 1000, "sha256": sha}]}})
    assert out["downloaded"] == ["up.safetensors"], out
    assert (venv.models / "latent_upscale_models" / "up.safetensors").read_bytes() == b"u" * 1000


# ---------------------------------------------------------------------------
# pod server
# ---------------------------------------------------------------------------
def test_generate_video_uses_the_gpu_queue():
    assert "generate_video" in server.GENERATE_ACTIONS
    assert "generate_video" in handler.ACTIONS


def test_pod_server_serves_a_large_video_output():
    """A ~40 MB base64 MP4 output goes through /status (aiohttp limits
    request bodies only; MAX_BODY_BYTES is 32 MB)."""
    from test_server import AUTH, TOKEN, Running, wait_for

    big = {"video": {"base64": "A" * (40 * 1024 * 1024), "mime": "video/mp4"}}
    mgr = server.JobManager(run_job=lambda job: big, interrupt=lambda: None)
    health = server.Health(mgr, comfy_up=lambda: True, gpu=lambda: "", comfy_version=lambda: "")
    srv = Running(server.build_app(TOKEN, mgr, health))
    try:
        r = srv.post("/run", json={"input": {"action": "generate_video"}})
        jid = r.json()["id"]
        wait_for(lambda: srv.get(f"/status/{jid}").json()["status"] == "COMPLETED", timeout=30)
        body = srv.get(f"/status/{jid}").json()
        assert len(body["output"]["video"]["base64"]) == 40 * 1024 * 1024
        assert server.MAX_BODY_BYTES == 32 * 1024 * 1024
        assert AUTH
    finally:
        srv.close()
        mgr.shutdown()
