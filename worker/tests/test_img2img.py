"""img2img ("start image" + strength) for the models with supportsImg2Img.

Graph shape: LoadImage -> ImageScaleToTotalPixels(lanczos, 1 MP) ->
ImageScale(lanczos, W, H, center) -> VAEEncode(model VAE) replaces the empty
latent; denoise goes to KSampler (Z-Image) or BasicScheduler (Chroma).
Node inputs are checked against tests/fixtures/object_info_v0.39.0.json.
"""

from __future__ import annotations

import base64
import struct

import pytest

import handler
from test_handler import JPEG_REF, env, gen_input, make_png  # noqa: F401  (env is a fixture)
from test_progress_stages import T2I_STAGES, realistic_script, transitions
from test_workflows import assert_valid_graph, by_class, one
from workflows import (STAGE_PHASE, STAGES, WorkflowError, build_workflow, graph_node_stages,
                       graph_stages, init_image_size, init_image_node_ids)

IMG2IMG_MODELS = ["chroma", "zimage"]
INIT_STAGES = ["loading_text_encoder", "encoding_prompt", "loading_model",
               "preparing_init_image", "sampling", "decoding", "saving"]


def params(model, **kw):
    p = {"model": model, "prompt": "a red fox", "negativePrompt": "blurry",
         "width": 1216, "height": 832, "seed": 7, "steps": None, "cfg": None,
         "references": [], "loras": []}
    p.update(kw)
    return p


def init(name="is_x_init.png", width=1500, height=1000):
    return {"name": name, "width": width, "height": height}


def denoise_of(graph):
    """The denoise input of the sampler chain (KSampler or BasicScheduler)."""
    vals = [n["inputs"]["denoise"] for n in graph.values()
            if n["class_type"] in ("KSampler", "BasicScheduler")]
    assert len(vals) == 1
    return vals[0]


def b64(data: bytes) -> str:
    return base64.b64encode(data).decode()


# --------------------------------------------------------------------------- registry
def test_registry_flags(registry):
    flags = {m["id"]: m["supportsImg2Img"] for m in registry["models"]}
    assert flags == {"chroma": True, "zimage": True, "flux2": False, "qwen": False}


# --------------------------------------------------------------------------- size
@pytest.mark.parametrize("size,expected", [
    ((1024, 1024), (1024, 1024)),
    ((1500, 1000), (1248, 832)),
    ((800, 600), (1184, 880)),
    ((1000, 1500), (832, 1248)),
    ((640, 1137), (768, 1360)),
])
def test_init_image_size(size, expected):
    assert init_image_size(*size) == expected


@pytest.mark.parametrize("w,h", [(1, 1), (37, 999), (4000, 3000), (1023, 1025), (20000, 50)])
def test_init_image_size_is_multiple_of_16_and_about_1mp(w, h):
    ow, oh = init_image_size(w, h)
    assert ow % 16 == 0 and oh % 16 == 0
    assert 64 <= ow <= 4096 and 64 <= oh <= 4096
    if 0.25 < w / h < 4:
        assert 0.9 < ow * oh / 2**20 < 1.1


def test_init_image_size_rejects_empty():
    with pytest.raises(WorkflowError):
        init_image_size(0, 10)


# --------------------------------------------------------------------------- graphs
@pytest.mark.parametrize("model", IMG2IMG_MODELS)
def test_img2img_graph_valid(model, registry, object_info):
    g, out = build_workflow(params(model, initImage=init()), registry)
    assert_valid_graph(g, out, object_info)
    assert not [n for n in g.values() if n["class_type"].startswith("Empty")]
    load_id, load = one(g, "LoadImage")
    assert load["inputs"]["image"] == "is_x_init.png"
    total_id, total = one(g, "ImageScaleToTotalPixels")
    assert total["inputs"] == {"image": [load_id, 0], "upscale_method": "lanczos",
                               "megapixels": 1.0, "resolution_steps": 1}
    scale_id, scale = one(g, "ImageScale")
    assert scale["inputs"] == {"image": [total_id, 0], "upscale_method": "lanczos",
                               "width": 1248, "height": 832, "crop": "center"}
    enc_id, enc = one(g, "VAEEncode")
    assert enc["inputs"] == {"pixels": [scale_id, 0], "vae": [one(g, "VAELoader")[0], 0]}
    sampler = next(n for n in g.values()
                   if n["class_type"] in ("KSampler", "SamplerCustomAdvanced"))
    assert sampler["inputs"]["latent_image"] == [enc_id, 0]


@pytest.mark.parametrize("model", IMG2IMG_MODELS)
def test_requested_size_ignored_with_init_image(model, registry):
    g, _ = build_workflow(params(model, width=1344, height=768,
                                 initImage=init(width=600, height=800)), registry)
    s = one(g, "ImageScale")[1]["inputs"]
    assert (s["width"], s["height"]) == init_image_size(600, 800) == (880, 1184)
    assert not any(v.get("inputs", {}).get("width") == 1344 for v in g.values())


@pytest.mark.parametrize("model", IMG2IMG_MODELS)
def test_t2i_unchanged_without_init_image(model, registry):
    g, _ = build_workflow(params(model), registry)
    assert denoise_of(g) == 1.0
    assert not by_class(g, "VAEEncode") and not by_class(g, "ImageScale")
    assert len(by_class(g, "EmptySD3LatentImage")) == 1
    # a stray denoise without a start image is ignored
    g2, _ = build_workflow(params(model, denoise=0.3), registry)
    assert g2 == g


@pytest.mark.parametrize("model,cls", [("chroma", "BasicScheduler"), ("zimage", "KSampler")])
def test_denoise_wiring(model, cls, registry):
    g, _ = build_workflow(params(model, steps=12, initImage=init(), denoise=0.35), registry)
    assert one(g, cls)[1]["inputs"]["denoise"] == 0.35
    assert denoise_of(g) == 0.35
    assert one(g, cls)[1]["inputs"]["steps"] == 12  # steps kept as given
    # default strength
    g, _ = build_workflow(params(model, initImage=init()), registry)
    assert denoise_of(g) == 0.6
    # clamped into [0.05, 1.0]
    g, _ = build_workflow(params(model, initImage=init(), denoise=0.0), registry)
    assert denoise_of(g) == 0.05
    g, _ = build_workflow(params(model, initImage=init(), denoise=3), registry)
    assert denoise_of(g) == 1.0


def test_chroma_scheduler_keeps_its_settings(registry):
    g, _ = build_workflow(params("chroma", initImage=init(), denoise=0.5), registry)
    sched = one(g, "BasicScheduler")[1]["inputs"]
    assert sched["scheduler"] == "beta" and sched["model"] == [one(g, "ModelSamplingAuraFlow")[0], 0]


@pytest.mark.parametrize("model", IMG2IMG_MODELS)
def test_img2img_with_loras(model, registry, object_info):
    g, out = build_workflow(params(model, initImage=init(),
                                   loras=[{"filename": "a.safetensors", "strength": 0.5}]),
                            registry)
    assert_valid_graph(g, out, object_info)


@pytest.mark.parametrize("model", ["flux2", "qwen"])
def test_img2img_rejected_for_other_models(model, registry):
    with pytest.raises(WorkflowError, match="IMG2IMG_NOT_SUPPORTED"):
        build_workflow(params(model, initImage=init()), registry)


# --------------------------------------------------------------------------- stages
def test_stage_constants():
    assert STAGES.index("loading_model") < STAGES.index("preparing_init_image") < STAGES.index(
        "sampling")
    assert STAGE_PHASE["preparing_init_image"] == "loading"


@pytest.mark.parametrize("model", IMG2IMG_MODELS)
def test_init_image_stage_list(model, registry):
    g, _ = build_workflow(params(model, initImage=init()), registry)
    assert graph_stages(g) == INIT_STAGES
    ns = graph_node_stages(g)
    for cls in ("LoadImage", "ImageScaleToTotalPixels", "ImageScale", "VAEEncode"):
        assert ns[one(g, cls)[0]] == "preparing_init_image"
    assert "preparing_references" not in ns.values()
    assert init_image_node_ids(g) == {one(g, c)[0] for c in
                                      ("LoadImage", "ImageScaleToTotalPixels", "ImageScale",
                                       "VAEEncode")}
    g, _ = build_workflow(params(model), registry)
    assert "preparing_init_image" not in graph_stages(g)


def test_reference_nodes_stay_references(registry):
    g, _ = build_workflow(params("flux2", references=["a.png", "b.png"]), registry)
    assert init_image_node_ids(g) == set()
    stages = graph_stages(g)
    assert "preparing_references" in stages and "preparing_init_image" not in stages


# --------------------------------------------------------------------------- image headers
def jpeg(w, h, orientation=None):
    out = b"\xff\xd8"
    if orientation is not None:
        tiff = (b"MM\x00\x2a" + struct.pack(">I", 8) + struct.pack(">H", 1)
                + struct.pack(">HHI", 0x0112, 3, 1) + struct.pack(">HH", orientation, 0)
                + struct.pack(">I", 0))
        seg = b"Exif\x00\x00" + tiff
        out += b"\xff\xe1" + struct.pack(">H", len(seg) + 2) + seg
    out += b"\xff\xe0" + struct.pack(">H", 16) + b"JFIF\x00" + b"\x00" * 9
    sof = struct.pack(">BHHB", 8, h, w, 3) + b"\x01\x11\x00\x02\x11\x00\x03\x11\x00"
    out += b"\xff\xc0" + struct.pack(">H", len(sof) + 2) + sof
    out += b"\xff\xda\x00\x02" + b"\x00" * 16 + b"\xff\xd9"
    return out


def webp_vp8x(w, h):
    body = b"VP8X" + struct.pack("<I", 10) + b"\x00" * 4 + (w - 1).to_bytes(3, "little") + (
        h - 1).to_bytes(3, "little")
    return b"RIFF" + struct.pack("<I", 4 + len(body)) + b"WEBP" + body


def webp_vp8l(w, h):
    bits = (w - 1) | ((h - 1) << 14)
    body = b"VP8L" + struct.pack("<I", 5) + b"\x2f" + struct.pack("<I", bits)
    return b"RIFF" + struct.pack("<I", 4 + len(body)) + b"WEBP" + body


@pytest.mark.parametrize("data,ext,size", [
    (make_png(40, 30), "png", (40, 30)),
    (jpeg(1500, 1000), "jpg", (1500, 1000)),
    (jpeg(1500, 1000, orientation=1), "jpg", (1500, 1000)),
    (jpeg(1500, 1000, orientation=6), "jpg", (1000, 1500)),  # rotated 90°: LoadImage transposes
    (webp_vp8x(1200, 700), "webp", (1200, 700)),
    (webp_vp8l(300, 200), "webp", (300, 200)),
    (JPEG_REF, "jpg", None),
])
def test_image_size(data, ext, size):
    assert handler.image_size(data, ext) == size


# --------------------------------------------------------------------------- handler
@pytest.mark.parametrize("model", IMG2IMG_MODELS)
def test_generate_img2img(env, model):
    env.install(model)
    fake = env.fake(steps=4, out_size=(1248, 832))
    realistic_script(fake)
    png = make_png(1500, 1000)
    inp = gen_input(model=model, steps=4, initImage={"name": "start.png", "base64": b64(png)},
                    denoise=0.45)
    del inp["input"]["width"], inp["input"]["height"]  # optional with a start image
    out = handler.handler(inp)
    assert "error" not in out, out
    assert (out["image"]["width"], out["image"]["height"]) == (1248, 832)
    # the start image is uploaded like a reference and wired into LoadImage
    assert len(fake.uploads) == 1
    name, data, mime = fake.uploads[0]
    assert name.endswith("_init.png") and data == png and mime == "image/png"
    graph = fake.prompts[0]["prompt"]
    assert one(graph, "LoadImage")[1]["inputs"]["image"] == name
    s = one(graph, "ImageScale")[1]["inputs"]
    assert (s["width"], s["height"]) == (1248, 832)
    assert denoise_of(graph) == 0.45
    # progress: the start-image stage is listed from the first update and runs
    assert env.sent[0]["stages"] == INIT_STAGES
    assert transitions(env.sent) == INIT_STAGES
    # the uploaded start image is cleaned from the container disk
    assert not (env.comfy / "input" / name).exists()


def test_generate_img2img_default_denoise_and_ignored_size(env):
    env.install("zimage")
    fake = env.fake(steps=4, out_size=(1184, 880))
    out = handler.handler(gen_input(model="zimage", width=1344, height=768,
                                    initImage={"name": "s.jpg", "base64": b64(jpeg(800, 600))}))
    assert "error" not in out, out
    graph = fake.prompts[0]["prompt"]
    assert denoise_of(graph) == 0.6
    s = one(graph, "ImageScale")[1]["inputs"]
    assert (s["width"], s["height"]) == (1184, 880)
    assert fake.uploads[0][2] == "image/jpeg"


def test_generate_without_init_image_unchanged(env):
    env.install("chroma")
    fake = env.fake(steps=4)
    out = handler.handler(gen_input(model="chroma", denoise=0.2))
    assert "error" not in out, out
    graph = fake.prompts[0]["prompt"]
    assert denoise_of(graph) == 1.0 and not by_class(graph, "LoadImage")
    assert env.sent[0]["stages"] == T2I_STAGES


@pytest.mark.parametrize("model", ["flux2", "qwen"])
def test_generate_rejects_init_image_for_other_models(env, model):
    env.install(model)
    fake = env.fake()
    out = handler.handler(gen_input(model=model, initImage={"name": "s.png",
                                                            "base64": b64(make_png(64, 64))}))
    assert out["error"].startswith("IMG2IMG_NOT_SUPPORTED: " + model), out
    assert fake.prompts == [] and fake.uploads == []


@pytest.mark.parametrize("patch,code", [
    ({"initImage": {"name": "s.png"}}, "INVALID_INIT_IMAGE"),
    ({"initImage": "abc"}, "INVALID_INIT_IMAGE"),
    ({"initImage": {"name": "s.png", "base64": "!!!"}}, "INVALID_INIT_IMAGE"),
    ({"initImage": {"name": "s.gif", "base64": b64(b"GIF89a")}}, "INVALID_INIT_IMAGE"),
    ({"initImage": {"name": "s.jpg", "base64": b64(JPEG_REF)}}, "INVALID_INIT_IMAGE: could not"),
    ({"initImage": {"name": "s.png", "base64": b64(make_png(64, 64))}, "denoise": 0.01},
     "INVALID_INPUT: denoise"),
    ({"initImage": {"name": "s.png", "base64": b64(make_png(64, 64))}, "denoise": 1.5},
     "INVALID_INPUT: denoise"),
    ({"initImage": {"name": "s.png", "base64": b64(make_png(64, 64))}, "denoise": "lots"},
     "INVALID_INPUT: denoise"),
])
def test_generate_init_image_validation(env, patch, code):
    env.install("chroma")
    fake = env.fake()
    out = handler.handler(gen_input(model="chroma", **patch))
    assert out["error"].startswith(code), out
    assert fake.prompts == []
