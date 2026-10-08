"""v5 video graph builders (MiniMax H3, LTX-2.5): node classes, valid wiring,
frame/size math and parameter substitution.

Node inputs and outputs are checked against tests/fixtures/
object_info_v0.39.0.json (the video nodes were transcribed from the ComfyUI
v0.39.0 source; see the fixture's "_added"). DynamicCombo inputs use ComfyUI's
dotted API names ("format.codec"); MatchType outputs take the linked type.
"""

from __future__ import annotations

import copy
import json
import math
from pathlib import Path

import pytest

from registry import get_video_model, model_file_by_role, video_model_ids
from safe_paths import validate_filename, validate_folder
from workflows import (LTX_SIGMAS_STAGE1, LTX_SIGMAS_STAGE2, LTX_STAGE2_SEED, OUTPUT_TYPES,
                       POSTER_PREFIX, STAGE_PHASE, STAGES, VIDEO_PREFIX, WorkflowError,
                       build_video_workflow, graph_node_stages, graph_stages, h3_frames,
                       is_video_graph, ltx_frames, sampler_node_ids, video_size)

MODELS = ["h3", "ltx25"]
MODES = ["t2v", "i2v"]
INIT = {"name": "is_abc_init.png", "width": 1000, "height": 1500}

DYN = "COMFY_DYNAMICCOMBO_V3"
MATCH = "COMFY_MATCHTYPE_V3"


def vparams(model, **kw):
    p = {"model": model, "prompt": "a fox runs through snow", "negativePrompt": None,
         "durationS": None, "fps": None, "resolution": None, "seed": 123456789,
         "steps": None, "cfg": None, "audio": True, "initImage": None}
    p.update(kw)
    return p


def by_class(graph, cls):
    return [(nid, n) for nid, n in graph.items() if n["class_type"] == cls]


def one(graph, cls):
    nodes = by_class(graph, cls)
    assert len(nodes) == 1, f"expected one {cls}, got {len(nodes)}"
    return nodes[0]


# ---------------------------------------------------------------------------
# validation against the v0.39.0 object_info fixture
# ---------------------------------------------------------------------------
def _sections(spec):
    return {**spec.get("required", {}), **spec.get("optional", {})}


def _resolve(spec_inputs, node_inputs, name):
    """Spec of input `name`, following DynamicCombo options for dotted names."""
    parts = name.split(".")
    level = spec_inputs
    for i, part in enumerate(parts):
        s = _sections(level).get(part)
        if s is None:
            return None
        if i == len(parts) - 1:
            return s
        if s["type"] != DYN:
            return None
        key = node_inputs.get(".".join(parts[:i + 1]))
        opt = next((o for o in s["options"] if o["key"] == key), None)
        if opt is None:
            return None
        level = opt["inputs"]
    return None


def _required_names(spec_inputs, node_inputs, prefix=""):
    """Every required input name (dotted) of the selected DynamicCombo options."""
    out = []
    for name, s in spec_inputs.get("required", {}).items():
        full = prefix + name
        out.append(full)
        if s["type"] == DYN and full in node_inputs:
            opt = next((o for o in s["options"] if o["key"] == node_inputs[full]), None)
            assert opt is not None, f"{full}={node_inputs[full]!r} is not an option"
            out += _required_names(opt["inputs"], node_inputs, full + ".")
    for name, s in spec_inputs.get("optional", {}).items():
        full = prefix + name
        if s["type"] == DYN and full in node_inputs:
            opt = next((o for o in s["options"] if o["key"] == node_inputs[full]), None)
            assert opt is not None, f"{full}={node_inputs[full]!r} is not an option"
            out += _required_names(opt["inputs"], node_inputs, full + ".")
    return out


def _output_type(graph, object_info, src, idx):
    cls = graph[src]["class_type"]
    t = object_info[cls]["output"][idx]
    if t == MATCH:  # MatchType: the type linked into the matching input
        spec = object_info[cls]["input"]
        name = next(n for n, s in _sections(spec).items() if s["type"] == MATCH)
        link = graph[src]["inputs"][name]
        return _output_type(graph, object_info, link[0], link[1])
    return t


def _accepts(spec, actual):
    if spec["type"] == MATCH:
        return actual in spec["template"]["allowed_types"].split(",")
    return actual in spec["type"].split(",")


def assert_valid_video_graph(graph, info, object_info):
    assert graph[info["videoNode"]]["class_type"] == "SaveVideo"
    assert graph[info["posterNode"]]["class_type"] == "SaveImage"
    for nid, node in graph.items():
        cls = node["class_type"]
        assert cls in object_info, f"{cls} not in ComfyUI v0.39.0 fixture"
        spec = object_info[cls]["input"]
        for name in _required_names(spec, node["inputs"]):
            assert name in node["inputs"], f"node {nid} {cls} missing input {name}"
        for name, value in node["inputs"].items():
            s = _resolve(spec, node["inputs"], name)
            assert s is not None, f"node {nid} {cls} has unknown input {name!r}"
            if isinstance(value, list):  # link
                src, idx = value
                assert src in graph, f"node {nid}.{name} links to missing node {src}"
                outputs = object_info[graph[src]["class_type"]]["output"]
                assert 0 <= idx < len(outputs), f"node {nid}.{name} bad output index {idx}"
                actual = _output_type(graph, object_info, src, idx)
                assert _accepts(s, actual), f"node {nid}.{name} expects {s['type']}, gets {actual}"
            else:
                assert s["type"] not in ("MODEL", "CLIP", "VAE", "LATENT", "IMAGE", "AUDIO",
                                         "VIDEO", "CONDITIONING", "GUIDER", "SIGMAS", "NOISE",
                                         "SAMPLER", "LATENT_UPSCALE_MODEL", MATCH), (
                    f"node {nid}.{name} needs a link, got {value!r}")
                if s["type"] in ("COMBO", DYN) and "options" in s:
                    keys = s["options"] if s["type"] == "COMBO" else [o["key"] for o in s["options"]]
                    assert value in keys, f"node {nid}.{name}={value!r} not an option"
        assert OUTPUT_TYPES[cls] == object_info[cls]["output"], cls
    # every node feeds one of the two output nodes (ComfyUI only runs those)
    reach, stack = set(), [info["videoNode"], info["posterNode"]]
    while stack:
        n = stack.pop()
        if n in reach:
            continue
        reach.add(n)
        stack += [v[0] for v in graph[n]["inputs"].values() if isinstance(v, list)]
    assert reach == set(graph), f"unreachable nodes: {set(graph) - reach}"
    json.dumps(graph)  # serialisable for POST /prompt


@pytest.mark.parametrize("model", MODELS)
@pytest.mark.parametrize("mode", MODES)
@pytest.mark.parametrize("audio", [True, False])
def test_video_graph_valid(model, mode, audio, registry, object_info):
    init = INIT if mode == "i2v" else None
    graph, info = build_video_workflow(vparams(model, audio=audio, initImage=init), registry)
    assert_valid_video_graph(graph, info, object_info)
    assert is_video_graph(graph)
    classes = [n["class_type"] for n in graph.values()]
    # audio on/off
    audio_dec = "VAEDecodeAudio" if model == "h3" else "LTXVAudioVAEDecode"
    assert classes.count(audio_dec) == (1 if audio else 0)
    _, cv = one(graph, "CreateVideo")
    assert ("audio" in cv["inputs"]) == audio
    assert info["hasAudio"] is audio
    # i2v: the uploaded start image is the only LoadImage
    loads = by_class(graph, "LoadImage")
    if mode == "i2v":
        assert [n["inputs"]["image"] for _, n in loads] == [INIT["name"]]
    else:
        assert loads == []
    # MP4 / H.264 output, poster = frame 0
    _, save = one(graph, "SaveVideo")
    assert save["inputs"]["format"] == "mp4" and save["inputs"]["format.codec"] == "h264"
    assert save["inputs"]["filename_prefix"] == VIDEO_PREFIX
    _, ifb = one(graph, "ImageFromBatch")
    assert ifb["inputs"]["batch_index"] == 0 and ifb["inputs"]["length"] == 1
    assert ifb["inputs"]["image"] == cv["inputs"]["images"]
    _, poster = one(graph, "SaveImage")
    assert poster["inputs"]["filename_prefix"] == POSTER_PREFIX


def test_h3_graph_matches_template(registry):
    graph, info = build_video_workflow(vparams("h3"), registry)
    m = get_video_model(registry, "h3")
    _, clip = one(graph, "CLIPLoader")
    assert clip["inputs"] == {"clip_name": model_file_by_role(m, "clip")["filename"],
                              "type": "minimax", "device": "default"}
    assert one(graph, "UNETLoader")[1]["inputs"]["unet_name"] == model_file_by_role(m, "unet")["filename"]
    vaes = sorted(n["inputs"]["vae_name"] for _, n in by_class(graph, "VAELoader"))
    assert vaes == sorted([model_file_by_role(m, "video_vae")["filename"],
                           model_file_by_role(m, "audio_vae")["filename"]])
    assert one(graph, "KSamplerSelect")[1]["inputs"]["sampler_name"] == "res_multistep"
    sched = one(graph, "BasicScheduler")[1]["inputs"]
    assert (sched["scheduler"], sched["steps"], sched["denoise"]) == ("simple", 20, 1.0)
    assert one(graph, "BasicGuider")  # no CFG, no negative prompt
    assert not by_class(graph, "CFGGuider")
    cond = one(graph, "MiniMaxH3ImageToVideo")[1]["inputs"]
    assert (cond["width"], cond["height"], cond["length"]) == (864, 480, 124)
    assert "first_frame" not in cond and "last_frame" not in cond
    assert one(graph, "CreateVideo")[1]["inputs"]["fps"] == 24.0
    assert (info["width"], info["height"], info["fps"], info["frames"]) == (864, 480, 24, 124)
    assert info["durationS"] == round(124 / 24, 3)


def test_h3_i2v_first_frame(registry):
    graph, info = build_video_workflow(vparams("h3", initImage=INIT), registry)
    load_id, _ = one(graph, "LoadImage")
    cond = one(graph, "MiniMaxH3ImageToVideo")[1]["inputs"]
    assert cond["first_frame"] == [load_id, 0]
    assert "last_frame" not in cond
    # aspect of the 1000x1500 start image at 864*480 px, multiples of 32
    assert (cond["width"], cond["height"]) == (info["width"], info["height"]) == (512, 800)


def test_ltx_graph_matches_template(registry):
    graph, info = build_video_workflow(vparams("ltx25"), registry)
    m = get_video_model(registry, "ltx25")
    _, clip = one(graph, "CLIPLoader")
    assert clip["inputs"]["type"] == "ltxv"
    assert clip["inputs"]["clip_name"] == model_file_by_role(m, "clip")["filename"]
    _, up = one(graph, "LatentUpscaleModelLoader")
    assert up["inputs"]["model_name"] == model_file_by_role(m, "spatial_upscaler")["filename"]
    texts = sorted(n["inputs"]["text"] for _, n in by_class(graph, "CLIPTextEncode"))
    assert texts == sorted(["a fox runs through snow", m["defaults"]["negativePrompt"]])
    assert one(graph, "LTXVConditioning")[1]["inputs"]["frame_rate"] == 24.0
    empty = one(graph, "EmptyLTXVLatentVideo")[1]["inputs"]
    assert (empty["width"], empty["height"], empty["length"]) == (640, 352, 121)
    audio = one(graph, "LTXVEmptyLatentAudio")[1]["inputs"]
    assert (audio["frames_number"], audio["frame_rate"]) == (121, 24)
    samplers = [n for _, n in by_class(graph, "SamplerCustomAdvanced")]
    assert len(samplers) == 2
    sig = {n["inputs"]["sigmas"] for _, n in by_class(graph, "ManualSigmas")}
    assert sig == {LTX_SIGMAS_STAGE1, LTX_SIGMAS_STAGE2}
    assert {n["inputs"]["sampler_name"] for _, n in by_class(graph, "KSamplerSelect")} == \
        {"euler_ancestral"}
    for _, g in by_class(graph, "LTXVDualCFGGuider"):
        assert (g["inputs"]["video_cfg"], g["inputs"]["audio_cfg"]) == (1.0, 1.0)
    # stage 2 consumes the x2-upscaled stage-1 video latent and stage-1 audio
    s1, s2 = [nid for nid, n in graph.items() if n["class_type"] == "SamplerCustomAdvanced"]
    assert [s for s, _ in info["samplers"]] == [s1, s2]
    concat2 = graph[graph[s2]["inputs"]["latent_image"][0]]
    up_node = graph[concat2["inputs"]["video_latent"][0]]
    assert up_node["class_type"] == "LTXVLatentUpsampler"
    sep1 = graph[up_node["inputs"]["samples"][0]]
    assert sep1["class_type"] == "LTXVSeparateAVLatent" and sep1["inputs"]["av_latent"] == [s1, 0]
    assert concat2["inputs"]["audio_latent"] == [up_node["inputs"]["samples"][0], 1]
    tiled = one(graph, "VAEDecodeTiled")[1]["inputs"]
    assert (tiled["tile_size"], tiled["overlap"], tiled["temporal_size"],
            tiled["temporal_overlap"]) == (512, 64, 64, 16)
    assert (info["width"], info["height"], info["frames"], info["totalSteps"]) == (1280, 704, 121, 11)


def test_ltx_i2v_conditioning(registry):
    graph, info = build_video_workflow(vparams("ltx25", initImage=INIT), registry)
    load_id, _ = one(graph, "LoadImage")
    rid, resize = one(graph, "ResizeImageMaskNode")
    assert resize["inputs"] == {"input": [load_id, 0], "resize_type": "scale longer dimension",
                                "resize_type.longer_size": 1536, "scale_method": "lanczos"}
    pid, pre = one(graph, "LTXVPreprocess")
    assert pre["inputs"] == {"image": [rid, 0], "img_compression": 18}
    inplace = {graph[n["inputs"]["latent"][0]]["class_type"]: n["inputs"]
               for _, n in by_class(graph, "LTXVImgToVideoInplace")}
    assert inplace["EmptyLTXVLatentVideo"]["strength"] == 0.7
    assert inplace["LTXVLatentUpsampler"]["strength"] == 1.0
    assert all(v["image"] == [pid, 0] and v["bypass"] is False for v in inplace.values())
    # 1000x1500 start image at 1280*704 px, multiples of 64
    assert (info["width"], info["height"]) == (768, 1152)
    empty = one(graph, "EmptyLTXVLatentVideo")[1]["inputs"]
    assert (empty["width"], empty["height"]) == (384, 576)


# ---------------------------------------------------------------------------
# frames, sizes, params
# ---------------------------------------------------------------------------
@pytest.mark.parametrize("dur,frames", [(2, 56), (5, 124), (10, 243), (15, 362), (0.1, 5)])
def test_h3_frames_17k_plus_5(dur, frames):
    assert h3_frames(dur) == frames
    assert frames % 17 == 5 and frames >= max(5, round(dur * 24))
    # the template's Math Expression
    n = max(5, round(dur * 24))
    assert frames == n + (5 - (n % 17)) % 17


@pytest.mark.parametrize("dur,fps,frames", [(5, 24, 121), (5, 25, 129), (2, 24, 49),
                                            (20, 24, 481), (10, 25, 249), (7.5, 24, 177)])
def test_ltx_frames_8n_plus_1(dur, fps, frames):
    assert ltx_frames(dur, fps) == frames
    assert (frames - 1) % 8 == 0
    assert abs((frames - 1) / fps - dur) <= 4 / fps + 1e-9  # nearest 8n+1


def test_template_default_sizes_match_resolution_selector(registry):
    """The registry defaults are the templates' ResolutionSelector outputs
    (comfy_extras/nodes_resolution.py), H3 16:9 at 0.4 MP x32; LTX 16:9 at
    0.9 MP x32 = 1280x736, which EmptyLTXVLatentVideo floors to 1280x704."""
    def selector(wr, hr, mp, multiple):
        scale = math.sqrt(mp * 1024 * 1024 / (wr * hr))
        return round(wr * scale / multiple) * multiple, round(hr * scale / multiple) * multiple

    assert selector(16, 9, 0.4, 32) == (864, 480)
    assert get_video_model(registry, "h3")["defaults"]["resolution"] == "864x480"
    w, h = selector(16, 9, 0.9, 32)
    assert (w, h) == (1280, 736)
    assert ((w // 2 // 32) * 64, (h // 2 // 32) * 64) == (1280, 704)
    assert get_video_model(registry, "ltx25")["defaults"]["resolution"] == "1280x704"


@pytest.mark.parametrize("model", MODELS)
def test_every_offered_resolution_is_exact(model, registry):
    m = get_video_model(registry, model)
    for res in m["limits"]["resolutions"]:
        graph, info = build_video_workflow(vparams(model, resolution=res), registry)
        assert f"{info['width']}x{info['height']}" == res
        multiple = 32 if model == "h3" else 64
        assert info["width"] % multiple == 0 and info["height"] % multiple == 0


@pytest.mark.parametrize("model,multiple", [("h3", 32), ("ltx25", 64)])
@pytest.mark.parametrize("iw,ih", [(1920, 1080), (1080, 1920), (512, 512), (4000, 1000)])
def test_i2v_size_follows_start_image(model, multiple, iw, ih, registry):
    res = get_video_model(registry, model)["defaults"]["resolution"]
    w, h = video_size(res, multiple, {"width": iw, "height": ih})
    assert w % multiple == 0 and h % multiple == 0
    pw, ph = map(int, res.split("x"))
    assert abs(w / h - iw / ih) / (iw / ih) < 0.15
    assert abs(w * h - pw * ph) / (pw * ph) < 0.25


@pytest.mark.parametrize("model", MODELS)
def test_params_applied(model, registry):
    graph, info = build_video_workflow(
        vparams(model, seed=2**63 + 7, steps=12, cfg=2.5, durationS=10, negativePrompt="ugly"),
        registry)
    noise = sorted(n["inputs"]["noise_seed"] for _, n in by_class(graph, "RandomNoise"))
    assert info["seed"] == 2**63 + 7
    if model == "h3":
        assert noise == [2**63 + 7]
        assert one(graph, "BasicScheduler")[1]["inputs"]["steps"] == 12
        assert info["totalSteps"] == 12 and info["frames"] == 243
        # BasicGuider: no cfg, no negative prompt anywhere
        assert "ugly" not in json.dumps(graph)
    else:
        assert noise == sorted([2**63 + 7, LTX_STAGE2_SEED])  # stage 2 is fixed in the template
        stage1 = graph[info["samplers"][0][0]]
        assert graph[stage1["inputs"]["noise"][0]]["inputs"]["noise_seed"] == 2**63 + 7
        # distilled: steps are the template's fixed sigma schedules (8 + 3)
        assert info["totalSteps"] == 11
        for _, g in by_class(graph, "LTXVDualCFGGuider"):
            assert (g["inputs"]["video_cfg"], g["inputs"]["audio_cfg"]) == (2.5, 2.5)
        assert "ugly" in [n["inputs"]["text"] for _, n in by_class(graph, "CLIPTextEncode")]
        assert info["frames"] == 241


def test_ltx_fps_25(registry):
    graph, info = build_video_workflow(vparams("ltx25", fps=25), registry)
    assert info["fps"] == 25 and info["frames"] == 129
    assert one(graph, "CreateVideo")[1]["inputs"]["fps"] == 25.0
    assert one(graph, "LTXVConditioning")[1]["inputs"]["frame_rate"] == 25.0
    assert one(graph, "LTXVEmptyLatentAudio")[1]["inputs"]["frame_rate"] == 25


@pytest.mark.parametrize("model", MODELS)
def test_defaults_from_registry(model, registry):
    m = get_video_model(registry, model)
    graph, info = build_video_workflow(vparams(model), registry)
    d = m["defaults"]
    assert f"{info['width']}x{info['height']}" == d["resolution"]
    assert info["fps"] == d["fps"]
    assert abs(info["durationS"] - d["durationS"]) < 0.25


@pytest.mark.parametrize("bad,code", [
    ({"model": "chroma"}, "UNKNOWN_MODEL"),
    ({"model": "nope"}, "UNKNOWN_MODEL"),
    ({"resolution": "1000x1000"}, "INVALID_INPUT: resolution"),
    ({"resolution": "huge"}, "INVALID_INPUT: resolution"),
    ({"fps": 30}, "INVALID_INPUT: fps"),
    ({"durationS": 60}, "INVALID_INPUT: durationS"),
    ({"durationS": 0.5}, "INVALID_INPUT: durationS"),
])
@pytest.mark.parametrize("model", MODELS)
def test_rejections(model, bad, code, registry):
    with pytest.raises(WorkflowError, match=code):
        build_video_workflow({**vparams(model), **bad}, registry)


def test_pure(registry):
    p = vparams("ltx25", initImage=dict(INIT))
    before = copy.deepcopy(p)
    a = build_video_workflow(p, registry)
    b = build_video_workflow(p, registry)
    assert p == before and a == b


def test_samplers_and_stages(registry):
    for model in MODELS:
        for init in (None, INIT):
            graph, info = build_video_workflow(vparams(model, initImage=init), registry)
            assert sampler_node_ids(graph) == {s for s, _ in info["samplers"]}
            stages = graph_stages(graph)
            assert stages[-4:] == ["video_decoding", "audio_decoding", "encoding_video", "saving"]
            assert ("preparing_init_image" in stages) == (init is not None)
            assert stages == [s for s in STAGES if s in stages]
            ns = graph_node_stages(graph)
            for nid, n in graph.items():
                if n["class_type"] in ("VAEDecode", "VAEDecodeTiled"):
                    assert ns[nid] == "video_decoding"
                if n["class_type"] in ("VAEDecodeAudio", "LTXVAudioVAEDecode"):
                    assert ns[nid] == "audio_decoding"
                if n["class_type"] in ("CreateVideo", "SaveVideo"):
                    assert ns[nid] == "encoding_video"
                if n["class_type"] == "LTXVLatentUpsampler":
                    assert ns[nid] == "sampling"
                if n["class_type"] == "LTXVImgToVideoInplace":
                    src = graph[n["inputs"]["latent"][0]]["class_type"]
                    assert ns[nid] == ("sampling" if src == "LTXVLatentUpsampler"
                                       else "preparing_init_image")
    graph, _ = build_video_workflow(vparams("h3", audio=False), registry)
    assert "audio_decoding" not in graph_stages(graph)
    for s in ("video_decoding", "audio_decoding", "encoding_video"):
        assert STAGE_PHASE[s] == "saving"


# ---------------------------------------------------------------------------
# registry entries
# ---------------------------------------------------------------------------
def test_video_registry_entries(registry):
    assert video_model_ids(registry) == ["h3", "ltx25"]
    image_ids = {m["id"] for m in registry["models"]}
    assert not image_ids & set(video_model_ids(registry))
    for m in registry["videoModels"]:
        assert m["modes"] == ["t2v", "i2v"] and m["audio"] is True
        assert m["volume"] == "image-studio-video"
        assert set(m["defaults"]) >= {"durationS", "fps", "resolution", "steps", "cfg"}
        lim = m["limits"]
        assert set(lim) >= {"maxDurationS", "resolutions", "fpsOptions"}
        assert m["defaults"]["resolution"] in lim["resolutions"]
        assert m["defaults"]["fps"] in lim["fpsOptions"]
        assert lim["minDurationS"] <= m["defaults"]["durationS"] <= lim["maxDurationS"]
        roles = [f["role"] for f in m["files"]]
        assert len(roles) == len(set(roles))
        for f in m["files"]:
            assert set(f) == {"folder", "filename", "url", "sizeBytes", "sha256", "gated", "role"}
            validate_folder(f["folder"])
            validate_filename(f["filename"])
            assert f["url"].startswith("https://huggingface.co/") and \
                f["url"].endswith("/" + f["filename"])
            assert isinstance(f["sizeBytes"], int) and f["sizeBytes"] > 0
            assert len(f["sha256"]) == 64 and int(f["sha256"], 16) >= 0
    h3 = get_video_model(registry, "h3")
    assert {f["role"] for f in h3["files"]} == {"unet", "clip", "video_vae", "audio_vae"}
    assert not any(f["gated"] for f in h3["files"])
    ltx = get_video_model(registry, "ltx25")
    assert {f["role"] for f in ltx["files"]} == {"unet", "clip", "video_vae", "audio_vae",
                                                 "spatial_upscaler"}
    assert all(f["gated"] for f in ltx["files"])
    assert model_file_by_role(ltx, "spatial_upscaler")["folder"] == "latent_upscale_models"


@pytest.mark.parametrize("model", MODELS)
@pytest.mark.parametrize("mode", MODES)
def test_every_registry_file_is_used(model, mode, registry):
    """videoModels lists exactly the files the graphs load."""
    m = get_video_model(registry, model)
    graph, _ = build_video_workflow(vparams(model, initImage=INIT if mode == "i2v" else None),
                                    registry)
    loaded = set()
    for n in graph.values():
        for key in ("unet_name", "clip_name", "vae_name", "model_name"):
            if key in n["inputs"]:
                loaded.add(n["inputs"][key])
    assert loaded == {f["filename"] for f in m["files"]}


def test_image_registry_unchanged_by_video(registry):
    """The image models keep their schema (no role/videoModels fields leak in)."""
    for m in registry["models"]:
        for f in m["files"]:
            assert "role" not in f
    src = Path(__file__).resolve().parents[2] / "shared" / "models.json"
    data = json.loads(src.read_text())
    assert list(data)[:3] == ["version", "models", "aspectRatios"]


def test_build_time_node_check_sees_only_node_classes(object_info):
    """boot/check_comfy_nodes.py (run by the runtime image build) collects
    every `.add("Name"` in workflows.py as a required node class: each one must
    be a real v0.39.0 node, or the image build fails."""
    from check_comfy_nodes import required_classes

    src = Path(__file__).resolve().parents[1] / "src" / "workflows.py"
    names = required_classes(src)
    assert set(names) <= set(object_info), set(names) - set(object_info)
    assert {"SaveVideo", "MiniMaxH3ImageToVideo", "LTXVLatentUpsampler"} <= set(names)
